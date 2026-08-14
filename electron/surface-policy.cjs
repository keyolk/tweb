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
function surfacePlan(active, terminalVisible, logical) {
  const width = Math.max(1, Math.round(logical?.width || 1));
  const height = Math.max(1, Math.round(logical?.height || 1));
  const painting = Boolean(active && terminalVisible);
  return {
    painting,
    // Chromium throttles a window it believes is in the background; the pane is this
    // window's foreground, so throttling is turned off exactly when it would paint.
    backgroundThrottling: !painting,
    width,
    height: painting ? height : Math.min(COLLAPSED_HEIGHT, height),
  };
}

/// Whether a plan requires a `setContentSize` call. Reading before writing keeps a
/// per-second reconciler from re-issuing a resize that would invalidate the page's
/// layout for no reason.
function surfaceResizeNeeded(plan, current) {
  if (!current) return true;
  return plan.width !== current.width || plan.height !== current.height;
}

module.exports = { surfacePlan, surfaceResizeNeeded, COLLAPSED_HEIGHT };
