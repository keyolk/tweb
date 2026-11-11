"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  rendererUsage,
  memoryDecision,
  SUSTAIN_MS,
  QUIET_INPUT_MS,
  RELOAD_COOLDOWN_MS,
} = require("./renderer-memory.cjs");

const NOW = 1_700_000_000_000;
const MB = 1024; // workingSetSize is KB

test("usage is per process, largest first, with the tabs each one serves", () => {
  const metrics = [
    { pid: 10, type: "Browser", memory: { workingSetSize: 200 * MB } },
    { pid: 11, type: "Tab", memory: { workingSetSize: 90 * MB } },
    { pid: 12, type: "Tab", memory: { workingSetSize: 2007 * MB } },
    { pid: 13, type: "Tab", memory: { workingSetSize: 40 * MB } },
  ];
  const usage = rendererUsage(metrics, [
    { index: 0, pids: [11] },
    { index: 1, pids: [12, 13] }, // main frame in 12, an out-of-process iframe in 13
    { index: 2, pids: [12] }, // shares the renderer with tab 1
  ]);
  assert.deepEqual(usage, [
    { pid: 12, mb: 2007, tabs: [1, 2], main: [1, 2] },
    { pid: 11, mb: 90, tabs: [0], main: [0] },
    { pid: 13, mb: 40, tabs: [1], main: [] },
  ]);
});

test("the browser process and pids with no metric are left out", () => {
  // A Chrome- or WebKit-engine tab has no Electron renderer; its pid is unknown to getAppMetrics.
  const usage = rendererUsage([{ pid: 10, memory: { workingSetSize: 200 * MB } }], [
    { index: 0, pids: [99] },
    { index: 1, pids: [] },
  ]);
  assert.deepEqual(usage, []);
});

const base = {
  mb: 2000, limitMb: 1536, onScreen: false, audible: false, shared: false, lastInputAt: null, now: NOW,
};

test("under the limit nothing happens, and an earlier crossing is forgotten", () => {
  const decision = memoryDecision({ ...base, mb: 500 }, { overSince: NOW - 1000, warned: true });
  assert.equal(decision.action, "none");
  assert.equal(decision.state.overSince, null);
  assert.equal(decision.state.warned, false);
});

test("one sample over the limit is a spike, not a leak", () => {
  const first = memoryDecision(base);
  assert.equal(first.action, "none");
  assert.equal(first.state.overSince, NOW);
  const almost = memoryDecision({ ...base, now: NOW + SUSTAIN_MS - 1 }, first.state);
  assert.equal(almost.action, "none");
});

test("a hidden, quiet tab that stays over the limit is reloaded", () => {
  const first = memoryDecision(base);
  const decision = memoryDecision({ ...base, now: NOW + SUSTAIN_MS }, first.state);
  assert.equal(decision.action, "reload");
  assert.equal(decision.state.reloadedAt, NOW + SUSTAIN_MS);
  assert.equal(decision.state.overSince, null);
});

for (const [name, input, reason] of [
  ["the tab on screen", { onScreen: true }, "on screen"],
  ["a tab playing sound", { audible: true }, "playing sound"],
  ["a renderer another tab also lives in", { shared: true }, "renderer shared with another tab"],
  ["a tab the user typed into recently", { lastInputAt: NOW + SUSTAIN_MS }, "used in the last 5 minutes"],
]) {
  test(`${name} is warned about once, never reloaded`, () => {
    const first = memoryDecision({ ...base, ...input });
    const warn = memoryDecision({ ...base, ...input, now: NOW + SUSTAIN_MS }, first.state);
    assert.equal(warn.action, "warn");
    assert.equal(warn.reason, reason);
    const again = memoryDecision({ ...base, ...input, now: NOW + SUSTAIN_MS + 1000 }, warn.state);
    assert.equal(again.action, "none");
  });
}

test("old input does not protect a tab", () => {
  const first = memoryDecision({ ...base, lastInputAt: NOW - QUIET_INPUT_MS });
  const decision = memoryDecision({ ...base, lastInputAt: NOW - QUIET_INPUT_MS, now: NOW + SUSTAIN_MS }, first.state);
  assert.equal(decision.action, "reload");
});

test("a tab that is back over the limit soon after a reload is warned about, not reloaded again", () => {
  const reloadedAt = NOW;
  const first = memoryDecision({ ...base, now: NOW + 60_000 }, { reloadedAt });
  const decision = memoryDecision({ ...base, now: NOW + 60_000 + SUSTAIN_MS }, first.state);
  assert.equal(decision.action, "warn");
  assert.equal(decision.reason, "reloaded less than 30 minutes ago");
  const later = memoryDecision({ ...base, now: NOW + RELOAD_COOLDOWN_MS + SUSTAIN_MS + 1 }, { reloadedAt, overSince: NOW + RELOAD_COOLDOWN_MS });
  assert.equal(later.action, "reload");
});

test("a limit of 0 turns the guard off, and an unknown size does nothing", () => {
  const off = memoryDecision({ ...base, limitMb: 0, now: NOW + SUSTAIN_MS }, { overSince: NOW });
  assert.equal(off.action, "none");
  const unknown = memoryDecision({ ...base, mb: null, now: NOW + SUSTAIN_MS }, { overSince: NOW });
  assert.equal(unknown.action, "none");
});
