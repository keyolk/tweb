"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseOcclusionRects, sameRects, pixelRects, maskBitmap, placeIsCovered,
} = require("./floating-occlusion.cjs");
const { parseControlLine } = require("./pane-control.cjs");

// 80x24 cells over an 800x480 frame: 10x20 px cells, checkable by hand.
const CELLS = { cols: 80, rows: 24 };
const FRAME = { width: 800, height: 480 };

test("an OCC line parses to cell rects, and a bare one to none", () => {
  assert.deepEqual(parseOcclusionRects("0,9,21,10 3,4,5,6"), [
    { col: 0, row: 9, cols: 21, rows: 10 },
    { col: 3, row: 4, cols: 5, rows: 6 },
  ]);
  assert.deepEqual(parseOcclusionRects(""), []);
  assert.equal(parseOcclusionRects("1,2,3"), null);
  assert.equal(parseOcclusionRects("1,2,3,x"), null);
});

test("the control parser routes OCC, addressed or not", () => {
  assert.deepEqual(parseControlLine("OCC 1,2,3,4"),
    { kind: "occlusion", paneId: null, rects: [{ col: 1, row: 2, cols: 3, rows: 4 }] });
  assert.deepEqual(parseControlLine("@%3 OCC"), { kind: "occlusion", paneId: "%3", rects: [] });
  assert.equal(parseControlLine("OCC 1,2"), null);
});

test("cells map to frame pixels, rounded outward and clipped to the frame", () => {
  assert.deepEqual(pixelRects([{ col: 2, row: 1, cols: 3, rows: 2 }], CELLS, FRAME),
    [{ x: 20, y: 20, width: 30, height: 40 }]);
  // A frame that is not a whole number of pixels per cell still covers every touched pixel.
  assert.deepEqual(pixelRects([{ col: 1, row: 0, cols: 1, rows: 1 }], { cols: 3, rows: 1 }, { width: 10, height: 5 }),
    [{ x: 3, y: 0, width: 4, height: 5 }]);
  assert.deepEqual(pixelRects([{ col: 78, row: 23, cols: 10, rows: 10 }], CELLS, FRAME),
    [{ x: 780, y: 460, width: 20, height: 20 }]);
  assert.deepEqual(pixelRects([], CELLS, FRAME), []);
});

test("masking clears exactly the covered pixels", () => {
  const size = { width: 4, height: 3 };
  const bitmap = Buffer.alloc(4 * 4 * 3, 0xff);
  const cleared = maskBitmap(bitmap, size, [{ x: 1, y: 1, width: 2, height: 2 }]);
  assert.equal(cleared, 4);
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const covered = x >= 1 && x <= 2 && y >= 1;
      const pixel = bitmap.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4);
      assert.deepEqual([...pixel], covered ? [0, 0, 0, 0] : [255, 255, 255, 255], `pixel ${x},${y}`);
    }
  }
});

test("a short bitmap is left alone rather than written past", () => {
  const bitmap = Buffer.alloc(8, 0xff);
  assert.equal(maskBitmap(bitmap, { width: 4, height: 3 }, [{ x: 0, y: 0, width: 1, height: 1 }]), 0);
});

test("a patch touching a covered cell is covered, one beside it is not", () => {
  const rects = [{ col: 10, row: 5, cols: 4, rows: 2 }];
  assert.equal(placeIsCovered({ col: 13, row: 6, cols: 3, rows: 3 }, rects), true);
  assert.equal(placeIsCovered({ col: 14, row: 5, cols: 3, rows: 1 }, rects), false);
  assert.equal(placeIsCovered({ col: 10, row: 7, cols: 1, rows: 1 }, rects), false);
  assert.equal(placeIsCovered({ col: 0, row: 0, cols: 1, rows: 1 }, []), false);
});

test("rect lists compare by value", () => {
  assert.equal(sameRects([], undefined), true);
  assert.equal(sameRects([{ col: 1, row: 2, cols: 3, rows: 4 }], [{ col: 1, row: 2, cols: 3, rows: 4 }]), true);
  assert.equal(sameRects([{ col: 1, row: 2, cols: 3, rows: 4 }], [{ col: 1, row: 2, cols: 3, rows: 5 }]), false);
});
