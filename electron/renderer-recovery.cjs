"use strict";

// What to do when a tab's render process goes away.
//
// Killing a renderer releases every byte it held — measured on a live pane: 4 processes to 3,
// IOSurface 18.0MB to 0.0MB, RSS -187MB — so DESIGN.md 6.5's "resource counts return to
// baseline after a renderer crash" was already met. What was not met is the page: nothing in
// the engine noticed, `tweb status` kept reporting a healthy pid, and the pane sat on a stale
// image until somebody typed a reload by hand. Chromium does not restart an offscreen
// renderer on its own, because there is no visible frame to trigger the reload path that a
// normal window gets.
//
// Reloading is the only recovery available, and an unbounded one is worse than none: a page
// that crashes its renderer on load would reload forever, each attempt spawning a process and
// repainting the pane. So attempts are counted inside a window and then given up on, which is
// also what a browser tab does before it shows "this page keeps crashing".

// Enough to ride out a one-off kill or an OOM under memory pressure, few enough that a page
// which crashes deterministically settles into an error page within a couple of seconds.
const MAX_ATTEMPTS = 3;
// Attempts older than this are forgotten, so a tab that crashed once an hour ago is still
// given a full budget rather than being penalised for ancient history.
const ATTEMPT_WINDOW_MS = 60_000;

// A renderer that exited cleanly was not lost — this is the ordinary teardown of a navigation
// or a closing tab, and reloading it would resurrect a page the user just left.
const CLEAN_EXIT = "clean-exit";

/**
 * Decides how to answer a `render-process-gone` event.
 *
 * Pure so the policy can be tested without killing real processes: the caller passes the
 * timestamps of its own earlier attempts and the current time.
 *
 * @param {string} reason `details.reason` from Electron
 * @param {number[]} attempts epoch-ms of previous recovery attempts for this tab
 * @param {number} now epoch-ms
 * @param {{maxAttempts?: number, windowMs?: number}} [limits]
 * @returns {{action: "ignore"|"reload"|"report", recent: number[]}} `recent` is the pruned
 *   attempt list the caller should keep, with this attempt appended when action is "reload"
 */
function recoveryDecision(reason, attempts, now, limits = {}) {
  const maxAttempts = limits.maxAttempts ?? MAX_ATTEMPTS;
  const windowMs = limits.windowMs ?? ATTEMPT_WINDOW_MS;
  const recent = (attempts || []).filter(
    (at) => Number.isFinite(at) && now - at < windowMs
  );
  if (reason === CLEAN_EXIT) return { action: "ignore", recent };
  // Giving up is reported rather than silent: a pane showing a stale image with no explanation
  // is the exact failure this module exists to end, and an error page at least names it.
  if (recent.length >= maxAttempts) return { action: "report", recent };
  return { action: "reload", recent: [...recent, now] };
}

module.exports = { recoveryDecision, MAX_ATTEMPTS, ATTEMPT_WINDOW_MS, CLEAN_EXIT };
