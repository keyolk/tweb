"use strict";

// A Chrome tab presented as the offscreen `BrowserWindow` main.cjs makes for every tab, plus the
// process-wide pieces Electron hangs off its modules (`BrowserWindow.getAllWindows`,
// `ipcMain`, `session.defaultSession`) restated over one CDP connection.
//
// A tab here has no OS window at all. Everything main.cjs does to keep its offscreen window
// hidden — bounds at -10000, opacity 0, unfocusable — is therefore answered with the state it
// is trying to reach, so the watchdog sees a window that is already hidden and does nothing.

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { CdpConnection, ensureChrome } = require("./connection.cjs");
const { CdpWebContents } = require("./web-contents.cjs");

const HIDDEN_BOUNDS = { x: -10_000, y: -10_000 };

class CdpBrowserWindow extends EventEmitter {
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
    this.scaleFactor = options.webPreferences?.offscreen?.deviceScaleFactor || 1;
    this.webContents = null;
    this.ready = null;
  }

  // Creating a target is asynchronous and the BrowserWindow constructor is not, so the window
  // exists before its page does. Everything main.cjs calls in the meantime is queued on `ready`.
  attach(contents) {
    this.webContents = contents;
    contents.on("destroyed", () => this.onContentsDestroyed());
  }

  onContentsDestroyed() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.engine.windows.delete(this);
    this.emit("closed");
  }

  // The CSS viewport is the content size divided by the zoom; the device scale is the render
  // scale multiplied by it. The product — the screenshot size — never moves, which is what
  // Electron's page zoom does to an offscreen window's paint.
  relayout() {
    const contents = this.webContents;
    if (!contents || contents.isDestroyed() || contents.deviceEmulation) return;
    const zoom = contents.getZoomFactor() || 1;
    // The frame Electron would paint is the content size at the render scale, whatever the zoom.
    // The CSS viewport is rounded UP, so the screenshot is never smaller than that frame, and the
    // capture is cropped back to it: at zoom 0.8 a 450-DIP pane is 562.5 CSS px, which rounds to a
    // 901px frame against the 900 the pane expects — measured, and dropped as the wrong size.
    contents.frameSize = {
      width: Math.max(1, Math.round(this.contentSize.width * this.scaleFactor)),
      height: Math.max(1, Math.round(this.contentSize.height * this.scaleFactor)),
    };
    contents.setViewport(
      Math.max(1, Math.ceil(this.contentSize.width / zoom)),
      Math.max(1, Math.ceil(this.contentSize.height / zoom)),
      this.scaleFactor * zoom,
    );
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

  loadURL(url) { return this.engine.whenReady(this).then(() => this.webContents.loadURL(url)); }
  loadFile(file) { return this.loadURL(`file://${path.resolve(file)}`); }
  reload() { this.webContents?.reload(); }

  setTitle(title) { this.title = String(title); }
  getTitle() { return this.title; }

  // An OS window's visibility and focus have no meaning for a CDP target. Answering with the
  // hidden, unfocused state is what makes `keepWindowHidden` a no-op rather than a loop.
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
    void this.engine.closeTarget(this);
  }

  destroy() { this.close(); }
}

// `ipcMain`, fed by the preload bridge instead of Electron's renderer IPC. The event carries
// `sender` (the contents) and `senderFrame`, the two fields main.cjs reads.
class CdpIpcMain extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  deliver(channel, event, args) {
    this.emit(channel, event, ...args);
  }
}

class CdpEngine extends EventEmitter {
  constructor({ userDataDir, nativeImage, clipboard, debug = false, downloadsPath = () => null }) {
    super();
    this.setMaxListeners(0);
    this.userDataDir = userDataDir;
    this.nativeImage = nativeImage;
    this.clipboard = clipboard;
    this.debug = debug;
    this.downloadsPath = downloadsPath;
    this.connection = null;
    this.windows = new Set();
    this.byTarget = new Map();
    this.readyByWindow = new WeakMap();
    this.ipcMain = new CdpIpcMain();
    this.pendingOpens = [];
    this.webRequestListeners = { beforeRequest: null, completed: null };
    this.downloadListeners = [];
    this.downloads = new Map();
    this.browserContextId = undefined;
  }

