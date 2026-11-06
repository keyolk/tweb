"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createHeldKeys, FIRST_MS, REPEAT_MS } = require("./held-keys.cjs");

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

function rig() {
  const c = clock();
  const keys = createHeldKeys({ setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now });
  const log = [];
  const press = (id = "ArrowRight") => keys.press(id, (rep) => log.push(`${c.now()} down${rep ? "*" : ""}`), () => log.push(`${c.now()} up`));
  return { c, keys, log, press };
}

test("a tap is one keyDown and, after the first window, one keyUp", () => {
  const { c, log, press } = rig();
  press();
  c.advance(1000);
  assert.deepStrictEqual(log, ["0 down", `${FIRST_MS} up`]);
});

test("holding through terminal autorepeat stays down with no keyUp between repeats", () => {
  // The cadence measured from tmux on macOS: first repeat after 166 ms, then every ~33 ms.
  const { c, log, press } = rig();
  press();
  c.advance(166);
  press();
  for (let i = 0; i < 10; i++) {
    c.advance(33);
    press();
  }
  assert.ok(!log.some((l) => l.endsWith("up")), `no keyUp while held: ${log.join(", ")}`);
  assert.strictEqual(log[0], "0 down");
  assert.ok(log.slice(2).every((l) => l.endsWith("down*")), "repeats are marked autorepeat");
  const last = c.now();
  c.advance(1000);
  assert.strictEqual(log.at(-1), `${last + REPEAT_MS} up`, "released one repeat window after the last repeat");
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

test("a double tap reaches the page as two keyDowns", () => {
  const { c, log, press } = rig();
  press();
  c.advance(120);
  press();
  c.advance(1000);
  assert.deepStrictEqual(log.filter((l) => l.includes("down")).length, 2);
  assert.strictEqual(log.filter((l) => l.endsWith("up")).length, 1);
});

test("different keys are held independently", () => {
  const { c, log, press } = rig();
  press("ArrowRight");
  c.advance(100);
  press("x");
  c.advance(250);
  assert.deepStrictEqual(log, ["0 down", "100 down", `${FIRST_MS} up`]);
  c.advance(1000);
  assert.strictEqual(log.at(-1), `${100 + FIRST_MS} up`);
});

test("releaseAll lets go of everything now", () => {
  const { keys, log, press } = rig();
  press("a");
  press("b");
  keys.releaseAll();
  assert.deepStrictEqual(log.filter((l) => l.endsWith("up")).length, 2);
  assert.strictEqual(keys.isHeld("a"), false);
});
