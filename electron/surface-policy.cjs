"use strict";

// How large an offscreen BrowserWindow's surface should be, given what the pane is
// actually showing.
//
// Measured on Electron 43.2.0, four offscreen windows at 1440x900 deviceScaleFactor 2,
// gpu-process phys_footprint:
//
//   0 windows                          91MB
//   1 / 2 / 3 / 4 windows   92 / 166 / 233 / 300MB     ~70MB per additional window
//   stopPainting() on the three background windows     279MB   (-7MB each)
//   setContentSize(width, 1) on the same three         162MB   (-39MB each)
//   destroying them instead                             97MB
//
// A window that paints nothing still owns its compositor surface, and `stopPainting`
// does not give it back — only shrinking the surface does. DESIGN.md 6.5 gates a
// release on "a hidden page's GPU/SHM surface bytes converge to 0", and this is the
// mechanism that moves them.
//
// The collapsed size keeps the full width. Layout and media queries are width-driven,
// so a 1x1 window reflows the document to a different one: measured on a scrolled
// Wikipedia article, collapsing to 1x1 took scrollHeight from 9579 to 319477, while
// collapsing to width x 1 left both scrollHeight and scrollY byte-identical. Restoring
// the surface produces a correctly sized frame within about a millisecond, so a tab
// switch pays no visible cost for having been collapsed.
const COLLAPSED_HEIGHT = 1;

/// What a tab's offscreen window should be doing right now.
///
/// `active` is whether this tab is the one the pane displays; `terminalVisible` is
/// whether any terminal client is looking at the pane at all. Only a tab that is both
/// gets a full-size surface — a background tab and a hidden pane are the same thing as
/// far as the compositor is concerned, and neither can put a pixel on screen.
///
/// `held` overrides the collapse for the active tab: an agent is reading the page and
/// needs it laid out at its real size. See `agentNeedsGeometry` for why.
function surfacePlan(active, terminalVisible, logical, held = false) {
  const width = Math.max(1, Math.round(logical?.width || 1));
  const height = Math.max(1, Math.round(logical?.height || 1));
  const painting = Boolean(active && terminalVisible);
  // A held tab is laid out and painting even though nobody is watching the pane. It costs
  // the surface bytes back for the length of one agent call, which is the price of the
  // call returning the page instead of a one-pixel strip of it.
  const laidOut = painting || Boolean(active && held);
  return {
    painting: laidOut,
    // Chromium throttles a window it believes is in the background; the pane is this
    // window's foreground, so throttling is turned off exactly when it would paint.
    backgroundThrottling: !laidOut,
    width,
    height: laidOut ? height : Math.min(COLLAPSED_HEIGHT, height),
  };
}

// Which agent methods need the page laid out at its real size.
//
// A hidden pane collapses its surface to width x 1 to give the GPU bytes back (DESIGN.md
// 6.5), and that collapse is invisible to the human — the pane is not on screen anyway.
// It is not invisible to an agent: at innerHeight=1 every element falls outside the
// viewport, so `snapshot` returns no refs, `screenshot` returns a two-pixel strip and
// `click` has nothing to aim at. All of them succeed and return emptiness, which reads as
// "the page is blank" rather than "the surface is collapsed".
//
// The rule is deliberately broad rather than a curated list. `eval` is arbitrary
// JavaScript and routinely reads layout; `wait` polls for a selector or for body text.
// Anything that reaches the page at all is assumed to care. What is excluded is only what
// demonstrably cannot: engine bookkeeping, tab and history plumbing, and the console
// buffer, none of which touch the renderer's layout.
const GEOMETRY_FREE_METHODS = new Set([
  "engine-log",
  "status",
  "tabs",
  "tab",
  "tab-new",
  "tab-close",
  "console",
  "errors",
  "audio-sync",
  // `diag` reports the collapsed size as a fact about the pane. Restoring the surface to
  // answer it would make the one command that exists to describe engine state the one
  // command that changes it.
  "diag",
]);

/// Whether `method` should hold the active tab's surface open while it runs.
function agentNeedsGeometry(method) {
  return typeof method === "string" && method.length > 0 && !GEOMETRY_FREE_METHODS.has(method);
}

module.exports = { surfacePlan, surfaceResizeNeeded, agentNeedsGeometry, COLLAPSED_HEIGHT };

/// Whether a plan requires a `setContentSize` call. Reading before writing keeps a
/// per-second reconciler from re-issuing a resize that would invalidate the page's
/// layout for no reason.
function surfaceResizeNeeded(plan, current) {
  if (!current) return true;
  return plan.width !== current.width || plan.height !== current.height;
}

