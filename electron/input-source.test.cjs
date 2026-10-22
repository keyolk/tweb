"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { TEXT_MODES, focusHookCommands, keysAreText } = require("./input-source.cjs");

const commands = { vimium: true, bypass: false, insertMode: false, textMode: false };

test("keys are commands only in plain normal mode", () => {
  assert.strictEqual(keysAreText(commands), false);
  assert.strictEqual(keysAreText({ ...commands, insertMode: true }), true);
  assert.strictEqual(keysAreText({ ...commands, textMode: true }), true);
  assert.strictEqual(keysAreText({ ...commands, bypass: true }), true, "edit mode (Ctrl-;) types");
  assert.strictEqual(keysAreText({ ...commands, vimium: false }), true, "shortcuts off types");
});

test("tweb's own input overlays are text; the key-driven ones are commands", () => {
  for (const mode of ["insert", "omnibox", "search", "command-line", "command"]) assert.ok(TEXT_MODES.has(mode), mode);
  for (const mode of ["normal", "visual", "tabs", "help", "inspect"]) assert.ok(!TEXT_MODES.has(mode), mode);
});

test("focus hooks switch to ABC entering a commands pane and restore leaving any tweb pane", () => {
  const [focusIn, focusOut] = focusHookCommands("/Users/me/.local/bin/tweb");
  assert.deepStrictEqual(focusIn.slice(0, 3), ["set-hook", "-g", "pane-focus-in[72]"]);
  assert.match(focusIn[3], /#\{&&:#\{==:#\{@tweb_browser\},1\},#\{!=:#\{@tweb_text\},1\}\}/);
  assert.match(focusIn[3], /'\/Users\/me\/\.local\/bin\/tweb' __ime normal/);
  assert.deepStrictEqual(focusOut.slice(0, 3), ["set-hook", "-g", "pane-focus-out[72]"]);
  assert.match(focusOut[3], /#\{==:#\{@tweb_browser\},1\}/);
  assert.match(focusOut[3], /__ime restore/);
  // Edit mode's hooks are index 71; these must not replace them.
  assert.ok(![focusIn, focusOut].some((args) => args[2].includes("[71]")));
  // A path with a space and a quote survives the three quoting layers (if-shell, run-shell, sh).
  const [awkward] = focusHookCommands("/tmp/my dir/it's/tweb");
  assert.ok(awkward[3].endsWith(String.raw`"run-shell -b \"'/tmp/my dir/it'\\\\''s/tweb' __ime normal >/dev/null 2>&1\""`), awkward[3]);
  assert.deepStrictEqual(focusHookCommands("/t", false),
    [["set-hook", "-gu", "pane-focus-in[72]"], ["set-hook", "-gu", "pane-focus-out[72]"]]);
});

// Typed Hangul is replayed as keys only while the keys are commands: in a field it is text.
test("terminal text replays Hangul as keys only in normal mode", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const dispatch = main.slice(main.indexOf("function dispatchText("), main.indexOf("const CMD_PRIVATE_KEYS"));
  assert.match(dispatch, /const commands = !keysAreText\(inputState\(\)\);/);
  assert.match(dispatch, /const keys = commands \? hangulKeys\(char\) : null;/);
  for (const site of ['case "insert-mode"', 'case "text-mode"', "function applyShortcutMode("]) {
    const at = main.indexOf(site);
    assert.ok(at > 0, site);
    assert.match(main.slice(at, at + 1600), /syncInputSource\(\)/, `${site} re-syncs the input source`);
  }
});
