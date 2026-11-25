"use strict";

// A CDP endpoint for one tab, open only while `tweb action` runs.
//
// `tweb action` drives a pane's tab with agent-browser, which speaks the Chrome DevTools Protocol
// to a browser endpoint. The obvious endpoint is Chromium's own `--remote-debugging-port`, and #313
// used it, but that switch is read once at start and cannot be closed again: the engine sat with an
// unauthenticated CDP port on 127.0.0.1 for its whole life, and any local process could drive every
// logged-in tab through it. So this is the endpoint instead:
//
//   - It exists only between `action-target` and `action-release` (or the hold's timeout), on
//     127.0.0.1 and a port the OS picks, and it answers only a WebSocket upgrade on a path holding
//     a random token. Every HTTP request, and an upgrade on any other path, is refused.
//   - It shows one target, the pane's tab, and relays that tab's page session through
//     `webContents.debugger`, which tweb already attaches for its own input and file chooser.
//   - The browser-level surface is what agent-browser was measured to send (Browser.getVersion,
//     Target.setDiscoverTargets, Target.getTargets, Target.attachToTarget) plus a few harmless
//     reads. Anything that would act on the browser rather than the page — Browser.close,
//     Target.closeTarget, Target.createTarget — is answered with an error: over CDP `close` closes
//     the engine, and that is every pane's.
//
// The WebSocket server is written out here (RFC 6455: handshake, framing, ping/close) because the
// engine has no `ws` dependency and Node has a client but no server.

const crypto = require("node:crypto");
const http = require("node:http");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// One screenshot of a 2880x1800 page is a few MB of base64; a client message is a command.
const MAX_CLIENT_FRAME = 16 * 1024 * 1024;
const REFUSED = new Set(["Browser.close", "Browser.crash", "Target.closeTarget", "Target.createTarget",
  "Target.createBrowserContext", "Target.disposeBrowserContext", "Browser.setDownloadBehavior"]);

