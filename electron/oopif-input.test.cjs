"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { mouseEventParams, modifierMask, sessionsUnderPoint } = require("./oopif-input.cjs");

// `sendInputEvent` stops at a process boundary, so a click over a cross-site iframe lands on the
// `<iframe>` element instead of the page inside it. These parameters are what the CDP router —
// which does hit-test across the whole frame tree — needs to be handed instead.

// CDP spells the event types differently from `sendInputEvent` and rejects the other spelling
// outright. Measured when this was first written: `Unexpected event type 'mouseMove'` on every
// event, after which each one fell back to the direct path and the OOPIF stayed exactly as
// unreachable as before. The whole fix rides on this rename, and nothing else would have said so.
test("the sendInputEvent names are translated to CDP's", () => {
  assert.equal(mouseEventParams({ type: "mouseMove", x: 0, y: 0 }).type, "mouseMoved");
  assert.equal(mouseEventParams({ type: "mouseDown", x: 0, y: 0 }).type, "mousePressed");
  assert.equal(mouseEventParams({ type: "mouseUp", x: 0, y: 0 }).type, "mouseReleased");
  assert.equal(mouseEventParams({ type: "mouseWheel", x: 0, y: 0 }).type, "mouseWheel");
});

// `contextMenu` has no CDP equivalent. Answering null is how the caller knows to send it the
// direct way rather than emitting something the protocol will refuse.
test("a type CDP does not have answers null rather than guessing", () => {
  assert.equal(mouseEventParams({ type: "contextMenu", x: 0, y: 0 }), null);
  assert.equal(mouseEventParams({ type: "keyDown", x: 0, y: 0 }), null);
});

test("a press names its button and reports it held", () => {
  const p = mouseEventParams({ type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1, held: true });
  assert.equal(p.type, "mousePressed");
  assert.equal(p.button, "left");
  assert.equal(p.buttons, 1);
  assert.equal(p.clickCount, 1);
});

// The whole point of `buttons` on a move: a page reads it to tell a drag from a pointer merely
// travelling. Without it, every site implementing its own drag sees nothing.
test("a move with a held button reports the mask, and carries no click count", () => {
  const p = mouseEventParams({ type: "mouseMove", x: 5, y: 6, button: "left", held: true });
  assert.equal(p.buttons, 1);
  assert.equal(p.button, "left");
  assert.ok(!("clickCount" in p));
});

test("a release reports no held button, because by then it is not held", () => {
  const p = mouseEventParams({ type: "mouseUp", x: 1, y: 2, button: "left", clickCount: 1, held: false });
  assert.equal(p.buttons, 0);
  assert.equal(p.clickCount, 1);
});

test("a bare move names no button — CDP says so explicitly rather than by omission", () => {
  const p = mouseEventParams({ type: "mouseMove", x: 3, y: 4 });
  assert.equal(p.button, "none");
  assert.equal(p.buttons, 0);
});

test("the right and middle buttons take their own mask bits", () => {
  assert.equal(mouseEventParams({ type: "mouseDown", button: "right", held: true, x: 0, y: 0 }).buttons, 2);
  assert.equal(mouseEventParams({ type: "mouseDown", button: "middle", held: true, x: 0, y: 0 }).buttons, 4);
});

test("modifiers become CDP's bitmask, by every name sendInputEvent accepts", () => {
  assert.equal(modifierMask([]), 0);
  assert.equal(modifierMask(["alt"]), 1);
  assert.equal(modifierMask(["control"]), 2);
  assert.equal(modifierMask(["ctrl"]), 2);
  assert.equal(modifierMask(["meta"]), 4);
  assert.equal(modifierMask(["cmd"]), 4);
  assert.equal(modifierMask(["shift"]), 8);
  assert.equal(modifierMask(["shift", "control"]), 10);
  // An unknown name must not poison the mask.
  assert.equal(modifierMask(["capslock"]), 0);
});

test("a wheel carries deltas and no click count", () => {
  // In: sendInputEvent's sign (a wheel turned up is +deltaY). Out: CDP's DOM sign (+ is down).
  const p = mouseEventParams({ type: "mouseWheel", x: 1, y: 2, deltaX: -10, deltaY: 100 });
  assert.equal(p.deltaX, 10);
  assert.equal(p.deltaY, -100);
  assert.ok(!("clickCount" in p));
});

test("a wheel turned down scrolls the page down", () => {
  // The terminal's wheel-down arrives as deltaY -100 (dispatchMouse) and the float viewer's as
  // the negated DOM delta (float-display.cjs). Both must reach CDP as a positive deltaY.
  assert.equal(mouseEventParams({ type: "mouseWheel", x: 0, y: 0, deltaY: -100 }).deltaY, 100);
  assert.ok(Object.is(mouseEventParams({ type: "mouseWheel", x: 0, y: 0 }).deltaY, 0));
});

