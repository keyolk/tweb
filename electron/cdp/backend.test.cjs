"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { backendFromEnv, chromeProfileDir, isTabWindowOptions } = require("./backend.cjs");
const { chromeArgs, devtoolsOriginAllowed, devtoolsUrl, findChrome, freePort, readActivePort } = require("./connection.cjs");

test("TWEB_BROWSER selects the Chrome or WebKit backend, and nothing else does", () => {
  assert.strictEqual(backendFromEnv({}), "electron");
  assert.strictEqual(backendFromEnv({ TWEB_BROWSER: "chrome" }), "chrome");
  assert.strictEqual(backendFromEnv({ TWEB_BROWSER: " Chrome " }), "chrome");
  assert.strictEqual(backendFromEnv({ TWEB_BROWSER: "webkit" }), "webkit");
  // The WebKit engine's old name still reaches it.
  assert.strictEqual(backendFromEnv({ TWEB_BROWSER: "tauri" }), "webkit");
  assert.strictEqual(backendFromEnv({ TWEB_BROWSER: "safari" }), "electron");
});

// Tabs are offscreen windows; the float viewer is a real one and must stay Electron's.
test("only offscreen window options become Chrome tabs", () => {
  assert.strictEqual(isTabWindowOptions({ webPreferences: { offscreen: { deviceScaleFactor: 2 } } }), true);
  assert.strictEqual(isTabWindowOptions({ webPreferences: { preload: "/x/float-preload.cjs" } }), false);
  assert.strictEqual(isTabWindowOptions(undefined), false);
});

test("the Chrome profile lives beside TWeb's own unless overridden", () => {
  assert.strictEqual(chromeProfileDir({}, "/data/tweb"), "/data/tweb/chrome-profile");
  assert.strictEqual(chromeProfileDir({ TWEB_CHROME_PROFILE: "/p" }, "/data/tweb"), "/p");
});

test("Chrome is launched headless on its own profile with a picked port", () => {
  const args = chromeArgs("/p", {});
  assert.ok(args.includes("--user-data-dir=/p"));
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.ok(args.includes("--headless=new"));
  const headed = chromeArgs("/p", { TWEB_CHROME_HEADED: "1" });
  assert.ok(!headed.includes("--headless=new"));
});

// YouTube stops playback about a minute in when `navigator.webdriver` is set, which the debugging
// port alone does. Both launch modes need it off.
test("Chrome is launched without the webdriver flag the debugging port would set", () => {
  for (const env of [{}, { TWEB_CHROME_HEADED: "1" }]) {
    assert.ok(chromeArgs("/p", env).includes("--disable-blink-features=AutomationControlled"));
  }
});

test("TWEB_CHROME wins over the installed candidates", () => {
  assert.strictEqual(findChrome({ TWEB_CHROME: "/opt/chrome" }, () => false), "/opt/chrome");
  assert.strictEqual(findChrome({}, () => false), null);
  assert.match(findChrome({}, (candidate) => candidate.includes("Google Chrome.app")), /Google Chrome\.app/);
});

// `tweb devtools`: Chrome refuses a DevTools WebSocket carrying an Origin it was not told to
// allow, and the DevTools page it serves sends `http://127.0.0.1:<port>`. A picked port is allowed
// exactly; port 0 (Chrome's own pick) cannot be, and never `*`.
test("a picked debugging port is the one origin allowed to open DevTools", () => {
  const picked = chromeArgs("/p", {}, 54321);
  assert.ok(picked.includes("--remote-debugging-port=54321"));
  assert.ok(picked.includes("--remote-allow-origins=http://127.0.0.1:54321"));
  const own = chromeArgs("/p", {}, 0);
  assert.ok(own.includes("--remote-debugging-port=0"));
  assert.ok(!own.some((arg) => arg.startsWith("--remote-allow-origins")));
  assert.ok(![...picked, ...own].includes("--remote-allow-origins=*"));
});

test("the DevTools URL points the page at its own Chrome, and only when allowed", () => {
  assert.strictEqual(devtoolsUrl(9222, "ABC", true),
    "http://127.0.0.1:9222/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/ABC");
  assert.strictEqual(devtoolsUrl(9222, "ABC", false), null);
  assert.strictEqual(devtoolsUrl(0, "ABC", true), null);
});

