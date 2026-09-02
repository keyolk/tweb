"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  RELAY_JPEG_QUALITY,
  fullscreenSurfaceScale,
  scaledSurfaceSize,
  displayWindowOptions,
  centeredDisplayBounds,
  canvasPointToPage,
  relayInputEvents,
} = require("./float-display.cjs");

// The viewer is an ordinary desktop window — everything the offscreen window turns off so
// the pane can own it, this turns back on so the user can.
test("a display window is a real, movable desktop window", () => {
  const options = displayWindowOptions({ x: 10, y: 20, width: 800, height: 600 }, "/tmp/pre.cjs");
  assert.equal(options.show, false); // shown once the viewer document has loaded
  assert.equal(options.frame, true);
  assert.equal(options.resizable, true);
  assert.equal(options.movable, true);
  assert.equal(options.focusable, true);
  assert.equal(options.useContentSize, true);
  assert.deepEqual(
    [options.x, options.y, options.width, options.height],
    [10, 20, 800, 600],
  );
  assert.equal(options.webPreferences.preload, "/tmp/pre.cjs");
  assert.equal(options.webPreferences.contextIsolation, true);
  // No `offscreen` block: the viewer draws relayed frames on a canvas, it does not render
  // the browsed page. An offscreen viewer would present nothing at all.
  assert.equal(options.webPreferences.offscreen, undefined);
});

// Chromium throttles an unfocused window's timers, and the viewer reports its own resize
// through one. Measured: with throttling on, resizing the window while the terminal held
// focus delivered only the first `resize` event and the page stayed at the old size.
test("a display window is not background-throttled", () => {
  const options = displayWindowOptions({ x: 0, y: 0, width: 10, height: 10 }, "/tmp/pre.cjs");
  assert.equal(options.webPreferences.backgroundThrottling, false);
});

test("a floating window opens centred on the display the pane is on", () => {
  const bounds = centeredDisplayBounds({ x: 0, y: 0, width: 1440, height: 900 }, 800, 600);
  assert.deepEqual(bounds, { x: 320, y: 150, width: 800, height: 600 });
});

// A second monitor's bounds are offset, and the window belongs on the monitor the pane is
// on rather than at the same coordinates on the primary.
test("centring respects a non-primary display's origin", () => {
  const bounds = centeredDisplayBounds({ x: 1440, y: -200, width: 1000, height: 800 }, 600, 400);
  assert.deepEqual(bounds, { x: 1640, y: 0, width: 600, height: 400 });
});

test("a degenerate size still yields a window at least one pixel across", () => {
  const bounds = centeredDisplayBounds({ x: 0, y: 0, width: 100, height: 100 }, 0, -5);
  assert.equal(bounds.width, 1);
  assert.equal(bounds.height, 1);
});

// Three coordinate spaces meet in the viewer and getting it wrong is silent — the click
// lands somewhere else on the page rather than failing.
test("a canvas click maps to the same relative point in the page", () => {
  // Canvas laid out at 700x500 in the window; page is 700x500 logical. Straight through.
  const point = canvasPointToPage({ x: 350, y: 250 }, { left: 0, top: 0, width: 700, height: 500 },
    { width: 700, height: 500 });
  assert.deepEqual(point, { x: 350, y: 250 });
});

// The window is resizable, so the laid-out canvas and the page's logical size drift apart.
// The click is taken as a fraction of the box, which is what keeps a resized window aiming
// at the element the user is pointing at.
test("a click in a resized window still lands on the same element", () => {
  const point = canvasPointToPage({ x: 450, y: 300 }, { left: 0, top: 0, width: 900, height: 600 },
    { width: 600, height: 400 });
  assert.deepEqual(point, { x: 300, y: 200 });
});

test("the viewer's own offset is subtracted before scaling", () => {
  const point = canvasPointToPage({ x: 120, y: 60 }, { left: 20, top: 10, width: 100, height: 100 },
    { width: 200, height: 200 });
  assert.deepEqual(point, { x: 200 - 1, y: 100 });
});

test("a point outside the canvas is clamped into the page", () => {
  const page = { width: 400, height: 300 };
  const layout = { left: 0, top: 0, width: 400, height: 300 };
  assert.deepEqual(canvasPointToPage({ x: -50, y: -50 }, layout, page), { x: 0, y: 0 });
  assert.deepEqual(canvasPointToPage({ x: 9999, y: 9999 }, layout, page), { x: 399, y: 299 });
});

// Chromium wants the pointer moved to where the press happens: a bare mouseDown at a new
// position lands on whatever the page last thought was hovered.
test("a click is a move, a press and a release", () => {
  const events = relayInputEvents("mouse", { x: 10, y: 20, button: "right", clickCount: 2 });
  assert.deepEqual(events.map((e) => e.type), ["mouseMove", "mouseDown", "mouseUp"]);
  assert.equal(events[1].button, "right");
  assert.equal(events[1].clickCount, 2);
  assert.equal(events[2].x, 10);
});

// The DOM's deltaY is positive scrolling down; sendInputEvent takes the scroll offset,
// whose sign is the other way round. Getting this wrong scrolls the page backwards.
test("a wheel event has its sign inverted for sendInputEvent", () => {
  const [wheel] = relayInputEvents("wheel", { x: 5, y: 5, deltaX: 30, deltaY: 120 });
  assert.equal(wheel.type, "mouseWheel");
  assert.equal(wheel.deltaY, -120);
  assert.equal(wheel.deltaX, -30);
  assert.equal(wheel.canScroll, true);
});

