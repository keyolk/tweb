"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const {
  surfacePlan, surfaceResizeNeeded, paintingTransition, agentNeedsGeometry,
  restoredLayoutScript, presentedFrameScript, acceptsRestoredPaint, COLLAPSED_HEIGHT,
} = require("./surface-policy.cjs");

const LOGICAL = { width: 1440, height: 900 };

test("the visible active tab keeps its full surface and paints", () => {
  const plan = surfacePlan(true, true, LOGICAL);
  assert.deepStrictEqual(plan, {
    painting: true,
    backgroundThrottling: false,
    width: 1440,
    height: 900,
    floating: false,
  });
});

test("a background tab collapses its surface but keeps its width", () => {
  const plan = surfacePlan(false, true, LOGICAL);
  assert.strictEqual(plan.painting, false);
  assert.strictEqual(plan.width, 1440, "width drives layout and media queries");
  assert.strictEqual(plan.height, COLLAPSED_HEIGHT);
});

test("a hidden pane collapses the active tab too", () => {
  const plan = surfacePlan(true, false, LOGICAL);
  assert.strictEqual(plan.painting, false);
  assert.strictEqual(plan.width, 1440);
  assert.strictEqual(plan.height, COLLAPSED_HEIGHT);
});

test("a background tab in a hidden pane is collapsed, not doubly so", () => {
  assert.deepStrictEqual(surfacePlan(false, false, LOGICAL), surfacePlan(false, true, LOGICAL));
});

test("a standby background tab of a visible pane keeps its full size but does not paint", () => {
  const plan = surfacePlan(false, true, LOGICAL, false, false, true);
  assert.strictEqual(plan.painting, false);
  assert.strictEqual(plan.height, 900, "a Chrome-engine tab pays a relayout to come back from a collapse");
});

test("a hidden pane collapses a standby tab like any other", () => {
  assert.strictEqual(surfacePlan(false, false, LOGICAL, false, false, true).height, COLLAPSED_HEIGHT);
  assert.strictEqual(surfacePlan(true, false, LOGICAL, false, false, true).height, COLLAPSED_HEIGHT);
});

test("throttling is off exactly when the tab would paint", () => {
  assert.strictEqual(surfacePlan(true, true, LOGICAL).backgroundThrottling, false);
  assert.strictEqual(surfacePlan(false, true, LOGICAL).backgroundThrottling, true);
  assert.strictEqual(surfacePlan(true, false, LOGICAL).backgroundThrottling, true);
});

test("a viewport smaller than the collapsed height is never grown by collapsing", () => {
  const plan = surfacePlan(false, true, { width: 10, height: 1 });
  assert.strictEqual(plan.height, 1);
});

test("a missing or degenerate viewport still yields a usable size", () => {
  for (const viewport of [null, undefined, {}, { width: 0, height: 0 }, { width: -5, height: -5 }]) {
    const plan = surfacePlan(true, true, viewport);
    assert.ok(plan.width >= 1 && plan.height >= 1, `bad plan for ${JSON.stringify(viewport)}`);
  }
});

test("fractional viewports are rounded, since setContentSize takes integers", () => {
  const plan = surfacePlan(true, true, { width: 1439.6, height: 899.4 });
  assert.deepStrictEqual([plan.width, plan.height], [1440, 899]);
});

test("a resize is only needed when the size actually differs", () => {
  const plan = surfacePlan(true, true, LOGICAL);
  assert.strictEqual(surfaceResizeNeeded(plan, { width: 1440, height: 900 }), false);
  assert.strictEqual(surfaceResizeNeeded(plan, { width: 1440, height: 1 }), true);
  assert.strictEqual(surfaceResizeNeeded(plan, { width: 1280, height: 900 }), true);
});

test("an unknown current size always resizes rather than assuming", () => {
  assert.strictEqual(surfaceResizeNeeded(surfacePlan(true, true, LOGICAL), null), true);
});

test("collapse then restore returns exactly the original size", () => {
  const full = surfacePlan(true, true, LOGICAL);
  const collapsed = surfacePlan(false, true, LOGICAL);
  assert.strictEqual(surfaceResizeNeeded(collapsed, full), true);
  assert.strictEqual(surfaceResizeNeeded(full, collapsed), true);
  assert.strictEqual(surfaceResizeNeeded(full, surfacePlan(true, true, LOGICAL)), false);
});

// An agent driving a pane in a tmux window nobody is viewing used to get a 554x2
// screenshot and a snapshot with zero refs, because the collapsed surface laid the page
// out at innerHeight=1 and every element fell outside the viewport.
test("a hold lays the active tab out at full size even while the pane is hidden", () => {
  const held = surfacePlan(true, false, LOGICAL, true);
  assert.strictEqual(held.height, 900);
  assert.strictEqual(held.painting, true, "capturePage needs the window painting");
  assert.strictEqual(held.backgroundThrottling, false);
});

