"use strict";

// Chrome is forced to the scale a tab at the default zoom is emulated at. Forced to the pane's
// scale alone (2) under an emulated 1.6, Chrome read mouse coordinates at one scale or the other
// from one event to the next, and a third of clicks landed at 1.25x the point.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");

test("the engine launches Chrome at the pane's scale times the default zoom", () => {
  const main = read("../main.cjs");
  assert.match(main, /browserScaleFactor: renderScaleFactor\(\) \* defaultZoomFactor\(\)/);
  const engine = read("engine.cjs");
  assert.match(engine, /const launch = browserScaleFactor \|\| scaleFactor;/);
  assert.match(engine, /scaleFactor: launch,/);
  assert.match(engine, /this\.browserScale = launched \|\| this\.scaleFactor;/);
});

test("a reused Chrome reports the scale it was launched with", () => {
  const connection = read("connection.cjs");
  assert.match(connection, /if \(existing\) return \{ version: existing, launched: null, scaleFactor: readLaunchedScale\(userDataDir\) \};/);
  assert.match(connection, /fs\.writeFileSync\(path\.join\(userDataDir, SCALE_FILE\)/);
});

test("the skew correction and screencast checks use Chrome's actual scale", () => {
  const contents = read("web-contents.cjs");
  assert.match(contents, /const real = this\.engine\.browserScale \|\| this\.engine\.scaleFactor \|\| 1;/);
  assert.match(contents, /isViewportFrame\(got, this\.viewport, this\.deviceScaleFactor, this\.engine\.browserScale/);
  assert.match(contents, /windowArea\(got, this\.engine\.browserScale/);
});
