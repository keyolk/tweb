"use strict";

// WKWebView tabs presented as the offscreen `BrowserWindow`s main.cjs makes for every tab, plus
// the process-wide pieces Electron hangs off its modules (`ipcMain`, `session.defaultSession`),
// restated over one tweb-webkit host. The shape is cdp/engine.cjs's; cdp/backend.cjs routes to
// whichever engine `TWEB_BROWSER` names.

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { WebKitHelper } = require("./helper.cjs");
const { WebKitWebContents } = require("./web-contents.cjs");
const { preloadScript, BINDING_NAME } = require("../cdp/preload-bridge.cjs");
const {
  AUDIO_PROBE, CONTEXT_MENU_PROBE, NO_BOUNCE, PRINT_SHIM, TITLE_PROBE,
} = require("../cdp/web-contents.cjs");

const HIDDEN_BOUNDS = { x: -10_000, y: -10_000 };

// The preload's channel out, in its isolated world. `__twebIpc` is the binding the shared bridge
// (preload-bridge.cjs) captures and deletes before the preload runs, so the preload is the same
// text on all three engines. The handler is registered for this world only: the page cannot reach
// it, and cannot forge a message into the preload's channel.
//
// Every message carries the document's own id. WebKit reports no subframe navigations, so a new
// id from a known frame is how a frame's new document is noticed; `pagehide` is how a removed
// iframe is.
const TWEB_BRIDGE = `(() => {
  const doc = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.twebIpc;
  const post = (name, payload) => {
    try { handler.postMessage(JSON.stringify({ doc, name, payload })); } catch (error) { void error; }
  };
  globalThis[${JSON.stringify(BINDING_NAME)}] = (payload) => post("ipc", payload);
  globalThis.__twebContextMenu = (payload) => post("contextmenu", payload);
  globalThis.__twebTitle = (payload) => post("title", payload);
  addEventListener("pagehide", () => post("gone", null));
  // A page WebKit restores from its back-forward cache keeps its preload running, but the engine
  // dropped the frame from its ready set when the navigation began — measured: after a Back,
  // \`tweb snapshot\` answered nothing and no shortcut reached the page. The preload already
  // re-registers when the engine asks whether it is there; a restored page asks for itself.
  addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    globalThis.__twebReceive && globalThis.__twebReceive("tweb-are-you-there", []);
  });
})();`;

// The page world's reporting: audio state (AUDIO_PROBE calls `__twebAudio`) and the console, which
// WebKit gives the embedder no other way to read. Both are facts a page could only forge about
// itself.
const PAGE_BRIDGE = `(() => {
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.twebPage;
  const post = (body) => {
    try { handler && handler.postMessage(JSON.stringify(body)); } catch (error) { void error; }
  };
  Object.defineProperty(globalThis, "__twebAudio", {
    configurable: true, value: (payload) => post({ name: "audio", payload }),
  });
  const text = (value) => {
    if (typeof value === "string") return value;
    try { return value instanceof Error ? String(value.stack || value) : JSON.stringify(value) ?? String(value); }
    catch (error) { void error; return String(value); }
  };
  for (const level of ["debug", "log", "info", "warn", "error"]) {
    const original = console[level];
    if (typeof original !== "function") continue;
    console[level] = function (...args) {
      post({ name: "console", level, message: args.map(text).join(" ") });
      return original.apply(this, args);
    };
  }
  addEventListener("error", (event) => post({
    name: "console", level: "error", message: event.message, line: event.lineno, source: event.filename,
  }));
  addEventListener("unhandledrejection", (event) => post({
    name: "console", level: "error", message: "Unhandled rejection: " + text(event.reason),
  }));
})();`;

/// Safari's own application name, so a site sees the browser it is talking to. WKWebView's
/// default user agent stops before "Version/... Safari/...", and sites read the missing tokens as
/// an old or unknown browser.
function safariApplicationName() {
  try {
    const plist = fs.readFileSync("/Applications/Safari.app/Contents/Info.plist", "utf8");
    const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    if (version) return `Version/${version} Safari/605.1.15`;
  } catch (_) { /* no Safari: keep WebKit's default */ }
  return null;
}

