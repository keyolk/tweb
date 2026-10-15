"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  NativeInput, GridEstimate, createPaneNative, paneGeometry, parseHelperLine, constants,
} = require("./native-input.cjs");

// A terminal window at (100, 40) whose cell 0,0 starts 13.3pt right and 61.7pt down of its
// top-left corner — title bar, padding and a status line, none of which anything reports.
const WINDOW = { id: 4242, pid: 77, x: 100, y: 40, width: 1400, height: 900, scale: 2 };
const GRID = { x: 13.3, y: 61.7 };
// A 7x14-pixel cell at 2x is 3.5x7 points. The pane is 80x30 cells, 10 cells in and 2 down.
const VIEWPORT = { cols: 80, rows: 30, width: 560, height: 420 };
const ORIGIN = { left: 10, top: 2 };
const GEOMETRY = paneGeometry({ viewport: VIEWPORT, origin: ORIGIN, inTmux: true }, 2);

function harness({ binary = "/bin/helper" } = {}) {
  let now = 1000;
  const timers = [];
  const written = [];
  const spawned = [];
  const native = new NativeInput({
    platform: "darwin",
    env: {},
    findHelper: () => binary,
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.done = true; },
    spawn: (path) => {
      const child = new EventEmitter();
      child.stdin = { write: (line) => written.push(line), on() {} };
      child.stdout = new PassThrough();
      child.kill = () => child.emit("exit", null, "SIGTERM");
      spawned.push({ path, child });
      return child;
    },
  });
  const advance = (ms) => {
    now += ms;
    for (const timer of timers) {
      if (!timer.done && timer.at <= now) {
        timer.done = true;
        timer.fn();
      }
    }
  };
  const line = (value) => native.onLine(JSON.stringify(value));
  const showWindow = (window = WINDOW) => line({
    ev: "w", id: window.id, pid: window.pid, x: window.x, y: window.y, w: window.width, h: window.height, scale: window.scale,
  });
  return { native, advance, line, showWindow, written, spawned, now: () => now };
}

// Where a screen point is in the pane's own cells, as tmux would report it (zero-based here).
function cellOf(x, y, window = WINDOW, grid = GRID) {
  return {
    col: Math.floor((x - window.x - grid.x) / GEOMETRY.cellW) - ORIGIN.left,
    row: Math.floor((y - window.y - grid.y) / GEOMETRY.cellH) - ORIGIN.top,
  };
}

// The pointer travelling slowly across the pane, the helper seeing every point and the terminal
// reporting each new cell, as a real one does.
function travel(h, pane, from, to, steps, window = WINDOW, grid = GRID) {
  let last = null;
  let result = null;
  for (let i = 0; i <= steps; i += 1) {
    const x = from.x + (to.x - from.x) * i / steps;
    const y = from.y + (to.y - from.y) * i / steps;
    h.advance(8);
    h.line({ ev: "m", x, y, b: 0 });
    const cell = cellOf(x, y, window, grid);
    if (!last || last.col !== cell.col || last.row !== cell.row) {
      h.advance(4);
      result = h.native.report(pane, GEOMETRY, cell.col, cell.row);
      last = cell;
    }
  }
  return result;
}

test("helper lines parse into the events the engine reads, and nothing else does", () => {
  assert.deepStrictEqual(parseHelperLine('{"ev":"m","x":1.5,"y":2,"b":1}'), { ev: "m", x: 1.5, y: 2, buttons: 1 });
  assert.deepStrictEqual(parseHelperLine('{"ev":"s","x":1,"y":2,"dx":0,"dy":-3.5,"ph":4,"mo":0,"pr":true,"mods":0}'), {
    ev: "s", x: 1, y: 2, dx: 0, dy: -3.5, phase: 4, momentum: 0, precise: true, modifiers: 0,
  });
  assert.deepStrictEqual(parseHelperLine('{"ev":"w","id":null}'), { ev: "w", window: null });
  assert.strictEqual(parseHelperLine('{"ev":"w","id":3,"x":0,"y":0,"w":10,"h":10,"scale":2}').window.id, 3);
  assert.strictEqual(parseHelperLine("not json"), null);
  assert.strictEqual(parseHelperLine('{"ev":"m","x":"1","y":2}'), null);
  assert.strictEqual(parseHelperLine('{"ev":"zoom"}'), null);
});

