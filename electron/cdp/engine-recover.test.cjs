"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { debuggingPortOf, ensureChrome, freePort, liveProfileChrome } = require("./connection.cjs");

const tempProfile = () => fs.mkdtempSync(path.join(os.tmpdir(), "tweb-recover-"));

// A process whose argv carries `--remote-debugging-port=<port>`, which is what `ps` shows for a Chrome.
function fakeChrome(port) {
  const args = ["-e", "setInterval(()=>{},1000)", "--"];
  if (port) args.push(`--remote-debugging-port=${port}`);
  return spawn(process.execPath, args, { stdio: "ignore" });
}

function lockTo(profile, pid) {
  fs.symlinkSync(`some-host-${pid}`, path.join(profile, "SingletonLock"));
}

test("the debugging port is read off a Chrome command line", () => {
  assert.equal(debuggingPortOf("Google Chrome --user-data-dir=/x --remote-debugging-port=55399 --headless=new"), 55399);
  assert.equal(debuggingPortOf("Google Chrome --remote-debugging-port=0"), 0);
  assert.equal(debuggingPortOf("Google Chrome --user-data-dir=/x"), 0);
  assert.equal(debuggingPortOf(""), 0);
});

test("a lock naming a dead pid, or no lock, is no holder", () => {
  const profile = tempProfile();
  assert.equal(liveProfileChrome(profile), null);
  lockTo(profile, 2147483646);
  assert.equal(liveProfileChrome(profile), null);
});

// The regression: the live Chrome answered on its port, but TwebDevToolsPort was gone, so tweb
// launched a second Chrome that Chrome's profile lock refused, failed after 15s and deleted the
// files again — a loop no pane could leave.
test("a live Chrome whose port file is gone is reused, not launched again", async (t) => {
  const port = await freePort();
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"Browser":"Chrome/test"}'); });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const child = fakeChrome(port);
  t.after(() => { child.kill(); server.close(); });
  const profile = tempProfile();
  lockTo(profile, child.pid);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const result = await ensureChrome(profile, { env: { TWEB_CHROME: "/nonexistent/chrome" } });

  assert.equal(result.launched, null);
  assert.equal(result.version.Browser, "Chrome/test");
  assert.equal(fs.readFileSync(path.join(profile, "TwebDevToolsPort"), "utf8").trim(), String(port));
});

test("a live Chrome with no answering port fails at once with the reason, and launches nothing", async (t) => {
  const child = fakeChrome(0);
  t.after(() => child.kill());
  const profile = tempProfile();
  lockTo(profile, child.pid);
  await new Promise((resolve) => setTimeout(resolve, 300));

  await assert.rejects(
    ensureChrome(profile, { env: { TWEB_CHROME: "/nonexistent/chrome" } }),
    new RegExp(`Chrome pid ${child.pid} holds the profile`),
  );
});
