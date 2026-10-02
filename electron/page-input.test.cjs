"use strict";

// Two ways a page can be told less than the truth about the pointer, both of which
// present to the user as "the click did nothing".

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

function body(name, end) {
  const from = main.indexOf(name);
  assert.notEqual(from, -1, `${name} is gone`);
  const to = main.indexOf(end, from);
  assert.notEqual(to, -1, `${name} no longer reaches ${end}`);
  return main.slice(from, to);
}

// --- a held button has to reach the page ---
//
// `MouseEvent.buttons` is what a page reads to tell a drag from a pointer merely travelling, and
// it is filled in from the held-button state rather than from the event's `button` field. A move
// sent without it reads as an idle pointer. Every site that implements its own drag — a canvas, a
// slider, a whiteboard, a text selection — gated on exactly that, and saw nothing.

test("the held-button modifiers are the names Chromium accepts", () => {
  // Lowercase. Electron's InputEvent.modifiers enumerates them that way, and an
  // unrecognised modifier is dropped silently — which is the failure this pins.
  assert.match(main, /left: "leftbuttondown"/);
  assert.match(main, /middle: "middlebuttondown"/);
  assert.match(main, /right: "rightbuttondown"/);
  // And they are applied on the direct path, which is the one that takes modifiers at all.
  assert.match(main, /function sendPointerEventDirect\(contents, event\)/);
  assert.match(main, /\? withButtonDown\(base\.modifiers, event\.button\)/);
});