test("a pane's grid is cells in tmux and device pixels outside it", () => {
  assert.deepStrictEqual(GEOMETRY, { inTmux: true, cellW: 3.5, cellH: 7, left: 10, top: 2, cols: 80, rows: 30 });
  const bare = paneGeometry({ viewport: VIEWPORT, origin: undefined, inTmux: false }, 2);
  assert.deepStrictEqual(bare, { inTmux: false, cellW: 0.5, cellH: 0.5, left: 0, top: 0, cols: 560, rows: 420 });
  assert.strictEqual(paneGeometry({ viewport: VIEWPORT, origin: undefined, inTmux: true }, 2), null);
  assert.strictEqual(paneGeometry({ viewport: VIEWPORT, origin: ORIGIN, inTmux: true }, undefined), null);
});

// tb's hover oracle cannot locate a pane from cell-quantized positions (its own test says so),
// which is why it falls back to pairing in tmux. The cell EDGES are exact, though, and crossing
// them is what pins the grid down.
test("cell reports alone locate the grid to well under a cell", () => {
  const estimate = new GridEstimate();
  for (let i = 0; i < 400; i += 1) {
    const x = WINDOW.x + 200 + i * 0.37;
    const y = WINDOW.y + 300 + i * 0.29;
    const col = Math.floor((x - WINDOW.x - GRID.x) / 3.5);
    const row = Math.floor((y - WINDOW.y - GRID.y) / 7);
    estimate.offer(col, row, { min: x - WINDOW.x, max: x - WINDOW.x }, { min: y - WINDOW.y, max: y - WINDOW.y }, 3.5, 7);
  }
  assert.ok(estimate.usable(3.5, 7));
  assert.ok(Math.abs(estimate.origin().x - GRID.x) < 0.4, `x ${estimate.origin().x}`);
  assert.ok(Math.abs(estimate.origin().y - GRID.y) < 0.4, `y ${estimate.origin().y}`);
});

test("once located, a report's point is the pointer's real one", () => {
  const h = harness();
  const pane = createPaneNative();
  assert.strictEqual(h.native.arm(), true);
  h.showWindow();
  const start = { x: WINDOW.x + GRID.x + 12 * 3.5 + 0.2, y: WINDOW.y + GRID.y + 4 * 7 + 0.3 };
  const end = { x: start.x + 90, y: start.y + 70 };
  // Out and back, as a hand moves. Entering a cell bounds the grid tightly from the side it was
  // entered by, so a pointer that only ever moved one way would leave the other side loose.
  travel(h, pane, start, end, 300);
  travel(h, pane, end, start, 300);

  // A point well inside a cell: the cell report says only "somewhere in 3.5x7 points".
  const x = WINDOW.x + GRID.x + (ORIGIN.left + 20) * 3.5 + 1.25;
  const y = WINDOW.y + GRID.y + (ORIGIN.top + 9) * 7 + 5.5;
  h.advance(8);
  h.line({ ev: "m", x, y, b: 0 });
  h.advance(3);
  const cell = cellOf(x, y);
  const hit = h.native.report(pane, GEOMETRY, cell.col, cell.row);
  assert.ok(hit, "the native point is used");
  const local = { x: hit.fx * 80 * 3.5, y: hit.fy * 30 * 7 };
  assert.ok(Math.abs(local.x - (20 * 3.5 + 1.25)) < 0.5, `x ${local.x}`);
  assert.ok(Math.abs(local.y - (9 * 7 + 5.5)) < 0.5, `y ${local.y}`);
  assert.strictEqual(pane.windowId, WINDOW.id);
  assert.strictEqual(pane.latched, true);
});

test("moving the terminal window keeps the calibration", () => {
  const h = harness();
  const pane = createPaneNative();
  h.native.arm();
  h.showWindow();
  const start = { x: WINDOW.x + 100, y: WINDOW.y + 120 };
  travel(h, pane, start, { x: start.x + 80, y: start.y + 60 }, 300);
  const moved = { ...WINDOW, x: 400, y: 200 };
  h.showWindow(moved);
  const x = moved.x + GRID.x + (ORIGIN.left + 5) * 3.5 + 2;
  const y = moved.y + GRID.y + (ORIGIN.top + 5) * 7 + 2;
  const hit = h.native.hit(pane, GEOMETRY, x, y);
  assert.ok(hit && hit.inside);
  assert.ok(Math.abs(hit.fx * 280 - (5 * 3.5 + 2)) < 0.5);
});

