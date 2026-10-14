"use strict";

// A WKWebView in the tweb-webkit host, presented to main.cjs as an Electron `webContents`.
//
// The contract is the one cdp/web-contents.cjs keeps for Chrome: `paint` events carrying a
// NativeImage, `sendInputEvent`, `frame.send` into the preload, `executeJavaScript`. So the pane
// logic — modes, hints, tabs, agent, float, frame pipeline — and the preload are the shared code,
// byte for byte, and nothing WebKit-specific can drift from them.
//
// Where WebKit differs in kind, the difference is resolved here:
//
//   paint     WebKit has no paint event. The host snapshots at the pane's frame rate and drops
//             unchanged pictures itself; a changed one arrives with its dirty box and only that
//             box's pixels, which are patched into the frame kept here.
//   input     Native NSEvents in the host, so WebKit routes them into frames itself — cross-origin
//             iframes included — and they arrive trusted. There is no CDP: `debugger.attach`
//             throws, and every main.cjs feature that would use it takes its fallback.
//   frames    A frame is known by WebKit's frame id from the messages its preload sends. There is
//             no frame tree, and none is needed: main.cjs addresses frames, it does not walk them
//             by parent. A frame that unloads says so (`pagehide`).

const { EventEmitter } = require("node:events");
const { KeySequencer, modifierMask } = require("../cdp/input.cjs");

let nativeImage = null;
function setNativeImage(impl) {
  nativeImage = impl;
}

let nextContentsId = 3000;

const BUTTONS = { left: 0, middle: 1, right: 2 };
const NSURL_ERROR_CANCELLED = -999;
// WebKitErrorFrameLoadInterruptedByPolicyChange: the navigation became a download (or was
// otherwise taken over by a policy decision). Not a failure of the page the user is on.
const WEBKIT_ERROR_POLICY_CHANGE = 102;

/// Whether a failed navigation is one Electron reports as -3 (ERR_ABORTED) — superseded or turned
/// into a download — which main.cjs leaves alone, rather than one to show an error page for.
function isAbortedNavigation(event) {
  if (event.code === NSURL_ERROR_CANCELLED) return true;
  return event.domain === "WebKitErrorDomain" && event.code === WEBKIT_ERROR_POLICY_CHANGE;
}

class WebKitFrame {
  constructor(contents, key, fid, isMain) {
    this.contents = contents;
    this.key = key;
    this.fid = fid;
    this.isMain = isMain;
    this.url = "";
    this.docId = null;
    this.detached = false;
  }

  // What `frameKey` reads: one engine, so the process half is constant and the frame's own id is
  // the identity. It is stable across the frame's documents, as an Electron frame's is.
  get processId() { return "webkit"; }
  get frameToken() { return this.key; }
  get parent() { return this.isMain ? null : this.contents.mainFrame; }
  get framesInSubtree() { return this.isMain ? this.contents.childFrames() : []; }

  isDestroyed() { return this.detached || this.contents.isDestroyed(); }

  send(channel, ...args) {
    if (this.isDestroyed()) return;
    const code = `globalThis.__twebReceive && globalThis.__twebReceive(${JSON.stringify(channel)}, ${JSON.stringify(args)})`;
    this.contents.evalIn(this, "tweb", code).catch(() => {
      /* the frame navigated away mid-send; its next preload-ready re-registers it */
    });
  }

  executeJavaScript(code) {
    return this.contents.evalIn(this, "page", code);
  }
}

// `webContents.debugger`. There is no CDP in WebKit, so it cannot attach; main.cjs's
// `ensureDebugger` then answers false and each feature that wanted it takes its fallback —
// `sendInputEvent` for pointer and edit keys, `executeJavaScript` for evaluation.
class WebKitDebugger extends EventEmitter {
  attach() { throw new Error("the WebKit engine has no DevTools protocol"); }
  isAttached() { return false; }
  detach() {}
  sendCommand(method) { return Promise.reject(new Error(`${method}: no DevTools protocol on the WebKit engine`)); }
}

class WebKitNavigationHistory {
  constructor(contents) {
    this.contents = contents;
    this.back = false;
    this.forward = false;
  }

  canGoBack() { return this.back; }
  canGoForward() { return this.forward; }
  goBack() { this.goToOffset(-1); }
  goForward() { this.goToOffset(1); }
  goToOffset(offset) { this.contents.command({ op: "go", offset }); }
}

