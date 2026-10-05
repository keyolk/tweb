"use strict";

// A page in Chrome, presented to main.cjs as an Electron `webContents`.
//
// main.cjs was written against Electron's offscreen webContents: `paint` events carrying a
// NativeImage, `sendInputEvent`, `frame.send` into the preload, `debugger.sendCommand`. This
// class keeps that contract and implements it over one CDP page target, so the 8000 lines of
// pane logic — modes, hints, tabs, agent, float, frame pipeline — run unchanged on Chrome.
//
// Where the two engines differ in kind, not just in API, the difference is resolved here and
// written down here:
//
//   paint      Electron pushes a bitmap per compositor frame. Chrome's screencast does too but
//              only at CSS-pixel size (measured: 720x450 for a 720x450 dpr-2 viewport, with or
//              without maxWidth), which halves the resolution of every frame on a Retina pane.
//              `captureScreenshot` returns device pixels (2880x1800 measured) at 15fps serial,
//              30fps with two in flight. So the screencast is the CHANGE SIGNAL — it is silent on
//              a static page (1 frame in 3s measured) — and each signal is answered with a
//              device-pixel screenshot, two in flight, capped at the pane's frame rate.
//   dirty rect Chrome reports none. Every paint is whole-frame; main.cjs already handles a
//              dirty rect equal to the frame as "send the whole thing".
//   preload    see preload-bridge.cjs.
//   frames     CDP frameId + the session that owns it stand in for Electron's
//              processId + frameToken, which is all `frameKey` reads.

const { EventEmitter } = require("node:events");
const { dirtyRect } = require("./damage.cjs");
const { KeySequencer, toCdpMouse } = require("./input.cjs");
const { BINDING_NAME, WORLD_NAME, preloadScript } = require("./preload-bridge.cjs");

let nextContentsId = 1000;

const CAPTURE_TIMEOUT_MS = 1000;
const INPUT_SCALE_RECHECK_MS = 3000;
// Quiet time after the last screencast frame before a device-pixel capture sharpens the picture.
const SETTLE_MS = 150;
// The screencast is now what motion is drawn from, so its quality is visible; 90 keeps text legible
// mid-scroll at a fraction of the bytes of 100.
const SCREENCAST_QUALITY = 90;

// `TWEB_CDP_PROFILE=1`: every 5s, where a frame's time went — the screenshot round trip, the PNG
// decode, the bitmap copy, the damage diff — and how many screencast signals arrived per capture.
const PROFILE = process.env.TWEB_CDP_PROFILE === "1";
function profileCapture(contents, sample) {
  const p = contents.profile || (contents.profile = { n: 0, at: Date.now(), sum: {} });
  p.n += 1;
  for (const [key, value] of Object.entries(sample)) p.sum[key] = (p.sum[key] || 0) + Number(value);
  if (Date.now() - p.at < 5000) return;
  const avg = (key) => (p.sum[key] / p.n).toFixed(key === "bytes" ? 0 : 1);
  console.error(`tweb: cdp profile ${p.n} captures/${((Date.now() - p.at) / 1000).toFixed(1)}s`
    + ` capture=${avg("capture")}ms decode=${avg("decode")}ms bitmap=${avg("bitmap")}ms diff=${avg("diff")}ms`
    + ` png=${Math.round(avg("bytes") / 1024)}KiB changed=${p.sum.changed}/${p.n} signals=${contents.signals || 0}`);
  contents.profile = null;
  contents.signals = 0;
}

// main.cjs never sees a NativeImage constructor of its own here; it is injected so this file has
// no hard dependency on Electron and the pure parts stay testable under plain node.
let nativeImage = null;
function setNativeImage(impl) {
  nativeImage = impl;
}

// Synchronous in main.cjs's world, so the shortcut a page installs for `window.print()` lands
// before the page's first script — the same timing the preload's accessor patch buys under
// Electron. See preload.cjs `installPrintShim`.
const PRINT_SHIM = `(() => {
  if (window.__twebPrintShim) return;
  window.__twebPrintShim = true;
  Object.defineProperty(window, "print", {
    configurable: true, writable: true,
    value: function print() { window.dispatchEvent(new CustomEvent("tweb-print-request")); },
  });
})();`;

// What Electron's `context-menu` event would have said, read in the isolated world at the
// moment the page's own `contextmenu` fires — after the page had its chance to cancel it.
const CONTEXT_MENU_PROBE = `(() => {
  addEventListener("contextmenu", (event) => {
    // Decided after the page has had the event, in every phase: a page with its own menu cancels
    // it, and then TWeb shows nothing — the rule Chrome follows. Cancelling it here instead (this
    // listener runs first) made every page's own handler see an already-cancelled event.
    setTimeout(() => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      const link = target && target.closest("a[href]");
      const media = target && target.closest("img,video,audio");
      const editable = target && (target.isContentEditable
        || (target.matches && target.matches("input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea")));
      const selection = String(getSelection() || "");
      const hasSelection = selection.length > 0;
      globalThis.__twebContextMenu && globalThis.__twebContextMenu(JSON.stringify({
        x: event.clientX, y: event.clientY,
        isEditable: Boolean(editable),
        selectionText: selection,
        linkURL: link ? link.href : "",
        linkText: link ? link.textContent.trim() : "",
        srcURL: media ? (media.currentSrc || media.src || "") : "",
        mediaType: media ? (media.tagName.toLowerCase() === "img" ? "image" : media.tagName.toLowerCase()) : "none",
        editFlags: {
          canUndo: Boolean(editable), canRedo: Boolean(editable),
          canCut: Boolean(editable) && hasSelection, canCopy: hasSelection,
          canPaste: Boolean(editable), canSelectAll: true,
        },
        frameURL: location.href,
      }));
    }, 0);
  }, true);
})();`;

// `document.title` as it changes. Chrome sends `Target.targetInfoChanged` per navigation, not per
// title change, so a page that retitles itself — an unread count, a scroll position, a chat's
// "(3) New messages" — kept its first title in the tab list. Electron's `page-title-updated` fires
// on every change; this is that, observed where the title lives. Top frame only: a subframe's
// title is never the tab's.
const TITLE_PROBE = `(() => {
  if (window !== top) return;
  let last = null;
  const report = () => {
    const title = document.title;
    if (title === last) return;
    last = title;
    globalThis.__twebTitle && globalThis.__twebTitle(title);
  };
  const watch = () => {
    report();
    new MutationObserver(report).observe(document.head || document.documentElement,
      { subtree: true, childList: true, characterData: true });
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", watch, { once: true });
  else watch();
})();`;