  async start() {
    if (typeof this.userDataDir === "function") this.userDataDir = this.userDataDir();
    const { version } = await ensureChrome(this.userDataDir, {
      log: (message) => this.debug && console.error(`tweb: ${message}`),
    });
    this.version = version;
    this.connection = await CdpConnection.connect(version.webSocketDebuggerUrl);
    this.connection.on("Target.targetCreated", (params) => this.onTargetCreated(params.targetInfo));
    this.connection.on("Target.targetInfoChanged", (params) => this.onTargetInfoChanged(params.targetInfo));
    this.connection.on("Target.targetDestroyed", (params) => this.onTargetDestroyed(params.targetId));
    this.connection.on("Target.detachedFromTarget", (params) => this.connection.dropSession(params.sessionId));
    this.connection.on("Browser.downloadWillBegin", (params) => this.onBrowserDownloadWillBegin(params));
    this.connection.on("Browser.downloadProgress", (params) => this.onDownloadProgress(params));
    this.connection.on("close", () => this.emit("disconnected"));
    await this.connection.send("Target.setDiscoverTargets", { discover: true });
    await this.closeOrphanTabs();
    await this.connection.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName", downloadPath: this.downloadDirectory(), eventsEnabled: true,
    }).catch(() => {});
    if (this.debug) console.error(`tweb: chrome engine ${version.Browser} at ${this.userDataDir}`);
    return this;
  }

  downloadDirectory() {
    const dir = path.join(this.userDataDir, "tweb-downloads");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // --- tabs ------------------------------------------------------------------------------

  // The constructor contract: `webContents` is there synchronously. The object is real from
  // the first line; only its session arrives a round trip later (see PendingSession).
  createWindow(options) {
    const window = new CdpBrowserWindow(this, options);
    this.windows.add(window);
    const contents = this.contentsFor(window, null);
    const ready = this.openTarget(window, contents).catch((error) => {
      console.error(`tweb: chrome tab failed: ${error.message}`);
      contents.session.fail(error);
      contents.destroy();
      throw error;
    });
    ready.catch(() => {});
    this.readyByWindow.set(window, ready);
    return window;
  }

  contentsFor(window, targetId) {
    const contents = new CdpWebContents(this, targetId, null, {
      width: window.contentSize.width,
      height: window.contentSize.height,
      deviceScaleFactor: window.scaleFactor,
    });
    window.attach(contents);
    return contents;
  }

  whenReady(window) {
    return this.readyByWindow.get(window) || Promise.resolve();
  }

  async openTarget(window, contents) {
    // A window of its own per tab, as Electron gives every tab its own BrowserWindow. Sharing
    // Chrome's one headless window is NOT equivalent: with a second tab in it, mouse input to an
    // emulated tab is scaled by the window's idea of the device scale, not the override's — measured,
    // a click sent at y=160 on a dsf-2 tab arrived at y=80, one at y=500 did not arrive at all, and
    // which runs showed it depended on timing. With `newWindow` the same override routed every
    // click exactly, across every window size tried.
    const { targetId } = await this.connection.send("Target.createTarget", {
      url: "about:blank", newWindow: true, background: true,
    });
    await this.adoptTarget(window, contents, targetId);
  }

  async adoptTarget(window, contents, targetId) {
    this.byTarget.set(targetId, window);
    const { sessionId } = await this.connection.send("Target.attachToTarget", { targetId, flatten: true });
    await contents.initialize(targetId, this.connection.session(sessionId));
    window.relayout();
    return contents;
  }

  windowFor(contents) {
    for (const window of this.windows) if (window.webContents === contents) return window;
    return null;
  }

  fromWebContents(contents) {
    if (!contents) return null;
    if (contents instanceof CdpWebContents) return this.windowFor(contents);
    return null;
  }

  getAllWindows() {
    return [...this.windows];
  }

  async closeTarget(window) {
    const contents = window.webContents;
    if (contents && !contents.isDestroyed()) {
      await this.connection.send("Target.closeTarget", { targetId: contents.targetId }).catch(() => {});
      contents.destroy();
    } else {
      window.onContentsDestroyed();
    }
  }

  // A popup Chrome opened on its own: `window.open`, `target=_blank`. Matched to the opener's
  // `Page.windowOpen` report, which carries the handler's decision.
  onTargetCreated(info) {
    if (info.type !== "page" || !info.openerId || this.byTarget.has(info.targetId)) return;
    const openerWindow = this.byTarget.get(info.openerId);
    if (!openerWindow) return;
    const index = this.pendingOpens.findIndex((open) => open.opener === openerWindow.webContents);
    const open = index >= 0 ? this.pendingOpens.splice(index, 1)[0] : null;
    const decision = open?.decision || { action: "deny" };
    if (decision.action !== "allow") {
      // main.cjs already opened its own tab for this url (or decided not to); Chrome's copy goes.
      void this.connection.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
      return;
    }
    const options = decision.overrideBrowserWindowOptions || {};
    const window = new CdpBrowserWindow(this, options);
    this.windows.add(window);
    const contents = this.contentsFor(window, info.targetId);
    const ready = this.adoptTarget(window, contents, info.targetId).then(() => {
      openerWindow.webContents.emit("did-create-window", window, {
        url: info.url || open?.url || "about:blank",
        frameName: "",
        disposition: open?.disposition || "new-window",
      });
      return contents;
    }).catch((error) => {
      console.error(`tweb: chrome popup failed: ${error.message}`);
      window.onContentsDestroyed();
    });
    this.readyByWindow.set(window, ready);
  }

  // Titles come from the page itself (TITLE_PROBE in web-contents.cjs). Chrome's target title
  // is NOT the same thing: before a document sets one it reports the url or the file name — measured
  // as "page.html" and the full file:// url — and those landed in the history as if they were titles.
  onTargetInfoChanged() {}

  onTargetDestroyed(targetId) {
    const window = this.byTarget.get(targetId);
    if (!window) return;
    this.byTarget.delete(targetId);
    window.webContents?.destroy();
  }

  // --- clipboard -------------------------------------------------------------------------

  // Electron's copy/cut talk to the system pasteboard from the browser process. CDP has no
  // such call, and a synthetic Cmd-C does not reach Chrome's accelerator table. So the
  // selection is read out of the focused frame and written with Electron's clipboard, then
  // removed for a cut — the same effect, through the host that owns the pasteboard here.
  async copySelection(contents, cut) {
    const frame = contents.focusedFrame;
    try {
      const text = await contents.evaluateIn(frame?.sessionId, frame?.mainContextId, `(() => {
        const active = document.activeElement;
        if (active && typeof active.selectionStart === "number" && active.value !== undefined) {
          const value = active.value.slice(active.selectionStart, active.selectionEnd);
          if (${cut}) active.setRangeText("", active.selectionStart, active.selectionEnd, "end"),
            active.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteByCut" }));
          return value;
        }
        const value = String(getSelection() || "");
        if (${cut} && value) document.execCommand("delete");
        return value;
      })()`, true);
      if (text) this.clipboard.writeText(String(text));
    } catch (error) {
      if (this.debug) console.error(`tweb: chrome copy failed ${error.message}`);
    }
  }

  async pasteClipboard(contents) {
    const text = this.clipboard.readText();
    if (text) await contents.insertText(text);
  }

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
      const image = await contents.capturePage(rect);
      if (!image.isEmpty()) this.clipboard.writeImage(image);
    } catch (error) {
      if (this.debug) console.error(`tweb: chrome copy image failed ${error.message}`);
    }
  }

  // --- network log (session.defaultSession.webRequest) -----------------------------------

  onRequest(_contents, params) {
    const listener = this.webRequestListeners.beforeRequest;
    if (!listener) return;
    listener({
      id: params.requestId,
      url: params.request?.url || "",
      method: params.request?.method || "GET",
      resourceType: String(params.type || "other").toLowerCase(),
    }, () => {});
  }

  onResponse(_contents, params) {
    const listener = this.webRequestListeners.completed;
    if (!listener) return;
    listener({
      id: params.requestId,
      statusCode: params.response?.status ?? 0,
      fromCache: Boolean(params.response?.fromDiskCache || params.response?.fromServiceWorker),
    });
  }

  onRequestFailed(_contents, params) {
    const listener = this.webRequestListeners.completed;
    if (!listener) return;
    listener({ id: params.requestId, statusCode: 0, fromCache: false, error: params.errorText });
  }

  // --- downloads (session.defaultSession "will-download") --------------------------------

  onDownloadWillBegin(contents, params) {
    this.onBrowserDownloadWillBegin(params, contents);
  }

  onBrowserDownloadWillBegin(params) {
    if (this.downloads.has(params.guid)) return;
    const item = new CdpDownloadItem(this, params);
    this.downloads.set(params.guid, item);
    for (const listener of this.downloadListeners) listener({}, item);
  }

  onDownloadProgress(params) {
    const item = this.downloads.get(params.guid);
    if (!item) return;
    item.progress(params);
    if (params.state !== "inProgress") this.downloads.delete(params.guid);
  }

  session() {
    const engine = this;
    return {
      webRequest: {
        onBeforeRequest(listener) { engine.webRequestListeners.beforeRequest = listener; },
        onCompleted(listener) { engine.webRequestListeners.completed = listener; },
      },
      on(event, listener) {
        if (event === "will-download") engine.downloadListeners.push(listener);
        return this;
      },
      extensions: {
        // The managed Chrome has its own extensions — the policy ones this engine exists for.
        // TWeb's unpacked-extension directory is an Electron feature and is not loaded here.
        loadExtension: async () => { throw new Error("extensions are managed by Chrome itself"); },
        getAllExtensions: () => [],
      },
      serviceWorkers: { on() {}, getAllRunning: () => ({}) },
    };
  }

  // Pages no engine is attached to: tabs of an engine that was killed before it could close them.
  // Every live pane holds a session on each of its tabs, so `attached` is exactly "someone's".
  // Chrome's own startup tab is one of these too, and goes with them.
  async closeOrphanTabs() {
    try {
      const { targetInfos } = await this.connection.send("Target.getTargets");
      const orphans = targetInfos.filter((info) => info.type === "page" && !info.attached
        && !String(info.url).startsWith("chrome-extension://"));
      await Promise.all(orphans.map((info) =>
        this.connection.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {})));
      if (orphans.length && this.debug) console.error(`tweb: closed ${orphans.length} orphaned chrome tabs`);
    } catch (error) {
      if (this.debug) console.error(`tweb: orphan sweep failed: ${error.message}`);
    }
  }

  // This engine's tabs, then Chrome itself if no other pane is using it. Chrome is shared, so it is
  // only closed when the last page left is nobody's — a pane in another tmux window keeps it alive.
  async stop() {
    if (!this.connection || this.connection.closed) return;
    await Promise.all([...this.windows].map((window) => this.closeTarget(window)));
    try {
      const { targetInfos } = await this.connection.send("Target.getTargets");
      const inUse = targetInfos.some((info) => info.type === "page" && info.attached);
      if (!inUse) {
        if (this.debug) console.error("tweb: last chrome pane closed, closing chrome");
        await this.connection.send("Browser.close").catch(() => {});
      }
    } catch (_) { /* Chrome already gone */ }
    this.connection.close();
  }
}

