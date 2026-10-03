"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { backendFromEnv, chromeProfileDir, isTabWindowOptions } = require("./backend.cjs");
const { chromeArgs, findChrome } = require("./connection.cjs");

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

test("TWEB_CHROME wins over the installed candidates", () => {
  assert.strictEqual(findChrome({ TWEB_CHROME: "/opt/chrome" }, () => false), "/opt/chrome");
  assert.strictEqual(findChrome({}, () => false), null);
  assert.match(findChrome({}, (candidate) => candidate.includes("Google Chrome.app")), /Google Chrome\.app/);
});
