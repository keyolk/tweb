"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPatchBudget, BASE_MAX, SINGLE_MAX, WINDOW_MS } = require("./patch-budget.cjs");

function clock() {
  let at = 1000;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

test("a caret-sized patch always goes, however many came before", () => {
  const time = clock();
  const budget = createPatchBudget(time);
  for (let i = 0; i < 50; i += 1) {
    assert.ok(budget.allows(BASE_MAX));
    budget.note(BASE_MAX);
  }
});

// The command palette at 2880x1800 encodes to ~135KB; under the old flat 64KB cap it went out as
// a 20MB whole frame on every open.
test("a single menu-sized patch goes", () => {
  const budget = createPatchBudget(clock());
  assert.ok(budget.allows(136 * 1024));
});

test("a patch over the single limit never goes", () => {
  const budget = createPatchBudget(clock());
  assert.ok(!budget.allows(SINGLE_MAX + 1));
});

// The whiteboard that blocked the main thread: large patches back to back.
test("a stream of large patches is held to the window budget", () => {
  const time = clock();
  const budget = createPatchBudget(time);
  const size = 200 * 1024;
  for (let i = 0; i < 2; i += 1) {
    assert.ok(budget.allows(size), `patch ${i}`);
    budget.note(size);
    time.advance(33);
  }
  assert.ok(!budget.allows(size), "a third 200KB patch inside the window must go paced");
  time.advance(WINDOW_MS);
  assert.ok(budget.allows(size), "once the window has passed, the next one goes");
});

test("menu moves a key apart all go", () => {
  const time = clock();
  const budget = createPatchBudget(time);
  for (let i = 0; i < 10; i += 1) {
    assert.ok(budget.allows(140 * 1024), `move ${i}`);
    budget.note(140 * 1024);
    time.advance(120);
  }
});