// `char` is what puts a printable key into a text field — verified against a real
// offscreen page: keyDown+keyUp alone fired keydown and typed nothing, while adding `char`
// produced both the keypress and the character in the input.
test("a printable key gets a char event so it types", () => {
  const events = relayInputEvents("key", { key: "h" });
  assert.deepEqual(events.map((e) => e.type), ["keyDown", "char", "keyUp"]);
  assert.equal(events[1].keyCode, "h");
});

// A non-printable key must NOT get one: Chromium would insert the key's name as literal
// text, so Escape would type "Escape" into whatever field had focus.
test("a named key gets no char event", () => {
  const events = relayInputEvents("key", { key: "Escape" });
  assert.deepEqual(events.map((e) => e.type), ["keyDown", "keyUp"]);
});

test("modifiers ride along with every kind of event", () => {
  const modifiers = ["shift", "meta"];
  for (const event of relayInputEvents("mouse", { x: 1, y: 1, modifiers })) {
    assert.deepEqual(event.modifiers, modifiers);
  }
  assert.deepEqual(relayInputEvents("key", { key: "a", modifiers })[0].modifiers, modifiers);
  assert.deepEqual(relayInputEvents("wheel", { x: 1, y: 1, modifiers })[0].modifiers, modifiers);
});

test("an empty key and an unknown kind produce nothing to send", () => {
  assert.deepEqual(relayInputEvents("key", { key: "" }), []);
  assert.deepEqual(relayInputEvents("teleport", { x: 1 }), []);
});

// A hover still has to reach the page — menus and link targets depend on it — but as one
// move, not the three a click expands to.
test("a hover forwards a single move", () => {
  const events = relayInputEvents("move", { x: 7, y: 9 });
  assert.deepEqual(events, [{ type: "mouseMove", x: 7, y: 9, modifiers: [] }]);
});

// The pane's own path already encodes each frame for Kitty. A second PNG encode measured
// ~3ms per frame at 700x500 dsf2 and scales with area; at 30fps that is main-thread time
// the keyboard waits on, so the relay pays for a JPEG instead.
test("frames are relayed as JPEG at a quality that stays readable", () => {
  assert.equal(typeof RELAY_JPEG_QUALITY, "number");
  assert.ok(RELAY_JPEG_QUALITY >= 60 && RELAY_JPEG_QUALITY <= 95);
});

// --- fullscreen on a monitor coarser than the surface ------------------------------------

test("a coarser fullscreen monitor shrinks the surface by the scale ratio", () => {
  // The measured case: primary 1728x1117 @2x fixes the offscreen dsf at 2, and fullscreen
  // deliberately moves to the external 2560x1440 @1x. Asking for 2560x1440 DIPs rendered
  // 5120x2880 — four times what the monitor can show, all discarded by the viewer.
  assert.equal(fullscreenSurfaceScale(1, 2), 0.5);
  const surface = scaledSurfaceSize({ width: 2560, height: 1440 }, 0.5);
  assert.deepEqual(surface, { width: 1280, height: 720 });
  // dsf2 over those DIPs is exactly the monitor's pixel count: nothing is thrown away, and
  // nothing is rendered that cannot be shown.
  assert.deepEqual({ width: surface.width * 2, height: surface.height * 2 },
    { width: 2560, height: 1440 });
});

test("a monitor at or above the surface's scale is left alone", () => {
  // NEGATIVE CONTROL. Shrinking on a retina monitor would throw away pixels the user can see,
  // which is the opposite of the bug being fixed.
  assert.equal(fullscreenSurfaceScale(2, 2), 1);
  assert.equal(fullscreenSurfaceScale(3, 2), 1);
  assert.equal(fullscreenSurfaceScale(1, 1), 1);
});

test("an unusable scale factor compensates for nothing", () => {
  // A display that reports no scale must not silently collapse the surface toward zero.
  for (const bad of [0, -1, undefined, null, NaN, "x"]) {
    assert.equal(fullscreenSurfaceScale(bad, 2), 1, `target ${String(bad)}`);
    assert.equal(fullscreenSurfaceScale(1, bad), 1, `surface ${String(bad)}`);
  }
});

test("scale 1 passes the size through unchanged", () => {
  // Every caller relies on this: it is what lets the sizing path stay branch-free.
  assert.deepEqual(scaledSurfaceSize({ width: 1401, height: 901 }, 1),
    { width: 1401, height: 901 });
});

test("a scaled surface lands on even DIPs so the frame is whole pixels", () => {
  // An odd DIP count at dsf2 puts the frame half a pixel off the monitor's, which the viewer
  // resamples for nothing.
  const surface = scaledSurfaceSize({ width: 2561, height: 1441 }, 0.5);
  assert.equal(surface.width % 2, 0);
  assert.equal(surface.height % 2, 0);
  // And never collapses: a surface of zero is a blank window, not a cheap one.
  assert.deepEqual(scaledSurfaceSize({ width: 1, height: 1 }, 0.5), { width: 2, height: 2 });
});

test("the compensating zoom keeps the page's layout identical", () => {
  // The resize and the zoom are two halves of one change. Verified against Electron 43.2.0:
  // contentSize 2560x1440 at zoom 0.8 laid the page out at CSS 3200x1800 and rendered
  // 5120x2880; contentSize 1280x720 at zoom 0.4 laid it out at CSS 3200x1800 — the same
  // document — and rendered 2560x1440.
  const scale = fullscreenSurfaceScale(1, 2);
  const userZoom = 0.8;
  const surface = scaledSurfaceSize({ width: 2560, height: 1440 }, scale);
  assert.equal(surface.width / (userZoom * scale), 2560 / userZoom);
  assert.equal(surface.height / (userZoom * scale), 1440 / userZoom);
});
