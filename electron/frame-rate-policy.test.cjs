"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  frameRateTiers,
  playbackWindowMs,
  settledFrameRate,
  playbackRateForArea,
  interactionRate,
  PLAYBACK_MIN_PAINTS,
  PLAYBACK_MIN_RATE,
  PLAYBACK_BYTE_BUDGET,
} = require("./frame-rate-policy.cjs");

test("adaptive mode has three tiers, fixed mode has one", () => {
  const adaptive = frameRateTiers(30, true);
  assert.deepEqual(adaptive, { max: 30, playback: 30, idle: 4 });

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
    assert.deepEqual(settledFrameRate(paints, tiers), { rate: 30, painting: true });
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

// --- the playback budget ---
//
// These pin the property the budget exists for, not the arithmetic: the cost of a playing pane
// is `area * 4 * rate` bytes per second, and the user's report was that the delay tracks BOTH
// whether a video plays and how big the pane is. A rate that ignores area is what made those two
// multiply.

test("a small pane keeps the full playback rate", () => {
  // 980x456, the smallest size actually observed: 1.79MB a frame, so 30fps fits in the budget
  // with room to spare. The budget must not be a tax on panes that were never the problem.
  assert.equal(playbackRateForArea(980 * 456, 30), 30);
});

test("a large pane is slowed in proportion to its bytes", () => {
  // 1680x1026 is 3.9x the pixels of 980x456. At a fixed rate that was 3.9x the bytes for the
  // same picture; under a budget it is a lower rate for the same bytes.
  const small = playbackRateForArea(980 * 456, 30);
  const large = playbackRateForArea(1680 * 1026, 30);
  assert.ok(large < small, `expected ${large} < ${small}`);
  // The bytes each is allowed are within rounding of each other — that is the whole claim.
  const smallBytes = 980 * 456 * 4 * small;
  const largeBytes = 1680 * 1026 * 4 * large;
  assert.ok(Math.abs(smallBytes - largeBytes) < PLAYBACK_BYTE_BUDGET * 0.35,
    `${smallBytes} vs ${largeBytes}`);
});

test("the rate never falls below the floor, however large the pane", () => {
  // A budget alone would take an enormous pane to 1fps, and a video at 1fps is not a picture.
  assert.equal(playbackRateForArea(8000 * 8000, 30), PLAYBACK_MIN_RATE);
});

test("an unusable area yields the ceiling rather than a blank pane", () => {
  // A rate policy must not be the thing that stops a pane painting. Before a viewport exists
  // there is no area to bound by, and the answer has to be the previous behaviour.
  for (const area of [0, -1, NaN, undefined, null]) {
    assert.equal(playbackRateForArea(area, 30), 30, `area ${area}`);
  }
});

test("tiers without an area keep the pre-budget behaviour", () => {
  // The startup config has no viewport. NEGATIVE CONTROL: this is the exact call the old code
  // made, and it must still answer the way it did — otherwise the budget has changed something
  // it was never meant to reach.
  assert.deepEqual(frameRateTiers(30, true), { max: 30, playback: 30, idle: 4 });
});

test("fixed mode ignores the budget entirely", () => {
  // `--tweb-adaptive-frame-rate 0` is a user saying "give me this rate". A budget that overrode
  // it would make the flag a suggestion.
  assert.deepEqual(frameRateTiers(30, false, 1680 * 1026), { max: 30, playback: 30, idle: 30 });
});

test("a configured maximum below the floor is still honoured", () => {
  // `--tweb-frame-rate 5` on a huge pane: the floor must not raise a rate the user capped.
  assert.equal(playbackRateForArea(8000 * 8000, 5), 5);
});

// --- the interaction cap ---
//
// The budget bounds what a self-painting page pushes, and interaction lifted that bound: a
// hover or a resize raised the pane to the maximum for 700ms. Measured on a 1130x1046 pane,
// 46 raises during one video, 38 of them from the settle's own `isLoading` branch rather than
// from anything the user did.

test("an interaction cannot lift the playback bound while the page is painting", () => {
  const tiers = frameRateTiers(30, true, 1130 * 1046);
  assert.ok(tiers.playback < 30, "the fixture must be a pane the budget actually bounds");
  assert.equal(interactionRate(true, tiers), tiers.playback);
});

test("an interaction with a page that is not painting still gets the maximum", () => {
  // A keystroke on a static page has to echo at once, and a static page pushes one frame, not
  // a stream of them. Capping here would be a regression with nothing to show for it.
  const tiers = frameRateTiers(30, true, 1130 * 1046);
  assert.equal(interactionRate(false, tiers), 30);
});

test("a pane the budget does not bind is unaffected either way", () => {
  // NEGATIVE CONTROL: on a small pane playback IS the maximum, so the cap must be invisible.
  const tiers = frameRateTiers(30, true, 980 * 456);
  assert.equal(tiers.playback, 30);
  assert.equal(interactionRate(true, tiers), 30);
  assert.equal(interactionRate(false, tiers), 30);
});

test("fixed mode is untouched by the cap", () => {
  // `--tweb-adaptive-frame-rate 0` means "this rate, always". Every tier is the maximum there,
  // so painting or not, the answer is the rate the user asked for.
  const tiers = frameRateTiers(30, false, 1680 * 1026);
  assert.equal(interactionRate(true, tiers), 30);
});