// Chrome writes DevToolsActivePort only for a port it picked itself, so a Chrome on tweb's port
// is found through tweb's own file.
test("the shared Chrome is found by Chrome's port file or by tweb's", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tweb-port-"));
  try {
    assert.strictEqual(readActivePort(dir), null);
    fs.writeFileSync(path.join(dir, "TwebDevToolsPort"), "41234\n");
    assert.deepStrictEqual(readActivePort(dir), { port: 41234, wsPath: "" });
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "51234\n/devtools/browser/x\n");
    assert.deepStrictEqual(readActivePort(dir), { port: 51234, wsPath: "/devtools/browser/x" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the origin probe answers false where no Chrome is listening", async () => {
  const port = await freePort();
  assert.strictEqual(await devtoolsOriginAllowed(port, `ws://127.0.0.1:${port}/devtools/browser/x`), false);
  assert.strictEqual(await devtoolsOriginAllowed(0, null), false);
});

// Out-of-process iframes took the headless window's 1x while the tab was emulated at 1.6, so text
// in them was upscaled and soft. The pane's scale is forced on the whole browser.
test("Chrome is launched at the pane's device scale factor when one is given", () => {
  assert.ok(chromeArgs("/p", {}, 0, 2).includes("--force-device-scale-factor=2"));
  assert.ok(!chromeArgs("/p", {}, 0, 0).some((arg) => arg.startsWith("--force-device-scale-factor")));
});

// --- one pane, several engines ---------------------------------------------------------------

const { EventEmitter } = require("node:events");
const { createBackend, engineAvailability, engineKind } = require("./backend.cjs");

function fakeElectron() {
  class FakeElectronWindow {
    constructor(options) { this.options = options; FakeElectronWindow.all.push(this); }
    static fromWebContents(contents) { return FakeElectronWindow.all.find((w) => w.webContents === contents) || null; }
    static getAllWindows() { return [...FakeElectronWindow.all]; }
    static getFocusedWindow() { return null; }
  }
  FakeElectronWindow.all = [];
  const realSession = {
    listeners: {}, downloads: [], cleared: 0,
    webRequest: {
      onBeforeRequest(l) { realSession.listeners.before = l; },
      onCompleted(l) { realSession.listeners.completed = l; },
      onErrorOccurred(l) { realSession.listeners.error = l; },
    },
    on(event, l) { if (event === "will-download") realSession.downloads.push(l); return this; },
    clearCache() { this.cleared += 1; },
  };
  return {
    BrowserWindow: FakeElectronWindow,
    ipcMain: new EventEmitter(),
    session: { defaultSession: realSession, fromPartition: () => null },
    app: new EventEmitter(),
    nativeImage: {},
    clipboard: {},
    realSession,
  };
}

function fakeEngine(kind, { fail = false } = {}) {
  const engine = Object.assign(new EventEmitter(), {
    kind, started: 0, stopped: 0, windows: [], ipcMain: new EventEmitter(),
    listeners: {}, downloads: [],
    async start(options) { engine.started += 1; engine.startOptions = options; if (fail) throw new Error("no chrome"); },
    async stop() { engine.stopped += 1; },
    createWindow(options) { const w = { kind, options, engine, webContents: { id: 1000 + engine.windows.length } }; engine.windows.push(w); return w; },
    whenReady(window) { return engine.ready?.get(window) || Promise.resolve(); },
    fromWebContents(contents) { return engine.windows.find((w) => w.webContents === contents) || null; },
    getAllWindows() { return engine.windows; },
    session() {
      return {
        webRequest: {
          observesRequests: kind !== "webkit",
          onBeforeRequest(l) { engine.listeners.before = l; },
          onCompleted(l) { engine.listeners.completed = l; },
          onErrorOccurred(l) { engine.listeners.error = l; },
        },
        on(event, l) { if (event === "will-download") engine.downloads.push(l); return this; },
      };
    },
  });
  return engine;
}

const tab = (engine) => ({ webPreferences: { offscreen: true }, ...(engine ? { twebEngine: engine } : {}) });

test("engine names: tauri is WebKit, anything unknown is nothing", () => {
  assert.strictEqual(engineKind(" Chrome "), "chrome");
  assert.strictEqual(engineKind("tauri"), "webkit");
  assert.strictEqual(engineKind("safari"), null);
});

test("an Electron pane starts no page engine until a tab asks for one", async () => {
  const electron = fakeElectron();
  const made = [];
  const backend = createBackend(electron, { env: {}, makeEngine: (kind) => { const e = fakeEngine(kind); made.push(e); return e; } });
  await backend.start({ scaleFactor: 2 });
  const first = new backend.BrowserWindow(tab());
  assert.strictEqual(backend.kindOf(first), "electron");
  assert.strictEqual(made.length, 0);
  assert.throws(() => new backend.BrowserWindow(tab("chrome")), /not started/);

  const chrome = await backend.ensureEngine("chrome");
  assert.strictEqual(chrome.startOptions.scaleFactor, 2, "a late engine starts with the pane's options");
  await backend.ensureEngine("chrome");
  assert.strictEqual(chrome.started, 1, "started once");
  const second = new backend.BrowserWindow(tab("chrome"));
  assert.strictEqual(backend.kindOf(second), "chrome");
  assert.strictEqual(backend.BrowserWindow.fromWebContents(second.webContents), second);
  assert.deepStrictEqual(backend.startedKinds(), ["electron", "chrome"]);
  // A popup Chrome made for an opener is Chrome's, though it never came through the facade.
  const popup = chrome.createWindow({});
  assert.strictEqual(backend.kindOf(popup), "chrome");
  // The float viewer and any non-tab window stays Electron's.
  assert.ok(new backend.BrowserWindow({ webPreferences: {} }) instanceof electron.BrowserWindow);
});

test("listeners registered before an engine starts reach it when it does", async () => {
  const electron = fakeElectron();
  const webkit = fakeEngine("webkit");
  const backend = createBackend(electron, { env: {}, makeEngine: () => webkit });
  const seen = [];
  backend.ipcMain.on("tweb-shortcut", (_e, v) => seen.push(v));
  const before = () => {};
  backend.session.defaultSession.webRequest.onBeforeRequest(before);
  const download = () => {};
  backend.session.defaultSession.on("will-download", download);

  assert.strictEqual(electron.realSession.listeners.before, before, "Electron gets it at once");
  await backend.ensureEngine("webkit");
  webkit.ipcMain.emit("tweb-shortcut", {}, "from-webkit");
  electron.ipcMain.emit("tweb-shortcut", {}, "from-electron");
  assert.deepStrictEqual(seen, ["from-webkit", "from-electron"]);
  assert.strictEqual(webkit.listeners.before, before);
  assert.deepStrictEqual(webkit.downloads, [download]);
  const page = new backend.BrowserWindow(tab("webkit"));
  assert.strictEqual(backend.observesRequests(page), false, "WebKit cannot see requests");
  // Everything else on the session is Electron's own.
  backend.session.defaultSession.clearCache();
  assert.strictEqual(electron.realSession.cleared, 1);
});

test("an engine that fails to start is tried again next time, and stopAll stops what started", async () => {
  const electron = fakeElectron();
  let attempts = 0;
  const backend = createBackend(electron, {
    env: {}, makeEngine: (kind) => fakeEngine(kind, { fail: ++attempts === 1 }),
  });
  await assert.rejects(backend.ensureEngine("chrome"), /no chrome/);
  const chrome = await backend.ensureEngine("chrome");
  assert.strictEqual(attempts, 2);
  await backend.stopAll();
  assert.strictEqual(chrome.stopped, 1);
  assert.deepStrictEqual(backend.startedKinds(), ["electron"]);
});

test("a Chrome pane's tabs default to Chrome, and its engine starts with the pane", async () => {
  const electron = fakeElectron();
  const chrome = fakeEngine("chrome");
  const backend = createBackend(electron, { env: { TWEB_BROWSER: "chrome" }, makeEngine: () => chrome });
  await backend.start({ scaleFactor: 1 });
  assert.strictEqual(chrome.started, 1);
  assert.strictEqual(backend.engine, chrome);
  assert.strictEqual(backend.kindOf(new backend.BrowserWindow(tab())), "chrome");
  assert.strictEqual(backend.kindOf(new backend.BrowserWindow(tab("electron"))), "electron");
});

test("an engine that cannot run here says why", () => {
  assert.deepStrictEqual(engineAvailability("electron"), { ok: true });
  assert.strictEqual(engineAvailability("webkit", { platform: "linux" }).reason, "macOS only");
  assert.deepStrictEqual(engineAvailability("webkit", { platform: "darwin", helper: null }),
    { ok: false, reason: "tweb-webkit not installed" });
  assert.strictEqual(engineAvailability("webkit", { platform: "darwin", helper: "/bin/tweb-webkit" }).ok, true);
  assert.strictEqual(engineAvailability("chrome", { env: {}, exists: () => false }).ok, false);
  assert.strictEqual(engineAvailability("chrome", { env: { TWEB_CHROME: "/c" } }).ok, true);
});

test("an engine whose start finishes during quit is stopped and never registered", async () => {
  const electron = fakeElectron();
  let release;
  const engine = fakeEngine("chrome");
  engine.start = () => new Promise((resolve) => { release = resolve; });
  const backend = createBackend(electron, { env: {}, makeEngine: () => engine });
  const start = backend.ensureEngine("chrome");
  const stop = backend.stopAll();
  release();
  await assert.rejects(start, /stopped while the engine was starting/);
  await stop;
  assert.strictEqual(engine.stopped, 1);
  assert.deepStrictEqual(backend.startedKinds(), ["electron"]);
  await assert.rejects(backend.ensureEngine("webkit"), /backend is stopping/);
});

// Measured: Chrome alive, its CDP socket closed, and every later tab failed with "CDP connection
// closed" because the dead engine stayed registered. A lost engine is forgotten and restarted.
test("an engine whose link dies is forgotten, reported, and started fresh on next use", async () => {
  const electron = fakeElectron();
  const made = [];
  const backend = createBackend(electron, { env: {}, makeEngine: (kind) => { const e = fakeEngine(kind); made.push(e); return e; } });
  const lost = [];
  backend.onEngineLost((kind) => lost.push(kind));
  const first = await backend.ensureEngine("chrome");
  const page = new backend.BrowserWindow(tab("chrome"));
  first.emit("disconnected");
  assert.deepStrictEqual(lost, ["chrome"]);
  assert.deepStrictEqual(backend.startedKinds(), ["electron"]);
  assert.strictEqual(backend.kindOf(page), "chrome", "the dead tab still names its engine, so main.cjs can rebuild it");
  const second = await backend.ensureEngine("chrome");
  assert.notStrictEqual(second, first);
  assert.strictEqual(made.length, 2);
  // A late event from the old engine does not drop the new one.
  first.emit("disconnected");
  assert.deepStrictEqual(backend.startedKinds(), ["electron", "chrome"]);
  assert.deepStrictEqual(lost, ["chrome"]);
});

test("an engine stopped at quit is not reported lost", async () => {
  const electron = fakeElectron();
  const chrome = fakeEngine("chrome");
  chrome.stop = async () => { chrome.emit("disconnected"); };
  const backend = createBackend(electron, { env: {}, makeEngine: () => chrome });
  const lost = [];
  backend.onEngineLost((kind) => lost.push(kind));
  await backend.ensureEngine("chrome");
  await backend.stopAll();
  assert.deepStrictEqual(lost, []);
});

// The engine move waits on this before closing the old tab.
test("whenReady follows the tab's own engine, and Electron's tab is ready at once", async () => {
  const electron = fakeElectron();
  const chrome = fakeEngine("chrome");
  chrome.ready = new WeakMap();
  const backend = createBackend(electron, { env: {}, makeEngine: () => chrome });
  await backend.whenReady(new backend.BrowserWindow(tab()));
  await backend.ensureEngine("chrome");
  const page = new backend.BrowserWindow(tab("chrome"));
  chrome.ready.set(page, Promise.reject(new Error("Target.createTarget: CDP connection closed")));
  await assert.rejects(backend.whenReady(page), /CDP connection closed/);
});
