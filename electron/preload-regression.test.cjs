"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const electron = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
const tauri = fs.readFileSync(path.join(root, "crates/tweb-engine/tauri/src/preload.js.inc"), "utf8");

function assertPreload(source) {
  assert.match(source, /"ㄹ": "f", "ᄅ": "f", "ㅎ": "g", "ᄒ": "g"/);
  assert.match(source, /function commandKey\(value, shiftKey = false\)/);
  assert.match(source, /return commandKey\(keys\[event\.code\] \|\| event\.key, event\.shiftKey\)/);
  assert.match(source, /commandKey\(payload\.key, Boolean\(payload\.shiftKey\)\)/);
  assert.match(source, /else send\("native-click", hintClickPoint\(item\)\)/);
  assert.match(source, /const rect = visibleRect\(item\.element\) \|\| item\.rect/);
  assert.doesNotMatch(source, /item\.element\.click\(\)/);
}

test("Electron preload maps Korean normal keys and uses trusted hint clicks", () => {
  assertPreload(electron);
});

test("Tauri preload maps Korean normal keys and uses trusted hint clicks", () => {
  assertPreload(tauri);
});

test("Electron sends each Unicode terminal key through one input path", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.doesNotMatch(main, /codepoint > 0x7f\) sendToTabFrames\(win, "tweb-terminal-text"/);
});

// The page speaks CSS pixels and sendInputEvent speaks unzoomed window pixels.
// Feeding one to the other silently lands clicks off-target at any zoom ≠ 100%.
test("synthetic pointer events are scaled by the zoom factor", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /function pageToWindowPoint\(contents, point\)/);
  assert.match(main, /const zoom = contents\.getZoomFactor\(\) \|\| 1/);
  const pointerEvents = main.match(/sendInputEvent\(\{\s*type: "mouse(?:Move|Down|Up)"[^}]*\}/g) || [];
  assert.ok(pointerEvents.length > 0, "expected synthetic pointer events");
  for (const call of pointerEvents) {
    assert.doesNotMatch(
      call,
      /Math\.round\((?:value|point)\.[xy]\)/,
      `pointer event uses unscaled page coordinates: ${call}`
    );
  }
});