// Whether this frame is making sound, as Electron's `isCurrentlyAudible` / `media-started-playing`
// / `media-paused` would report it. CDP has no audio state, so the page reports it: a media
// element playing unmuted with volume, or an AudioContext running. Web Audio is caught by wrapping
// the constructor, since a running context is otherwise invisible from outside. The mute TWeb
// applies (`setAudioMuted`) follows the same elements, including ones created after it was set.
const AUDIO_PROBE = `(() => {
  const media = () => [...document.querySelectorAll("video,audio")];
  const contexts = new Set();
  const Native = window.AudioContext || window.webkitAudioContext;
  if (Native && !Native.__twebWrapped) {
    const Wrapped = function (...args) {
      const context = new Native(...args);
      contexts.add(context);
      context.addEventListener("statechange", report);
      return context;
    };
    Wrapped.prototype = Native.prototype;
    Wrapped.__twebWrapped = true;
    try { window.AudioContext = Wrapped; } catch (error) { void error; }
  }
  let last = null;
  function report() {
    const playing = media().some((m) => !m.paused && !m.ended && m.readyState > 2);
    const audible = media().some((m) => !m.paused && !m.ended && !m.muted && m.volume > 0 && m.readyState > 2)
      || [...contexts].some((c) => c.state === "running");
    const state = (playing ? 1 : 0) | (audible ? 2 : 0);
    if (state === last) return;
    last = state;
    globalThis.__twebAudio && globalThis.__twebAudio(JSON.stringify({ playing, audible }));
  }
  for (const type of ["play", "playing", "pause", "ended", "volumechange", "emptied"]) {
    addEventListener(type, report, true);
  }
  addEventListener("tweb-mute", (event) => {
    window.__twebMuted = Boolean(event.detail);
    for (const m of media()) {
      if (window.__twebMuted) { if (!m.muted) { m.dataset.twebMuted = "1"; m.muted = true; } }
      else if (m.dataset.twebMuted) { delete m.dataset.twebMuted; m.muted = false; }
    }
  });
  addEventListener("play", (event) => {
    const m = event.target;
    if (window.__twebMuted && m && !m.muted) { m.dataset.twebMuted = "1"; m.muted = true; }
  }, true);
})();`;

class CdpFrame {
  constructor(contents, frameId, sessionId) {
    this.contents = contents;
    this.frameId = frameId;
    this.sessionId = sessionId;
    this.url = "";
    this.parentId = null;
    this.detached = false;
    // Execution contexts in this frame: the isolated world the preload lives in, and the page's.
    this.isolatedContextId = null;
    this.mainContextId = null;
  }

  // What `frameKey` reads. A session id plus a frame id is unique across the whole browser, which
  // is what processId + frameToken are under Electron.
  get processId() { return this.sessionId || "root"; }
  get frameToken() { return this.frameId; }
  get parent() { return this.parentId ? this.contents.frames.get(this.parentId) || null : null; }
  get framesInSubtree() {
    const out = [];
    const walk = (id) => {
      for (const frame of this.contents.frames.values()) {
        if (frame.parentId === id && !frame.detached) {
          out.push(frame);
          walk(frame.frameId);
        }
      }
    };
    walk(this.frameId);
    return out;
  }

  isDestroyed() { return this.detached || this.contents.isDestroyed(); }

  session() { return this.contents.sessionFor(this.sessionId); }

  send(channel, ...args) {
    if (this.isDestroyed() || this.isolatedContextId === null) return;
    const expression = `globalThis.__twebReceive && globalThis.__twebReceive(${JSON.stringify(channel)}, ${JSON.stringify(args)})`;
    this.session().send("Runtime.evaluate", { expression, contextId: this.isolatedContextId })
      .catch(() => { /* frame navigated away mid-send; the next preload-ready re-registers it */ });
  }

  executeJavaScript(code, userGesture = false) {
    return this.contents.evaluateIn(this.sessionId, this.mainContextId, code, userGesture);
  }
}

// `webContents.debugger`, over the same connection the engine already holds. main.cjs uses it
// for OOPIF input routing, the file chooser, and DOM queries; all of those are plain CDP, so
// they pass straight through. The child sessions it creates with `Target.setAutoAttach` are the
// ones this engine already auto-attaches, so the announcement is replayed rather than raced.
class CdpDebugger extends EventEmitter {
  constructor(contents) {
    super();
    this.setMaxListeners(0);
    this.contents = contents;
    this.attached = false;
  }

  attach() { this.attached = true; }
  isAttached() { return this.attached; }
  detach() {
    if (!this.attached) return;
    this.attached = false;
    this.emit("detach", {}, "target closed");
  }

  sendCommand(method, params = {}, sessionId = undefined) {
    if (this.contents.isDestroyed()) return Promise.reject(new Error(`${method}: target closed`));
    // The engine already auto-attaches every frame with flatten and replays each child to
    // listeners; a second setAutoAttach from main.cjs would be redundant and, with
    // waitForDebuggerOnStart differing, could leave a frame paused.
    if (method === "Target.setAutoAttach") {
      if (!sessionId) this.contents.replayAttachedFrames(this);
      return Promise.resolve({});
    }
    if (method.startsWith("Input.")) return this.contents.sendInput(method, params, sessionId);
    if (sessionId && sessionId !== this.contents.session.id) return this.contents.connection.send(method, params, sessionId);
    return this.contents.session.send(method, params);
  }

  deliver(method, params, sessionId) {
    if (!this.attached) return;
    // Electron passes the CHILD session's parent as the 4th argument for an attach event, and
    // the session the event came from otherwise.
    this.emit("message", {}, method, params, sessionId === this.contents.session.id ? undefined : sessionId);
  }
}

class CdpNavigationHistory {
  constructor(contents) {
    this.contents = contents;
    this.entries = [];
    this.index = -1;
  }

  async refresh() {
    try {
      const history = await this.contents.session.send("Page.getNavigationHistory");
      this.entries = history.entries || [];
      this.index = history.currentIndex ?? -1;
    } catch (_) { /* target gone */ }
  }

  canGoBack() { return this.index > 0; }
  canGoForward() { return this.index >= 0 && this.index < this.entries.length - 1; }
  goBack() { return this.goToOffset(-1); }
  goForward() { return this.goToOffset(1); }
  goToOffset(offset) {
    const entry = this.entries[this.index + offset];
    if (!entry) return;
    void this.contents.session.send("Page.navigateToHistoryEntry", { entryId: entry.id }).catch(() => {});
  }
}

// The session a tab will have. `new BrowserWindow()` is synchronous and main.cjs talks to the
// webContents on the very next line, but a CDP target takes a round trip to exist. Calls made
// in between wait for the real session; listeners attach to it when it arrives. Nothing is
// dropped and nothing is answered with a fake.
class PendingSession extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.real = null;
    this.id = null;
    this.detached = false;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Nobody may be awaiting it yet; an unhandled rejection would crash the host.
    this.ready.catch(() => {});
  }

  bind(session) {
    this.real = session;
    this.id = session.id;
    const forward = session.emit.bind(session);
    session.emit = (event, ...args) => {
      forward(event, ...args);
      return this.emit(event, ...args);
    };
    this.resolveReady(session);
  }

  fail(error) {
    this.detached = true;
    this.rejectReady(error);
  }

  send(method, params = {}) {
    if (this.real) return this.real.send(method, params);
    return this.ready.then((session) => session.send(method, params));
  }
}

class CdpWebContents extends EventEmitter {
  constructor(engine, targetId, session, options = {}) {
    super();
    this.setMaxListeners(0);
    this.engine = engine;
    this.connection = engine.connection;
    this.targetId = targetId;
    this.session = session || new PendingSession();
    this.id = nextContentsId++;
    this.destroyed = false;
    this.frames = new Map();
    this.childSessions = new Map();
    this.mainFrameId = null;
    this.title = "";
    this.currentUrl = "about:blank";
    this.loading = false;
    this.zoomFactor = 1;
    this.deviceScaleFactor = options.deviceScaleFactor || 1;
    this.viewport = { width: options.width || 800, height: options.height || 600 };
    this.frameRate = 30;
    this.painting = true;
    this.audioMuted = false;
    this.audible = false;
    this.playing = false;
    this.audibleFrames = new Set();
    this.playingFrames = new Set();
    this.userAgentOverride = null;
    this.defaultUserAgent = null;
    this.windowOpenHandler = null;
    this.debugger = new CdpDebugger(this);
    this.navigationHistory = new CdpNavigationHistory(this);
    this.keys = new KeySequencer((params) => this.dispatchKey(params));
    this.keyFlushQueued = false;
    this.capture = { inFlight: 0, dirty: false, lastAt: 0, timer: null, screencast: false };
    this.findState = null;
  }

