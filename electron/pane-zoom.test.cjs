"use strict";

// Zoom is one value per pane. Tabs that each kept their own came back at a different size on
// every J/K, and a new tab opened at the default however far the pane had been zoomed.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

function body(name, end) {
  const from = main.indexOf(name);
  assert.notEqual(from, -1, `${name} is gone`);
  const to = main.indexOf(end, from);
  assert.notEqual(to, -1, `${name} no longer reaches ${end}`);
  return main.slice(from, to);
}

test("a zoom step sets every tab of the pane, not only the active one", () => {
  const zoom = body("function setBrowserZoom(action)", "\nfunction hasZoomModifier");
  assert.match(zoom, /for \(const tab of currentWindows\(\)\.tabs\) tabZoomFactors\.set\(tab, next\)/);
  assert.doesNotMatch(zoom, /tabZoomFactors\.set\(currentWindows\(\)\.win, next\)/);
});

test("a new tab starts at the pane's zoom", () => {
  assert.match(main, /function configureTab\(tab, initialZoomFactor = paneZoomFactor\(\)\)/);
  assert.match(main, /function adoptTab\(tab, url, activate = true, initialZoomFactor = paneZoomFactor\(\),/);
  const create = body("function createTab(", "const tab = adoptTab(");
  assert.match(create, /initialZoomFactor = paneZoomFactor\(\)/);
});

test("a restored window comes back at one zoom, the active tab's", () => {
  const restore = body("const moves = [];", "activateTab(session.activeIndex);");
  assert.match(restore, /const zoom = session\.tabs\[session\.activeIndex\]\?\.zoom \?\? defaultZoomFactor\(\)/);
  assert.match(restore, /createTab\(tab\.url, false, zoom, /);
});

test("activating a tab applies the pane's zoom to it", () => {
  // The step above only reaches the painted tab; a background tab takes it here.
  assert.match(main, /const zoomFactor = effectiveZoomFactor\(currentWindows\(\)\.win\);\n\s+if \(!currentWindows\(\)\.win\.isDestroyed\(\) && currentWindows\(\)\.win\.webContents\.getZoomFactor\(\) !== zoomFactor\)/);
});
