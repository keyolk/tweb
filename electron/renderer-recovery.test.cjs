"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  recoveryDecision,
  MAX_ATTEMPTS,
  ATTEMPT_WINDOW_MS,
  CLEAN_EXIT,
} = require("./renderer-recovery.cjs");

const NOW = 1_700_000_000_000;

test("a crashed renderer is reloaded", () => {
  // Measured on a live pane: SIGKILL the renderer and the page answers nothing ever again,
  // while `tweb status` still reports a healthy engine pid.
  assert.deepEqual(recoveryDecision("crashed", [], NOW), {
    action: "reload",
    recent: [NOW],
  });
  for (const reason of ["oom", "killed", "abnormal-exit", "launch-failed", "integrity-failure"]) {
    assert.equal(recoveryDecision(reason, [], NOW).action, "reload");
  }
});

test("a clean exit is the ordinary teardown, not a loss", () => {
  // Navigating away and closing a tab both retire a render process. Reloading here would
  // resurrect the page the user just left.
  const decision = recoveryDecision(CLEAN_EXIT, [], NOW);
  assert.equal(decision.action, "ignore");
  assert.deepEqual(decision.recent, []);
});

test("a clean exit neither spends nor prunes the budget", () => {
  const attempts = [NOW - 1000, NOW - 500];
  assert.deepEqual(recoveryDecision(CLEAN_EXIT, attempts, NOW).recent, attempts);
});

test("attempts are spent, then recovery gives up and says so", () => {
  let attempts = [];
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const decision = recoveryDecision("crashed", attempts, NOW + i);
    assert.equal(decision.action, "reload", `attempt ${i + 1} should still reload`);
    attempts = decision.recent;
  }
  // A page that crashes its renderer on load would otherwise reload forever, each attempt
  // spawning a process and repainting the pane.
  const exhausted = recoveryDecision("crashed", attempts, NOW + MAX_ATTEMPTS);
  assert.equal(exhausted.action, "report");
  assert.equal(exhausted.recent.length, MAX_ATTEMPTS);
});

test("attempts outside the window are forgotten", () => {
  // A tab that crashed once an hour ago starts with a full budget rather than being
  // penalised for ancient history.
  const stale = [NOW - ATTEMPT_WINDOW_MS - 1, NOW - ATTEMPT_WINDOW_MS * 2];
  const decision = recoveryDecision("crashed", stale, NOW);
  assert.equal(decision.action, "reload");
  assert.deepEqual(decision.recent, [NOW]);
});

test("an attempt exactly at the window edge has expired", () => {
  const decision = recoveryDecision("crashed", [NOW - ATTEMPT_WINDOW_MS], NOW);
  assert.deepEqual(decision.recent, [NOW]);
});

test("a budget spent long ago does not block recovery now", () => {
  const spent = Array.from({ length: MAX_ATTEMPTS }, (_, i) => NOW - ATTEMPT_WINDOW_MS - i);
  assert.equal(recoveryDecision("crashed", spent, NOW).action, "reload");
});

test("limits are overridable so the caller can tune without editing the policy", () => {
  assert.equal(recoveryDecision("crashed", [NOW], NOW, { maxAttempts: 1 }).action, "report");
  assert.equal(
    recoveryDecision("crashed", [NOW - 50], NOW, { windowMs: 10 }).action,
    "reload"
  );
});

test("a missing or malformed attempt list is not an error", () => {
  for (const attempts of [null, undefined, [], [NaN, "x", Infinity]]) {
    const decision = recoveryDecision("crashed", attempts, NOW);
    assert.equal(decision.action, "reload");
    assert.deepEqual(decision.recent, [NOW]);
  }
});
