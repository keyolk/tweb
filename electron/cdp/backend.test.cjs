"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { backendFromEnv, chromeProfileDir, isTabWindowOptions } = require("./backend.cjs");
const { chromeArgs, devtoolsOriginAllowed, devtoolsUrl, findChrome, freePort, readActivePort } = require("./connection.cjs");

test("only TWEB_BROWSER=chrome selects the Chrome backend", () => {
  assert.strictEqual(backendFromEnv({}), "electron");
  assert.strictEqual(backendFromEnv({ TWEB_BROWSER: "chrome" }), "chrome");
  assert.strictEqual(backendFromEnv({ TWEB_BROWSER: " Chrome " }), "chrome");
  assert.strictEqual(backendFromEnv({ TWEB_BROWSER: "tauri" }), "electron");
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
