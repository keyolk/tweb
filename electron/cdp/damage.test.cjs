"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { dirtyRect } = require("./damage.cjs");

const frame = (width, height, fill = 0) => Buffer.alloc(width * height * 4, fill);
const paint = (buffer, width, x, y, value = 255) => {
  buffer.writeUInt32LE(value, (y * width + x) * 4);
};

test("identical frames have no damage", () => {
  assert.strictEqual(dirtyRect(frame(40, 30), frame(40, 30), 40, 30), null);
});

test("one changed pixel is a one-pixel rect at that pixel", () => {
  const next = frame(40, 30);
  paint(next, 40, 17, 9);
  assert.deepStrictEqual(dirtyRect(frame(40, 30), next, 40, 30), { x: 17, y: 9, width: 1, height: 1 });
});

// Chromium reports one rect per paint, and so does this: the bounding box of everything changed.
test("separate changes come back as the box that holds them all", () => {
  const next = frame(40, 30);
  paint(next, 40, 3, 4);
  paint(next, 40, 30, 20);
  assert.deepStrictEqual(dirtyRect(frame(40, 30), next, 40, 30), { x: 3, y: 4, width: 28, height: 17 });
});

test("a changed first and last column span the full width", () => {
  const next = frame(40, 30);
  paint(next, 40, 0, 5);
  paint(next, 40, 39, 5);
  assert.deepStrictEqual(dirtyRect(frame(40, 30), next, 40, 30), { x: 0, y: 5, width: 40, height: 1 });
});

test("no previous frame, or one of another size, is whole-frame damage", () => {
  assert.deepStrictEqual(dirtyRect(null, frame(4, 3), 4, 3), { x: 0, y: 0, width: 4, height: 3 });
  assert.deepStrictEqual(dirtyRect(frame(5, 3), frame(4, 3), 4, 3), { x: 0, y: 0, width: 4, height: 3 });
});