test("a native pointer the report does not agree with leaves the cell report alone", () => {
  const h = harness();
  const pane = createPaneNative();
  h.native.arm();
  h.showWindow();
  const start = { x: WINDOW.x + 100, y: WINDOW.y + 120 };
  travel(h, pane, start, { x: start.x + 80, y: start.y + 60 }, 300);
  // The terminal reports a cell far from where the helper sees the pointer — another client's
  // window showing the same pane, say.
  h.advance(8);
  h.line({ ev: "m", x: WINDOW.x + 900, y: WINDOW.y + 700, b: 0 });
  h.advance(3);
  assert.strictEqual(h.native.report(pane, GEOMETRY, 3, 3), null);
});

test("a pane is only hit through the window it was reported in", () => {
  const h = harness();
  const pane = createPaneNative();
  h.native.arm();
  h.showWindow();
  const start = { x: WINDOW.x + 100, y: WINDOW.y + 120 };
  travel(h, pane, start, { x: start.x + 80, y: start.y + 60 }, 300);
  assert.ok(h.native.hit(pane, GEOMETRY, start.x, start.y));
  // Another terminal window in front, at the same place.
  h.showWindow({ ...WINDOW, id: 9999 });
  assert.strictEqual(h.native.hit(pane, GEOMETRY, start.x, start.y), null);
  // No window under the pointer at all (the desktop, a window from no app).
  h.line({ ev: "w", id: null });
  assert.strictEqual(h.native.hit(pane, GEOMETRY, start.x, start.y), null);
});

test("an idle helper hits nothing, so nothing native happens until the pane is pointed at", () => {
  const h = harness();
  const pane = createPaneNative();
  h.native.arm();
  h.showWindow();
  const start = { x: WINDOW.x + 100, y: WINDOW.y + 120 };
  travel(h, pane, start, { x: start.x + 80, y: start.y + 60 }, 300);
  h.advance(constants.ARM_SECONDS * 1000 + 1);
  assert.strictEqual(h.native.hit(pane, GEOMETRY, start.x, start.y), null);
  assert.strictEqual(h.native.wheelClaim(pane, GEOMETRY), "pass");
});

function calibrated() {
  const h = harness();
  const pane = createPaneNative();
  h.native.arm();
  h.showWindow();
  const start = { x: WINDOW.x + 100, y: WINDOW.y + 120 };
  travel(h, pane, start, { x: start.x + 80, y: start.y + 60 }, 300);
  return { h, pane };
}

test("a wheel notch with no native gesture yet waits for one, then goes", () => {
  const { h, pane } = calibrated();
  assert.strictEqual(h.native.wheelClaim(pane, GEOMETRY), "hold");
  let delivered = 0;
  h.native.hold(pane, () => { delivered += 1; });
  h.native.hold(pane, () => { delivered += 1; });
  h.advance(constants.HOLD_MS - 1);
  assert.strictEqual(delivered, 0);
  h.advance(2);
  assert.strictEqual(delivered, 2, "nothing native came, so the terminal's notches scroll");
});

test("the notches of a precise gesture are dropped, before and after it lands", () => {
  const { h, pane } = calibrated();
  let delivered = 0;
  h.native.hold(pane, () => { delivered += 1; });
  h.advance(10);
  h.native.noteNativeScroll(pane, true);
  h.advance(constants.HOLD_MS * 2);
  assert.strictEqual(delivered, 0, "the held notch was the gesture");
  assert.strictEqual(pane.wheel.dropped, 1);
  h.advance(constants.DROP_MS - constants.HOLD_MS * 2 - 1);
  assert.strictEqual(h.native.wheelClaim(pane, GEOMETRY), "drop");
  h.advance(constants.HOLD_MS * 2 + 2);
  assert.strictEqual(h.native.wheelClaim(pane, GEOMETRY), "hold", "the gesture is over");
});

test("a mouse wheel's native event releases the terminal's notch at once", () => {
  const { h, pane } = calibrated();
  let delivered = 0;
  h.native.hold(pane, () => { delivered += 1; });
  h.native.noteNativeScroll(pane, false);
  assert.strictEqual(delivered, 1);
  // Nor to wait: the wheel's native event usually lands before its notch, which then goes at once.
  assert.strictEqual(h.native.wheelClaim(pane, GEOMETRY), "pass");
  h.advance(constants.DROP_MS + 1);
  assert.strictEqual(h.native.wheelClaim(pane, GEOMETRY), "hold");
});

test("a helper that never hears the wheel stops being waited for", () => {
  const { h, pane } = calibrated();
  for (let i = 0; i < constants.FLUSHES_TO_SILENCE; i += 1) {
    h.native.hold(pane, () => {});
    h.advance(constants.HOLD_MS + 1);
  }
  assert.strictEqual(h.native.wheelClaim(pane, GEOMETRY), "pass");
  h.advance(constants.SILENCE_MS);
  h.native.arm();
  assert.strictEqual(h.native.wheelClaim(pane, GEOMETRY), "hold");
});

