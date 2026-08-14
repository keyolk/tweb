"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { surfacePlan, surfaceResizeNeeded, COLLAPSED_HEIGHT } = require("./surface-policy.cjs");

const LOGICAL = { width: 1440, height: 900 };

test("the visible active tab keeps its full surface and paints", () => {
  const plan = surfacePlan(true, true, LOGICAL);
  assert.deepStrictEqual(plan, {
    painting: true,
    backgroundThrottling: false,
    width: 1440,
    height: 900,
  });
});

test("a background tab collapses its surface but keeps its width", () => {
  const plan = surfacePlan(false, true, LOGICAL);
  assert.strictEqual(plan.painting, false);
  assert.strictEqual(plan.width, 1440, "width drives layout and media queries");
  assert.strictEqual(plan.height, COLLAPSED_HEIGHT);
});

test("a hidden pane collapses the active tab too", () => {
  const plan = surfacePlan(true, false, LOGICAL);
  assert.strictEqual(plan.painting, false);
  assert.strictEqual(plan.width, 1440);
  assert.strictEqual(plan.height, COLLAPSED_HEIGHT);
});

test("a background tab in a hidden pane is collapsed, not doubly so", () => {
  assert.deepStrictEqual(surfacePlan(false, false, LOGICAL), surfacePlan(false, true, LOGICAL));
});

test("throttling is off exactly when the tab would paint", () => {
  assert.strictEqual(surfacePlan(true, true, LOGICAL).backgroundThrottling, false);
  assert.strictEqual(surfacePlan(false, true, LOGICAL).backgroundThrottling, true);
  assert.strictEqual(surfacePlan(true, false, LOGICAL).backgroundThrottling, true);
});

test("a viewport smaller than the collapsed height is never grown by collapsing", () => {
  const plan = surfacePlan(false, true, { width: 10, height: 1 });
  assert.strictEqual(plan.height, 1);
});

test("a missing or degenerate viewport still yields a usable size", () => {
  for (const viewport of [null, undefined, {}, { width: 0, height: 0 }, { width: -5, height: -5 }]) {
    const plan = surfacePlan(true, true, viewport);
    assert.ok(plan.width >= 1 && plan.height >= 1, `bad plan for ${JSON.stringify(viewport)}`);
  }
});

test("fractional viewports are rounded, since setContentSize takes integers", () => {
  const plan = surfacePlan(true, true, { width: 1439.6, height: 899.4 });
  assert.deepStrictEqual([plan.width, plan.height], [1440, 899]);
});

test("a resize is only needed when the size actually differs", () => {
  const plan = surfacePlan(true, true, LOGICAL);
  assert.strictEqual(surfaceResizeNeeded(plan, { width: 1440, height: 900 }), false);
  assert.strictEqual(surfaceResizeNeeded(plan, { width: 1440, height: 1 }), true);
  assert.strictEqual(surfaceResizeNeeded(plan, { width: 1280, height: 900 }), true);
});

test("an unknown current size always resizes rather than assuming", () => {
  assert.strictEqual(surfaceResizeNeeded(surfacePlan(true, true, LOGICAL), null), true);
});

test("collapse then restore returns exactly the original size", () => {
  const full = surfacePlan(true, true, LOGICAL);
  const collapsed = surfacePlan(false, true, LOGICAL);
  assert.strictEqual(surfaceResizeNeeded(collapsed, full), true);
  assert.strictEqual(surfaceResizeNeeded(full, collapsed), true);
  assert.strictEqual(surfaceResizeNeeded(full, surfacePlan(true, true, LOGICAL)), false);
});
