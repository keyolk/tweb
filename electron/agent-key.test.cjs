"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { pressEvents, insertedText } = require("./agent-key.cjs");

const types = (events) => events.map((event) => event.type);
const charOf = (events) => events.find((event) => event.type === "char")?.keyCode ?? null;

test("a plain printable key types itself", () => {
  const events = pressEvents("a", []);
  assert.deepStrictEqual(types(events), ["keyDown", "char", "keyUp"]);
  assert.strictEqual(events[0].keyCode, "a");
  assert.strictEqual(charOf(events), "a");
});

// Measured against the real key path: `tmux send-keys h I x` left "hIx" in the field,
// while `tweb press h; tweb press i --mod shift` left "h". The keydown was correct in
// both — only the char event was missing.
test("shift uppercases the inserted character instead of suppressing it", () => {
  const events = pressEvents("i", ["shift"]);
  assert.strictEqual(charOf(events), "I", "shift+i must type I, not nothing");
  assert.deepStrictEqual(events[0].modifiers, ["shift"]);
});

test("an already-shifted character is passed through untouched", () => {
  assert.strictEqual(charOf(pressEvents("!", ["shift"])), "!");
  assert.strictEqual(charOf(pressEvents("B", [])), "B");
});

// Control and Meta make the keystroke a shortcut. A char event here would type a literal
// letter into the field the shortcut was aimed at.
test("control and meta suppress the character but keep the key event", () => {
  for (const modifier of ["control", "meta"]) {
    const events = pressEvents("a", [modifier]);
    assert.deepStrictEqual(types(events), ["keyDown", "keyUp"], `${modifier} must not type`);
    assert.deepStrictEqual(events[0].modifiers, [modifier]);
  }
});

test("alt still types, matching the real key path", () => {
  assert.strictEqual(charOf(pressEvents("a", ["alt"])), "a");
});

// sendInputEvent takes Accelerator names. Chromium drops "ArrowLeft" silently, which is
// why two `press ArrowLeft` calls left selectionStart at 6 while `tmux send-keys Left Left`
// moved it to 4, and why the page saw keydown key="" which=0.
test("the arrow keys are translated to their Accelerator names", () => {
  for (const [key, accelerator] of [
    ["ArrowUp", "Up"], ["ArrowDown", "Down"], ["ArrowLeft", "Left"], ["ArrowRight", "Right"],
  ]) {
    const events = pressEvents(key, []);
    assert.strictEqual(events[0].keyCode, accelerator, `${key} must go out as ${accelerator}`);
    assert.strictEqual(charOf(events), null, "an arrow key types nothing");
  }
});

// A letter must NOT be rewritten to a "KeyX" name: measured in offscreen Chromium,
// keyDown with "KeyK" reaches the page as key="" keyCode=0.
test("keys the two schemes already agree on are passed through", () => {
  for (const key of ["Enter", "Tab", "Escape", "Backspace", "PageDown", "Home", "End", "F5"]) {
    assert.strictEqual(pressEvents(key, [])[0].keyCode, key);
    assert.strictEqual(charOf(pressEvents(key, [])), null, `${key} types nothing on its own`);
  }
});

// The keydown fires for "Space" either way; without the char event nothing is inserted.
// Measured: `press Space` left "ab" where `tmux send-keys Space` left "ab ".
test("Space types a space", () => {
  const events = pressEvents("Space", []);
  assert.strictEqual(charOf(events), " ");
  assert.strictEqual(events[0].keyCode, "Space", "the key event keeps its name");
});

test("Space under control is a shortcut, not a space", () => {
  assert.deepStrictEqual(types(pressEvents("Space", ["control"])), ["keyDown", "keyUp"]);
});

test("a multi-codepoint key name types nothing", () => {
  assert.strictEqual(insertedText("MediaPlayPause", []), null);
});

// An emoji is a single character to a user and two code units to `.length`, which is why
// the check counts code points.
test("an astral character types itself", () => {
  assert.strictEqual(charOf(pressEvents("😀", [])), "😀");
});

test("an empty key produces no events at all", () => {
  assert.deepStrictEqual(pressEvents("", []), []);
  assert.deepStrictEqual(pressEvents(undefined, []), []);
});

test("the caller's modifier array is never mutated", () => {
  const modifiers = ["shift"];
  pressEvents("a", modifiers);
  assert.deepStrictEqual(modifiers, ["shift"]);
});
