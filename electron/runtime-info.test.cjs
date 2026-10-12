"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { appBuild, chromeVersion, engineLabel, runtimeInfoRows } = require("./runtime-info.cjs");

test("an installed build is named by its app hash, a checkout by its path", () => {
  assert.equal(appBuild("/Users/x/.cache/tweb/app-0123456789abcdef"), "installed 01234567");
  assert.equal(appBuild("/Users/x/src/tweb/electron"), "dev /Users/x/src/tweb/electron");
});

test("the Chrome version comes from /json/version, headless or not", () => {
  assert.equal(chromeVersion({ Browser: "Chrome/141.0.7390.54" }), "141.0.7390.54");
  assert.equal(chromeVersion({ Browser: "HeadlessChrome/141.0.1" }), "141.0.1");
  assert.equal(chromeVersion(undefined), null);
});

test("the engine row says which engine serves the pane", () => {
  assert.equal(engineLabel({ backend: "chrome", chromeInfo: { Browser: "Chrome/141.0" } }), "Chrome 141.0 (CDP)");
  assert.equal(engineLabel({ backend: "chrome" }), "Chrome (CDP)");
  assert.equal(engineLabel({ backend: "electron", electronVersion: "43.2.0", chromiumVersion: "140.0" }),
    "Electron 43.2.0 · Chromium 140.0");
});

test("rows are label/value pairs in a fixed order", () => {
  const rows = runtimeInfoRows({
    version: "0.1.0",
    appDir: "/c/tweb/app-abcdef0123",
    backend: "electron",
    electronVersion: "43.2.0",
    chromiumVersion: "140.0",
    pane: "%12",
    pid: 42,
    hosted: false,
    frames: { adaptive: true, idle: 4, max: 30, rate: 4, size: { width: 2880, height: 1800 } },
    mode: "shortcuts",
  });
  assert.deepEqual(rows.map(([label]) => label), ["tweb", "engine", "pane", "frames", "input"]);
  assert.equal(rows[0][1], "0.1.0 · installed abcdef01");
  assert.equal(rows[2][1], "%12 · pid 42 · own process");
  assert.equal(rows[3][1], "adaptive 4–30fps (now 4) · 2880x1800");
});

test("a fixed frame rate and a hosted pane read as such", () => {
  const rows = runtimeInfoRows({ backend: "electron", pid: 7, hosted: true, frames: { adaptive: false, max: 30 } });
  assert.equal(rows.find(([label]) => label === "pane")[1], "twebd · pid 7 · hosted by twebd");
  assert.equal(rows.find(([label]) => label === "frames")[1], "fixed 30fps");
});
