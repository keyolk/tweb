"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pressEvents, typeSteps, typedKeys, insertedText, parseChord } = require("./agent-key.cjs");

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

// Measured on Upwind's console: `press Meta+k` returned ok and the page saw a keydown for a
// key named "Meta+k", so the Cmd-K palette never opened; `press k --mod meta` opened it.
test("a chord is split into its key and modifiers", () => {
  assert.deepStrictEqual(parseChord("Meta+k"), { key: "k", modifiers: ["meta"] });
  assert.deepStrictEqual(parseChord("Cmd+Shift+P"), { key: "P", modifiers: ["meta", "shift"] });
  assert.deepStrictEqual(parseChord("ctrl+ArrowLeft"), { key: "ArrowLeft", modifiers: ["control"] });
  assert.deepStrictEqual(parseChord("Option+a"), { key: "a", modifiers: ["alt"] });
});

test("a chord merges with --mod without duplicating", () => {
  assert.deepStrictEqual(parseChord("Meta+k", ["meta"]), { key: "k", modifiers: ["meta"] });
  assert.deepStrictEqual(parseChord("Shift+a", ["control"]), { key: "a", modifiers: ["control", "shift"] });
});

test("plus as a key survives", () => {
  assert.deepStrictEqual(parseChord("+"), { key: "+", modifiers: [] });
  assert.deepStrictEqual(parseChord("Shift++"), { key: "+", modifiers: ["shift"] });
});

test("a name with + whose prefix is not a modifier is left alone", () => {
  assert.deepStrictEqual(parseChord("a+b"), { key: "a+b", modifiers: [] });
  assert.deepStrictEqual(parseChord("Meta+"), { key: "Meta+", modifiers: [] });
  assert.deepStrictEqual(parseChord("Enter", ["shift"]), { key: "Enter", modifiers: ["shift"] });
});

test("the chord's key and modifiers produce the shortcut events", () => {
  const { key, modifiers } = parseChord("Meta+k");
  const events = pressEvents(key, modifiers);
  assert.deepStrictEqual(types(events), ["keyDown", "keyUp"]);
  assert.strictEqual(events[0].keyCode, "k");
  assert.deepStrictEqual(events[0].modifiers, ["meta"]);
});

// --- `tweb type` ---
//
// Measured: `tweb type x` returned ok and filled a field, but a capture-phase keydown listener on
// the document stayed empty, because the text went in as one insertText.

test("type sends every printable ASCII character as a key press", () => {
  const steps = typeSteps("g]x");
  assert.deepStrictEqual(steps.map((step) => step.key), ["g", "]", "x"]);
  for (const step of steps) {
    assert.deepStrictEqual(types(step.events), ["keyDown", "char", "keyUp"]);
    assert.strictEqual(step.events[0].keyCode, step.key);
    assert.strictEqual(charOf(step.events), step.key);
  }
});

test("type keeps a space and an uppercase letter as characters, not shift chords", () => {
  const steps = typeSteps("A b");
  assert.deepStrictEqual(steps.map((step) => charOf(step.events)), ["A", " ", "b"]);
  assert.deepStrictEqual(steps[0].events[0].modifiers, []);
});

test("type turns a newline and a tab into the Enter and Tab keys", () => {
  const steps = typeSteps("a\n\tb");
  assert.deepStrictEqual(steps.map((step) => step.key), ["a", "Enter", "Tab", "b"]);
  assert.deepStrictEqual(types(steps[1].events), ["keyDown", "keyUp"], "Enter inserts no character");
});

// Hangul and emoji have no keyCode Chromium accepts, so they stay one insertText run rather
// than become keyDown events that would type nothing.
test("type leaves characters without a key as one run of text", () => {
  const steps = typeSteps("a한글😀b");
  assert.deepStrictEqual(steps.map((step) => step.text ?? step.key), ["a", "한글😀", "b"]);
});

test("type of nothing sends nothing", () => {
  assert.deepStrictEqual(typeSteps(""), []);
  assert.deepStrictEqual(typeSteps(undefined), []);
  assert.deepStrictEqual(typedKeys(typeSteps("")), []);
});

test("typedKeys names only the key steps, with repeats", () => {
  assert.deepStrictEqual(typedKeys(typeSteps("gg한")), ["g", "g"]);
});

// --- the preload must let an announced agent key through ---
//
// Measured on a file:// page with a capture-phase keydown listener: `press g` and `press j` left
// the listener empty while `press 5` and `press q` did not. `g` and `j` are TWeb commands, and the
// preload's own capture handler stopped them before the page. An agent key is announced by the
// engine (`tweb-agent-keys`) and spent once.

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");

test("the engine announces an agent key before it sends it, for both press and type", () => {
  assert.match(main, /function allowAgentKeys\(keys, modifiers\)/);
  assert.match(main, /sendToFocusedTabFrame\(agentTab\(\), "tweb-agent-keys"/);
  const press = main.slice(main.indexOf("function agentPressKey("), main.indexOf("function agentTypeText("));
  assert.ok(press.includes(".sendInputEvent("), "press body found");
  assert.ok(press.indexOf("allowAgentKeys([key]") !== -1 && press.indexOf("allowAgentKeys([key]") < press.indexOf(".sendInputEvent("), "press: announce, then send");
  const type = main.slice(main.indexOf("function agentTypeText("), main.indexOf("function allowAgentKeys("));
  assert.ok(type.includes(".sendInputEvent("), "type body found");
  assert.ok(type.indexOf("allowAgentKeys(typedKeys") !== -1 && type.indexOf("allowAgentKeys(typedKeys") < type.indexOf(".sendInputEvent("), "type: announce, then send");
  assert.doesNotMatch(main, /case "type":\s*agentContents\(\)\.insertText/, "type must not be one insertText");
});

test("Escape is never announced, so it stays the way out of a TWeb overlay", () => {
  assert.match(main, /keys\.filter\(\(name\) => name !== "Escape"\)/);
});

test("the preload spends an announced key once and lets it past the TWeb commands", () => {
  assert.match(preload, /ipcRenderer\.on\("tweb-agent-keys"/);
  const handler = preload.slice(preload.indexOf("function handleNormalKey(event)"));
  const take = handler.indexOf("takeAgentKey(event, key)");
  const passed = handler.indexOf("if (agentKey) {");
  const commands = handler.indexOf("normalKeyActions.get(key)");
  assert.ok(take !== -1 && passed !== -1 && commands !== -1);
  assert.ok(take < passed && passed < commands, "the pass-through comes before the command table");
  // Overlays keep their keys: the pass-through sits after the help, picker and palette handlers.
  assert.ok(handler.indexOf("handlePickerKey(event, key)") < passed);
});

test("an announcement expires, so a key that never arrives cannot swallow a later one", () => {
  assert.match(preload, /Date\.now\(\) > agentKeysUntil/);
});

test("only a real keydown spends the allowance", () => {
  assert.match(preload, /event\.type === "keydown" \? takeAgentKey\(event, key\) : false/);
});