function encodeFrame(text, opcode = 1) {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

// Parses as many complete client frames as `buffer` holds. Returns the rest, or null when the
// stream is not one a client may send (unmasked, or a frame over the limit) and must be dropped.
function parseFrames(buffer, onFrame) {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    if (!(b1 & 0x80)) return null;
    let length = b1 & 0x7f;
    let pos = offset + 2;
    if (length === 126) {
      if (buffer.length < pos + 2) break;
      length = buffer.readUInt16BE(pos); pos += 2;
    } else if (length === 127) {
      if (buffer.length < pos + 8) break;
      const big = buffer.readBigUInt64BE(pos); pos += 8;
      if (big > BigInt(MAX_CLIENT_FRAME)) return null;
      length = Number(big);
    }
    if (length > MAX_CLIENT_FRAME) return null;
    if (buffer.length < pos + 4 + length) break;
    const mask = buffer.subarray(pos, pos + 4);
    pos += 4;
    const payload = Buffer.from(buffer.subarray(pos, pos + length));
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    onFrame({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    offset = pos + length;
  }
  return buffer.subarray(offset);
}

/**
 * Opens the relay for one tab.
 *
 * @param {object} options
 * @param {{ sendCommand(method: string, params?: object): Promise<object>,
 *           on(event: "message", fn: Function): void, off?(event: string, fn: Function): void,
 *           removeListener?(event: string, fn: Function): void }} options.debugger
 *        the tab's attached `webContents.debugger`
 * @param {() => {url: string, title: string}} options.page what the tab shows now
 * @returns {Promise<{ url: string, port: number, close(): Promise<void> }>}
 */
async function openCdpRelay({ debugger: dbg, page }) {
  const token = crypto.randomBytes(24).toString("hex");
  const targetId = crypto.randomBytes(16).toString("hex").toUpperCase();
  const sessionId = crypto.randomBytes(16).toString("hex").toUpperCase();
  const path = `/devtools/browser/${token}`;
  const sockets = new Set();

  const targetInfo = () => {
    const { url, title } = page();
    return { targetId, type: "page", title: title || "", url: url || "", attached: true, canAccessOpener: false,
      browserContextId: "tweb" };
  };

  const send = (socket, message) => {
    if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(message)));
  };

  const onDebuggerMessage = (_event, method, params, childSession) => {
    // Child sessions (an out-of-process frame tweb attached for itself) are tweb's, not the agent's.
    if (childSession) return;
    for (const socket of sockets) send(socket, { method, params, sessionId });
  };
  dbg.on("message", onDebuggerMessage);

  async function browserCommand(socket, { id, method, params }) {
    if (REFUSED.has(method)) {
      return send(socket, { id, error: { code: -32000, message: `${method} is not allowed through tweb action: it would act on tweb's engine, not this tab` } });
    }
    switch (method) {
      case "Browser.getVersion":
        return send(socket, { id, result: { protocolVersion: "1.3", product: `Chrome/${process.versions.chrome || ""}`,
          revision: "", userAgent: "", jsVersion: process.versions.v8 || "" } });
      case "Target.setDiscoverTargets":
        send(socket, { id, result: {} });
        if (params?.discover) send(socket, { method: "Target.targetCreated", params: { targetInfo: targetInfo() } });
        return undefined;
      case "Target.getTargets":
        return send(socket, { id, result: { targetInfos: [targetInfo()] } });
      case "Target.getTargetInfo":
        return send(socket, { id, result: { targetInfo: targetInfo() } });
      case "Target.setAutoAttach":
      case "Target.activateTarget":
        return send(socket, { id, result: {} });
      case "Target.getBrowserContexts":
        return send(socket, { id, result: { browserContextIds: ["tweb"] } });
      case "Target.attachToTarget":
        if (params?.targetId !== targetId) {
          return send(socket, { id, error: { code: -32602, message: "No target with given id found" } });
        }
        send(socket, { method: "Target.attachedToTarget",
          params: { sessionId, targetInfo: targetInfo(), waitingForDebugger: false } });
        return send(socket, { id, result: { sessionId } });
      default:
        return send(socket, { id, error: { code: -32601, message: `'${method}' wasn't found` } });
    }
  }

  async function onMessage(socket, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const { id, method, params } = message;
    if (typeof id !== "number" || typeof method !== "string") return;
    if (!message.sessionId) {
      await browserCommand(socket, message);
      return;
    }
    if (message.sessionId !== sessionId) {
      send(socket, { id, sessionId: message.sessionId, error: { code: -32001, message: "Session with given id not found." } });
      return;
    }
    if (REFUSED.has(method)) {
      send(socket, { id, sessionId, error: { code: -32000, message: `${method} is not allowed through tweb action` } });
      return;
    }
    try {
      const result = await dbg.sendCommand(method, params || {});
      send(socket, { id, sessionId, result: result || {} });
    } catch (error) {
      send(socket, { id, sessionId, error: { code: -32000, message: String(error?.message || error) } });
    }
  }

  const server = http.createServer((_req, res) => {
    // No /json/version, /json/list: the token travels only in the WebSocket URL `tweb action` hands
    // agent-browser, so nothing here may answer without it.
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (req.url !== path || typeof key !== "string" || String(req.headers.upgrade).toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    let fragments = [];
    socket.on("data", (chunk) => {
      const rest = parseFrames(Buffer.concat([pending, chunk]), ({ fin, opcode, payload }) => {
        if (opcode === 8) { socket.end(encodeFrame("", 8)); return; }
        if (opcode === 9) { if (!socket.destroyed) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); return; }
        if (opcode === 1 || opcode === 0) {
          fragments.push(payload);
          if (fin) {
            const text = Buffer.concat(fragments).toString("utf8");
            fragments = [];
            void onMessage(socket, text);
          }
        }
      });
      if (rest === null) { socket.destroy(); return; }
      pending = rest;
    });
    const drop = () => sockets.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    (dbg.off || dbg.removeListener).call(dbg, "message", onDebuggerMessage);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { url: `ws://127.0.0.1:${port}${path}`, port, close };
}

module.exports = { openCdpRelay, encodeFrame, parseFrames };
