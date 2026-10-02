"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { HINT_ALPHABET, hintLabel, shareLabels } = require("./hint-labels.cjs");

test("a small space uses one character", () => {
  assert.equal(hintLabel(0, 5), "a");
  assert.equal(hintLabel(4, 5), "g");
});

// Every label in one round has to be the same length. With "a" and "ab" both live, typing "a"
// is ambiguous — it is either a pick or the first half of one, and the picker cannot tell.
test("every label in a round is the same width", () => {
  const total = 40;
  const widths = new Set(Array.from({ length: total }, (_, i) => hintLabel(i, total).length));
  assert.deepEqual([...widths], [2]);
});

test("the width grows with the space, not with the index", () => {
  assert.equal(hintLabel(0, HINT_ALPHABET.length).length, 1);
  assert.equal(hintLabel(0, HINT_ALPHABET.length + 1).length, 2);
  assert.equal(hintLabel(0, HINT_ALPHABET.length ** 2 + 1).length, 3);
});

test("labels are distinct across the whole space", () => {
  const total = 200;
  const seen = new Set(Array.from({ length: total }, (_, i) => hintLabel(i, total)));
  assert.equal(seen.size, total);
});

// --- sharing between frames ---
//
// Each frame draws its own badges, in its own coordinates, because a cross-origin frame's
// contents are unreachable from the parent. Two frames each numbering from zero would both
// produce "a", so one keystroke would name two targets. The offsets are what stop that.

test("each frame gets a block, and the blocks do not overlap", () => {
  const { total, offsets } = shareLabels([
    { key: "main", count: 3 },
    { key: "panel", count: 2 },
    { key: "inner", count: 4 },
  ]);
  assert.equal(total, 9);
  assert.deepEqual(offsets, { main: 0, panel: 3, inner: 5 });

  // Walk every frame's block and confirm one label is never produced twice.
  const seen = new Set();
  for (const [key, start] of Object.entries(offsets)) {
    const count = { main: 3, panel: 2, inner: 4 }[key];
    for (let i = 0; i < count; i += 1) {
      const label = hintLabel(start + i, total);
      assert.ok(!seen.has(label), `${label} was handed out twice`);
      seen.add(label);
    }
  }
  assert.equal(seen.size, 9);
});

test("a frame with nothing to hint takes no labels", () => {
  const { total, offsets } = shareLabels([
    { key: "main", count: 2 },
    { key: "empty", count: 0 },
    { key: "panel", count: 1 },
  ]);
  assert.equal(total, 3);
  assert.equal(offsets.empty, 2);
  assert.equal(offsets.panel, 2);
});

test("a malformed count is treated as none rather than poisoning the total", () => {
  const { total, offsets } = shareLabels([
    { key: "a", count: 2 },
    { key: "b", count: undefined },
    { key: "c", count: -5 },
    { key: "d", count: 1.7 },
  ]);
  assert.equal(total, 3);
  assert.deepEqual(offsets, { a: 0, b: 2, c: 2, d: 2 });
});

test("no frames is an empty round, not a crash", () => {
  assert.deepEqual(shareLabels([]), { total: 0, offsets: {} });
});