test("a terminal drag says the button is held, and a release says it is not", () => {
  const dispatch = body("function dispatchMouse(cb, rawX, rawY, release)", "const KITTY_KEYS");
  assert.match(dispatch, /held: type !== "mouseUp",/);
  assert.match(dispatch, /sendPointerEvent\(currentWindows\(\)\.win, \{/);
});

test("an agent drag says so through every intermediate move", () => {
  const drag = body('case "native-drag": {', 'case "frame-mode":');
  // The press, and the one loop that issues all three interpolated moves. The release
  // deliberately says nothing, because by then the button is no longer down.
  assert.equal((drag.match(/held: true/g) || []).length, 2);
  assert.match(drag, /type: "mouseDown".*held: true/);
  assert.doesNotMatch(drag, /type: "mouseUp".*held: true/);
});

// --- and it has to reach a frame in another process ---
//
// `sendInputEvent` delivers into the root frame's widget and nothing hit-tests past a process
// boundary from there, so a click over a cross-SITE iframe stopped at the `<iframe>` element in
// the parent. Measured in the pane with two local servers: same-site (differing only by port)
// the child saw the click; cross-site it saw nothing and the parent saw target "f".

test("every pointer path goes through the router rather than straight at the widget", () => {
  // The four callers: the terminal's own mouse, the hint click, the agent, the float viewer.
  for (const site of [
    "function dispatchMouse", 'case "native-click":', "function agentNativeClick", "relayInputEvents(kind,",
  ]) {
    assert.ok(main.includes(site), `${site} is gone`);
  }
  // No mouse event may be sent directly any more, except from inside the fallback itself.
  const direct = main.match(/\.sendInputEvent\(\{\s*\n?\s*type: "mouse[A-Za-z]+"/g) || [];
  assert.deepEqual(direct, [], "a mouse event still bypasses sendPointerEvent");
});

test("the router prefers CDP and falls back to the direct path", () => {
  const router = body("function sendPointerEvent(tab, event)", "// The pre-CDP path");
  assert.match(router, /if \(params && ensureDebugger\(tab\)\) \{/);
  assert.match(router, /Input\.dispatchMouseEvent/);
  // A failed CDP command must still deliver the event rather than dropping it.
  assert.match(router, /\.catch\(\(error\) => \{[^]*?sendPointerEventDirect\(contents, event\);/);
  // And when the debugger cannot be had at all.
  assert.match(router, /\}\s*\n\s*sendPointerEventDirect\(contents, event\);\s*\n\}/);
});

// The two routes do not take the same coordinates. `sendInputEvent` wants unzoomed window DIPs,
// which is what every caller here produces; CDP wants CSS pixels in the top frame's viewport.
// This pane runs at 0.8 by default, so sending one where the other is expected puts every click
// a fifth of the way off target — far enough to miss the control and land on the page behind it.
test("CDP gets CSS pixels, not the window DIPs the direct path takes", () => {
  const router = body("function sendPointerEvent(tab, event)", "// The pre-CDP path");
  assert.match(router, /const zoom = contents\.getZoomFactor\(\) \|\| 1;/);
  assert.match(router, /x: Math\.round\(event\.x \/ zoom\)/);
  assert.match(router, /y: Math\.round\(event\.y \/ zoom\)/);
  // And the fallback keeps the unconverted point.
  assert.match(router, /sendPointerEventDirect\(contents, event\)/);
});

// The root session was not enough. It is sent on every event — a point over no subframe still
// has to reach the main frame — but the OOPIF needs its own session and its own coordinates.
test("each out-of-process frame under the point is addressed on its own session", () => {
  const router = body("function sendPointerEvent(tab, event)", "// The pre-CDP path");
  assert.match(router, /for \(const hit of sessionsUnderPoint\(oopifSessions\(tab\), \{ x: params\.x, y: params\.y \}\)\)/);
  assert.match(router, /\{ \.\.\.params, x: hit\.x, y: hit\.y \},\s*\n\s*hit\.sessionId,/);
  // And the root still gets the unrewritten event.
  assert.match(router, /sendCommand\("Input\.dispatchMouseEvent", params\)/);
});

test("sessions are flattened onto this connection, with the DOM domain they need", () => {
  // Without `flatten` each child session would need its own transport.
  assert.match(main, /autoAttach: true, waitForDebuggerOnStart: false, flatten: true,/);
  // `DOM.getFrameOwner`/`getBoxModel` answer nothing until DOM is enabled — measured: every
  // rect stayed null and no frame was ever aimed at.
  assert.match(main, /sendCommand\("DOM\.enable"\)/);
  // Only iframes. A worker has a session too and no place on screen.
  assert.match(main, /if \(params\?\.targetInfo\?\.type !== "iframe"\) return;/);
});

test("attaching happens on dom-ready, not on the first click", () => {
  // Measured: attaching lazily meant the first click went out before any session existed and
  // reached nobody, while the second landed.
  const domReady = body('onContents("dom-ready", () => {', "// Gone on the way out");
  assert.match(domReady, /if \(ensureDebugger\(tab\)\) watchOopifSessions\(tab\);/);
});

test("frame boxes are refreshed on the move, which is what precedes every click", () => {
  const router = body("function sendPointerEvent(tab, event)", "// The pre-CDP path");
  // Not on the press: this path is synchronous and cannot await the read, so a refresh started
  // there would still be in flight when the press is routed.
  assert.match(router, /if \(params\.type === "mouseMoved"\) scheduleOopifRectRefresh\(tab\);/);
  assert.doesNotMatch(router, /if \(params\.type === "mousePressed"\) void refreshOopifRects/);
  // Throttled, because two CDP round trips per motion report is not affordable.
  assert.match(main, /if \(now - \(oopifRectRefreshAt\.get\(tab\) \|\| 0\) < 250\) return;/);
});

// Only the top frame answers an agent request — refs are the `f` hint labels, and a subframe's
// would collide. Sending to the FOCUSED frame therefore gets no reply whenever focus is inside a
// subframe, which it is as soon as someone clicks an embedded app.
//
// Survivable while a cross-origin subframe could not register as a shortcut frame: delivery fell
// back to the main frame by itself. Once every frame registers, this became "every agent call
// times out while the page is plainly alive" — measured on a Google Meet add-on panel, `snapshot`
// at 10s and `page-diag` at 3s, with `eval` answering fine because it takes another path.
test("an agent request goes to the main frame, which is the only one that answers", () => {
  assert.match(main, /sendToMainTabFrame\(tab, "tweb-agent-request", \{ id, method, params \}\)/);
  assert.doesNotMatch(main, /sendToFocusedTabFrame\(tab, "tweb-agent-request"/);
});

// Getting INTO an embedded app takes three things, and all three were measured missing.
//
// End to end on a two-deep cross-origin panel (the shape Google Meet's add-ons have): `f` hints
// the frame, the pick focuses it, the next `f` runs INSIDE it, and picking there opened the
// popup — `tab opened 2`. Each assertion below is one of the steps that was broken.

test("a click into an out-of-process frame also gives it focus", () => {
  const router = body("function sendPointerEvent(tab, event)", "// The pre-CDP path");
  // Measured: the event reached the child (`sessions=1 hits=1`) and it still reported
  // `activeElement: body, hasFocus: false`, so the next key went to the main frame.
  assert.match(router, /Emulation\.setFocusEmulationEnabled/);
  // And emulation alone was not enough — same result until the frame called `window.focus()`.
  assert.match(router, /expression: "window\.focus\(\)"/);
});

test("a subframe's click point is moved into the top frame's viewport", () => {
  const helper = body("function frameViewportPoint(tab, sourceFrame, point)", "// Send one pointer event");
  assert.match(helper, /return \{ x: point\.x \+ info\.rect\.x, y: point\.y \+ info\.rect\.y \};/);
  // The main frame already reports top-viewport coordinates and must not be shifted.
  assert.match(helper, /if \(!sourceFrame \|\| sourceFrame === tab\.webContents\.mainFrame\) return point;/);
  // And the hint click is what passes the source frame through.
  assert.match(main, /pageToWindowPoint\(contents, frameViewportPoint\(tab, sourceFrame, value\)\)/);
});

test("a frame's URL is re-read once it has one", () => {
  // `Target.attachedToTarget` fires before the frame has a URL, so the value stored then is
  // empty — and `frameViewportPoint` matches on exactly that.
  const refresh = body("async function refreshOopifRects(tab)", "function sendPointerEvent");
  assert.match(refresh, /expression: "location\.href", returnByValue: true,/);
  // Re-read from the live entry rather than the one captured before the awaits: a refresh is
  // asynchronous and an attach may have landed in between.
  assert.match(refresh, /sessions\.set\(sessionId, \{ \.\.\.sessions\.get\(sessionId\), url, rect \}\)/);
});

// A frame nested inside ANOTHER out-of-process frame — which is the shape a Google Meet add-on
// has — could not be placed at all, and an unplaced frame is never aimed at. Two reasons, both
// measured on the live panel, both of which this covers:
//
//   `DOM.getFrameOwner` was asked of the ROOT session, and the owning `<iframe>` lives in the
//   intermediate frame's process. Every call answered `Could not compute box model`, so every
//   rect stayed null.
//
//   And the box, once obtained, is in the coordinates of whichever document holds the element.
//   An add-on panel sits in a plain `<iframe>` with no src, so a box measured there is off by
//   wherever that panel is on screen.
test("a frame is measured by the session that holds it, and composed up the tree", () => {
  const refresh = body("async function refreshOopifRects(tab)", "function sendPointerEvent");
  // Asked of the parent, not the root.
  assert.match(refresh, /"DOM\.getFrameOwner", \{ frameId: info\.frameId \}, info\.parent/);
  // A backend node id cannot be called on, so it is resolved first and measured in the page —
  // `getBoundingClientRect` is the coordinate space the mouse router works in.
  assert.match(refresh, /"DOM\.resolveNode"/);
  assert.match(refresh, /"Runtime\.callFunctionOn"/);
  assert.match(refresh, /this\.getBoundingClientRect\(\)/);
  // The same-origin frames in between are added by walking up from the owner's own document.
  assert.match(refresh, /win\.frameElement\.getBoundingClientRect\(\)/);
  // And when that walk stopped at a process boundary, the parent's rect completes it.
  assert.match(refresh, /if \(!box\.atTop\) \{/);
  assert.match(refresh, /x: rect\.x \+ outer\.x, y: rect\.y \+ outer\.y/);
});

test("the parent session is recorded at attach, which is the only time it is told", () => {
  // The session a `Target.attachedToTarget` arrives on is the one whose document holds the
  // frame. It is the fourth argument of the message event and was being dropped.
  assert.match(main, /\(_event, method, params, parentSessionId\) => \{/);
  assert.match(main, /parent: String\(parentSessionId \|\| ""\),/);
  // Each child session needs its own DOM domain, or it cannot resolve a frame nested below it.
  assert.match(main, /for \(const domain of \["Runtime\.enable", "DOM\.enable"\]\)/);
});

test("the file chooser no longer treats 'attached' as 'wired up'", () => {
  // The mouse router attaches the same debugger now, so `isAttached()` stopped implying that
  // the chooser's own listeners had been registered — it would have skipped registering them.
  assert.match(main, /const chooserWiredTabs = new WeakSet\(\);/);
  assert.match(main, /if \(chooserWiredTabs\.has\(tab\)\) return true;/);
  assert.match(main, /chooserWiredTabs\.delete\(tab\);/);
});

// --- window.open opens a tab, and that is deliberate ---
//
// Allowing the window instead was tried and reverted. Measured on a live Google Meet add-on's
// sign-in popup: the adopted tab came up `innerWidth: 0, innerHeight: 0` with `screen: 0x0` and
// so had no display attached. It painted nothing, and as the ACTIVE tab it froze the whole pane
// on its last frame. `f` then found nothing to hint, because it hints the active tab. The page
// answered `eval` normally throughout, which is what made it read as a hang rather than as a
// broken tab.
//
// `setContentSize` did not fix it (the window was already the right size) and neither did the
// page's own `resizeTo`. A minimal repro could not reproduce it: an allowed popup to a real URL,
// opened from a cross-origin iframe, came up correctly at the pane's size. So the condition that
// produces a display-less window is not known, and until it is, the window is not allowed.
//
// The cost is real: the opener gets null, so an OAuth flow that drives a blank popup does not
// start. A broken sign-in is one feature; a frozen pane is the whole browser.

test("window.open is denied, and the URL opens as a tab", () => {
  const handler = body("setWindowOpenHandler((details) => {", 'onContents("did-start-navigation"');
  assert.match(handler, /action: "deny"/);
  assert.match(handler, /setImmediate\(\(\) => createTab\(target, activate\)\)/);
  assert.doesNotMatch(handler, /action: "allow"/);
});

// Nothing may adopt a window Electron made for an opener: that is the path that produced the
// display-less tab. Pinned so it is not re-attempted blind.
test("no window is adopted from an opener", () => {
  assert.doesNotMatch(main, /onContents\("did-create-window"/);
  assert.doesNotMatch(main, /pendingWindowOpen/);
});

test("middle-click still does not steal focus, while window.open does", () => {
  const handler = body("setWindowOpenHandler((details) => {", 'onContents("did-start-navigation"');
  assert.match(handler, /const activate = details\.disposition !== "background-tab";/);
});
