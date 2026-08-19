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

// How many bytes of whole frames a playing pane may push per second.
//
// Every whole frame is `width * height * 4` bytes written to a file and read back by the
// terminal, and the rate did not depend on the size — so a big pane cost several times what a
// small one did while both sat at the same 30fps. Measured on this machine, across the pane
// sizes actually observed in one session:
//
//     980x456    1.79 MB/frame     53.6 MB/s at 30fps
//     1280x646   3.31 MB/frame     99.2 MB/s
//     1680x1026  6.89 MB/frame    206.8 MB/s
//
// 3.9x the bytes for the same picture rate. That is why the delay a user feels tracks BOTH
// whether a video is playing and how large the pane is: the two multiply.
//
// 60MB/s is the smallest budget that leaves the smallest observed pane alone. 980x456 at the
// full 30fps IS 53.6MB/s, so anything under ~54MB/s starts docking a pane that was never the
// problem — 50MB/s was tried first and took it to 28fps, which buys nothing and costs a
// visibly worse picture. At 60MB/s the sizes that actually hurt come down hard:
//
//     980x456     30fps  (unchanged)
//     1280x646    18fps  (was 30)
//     1680x932    10fps  (was 30)
//     1680x1026    9fps  (was 30)
//
// Overridable, because the right value depends on what else the machine is doing and that is
// not knowable from here: `TWEB_PLAYBACK_BUDGET=120000000` restores something near the old
// behaviour on a machine with headroom.
const PLAYBACK_BYTE_BUDGET = Number.parseInt(process.env.TWEB_PLAYBACK_BUDGET || "", 10) || 60e6;

// A floor, because a budget alone would take a very large pane to 1fps and a video at 1fps is
// not a picture. Below this the pane is better off dropping frames than pretending.
const PLAYBACK_MIN_RATE = 8;

const BYTES_PER_PIXEL = 4;

/**
 * The playback rate for a pane of a given size.
 *
 * `area` is in device pixels — the size a whole frame actually is, not the CSS viewport, since
 * the bytes are what this bounds. An unusable area yields the ceiling, which is the behaviour
 * before this budget existed: a rate policy must not be the thing that blanks a pane.
 *
 * @param {number} area width * height in device pixels
 * @param {number} max the pane's configured ceiling
 */
function playbackRateForArea(area, max) {
  const pixels = Number(area);
  if (!Number.isFinite(pixels) || pixels <= 0) return max;
  const affordable = Math.round(PLAYBACK_BYTE_BUDGET / (pixels * BYTES_PER_PIXEL));
  return Math.min(max, Math.max(Math.min(PLAYBACK_MIN_RATE, max), affordable));
}

/**
 * Rates for a given configuration.
 *
 * Playback is bounded by bytes, not by a fixed number. It was capped at 15 when this tier was
 * introduced, then raised to the full rate: measured on YouTube, the pipeline carried 28.2fps
 * against a 30fps cap with nothing dropped, so the cap looked like it was protecting against a
 * limit that did not exist.
 *
 * That measurement was right about the pipeline and silent about the machine. What it watched
 * was tweb's own counters — `dropped` stayed at 0 — while the cost was being paid somewhere it
 * was not looking. Measured again, 240 samples with a pane playing and then stopping: Ghostty's
 * CPU tracks the frame rate up and down with no residue, nothing accumulates, and the load is
 * simply proportional to bytes/second. On a machine with no headroom that proportion is what
 * delays input to OTHER tmux panes, and it scales with the pane's area — which is why the
 * report was "it depends on whether a video is playing AND how big the pane is".
 *
 * So the cap is back, as a budget rather than a number: a small pane still gets the full rate,
 * and a large one gets what fits. `area` omitted keeps the previous behaviour, since the
 * startup config has no viewport yet.
 *
 * @param {number} maxRate the configured maximum, 1-60
 * @param {boolean} adaptive false pins everything to the maximum
 * @param {number} [area] the pane's frame size in device pixels, when known
 */
function frameRateTiers(maxRate, adaptive, area) {
  const max = Math.min(60, Math.max(1, Math.round(maxRate) || 1));
  if (!adaptive) return { max, playback: max, idle: max };
  return {
    max,
    playback: area === undefined ? max : playbackRateForArea(area, max),
    idle: Math.min(max, 4),
  };
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

module.exports = {
  frameRateTiers, playbackWindowMs, settledFrameRate, playbackRateForArea,
  PLAYBACK_MIN_PAINTS, PLAYBACK_MIN_RATE, PLAYBACK_BYTE_BUDGET,
};
