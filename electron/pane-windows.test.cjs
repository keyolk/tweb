"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createPaneWindows, surfaceHeld, holdSurface, releaseSurface, applyFrameRate, isThrottled,
} = require("./pane-windows.cjs");

const TTL = 30_000;

test("a pane starts with no window, no tabs and its own rate ceiling", () => {
  const windows = createPaneWindows({ maxFrameRate: 30 });
  assert.equal(windows.win, null);
  assert.deepEqual(windows.tabs, []);
  assert.equal(windows.activeTabIndex, -1);
  assert.equal(windows.activeFrameRate, 30);
  assert.equal(windows.frameIntervalMs, 34);
});

// A host serves panes launched with different --tweb-frame-rate settings, and the adaptive tiers
// are decided by counting THAT pane's paints. A shared ceiling would have a video in one pane hold
// every other pane at the playback rate.
test("two panes keep their own ceilings", () => {
  const fast = createPaneWindows({ maxFrameRate: 60 });
  const slow = createPaneWindows({ maxFrameRate: 10 });
  applyFrameRate(fast, 60);
  applyFrameRate(slow, 60);
  assert.equal(fast.activeFrameRate, 60);
  assert.equal(slow.activeFrameRate, 10, "a rate above the ceiling is clamped to it");
});

// setFrameRate provokes a paint of its own, and the playback tier is decided by counting paints
// over a window — so re-applying the current tier feeds the detector its own noise.
test("re-applying the current rate is suppressed", () => {
  const windows = createPaneWindows({ maxFrameRate: 30 });
  assert.equal(applyFrameRate(windows, 30), null);
  assert.deepEqual(applyFrameRate(windows, 4), { previous: 30, rate: 4, intervalMs: 250 });
  assert.equal(applyFrameRate(windows, 4), null);
  assert.equal(isThrottled(windows), true);
  applyFrameRate(windows, 30);
  assert.equal(isThrottled(windows), false);
});

test("a rate below one is clamped, because a zero interval is not a frame rate", () => {
  const windows = createPaneWindows({ maxFrameRate: 30 });
  assert.equal(applyFrameRate(windows, 0).rate, 1);
  assert.equal(windows.frameIntervalMs, 1000);
});

// Agent calls overlap: `wait` polls for up to ten seconds while another command runs against the
// same pane. A flag would collapse on the first release and let the surface go while a call was
// still reading it.
test("holds are counted, so an overlapping call does not drop the surface", () => {
  const windows = createPaneWindows();
  holdSurface(windows, 1000, TTL);
  holdSurface(windows, 1200, TTL);
  assert.equal(surfaceHeld(windows, 1300).held, true);
  assert.equal(releaseSurface(windows), false, "one call ending is not the last one");
  assert.equal(surfaceHeld(windows, 1400).held, true);
  assert.equal(releaseSurface(windows), true);
  assert.equal(surfaceHeld(windows, 1500).held, false);
});

// A hold leaked by an exception would pin the surface open for the life of the process, undoing
// the hidden-pane collapse for anyone who ever ran one agent command.
test("a leaked hold expires rather than pinning the surface open forever", () => {
  const windows = createPaneWindows();
  holdSurface(windows, 1000, TTL);
  const expired = surfaceHeld(windows, 1000 + TTL + 1);
  assert.equal(expired.held, false);
  assert.equal(expired.expired, true);
  assert.equal(expired.outstanding, 1);
  // Reported once: the caller logs it, and the next tick must not repeat the complaint.
  assert.deepEqual(surfaceHeld(windows, 1000 + TTL + 2), { held: false, expired: false });
});

// The frame kept for a screenshot outlives an inner call, so an overlapping one is not left
// holding null and falling back to the capturePage that failed intermittently during a restore.
test("the restored frame is dropped only with the last hold", () => {
  const windows = createPaneWindows();
  holdSurface(windows, 1000, TTL);
  holdSurface(windows, 1000, TTL);
  windows.agentSurfaceFrame = { fake: "frame" };
  releaseSurface(windows);
  assert.deepEqual(windows.agentSurfaceFrame, { fake: "frame" });
  releaseSurface(windows);
  assert.equal(windows.agentSurfaceFrame, null);
});

// One pane's agent call must not hold another pane's surface open — that would undo the collapse
// for every pane at once rather than for the one being driven.
test("one pane's hold does not touch another's", () => {
  const driven = createPaneWindows();
  const idle = createPaneWindows();
  holdSurface(driven, 1000, TTL);
  assert.equal(surfaceHeld(driven, 1100).held, true);
  assert.equal(surfaceHeld(idle, 1100).held, false);
});

test("releasing a hold that is not there does not go negative", () => {
  const windows = createPaneWindows();
  assert.equal(releaseSurface(windows), true);
  assert.equal(windows.agentSurfaceHolds, 0);
});

// The point of the extraction, asserted directly: two panes hold entirely separate window, tab,
// rate and surface state. Anything shared here is one pane's tab list, rate ceiling or restored
// surface being applied to another — which shows up as the wrong page in a pane rather than as an
// error.
test("two panes share nothing", () => {
  const left = createPaneWindows({ maxFrameRate: 30 });
  const right = createPaneWindows({ maxFrameRate: 30 });
  left.win = { id: "left" };
  left.tabs.push(left.win);
  left.activeTabIndex = 0;
  applyFrameRate(left, 4);
  holdSurface(left, 1000, TTL);

  assert.equal(right.win, null);
  assert.deepEqual(right.tabs, []);
  assert.equal(right.activeTabIndex, -1);
  assert.equal(right.activeFrameRate, 30, "one pane going idle must not throttle another");
  assert.equal(surfaceHeld(right, 1100).held, false);
});