test("a hold does not inflate a background tab", () => {
  // Only the tab the agent actually drives is worth the bytes; the rest of the window's
  // tabs stay collapsed exactly as they were.
  assert.deepStrictEqual(
    surfacePlan(false, false, LOGICAL, true),
    surfacePlan(false, false, LOGICAL, false)
  );
});

test("a hold changes nothing for a pane that is already visible", () => {
  assert.deepStrictEqual(
    surfacePlan(true, true, LOGICAL, true),
    surfacePlan(true, true, LOGICAL, false)
  );
});

test("the hold defaults off, so a caller that never heard of it collapses as before", () => {
  assert.deepStrictEqual(surfacePlan(true, false, LOGICAL), surfacePlan(true, false, LOGICAL, false));
  assert.strictEqual(surfacePlan(true, false, LOGICAL).height, COLLAPSED_HEIGHT);
});

test("every method that reaches the page holds the surface open", () => {
  for (const method of [
    "snapshot", "query", "info", "act", "eval", "wait", "screenshot",
    "press", "type", "navigate", "back", "forward", "reload",
  ]) {
    assert.strictEqual(agentNeedsGeometry(method), true, method);
  }
});

test("engine bookkeeping does not pay for a surface it cannot use", () => {
  for (const method of [
    "diag", "engine-log", "status", "tabs", "tab", "tab-new", "tab-close",
    "console", "errors", "audio-sync",
  ]) {
    assert.strictEqual(agentNeedsGeometry(method), false, method);
  }
});

// A method nobody anticipated is far more likely to read layout than not, and holding a
// surface it did not need costs one collapse cycle rather than an empty result.
test("an unknown method is assumed to need geometry", () => {
  assert.strictEqual(agentNeedsGeometry("some-future-method"), true);
});

test("a non-method is not a method", () => {
  for (const value of [null, undefined, "", 42, {}]) {
    assert.strictEqual(agentNeedsGeometry(value), false, JSON.stringify(value));
  }
});

// --- paintingTransition ---
//
// The reconciler behind these runs once a second for the life of the pane, so what
// matters is what it does when nothing has changed. `startPainting()` on a tab that is
// already painting provokes a paint (measured: 0.88/s on a settled static page), and a
// paint is a whole 5.18MB frame — so a no-op tick has to actually be a no-op.

test("a tab already in the state the plan asks for is left alone", () => {
  assert.strictEqual(paintingTransition(true, true), null);
  assert.strictEqual(paintingTransition(false, false), null);
});

test("only a real transition issues a call", () => {
  assert.strictEqual(paintingTransition(true, false), "start");
  assert.strictEqual(paintingTransition(false, true), "stop");
});

test("an engine that cannot report its state still gets told what to do", () => {
  // Older Electron has no `isPainting`. A redundant call there costs what it always
  // cost; skipping a needed one would leave the pane blank, which is worse.
  for (const unknown of [null, undefined, "yes", 1]) {
    assert.strictEqual(paintingTransition(true, unknown), "start", String(unknown));
    assert.strictEqual(paintingTransition(false, unknown), "stop", String(unknown));
  }
});

test("the plan's painting flag is read as a boolean, not by identity", () => {
  assert.strictEqual(paintingTransition(1, true), null);
  assert.strictEqual(paintingTransition(0, false), null);
  assert.strictEqual(paintingTransition(undefined, true), "stop");
});

test("a surfacePlan feeds straight into it", () => {
  const visible = surfacePlan(true, true, LOGICAL);
  const hidden = surfacePlan(true, false, LOGICAL);
  // The steady states a pane actually sits in: visible and painting, hidden and not.
  assert.strictEqual(paintingTransition(visible.painting, true), null);
  assert.strictEqual(paintingTransition(hidden.painting, false), null);
  // And the two transitions between them.
  assert.strictEqual(paintingTransition(visible.painting, false), "start");
  assert.strictEqual(paintingTransition(hidden.painting, true), "stop");
});

// --- the restored-layout wait ---
//
// The script is a string because it runs in the page, so it is tested by running it in a
// context that stands in for one. That keeps the assertions about behaviour — does it
// settle, and on what — rather than about the text.

const vm = require("node:vm");

function runLayoutScript(innerHeight, timeoutMs = 1500) {
  const listeners = new Set();
  const timers = new Map();
  let nextTimer = 1;
  const context = {
    innerHeight,
    addEventListener: (type, fn) => { if (type === "resize") listeners.add(fn); },
    removeEventListener: (_type, fn) => listeners.delete(fn),
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    Promise,
  };
  vm.createContext(context);
  const promise = vm.runInContext(restoredLayoutScript(timeoutMs), context);
  return {
    promise,
    listeners,
    timers,
    // What the page does when the surface comes back: the size changes, then resize fires.
    resizeTo: (height) => {
      context.innerHeight = height;
      for (const fn of [...listeners]) fn();
    },
    fireTimeout: () => {
      for (const { fn } of [...timers.values()]) fn();
    },
  };
}