class WebKitBrowserWindow extends EventEmitter {
  constructor(engine, options = {}) {
    super();
    this.setMaxListeners(0);
    this.engine = engine;
    this.destroyed = false;
    this.title = "";
    this.contentSize = {
      width: Math.max(1, Math.round(options.width || 800)),
      height: Math.max(1, Math.round(options.height || 600)),
    };
    this.scaleFactor = options.webPreferences?.offscreen?.deviceScaleFactor || engine.scaleFactor || 1;
    this.webContents = null;
  }

  attach(contents) {
    this.webContents = contents;
    contents.on("destroyed", () => this.onContentsDestroyed());
  }

  onContentsDestroyed() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.engine.forget(this);
    this.emit("closed");
  }

  // The view is the content size in points, on a screen of the pane's scale, so its pictures come
  // out at exactly the pane's pixel size. Zoom is the page's own and leaves the view alone.
  relayout(force = false) {
    const contents = this.webContents;
    if (!contents || contents.isDestroyed()) return;
    if (contents.deviceEmulation && !force) return;
    contents.frameSize = {
      width: Math.max(1, Math.round(this.contentSize.width * this.scaleFactor)),
      height: Math.max(1, Math.round(this.contentSize.height * this.scaleFactor)),
    };
    contents.command({
      op: "resize", width: this.contentSize.width, height: this.contentSize.height, scale: this.scaleFactor,
    });
  }

  isDestroyed() { return this.destroyed; }
  getContentSize() { return [this.contentSize.width, this.contentSize.height]; }

  setContentSize(width, height) {
    const next = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
    if (next.width === this.contentSize.width && next.height === this.contentSize.height) return;
    this.contentSize = next;
    this.relayout();
    this.emit("resize");
  }

  getBounds() { return { ...HIDDEN_BOUNDS, ...this.contentSize }; }
  getContentBounds() { return this.getBounds(); }
  setBounds(bounds) {
    if (bounds && bounds.width && bounds.height) this.setContentSize(bounds.width, bounds.height);
  }

  loadURL(url) { return this.webContents.loadURL(url); }
  loadFile(file) { return this.loadURL(`file://${path.resolve(file)}`); }
  reload() { this.webContents?.reload(); }
  setTitle(title) { this.title = String(title); }
  getTitle() { return this.title; }

  // The host's window is its own business (present, invisible, untouchable — see app.rs). To
  // main.cjs it is the hidden, unfocused offscreen window it is trying to keep, so the watchdog
  // that keeps windows hidden has nothing to do.
  getOpacity() { return 0; }
  setOpacity() {}
  isFocusable() { return false; }
  setFocusable() {}
  setSkipTaskbar() {}
  setIgnoreMouseEvents() {}
  isFocused() { return false; }
  isVisible() { return false; }
  isFullScreen() { return false; }
  setFullScreen() {}
  show() {}
  showInactive() {}
  hide() {}
  blur() {}
  focus() { this.webContents?.focus(); }
  moveTop() {}

  close() {
    if (this.destroyed) return;
    this.engine.helper.send({ op: "close", view: this.webContents.view });
  }

  destroy() { this.close(); }
}

class WebKitIpcMain extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  deliver(channel, event, args) {
    this.emit(channel, event, ...args);
  }
}

class WebKitDownloadItem extends EventEmitter {
  constructor(engine, event) {
    super();
    this.engine = engine;
    this.id = event.dl;
    this.url = event.url;
    this.filename = event.filename || "download";
    this.savePath = null;
    this.received = 0;
    this.total = Math.max(0, Number(event.total) || 0);
    this.cancelled = false;
  }

  getFilename() { return this.filename; }
  getURL() { return this.url; }
  setSavePath(destination) { this.savePath = destination; }
  getSavePath() { return this.savePath; }
  getReceivedBytes() { return this.received; }
  getTotalBytes() { return this.total; }
  isPaused() { return false; }

  cancel() {
    this.cancelled = true;
    this.engine.helper.send({ op: "download-cancel", dl: this.id });
  }
}

