"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DIACRITICS, PLACEHOLDER, MAX_ROWS, placeholderBlock, virtualPlacement, placeholdersDecision,
} = require("./placeholder-cells.cjs");

const strip = (text) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b[78]/g, "");
const mark = (index) => String.fromCodePoint(DIACRITICS[index]);

test("the diacritic table is kitty's, in order", () => {
  assert.equal(DIACRITICS.length, 297);
  assert.equal(DIACRITICS[0], 0x0305);
  assert.equal(DIACRITICS[1], 0x030d);
  assert.equal(DIACRITICS[296], 0x1d244);
  assert.equal(new Set(DIACRITICS).size, DIACRITICS.length);
});

// A bare cell continues from its left neighbour on the terminal's screen, not in tmux's grid. tmux
// redraws a row from the right edge of a popup, and every bare cell after it drew nothing.
test("every cell names its own row, column and id", () => {
  const id = 0x20000110;
  const text = strip(placeholderBlock(id, { rows: 2, cols: 3 }));
  const cell = (y, x) => `${PLACEHOLDER}${mark(y)}${mark(x)}${mark(0x20)}`;
  assert.equal(text, [0, 1].map((y) => [0, 1, 2].map((x) => cell(y, x)).join("")).join(""));
});

test("columns past the table inherit, since nothing can name them", () => {
  const text = strip(placeholderBlock(0x20000110, { rows: 1, cols: DIACRITICS.length + 3 }));
  assert.ok(text.endsWith(`${mark(DIACRITICS.length - 1)}${mark(0x20)}${PLACEHOLDER.repeat(3)}`));
});

test("the id's low 24 bits are the colour and its high byte the third mark", () => {
  const block = placeholderBlock(0x2a010203, { rows: 1, cols: 1 });
  assert.match(block, /\x1b\[38;2;1;2;3m/);
  assert.ok(block.includes(`${mark(0)}${mark(0)}${mark(0x2a)}`));
  // An id under 2^24 needs no third mark.
  assert.ok(!strip(placeholderBlock(0x010203, { rows: 1, cols: 1 })).includes(mark(0) + mark(0) + mark(0)));
});

test("a block starts at its own image cell, not the pane cell it sits on", () => {
  // A patch is its own image: its cells count from 0 wherever the patch lands in the pane.
  const block = placeholderBlock(0x20000111, { rows: 2, cols: 2, top: 7, left: 11 });
  assert.match(block, /\x1b\[7;11H/);
  assert.match(block, /\x1b\[8;11H/);
  assert.ok(strip(block).startsWith(`${PLACEHOLDER}${mark(0)}${mark(0)}`));
  // An offset block starts at that cell of its image.
  const offset = strip(placeholderBlock(0x20000111, { rows: 1, cols: 1, rowOffset: 4, colOffset: 9 }));
  assert.ok(offset.startsWith(`${PLACEHOLDER}${mark(4)}${mark(9)}`));
});

test("drawing a block leaves the cursor, autowrap and colour as they were", () => {
  const block = placeholderBlock(0x20000110, { rows: 1, cols: 1 });
  assert.ok(block.startsWith("\x1b7\x1b[?7l"));
  assert.ok(block.endsWith("\x1b[39m\x1b[?7h\x1b8"));
});

test("columns are not limited by the table, rows are", () => {
  assert.doesNotThrow(() => placeholderBlock(0x20000110, { rows: 1, cols: 600 }));
  assert.throws(() => placeholderBlock(0x20000110, { rows: MAX_ROWS + 1, cols: 1 }), /rows/);
});

test("the virtual placement is quiet and sized in cells", () => {
  assert.equal(virtualPlacement(7, { rows: 10, cols: 40 }), "a=p,U=1,i=7,c=40,r=10,q=2");
});

test("placeholders only inside tmux, on Ghostty 1.4 and later", () => {
  assert.equal(placeholdersDecision({ inTmux: true, clientTermtype: "ghostty 1.4.0" }).allowed, true);
  assert.equal(placeholdersDecision({ inTmux: true, clientTermtype: "ghostty 1.3.1" }).allowed, false);
  assert.equal(placeholdersDecision({ inTmux: true, clientTermtype: "kitty(0.35.2)" }).allowed, false);
  assert.equal(placeholdersDecision({ inTmux: true, clientTermtype: "" }).allowed, false);
  assert.equal(placeholdersDecision({ inTmux: false, clientTermtype: "ghostty 1.4.0" }).allowed, false);
});

test("TWEB_PLACEHOLDERS forces it, but never outside tmux", () => {
  assert.equal(placeholdersDecision({ inTmux: true, clientTermtype: "ghostty 1.4.0", override: "0" }).allowed, false);
  assert.equal(placeholdersDecision({ inTmux: true, clientTermtype: "kitty", override: "1" }).allowed, true);
  assert.equal(placeholdersDecision({ inTmux: false, override: "1" }).allowed, false);
});
