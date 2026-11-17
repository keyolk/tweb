"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parkSequence, unparkSequence } = require("./terminal-caret.cjs");

const SHOW = "\x1b[?25h";
const HIDE = "\x1b[?25l";

// The "blue cursor" in a focused field was the terminal's own cursor, shown as a bar on the cell
// grid. Parking must move it without ever making it visible.
test("parking the caret moves the cursor and leaves it hidden", () => {
  const bytes = parkSequence(12, 34);
  assert.ok(bytes.startsWith("\x1b[12;34H"), "the cursor goes to the caret cell first");
  assert.ok(!bytes.includes(SHOW), "a parked caret is never shown");
  assert.ok(bytes.endsWith(HIDE), "and is re-hidden, in case anything showed it");
  // No shape request: the terminal draws a composition as a block regardless (Ghostty
  // cursor.zig), and nothing else is drawn there.
  assert.ok(!/\x1b\[\d q/.test(bytes));
});

test("unparking hides the cursor and gives the shell its shape back", () => {
  const bytes = unparkSequence();
  assert.ok(bytes.includes(HIDE));
  assert.ok(bytes.includes("\x1b[0 q"));
  assert.ok(!bytes.includes(SHOW));
});

// While the pane's cursor was visible, every graphics write showed it travelling: the tmux
// passthrough walks it to the pane origin and back, and tmux sends it to the screen's top-left
// after a passthrough. Nothing the engine writes to the pane may turn it on.
test("the engine never shows the pane's terminal cursor", () => {
  const sources = ["main.cjs", "gfx-worker.cjs", "frame-writer.cjs", "placeholder-cells.cjs"]
    .map((name) => fs.readFileSync(path.join(__dirname, name), "utf8"));
  for (const source of sources) {
    assert.doesNotMatch(source, /\?25h/);
  }
});
