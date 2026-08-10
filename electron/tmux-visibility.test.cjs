"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { visibleTmuxClientTtys } = require("./tmux-visibility.cjs");

const identity = { session: "work", windowId: "@3", paneId: "%7" };

function visible(...lines) {
  return [...visibleTmuxClientTtys(lines.join("\n"), identity)];
}

test("an unzoomed client shows every pane in its current window", () => {
  assert.deepEqual(visible("/dev/ttys001\twork\t@3\t0\t%9"), ["/dev/ttys001"]);
});

test("a client zoomed into the browser pane still shows it", () => {
  assert.deepEqual(visible("/dev/ttys001\twork\t@3\t1\t%7"), ["/dev/ttys001"]);
});

test("a client zoomed into another pane hides the browser pane", () => {
  assert.deepEqual(visible("/dev/ttys001\twork\t@3\t1\t%9"), []);
});

test("visibility is tracked independently for each attached client", () => {
  assert.deepEqual(visible(
    "/dev/ttys001\twork\t@3\t1\t%9",
    "/dev/ttys002\twork\t@3\t0\t%9",
    "/dev/ttys003\twork\t@4\t0\t%7",
    "/dev/ttys004\tother\t@3\t0\t%7",
  ), ["/dev/ttys002"]);
});
