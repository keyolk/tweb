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

// break-pane gives the pane a new window id and join-pane can change its session
// too, while the pane id stays the same. Matching against where the pane started
// then misses every client, the pane looks hidden, and painting stops — it froze
// after being moved. The caller has to pass the pane's live placement.
test("a moved pane is visible once matched against its current window", () => {
  const moved = { session: "work", windowId: "@11", paneId: "%7" };
  const clients = "/dev/ttys001\twork\t@11\t0\t%7";
  assert.deepEqual([...visibleTmuxClientTtys(clients, identity)], [],
    "the startup window no longer matches, which is the bug being guarded");
  assert.deepEqual([...visibleTmuxClientTtys(clients, moved)], ["/dev/ttys001"]);
});

test("a pane joined into another session is visible under that session", () => {
  const joined = { session: "other", windowId: "@2", paneId: "%7" };
  const clients = "/dev/ttys001\tother\t@2\t0\t%7";
  assert.deepEqual([...visibleTmuxClientTtys(clients, joined)], ["/dev/ttys001"]);
});