// Chrome names the file itself (`allowAndName` saves it under the guid), so the item is moved to
// the path main.cjs chose once it completes.
class CdpDownloadItem extends EventEmitter {
  constructor(engine, params) {
    super();
    this.engine = engine;
    this.guid = params.guid;
    this.url = params.url;
    this.filename = params.suggestedFilename || "download";
    this.savePath = null;
    this.received = 0;
    this.total = 0;
    this.paused = false;
    this.state = "progressing";
  }

  getFilename() { return this.filename; }
  getURL() { return this.url; }
  setSavePath(destination) { this.savePath = destination; }
  getSavePath() { return this.savePath; }
  getReceivedBytes() { return this.received; }
  getTotalBytes() { return this.total; }
  isPaused() { return this.paused; }

  cancel() {
    void this.engine.connection.send("Browser.cancelDownload", { guid: this.guid }).catch(() => {});
  }

  progress(params) {
    this.received = params.receivedBytes || 0;
    this.total = params.totalBytes || 0;
    if (params.state === "inProgress") {
      this.emit("updated", {}, "progressing");
      return;
    }
    let state = params.state === "completed" ? "completed" : "cancelled";
    if (state === "completed" && this.savePath) {
      const source = path.join(this.engine.downloadDirectory(), this.guid);
      try {
        fs.mkdirSync(path.dirname(this.savePath), { recursive: true });
        fs.renameSync(source, this.savePath);
      } catch (error) {
        try {
          fs.copyFileSync(source, this.savePath);
          fs.rmSync(source, { force: true });
        } catch (_) {
          console.error(`tweb: download move failed ${error.message}`);
          state = "interrupted";
        }
      }
    }
    this.emit("done", {}, state);
  }
}

module.exports = { CdpBrowserWindow, CdpEngine, CdpIpcMain };