  // --- lifecycle -------------------------------------------------------------------------

  async initialize(targetId, realSession) {
    if (realSession) {
      this.targetId = targetId;
      this.session.bind(realSession);
    }
    const session = this.session;
    session.on("Page.frameNavigated", (params) => this.onFrameNavigated(params.frame, session.id));
    session.on("Page.frameAttached", (params) => this.onFrameAttached(params, session.id));
    session.on("Page.frameDetached", (params) => this.onFrameDetached(params));
    session.on("Page.frameStartedLoading", (params) => this.onFrameStartedLoading(params, session.id));
    session.on("Page.frameStoppedLoading", (params) => this.onFrameStoppedLoading(params));
    session.on("Page.navigatedWithinDocument", (params) => this.onNavigatedWithinDocument(params));
    session.on("Page.domContentEventFired", () => this.emit("dom-ready", {}));
    session.on("Page.loadEventFired", () => this.onLoad());
    session.on("Page.screencastFrame", (params) => this.onScreencastFrame(params));
    session.on("Page.fileChooserOpened", (params) => this.debugger.deliver("Page.fileChooserOpened", params, session.id));
    session.on("Page.javascriptDialogOpening", (params) => this.onDialog(params, session.id));
    session.on("Page.downloadWillBegin", (params) => this.engine.onDownloadWillBegin(this, params));
    session.on("Page.windowOpen", (params) => this.onWindowOpen(params));
    session.on("Runtime.executionContextCreated", (params) => this.onContextCreated(params.context, session.id));
    session.on("Runtime.executionContextsCleared", () => this.onContextsCleared(session.id));
    session.on("Runtime.bindingCalled", (params) => this.onBinding(params, session.id));
    session.on("Runtime.consoleAPICalled", (params) => this.onConsole(params));
    session.on("Runtime.exceptionThrown", (params) => this.onException(params));
    session.on("Target.attachedToTarget", (params) => this.onChildAttached(params, session.id));
    session.on("Target.detachedFromTarget", (params) => this.onChildDetached(params, session.id));
    session.on("Inspector.targetCrashed", () => this.emit("render-process-gone", {}, { reason: "crashed", exitCode: -1 }));
    session.on("Network.requestWillBeSent", (params) => this.engine.onRequest(this, params));
    session.on("Network.responseReceived", (params) => this.engine.onResponse(this, params));
    session.on("Network.loadingFailed", (params) => this.engine.onRequestFailed(this, params));
    session.on("detached", () => this.destroy());

    await this.prepareSession(session, true);
    this.initialized = true;
    const tree = await session.send("Page.getFrameTree");
    this.registerTree(tree.frameTree, null, session.id);
    try {
      const version = await session.send("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
      this.defaultUserAgent = version.result?.value || null;
    } catch (_) { /* filled in lazily */ }
    await this.applyMetrics();
    await this.startScreencast();
  }

  // Everything a session needs before its page runs a line: the preload in its isolated world,
  // the binding into that world, the print shim in the main world, and auto-attach for frames
  // below it. Root and child sessions alike — an OOPIF is a page as far as the preload goes.
  async prepareSession(session, root) {
    const calls = [
      session.send("Page.enable"),
      session.send("Runtime.enable"),
      session.send("Runtime.addBinding", { name: BINDING_NAME, executionContextName: WORLD_NAME }),
      session.send("Runtime.addBinding", { name: "__twebContextMenu", executionContextName: WORLD_NAME }),
      session.send("Runtime.addBinding", { name: "__twebTitle", executionContextName: WORLD_NAME }),
      // Unscoped: the audio probe runs in the page's own world. It carries one bit of state the
      // page could forge only about itself.
      session.send("Runtime.addBinding", { name: "__twebAudio" }),
      session.send("Page.addScriptToEvaluateOnNewDocument", { source: PRINT_SHIM, runImmediately: true }),
      session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: preloadScript(), worldName: WORLD_NAME, runImmediately: true,
      }),
      session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: CONTEXT_MENU_PROBE, worldName: WORLD_NAME, runImmediately: true,
      }),
      session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: TITLE_PROBE, worldName: WORLD_NAME, runImmediately: true,
      }),
      // The main world, not the isolated one: AudioContext has to be wrapped where the page
      // constructs it, and media mute has to touch the elements the page holds.
      session.send("Page.addScriptToEvaluateOnNewDocument", { source: AUDIO_PROBE, runImmediately: true }),
      session.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }),
    ];
    if (root) {
      calls.push(
        session.send("Network.enable"),
        session.send("Page.setInterceptFileChooserDialog", { enabled: true }),
        session.send("Page.setLifecycleEventsEnabled", { enabled: true }),
        // A pane is never "hidden" in Chrome's sense, even though no Chrome window is on screen.
        session.send("Emulation.setFocusEmulationEnabled", { enabled: true }),
        session.send("Browser.setDownloadBehavior", {
          behavior: "allowAndName", downloadPath: this.engine.downloadDirectory(), eventsEnabled: true,
        }).catch(() => {}),
      );
    }
    const results = await Promise.allSettled(calls);
    for (const result of results) {
      if (result.status === "rejected" && this.engine.debug) {
        console.error(`tweb: cdp prepare ${result.reason?.message || result.reason}`);
      }
    }
    // A page that existed before the scripts were registered never ran them.
    if (root) {
      await session.send("Page.createIsolatedWorld", { frameId: this.targetId, worldName: WORLD_NAME }).catch(() => {});
    }
  }

  // Mouse coordinates, corrected for a Chrome defect measured on this engine and nowhere else.
  //
  // Once a tab has been both screencast and captured at device scale — which is exactly how this
  // engine paints — Chrome routes `Input.dispatchMouseEvent` as if its coordinates were device
  // pixels: every point lands at (x, y) / deviceScaleFactor. Measured: a click at CSS (48,160)
  // arrived at (24,80) on a dsf-2 tab and at (30,100) on a dsf-1.6 one, moves skewed identically,
  // and the page's own layout, devicePixelRatio and screenshots stayed correct throughout. Turning
  // off either the screencast or the captures cures it; re-sending the override, resizing the
  // window, a second input session, serialising captures and pausing the screencast around each
  // capture did not. Coordinates pre-multiplied by the skew landed exactly, including far down the
  // page — so the skew is measured rather than assumed, and undone.
  //
  // The measurement is one `mouseMoved` at a known point, read back by a listener in the preload's
  // isolated world. It is taken before the first pointer event after anything that can change the
  // skew (navigation, a metrics change), and re-checked every few seconds of pointer use, because
  // the defect can begin after the tab has already been used. Only 1 or the current
  // deviceScaleFactor are accepted: anything else is a probe that missed, and leaves input as is.
  invalidateInputScale() {
    this.inputScale = null;
  }

  async measureInputScale() {
    const frame = this.mainFrame;
    if (!frame || frame.isolatedContextId === null) return 1;
    const probe = { x: 17, y: 13 };
    try {
      await this.evaluateIn(this.session.id, frame.isolatedContextId, `(() => {
        globalThis.__twebProbe = null;
        if (!globalThis.__twebProbeArmed) {
          globalThis.__twebProbeArmed = true;
          addEventListener("mousemove", (e) => { globalThis.__twebProbe = [e.clientX, e.clientY]; }, true);
        }
      })()`);
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: probe.x, y: probe.y, button: "none" });
      const seen = await this.evaluateIn(this.session.id, frame.isolatedContextId, "globalThis.__twebProbe");
      if (!Array.isArray(seen) || !(seen[0] > 0)) return this.inputScale || 1;
      const ratio = probe.x / seen[0];
      const dsf = this.deviceScaleFactor || 1;
      const scale = Math.abs(ratio - dsf) < 0.15 ? dsf : Math.abs(ratio - 1) < 0.15 ? 1 : (this.inputScale || 1);
      if (scale !== 1 && this.inputScale !== scale && this.engine.debug) {
        console.error(`tweb: chrome input skew ${(1 / scale).toFixed(3)} measured, correcting`);
      }
      return scale;
    } catch (_) {
      return this.inputScale || 1;
    }
  }

  // The scale to multiply mouse coordinates by, measured when stale. Concurrent callers share one
  // measurement, and pointer events queue behind it so their order is kept.
  inputScaleReady() {
    const now = Date.now();
    // Never mid-drag: the probe is a buttonless move, and it would end the drag on the page.
    if (this.inputScale && (this.pointerHeld || now - this.inputScaleAt < INPUT_SCALE_RECHECK_MS)) {
      return Promise.resolve(this.inputScale);
    }
    if (!this.inputScaleProbe) {
      this.inputScaleProbe = this.measureInputScale().then((scale) => {
        this.inputScale = scale;
        this.inputScaleAt = Date.now();
        this.inputScaleProbe = null;
        return scale;
      });
    }
    return this.inputScaleProbe;
  }

  // Every `Input.*` for the top frame goes through here, in order. Mouse events are scaled; keys
  // wait their turn behind any pointer event still queued so a click-then-type is not reordered.
  // An out-of-process frame's session is a different widget and is sent to directly.
  sendInput(method, params, sessionId = undefined) {
    if (sessionId && sessionId !== this.session.id) return this.connection.send(method, params, sessionId);
    if (method === "Input.dispatchMouseEvent") {
      if (params.type === "mousePressed") this.pointerHeld = true;
      else if (params.type === "mouseReleased" || (params.type === "mouseMoved" && !params.buttons)) this.pointerHeld = false;
    }
    const send = async () => {
      if (method !== "Input.dispatchMouseEvent") return this.session.send(method, params);
      const scale = await this.inputScaleReady();
      const sent = { ...params, x: params.x * scale, y: params.y * scale };
      // Wheel distance is in DIPs on Electron, where zoom is the browser's own and Chromium turns
      // DIPs into CSS pixels itself. Here zoom is an emulated scale with no such step, so a notch
      // scrolled a fifth less at the default 0.8 — measured 300px against Electron's 375 for three.
      if (params.type === "mouseWheel") {
        const zoom = this.zoomFactor || 1;
        sent.deltaX = (params.deltaX || 0) / zoom;
        sent.deltaY = (params.deltaY || 0) / zoom;
      }
      return this.session.send(method, sent);
    };
    const next = (this.inputQueue || Promise.resolve()).then(send, send);
    this.inputQueue = next.catch(() => {});
    return next;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const key of ["timer", "castTimer", "settleTimer"]) {
      if (this.capture[key]) clearTimeout(this.capture[key]);
    }
    this.debugger.detach();
    this.emit("destroyed");
  }

  isDestroyed() { return this.destroyed; }

  sessionFor(sessionId) {
    return !sessionId || sessionId === this.session.id ? this.session : this.childSessions.get(sessionId) || this.session;
  }

  // --- frames ----------------------------------------------------------------------------

  registerTree(node, parentId, sessionId) {
    const frame = this.ensureFrame(node.frame.id, sessionId);
    frame.url = node.frame.url + (node.frame.urlFragment || "");
    frame.parentId = parentId;
    if (!parentId) {
      this.mainFrameId = node.frame.id;
      this.currentUrl = frame.url;
    }
    for (const child of node.childFrames || []) this.registerTree(child, node.frame.id, sessionId);
  }

  ensureFrame(frameId, sessionId) {
    let frame = this.frames.get(frameId);
    if (!frame) {
      frame = new CdpFrame(this, frameId, sessionId);
      this.frames.set(frameId, frame);
      if (frameId !== this.targetId) this.emit("frame-created", {}, { frame });
    } else if (sessionId && frame.sessionId !== sessionId) {
      // A frame moving into its own process: the OOPIF session now owns it.
      frame.sessionId = sessionId;
      frame.isolatedContextId = null;
      frame.mainContextId = null;
    }
    frame.detached = false;
    return frame;
  }

  get mainFrame() { return this.frames.get(this.mainFrameId || this.targetId) || null; }

  get focusedFrame() { return this.mainFrame; }

  onFrameAttached(params, sessionId) {
    const frame = this.ensureFrame(params.frameId, sessionId);
    frame.parentId = params.parentFrameId || null;
  }

  onFrameDetached(params) {
    // "swap" means the frame moved to another process and lives on under a new session.
    if (params.reason === "swap") return;
    const frame = this.frames.get(params.frameId);
    if (!frame) return;
    frame.detached = true;
    this.frames.delete(params.frameId);
  }

  onFrameStartedLoading(params, sessionId) {
    const frame = this.ensureFrame(params.frameId, sessionId);
    const isMainFrame = !frame.parentId;
    if (isMainFrame) {
      this.loading = true;
      this.emit("did-start-loading", {});
    }
    // main.cjs prunes per-frame readiness here; the frame object it gets must be the live one.
    this.emit("did-start-navigation", {
      url: frame.url, isSameDocument: false, isMainFrame, frame,
    });
  }

  onFrameStoppedLoading(params) {
    const frame = this.frames.get(params.frameId);
    if (frame && !frame.parentId) {
      this.loading = false;
      this.emit("did-stop-loading", {});
    }
  }

  onFrameNavigated(cdpFrame, sessionId) {
    const frame = this.ensureFrame(cdpFrame.id, sessionId);
    frame.url = cdpFrame.url + (cdpFrame.urlFragment || "");
    frame.parentId = cdpFrame.parentId || (sessionId !== this.session.id ? frame.parentId : null);
    if (!cdpFrame.parentId && sessionId === this.session.id) {
      this.invalidateInputScale();
      this.mainFrameId = cdpFrame.id;
      this.currentUrl = frame.url;
      this.title = "";
      void this.navigationHistory.refresh();
      // Chrome reports a load failure by navigating to an error page whose url is the one that
      // failed; `unreachableUrl` is set when that happened.
      if (cdpFrame.unreachableUrl) {
        this.emit("did-fail-load", {}, -2, "ERR_FAILED", cdpFrame.unreachableUrl, true);
        return;
      }
      this.emit("did-navigate", {}, frame.url, 200, "OK");
      void this.refreshTitle();
    }
  }

  onNavigatedWithinDocument(params) {
    const frame = this.frames.get(params.frameId);
    if (!frame) return;
    frame.url = params.url;
    const isMainFrame = !frame.parentId;
    if (isMainFrame) {
      this.currentUrl = params.url;
      void this.navigationHistory.refresh();
    }
    this.emit("did-navigate-in-page", {}, params.url, isMainFrame);
  }

  async onLoad() {
    await this.navigationHistory.refresh();
    await this.refreshTitle();
    this.emit("did-finish-load", {});
  }

  // The title as the page has set it, read back once a load finishes. A document with no
  // <title> has an empty one, which is what Electron reports too.
  async refreshTitle() {
    try {
      const title = String(await this.evaluateIn(this.session.id, this.mainFrame?.mainContextId, "document.title") || "");
      if (title && title !== this.title) {
        this.title = title;
        this.engine.windowFor(this)?.emit("page-title-updated", {}, title, true);
      }
    } catch (_) { /* navigated again before the read */ }
  }

  onContextCreated(context, sessionId) {
    const frameId = context.auxData?.frameId;
    if (!frameId) return;
    const frame = this.ensureFrame(frameId, sessionId);
    if (context.name === WORLD_NAME) frame.isolatedContextId = context.id;
    else if (context.auxData?.isDefault) frame.mainContextId = context.id;
  }

  onContextsCleared(sessionId) {
    for (const frame of this.frames.values()) {
      if (frame.sessionId === sessionId) {
        frame.isolatedContextId = null;
        frame.mainContextId = null;
      }
    }
  }

  frameForContext(contextId, sessionId) {
    for (const frame of this.frames.values()) {
      if (frame.sessionId === sessionId && (frame.isolatedContextId === contextId || frame.mainContextId === contextId)) {
        return frame;
      }
    }
    return null;
  }

  // --- child sessions (OOPIFs, workers) ----------------------------------------------------

  async onChildAttached(params, parentSessionId) {
    const info = params.targetInfo || {};
    const child = this.connection.session(params.sessionId);
    if (info.type === "iframe") {
      this.childSessions.set(params.sessionId, child);
      this.attachedFrames.set(params.sessionId, { params, parentSessionId });
      child.on("Page.frameNavigated", (p) => this.onFrameNavigated(p.frame, child.id));
      child.on("Page.frameAttached", (p) => this.onFrameAttached(p, child.id));
      child.on("Page.frameDetached", (p) => this.onFrameDetached(p));
      child.on("Runtime.executionContextCreated", (p) => this.onContextCreated(p.context, child.id));
      child.on("Runtime.executionContextsCleared", () => this.onContextsCleared(child.id));
      child.on("Runtime.bindingCalled", (p) => this.onBinding(p, child.id));
      child.on("Runtime.consoleAPICalled", (p) => this.onConsole(p));
      child.on("Target.attachedToTarget", (p) => this.onChildAttached(p, child.id));
      child.on("Target.detachedFromTarget", (p) => this.onChildDetached(p, child.id));
      child.on("Page.javascriptDialogOpening", (p) => this.onDialog(p, child.id));
      const frame = this.ensureFrame(info.targetId, child.id);
      frame.url = info.url || frame.url;
      await this.prepareSession(child, false);
      // The frame's place in the tree: the session that announced it owns its parent document.
      try {
        const tree = await child.send("Page.getFrameTree");
        const root = this.frames.get(tree.frameTree.frame.id);
        if (root && tree.frameTree.frame.parentId) root.parentId = tree.frameTree.frame.parentId;
        for (const sub of tree.frameTree.childFrames || []) this.registerTree(sub, tree.frameTree.frame.id, child.id);
      } catch (_) { /* gone already */ }
    }
    await child.send("Runtime.runIfWaitingForDebugger").catch(() => {});
    if (info.type === "iframe") this.debugger.deliver("Target.attachedToTarget", params, parentSessionId);
  }

  get attachedFrames() {
    if (!this._attachedFrames) this._attachedFrames = new Map();
    return this._attachedFrames;
  }

  onChildDetached(params, parentSessionId) {
    this.childSessions.delete(params.sessionId);
    this.attachedFrames.delete(params.sessionId);
    this.connection.dropSession(params.sessionId);
    for (const frame of this.frames.values()) {
      if (frame.sessionId === params.sessionId) frame.detached = true;
    }
    this.debugger.deliver("Target.detachedFromTarget", params, parentSessionId);
  }

  replayAttachedFrames(debuggerInstance) {
    for (const { params, parentSessionId } of this.attachedFrames.values()) {
      setImmediate(() => debuggerInstance.deliver("Target.attachedToTarget", params, parentSessionId));
    }
  }

  // --- preload IPC -----------------------------------------------------------------------

  onBinding(params, sessionId) {
    const frame = this.frameForContext(params.executionContextId, sessionId);
    if (params.name === "__twebContextMenu") {
      let menu;
      try { menu = JSON.parse(params.payload); } catch (_) { return; }
      void this.contextMenuParams(menu, frame).then((resolved) => this.emit("context-menu", {}, resolved));
      return;
    }
    if (params.name === "__twebAudio") {
      let state;
      try { state = JSON.parse(params.payload); } catch (_) { return; }
      const key = frame ? frame.frameId : sessionId;
      if (state.audible) this.audibleFrames.add(key);
      else this.audibleFrames.delete(key);
      const wasPlaying = this.playing;
      if (state.playing) this.playingFrames.add(key);
      else this.playingFrames.delete(key);
      this.playing = this.playingFrames.size > 0;
      this.audible = this.audibleFrames.size > 0;
      if (this.playing && !wasPlaying) this.emit("media-started-playing", {});
      else if (!this.playing && wasPlaying) this.emit("media-paused", {});
      return;
    }
    if (params.name === "__twebTitle") {
      if (sessionId !== this.session.id || !frame || frame.parentId) return;
      const title = String(params.payload || "");
      if (title && title !== this.title) {
        this.title = title;
        this.engine.windowFor(this)?.emit("page-title-updated", {}, title, true);
      }
      return;
    }
    if (params.name !== BINDING_NAME) return;
    let message;
    try { message = JSON.parse(params.payload); } catch (_) { return; }
    if (!frame) return;
    if (message.kind === "ipc") {
      // The fields of Electron's IpcMainEvent main.cjs reads. `reply` answers the frame that
      // sent the message, which is what Electron's does.
      this.engine.ipcMain.deliver(message.channel, {
        sender: this,
        senderFrame: frame,
        frameId: frame.frameId,
        processId: frame.processId,
        reply: (channel, ...args) => frame.send(channel, ...args),
      }, message.args || []);
    } else if (message.kind === "main-eval") {
      frame.executeJavaScript(message.code, false)
        .then((value) => frame.send("\u0000eval", message.id, null, value))
        .catch((error) => frame.send("\u0000eval", message.id, String(error?.message || error)));
    }
  }

  // Electron reports context-menu coordinates in the top frame's window space; a subframe's
  // `clientX` is in its own. The offset is the frame's box in the top page, which only the
  // top page can measure — the same problem main.cjs solves for hints.
  async contextMenuParams(menu, frame) {
    const zoom = this.zoomFactor || 1;
    let x = menu.x;
    let y = menu.y;
    if (frame && frame.parentId && frame.sessionId !== this.session.id) {
      try {
        const owner = await this.session.send("DOM.getFrameOwner", { frameId: frame.frameId });
        const box = await this.session.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId });
        x += box.model.content[0];
        y += box.model.content[1];
      } catch (_) { /* best effort; the menu still opens, slightly off */ }
    }
    return { ...menu, x: Math.round(x * zoom), y: Math.round(y * zoom) };
  }

  async evaluateIn(sessionId, contextId, code, userGesture = false) {
    const session = this.sessionFor(sessionId);
    const params = {
      expression: String(code),
      awaitPromise: true,
      returnByValue: true,
      userGesture: Boolean(userGesture),
    };
    if (contextId !== null && contextId !== undefined) params.contextId = contextId;
    const result = await session.send("Runtime.evaluate", params);
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(description || "evaluation failed");
    }
    return result.result?.value;
  }

  onConsole(params) {
    const levels = { debug: 0, log: 1, info: 1, warning: 2, warn: 2, error: 3 };
    const message = (params.args || []).map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || "")).join(" ");
    const frame = params.stackTrace?.callFrames?.[0];
    this.emit("console-message", {
      level: params.type === "warning" ? "warning" : params.type === "error" ? "error" : params.type === "debug" ? "debug" : "info",
      message,
      lineNumber: frame?.lineNumber ?? 0,
      sourceId: frame?.url || "",
    }, levels[params.type] ?? 1, message, frame?.lineNumber ?? 0, frame?.url || "");
  }

  onException(params) {
    const details = params.exceptionDetails || {};
    const message = details.exception?.description || details.text || "Uncaught exception";
    this.emit("console-message", {
      level: "error", message, lineNumber: details.lineNumber ?? 0, sourceId: details.url || "",
    }, 3, message, details.lineNumber ?? 0, details.url || "");
  }

  // A JavaScript dialog in a pane has nowhere to appear. Electron's offscreen window answers
  // them itself (alert -> dismissed, confirm -> false); Chrome waits forever for an answer
  // that never comes, freezing the page. So: answered the way Electron would, and logged.
  onDialog(params, sessionId) {
    const accept = params.type === "beforeunload";
    if (this.engine.debug) console.error(`tweb: dialog ${params.type} "${params.message}" -> ${accept ? "accept" : "dismiss"}`);
    void this.sessionFor(sessionId).send("Page.handleJavaScriptDialog", { accept }).catch(() => {});
  }

  // --- window.open -----------------------------------------------------------------------

  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }

  // Chrome makes the new target itself; `Page.windowOpen` only reports it. So `deny` means
  // closing what Chrome already opened, and `allow` means adopting it — the same two outcomes
  // main.cjs's handler picks between, in the opposite order of events.
  onWindowOpen(params) {
    const features = (params.windowFeatures || []).join(",");
    const disposition = params.userGesture === false && !features ? "foreground-tab"
      : features ? "new-window" : "foreground-tab";
    this.engine.pendingOpens.push({
      opener: this,
      url: params.url,
      disposition,
      decision: this.windowOpenHandler
        ? this.windowOpenHandler({ url: params.url, frameName: params.windowName, features, disposition })
        : { action: "allow" },
    });
  }

  // --- rendering -------------------------------------------------------------------------

  // Not before `initialize` has finished: the override is per session, and the session is the
  // one being set up.
  async applyMetrics() {
    if (!this.initialized) return;
    this.invalidateInputScale();
    const { width, height } = this.viewport;
    if (width < 1 || height < 1) return;
    await this.session.send("Emulation.setDeviceMetricsOverride", {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor: this.deviceScaleFactor,
      mobile: false,
      // Hides the page from `screen.width` being Chrome's idea of a headless display.
      screenWidth: Math.round(width),
      screenHeight: Math.round(height),
    }).catch(() => {});
    this.invalidate();
  }

  setViewport(width, height, deviceScaleFactor = this.deviceScaleFactor) {
    const changed = width !== this.viewport.width || height !== this.viewport.height
      || deviceScaleFactor !== this.deviceScaleFactor;
    this.viewport = { width, height };
    this.deviceScaleFactor = deviceScaleFactor;
    if (changed && !this.destroyed) void this.applyMetrics();
  }

  // The screencast is the damage signal, and it has to be compared by CONTENT, not counted.
  // `captureScreenshot` makes the compositor produce a frame, and that frame arrives here as a
  // screencast frame too — measured: one invalidate on a static page turned into 91 screencast
  // frames and 86 captures in 3s, a loop that sustains itself forever. Every frame the loop makes
  // is pixel-identical to the last, so a frame equal to the previous one is the capture's echo and
  // is dropped; a frame that differs is a real change. JPEG at full quality so a one-glyph change
  // (a caret, a typed letter) still changes the bytes; at CSS-pixel size it costs a fraction of
  // the device-pixel capture it gates.
  async startScreencast() {
    if (this.capture.screencast || this.destroyed || !this.painting) return;
    this.capture.screencast = true;
    this.capture.lastSignal = null;
    await this.session.send("Page.startScreencast", {
      format: "jpeg", quality: SCREENCAST_QUALITY, everyNthFrame: 1,
    }).catch(() => { this.capture.screencast = false; });
  }

  async stopScreencast() {
    if (!this.capture.screencast) return;
    this.capture.screencast = false;
    await this.session.send("Page.stopScreencast").catch(() => {});
  }

  // While the page moves, the screencast IS the picture; once it stops, one device-pixel capture
  // replaces it.
  //
  // A device-pixel `captureScreenshot` of a busy page is slow: measured on a playing YouTube video,
  // 272–300ms per frame (2–3MB PNGs) with the screencast running beside it — 6.4 frames/s in the
  // pane against Electron's 9.6, and 140–190% CPU against Electron's 7%. The screencast pushes the
  // same picture at 60fps but only at CSS-pixel size (half resolution on a Retina pane, whatever
  // `maxWidth` or `scale` says — measured). So motion is drawn from the screencast, scaled to the
  // frame size, and sharpness is restored by one capture `SETTLE_MS` after the last change. A page
  // of text is still on screen at full resolution almost all the time; only a scroll in progress
  // or a video is drawn at half.
  onScreencastFrame(params) {
    void this.session.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    if (PROFILE) this.signals = (this.signals || 0) + 1;
    // An unchanged frame is the echo of a capture (see `startScreencast`), not a change.
    if (params.data === this.capture.lastSignal) return;
    this.capture.lastSignal = params.data;
    this.capture.generation = (this.capture.generation || 0) + 1;
    this.scheduleSettle();
    this.presentScreencastFrame(params.data);
  }

  // Paced to the pane's frame rate; a frame that arrives inside the interval waits as `pendingCast`
  // and only the newest is kept — older ones are already stale.
  presentScreencastFrame(data) {
    const capture = this.capture;
    capture.pendingCast = data;
    if (capture.castTimer || this.destroyed || !this.painting) return;
    const wait = (capture.lastAt || 0) + 1000 / Math.max(1, this.frameRate) - Date.now();
    capture.castTimer = setTimeout(() => {
      capture.castTimer = null;
      const next = capture.pendingCast;
      capture.pendingCast = null;
      if (!next || this.destroyed || !this.painting || !nativeImage) return;
      capture.lastAt = Date.now();
      const decoded = nativeImage.createFromBuffer(Buffer.from(next, "base64"));
      const want = this.frameSize || decoded.getSize();
      const image = decoded.getSize().width === want.width && decoded.getSize().height === want.height
        ? decoded
        : decoded.resize({ width: want.width, height: want.height, quality: "good" });
      // The damage diff is skipped: a frame arriving here differs from the last by construction,
      // and its pixels are about to be replaced by the settled capture anyway.
      this.lastBitmap = null;
      this.capture.forceNext = false;
      const size = image.getSize();
      this.emit("paint", {}, { x: 0, y: 0, width: size.width, height: size.height }, image);
    }, Math.max(0, wait));
  }

  scheduleSettle() {
    const capture = this.capture;
    if (capture.settleTimer) clearTimeout(capture.settleTimer);
    capture.settleTimer = setTimeout(() => {
      capture.settleTimer = null;
      capture.forceNext = true;
      this.requestCapture();
    }, SETTLE_MS);
  }

  // Electron's `invalidate()` always yields a paint, changed or not, and main.cjs relies on it:
  // a pane coming back into view repaints from it, and `awaitRestoredFrame` waits for it. So an
  // explicit invalidate forces the next frame through the unchanged-frame filter; a damage
  // signal from the screencast does not.
  invalidate() {
    if (this.destroyed || !this.painting) return;
    this.capture.forceNext = true;
    this.requestCapture();
  }

  requestCapture() {
    if (this.destroyed || !this.painting) return;
    this.capture.dirty = true;
    this.pumpCapture();
  }

  pumpCapture() {
    const capture = this.capture;
    if (!capture.dirty || capture.timer || capture.inFlight >= 2 || this.destroyed || !this.painting) return;
    const interval = 1000 / Math.max(1, this.frameRate);
    const wait = capture.lastAt + interval - Date.now();
    if (wait > 0) {
      capture.timer = setTimeout(() => {
        capture.timer = null;
        this.pumpCapture();
      }, wait);
      return;
    }
    capture.dirty = false;
    capture.lastAt = Date.now();
    capture.inFlight += 1;
    this.captureFrame().finally(() => {
      capture.inFlight -= 1;
      this.pumpCapture();
    });
  }

  async captureFrame() {
    let shot;
    let timer = null;
    const t0 = performance.now();
    const generation = this.capture.generation || 0;
    try {
      // PNG, not JPEG: the frame is decoded to a bitmap and re-encoded for the terminal anyway,
      // and a JPEG round trip smears text — the one thing a browser pane must render sharply.
      //
      // Bounded. A screenshot asked of a page that has not committed its first frame is never
      // answered — measured: both in-flight slots stuck on `about:blank` before navigation, and
      // the pane never drew again. The slot is given back and the next signal asks afresh.
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("captureScreenshot timed out")), CAPTURE_TIMEOUT_MS);
      });
      shot = await Promise.race([
        this.session.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true }),
        deadline,
      ]);
    } catch (error) {
      // Timed out or failed: whatever changed is still unpainted.
      this.capture.dirty = true;
      if (this.engine.debug && !this.destroyed) console.error(`tweb: capture failed ${error.message}`);
      return;
    } finally {
      clearTimeout(timer);
    }
    if (this.destroyed || !nativeImage) return;
    // The page moved while this was being taken: the screencast has drawn something newer, and
    // the settle timer will ask again once it stops.
    if ((this.capture.generation || 0) !== generation && !this.capture.forceNext) return;
    const t1 = performance.now();
    let image = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
    const want = this.frameSize;
    const raw = image.getSize();
    if (want && !this.deviceEmulation && (raw.width > want.width || raw.height > want.height)
      && raw.width - want.width <= 4 && raw.height - want.height <= 4) {
      image = image.crop({ x: 0, y: 0, width: Math.min(raw.width, want.width), height: Math.min(raw.height, want.height) });
    }
    const size = image.getSize();
    // Damage, recovered by comparison (see damage.cjs). Unchanged frames are not painted at all
    // — Electron does not paint when nothing changed either — and a changed one carries the box
    // that changed, so main.cjs can send a caret blink as a patch rather than a whole frame.
    const t2 = performance.now();
    const bitmap = image.toBitmap();
    const t3 = performance.now();
    const previous = this.lastBitmap;
    const sameSize = previous && previous.width === size.width && previous.height === size.height;
    const dirty = sameSize
      ? dirtyRect(previous.pixels, bitmap, size.width, size.height)
      : { x: 0, y: 0, width: size.width, height: size.height };
    this.lastBitmap = { pixels: bitmap, width: size.width, height: size.height };
    if (PROFILE) profileCapture(this, { capture: t1 - t0, decode: t2 - t1, bitmap: t3 - t2, diff: performance.now() - t3, bytes: shot.data.length * 0.75, changed: Boolean(dirty) });
    if (!dirty && !this.capture.forceNext) return;
    this.capture.forceNext = false;
    this.emit("paint", {}, dirty || { x: 0, y: 0, width: size.width, height: size.height }, image);
  }

  async capturePage(rect) {
    const params = { format: "png" };
    if (rect) params.clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
    const shot = await this.session.send("Page.captureScreenshot", params);
    return nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
  }

  setFrameRate(rate) {
    this.frameRate = Math.max(1, Number(rate) || 1);
  }

  getFrameRate() { return this.frameRate; }

  startPainting() {
    if (this.painting) return;
    this.painting = true;
    void this.startScreencast();
    this.invalidate();
  }

  stopPainting() {
    this.painting = false;
    void this.stopScreencast();
  }

  isPainting() { return this.painting; }

  setBackgroundThrottling() { /* the launch flags already disable it browser-wide */ }

  // --- navigation ------------------------------------------------------------------------

  getURL() { return this.currentUrl; }
  getTitle() { return this.title || ""; }
  isLoading() { return this.loading; }

  async loadURL(url) {
    const result = await this.session.send("Page.navigate", { url: String(url) });
    if (result.errorText && result.errorText !== "net::ERR_ABORTED") {
      // Electron rejects loadURL for a failed load AND emits did-fail-load; keep both.
      this.emit("did-fail-load", {}, -2, result.errorText, url, true);
      const error = new Error(`${result.errorText} loading '${url}'`);
      error.code = result.errorText;
      throw error;
    }
    if (result.errorText === "net::ERR_ABORTED") {
      const error = new Error(`ERR_ABORTED (-3) loading '${url}'`);
      error.code = "ERR_ABORTED";
      throw error;
    }
  }

  reload() { void this.session.send("Page.reload", { ignoreCache: false }).catch(() => {}); }
  reloadIgnoringCache() { void this.session.send("Page.reload", { ignoreCache: true }).catch(() => {}); }
  stop() { void this.session.send("Page.stopLoading").catch(() => {}); }

  // --- zoom ------------------------------------------------------------------------------

  // Electron's zoom is page zoom: CSS pixels grow, the layout viewport shrinks. CDP has no page
  // zoom, but a device metrics override with the viewport divided by the factor and the scale
  // multiplied by it is the same thing — the page lays out in fewer, larger CSS pixels on the
  // same number of device pixels. The pane's size stays fixed; only `deviceScaleFactor` and the
  // CSS viewport move.
  getZoomFactor() { return this.zoomFactor; }

  setZoomFactor(factor) {
    const value = Number(factor);
    if (!Number.isFinite(value) || value <= 0 || value === this.zoomFactor) return;
    this.zoomFactor = value;
    this.engine.windowFor(this)?.relayout();
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
    if (type === "contextMenu") return;
    const params = toCdpMouse(scaleMouse(event, this.zoomFactor));
    if (params) void this.sendInput("Input.dispatchMouseEvent", params).catch(() => {});
  }

  dispatchKey(params) {
    if (this.destroyed) return undefined;
    // An IME-style lone char is `Input.insertText`: CDP's `char` key event is ignored by most
    // editors, `insertText` is what Chrome's own IME commit uses.
    if (params.type === "char") {
      return this.sendInput("Input.insertText", { text: params.text }).catch(() => {});
    }
    return this.sendInput("Input.dispatchKeyEvent", params).catch(() => {});
  }

  insertText(text) {
    return this.sendInput("Input.insertText", { text: String(text) }).catch(() => {});
  }

  focus() {
    void this.connection.send("Target.activateTarget", { targetId: this.targetId }).catch(() => {});
    void this.session.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  }

  // Edit commands. Electron runs these on the focused frame; `document.execCommand` in the
  // focused frame's main world is the same operation and works in every frame CDP can reach.
  // Copy and cut go through the engine so the clipboard is the system one, as in Electron.
  editCommand(name) {
    const frame = this.focusedFrame;
    if (!frame) return;
    void frame.executeJavaScript(`document.execCommand(${JSON.stringify(name)})`, true).catch(() => {});
  }

  undo() { this.editCommand("undo"); }
  redo() { this.editCommand("redo"); }
  selectAll() { this.dispatchKeyCommand("selectAll", "a"); }
  cut() { void this.engine.copySelection(this, true); }
  copy() { void this.engine.copySelection(this, false); }
  paste() { void this.engine.pasteClipboard(this, false); }
  pasteAndMatchStyle() { void this.engine.pasteClipboard(this, true); }

  dispatchKeyCommand(command, key) {
    void this.sendInput("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key, code: `Key${key.toUpperCase()}`, modifiers: 4,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), commands: [command],
    }).then(() => this.sendInput("Input.dispatchKeyEvent", {
      type: "keyUp", key, code: `Key${key.toUpperCase()}`, modifiers: 4,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    })).catch(() => {});
  }

  copyImageAt(x, y) { void this.engine.copyImageAt(this, x, y); }

  // --- find ------------------------------------------------------------------------------

  // Chrome has no find-in-page over CDP. `window.find` in the main world is the same matcher
  // the find bar uses, minus the match count, so the count is computed separately over the
  // document text. `found-in-page` gets the same fields Electron's does.
  findInPage(text, options = {}) {
    const requestId = (this.findRequestId = (this.findRequestId || 0) + 1);
    const query = String(text);
    const forward = options.forward !== false;
    const matchCase = Boolean(options.matchCase);
    const script = `(() => {
      const query = ${JSON.stringify(query)};
      const matchCase = ${matchCase};
      const forward = ${forward};
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
    void this.evaluateIn(this.session.id, this.mainFrame?.mainContextId, script).then((result) => {
      this.emit("found-in-page", {}, { requestId, finalUpdate: true, ...result });
    }).catch(() => {
      this.emit("found-in-page", {}, { requestId, finalUpdate: true, matches: 0, activeMatchOrdinal: 0 });
    });
    return requestId;
  }

  stopFindInPage(action = "clearSelection") {
    if (action === "keepSelection") return;
    void this.evaluateIn(this.session.id, this.mainFrame?.mainContextId, "getSelection().removeAllRanges()").catch(() => {});
  }

  // --- audio -----------------------------------------------------------------------------

  // Audibility is read off the page: Chrome has no CDP event for it, and the audio-owner
  // protocol only needs "is something playing unmuted right now", which the media elements say.
  isCurrentlyAudible() { return this.audible; }

  setAudioMuted(muted) {
    this.audioMuted = Boolean(muted);
    const script = `dispatchEvent(new CustomEvent("tweb-mute", { detail: ${this.audioMuted} }))`;
    for (const frame of this.frames.values()) {
      if (frame.detached || frame.mainContextId === null) continue;
      void this.evaluateIn(frame.sessionId, frame.mainContextId, script).catch(() => {});
    }
  }

  isAudioMuted() { return this.audioMuted; }

  // --- emulation, UA, PDF ----------------------------------------------------------------

  getUserAgent() { return this.userAgentOverride || this.defaultUserAgent || ""; }

  setUserAgent(userAgent) {
    this.userAgentOverride = userAgent && userAgent !== this.defaultUserAgent ? userAgent : null;
    void this.session.send("Emulation.setUserAgentOverride", { userAgent: String(userAgent || this.defaultUserAgent || "") }).catch(() => {});
  }

  enableDeviceEmulation(parameters) {
    this.deviceEmulation = parameters;
    const view = parameters.viewSize || this.viewport;
    void this.session.send("Emulation.setDeviceMetricsOverride", {
      width: view.width, height: view.height,
      deviceScaleFactor: parameters.deviceScaleFactor || this.deviceScaleFactor,
      mobile: parameters.screenPosition === "mobile",
      screenWidth: parameters.screenSize?.width || view.width,
      screenHeight: parameters.screenSize?.height || view.height,
    }).then(() => this.session.send("Emulation.setTouchEmulationEnabled", {
      enabled: parameters.screenPosition === "mobile",
    })).catch(() => {});
    this.invalidate();
  }

  // The device override was sent directly, without touching `this.viewport`, so the pane's own
  // metrics have to be re-sent unconditionally: `relayout` would see an unchanged viewport and send
  // nothing, leaving the page at the emulated width (measured: 980 after a reset from iPhone 12).
  disableDeviceEmulation() {
    this.deviceEmulation = null;
    void this.session.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    this.engine.windowFor(this)?.relayout();
    void this.applyMetrics();
  }

  async printToPDF(options = {}) {
    const result = await this.session.send("Page.printToPDF", {
      printBackground: Boolean(options.printBackground ?? true),
      landscape: Boolean(options.landscape),
      preferCSSPageSize: true,
    });
    return Buffer.from(result.data, "base64");
  }

  downloadURL(url) {
    // Chrome's download manager decides by response headers, not by how the request was made,
    // so the url is fetched as a navigation-initiated download from the page itself.
    void this.evaluateIn(this.session.id, this.mainFrame?.mainContextId, `(() => {
      const a = document.createElement("a");
      a.href = ${JSON.stringify(String(url))};
      a.download = "";
      a.style.display = "none";
      document.documentElement.append(a);
      a.click();
      a.remove();
    })()`, true).catch(() => {});
  }

  executeJavaScript(code, userGesture = false) {
    return this.evaluateIn(this.session.id, this.mainFrame?.mainContextId, code, userGesture);
  }

  send(channel, ...args) {
    this.mainFrame?.send(channel, ...args);
  }

  print() {
    // Same as a page's own window.print(): the preload's handler owns what a print means here.
    void this.executeJavaScript("window.dispatchEvent(new CustomEvent('tweb-print-request'))").catch(() => {});
  }
}

function scaleMouse(event, zoom) {
  // `sendInputEvent` coordinates are window DIPs; CDP's are CSS pixels of the top frame.
  if (!zoom || zoom === 1) return event;
  return { ...event, x: event.x / zoom, y: event.y / zoom };
}

module.exports = {
  PendingSession,
  CdpDebugger,
  CdpFrame,
  CdpWebContents,
  setNativeImage,
};