test("a page already laid out at its real size does not wait at all", async () => {
  const run = runLayoutScript(900);
  assert.strictEqual(await run.promise, "already");
  assert.strictEqual(run.listeners.size, 0, "nothing to unsubscribe from");
  assert.strictEqual(run.timers.size, 0, "and no timer to leak");
});

test("a collapsed page waits for the resize that restores it", async () => {
  const run = runLayoutScript(COLLAPSED_HEIGHT);
  run.resizeTo(900);
  assert.strictEqual(await run.promise, "resize");
});

test("a resize that does not clear the collapsed height is not the one being waited for", async () => {
  // The reconciler can resize a collapsed tab — a pane resize rewrites its width — and
  // that resize still leaves the page one pixel tall. Settling on it would hand the agent
  // exactly the empty page this wait exists to prevent.
  const run = runLayoutScript(COLLAPSED_HEIGHT);
  run.resizeTo(COLLAPSED_HEIGHT);
  assert.strictEqual(run.listeners.size, 1, "still waiting");
  run.resizeTo(640);
  assert.strictEqual(await run.promise, "resize");
});

test("a page that never comes back settles on its own deadline", async () => {
  const run = runLayoutScript(COLLAPSED_HEIGHT);
  run.fireTimeout();
  assert.strictEqual(await run.promise, "timeout");
});

test("settling unsubscribes and clears the timer either way", async () => {
  for (const settle of ["resizeTo", "fireTimeout"]) {
    const run = runLayoutScript(COLLAPSED_HEIGHT);
    if (settle === "resizeTo") run.resizeTo(900); else run.fireTimeout();
    await run.promise;
    assert.strictEqual(run.listeners.size, 0, settle);
    assert.strictEqual(run.timers.size, 0, settle);
  }
});

test("the deadline reaches the page as a number, whatever it was given", () => {
  assert.match(restoredLayoutScript(1500), /setTimeout\(\(\) => settle\("timeout"\), 1500\)/);
  // A caller that passes nonsense must not produce a script that throws in the page.
  for (const bad of [undefined, null, NaN, "soon", -5]) {
    assert.match(restoredLayoutScript(bad), /settle\("timeout"\), \d+\)/, String(bad));
  }
});

// --- the presented-frame wait ---
//
// A hold that restores a collapsed surface gets a correctly sized paint at once, and it is the
// compositor's frame from before the collapse. Keeping it made `screenshot` answer with the page
// as it was before an `eval` or a click on a hidden pane (office-free-answer, 2026-11-10).

function runPresentedScript(timeoutMs = 700) {
  const frames = [];
  const timers = new Map();
  let nextTimer = 1;
  const context = {
    requestAnimationFrame: (fn) => { frames.push(fn); },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    Promise,
  };
  vm.createContext(context);
  const promise = vm.runInContext(presentedFrameScript(timeoutMs), context);
  return {
    promise,
    timers,
    // One animation frame: runs what was queued before it, not what that queues in turn.
    frame: () => { for (const fn of frames.splice(0)) fn(); },
    fireTimeout: () => { for (const { fn } of [...timers.values()]) fn(); },
  };
}

test("the page has presented only after the second animation frame", async () => {
  const run = runPresentedScript();
  let settled = null;
  run.promise.then((how) => { settled = how; });
  run.frame();
  await Promise.resolve();
  assert.strictEqual(settled, null, "one frame is the update after the resize, not yet the frame it drew");
  run.frame();
  assert.strictEqual(await run.promise, "frame");
  assert.strictEqual(run.timers.size, 0, "the backstop is cleared");
});

test("a page that never runs animation frames settles on its own deadline", async () => {
  const run = runPresentedScript();
  run.fireTimeout();
  assert.strictEqual(await run.promise, "timeout");
});

test("the presented-frame deadline reaches the page as a number, whatever it was given", () => {
  assert.match(presentedFrameScript(700), /setTimeout\(\(\) => settle\("timeout"\), 700\)/);
  for (const bad of [undefined, null, NaN, "soon", -5]) {
    assert.match(presentedFrameScript(bad), /settle\("timeout"\), \d+\)/, String(bad));
  }
});

test("a paint at the restored size is not the frame until the renderer has presented", () => {
  const expected = { width: 1274, height: 1344 };
  // The compositor's cached frame: right size, drawn before the collapse.
  assert.strictEqual(acceptsRestoredPaint({ ...expected }, expected, false), false);
  assert.strictEqual(acceptsRestoredPaint({ ...expected }, expected, true), true);
});

test("a paint of another size is never the restored frame", () => {
  const expected = { width: 1274, height: 1344 };
  // The collapse itself paints width x 2, and a pane resize paints at the old size.
  for (const size of [{ width: 1274, height: 2 }, { width: 0, height: 0 }, { width: 1200, height: 1344 }]) {
    assert.strictEqual(acceptsRestoredPaint(size, expected, true), false, JSON.stringify(size));
  }
});
