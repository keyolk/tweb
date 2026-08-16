"use strict";

// The window, tabs and frame-rate state one pane owns.
//
// Together with `frame-context.cjs` this is everything a pane needs that used to be a module-level
// variable in main.cjs. The split is by lifetime rather than by subject: a frame context is
// replaced wholesale when a pane's geometry generation moves on, while this outlives every resize
// and is destroyed only when the pane detaches.
//
// The Electron objects (`BrowserWindow`s) are held here but never *made* here — this module has no
// Electron import, so what a pane owns and what it does with it stay separately testable. The
// caller creates windows and hands them over.

/**
 * Creates the window/tab state for one pane.
 *
 * `frameRate` is the pane's own ceiling. It is per-pane rather than per-process because a host
 * serves panes with different `--tweb-frame-rate` settings, and because the adaptive tiers are
 * decided by counting *that pane's* paints — a shared counter would have a video in one pane hold
 * every other pane at the playback rate.
 */
function createPaneWindows({ maxFrameRate = 30, adaptive = true } = {}) {
  return {
    // The tab a pane is showing, and every tab it holds. `win` is one of `tabs`.
    win: null,
    tabs: [],
    closedTabs: [],
    activeTabIndex: -1,

    // The rate tier this pane is on, and the paint count the settle decides from.
    maxFrameRate,
    adaptive,
    activeFrameRate: maxFrameRate,
    frameIntervalMs: Math.ceil(1000 / maxFrameRate),
    frameIdleTimer: null,
    paintsSinceSettle: 0,

    // The agent's surface hold. A refcount rather than a flag because agent calls overlap — `wait`
    // polls for up to ten seconds while another command runs against the same pane — and it is
    // per-pane because one pane's agent call must not hold another pane's surface open, which
    // would undo the hidden-pane collapse for every pane at once.
    agentSurfaceHolds: 0,
    agentSurfaceHoldDeadline: 0,
    agentSurfaceFrame: null,
  };
}

/**
 * Whether this pane's surface is currently held open for an agent call.
 *
 * The deadline exists because a hold leaked by an exception would pin the surface open for the
 * life of the process, undoing the collapse for anyone who ever ran one agent command. Expiring
 * returns false *and* drops the outstanding count, so the leak costs bytes for a bounded window
 * rather than forever.
 */
function surfaceHeld(windows, now) {
  if (windows.agentSurfaceHolds <= 0) return { held: false, expired: false };
  if (now > windows.agentSurfaceHoldDeadline) {
    const outstanding = windows.agentSurfaceHolds;
    windows.agentSurfaceHolds = 0;
    return { held: false, expired: true, outstanding };
  }
  return { held: true, expired: false };
}

/** Opens a hold, extending the deadline. Returns the new depth. */
function holdSurface(windows, now, ttlMs) {
  windows.agentSurfaceHolds += 1;
  windows.agentSurfaceHoldDeadline = now + ttlMs;
  return windows.agentSurfaceHolds;
}

/**
 * Closes a hold. Reports whether that was the last one, which is when the surface may collapse
 * again — and when the frame kept for a screenshot may be dropped.
 *
 * The frame deliberately outlives an inner call: an overlapping one (a `wait` polling while a
 * screenshot runs) would otherwise be left holding null and fall back to the `capturePage` that
 * was measured failing intermittently during a restore.
 */
function releaseSurface(windows) {
  windows.agentSurfaceHolds = Math.max(0, windows.agentSurfaceHolds - 1);
  const last = windows.agentSurfaceHolds === 0;
  if (last) windows.agentSurfaceFrame = null;
  return last;
}

/**
 * Applies a frame rate, returning the interval to use, or null when the pane is already on it.
 *
 * Suppressing the no-op matters beyond saving a syscall: `setFrameRate` provokes a paint of its
 * own, and the playback tier is decided by counting paints over a window — so re-applying the
 * current tier would feed the detector paints it caused itself.
 */
function applyFrameRate(windows, rate) {
  const next = Math.min(windows.maxFrameRate, Math.max(1, Math.round(rate)));
  if (!Number.isFinite(next)) return null;
  if (windows.activeFrameRate === next) return null;
  const previous = windows.activeFrameRate;
  windows.activeFrameRate = next;
  windows.frameIntervalMs = Math.ceil(1000 / next);
  return { previous, rate: next, intervalMs: windows.frameIntervalMs };
}

/** Whether this pane is below its ceiling, i.e. whether coming back up needs a repaint. */
function isThrottled(windows) {
  return windows.activeFrameRate !== windows.maxFrameRate;
}

module.exports = {
  createPaneWindows,
  surfaceHeld,
  holdSurface,
  releaseSurface,
  applyFrameRate,
  isThrottled,
};