// --- addressing the frame the point is actually over ---
//
// The root session does not forward across a process boundary, and a child session measures from
// its OWN viewport. Both halves were measured: sending the top-frame point on the root session
// left the child with nothing, and sending it on the child's session put the click off by the
// iframe's offset. Subtracting that offset is what finally delivered.

const RECT = { x: 30, y: 69, width: 425, height: 265 };

test("a point inside a frame is rewritten into that frame's own viewport", () => {
  const hits = sessionsUnderPoint(new Map([["S1", { rect: RECT }]]), { x: 243, y: 202 });
  assert.deepEqual(hits, [{ sessionId: "S1", x: 213, y: 133 }]);
});

test("a point outside every frame addresses none of them", () => {
  const sessions = new Map([["S1", { rect: RECT }]]);
  assert.deepEqual(sessionsUnderPoint(sessions, { x: 10, y: 10 }), []);
  assert.deepEqual(sessionsUnderPoint(sessions, { x: 500, y: 202 }), []);
  assert.deepEqual(sessionsUnderPoint(sessions, { x: 243, y: 400 }), []);
});

// A frame attaches before its box has been read, and guessing an origin would put the click at
// an arbitrary spot inside it — worse than not sending, which at least leaves the root session's
// copy to land in the parent.
test("a frame whose box is unknown is not aimed at", () => {
  assert.deepEqual(sessionsUnderPoint(new Map([["S1", { rect: null }]]), { x: 243, y: 202 }), []);
  assert.deepEqual(sessionsUnderPoint(new Map([["S1", {}]]), { x: 243, y: 202 }), []);
});

test("nested frames are ordered outermost first, each in its own coordinates", () => {
  const outer = { x: 0, y: 0, width: 800, height: 600 };
  const inner = { x: 100, y: 50, width: 200, height: 150 };
  const hits = sessionsUnderPoint(new Map([["INNER", { rect: inner }], ["OUTER", { rect: outer }]]),
    { x: 150, y: 100 });
  assert.deepEqual(hits, [
    { sessionId: "OUTER", x: 150, y: 100 },
    { sessionId: "INNER", x: 50, y: 50 },
  ]);
});

test("a point on a frame's own edge counts as inside it", () => {
  const hits = sessionsUnderPoint(new Map([["S1", { rect: RECT }]]), { x: 30, y: 69 });
  assert.deepEqual(hits, [{ sessionId: "S1", x: 0, y: 0 }]);
});

// --- one destination per event, and a drag stays with its frame ---

const { pointerTarget, nextCapture } = require("./oopif-input.cjs");

const PANEL = new Map([
  ["outer", { rect: { x: 100, y: 100, width: 400, height: 400 } }],
  ["inner", { rect: { x: 150, y: 150, width: 200, height: 200 } }],
]);

test("the innermost frame under the point is the only target", () => {
  // Sending to the outer one as well would blur the inner one, exactly as the root did.
  assert.deepEqual(pointerTarget(PANEL, { x: 200, y: 220 }, null), { sessionId: "inner", x: 50, y: 70 });
  assert.deepEqual(pointerTarget(PANEL, { x: 120, y: 120 }, null), { sessionId: "outer", x: 20, y: 20 });
});

test("a point over no frame goes to the root", () => {
  assert.equal(pointerTarget(PANEL, { x: 10, y: 10 }, null), null);
});

test("while a drag is held, its frame keeps the events even outside its box", () => {
  // Dragged off the panel to the left, with the button still down in the frame.
  assert.deepEqual(pointerTarget(PANEL, { x: 20, y: 160 }, "inner"), { sessionId: "inner", x: -130, y: 10 });
});

test("a capture on a frame that has gone falls back to hit-testing", () => {
  assert.equal(pointerTarget(PANEL, { x: 10, y: 10 }, "vanished"), null);
});

test("a press takes the capture for its target and a release gives it back", () => {
  assert.equal(nextCapture(null, "mousePressed", { sessionId: "inner" }), "inner");
  assert.equal(nextCapture(null, "mousePressed", null), null);
  assert.equal(nextCapture("inner", "mouseMoved", { sessionId: "outer" }), "inner");
  assert.equal(nextCapture("inner", "mouseReleased", { sessionId: "inner" }), null);
});

// A hardware mouse reports pressure 0.5 while a button is down; CDP's `force` defaults to 0, so
// every synthetic drag arrived pressed but weightless. A pen that sizes its stroke by pressure —
// Excalidraw's does — draws nothing visible from that.
test("a held button carries the pressure a real mouse reports", () => {
  assert.equal(mouseEventParams({ type: "mouseMove", x: 1, y: 1, button: "left", held: true }).force, 0.5);
  assert.equal(mouseEventParams({ type: "mouseDown", x: 1, y: 1, button: "left", held: true }).force, 0.5);
  assert.equal(mouseEventParams({ type: "mouseUp", x: 1, y: 1, button: "left" }).force, 0);
  assert.equal(mouseEventParams({ type: "mouseMove", x: 1, y: 1 }).force, 0);
});
