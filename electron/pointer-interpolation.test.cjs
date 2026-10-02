"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { interpolatePoints } = require("./pointer-interpolation.cjs");

// A 360x100 pane over a 1800x1125 page: 5.0 x 11.2 CSS px per cell, which is the shape that
// produced the staircase.
const CELL = { x: 5, y: 11.25 };

test("a move within one cell is left alone", () => {
  assert.deepEqual(interpolatePoints({ x: 100, y: 100 }, { x: 103, y: 108 }, CELL), []);
});

test("a move of exactly one cell is already as smooth as the grid allows", () => {
  // One cell down is the smallest step tmux can report. Splitting it would put points at
  // coordinates the terminal could never have produced on their own, for no gain.
  assert.deepEqual(interpolatePoints({ x: 100, y: 100 }, { x: 100, y: 111 }, CELL), []);
});

test("a vertical jump of several cells is filled on the line between the two", () => {
  const points = interpolatePoints({ x: 100, y: 100 }, { x: 100, y: 145 }, CELL);
  assert.equal(points.length, 3);
  assert.deepEqual(points, [
    { x: 100, y: 111 }, { x: 100, y: 123 }, { x: 100, y: 134 },
  ]);
  // Strictly between, never repeating either end: the caller sends `to` itself afterwards.
  for (const p of points) assert.ok(p.y > 100 && p.y < 145);
});

test("a diagonal is filled on both axes at once", () => {
  const points = interpolatePoints({ x: 100, y: 100 }, { x: 140, y: 145 }, CELL);
  assert.ok(points.length > 0);
  // Every inserted point lies on the straight line between the two, which is the only claim
  // this makes about where the pointer was.
  for (const p of points) {
    const t = (p.y - 100) / 45;
    assert.ok(Math.abs(p.x - (100 + 40 * t)) <= 1, `${p.x},${p.y} is off the line`);
  }
});

test("the first motion of a drag has nothing to interpolate from", () => {
  assert.deepEqual(interpolatePoints(null, { x: 100, y: 145 }, CELL), []);
});

// A pointer re-entering the pane, or a report missed while another window had focus, arrives as
// one enormous jump. Filling it proportionally would emit a hundred events for a movement that
// never happened as a drag.
test("an enormous jump is capped", () => {
  const points = interpolatePoints({ x: 0, y: 0 }, { x: 0, y: 1100 }, CELL);
  assert.ok(points.length <= 32, `${points.length} points for one jump`);
  const custom = interpolatePoints({ x: 0, y: 0 }, { x: 0, y: 1100 }, CELL, 3);
  assert.ok(custom.length <= 3);
});

// The cap is what decides whether a FAST stroke is filled at all, which is why it is 32 rather
// than something smaller. A slow stroke reports every few cells and never reaches it; a fast one
// reports every few DOZEN, and a cap of 8 leaves that fill as coarse as the staircase it is there
// to remove. Measured end to end on a 320-cell diagonal: 41px between delivered points at 8,
// 11px at 32, against the 6px a slow stroke produces either way.
test("one report of a fast stroke is still filled to about a cell", () => {
  // 64 cells in one report, which is what a quick diagonal across the pane produces.
  const points = interpolatePoints({ x: 0, y: 0 }, { x: 64 * CELL.x, y: 0 }, CELL);
  assert.ok(points.length >= 30, `only ${points.length} points for a 64-cell jump`);
  const step = (64 * CELL.x) / (points.length + 1);
  assert.ok(step <= 2.5 * CELL.x, `${step.toFixed(1)}px between points is still a staircase`);
});

test("a degenerate cell size does not divide by zero", () => {
  assert.deepEqual(interpolatePoints({ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 0 }), []);
});

test("the points are integers, because that is what the protocol carries", () => {
  for (const p of interpolatePoints({ x: 10, y: 10 }, { x: 53, y: 97 }, CELL)) {
    assert.equal(p.x, Math.round(p.x));
    assert.equal(p.y, Math.round(p.y));
  }
});
