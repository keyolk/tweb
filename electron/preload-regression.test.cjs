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

  // Hints must land on the controls a site actually draws, so the pointer is
  // parked over the video first and no lookalike overlay is painted.
  assert.match(source, /function mediaHoverPoints\(\)/);
  assert.doesNotMatch(source, /renderMediaControlOverlays/);
  // Players fade their controls once the pointer stops, so the loop has to keep
  // nudging — and it must start after startPicker's cancelTransient, which is
  // what stops any previous loop.
  assert.match(source, /mediaHoverTimer = setInterval\(\(\) => nudgeMediaPointer\(points\), 700\)/);
  assert.match(source, /pickerState = null;\s*\n\s*stopMediaHover\(\);/);
  const startHints = source.slice(source.indexOf("function startHints(newTab)"));
  assert.ok(
    startHints.indexOf("startMediaHoverLoop(points)") > startHints.indexOf("startPicker("),
    "the hover loop must start after startPicker, or cancelTransient kills it"
  );
  // Synthetic control targets are for UA shadow-DOM controls only.
  assert.match(source, /if \(!media\.controls \|\| rect\.width < 160/);

  // Insert mode pauses TWeb keys for a page's own shortcuts; Escape comes back
  // and also leaves fullscreen, which an offscreen window never does by itself.
  assert.match(source, /function enterInsertMode\(\)/);
  assert.match(source, /case "i": enterInsertMode\(\); break;/);
  assert.match(source, /if \(insertMode\) \{\s*\n\s*if \(key !== "Escape"\) return;/);
  assert.match(source, /if \(key === "Escape" && document\.fullscreenElement\)/);
  assert.match(source, /!editable && !insertMode/);

  // Blur alone leaves a site's suggestion panel up, so a normal-mode Escape
  // clicks somewhere inert to trigger the page's own outside-click dismissal.
  assert.match(source, /case "Escape": handled = dismissPageOverlay\(\); break;/);
  assert.match(source, /function outsideClickPoint\(\)/);
  assert.match(source, /if \(isEditable\(element\) \|\| clickableAncestor\(element\)\) continue;/);
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

test("agent bridge exposes snapshot, act and query to the socket", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  for (const method of ["snapshot", "act", "navigate", "eval", "wait", "console", "errors", "screenshot"]) {
    assert.match(main, new RegExp(`case "${method}"`), `main is missing agent method ${method}`);
  }
  assert.match(electron, /function agentSnapshot\(params = \{\}\)/);
  assert.match(electron, /function agentAct\(params\)/);
  assert.match(electron, /ipcRenderer\.on\("tweb-agent-request"/);
  // Refs are hint labels so the agent and the human name the same element.
  assert.match(electron, /const labels = hintLabels\(targets\.length\);\s*\n\s*agentTargets = new Map/);
});

test("agent socket refuses a path longer than sun_path", () => {
  const server = fs.readFileSync(path.join(__dirname, "agent-server.cjs"), "utf8");
  assert.match(server, /Buffer\.byteLength\(target\) > 100/);
  assert.match(server, /agent-\$\{pane\.replace/);
});
