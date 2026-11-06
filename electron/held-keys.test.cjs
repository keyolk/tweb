"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createHeldKeys } = require("./held-keys.cjs");

// A fake clock: timers fire only when `advance` passes them, so each case reads as a timeline.
function clock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
}

// The settings this machine was measured on: InitialKeyRepeat 10 (150 ms), KeyRepeat 2 (30 ms).
function rig() {
  const c = clock();
  const keys = createHeldKeys({ setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now, initialMs: 150, intervalMs: 30 });
  const log = [];
  const press = (id = "ArrowRight") => keys.press(id, (rep) => log.push(`${c.now()} down${rep ? "*" : ""}`), () => log.push(`${c.now()} up`));
  return { c, keys, log, press };
}

test("a tap is one keyDown and, after the first window, one keyUp", () => {
  const { c, keys, log, press } = rig();
  press();
  c.advance(1000);
  assert.deepStrictEqual(log, ["0 down", `${keys.windows.firstMs} up`]);
});

test("holding through terminal autorepeat stays down, repeats marked, no keyUp between", () => {
  // The cadence measured from tmux: first repeat after 166 ms, then every ~33 ms.
  const { c, keys, log, press } = rig();
  press();
  c.advance(166);
  assert.strictEqual(press(), "repeat", "the first repeat at the OS delay is a repeat, not a second press");
  for (let i = 0; i < 10; i++) {
    c.advance(33);
    press();
  }
  assert.ok(!log.some((l) => l.endsWith("up")), `no keyUp while held: ${log.join(", ")}`);
  assert.strictEqual(log[0], "0 down");
  assert.ok(log.slice(1).every((l) => l.endsWith("down*")), "every repeat is marked autorepeat");
  const last = c.now();
  c.advance(1000);
  assert.strictEqual(log.at(-1), `${last + keys.windows.repeatMs} up`);
});

test("a double tap faster than the repeat delay is keyUp then a fresh keyDown", () => {
  const { c, log, press } = rig();
  press();
  c.advance(100);
  assert.strictEqual(press(), "again");
  assert.deepStrictEqual(log, ["0 down", "100 up", "100 down"]);
});

test("mashing a button gives one press per hit", () => {
  const { c, log, press } = rig();
  for (let i = 0; i < 4; i++) {
    press("x");
    c.advance(120);
  }
  assert.strictEqual(log.filter((l) => l.endsWith(" down")).length, 4);
  assert.ok(!log.some((l) => l.endsWith("down*")));
});

test("a real release lets go at once and cancels the timer", () => {
  const { c, keys, log, press } = rig();
  press();
  c.advance(50);
  assert.strictEqual(keys.release("ArrowRight"), true);
  c.advance(1000);
  assert.deepStrictEqual(log, ["0 down", "50 up"]);
});

test("a release for a key that is not held does nothing", () => {
  const { keys, log } = rig();
  assert.strictEqual(keys.release("x"), false);
  assert.deepStrictEqual(log, []);
});

test("different keys are held independently", () => {
  const { c, keys, log, press } = rig();
  press("ArrowRight");
  c.advance(100);
  press("x");
  c.advance(1000);
  assert.deepStrictEqual(log, ["0 down", "100 down", `${keys.windows.firstMs} up`, `${100 + keys.windows.firstMs} up`]);
});

test("releaseAll lets go of everything now", () => {
  const { keys, log, press } = rig();
  press("a");
  press("b");
  keys.releaseAll();
  assert.strictEqual(log.filter((l) => l.endsWith("up")).length, 2);
  assert.strictEqual(keys.isHeld("a"), false);
});
