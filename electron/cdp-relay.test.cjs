"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const net = require("node:net");
const test = require("node:test");
const { openCdpRelay, encodeFrame, parseFrames } = require("./cdp-relay.cjs");

// bun (which runs `make electron-test`) delivers the `upgrade` event but drops whatever is written to
// its socket, so a WebSocket handshake never reaches the client there. The engine runs on Electron's
// Node, where these pass; `electron --test electron/cdp-relay.test.cjs` (ELECTRON_RUN_AS_NODE=1)
// runs them. Under bun they are skipped rather than left to time out.
const wsCapable = !process.versions.bun;
// bun's node:test ignores the `skip` option, so the runner itself is picked.
const wsTest = wsCapable ? test : test.skip;

// A stand-in for `webContents.debugger`: answers every command with its own method name, and lets
// the test emit page events.
function fakeDebugger() {
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    on(event, fn) { if (event === "message") listeners.add(fn); },
    off(event, fn) { listeners.delete(fn); },
    listenerCount() { return listeners.size; },
    async sendCommand(method, params) {
      sent.push(method);
      if (method === "Fail.please") throw new Error("nope");
      return { echoed: method, params };
    },
    emit(method, params) { for (const fn of listeners) fn({}, method, params); },
  };
}

function masked(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i & 3];
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x81, 0x80 | length])
    : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([length >> 8, length & 0xff])]);
  return Buffer.concat([header, mask, body]);
}

