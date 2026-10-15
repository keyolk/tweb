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
const net = require("node:net");
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

// macOS gives an outside url open (a Slack link, `open URL`) to whichever running process has
// Chrome's bundle id, and the engine's headless Chrome has the same one, so the tab can open where
// nobody sees it. Starting the installed Chrome binary directly, on its default profile, is not
// routed by LaunchServices: Chrome's ProcessSingleton passes the url to the user's own Chrome and
// exits (measured: gone in under 4s, no new instance). With no user Chrome running, it starts one.
// TWEB_CHROME is ignored here on purpose: the user's browser is the installed one, not the binary
// this engine was pointed at.
function handOffToUserChrome(url, { exists = fs.existsSync, spawnFn = spawn } = {}) {
  const binary = findChrome({}, exists);
  if (!binary) return false;
  const child = spawnFn(binary, [url], { detached: true, stdio: "ignore" });
  child.on?.("error", () => {});
  child.unref?.();
  return true;
}

// Headless by default. A headed Chrome is a real window the user can Cmd-Tab to, which is not
// what a pane is; and headless keeps the policy extensions and the Okta SSO path (measured).
// `TWEB_CHROME_HEADED=1` is the escape hatch for a site that refuses headless.
//
// `port` is the debugging port tweb picked (`freePort`), or 0 to let Chrome pick one. A picked
// port is also the one origin allowed to open a DevTools WebSocket: Chrome refuses any upgrade
// that carries an Origin header unless `--remote-allow-origins` names it, and the DevTools page
// it serves itself at `http://127.0.0.1:<port>/devtools/inspector.html` sends exactly that
// origin — measured: no Origin 101, that Origin without the flag dropped, a wrong port 403. So
// `tweb devtools` works only when the port is known before launch. Never `*`: that would let any
// web page on this machine drive the signed-in profile over the port.
//
// `scaleFactor` is the screen's device scale factor, forced on the whole browser. The metrics
// override that sizes each tab sets it for the tab's own renderer only: an out-of-process iframe
// is drawn by another renderer, which took the headless window's 1x, and the compositor scaled
// that up to the tab's 1.6. Text in such a frame came out soft while the page around it was sharp
// — measured on a claude.ai artifact, whose whole body is a cross-origin frame. Forced to the
// pane's own scale every renderer draws at it, and the override still sets the tab's exact size.
function chromeArgs(userDataDir, env = process.env, port = 0, scaleFactor = 0) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    // Chrome writes the port it bound to DevToolsActivePort either way, so concurrent profiles
    // find their own Chrome by that file and never by a fixed number.
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    // A pane is the foreground even though no Chrome window is; without these the page's
    // timers and rAF are throttled exactly as a background tab's would be.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--hide-scrollbars",
    // `--remote-debugging-port` alone sets `navigator.webdriver`, with or without a client
    // attached, and YouTube stops a video about a minute in with "Something went wrong" when it
    // is set. Measured on one video, Chrome 155 with no tweb involved: headless, headless with
    // the headless marker out of the user agent, headed off-screen, and headed with no CDP client
    // at all all failed at 40-60s of playback; headless with CDP attached and this flag played
    // past 129s. It turns off only the `webdriver` flag, not the debugging port tweb drives.
    "--disable-blink-features=AutomationControlled",
  ];
  if (scaleFactor > 0) args.push(`--force-device-scale-factor=${scaleFactor}`);
  if (port) args.push(`--remote-allow-origins=http://127.0.0.1:${port}`);
  if (env.TWEB_CHROME_HEADED === "1") args.push("--window-position=-32000,-32000", "--window-size=800,600");
  else args.push("--headless=new");
  args.push("about:blank");
  return args;
}

// Chrome writes DevToolsActivePort only when it picked the port itself (`--remote-debugging-port=0`).
// Launched on a port tweb picked, it writes nothing — measured with Chrome 155 — so tweb records
// that port in a file of its own, and every pane finds the shared Chrome by either file.
const PICKED_PORT_FILE = "TwebDevToolsPort";