class WebKitEngine extends EventEmitter {
  constructor({ nativeImage, clipboard, debug = false, downloadsPath = () => null }) {
    super();
    this.setMaxListeners(0);
    this.nativeImage = nativeImage;
    this.clipboard = clipboard;
    this.debug = debug;
    this.downloadsPath = downloadsPath;
    this.helper = null;
    this.windows = new Set();
    this.byView = new Map();
    this.nextView = 1;
    this.ipcMain = new WebKitIpcMain();
    this.webRequestListeners = { beforeRequest: null, completed: null };
    this.downloadListeners = [];
    this.downloads = new Map();
    this.scaleFactor = 1;
  }

  async start({ scaleFactor = 0 } = {}) {
    this.scaleFactor = scaleFactor || 1;
    this.helper = WebKitHelper.spawn();
    const helper = this.helper;
    helper.on("created", (event) => this.contentsOf(event.view)?.onCreated());
    helper.on("nav", (event) => this.contentsOf(event.view)?.onNavigation(event));
    helper.on("state", (event) => this.contentsOf(event.view)?.onState(event));
    helper.on("msg", (event) => this.contentsOf(event.view)?.onMessage(event));
    helper.on("paint", (header, payload) => this.contentsOf(header.view)?.onPaint(header, payload));
    helper.on("closed", (event) => this.contentsOf(event.view)?.destroy());
    helper.on("page-close", (event) => this.byView.get(event.view)?.close());
    helper.on("crash", (event) => {
      this.contentsOf(event.view)?.emit("render-process-gone", {}, { reason: "crashed", exitCode: -1 });
    });
    helper.on("dialog", (event) => {
      if (this.debug) console.error(`tweb: dialog ${event.kind} "${event.message}" -> dismissed`);
    });
    helper.on("open", (event) => this.contentsOf(event.view)?.decideWindowOpen(event.url, event.disposition));
    helper.on("popup", (event) => this.onPopup(event));
    helper.on("chooser", (event) => {
      this.contentsOf(event.view)?.emit("tweb-file-chooser", {}, {
        mode: event.multiple ? "selectMultiple" : "selectSingle",
      });
    });
    helper.on("download-start", (event) => this.onDownloadStart(event));
    helper.on("download-progress", (event) => this.onDownloadProgress(event));
    helper.on("download-done", (event) => this.onDownloadDone(event));
    helper.on("exit", () => {
      for (const window of [...this.windows]) window.webContents?.destroy();
      this.emit("disconnected");
    });
    await helper.ready;
    helper.send({
      op: "init",
      tweb_scripts: [TWEB_BRIDGE, preloadScript(), CONTEXT_MENU_PROBE, TITLE_PROBE, NO_BOUNCE],
      page_scripts: [PAGE_BRIDGE, PRINT_SHIM, AUDIO_PROBE],
      application_name: safariApplicationName(),
    });
    if (this.debug) console.error(`tweb: webkit engine pid ${helper.child.pid}`);
    return this;
  }

  contentsOf(view) {
    return this.byView.get(view)?.webContents || null;
  }

  // The constructor contract: `webContents` exists synchronously, as with Electron. The host
  // creates the view from the commands queued behind this one, in order.
  createWindow(options) {
    const view = this.nextView++;
    const window = new WebKitBrowserWindow(this, options);
    this.adopt(window, view);
    this.helper.send({
      op: "create", view, width: window.contentSize.width, height: window.contentSize.height, scale: window.scaleFactor,
    });
    window.relayout();
    return window;
  }

  adopt(window, view) {
    const contents = new WebKitWebContents(this, view);
    window.attach(contents);
    this.windows.add(window);
    this.byView.set(view, window);
    return contents;
  }

  forget(window) {
    this.windows.delete(window);
    for (const [view, candidate] of this.byView) if (candidate === window) this.byView.delete(view);
  }

  // A popup WebKit made itself, offered for adoption — the order of events the Chrome engine has
  // too: the page exists first, then main.cjs's handler decides whether it stays.
  onPopup(event) {
    const opener = this.byView.get(event.opener)?.webContents;
    const decision = opener ? opener.decideWindowOpen(event.url, event.disposition) : { action: "deny" };
    if (decision.action !== "allow") {
      this.helper.send({ op: "close", view: event.view });
      return;
    }
    const window = new WebKitBrowserWindow(this, decision.overrideBrowserWindowOptions || {});
    const contents = this.adopt(window, event.view);
    contents.currentUrl = event.url || "about:blank";
    contents.onCreated();
    window.relayout();
    opener.emit("did-create-window", window, {
      url: event.url || "about:blank", frameName: "", disposition: event.disposition,
    });
  }

