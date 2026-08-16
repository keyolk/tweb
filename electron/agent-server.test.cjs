"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  clearOwnedSocket,
  sameSocketIdentity,
  socketName,
  socketPath,
  stagingPath,
  startAgentServer,
} = require("./agent-server.cjs");

// A pane id is reused as soon as tmux hands it out again, so two engines can legitimately
// want the same socket pathname: the newcomer takes the stale name and binds its own socket,
// while the previous engine is still alive and only learns it was orphaned a second later.
// Its exit path then unlinks the *pathname*, which by then belongs to the newcomer — the
// live pane loses automation with no error anywhere. Identity is device+inode, not the name.
//
// libuv unlinks the path a handle bound when that handle closes, so the identity check alone
// is not enough: the server binds a private staging name and renames it into place, and the
// only path `close()` can ever unlink is that staging name.

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tweb-agent-test-"));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

function ask(target) {
  return new Promise((resolve) => {
    const client = net.connect(target, () => {
      client.write(`${JSON.stringify({ id: 1, method: "ping", params: {} })}\n`);
    });
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      resolve(JSON.parse(chunk.trim()));
      client.destroy();
    });
    client.on("error", (error) => resolve({ error: error.code }));
    setTimeout(() => {
      resolve({ error: "timeout" });
      client.destroy();
    }, 1000);
  });
}

test("an identity matches only the same socket instance", () => {
  assert.equal(sameSocketIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }), true);
  assert.equal(sameSocketIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }), false);
  // A different filesystem can hand out the same inode number.
  assert.equal(sameSocketIdentity({ dev: 1, ino: 2 }, { dev: 9, ino: 2 }), false);
  assert.equal(sameSocketIdentity(null, { dev: 1, ino: 2 }), false);
  assert.equal(sameSocketIdentity({ dev: 1, ino: 2 }, null), false);
});

// A daemon-started engine inherits the DAEMON's TMUX_PANE. Deriving the name from it was
// measured claiming `agent-%304.sock` — a name inside an unrelated pane's namespace, which
// `tweb --pane %304` would then connect to and drive the wrong page. The name comes from the
// pane the socket serves, and there is no environment fallback left to leak into it.
test("a socket is named after the pane it serves, never after the engine", () => {
  assert.equal(socketName("%3"), "agent-%3.sock");
  // A bare terminal registers its pane under a pid-derived identity; that identity is the
  // caller's, and arrives here as a pane id like any other.
  assert.equal(socketName("pid-4242"), "agent-pid-4242.sock");
  process.env.TMUX_PANE = "%304";
  assert.equal(socketName("%7"), "agent-%7.sock", "the engine's own pane must not appear");
  delete process.env.TMUX_PANE;
});

test("a nameless pane is refused rather than given the process's name", () => {
  // Silently falling back to a pid would give N hosted panes N sockets nobody can address by
  // pane id, which reads as "automation randomly picks the wrong pane".
  assert.throws(() => socketName(""), TypeError);
  assert.throws(() => socketName(null), TypeError);
  assert.throws(() => socketName(undefined), TypeError);
});

test("the pinned-path override is the caller's decision, not the module's", () => {
  const directory = temporaryDirectory();
  process.env.TWEB_RUNTIME_DIR = directory;
  // TWEB_AGENT_SOCKET names one path. Honouring it for every pane of a host would point N
  // panes at one socket, so it only applies where a caller passes it.
  assert.equal(socketPath("%3", { override: "/tmp/pinned.sock" }), "/tmp/pinned.sock");
  assert.equal(socketPath("%3"), path.join(directory, "agent-%3.sock"));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("an engine removes the socket it actually bound", async () => {
  const directory = temporaryDirectory();
  const target = path.join(directory, "agent-%7.sock");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(target, resolve));
  const identity = fs.lstatSync(target);

  clearOwnedSocket(target, { dev: identity.dev, ino: identity.ino });
  assert.equal(fs.existsSync(target), false);
  server.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("an engine never removes the socket a successor rebound at the same path", async () => {
  const directory = temporaryDirectory();
  process.env.TWEB_RUNTIME_DIR = directory;
  const target = path.join(directory, "agent-%42.sock");

  // Engine A: its frontend was SIGKILLed, but the orphan watchdog has not fired yet.
  const first = startAgentServer({
    paneId: "%42", dispatch: async () => ({ from: "A" }), log: () => {},
  });
  await settle();
  const firstIno = fs.lstatSync(target).ino;

  // Engine B: tmux reused the pane id, so the same pathname, taken over legitimately.
  const second = startAgentServer({
    paneId: "%42", dispatch: async () => ({ from: "B" }), log: () => {},
  });
  await settle();
  const secondIno = fs.lstatSync(target).ino;
  assert.notEqual(secondIno, firstIno, "the successor must own a new socket");

  // Engine A finally runs its exit path.
  first.close();
  await settle();

  assert.equal(fs.existsSync(target), true, "the live pane's socket must survive");
  assert.equal(fs.lstatSync(target).ino, secondIno);
  assert.deepEqual(await ask(target), { id: 1, result: { from: "B" } });

  second.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a socket that is already gone is not an error", () => {
  const directory = temporaryDirectory();
  clearOwnedSocket(path.join(directory, "agent-%9.sock"), { dev: 1, ino: 2 });
  // A server that never got to record what it bound must not delete a stranger's socket.
  clearOwnedSocket(path.join(directory, "agent-%9.sock"), null);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("an unrecorded identity leaves a live socket alone", async () => {
  const directory = temporaryDirectory();
  const target = path.join(directory, "agent-%11.sock");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(target, resolve));

  // `listen` never fired its callback (bind failed, the process died mid-startup), so
  // nothing was recorded. Deleting on a guess is what the identity check exists to stop.
  clearOwnedSocket(target, null);
  assert.equal(fs.existsSync(target), true);

  server.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

// bind(2) sees the staging name, not the final one, so the sun_path budget has to be
// measured against the longer of the two. A target that fits at 100 bytes while its staging
// name does not would bind-fail at exactly the length the guard exists to catch — and the
// failure looks like "automation is broken" much later, with no rename and no identity.
test("the length guard is measured against the name bind actually sees", () => {
  const target = "/tmp/tweb-502/agent-%3.sock";
  assert.equal(stagingPath(target, 12345), `${target}.12345.bind`);
  assert.ok(
    Buffer.byteLength(stagingPath(target, 12345)) > Buffer.byteLength(target),
    "staging is the longer name, so it is the one that has to fit"
  );
});

test("a target that only fits before staging is refused rather than bound", async () => {
  const directory = temporaryDirectory();
  // Built so the final name fits inside the 100-byte budget and the staging name does not.
  const padding = "p".repeat(Math.max(0, 96 - Buffer.byteLength(path.join(directory, "a.sock"))));
  const target = path.join(directory, `${padding}a.sock`);
  assert.ok(Buffer.byteLength(target) <= 100, "the final name must fit, or the test proves nothing");
  assert.ok(Buffer.byteLength(stagingPath(target)) > 100, "the staging name must not fit");

  process.env.TWEB_AGENT_SOCKET = target;
  const server = startAgentServer({
    paneId: "%3", socketOverride: target, dispatch: async () => ({}), log: () => {},
  });
  await settle();
  assert.equal(fs.existsSync(target), false, "nothing may be bound when the guard refuses");
  assert.equal(fs.existsSync(stagingPath(target)), false);
  server.close();

  delete process.env.TWEB_AGENT_SOCKET;
  fs.rmSync(directory, { recursive: true, force: true });
});
