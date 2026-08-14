"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isOrphaned, INIT_PID } = require("./orphan-watch.cjs");

test("reparenting to init means the frontend is gone", () => {
  assert.equal(isOrphaned(4242, INIT_PID), true);
});

test("a live parent is not an orphan, whatever its pid", () => {
  // Chromium reparents the engine while starting, so the current parent is routinely not
  // the pid that launched it. Only init specifically means orphaned.
  assert.equal(isOrphaned(4242, 4242), false);
  assert.equal(isOrphaned(4242, 9999), false);
});

test("no frontend pid means nothing to watch", () => {
  // Started by hand or by a test: exiting on a guess would kill a legitimate run.
  assert.equal(isOrphaned(undefined, INIT_PID), false);
  assert.equal(isOrphaned("", INIT_PID), false);
  assert.equal(isOrphaned(0, INIT_PID), false);
  assert.equal(isOrphaned(INIT_PID, INIT_PID), false);
  assert.equal(isOrphaned("not-a-pid", INIT_PID), false);
});
