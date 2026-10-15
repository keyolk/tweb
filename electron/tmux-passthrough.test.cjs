"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { passthroughRuns, TMUX_PASSTHROUGH_MAX } = require("./tmux-passthrough.cjs");

const command = (n) => `\x1b_Gm=1,q=2;${"A".repeat(n)}\x1b\\`;

test("a small run stays one passthrough", () => {
  const commands = [command(10), command(10)];
  assert.deepEqual(passthroughRuns(commands), [commands.join("")]);
});

test("a run past the cap is cut between commands, never inside one", () => {
  const commands = Array.from({ length: 10 }, () => command(3072));
  const runs = passthroughRuns(commands, 10_000);
  assert.ok(runs.length > 1);
  assert.equal(runs.join(""), commands.join(""));
  for (const run of runs) {
    assert.ok(run.length <= 10_000, `run of ${run.length}`);
    assert.ok(run.startsWith("\x1b_G") && run.endsWith("\x1b\\"), "a run holds whole commands");
  }
});

test("a whole 2880x1800 inline frame lands well under tmux's 1MB", () => {
  // ~1MB of base64 in the worker's 3KB chunks, the size that was being dropped.
  const commands = Array.from({ length: 340 }, () => command(3072));
  const runs = passthroughRuns(commands);
  assert.ok(runs.every((run) => run.length <= TMUX_PASSTHROUGH_MAX));
  assert.ok(TMUX_PASSTHROUGH_MAX * 2 < 1024 * 1024, "doubled ESCs still fit");
});

test("an oversized single command still goes out, alone", () => {
  const big = command(20);
  assert.deepEqual(passthroughRuns([command(1), big, command(1)], 30), [command(1), big, command(1)]);
});

test("nothing in, nothing out", () => {
  assert.deepEqual(passthroughRuns([]), []);
});
