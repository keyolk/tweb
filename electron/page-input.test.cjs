"use strict";

// Two ways a page can be told less than the truth about the pointer, both of which
// present to the user as "the click did nothing".

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

// --- a held button has to reach the page ---
//
// `MouseEvent.buttons` is filled in from the event's modifiers, not from its `button`
// field, so a move sent without one reads as an idle pointer travelling across the page.
// Every site that implements its own drag — a canvas, a slider, a whiteboard, a text
// selection — gates on exactly that, and saw nothing.

test("the held-button modifiers are the names Chromium accepts", () => {
  // Lowercase. Electron's InputEvent.modifiers enumerates them that way, and an
  // unrecognised modifier is dropped silently — which is the failure this pins.
  assert.match(main, /left: "leftbuttondown"/);
  assert.match(main, /middle: "middlebuttondown"/);
  assert.match(main, /right: "rightbuttondown"/);
});

test("a terminal drag carries the held button, and a release does not", () => {
  const dispatch = body("function dispatchMouse(cb, rawX, rawY, release)", "const KITTY_KEYS");
  assert.match(
    dispatch,
    /modifiers: type === "mouseUp" \? modifiers : withButtonDown\(modifiers, button\),/,
    "mouseDown and every mouseMove during a drag must say which button is down"
  );
});

test("an agent drag carries the held button through every intermediate move", () => {
  const drag = body('case "native-drag": {', 'case "frame-mode":');
  assert.match(drag, /const held = withButtonDown\(\[\], "left"\);/);
  // The down and all three interpolated moves. The up deliberately does not.
  assert.equal((drag.match(/modifiers: held,?/g) || []).length, 2);
  assert.match(drag, /type: "mouseDown".*modifiers: held/);
  assert.doesNotMatch(drag, /type: "mouseUp".*modifiers: held/);
});

// --- window.open has to come back with a handle ---
//
// Denying the request and opening a tab instead returns null to the opener. An OAuth
// "sign in in a new window" opens a blank popup first and then drives it through that
// handle, so null ends the flow before it starts — the user sees an empty tab and no
// sign-in. Measured in-page on a live Google Meet add-on.

test("window.open is allowed, with this pane's own offscreen window options", () => {
  const handler = body("setWindowOpenHandler((details) => {", "// The window Electron just created");
  assert.match(handler, /action: "allow", overrideBrowserWindowOptions: browserWindowOptions\(\)/);
  assert.doesNotMatch(handler, /action: "deny"/);
  // The options are what keep Electron from surfacing a native popup, which is the
  // reason the old code denied in the first place.
  assert.match(main, /show: false,/);
});

test("the opened window is adopted rather than created a second time", () => {
  const created = body('onContents("did-create-window"', "});");
  assert.match(created, /adoptTab\(child, details\.url \|\| "about:blank", activate\)/);
  // createTab would build a SECOND window and load the URL again; the opener's handle
  // points at the one Electron already made.
  assert.doesNotMatch(created, /createTab\(/);
});

test("the disposition survives the hop from the open handler to did-create-window", () => {
  assert.match(main, /let pendingWindowOpen = null;/);
  assert.match(main, /pendingWindowOpen = \{ activate: details\.disposition !== "background-tab" \};/);
  // Cleared on use, so a window Electron creates for anything else cannot inherit it.
  assert.match(main, /const activate = pendingWindowOpen\?\.activate \?\? true;\s*\n\s*pendingWindowOpen = null;/);
});