class WebKitWebContents extends EventEmitter {
  constructor(engine, view, options = {}) {
    super();
    this.setMaxListeners(0);
    this.engine = engine;
    this.view = view;
    this.id = nextContentsId++;
    this.destroyed = false;
    this.mainFrame = new WebKitFrame(this, "main", null, true);
    this.frames = new Map();
    this.title = "";
    this.currentUrl = "about:blank";
    this.loading = false;
    this.navigating = false;
    this.zoomFactor = 1;
    this.frameRate = 30;
    this.painting = true;
    this.frameSize = null;
    this.frameBuffer = null;
    this.audioMuted = false;
    this.audibleFrames = new Set();
    this.playingFrames = new Set();
    this.playing = false;
    this.audible = false;
    this.userAgentOverride = null;
    this.defaultUserAgent = null;
    this.windowOpenHandler = null;
    this.pendingLoad = null;
    this.debugger = new WebKitDebugger();
    this.navigationHistory = new WebKitNavigationHistory(this);
    this.keys = new KeySequencer((params) => this.dispatchKey(params));
    this.keyFlushQueued = false;
    this.deviceEmulation = null;
    void options;
  }

  command(fields) {
    if (this.destroyed) return;
    this.engine.helper.send({ ...fields, view: this.view });
  }

  request(fields) {
    if (this.destroyed) return Promise.reject(new Error("the page is gone"));
    return this.engine.helper.request({ ...fields, view: this.view });
  }

  // --- lifecycle -------------------------------------------------------------------------

