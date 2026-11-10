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
///
/// `standby` keeps a background tab of a visible pane at its full size, painting nothing. The
/// collapse is free to undo on Electron (above) but not on the Chrome engine: there a restore is
/// a metrics override, a headless window resize and a full relayout before the first capture.
/// Measured switching with `J`/`K` between an Electron and a Chrome tab (bench/feel.py
/// tab-switch, 1440x1800): to the Electron tab p50 7ms, to the collapsed Chrome tab 112–400ms.
/// A hidden pane still collapses every tab, so DESIGN.md 6.5's gate is unaffected.
function surfacePlan(active, terminalVisible, logical, held = false, floating = false, standby = false) {
  const width = Math.max(1, Math.round(logical?.width || 1));
  const height = Math.max(1, Math.round(logical?.height || 1));
  // A floating tab detaches its display from the tmux pane: the OS window is the
  // surface, not the Kitty graphics channel. It paints at full size regardless of
  // terminal visibility, because the user is looking at the OS window, not the pane.
  const painting = floating || Boolean(active && terminalVisible);
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
    height: laidOut || (standby && terminalVisible) ? height : Math.min(COLLAPSED_HEIGHT, height),
    // Passed through to applySurfacePlan so it knows to show the OS window.
    floating,
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
  "extensions",
  "status",
  "tabs",
  "tab",
  "tab-new",
  "tab-close",
  "console",
  "errors",
  "audio-sync",
  // A controller's heartbeat (agent-presence.cjs): it says who is linked, it does not look.
  "link",
  // `diag` reports the collapsed size as a fact about the pane. Restoring the surface to
  // answer it would make the one command that exists to describe engine state the one
  // command that changes it.
  "diag",
  // A recording observes what the user sees. Holding the surface open to start or stop one would
  // repaint a pane nobody is looking at, and those paints would be recorded as page changes.
  "record-start",
  "record-stop",
  "record-status",
]);

/// Whether `method` should hold the active tab's surface open while it runs.
function agentNeedsGeometry(method) {
  return typeof method === "string" && method.length > 0 && !GEOMETRY_FREE_METHODS.has(method);
}

// The script a restoring hold runs in the page, to wait until the restored size has
// actually been applied to the layout.
//
// Waiting for a paint at the restored size is not the same question. Measured on a hidden
// pane, `eval innerHeight` 600ms apart against a page whose real height is 300: the
// compositor delivered a correctly-sized 480px frame within 0-4ms every single time, while
// the renderer answered `innerHeight === 1` on 13 of 30 calls. Polling from the main
// process showed why — the layout takes ~380ms to catch up with `setContentSize`, and the
// frame arrives first. So the agent read a page laid out at one pixel and got an empty
// answer, which is the #22 symptom #24 was written to remove.
//
// The wait happens inside the renderer rather than as a poll from here: the `resize` event
// fires exactly when the new size reaches layout, so there is no round trip per attempt.
// Measured over 20 hidden `eval`s, p50 19ms against 396ms for the polling version, with
// both at 0/20 wrong answers.
//
// `timeoutMs` is a backstop inside the page. The caller needs its own as well — a page
// whose renderer is gone never runs this at all — see `withAgentSurface`.
function restoredLayoutScript(timeoutMs) {
  return `new Promise((resolve) => {
    if (innerHeight > ${COLLAPSED_HEIGHT}) return resolve("already");
    const settle = (how) => {
      removeEventListener("resize", onResize);
      clearTimeout(timer);
      resolve(how);
    };
    const onResize = () => { if (innerHeight > ${COLLAPSED_HEIGHT}) settle("resize"); };
    addEventListener("resize", onResize);
    const timer = setTimeout(() => settle("timeout"), ${Math.max(0, Math.round(timeoutMs) || 0)});
  })`;
}

// The script a restoring hold runs in the page, to wait until the renderer has produced a frame
// of its own since the surface came back.
//
// A restored surface hands out a frame of the right size within a millisecond, and that frame is
// the compositor's last one — drawn before the surface was collapsed. A hidden pane paints
// nothing between agent calls, so anything the page did since (an `eval`, a click, a timer) is
// not in it. Measured on a hidden pane: `eval` changes the background, the next `screenshot`
// answered with the old colour on 4 of 8 runs, and the hold closed again before the renderer had
// drawn anything, so the next call got the same old frame.
//
// Two animation frames is the signal that the renderer has run a full lifecycle at the restored
// size: the first runs the update that follows the resize, the second runs after that update's
// frame was committed. `timeoutMs` is a backstop for a page that never runs animation frames (a
// throttled background page); the caller then falls back to the first correctly sized paint, which
// is what it did before this wait existed.
function presentedFrameScript(timeoutMs) {
  return `new Promise((resolve) => {
    const settle = (how) => {
      clearTimeout(timer);
      resolve(how);
    };
    const timer = setTimeout(() => settle("timeout"), ${Math.max(0, Math.round(timeoutMs) || 0)});
    requestAnimationFrame(() => requestAnimationFrame(() => settle("frame")));
  })`;
}

// Whether a paint is the frame a restoring hold is waiting for: the size it restored to, and
// only once the renderer has presented a frame since (`presentedFrameScript`). A correctly sized
// paint before that is the compositor's cached pre-collapse frame.
function acceptsRestoredPaint(size, expected, presented) {
  return Boolean(presented) && size.width === expected.width && size.height === expected.height;
}

module.exports = {
  surfacePlan,
  surfaceResizeNeeded,
  paintingTransition,
  agentNeedsGeometry,
  restoredLayoutScript,
  presentedFrameScript,
  acceptsRestoredPaint,
  COLLAPSED_HEIGHT,
};

/// Whether a plan requires a `setContentSize` call. Reading before writing keeps a
/// per-second reconciler from re-issuing a resize that would invalidate the page's
/// layout for no reason.
function surfaceResizeNeeded(plan, current) {
  if (!current) return true;
  return plan.width !== current.width || plan.height !== current.height;
}

/// Which of `startPainting`/`stopPainting` the reconciler still has to call, or
/// `null` when the tab is already in the state the plan asks for.
///
/// Same read-before-write rule as `surfaceResizeNeeded`, and for a sharper reason:
/// `startPainting()` on a webContents that is *already* painting provokes a fresh
/// paint. Measured on Electron 43.2.0 over a settled static page, 8s windows:
///
///   touch nothing                      0 paints
///   setFrameRate(the same value) 1/s   0 paints
///   startPainting() 1/s                7 paints   (0.88/s)
///
/// The hidden-window watchdog reconciles once a second, so re-issuing it cost a
/// static idle page ~1 whole frame every second forever — measured end to end at
/// 126 frames over 120s of a page that was not changing, each one a 5.18MB raw
/// file write. DESIGN.md 7.7 gates on "0 frame transfers while a static page is
/// idle", and this is what stood between the pipeline and that number.
function paintingTransition(wantPainting, isPainting) {
  const want = Boolean(wantPainting);
  // An engine that cannot report its state gets the call, since issuing a
  // redundant one is recoverable and skipping a needed one leaves a pane blank.
  if (typeof isPainting !== "boolean") return want ? "start" : "stop";
  if (want === isPainting) return null;
  return want ? "start" : "stop";
}

