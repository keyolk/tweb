"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { patchGeometry, patchCursorMove, unionDamage } = require("./patch-geometry.cjs");

// Everything below is in frame pixels: a `paint` dirty rect and `NativeImage.crop` share
// the frame's own pixel space, which is device pixels once a scale factor is applied.
// Measured: a 637x189 DIP window at 2x reports a 1274x378 frame and a whole-frame dirty
// rect of exactly 1274x378.
//
// An 80x24 pane over an 800x480 frame gives 10x20 cells, so the arithmetic stays checkable
// by hand.
const CELLS = { cols: 80, rows: 24 };
const FRAME = { width: 800, height: 480 };

test("a caret-sized dirty rect maps to a small patch", () => {
  // 60x60 px at (400, 200) covers columns 40..46 and rows 10..13.
  const got = patchGeometry({ x: 400, y: 200, width: 60, height: 60 }, CELLS, FRAME);
  assert.deepEqual(got.place, { col: 40, row: 10, cols: 6, rows: 3 });
  assert.deepEqual(got.crop, { x: 400, y: 200, width: 60, height: 60 });
});

test("damage is rounded outward to whole cells, never inward", () => {
  // A single pixel mid-cell must still claim the whole cell it touches.
  const got = patchGeometry({ x: 5, y: 5, width: 1, height: 1 }, CELLS, FRAME);
  assert.deepEqual(got.place, { col: 0, row: 0, cols: 1, rows: 1 });
  assert.deepEqual(got.crop, { x: 0, y: 0, width: 10, height: 20 });

  // Damage straddling a cell boundary has to claim both cells.
  const straddle = patchGeometry({ x: 9, y: 19, width: 2, height: 2 }, CELLS, FRAME);
  assert.deepEqual(straddle.place, { col: 0, row: 0, cols: 2, rows: 2 });
});

test("the crop rect and the placement rect describe the same region", () => {
  const got = patchGeometry({ x: 33, y: 17, width: 41, height: 23 }, CELLS, FRAME);
  const cellWidth = FRAME.width / CELLS.cols;
  const cellHeight = FRAME.height / CELLS.rows;
  // A mismatch here is the bug this module exists to prevent: the patch would be cut from
  // one region and placed over another, off by up to a cell.
  assert.equal(got.crop.x, got.place.col * cellWidth);
  assert.equal(got.crop.y, got.place.row * cellHeight);
  assert.equal(got.crop.width, got.place.cols * cellWidth);
  assert.equal(got.crop.height, got.place.rows * cellHeight);
});

test("the patch never runs past the pane", () => {
  // Damage reaching past the right/bottom edge is clamped to the grid, and the crop is
  // clamped with it so it never asks the frame for pixels it does not have.
  const got = patchGeometry({ x: 700, y: 400, width: 200, height: 200 }, CELLS, FRAME);
  assert.deepEqual(got.place, { col: 70, row: 20, cols: 10, rows: 4 });
  assert.equal(got.crop.x + got.crop.width, FRAME.width);
  assert.equal(got.crop.y + got.crop.height, FRAME.height);
});

test("large damage falls through to the whole-frame path", () => {
  // A scroll damages everything: no patch.
  assert.equal(patchGeometry({ x: 0, y: 0, width: 800, height: 480 }, CELLS, FRAME), null);
  // Over the area limit, even when not the full pane.
  assert.equal(patchGeometry({ x: 0, y: 0, width: 800, height: 240 }, CELLS, FRAME), null);
  // Just under it still patches, so the limit is what decides and not some other guard.
  assert.ok(patchGeometry({ x: 0, y: 0, width: 800, height: 80 }, CELLS, FRAME));
});

test("degenerate input yields no patch rather than a bad placement", () => {
  const ok = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(patchGeometry(null, CELLS, FRAME), null);
  assert.equal(patchGeometry(ok, { cols: 0, rows: 24 }, FRAME), null);
  assert.equal(patchGeometry(ok, CELLS, { width: 0, height: 480 }), null);
  assert.equal(patchGeometry({ x: 0, y: 0, width: 0, height: 10 }, CELLS, FRAME), null);
});

