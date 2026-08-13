"use strict";

// The adaptive frame-rate policy.
//
// Three rates, and the whole question is which one a moment belongs to:
//
//   active    the maximum, right after terminal input or a resize
//   playback  a page painting on its own — video, an animation, a canvas
//   idle      nothing is changing
//
// Playback used to not exist: only terminal input extended the active window, so a video
// fell to the idle rate like a static page and played at 4fps. That was the right trade
// when a frame cost 28-100ms of main-thread encode and continuous playback would have
// saturated the pane. A frame now costs ~1.4ms there, so the reason is gone — but the
// bytes are still real (every frame is written to disk), and playback is the one case that
// runs unbounded, so it holds a middle rate rather than the maximum.
//
// Deciding "is the page painting on its own" is the delicate part, because the decision
// perturbs what it measures: `setFrameRate` provokes a paint of its own. Counting paints
// over a window and requiring several of them separates the cases — measured over a 1.5s
// window, a static page produces 0-1 paints and an animating one produces 6 even while
// pinned at the idle rate.

// Enough paints to mean the page is driving them, not the rate change or a stray hover.
const PLAYBACK_MIN_PAINTS = 4;

/**
 * Rates for a given configuration.
 *
 * Playback gets the full rate. It was capped at 15 when this tier was introduced, on the
 * theory that continuous playback is the one workload that runs unbounded and should stay
 * bounded under the interactive path. Measured on YouTube afterwards, the pipeline carries
 * 28.2fps against a 30fps cap with nothing dropped — so the cap was not protecting against
 * a limit that exists, it was just a worse picture. The tier still matters: it is what
 * separates a page that is painting from one that has stopped, and the idle rate is where
 * the saving actually comes from.
 *
 * @param {number} maxRate the configured maximum, 1-60
 * @param {boolean} adaptive false pins everything to the maximum
 */
function frameRateTiers(maxRate, adaptive) {
  const max = Math.min(60, Math.max(1, Math.round(maxRate) || 1));
  if (!adaptive) return { max, playback: max, idle: max };
  return { max, playback: max, idle: Math.min(max, 4) };
}

/**
 * How long to wait before judging again.
 *
 * Long enough that a page painting at the *idle* rate still clears the threshold — at 4fps
 * a half-second window only ever sees two paints, so a short window would pin an animation
 * to idle by the very rate it should be climbing out of.
 */
function playbackWindowMs(idleRate) {
  return Math.max(1500,
    Math.ceil((PLAYBACK_MIN_PAINTS + 2) * 1000 / Math.max(1, Math.round(idleRate) || 1)));
}

/**
 * The rate to settle on, given how many paints arrived over the window that just ended.
 *
 * @param {number} paints paints since the last settle
 * @param {{playback: number, idle: number}} tiers from `frameRateTiers`
 * @returns {{rate: number, painting: boolean}} `painting` is whether to keep watching
 */
function settledFrameRate(paints, tiers) {
  const painting = paints >= PLAYBACK_MIN_PAINTS;
  return { rate: painting ? tiers.playback : tiers.idle, painting };
}

module.exports = { frameRateTiers, playbackWindowMs, settledFrameRate, PLAYBACK_MIN_PAINTS };
