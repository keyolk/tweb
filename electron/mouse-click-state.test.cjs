"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MouseClickState } = require("./mouse-click-state.cjs");

test("hover without an active press is ignored", () => {
  const state = new MouseClickState();
  assert.doesNotThrow(() => state.move(undefined, 10, 20));
  assert.deepEqual(state.release(undefined), { count: 1, dragged: false });
});

test("nearby presses within the interval form a double click", () => {
  const state = new MouseClickState();
  assert.equal(state.press("left", 10, 20, 1000), 1);
  assert.deepEqual(state.release("left"), { count: 1, dragged: false });
  assert.equal(state.press("left", 12, 22, 1200), 2);
  assert.deepEqual(state.release("left"), { count: 2, dragged: false });
});

test("time, distance, and button changes reset the count", () => {
  const state = new MouseClickState();
  state.press("left", 10, 20, 1000);
  state.release("left");
  assert.equal(state.press("left", 10, 20, 1501), 1);
  state.release("left");
  assert.equal(state.press("left", 20, 20, 1600), 1);
  state.release("left");
  assert.equal(state.press("right", 20, 20, 1700), 1);
});

test("dragging cancels the click streak", () => {
  const state = new MouseClickState();
  state.press("left", 10, 20, 1000);
  state.move("left", 30, 20);
  assert.deepEqual(state.release("left"), { count: 1, dragged: true });
  assert.equal(state.press("left", 10, 20, 1100), 1);
});

test("a mismatched release clears stale state safely", () => {
  const state = new MouseClickState();
  state.press("left", 10, 20, 1000);
  assert.deepEqual(state.release("right"), { count: 1, dragged: false });
  assert.equal(state.press("left", 10, 20, 1100), 1);
});

test("reset clears active and repeated click state", () => {
  const state = new MouseClickState();
  state.press("left", 10, 20, 1000);
  state.reset();
  assert.doesNotThrow(() => state.move("left", 30, 20));
  assert.equal(state.press("left", 10, 20, 1100), 1);
});