// A real pane rather than the round numbers above: 182x27 cells over a 1274x378 frame
// gives 7x14 cells, so a caret's damage is several cells wide but only a few tall.
const REAL_CELLS = { cols: 182, rows: 27 };
const REAL_FRAME = { width: 1274, height: 378 };

test("typing damage lands on the caret, not at the pane edge", () => {
  // Measured while typing into an input near the top of the page: 31x37 px at y=187.
  // Treating those pixels as DIP and scaling them again would push the patch to the last
  // row and clamp it to a sliver — the bug this case pins down.
  const got = patchGeometry({ x: 60, y: 187, width: 31, height: 37 }, REAL_CELLS, REAL_FRAME);
  assert.deepEqual(got.place, { col: 8, row: 13, cols: 5, rows: 3 });
  assert.ok(got.place.row + got.place.rows < REAL_CELLS.rows, "patch must not sit on the last row");
});

test("typing damage on a real pane stays on the patch path", () => {
  for (const width of [31, 40, 48, 64, 72, 119]) {
    const got = patchGeometry({ x: 60, y: 187, width, height: 37 }, REAL_CELLS, REAL_FRAME);
    assert.ok(got, `${width}x37 should patch`);
    assert.ok(got.place.cols * got.place.rows < REAL_CELLS.cols * REAL_CELLS.rows * 0.2);
  }
  // A scroll damages the whole pane and must not.
  assert.equal(
    patchGeometry({ x: 0, y: 0, width: 1274, height: 378 }, REAL_CELLS, REAL_FRAME),
    null
  );
});

test("cursor motion addresses the pane's own cell, absolutely", () => {
  // A pane 51 rows down the screen: the patch's own row is an offset within it.
  const move = patchCursorMove({ col: 13, row: 21 }, { left: 0, top: 51 }, REAL_CELLS);
  assert.equal(move.prefix, "\x1b[73;14H");
  // The cursor goes back to the pane origin, where the passthrough wrapper left it.
  assert.equal(move.suffix, "\x1b[52;1H");
});

test("cursor motion never addresses a cell outside the pane", () => {
  // Relative motion (CUD) stops at the last row of the terminal, not of the pane, so a
  // patch in a pane low on screen used to pile up along the bottom edge — drawn over
  // whichever pane was there. An out-of-range cell is clamped into the pane instead.
  const move = patchCursorMove({ col: 999, row: 999 }, { left: 0, top: 51 }, REAL_CELLS);
  assert.equal(move.prefix, `\x1b[${51 + REAL_CELLS.rows};${REAL_CELLS.cols}H`);
});

test("cursor motion at the pane origin still addresses the origin", () => {
  const move = patchCursorMove({ col: 0, row: 0 }, { left: 4, top: 10 }, REAL_CELLS);
  assert.equal(move.prefix, "\x1b[11;5H");
  assert.equal(move.suffix, "\x1b[11;5H");
});

test("damage accumulates until the next whole frame", () => {
  // Typing widens the damage; backspacing narrows it. A patch cut to the narrow rect alone
  // would leave the deleted character visible in the strip it no longer covers, so each
  // patch repaints the union of everything patched since the base frame.
  const wide = { x: 60, y: 187, width: 119, height: 37 };
  const narrow = { x: 60, y: 187, width: 31, height: 37 };
  assert.deepEqual(unionDamage(wide, null), wide);
  assert.deepEqual(unionDamage(narrow, wide), wide);

  // Damage that moves away still covers where it came from.
  const moved = unionDamage({ x: 300, y: 187, width: 20, height: 37 }, narrow);
  assert.deepEqual(moved, { x: 60, y: 187, width: 260, height: 37 });

  // And in both axes at once.
  const grown = unionDamage({ x: 40, y: 100, width: 10, height: 10 }, narrow);
  assert.deepEqual(grown, { x: 40, y: 100, width: 51, height: 124 });
});
