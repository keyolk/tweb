"use strict";

// The preload, delivered into Chrome pages.
//
// Electron runs `preload.cjs` in an isolated world with `require("electron")` handing it
// `ipcRenderer` and `webFrame`. Chrome has the isolated world — `Page.addScriptToEvaluateOnNewDocument`
// with a `worldName` — but nothing to require. So the preload's source is wrapped in a
// function whose `require` answers "electron" with a shim of exactly the surface it uses:
//
//   ipcRenderer.send / on / once   -> a Runtime binding out, `__twebReceive` in
//   webFrame.executeJavaScript     -> the same binding, asking the engine to evaluate in the
//                                     MAIN world of this frame
//
// The preload is the same file, byte for byte. That is the point: Electron and Chrome run one
// shortcut runtime, and nothing here can drift from it.

const fs = require("node:fs");
const path = require("node:path");

const WORLD_NAME = "tweb";
const BINDING_NAME = "__twebIpc";

// Installed in the isolated world before the preload body runs. `__twebReceive` is defined
// on that world's `window`, which the page cannot see — the page's own world has a different
// global object — so a page cannot forge a message into the preload or read one out.
function bridgePrelude() {
  return `
const __twebBinding = globalThis[${JSON.stringify(BINDING_NAME)}];
// The page's world cannot reach this binding: it is registered with an executionContextName,
// which scopes it to contexts of that world name only.
delete globalThis[${JSON.stringify(BINDING_NAME)}];
const __twebListeners = new Map();
let __twebEvalSerial = 0;
const __twebEvalPending = new Map();
const __twebPost = (message) => {
  try { __twebBinding(JSON.stringify(message)); } catch (error) { void error; }
};
const __twebIpcRenderer = {
  send(channel, ...args) { __twebPost({ kind: "ipc", channel, args }); },
  on(channel, listener) {
    const group = __twebListeners.get(channel) || [];
    group.push(listener);
    __twebListeners.set(channel, group);
    return this;
  },
  once(channel, listener) {
    const wrapper = (...args) => {
      this.removeListener(channel, wrapper);
      listener(...args);
    };
    return this.on(channel, wrapper);
  },
  removeListener(channel, listener) {
    const group = __twebListeners.get(channel) || [];
    __twebListeners.set(channel, group.filter((candidate) => candidate !== listener));
    return this;
  },
};
const __twebWebFrame = {
  executeJavaScript(code) {
    const id = ++__twebEvalSerial;
    __twebPost({ kind: "main-eval", id, code: String(code) });
    return new Promise((resolve, reject) => __twebEvalPending.set(id, { resolve, reject }));
  },
};
Object.defineProperty(globalThis, "__twebReceive", {
  configurable: false,
  value(channel, args) {
    if (channel === "\\u0000eval") {
      const pending = __twebEvalPending.get(args[0]);
      if (!pending) return;
      __twebEvalPending.delete(args[0]);
      if (args[1]) pending.reject(new Error(args[1])); else pending.resolve(args[2]);
      return;
    }
    for (const listener of [...(__twebListeners.get(channel) || [])]) {
      try { listener({ sender: null }, ...args); } catch (error) { console.error(error); }
    }
  },
});
const __twebRequire = (name) => {
  if (name === "electron") return { ipcRenderer: __twebIpcRenderer, webFrame: __twebWebFrame };
  throw new Error("module not found: " + name);
};
`;
}

let cachedSource = null;

/// The full script to inject, preload included. Read once per process: the preload sits beside
/// this file and does not change while an engine runs.
function preloadScript(preloadPath = path.join(__dirname, "..", "preload.cjs")) {
  if (cachedSource) return cachedSource;
  const body = fs.readFileSync(preloadPath, "utf8");
  // Guarded so a frame that somehow receives it twice (a re-attach after a crash) does not run
  // two shortcut runtimes fighting over every key.
  cachedSource = `(() => {
if (globalThis.__twebPreloadInstalled) return;
Object.defineProperty(globalThis, "__twebPreloadInstalled", { value: true });
${bridgePrelude()}
(function (require) {
${body}
})(__twebRequire);
})();
//# sourceURL=tweb-preload.cjs
`;
  return cachedSource;
}

module.exports = { BINDING_NAME, WORLD_NAME, preloadScript, bridgePrelude };