// A minimal WebSocket client over a raw socket: enough to speak CDP JSON to the relay.
function connectWs(url) {
  const { port, pathname } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), "127.0.0.1");
    const key = crypto.randomBytes(16).toString("base64");
    let handshaken = false;
    let buffer = Buffer.alloc(0);
    const inbox = [];
    const waiters = [];
    const deliver = (message) => {
      const index = waiters.findIndex((w) => w.match(message));
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
      else inbox.push(message);
    };
    socket.on("connect", () => socket.write(
      `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 4);
        if (!head.startsWith("HTTP/1.1 101")) { reject(new Error(head.split("\r\n")[0])); socket.destroy(); return; }
        handshaken = true;
        resolve({
          send: (message) => socket.write(masked(JSON.stringify(message))),
          next: (match) => {
            const index = inbox.findIndex(match);
            if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
            return new Promise((r) => waiters.push({ match, resolve: r }));
          },
          close: () => socket.destroy(),
        });
      }
      // Server frames are unmasked; reuse the parser by masking with zeros is not possible, so read
      // them directly.
      let offset = 0;
      while (buffer.length - offset >= 2) {
        let length = buffer[offset + 1] & 0x7f;
        let pos = offset + 2;
        if (length === 126) { if (buffer.length < pos + 2) break; length = buffer.readUInt16BE(pos); pos += 2; }
        else if (length === 127) { if (buffer.length < pos + 8) break; length = Number(buffer.readBigUInt64BE(pos)); pos += 8; }
        if (buffer.length < pos + length) break;
        const opcode = buffer[offset] & 0x0f;
        if (opcode === 1) deliver(JSON.parse(buffer.subarray(pos, pos + length).toString("utf8")));
        offset = pos + length;
      }
      buffer = buffer.subarray(offset);
    });
    socket.on("error", reject);
  });
}

function rawRequest(port, request) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    let text = "";
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("close", () => resolve(text));
    socket.on("error", () => resolve(text));
  });
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
  });
}

test("the relay listens only between open and close, on 127.0.0.1", async () => {
  const dbg = fakeDebugger();
  const relay = await openCdpRelay({ debugger: dbg, page: () => ({ url: "https://a/", title: "A" }) });
  assert.match(relay.url, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f]{48}$/);
  assert.equal(await listening(relay.port), true);
  assert.equal(dbg.listenerCount(), 1);
  await relay.close();
  assert.equal(await listening(relay.port), false, "the port is closed after close()");
  assert.equal(dbg.listenerCount(), 0, "the debugger listener goes with it");
  await relay.close();
});

wsTest("nothing answers without the token: no /json endpoints, no upgrade on another path", async () => {
  const relay = await openCdpRelay({ debugger: fakeDebugger(), page: () => ({ url: "", title: "" }) });
  try {
    const version = await rawRequest(relay.port, "GET /json/version HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert.match(version, /^HTTP\/1\.1 404/);
    const wrong = relay.url.replace(/[0-9a-f]{48}$/, "0".repeat(48));
    await assert.rejects(connectWs(wrong), /403/);
  } finally {
    await relay.close();
  }
});

wsTest("one target, the pane's tab; its page session is relayed to the tab's debugger", async () => {
  const dbg = fakeDebugger();
  const relay = await openCdpRelay({ debugger: dbg, page: () => ({ url: "https://tab/", title: "Tab" }) });
  const ws = await connectWs(relay.url);
  try {
    ws.send({ id: 1, method: "Browser.getVersion" });
    assert.ok((await ws.next((m) => m.id === 1)).result.product);
    ws.send({ id: 2, method: "Target.getTargets" });
    const { targetInfos } = (await ws.next((m) => m.id === 2)).result;
    assert.equal(targetInfos.length, 1);
    assert.equal(targetInfos[0].url, "https://tab/");
    ws.send({ id: 3, method: "Target.attachToTarget", params: { targetId: targetInfos[0].targetId, flatten: true } });
    const { sessionId } = (await ws.next((m) => m.id === 3)).result;
    ws.send({ id: 4, sessionId, method: "Runtime.evaluate", params: { expression: "1" } });
    const answer = await ws.next((m) => m.id === 4);
    assert.equal(answer.sessionId, sessionId);
    assert.equal(answer.result.echoed, "Runtime.evaluate");
    ws.send({ id: 5, sessionId, method: "Fail.please" });
    assert.match((await ws.next((m) => m.id === 5)).error.message, /nope/);
    dbg.emit("Page.loadEventFired", { timestamp: 1 });
    const event = await ws.next((m) => m.method === "Page.loadEventFired");
    assert.equal(event.sessionId, sessionId);
    ws.send({ id: 6, method: "Target.attachToTarget", params: { targetId: "SOMEONE-ELSE" } });
    assert.ok((await ws.next((m) => m.id === 6)).error);
  } finally {
    ws.close();
    await relay.close();
  }
});

wsTest("commands that would act on the engine are refused, at browser and page level", async () => {
  const dbg = fakeDebugger();
  const relay = await openCdpRelay({ debugger: dbg, page: () => ({ url: "", title: "" }) });
  const ws = await connectWs(relay.url);
  try {
    ws.send({ id: 1, method: "Browser.close" });
    assert.match((await ws.next((m) => m.id === 1)).error.message, /not allowed/);
    ws.send({ id: 2, method: "Target.createTarget", params: { url: "about:blank" } });
    assert.match((await ws.next((m) => m.id === 2)).error.message, /not allowed/);
    ws.send({ id: 3, method: "Target.getTargets" });
    const { targetInfos } = (await ws.next((m) => m.id === 3)).result;
    ws.send({ id: 4, method: "Target.attachToTarget", params: { targetId: targetInfos[0].targetId } });
    const { sessionId } = (await ws.next((m) => m.id === 4)).result;
    ws.send({ id: 5, sessionId, method: "Browser.close" });
    assert.match((await ws.next((m) => m.id === 5)).error.message, /not allowed/);
    assert.deepEqual(dbg.sent, [], "none of them reached the tab's debugger");
  } finally {
    ws.close();
    await relay.close();
  }
});

test("frames: an unmasked client frame is refused, a large server frame is encoded with 64-bit length", () => {
  assert.equal(parseFrames(Buffer.from([0x81, 0x01, 0x41]), () => {}), null);
  const big = encodeFrame("x".repeat(70000));
  assert.equal(big[1], 127);
  assert.equal(Number(big.readBigUInt64BE(2)), 70000);
});
