"use strict";

// Which page engines this process runs, and the Electron-shaped modules main.cjs uses over them.
//
// main.cjs destructures `BrowserWindow`, `ipcMain` and `session` once at the top and uses them
// everywhere. A tab is an offscreen window; the float viewer is a real Electron window — a desktop
// window the user looks at, which only Electron can draw. So each of these is a facade:
//
//   new BrowserWindow(options)   offscreen options -> a tab on `options.twebEngine` (default: the
//                                pane's engine); anything else -> Electron
//   BrowserWindow.fromWebContents / getAllWindows   every engine's windows, merged
//   ipcMain.on                   registered on Electron and on every page engine, including one
//                                started later: the preload speaks to whichever hosts its frame
//   session.defaultSession       webRequest and downloads from every engine; the rest is Electron's
//
// One pane can hold tabs on several engines (engine.*_sites pinning, the engine badge). Electron
// is always there, because the process is Electron. Chrome (cdp/engine.cjs) and WebKit
// (webkit/engine.cjs) are started the first time a tab asks for them — `ensureEngine` — and not
// before: a pane that never leaves Electron launches neither. `TWEB_BROWSER` only picks the engine
// a tab gets when nothing else says.
//
// With only Electron tabs this hands Electron's own windows back and registers Electron's own
// listeners, so the default path is what it was.

const path = require("node:path");
const { CdpEngine } = require("./engine.cjs");
const { findChrome } = require("./connection.cjs");
const { setNativeImage } = require("./web-contents.cjs");
const { WebKitEngine } = require("../webkit/engine.cjs");
const { setNativeImage: setWebKitNativeImage } = require("../webkit/web-contents.cjs");
const { findHelper } = require("../webkit/helper.cjs");

const ENGINE_KINDS = ["electron", "chrome", "webkit"];

function backendFromEnv(env = process.env) {
  return engineKind(env.TWEB_BROWSER) || "electron";
}

/** An engine name as the user or the environment spells it, or null. */
function engineKind(value) {
  const name = String(value || "").trim().toLowerCase();
  if (name === "chrome" || name === "electron") return name;
  // `tauri` was the WebKit engine's name before it became a page host under this engine.
  if (name === "webkit" || name === "tauri") return "webkit";
  return null;
}

// The Chrome profile lives beside TWeb's own, never in the user's Chrome directory: Chrome 136+
// refuses remote debugging on its default profile, and sharing a profile with a running Chrome is
// a lock conflict. Machine policy still applies to it, which is what brings the managed
// extensions and the device trust along.
function chromeProfileDir(env, userData) {
  return env.TWEB_CHROME_PROFILE || path.join(userData, "chrome-profile");
}

function isTabWindowOptions(options) {
  return Boolean(options?.webPreferences?.offscreen);
}

/**
 * Whether a tab could be put on `kind` here, and why not. Checked before a switch is offered, so
 * the badge can grey out an engine with its reason instead of failing after the old tab is gone.
 */
function engineAvailability(kind, { env = process.env, platform = process.platform, exists, helper } = {}) {
  if (kind === "electron") return { ok: true };
  if (kind === "chrome") {
    return findChrome(env, exists) ? { ok: true } : { ok: false, reason: "Google Chrome not found (TWEB_CHROME)" };
  }
  if (kind === "webkit") {
    if (platform !== "darwin") return { ok: false, reason: "macOS only" };
    return (helper !== undefined ? helper : findHelper(env)) ? { ok: true } : { ok: false, reason: "tweb-webkit not installed" };
  }
  return { ok: false, reason: "unknown engine" };
}

