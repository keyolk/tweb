"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  frameRateTiers,
  playbackWindowMs,
  settledFrameRate,
  PLAYBACK_MIN_PAINTS,
} = require("./frame-rate-policy.cjs");

test("adaptive mode has three tiers, fixed mode has one", () => {
  const adaptive = frameRateTiers(30, true);
  assert.deepEqual(adaptive, { max: 30, playback: 15, idle: 4 });

  const fixed = frameRateTiers(30, false);
  assert.deepEqual(fixed, { max: 30, playback: 30, idle: 30 });
});

test("no tier ever exceeds the configured maximum", () => {
  // A pane asking for 5fps must not get a 15fps playback tier.
  assert.deepEqual(frameRateTiers(5, true), { max: 5, playback: 5, idle: 4 });
  assert.deepEqual(frameRateTiers(2, true), { max: 2, playback: 2, idle: 2 });
  assert.deepEqual(frameRateTiers(1, true), { max: 1, playback: 1, idle: 1 });
  // And the range is clamped at both ends.
  assert.equal(frameRateTiers(600, true).max, 60);
  assert.equal(frameRateTiers(0, true).max, 1);
});

// The window has to be long enough that a page painting at the idle rate still clears the
// threshold. Otherwise the judgement is self-defeating: at 4fps a half-second window sees
// two paints, so an animation would be pinned to idle by the rate it should climb out of.
test("the window outlasts the paints the threshold needs at the idle rate", () => {
  for (const idle of [1, 2, 4, 10, 15]) {
    const window = playbackWindowMs(idle);
    const paintsInWindow = (window / 1000) * idle;
    assert.ok(paintsInWindow >= PLAYBACK_MIN_PAINTS,
      `at ${idle}fps a ${window}ms window only sees ${paintsInWindow} paints`);
  }
});

test("the window never drops below a human-scale interval", () => {
  // A fast idle rate would otherwise compute a window short enough to judge on noise.
  assert.ok(playbackWindowMs(60) >= 1500);
});

// Measured over a 1.5s window against real pages: a static page produces 0-1 paints, an
// animating one produces 6 even while pinned at the idle rate, and 19 at the playback rate.
test("measured paint counts land on the right side of the threshold", () => {
  const tiers = frameRateTiers(30, true);
  const staticPage = [0, 1];
  const animating = [6, 19];
  for (const paints of staticPage) {
    assert.deepEqual(settledFrameRate(paints, tiers), { rate: 4, painting: false });
  }
  for (const paints of animating) {
    assert.deepEqual(settledFrameRate(paints, tiers), { rate: 15, painting: true });
  }
});

test("a settle that finds painting keeps watching, one that does not stops", () => {
  const tiers = frameRateTiers(30, true);
  // `painting` is what re-arms the timer: a video that ends has to fall the rest of the
  // way, so the watch cannot simply stay on once it starts.
  assert.equal(settledFrameRate(PLAYBACK_MIN_PAINTS, tiers).painting, true);
  assert.equal(settledFrameRate(PLAYBACK_MIN_PAINTS - 1, tiers).painting, false);
});

test("fixed mode settles to the maximum either way", () => {
  const tiers = frameRateTiers(24, false);
  assert.equal(settledFrameRate(0, tiers).rate, 24);
  assert.equal(settledFrameRate(50, tiers).rate, 24);
});