  onCreated() {
    void this.evalIn(this.mainFrame, "page", "navigator.userAgent").then((ua) => {
      this.defaultUserAgent = String(ua || "") || null;
    }).catch(() => {});
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pendingLoad) {
      this.pendingLoad.reject(Object.assign(new Error("ERR_ABORTED (-3)"), { code: "ERR_ABORTED" }));
      this.pendingLoad = null;
    }
    this.emit("destroyed");
  }

  isDestroyed() { return this.destroyed; }

  // --- frames ----------------------------------------------------------------------------

  childFrames() {
    return [...this.frames.values()].filter((frame) => !frame.detached);
  }

  get focusedFrame() { return this.mainFrame; }

  frameFor(event, doc) {
    if (event.main) return this.mainFrame;
    // Without the frame-id SPI a frame is known only by its document, which is new on every load.
    const key = event.fid != null ? String(event.fid) : `doc:${doc}`;
    let frame = this.frames.get(key);
    if (!frame) {
      frame = new WebKitFrame(this, key, event.fid, false);
      this.frames.set(key, frame);
      this.emit("frame-created", {}, { frame });
    }
    return frame;
  }

  dropChildFrames() {
    for (const frame of this.frames.values()) frame.detached = true;
    this.frames.clear();
  }

  evalIn(frame, world, code) {
    if (!frame || frame.isDestroyed()) return Promise.reject(new Error("frame gone"));
    const fields = { op: "eval", world, code: String(code) };
    if (!frame.isMain) fields.frame = frame.fid;
    return this.request(fields).catch((error) => {
      if (!frame.isMain && /frame gone/.test(error.message)) this.detachFrame(frame);
      throw error;
    });
  }

  detachFrame(frame) {
    frame.detached = true;
    if (this.frames.get(frame.key) === frame) this.frames.delete(frame.key);
  }

  // --- messages from the page ------------------------------------------------------------

  onMessage(event) {
    let body;
    try { body = JSON.parse(event.body); } catch (_) { return; }
    if (event.name === "twebPage") {
      this.onPageMessage(event, body);
      return;
    }
    const frame = this.frameFor(event, body.doc);
    if (body.name === "gone") {
      if (!frame.isMain && frame.docId === body.doc) this.detachFrame(frame);
      return;
    }
    if (frame.docId !== body.doc) {
      // A subframe on a new document. main.cjs prunes a frame's readiness when it navigates and
      // waits for its preload to say ready again; WebKit reports no subframe navigations, so the
      // first message of the new document stands for one.
      if (frame.docId !== null && !frame.isMain) {
        this.emit("did-start-navigation", {
          url: event.url, isSameDocument: false, isMainFrame: false, frame,
        });
      }
      frame.docId = body.doc;
      frame.detached = false;
      if (!frame.isMain) this.frames.set(frame.key, frame);
    }
    frame.url = event.url;
    if (body.name === "ipc") this.onIpc(frame, body.payload);
    else if (body.name === "contextmenu") this.onContextMenu(frame, body.payload);
    else if (body.name === "title") this.onTitle(frame, String(body.payload || ""));
  }

  onIpc(frame, payload) {
    let message;
    try { message = JSON.parse(payload); } catch (_) { return; }
    if (message.kind === "ipc") {
      // The fields of Electron's IpcMainEvent main.cjs reads; `reply` answers the sending frame.
      this.engine.ipcMain.deliver(message.channel, {
        sender: this,
        senderFrame: frame,
        frameId: frame.key,
        processId: frame.processId,
        reply: (channel, ...args) => frame.send(channel, ...args),
      }, message.args || []);
    } else if (message.kind === "main-eval") {
      frame.executeJavaScript(message.code)
        .then((value) => frame.send("\u0000eval", message.id, null, value))
        .catch((error) => frame.send("\u0000eval", message.id, String(error?.message || error)));
    }
  }

  onContextMenu(frame, payload) {
    let menu;
    try { menu = JSON.parse(payload); } catch (_) { return; }
    // CSS pixels of the reporting frame, to window points. A subframe's offset in the page is not
    // known here; its menu opens at its own coordinates, slightly off, rather than not at all.
    const zoom = this.zoomFactor || 1;
    this.emit("context-menu", {}, { ...menu, x: Math.round(menu.x * zoom), y: Math.round(menu.y * zoom) });
    void frame;
  }

  onTitle(frame, title) {
    if (!frame.isMain || !title || title === this.title) return;
    this.title = title;
    this.engine.windowFor(this)?.emit("page-title-updated", {}, title, true);
  }

  onPageMessage(event, body) {
    if (body.name === "audio") {
      let state;
      try { state = JSON.parse(body.payload); } catch (_) { return; }
      const key = event.main ? "main" : String(event.fid ?? event.url);
      if (state.audible) this.audibleFrames.add(key); else this.audibleFrames.delete(key);
      if (state.playing) this.playingFrames.add(key); else this.playingFrames.delete(key);
      const wasPlaying = this.playing;
      this.playing = this.playingFrames.size > 0;
      this.audible = this.audibleFrames.size > 0;
      if (this.playing && !wasPlaying) this.emit("media-started-playing", {});
      else if (!this.playing && wasPlaying) this.emit("media-paused", {});
    } else if (body.name === "console") {
      const levels = { debug: 0, log: 1, info: 1, warn: 2, error: 3 };
      const level = levels[body.level] ?? 1;
      const message = String(body.message || "");
      this.emit("console-message", {
        level: ["debug", "info", "warning", "error"][level], message,
        lineNumber: Number(body.line) || 0, sourceId: String(body.source || event.url || ""),
      }, level, message, Number(body.line) || 0, String(body.source || event.url || ""));
    }
  }

  // --- navigation ------------------------------------------------------------------------

  onNavigation(event) {
    switch (event.phase) {
      case "start":
        this.navigating = true;
        this.loading = true;
        this.emit("did-start-loading", {});
        this.emit("did-start-navigation", {
          url: event.url, isSameDocument: false, isMainFrame: true, frame: this.mainFrame,
        });
        break;
      case "commit":
        this.navigating = false;
        this.dropChildFrames();
        this.mainFrame.docId = null;
        this.mainFrame.url = event.url;
        this.currentUrl = event.url;
        this.title = "";
        if (this.pendingLoad) {
          this.pendingLoad.resolve();
          this.pendingLoad = null;
        }
        this.emit("did-navigate", {}, event.url, 200, "OK");
        break;
      case "finish":
        this.loading = false;
        this.emit("dom-ready", {});
        this.emit("did-finish-load", {});
        this.emit("did-stop-loading", {});
        break;
      case "fail": {
        this.navigating = false;
        this.loading = false;
        // Measured: a link to a file the page cannot show downloaded the file and then put an
        // error page in the tab, because the interrupted navigation was reported as a failure.
        const cancelled = isAbortedNavigation(event);
        const code = cancelled ? -3 : -2;
        const description = cancelled ? "ERR_ABORTED" : String(event.error || "ERR_FAILED");
        this.emit("did-fail-load", {}, code, description, event.url, true);
        this.emit("did-stop-loading", {});
        if (this.pendingLoad) {
          const error = new Error(`${description} (${code}) loading '${event.url}'`);
          error.code = cancelled ? "ERR_ABORTED" : "ERR_FAILED";
          this.pendingLoad.reject(error);
          this.pendingLoad = null;
        }
        break;
      }
      default:
        break;
    }
  }

  onState(event) {
    this.navigationHistory.back = Boolean(event.back);
    this.navigationHistory.forward = Boolean(event.forward);
    // A url that changes with no navigation in flight is a same-document one: pushState or a hash.
    // WebKit's navigation delegate does not report those.
    if (event.url && event.url !== this.currentUrl && !this.navigating && !this.loading) {
      this.currentUrl = event.url;
      this.mainFrame.url = event.url;
      this.emit("did-navigate-in-page", {}, event.url, true);
    }
    if (event.title && event.title !== this.title) {
      this.title = event.title;
      this.engine.windowFor(this)?.emit("page-title-updated", {}, event.title, true);
    }
  }

  getURL() { return this.currentUrl; }
  getTitle() { return this.title || ""; }
  isLoading() { return this.loading; }

  loadURL(url) {
    if (this.pendingLoad) {
      this.pendingLoad.reject(Object.assign(new Error("ERR_ABORTED (-3)"), { code: "ERR_ABORTED" }));
    }
    return new Promise((resolve, reject) => {
      this.pendingLoad = { resolve, reject };
      this.command({ op: "load", url: String(url) });
    });
  }

  reload() { this.command({ op: "reload" }); }
  reloadIgnoringCache() { this.command({ op: "reload", ignore_cache: true }); }
  stop() { this.command({ op: "stop" }); }

  // --- rendering -------------------------------------------------------------------------

  onPaint(header, payload) {
    if (this.destroyed || !nativeImage) return;
    const { width, height, rect } = header;
    const whole = rect.x === 0 && rect.y === 0 && rect.width === width && rect.height === height;
    if (whole && payload.length === width * height * 4) {
      // A whole frame is the frame: adopted as it arrived, not copied row by row into the old one
      // (an 18MB copy per scroll step on a Retina pane).
      this.frameBuffer = { width, height, pixels: payload };
    } else {
      if (!this.frameBuffer || this.frameBuffer.width !== width || this.frameBuffer.height !== height) {
        this.frameBuffer = { width, height, pixels: Buffer.alloc(width * height * 4) };
      }
      const stride = width * 4;
      const rowBytes = rect.width * 4;
      for (let row = 0; row < rect.height; row += 1) {
        payload.copy(this.frameBuffer.pixels, (rect.y + row) * stride + rect.x * 4, row * rowBytes, (row + 1) * rowBytes);
      }
    }
    if (!this.painting) return;
    let image = nativeImage.createFromBitmap(this.frameBuffer.pixels, { width, height });
    let dirty = rect.width && rect.height ? rect : { x: 0, y: 0, width, height };
    // A window on a screen of another scale renders at that scale; the pane's size is what counts.
    const want = this.frameSize;
    if (want && (want.width !== width || want.height !== height)) {
      image = image.resize({ width: want.width, height: want.height, quality: "good" });
      dirty = { x: 0, y: 0, width: want.width, height: want.height };
    }
    this.emit("paint", {}, dirty, image);
  }

  invalidate() {
    if (!this.painting) return;
    this.command({ op: "invalidate" });
  }

  setFrameRate(rate) {
    this.frameRate = Math.max(1, Number(rate) || 1);
    this.command({ op: "rate", fps: this.frameRate });
  }

  getFrameRate() { return this.frameRate; }

  startPainting() {
    if (this.painting) return;
    this.painting = true;
    this.command({ op: "paint", on: true });
  }

  stopPainting() {
    this.painting = false;
    this.command({ op: "paint", on: false });
  }

  isPainting() { return this.painting; }
  setBackgroundThrottling() {}

  async capturePage(rect) {
    const fields = { op: "capture" };
    if (rect) fields.rect = [rect.x, rect.y, rect.width, rect.height];
    const shot = await this.request(fields);
    if (!shot.width || !shot.height) return nativeImage.createEmpty();
    return nativeImage.createFromBitmap(shot.pixels, { width: shot.width, height: shot.height });
  }

  // --- zoom ------------------------------------------------------------------------------

  // WebKit's page zoom is Electron's: CSS pixels grow, the view stays the pane's size, and
  // WebKit maps view points to CSS pixels itself — so input needs no scaling for it.
  getZoomFactor() { return this.zoomFactor; }

  setZoomFactor(factor) {
    const value = Number(factor);
    if (!Number.isFinite(value) || value <= 0 || value === this.zoomFactor) return;
    this.zoomFactor = value;
    this.command({ op: "zoom", factor: value });
  }

  // --- input -----------------------------------------------------------------------------

  sendInputEvent(event) {
    if (this.destroyed || !event) return;
    const type = event.type;
    if (type === "keyDown" || type === "keyUp" || type === "char" || type === "rawKeyDown") {
      this.keys.push(event);
      if (!this.keyFlushQueued) {
        this.keyFlushQueued = true;
        queueMicrotask(() => {
          this.keyFlushQueued = false;
          this.keys.flush();
        });
      }
      return;
    }
    const kinds = {
      mouseDown: "down", mouseUp: "up", mouseMove: "move", mouseEnter: "move", mouseLeave: "move", mouseWheel: "wheel",
    };
    const kind = kinds[type];
    if (!kind) return;
    this.command({
      op: "mouse",
      kind,
      x: Number(event.x) || 0,
      y: Number(event.y) || 0,
      button: BUTTONS[event.button || "left"] ?? 0,
      clicks: Math.max(1, Number(event.clickCount) || 1),
      modifiers: modifierMask(event.modifiers),
      dx: Number(event.deltaX) || 0,
      dy: Number(event.deltaY) || 0,
    });
  }

  // From the key sequencer: CDP-shaped key events, which name the key, its code and its text.
  dispatchKey(params) {
    if (this.destroyed) return;
    if (params.type === "char") {
      this.command({ op: "text", text: String(params.text || "") });
      return;
    }
    this.command({
      op: "key",
      kind: params.type === "keyUp" ? "up" : "down",
      key: String(params.key || ""),
      code: String(params.code || ""),
      text: params.type === "keyDown" ? String(params.text || "") : "",
      modifiers: Number(params.modifiers) || 0,
    });
  }

  insertText(text) {
    this.command({ op: "text", text: String(text) });
    return Promise.resolve();
  }

  focus() { this.command({ op: "focus" }); }

  editCommand(name) { this.command({ op: "command", name }); }
  undo() { this.editCommand("undo"); }
  redo() { this.editCommand("redo"); }
  selectAll() { this.editCommand("selectAll"); }
  cut() { this.editCommand("cut"); }
  copy() { this.editCommand("copy"); }
  paste() { this.editCommand("paste"); }
  pasteAndMatchStyle() { this.editCommand("pasteAndMatchStyle"); }
  delete() { this.editCommand("delete"); }

  copyImageAt(x, y) { void this.engine.copyImageAt(this, x, y); }

  // --- find ------------------------------------------------------------------------------

  // `window.find` in the main world, with the match count computed over the document text — the
  // approach the Chrome engine takes, and for the same reason: the native find reports no count.
  findInPage(text, options = {}) {
    const requestId = (this.findRequestId = (this.findRequestId || 0) + 1);
    const script = `(() => {
      const query = ${JSON.stringify(String(text))};
      const matchCase = ${Boolean(options.matchCase)};
      const forward = ${options.forward !== false};
      const findNext = ${Boolean(options.findNext)};
      const body = document.body ? document.body.innerText : "";
      const haystack = matchCase ? body : body.toLowerCase();
      const needle = matchCase ? query : query.toLowerCase();
      let matches = 0;
      if (needle) for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) matches += 1;
      if (!findNext) { const s = getSelection(); s && s.removeAllRanges(); }
      const found = matches > 0 && window.find(query, matchCase, !forward, true, false, false, false);
      const state = window.__twebFind || (window.__twebFind = { ordinal: 0 });
      if (!findNext) state.ordinal = 0;
      state.ordinal = matches ? ((state.ordinal + (forward ? 1 : -1) - 1 + matches) % matches) + 1 : 0;
      let rect = { x: 0, y: 0, width: 0, height: 0 };
      const sel = getSelection();
      if (found && sel && sel.rangeCount) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        rect = { x: r.x, y: r.y, width: r.width, height: r.height };
        const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
        node && node.scrollIntoView && node.scrollIntoView({ block: "center", inline: "nearest" });
      }
      return { matches, activeMatchOrdinal: found ? state.ordinal : 0, selectionArea: rect };
    })()`;
    void this.executeJavaScript(script).then((result) => {
      this.emit("found-in-page", {}, { requestId, finalUpdate: true, ...result });
    }).catch(() => {
      this.emit("found-in-page", {}, { requestId, finalUpdate: true, matches: 0, activeMatchOrdinal: 0 });
    });
    return requestId;
  }

  stopFindInPage(action = "clearSelection") {
    if (action === "keepSelection") return;
    void this.executeJavaScript("getSelection().removeAllRanges()").catch(() => {});
  }

  // --- audio -----------------------------------------------------------------------------

  isCurrentlyAudible() { return this.audible; }

  setAudioMuted(muted) {
    this.audioMuted = Boolean(muted);
    const script = `dispatchEvent(new CustomEvent("tweb-mute", { detail: ${this.audioMuted} }))`;
    for (const frame of [this.mainFrame, ...this.childFrames()]) {
      void this.evalIn(frame, "page", script).catch(() => {});
    }
  }

  isAudioMuted() { return this.audioMuted; }

  // --- emulation, UA, PDF, downloads -----------------------------------------------------

  getUserAgent() { return this.userAgentOverride || this.defaultUserAgent || ""; }

  setUserAgent(userAgent) {
    this.userAgentOverride = userAgent && userAgent !== this.defaultUserAgent ? userAgent : null;
    this.command({ op: "user-agent", ua: this.userAgentOverride });
  }

  // The view is resized to the device's viewport; the pane shows it scaled to fit. There is no
  // touch or mobile-viewport emulation in WebKit's public API.
  enableDeviceEmulation(parameters) {
    this.deviceEmulation = parameters;
    const view = parameters.viewSize;
    if (view?.width && view?.height) {
      this.command({ op: "resize", width: view.width, height: view.height, scale: this.engine.windowFor(this)?.scaleFactor || 1 });
    }
    this.invalidate();
  }

  disableDeviceEmulation() {
    this.deviceEmulation = null;
    this.engine.windowFor(this)?.relayout(true);
  }

  async printToPDF() {
    const bytes = await this.request({ op: "pdf" });
    if (!bytes || bytes.length === 0) throw new Error("WebKit could not make a PDF of this page");
    return Buffer.from(bytes);
  }

  downloadURL(url) { this.command({ op: "download", url: String(url) }); }

  executeJavaScript(code) {
    return this.evalIn(this.mainFrame, "page", code);
  }

  send(channel, ...args) {
    this.mainFrame.send(channel, ...args);
  }

  print() {
    // Same as a page's own window.print(): the preload's handler owns what a print means here.
    void this.executeJavaScript("window.dispatchEvent(new CustomEvent('tweb-print-request'))").catch(() => {});
  }

  // The Web Inspector, in a window of its own. There is no element-picking entry point in public
  // WebKit API, so inspecting an element opens the inspector on the page.
  openDevTools() { this.command({ op: "devtools" }); }
  inspectElement() { this.openDevTools(); }
  isDevToolsOpened() { return false; }
  closeDevTools() {}

  // --- window.open -----------------------------------------------------------------------

  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }

  decideWindowOpen(url, disposition) {
    if (!this.windowOpenHandler) return { action: "allow" };
    return this.windowOpenHandler({
      url, frameName: "", features: disposition === "new-window" ? "popup" : "", disposition,
    }) || { action: "deny" };
  }

  // --- the file chooser ------------------------------------------------------------------

  // main.cjs answers a chooser through CDP's `DOM.setFileInputFiles` on the other engines; here
  // the host holds WebKit's open-panel callback and is answered directly.
  setFileChooserFiles(paths) {
    this.command({ op: "chooser", paths: Array.isArray(paths) && paths.length ? paths.map(String) : null });
  }
}

module.exports = { WebKitWebContents, WebKitFrame, WebKitDebugger, isAbortedNavigation, setNativeImage };
