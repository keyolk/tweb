"use strict";

// Which page engine this process runs, and the Electron-shaped modules that choice implies.
//
// main.cjs destructures `BrowserWindow`, `ipcMain` and `session` from Electron once at the top
// and uses them everywhere. With the Chrome backend, a TAB window is a CDP target, while the
// float viewer is still a real Electron window — it is a desktop window the user looks at, which
// only Electron can draw. So each of these becomes a facade that routes by kind:
//
//   new BrowserWindow(options)   offscreen options -> a Chrome tab; anything else -> Electron
//   BrowserWindow.fromWebContents / getAllWindows   both populations, merged
//   ipcMain.on                   registered on both: the preload speaks CDP, the viewer Electron
//   session.defaultSession       webRequest and downloads from Chrome; the rest stays Electron's
//
// `TWEB_BROWSER=webkit` is the same facade over WKWebViews in the tweb-webkit host
// (webkit/engine.cjs): the engines differ in how a tab is hosted, not in what main.cjs sees.
//
// With the Electron backend (the default) this returns Electron's own objects untouched, so the
// shipping path is byte-for-byte what it was.

const path = require("node:path");
const { CdpEngine } = require("./engine.cjs");
const { setNativeImage } = require("./web-contents.cjs");
const { WebKitEngine } = require("../webkit/engine.cjs");
const { setNativeImage: setWebKitNativeImage } = require("../webkit/web-contents.cjs");

function backendFromEnv(env = process.env) {
  const value = String(env.TWEB_BROWSER || "").trim().toLowerCase();
  if (value === "chrome") return "chrome";
  // `tauri` was the WebKit engine's name before it became a page host under this engine.
  if (value === "webkit" || value === "tauri") return "webkit";
  return "electron";
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

function createBackend(electron, { env = process.env, debug = false } = {}) {
  const backend = backendFromEnv(env);
  if (backend === "electron") {
    return {
      kind: "electron",
      BrowserWindow: electron.BrowserWindow,
      ipcMain: electron.ipcMain,
      session: electron.session,
      start: async () => {},
      engine: null,
    };
  }

  // The profile path is resolved at start(), not here: this module loads before main.cjs has
  // applied TWEB_USER_DATA_DIR, and reading userData now would pin Chrome to the default profile
  // whatever the environment asked for.
  const engine = backend === "webkit"
    ? new WebKitEngine({ nativeImage: electron.nativeImage, clipboard: electron.clipboard, debug })
    : new CdpEngine({
      userDataDir: () => chromeProfileDir(env, electron.app.getPath("userData")),
      nativeImage: electron.nativeImage,
      clipboard: electron.clipboard,
      debug,
    });
  setNativeImage(electron.nativeImage);
  setWebKitNativeImage(electron.nativeImage);
  const ElectronWindow = electron.BrowserWindow;

  // A function, not a class: `new BrowserWindow(...)` returns whichever object the constructor
  // returns, so the facade can hand back an Electron window or a CDP one from the same call.
  function BrowserWindow(options) {
    if (isTabWindowOptions(options)) {
      const window = engine.createWindow(options);
      electron.app.emit("browser-window-created", {}, window);
      return window;
    }
    return new ElectronWindow(options);
  }
  BrowserWindow.fromWebContents = (contents) => engine.fromWebContents(contents)
    || ElectronWindow.fromWebContents(contents);
  BrowserWindow.getAllWindows = () => [...engine.getAllWindows(), ...ElectronWindow.getAllWindows()];
  BrowserWindow.getFocusedWindow = () => ElectronWindow.getFocusedWindow();

  const ipcMain = {
    on(channel, listener) {
      electron.ipcMain.on(channel, listener);
      engine.ipcMain.on(channel, listener);
      return this;
    },
    once(channel, listener) {
      electron.ipcMain.once(channel, listener);
      engine.ipcMain.once(channel, listener);
      return this;
    },
    removeListener(channel, listener) {
      electron.ipcMain.removeListener(channel, listener);
      engine.ipcMain.removeListener(channel, listener);
      return this;
    },
    handle: (...args) => electron.ipcMain.handle(...args),
  };

  let defaultSession = null;
  const session = {
    get defaultSession() {
      if (!defaultSession) {
        // Requests and downloads are the page engine's; everything else stays Electron's.
        const chrome = engine.session();
        const real = electron.session.defaultSession;
        defaultSession = {
          webRequest: chrome.webRequest,
          on: (event, listener) => {
            if (event === "will-download") chrome.on(event, listener);
            else real.on(event, listener);
            return defaultSession;
          },
          extensions: chrome.extensions,
          serviceWorkers: chrome.serviceWorkers,
          clearCache: () => real.clearCache(),
        };
      }
      return defaultSession;
    },
    fromPartition: (...args) => electron.session.fromPartition(...args),
  };

  return {
    kind: backend,
    BrowserWindow,
    ipcMain,
    session,
    engine,
    start: (options) => engine.start(options),
  };
}

module.exports = { backendFromEnv, chromeProfileDir, createBackend, isTabWindowOptions };