function readActivePort(userDataDir) {
  for (const name of ["DevToolsActivePort", PICKED_PORT_FILE]) {
    try {
      const [port, wsPath = ""] = fs.readFileSync(path.join(userDataDir, name), "utf8").split("\n");
      const value = Number(port);
      if (Number.isInteger(value) && value > 0) return { port: value, wsPath: wsPath.trim() };
    } catch (_) {
      // Not this file; try the next.
    }
  }
  return null;
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
async function ensureChrome(userDataDir, { env = process.env, log = () => {}, scaleFactor = 0 } = {}) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const existing = await probeBrowser(readActivePort(userDataDir));
  if (existing) return { version: existing, launched: null };
  // A file left by a Chrome that is gone would otherwise be read as the new one's port.
  for (const name of ["DevToolsActivePort", PICKED_PORT_FILE]) {
    try { fs.rmSync(path.join(userDataDir, name), { force: true }); } catch (_) { /* best effort */ }
  }
  const binary = findChrome(env);
  if (!binary) throw new Error("Google Chrome not found; install it or set TWEB_CHROME");
  log(`chrome launch ${binary}`);
  // A port free a moment ago can be taken before Chrome binds it, and then Chrome never answers on
  // it. That launch is given up on and Chrome started again on a port of its own choosing: no
  // DevTools page for `tweb devtools`, everything else as before, rather than no browser.
  const picked = await freePort().catch(() => 0);
  if (picked) {
    const launched = await launchChrome(binary, userDataDir, env, picked, 100, scaleFactor);
    if (launched) return launched;
    log(`chrome did not answer on picked port ${picked}; relaunching on a port of its own`);
  }
  const launched = await launchChrome(binary, userDataDir, env, 0, 150, scaleFactor);
  if (launched) return launched;
  throw new Error(`Chrome did not open its DevTools port within 15s (${binary})`);
}

// One launch, waited on for `tries` x 100ms. Null when it never answered, with the process killed
// so the relaunch is not refused as a second instance on the same profile.
async function launchChrome(binary, userDataDir, env, port, tries, scaleFactor = 0) {
  // Detached so a pane closing does not take Chrome — and every other pane's tabs — with it.
  const child = spawn(binary, chromeArgs(userDataDir, env, port, scaleFactor), { detached: true, stdio: "ignore" });
  child.unref();
  if (port) {
    try { fs.writeFileSync(path.join(userDataDir, PICKED_PORT_FILE), `${port}\n`); } catch (_) { /* best effort */ }
  }
  for (let i = 0; i < tries; i += 1) {
    await sleep(100);
    const version = await probeBrowser(readActivePort(userDataDir));
    if (version) return { version, launched: child };
  }
  try { child.kill(); } catch (_) { /* already gone */ }
  try { fs.rmSync(path.join(userDataDir, PICKED_PORT_FILE), { force: true }); } catch (_) { /* best effort */ }
  await sleep(500);
  return null;
}

// A loopback port nobody is listening on right now.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Whether this Chrome lets its own DevTools page connect: an upgrade carrying that page's origin
// is answered 101 only when `--remote-allow-origins` names it. Asked of the running Chrome rather
// than assumed, because the Chrome a pane finds may have been launched by an older tweb.
function devtoolsOriginAllowed(port, browserWsUrl) {
  if (!port || !browserWsUrl) return Promise.resolve(false);
  const http = require("node:http");
  const { pathname } = new URL(browserWsUrl);
  return new Promise((resolve) => {
    const request = http.request({
      host: "127.0.0.1", port, path: pathname, timeout: 1500,
      headers: {
        Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dHdlYi1kZXZ0b29scy0xMg==", Origin: `http://127.0.0.1:${port}`,
      },
    });
    request.on("upgrade", (_response, socket) => { socket.destroy(); resolve(true); });
    request.on("response", (response) => { response.resume(); resolve(false); });
    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.on("error", () => resolve(false));
    request.end();
  });
}

// The DevTools page for one target, served by the Chrome that owns it. Null when that Chrome was
// launched without an allowed origin (before tweb picked its port, or when the pick failed):
// the page would load and then lose its connection at once.
function devtoolsUrl(port, targetId, allowed) {
  if (!port || !targetId || !allowed) return null;
  return `http://127.0.0.1:${port}/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/${targetId}`;
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
  devtoolsOriginAllowed,
  devtoolsUrl,
  ensureChrome,
  freePort,
  findChrome,
  handOffToUserChrome,
  readActivePort,
};
