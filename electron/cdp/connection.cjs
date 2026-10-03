"use strict";

// The real Google Chrome, driven over the DevTools protocol, as the page engine.
//
// WHY this exists at all: some sites only work in the user's managed Chrome. Okta Device
// Assurance answers through macOS Extensible SSO, which Chrome calls and Electron never does;
// Endpoint Verification and Cyberhaven are policy force-installed extensions whose APIs
// (`enterprise.*`, `nativeMessaging`, `webRequest`) Electron does not implement. Measured on
// this machine with Chrome 154: a CDP-launched Chrome on its own `--user-data-dir` still gets
// every machine policy, force-installs both extensions within seconds, and lands on the Okta
// dashboard without a password. So rather than imitate any of that, the pages run in Chrome.
//
// The Electron process stays the host. Everything that is not a page — the kitty frame
// pipeline, nativeImage decoding, the clipboard, the float window, the agent socket — is
// still Electron's. Only the tabs move.
//
// One Chrome per profile, shared by every pane: Chrome refuses a second instance on the same
// user-data-dir (it hands the command line to the first and exits), so each engine looks for a
// running one through `DevToolsActivePort` before launching its own.

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

function findChrome(env = process.env, exists = fs.existsSync) {
  if (env.TWEB_CHROME) return env.TWEB_CHROME;
  return CHROME_CANDIDATES.find((candidate) => exists(candidate)) || null;
}

// Headless by default. A headed Chrome is a real window the user can Cmd-Tab to, which is not
// what a pane is; and headless keeps the policy extensions and the Okta SSO path (measured).
// `TWEB_CHROME_HEADED=1` is the escape hatch for a site that refuses headless.
function chromeArgs(userDataDir, env = process.env) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    // 0 lets Chrome pick a free port and write it to DevToolsActivePort, so concurrent
    // profiles never collide on a fixed number.
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    // A pane is the foreground even though no Chrome window is; without these the page's
    // timers and rAF are throttled exactly as a background tab's would be.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--hide-scrollbars",
  ];
  if (env.TWEB_CHROME_HEADED === "1") args.push("--window-position=-32000,-32000", "--window-size=800,600");
  else args.push("--headless=new");
  args.push("about:blank");
  return args;
}

function readActivePort(userDataDir) {
  try {
    const [port, wsPath] = fs.readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").split("\n");
    const value = Number(port);
    return Number.isInteger(value) && value > 0 ? { port: value, wsPath: wsPath.trim() } : null;
  } catch (_) {
    return null;
  }
}

async function probeBrowser(active) {
  if (!active) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${active.port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `TWEB_CDP_TRACE=1` logs every command and every non-noisy event to stderr. The protocol is the
// whole interface between the two processes, so when a tab stalls this is where it shows.
const TRACE = process.env.TWEB_CDP_TRACE === "1";
const NOISY = new Set(["Page.screencastFrame", "Network.requestWillBeSent", "Network.responseReceived",
  "Network.loadingFinished", "Network.dataReceived", "Network.requestWillBeSentExtraInfo",
  "Network.responseReceivedExtraInfo", "Runtime.consoleAPICalled"]);
function trace(line) {
  if (TRACE) console.error(`tweb: cdp ${line.slice(0, 300)}`);
}

/// A running Chrome for `userDataDir`, launched if there is none. Resolves to its version info,
/// including `webSocketDebuggerUrl`.
async function ensureChrome(userDataDir, { env = process.env, log = () => {} } = {}) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const existing = await probeBrowser(readActivePort(userDataDir));
  if (existing) return { version: existing, launched: null };
  // A file left by a Chrome that is gone would otherwise be read as the new one's port.
  try { fs.rmSync(path.join(userDataDir, "DevToolsActivePort"), { force: true }); } catch (_) { /* best effort */ }
  const binary = findChrome(env);
  if (!binary) throw new Error("Google Chrome not found; install it or set TWEB_CHROME");
  log(`chrome launch ${binary}`);
  // Detached so a pane closing does not take Chrome — and every other pane's tabs — with it.
  const child = spawn(binary, chromeArgs(userDataDir, env), { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 150; i += 1) {
    await sleep(100);
    const version = await probeBrowser(readActivePort(userDataDir));
    if (version) return { version, launched: child };
  }
  throw new Error(`Chrome did not open its DevTools port within 15s (${binary})`);
}

/// One browser-level DevTools connection, flat sessions multiplexed over it.
class CdpConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.setMaxListeners(0);
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.closed = false;
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.onClose());
    socket.addEventListener("error", () => this.onClose());
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`CDP connect failed: ${url}`)), { once: true });
    });
    return new CdpConnection(socket);
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    } catch (_) {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (TRACE) trace(`<- #${message.id} ${entry.method} ${message.error ? "ERR " + message.error.message : "ok"}`);
      if (message.error) {
        const error = new Error(`${entry.method}: ${message.error.message}`);
        error.code = message.error.code;
        entry.reject(error);
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    if (TRACE && !NOISY.has(message.method)) trace(`<- ${message.method} ${(message.sessionId || "").slice(0, 6)} ${JSON.stringify(message.params || {})}`);
    // One listener throwing must not take the engine down. These handlers run on the socket's
    // message callback, where an uncaught throw ends the Electron main process with nothing in
    // the pane to say why — measured: a missing `event.reply` killed the engine silently on the
    // first preload-ready. Logged with its stack instead, and the next event still arrives.
    try {
      const session = message.sessionId ? this.sessions.get(message.sessionId) : null;
      if (session) session.emit(message.method, message.params || {}, message.sessionId);
      this.emit("event", message.method, message.params || {}, message.sessionId || null);
      if (!message.sessionId) this.emit(message.method, message.params || {});
    } catch (error) {
      console.error(`tweb: cdp ${message.method} handler failed: ${error.stack || error.message}`);
    }
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(new Error(`${entry.method}: CDP connection closed`));
    this.pending.clear();
    this.emit("close");
  }

  send(method, params = {}, sessionId = undefined) {
    if (this.closed) return Promise.reject(new Error(`${method}: CDP connection closed`));
    const id = ++this.nextId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    if (TRACE && method !== "Page.screencastFrameAck") trace(`-> #${id} ${method} ${(sessionId || "").slice(0, 6)} ${JSON.stringify(params)}`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify(message));
    });
  }

  session(sessionId) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new CdpSession(this, sessionId);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  dropSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.detached = true;
    session.emit("detached");
  }

  close() {
    try { this.socket.close(); } catch (_) { /* already gone */ }
  }
}

class CdpSession extends EventEmitter {
  constructor(connection, id) {
    super();
    this.setMaxListeners(0);
    this.connection = connection;
    this.id = id;
    this.detached = false;
  }

  send(method, params = {}) {
    if (this.detached) return Promise.reject(new Error(`${method}: session detached`));
    return this.connection.send(method, params, this.id);
  }
}

module.exports = {
  CdpConnection,
  CdpSession,
  chromeArgs,
  ensureChrome,
  findChrome,
  readActivePort,
};