  windowFor(contents) {
    for (const window of this.windows) if (window.webContents === contents) return window;
    return null;
  }

  fromWebContents(contents) {
    return contents instanceof WebKitWebContents ? this.windowFor(contents) : null;
  }

  getAllWindows() {
    return [...this.windows];
  }

  // There is no DevTools page to serve; Safari's Web Inspector attaches to every pane instead.
  async devtoolsFor(contents) {
    if (contents instanceof WebKitWebContents) contents.openDevTools();
    return {
      ok: false,
      message: "WebKit pages are inspected with Safari's Web Inspector, which was opened for this page"
        + " (also reachable from Safari > Develop > this Mac > tweb-webkit)",
    };
  }

  // --- clipboard -------------------------------------------------------------------------

  async copyImageAt(contents, x, y) {
    try {
      const zoom = contents.getZoomFactor() || 1;
      const rect = await contents.executeJavaScript(`(() => {
        const el = document.elementFromPoint(${x / zoom}, ${y / zoom});
        const img = el && el.closest("img,canvas,video");
        if (!img) return null;
        const r = img.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`);
      if (!rect || rect.width < 1 || rect.height < 1) return;
      // CSS pixels to view points: the snapshot rect is in the view's space.
      const image = await contents.capturePage({
        x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom,
      });
      if (!image.isEmpty()) this.clipboard.writeImage(image);
    } catch (error) {
      if (this.debug) console.error(`tweb: webkit copy image failed ${error.message}`);
    }
  }

  // --- downloads (session.defaultSession "will-download") --------------------------------

  downloadDirectory() {
    const dir = this.downloadsPath() || path.join(require("node:os").homedir(), "Downloads");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  onDownloadStart(event) {
    const item = new WebKitDownloadItem(this, event);
    this.downloads.set(event.dl, item);
    for (const listener of this.downloadListeners) {
      try { listener({}, item, this.contentsOf(event.view)); } catch (error) { console.error(error); }
    }
    if (item.cancelled) return;
    const destination = item.savePath || path.join(this.downloadDirectory(), path.basename(item.filename));
    item.savePath = destination;
    this.helper.send({ op: "download-dest", dl: event.dl, path: destination });
  }

  onDownloadProgress(event) {
    const item = this.downloads.get(event.dl);
    if (!item) return;
    item.received = Math.max(0, Number(event.received) || 0);
    if (Number(event.total) > 0) item.total = Number(event.total);
    item.emit("updated", {}, "progressing");
  }

  onDownloadDone(event) {
    const item = this.downloads.get(event.dl);
    if (!item) return;
    this.downloads.delete(event.dl);
    if (event.state === "completed") {
      try { item.received = fs.statSync(item.savePath).size; } catch (_) { /* keep the last count */ }
      if (!item.total) item.total = item.received;
    }
    item.emit("done", {}, event.state);
  }

  session() {
    const engine = this;
    return {
      // WebKit gives an embedder no view of a page's requests: the network log stays empty.
      webRequest: {
        onBeforeRequest(listener) { engine.webRequestListeners.beforeRequest = listener; },
        onCompleted(listener) { engine.webRequestListeners.completed = listener; },
      },
      on(event, listener) {
        if (event === "will-download") engine.downloadListeners.push(listener);
        return this;
      },
      extensions: {
        loadExtension: async () => { throw new Error("the WebKit engine does not load Chrome extensions"); },
        getAllExtensions: () => [],
      },
      serviceWorkers: { on() {}, getAllRunning: () => ({}) },
    };
  }

  async stop() {
    if (!this.helper || this.helper.closed) return;
    const exited = new Promise((resolve) => this.helper.once("exit", resolve));
    this.helper.stop();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

module.exports = {
  WebKitBrowserWindow, WebKitEngine, WebKitIpcMain, PAGE_BRIDGE, TWEB_BRIDGE, safariApplicationName,
};