function createBackend(electron, { env = process.env, debug = false, makeEngine = null } = {}) {
  const defaultKind = backendFromEnv(env);
  const ElectronWindow = electron.BrowserWindow;
  setNativeImage(electron.nativeImage);
  setWebKitNativeImage(electron.nativeImage);

  // The profile path is resolved at start(), not here: this module loads before main.cjs has
  // applied TWEB_USER_DATA_DIR, and reading userData now would pin Chrome to the default profile
  // whatever the environment asked for.
  const newEngine = makeEngine || ((kind) => (kind === "webkit"
    ? new WebKitEngine({ nativeImage: electron.nativeImage, clipboard: electron.clipboard, debug })
    : new CdpEngine({
      userDataDir: () => chromeProfileDir(env, electron.app.getPath("userData")),
      nativeImage: electron.nativeImage,
      clipboard: electron.clipboard,
      debug,
    })));

  const engines = new Map(); // kind -> engine, started
  const starting = new Map(); // kind -> promise of the started engine
  let stopping = false;
  const windowKinds = new WeakMap();
  let startOptions = {};

  // Listeners main.cjs registered, applied to Electron now and to each engine as it starts.
  const ipcListeners = [];
  const webRequestListeners = { onBeforeRequest: null, onCompleted: null, onErrorOccurred: null };
  const downloadListeners = [];

  function wireEngine(engine) {
    for (const { channel, listener } of ipcListeners) engine.ipcMain.on(channel, listener);
    const engineSession = engine.session();
    for (const [method, listener] of Object.entries(webRequestListeners)) {
      if (listener && typeof engineSession.webRequest[method] === "function") engineSession.webRequest[method](listener);
    }
    for (const listener of downloadListeners) engineSession.on("will-download", listener);
  }

  /** The started engine for `kind`, starting it on first use. Electron needs no start. */
  function ensureEngine(kind) {
    if (kind === "electron") return Promise.resolve(null);
    if (stopping) return Promise.reject(new Error("the page backend is stopping"));
    if (engines.has(kind)) return Promise.resolve(engines.get(kind));
    if (!starting.has(kind)) {
      const engine = newEngine(kind);
      const started = Promise.resolve(engine.start(startOptions)).then(async () => {
        // Quit can begin while Chrome or tweb-webkit is launching. Do not let a late child escape
        // the stop set and survive the pane that owned it.
        if (stopping) {
          await engine.stop();
          throw new Error("the page backend stopped while the engine was starting");
        }
        engines.set(kind, engine);
        wireEngine(engine);
        return engine;
      }).catch((error) => {
        // Not cached: the next tab that asks tries again (Chrome closed mid-launch, say).
        starting.delete(kind);
        throw error;
      });
      starting.set(kind, started);
    }
    return starting.get(kind);
  }

  // A function, not a class: `new BrowserWindow(...)` returns whichever object the constructor
  // returns, so the facade can hand back an Electron window or an engine's from the same call.
  function BrowserWindow(options) {
    if (!isTabWindowOptions(options)) return new ElectronWindow(options);
    const kind = engineKind(options.twebEngine) || defaultKind;
    if (kind === "electron") {
      const window = new ElectronWindow(options);
      windowKinds.set(window, "electron");
      return window;
    }
    const engine = engines.get(kind);
    if (!engine) throw new Error(`the ${kind} engine is not started (ensureEngine first)`);
    const window = engine.createWindow(options);
    windowKinds.set(window, kind);
    electron.app.emit("browser-window-created", {}, window);
    return window;
  }
  BrowserWindow.fromWebContents = (contents) => {
    for (const engine of engines.values()) {
      const window = engine.fromWebContents(contents);
      if (window) return window;
    }
    return ElectronWindow.fromWebContents(contents);
  };
  BrowserWindow.getAllWindows = () => [
    ...[...engines.values()].flatMap((engine) => engine.getAllWindows()),
    ...ElectronWindow.getAllWindows(),
  ];
  BrowserWindow.getFocusedWindow = () => ElectronWindow.getFocusedWindow();

  const ipcMain = {
    on(channel, listener) {
      ipcListeners.push({ channel, listener });
      electron.ipcMain.on(channel, listener);
      for (const engine of engines.values()) engine.ipcMain.on(channel, listener);
      return this;
    },
    once(channel, listener) {
      electron.ipcMain.once(channel, listener);
      for (const engine of engines.values()) engine.ipcMain.once(channel, listener);
      return this;
    },
    removeListener(channel, listener) {
      const index = ipcListeners.findIndex((entry) => entry.channel === channel && entry.listener === listener);
      if (index >= 0) ipcListeners.splice(index, 1);
      electron.ipcMain.removeListener(channel, listener);
      for (const engine of engines.values()) engine.ipcMain.removeListener(channel, listener);
      return this;
    },
    handle: (...args) => electron.ipcMain.handle(...args),
  };

  let defaultSession = null;
  const session = {
    get defaultSession() {
      if (defaultSession) return defaultSession;
      const real = electron.session.defaultSession;
      // `webRequest` keeps one listener per event per session; each engine is a session of its
      // own, so a listener is stored and given to every engine, the late ones included.
      const webRequest = {};
      for (const method of Object.keys(webRequestListeners)) {
        webRequest[method] = (listener) => {
          webRequestListeners[method] = listener;
          if (typeof real.webRequest?.[method] === "function") real.webRequest[method](listener);
          for (const engine of engines.values()) {
            const engineRequests = engine.session().webRequest;
            if (typeof engineRequests[method] === "function") engineRequests[method](listener);
          }
        };
      }
      defaultSession = new Proxy(real, {
        get(target, property) {
          if (property === "webRequest") return webRequest;
          if (property === "on") {
            return (event, listener) => {
              if (event === "will-download") {
                downloadListeners.push(listener);
                for (const engine of engines.values()) engine.session().on(event, listener);
              }
              target.on(event, listener);
              return defaultSession;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return defaultSession;
    },
    fromPartition: (...args) => electron.session.fromPartition(...args),
  };

  /** The engine a tab window runs on. */
  // A popup an engine made for an opener never came through the constructor above, so the
  // engines are asked too.
  function kindOf(window) {
    const known = windowKinds.get(window);
    if (known) return known;
    for (const [kind, engine] of engines) {
      if (engine.getAllWindows().includes(window)) {
        windowKinds.set(window, kind);
        return kind;
      }
    }
    return "electron";
  }

  /** Whether `contents`' engine can see its page's requests (WebKit cannot). */
  function observesRequests(window) {
    const kind = kindOf(window);
    if (kind === "electron") return true;
    return engines.get(kind)?.session().webRequest.observesRequests !== false;
  }

  return {
    kind: defaultKind,
    BrowserWindow,
    ipcMain,
    session,
    /** The default engine, once started (null for Electron), for code that predates per-tab engines. */
    get engine() { return engines.get(defaultKind) || null; },
    engineFor: (kind) => engines.get(kind) || null,
    startedKinds: () => ["electron", ...engines.keys()],
    kindOf,
    observesRequests,
    ensureEngine,
    availability: (kind) => engineAvailability(kind, { env }),
    // The pane's engine before its first tab; the others start on demand with the same options.
    start: (options = {}) => {
      startOptions = options;
      return defaultKind === "electron" ? Promise.resolve() : ensureEngine(defaultKind);
    },
    async stopAll() {
      stopping = true;
      // A start already in flight either registers before this reads `engines`, or sees `stopping`
      // and stops its own child. Either way no engine can escape the quit.
      await Promise.allSettled([...starting.values()]);
      const stops = [...engines.entries()].map(([kind, engine]) => Promise.resolve(engine.stop())
        .catch((error) => console.error(`tweb: ${kind} engine stop failed: ${error.message}`)));
      engines.clear();
      starting.clear();
      await Promise.all(stops);
    },
  };
}

module.exports = {
  ENGINE_KINDS, backendFromEnv, chromeProfileDir, createBackend, engineAvailability, engineKind, isTabWindowOptions,
};
