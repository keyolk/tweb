"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { KeySequencer, keyIdentity, modifierMask, toCdpKey, toCdpMouse } = require("./input.cjs");
const { pressEvents } = require("../agent-key.cjs");

test("modifier names map to CDP's bitfield", () => {
  assert.strictEqual(modifierMask([]), 0);
  assert.strictEqual(modifierMask(["alt"]), 1);
  assert.strictEqual(modifierMask(["control"]), 2);
  assert.strictEqual(modifierMask(["meta"]), 4);
  assert.strictEqual(modifierMask(["shift"]), 8);
  assert.strictEqual(modifierMask(["shift", "meta", "leftbuttondown"]), 12);
});

test("Accelerator arrow names become DOM keys with their legacy keyCodes", () => {
  assert.deepStrictEqual(keyIdentity("Up"), { key: "ArrowUp", code: "ArrowUp", keyCode: 38 });
  assert.deepStrictEqual(keyIdentity("Left"), { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 });
  assert.deepStrictEqual(keyIdentity("Enter"), { key: "Enter", code: "Enter", keyCode: 13 });
});

test("printable characters carry a physical code where a US keyboard has one", () => {
  assert.deepStrictEqual(keyIdentity("k"), { key: "k", code: "KeyK", keyCode: 75 });
  assert.deepStrictEqual(keyIdentity("K"), { key: "K", code: "KeyK", keyCode: 75 });
  assert.deepStrictEqual(keyIdentity("7"), { key: "7", code: "Digit7", keyCode: 55 });
  assert.deepStrictEqual(keyIdentity("!"), { key: "!", code: "Digit1", keyCode: 49 });
  assert.deepStrictEqual(keyIdentity("/"), { key: "/", code: "Slash", keyCode: 191 });
  // No physical key: the text still goes through, with no code to misreport.
  assert.deepStrictEqual(keyIdentity("한"), { key: "한", code: "", keyCode: 0 });
});

// Electron sends keyDown, then char with the text, then keyUp. CDP wants the text ON the keyDown,
// which is what fires keypress/beforeinput/input the way a real keyboard does.
test("a keyDown + char pair becomes one keyDown carrying the text", () => {
  const sent = [];
  const keys = new KeySequencer((params) => sent.push(params));
  for (const event of pressEvents("a", [])) keys.push(event);
  keys.flush();
  assert.deepStrictEqual(sent.map((params) => params.type), ["keyDown", "keyUp"]);
  assert.strictEqual(sent[0].text, "a");
  assert.strictEqual(sent[0].key, "a");
  assert.strictEqual(sent[0].code, "KeyA");
});

test("shift + letter types the uppercase letter", () => {
  const sent = [];
  const keys = new KeySequencer((params) => sent.push(params));
  for (const event of pressEvents("i", ["shift"])) keys.push(event);
  keys.flush();
  assert.strictEqual(sent[0].text, "I");
  assert.strictEqual(sent[0].modifiers, 8);
});

test("a key with no char is a rawKeyDown, so it types nothing", () => {
  const sent = [];
  const keys = new KeySequencer((params) => sent.push(params));
  keys.push({ type: "keyDown", keyCode: "Left", modifiers: [] });
  keys.push({ type: "keyUp", keyCode: "Left", modifiers: [] });
  keys.flush();
  assert.deepStrictEqual(sent.map((params) => [params.type, params.key]), [["rawKeyDown", "ArrowLeft"], ["keyUp", "ArrowLeft"]]);
  assert.strictEqual(sent[0].text, undefined);
});

// Enter has to carry "\r": without text Chrome fires keydown but neither submits a form nor
// inserts a newline in a textarea.
test("Enter carries its carriage return", () => {
  const params = toCdpKey({ type: "keyDown", keyCode: "Enter", modifiers: [] });
  assert.strictEqual(params.type, "keyDown");
  assert.strictEqual(params.text, "\r");
});

// CDP input skips the browser's accelerator table, so a synthetic Cmd-A selects nothing unless
// the editing command is named.
test("Cmd shortcuts name the editing command Chrome would have run", () => {
  assert.deepStrictEqual(toCdpKey({ type: "keyDown", keyCode: "a", modifiers: ["meta"] }).commands, ["selectAll"]);
  assert.deepStrictEqual(toCdpKey({ type: "keyDown", keyCode: "z", modifiers: ["meta", "shift"] }).commands, ["redo"]);
  assert.deepStrictEqual(toCdpKey({ type: "keyDown", keyCode: "Left", modifiers: ["alt"] }).commands, ["moveWordLeft"]);
  assert.strictEqual(toCdpKey({ type: "keyDown", keyCode: "a", modifiers: [] }).commands, undefined);
});

test("a lone char (an IME commit) is sent as text without a key", () => {
  const sent = [];
  const keys = new KeySequencer((params) => sent.push(params));
  keys.push({ type: "char", keyCode: "한", modifiers: [] });
  assert.deepStrictEqual(sent, [{ type: "char", text: "한", unmodifiedText: "한", key: "한", modifiers: 0 }]);
});

test("mouse down and up report the button state after the event", () => {
  const down = toCdpMouse({ type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1, modifiers: [] });
  assert.deepStrictEqual(down, { type: "mousePressed", x: 10, y: 20, modifiers: 0, button: "left", buttons: 1, clickCount: 1 });
  const up = toCdpMouse({ type: "mouseUp", x: 10, y: 20, button: "left", clickCount: 1, modifiers: ["leftbuttondown"] });
  assert.strictEqual(up.type, "mouseReleased");
  assert.strictEqual(up.buttons, 0);
});

test("a move with a held button reports that button, so the page sees a drag", () => {
  const move = toCdpMouse({ type: "mouseMove", x: 5, y: 6, modifiers: ["leftbuttondown"] });
  assert.strictEqual(move.type, "mouseMoved");
  assert.strictEqual(move.button, "left");
  assert.strictEqual(move.buttons, 1);
});

// Electron's wheel deltas point the way the content moves, CDP's the way the wheel turns.
test("wheel deltas flip sign between the two conventions", () => {
  const wheel = toCdpMouse({ type: "mouseWheel", x: 0, y: 0, deltaX: 0, deltaY: 120, modifiers: [] });
  assert.strictEqual(wheel.type, "mouseWheel");
  assert.strictEqual(wheel.deltaY, -120);
});

test("contextMenu has no CDP equivalent and is dropped", () => {
  assert.strictEqual(toCdpMouse({ type: "contextMenu", x: 1, y: 1 }), null);
});