test("an unlocated pane passes every notch straight through", () => {
  const h = harness();
  const pane = createPaneNative();
  h.native.arm();
  h.showWindow();
  assert.strictEqual(h.native.wheelClaim(pane, GEOMETRY), "pass");
});

test("arming starts the helper once and renews no faster than it must", () => {
  const h = harness();
  assert.strictEqual(h.native.arm(), true);
  assert.strictEqual(h.native.arm(), true);
  assert.strictEqual(h.spawned.length, 1);
  assert.deepStrictEqual(h.written, [`arm ${constants.ARM_SECONDS}\n`]);
  h.advance(constants.ARM_RENEW_MS);
  h.native.arm();
  assert.strictEqual(h.written.length, 2);
});

test("no helper, or one that died, leaves everything to the terminal", () => {
  const absent = harness({ binary: null });
  assert.strictEqual(absent.native.arm(), false);
  assert.strictEqual(absent.native.status, "absent");

  const h = harness();
  h.native.arm();
  h.spawned[0].child.emit("exit", 1, null);
  assert.strictEqual(h.native.status, "dead");
  assert.strictEqual(h.native.arm(), false);
  assert.strictEqual(h.native.report(createPaneNative(), GEOMETRY, 1, 1), null);

  const linux = new NativeInput({ platform: "linux", findHelper: () => "/bin/x" });
  assert.strictEqual(linux.arm(), false);
});

// Measured on a real Ghostty window: the grid was known to 0.1pt after a wander. Then a trackpad
// flick was posted at a point the pointer had not moved to, and Ghostty reported each wheel event
// at the last cell it had tracked. Three of those reset the estimate, and the horizontal wander
// that followed could never narrow Y again — the pointer stayed on cells for the rest of the run.
test("wheel and press reports at a stale cell do not undo a located grid", () => {
  const { h, pane } = calibrated();
  const located = h.native.estimateFor(GEOMETRY).origin();
  const stale = cellOf(WINDOW.x + 120, WINDOW.y + 140);
  for (let i = 0; i < 13; i += 1) {
    h.advance(16);
    h.line({ ev: "s", x: WINDOW.x + 560, y: WINDOW.y + 331, dx: 0, dy: -12, ph: 4, mo: 0, pr: true, mods: 0 });
    h.native.report(pane, GEOMETRY, stale.col, stale.row, { motion: false });
  }
  const estimate = h.native.estimateFor(GEOMETRY);
  assert.ok(estimate.usable(GEOMETRY.cellW, GEOMETRY.cellH));
  assert.deepStrictEqual(estimate.origin(), located, "a report that is not a cell crossing never calibrates");
});

test("a few disagreeing motion reports do not reset the grid", () => {
  const { h, pane } = calibrated();
  const located = h.native.estimateFor(GEOMETRY).origin();
  // The pointer is far away while the terminal still names an old cell: stale or from another path.
  for (let i = 0; i < 5; i += 1) {
    h.advance(16);
    h.line({ ev: "m", x: WINDOW.x + 560, y: WINDOW.y + 331, b: 0 });
    h.native.report(pane, GEOMETRY, 3 + (i % 2), 4);
  }
  const estimate = h.native.estimateFor(GEOMETRY);
  assert.ok(estimate.usable(GEOMETRY.cellW, GEOMETRY.cellH));
  assert.deepStrictEqual(estimate.origin(), located);
  assert.ok(estimate.conflicts >= 5);
});

test("a grid that really moved takes over once its own reports locate it", () => {
  const { h, pane } = calibrated();
  // Ghostty showing a tab bar: every cell 28pt lower in the same window.
  const moved = { x: GRID.x, y: GRID.y + 28 };
  const start = { x: WINDOW.x + 100, y: WINDOW.y + 150 };
  const end = { x: start.x + 80, y: start.y + 60 };
  travel(h, pane, start, end, 300, WINDOW, moved);
  travel(h, pane, end, start, 300, WINDOW, moved);
  const estimate = h.native.estimateFor(GEOMETRY);
  assert.ok(estimate.usable(GEOMETRY.cellW, GEOMETRY.cellH));
  assert.ok(Math.abs(estimate.origin().y - moved.y) < 0.5, `y ${estimate.origin().y}`);
  assert.ok(Math.abs(estimate.origin().x - moved.x) < 0.5, `x ${estimate.origin().x}`);
});
