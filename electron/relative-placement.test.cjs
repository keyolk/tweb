"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { relativePatchesDecision, parseVersion } = require("./relative-placement.cjs");

test("Ghostty 1.4 and later place patches relative to the base", () => {
  for (const clientTermtype of ["ghostty 1.4.0", "ghostty 1.4.1", "ghostty 1.5.0-dev+abc", "ghostty 2.0.0"]) {
    assert.equal(relativePatchesDecision({ clientTermtype }).allowed, true, clientTermtype);
  }
});

// The compatibility path: a patch an older terminal cannot place is silently dropped (`q=2`), so
// it must never be sent one.
test("older Ghostty keeps the absolute path", () => {
  for (const clientTermtype of ["ghostty 1.3.1", "ghostty 1.2.3", "ghostty 1.3.99"]) {
    const decision = relativePatchesDecision({ clientTermtype });
    assert.equal(decision.allowed, false, clientTermtype);
    assert.match(decision.reason, /< 1\.4\.0/);
  }
});

test("a Ghostty whose version cannot be read keeps the absolute path", () => {
  assert.equal(relativePatchesDecision({ clientTermtype: "ghostty" }).allowed, false);
  assert.equal(relativePatchesDecision({ termProgram: "ghostty" }).allowed, false);
});

test("other and unknown terminals keep the absolute path", () => {
  assert.equal(relativePatchesDecision({ clientTermtype: "kitty(0.35.2)" }).allowed, false);
  assert.equal(relativePatchesDecision({ clientTermtype: "WezTerm 20240203" }).allowed, false);
  assert.equal(relativePatchesDecision({}).allowed, false);
});

// Inside tmux the environment is tmux's own — TERM_PROGRAM=tmux, TERM_PROGRAM_VERSION=3.8 — which
// would read as "version 3.8" if it were consulted. The attached client's answer decides.
test("the attached client's answer wins over a tmux-owned environment", () => {
  assert.equal(relativePatchesDecision({
    clientTermtype: "ghostty 1.3.1", termProgram: "ghostty", termProgramVersion: "1.4.0",
  }).allowed, false);
  assert.equal(relativePatchesDecision({
    clientTermtype: "ghostty 1.4.0", termProgram: "tmux", termProgramVersion: "3.8",
  }).allowed, true);
});

test("outside tmux the environment names the terminal", () => {
  assert.equal(relativePatchesDecision({ termProgram: "ghostty", termProgramVersion: "1.4.0" }).allowed, true);
  assert.equal(relativePatchesDecision({ termProgram: "ghostty", termProgramVersion: "1.3.1" }).allowed, false);
  assert.equal(relativePatchesDecision({ termProgram: "tmux", termProgramVersion: "3.8" }).allowed, false);
});

test("the override wins both ways", () => {
  assert.equal(relativePatchesDecision({ clientTermtype: "ghostty 1.4.0", override: "0" }).allowed, false);
  assert.equal(relativePatchesDecision({ clientTermtype: "ghostty 1.3.1", override: "1" }).allowed, true);
});

test("version parsing", () => {
  assert.deepEqual(parseVersion("ghostty 1.4.0"), [1, 4, 0]);
  assert.deepEqual(parseVersion("1.4"), [1, 4, 0]);
  assert.deepEqual(parseVersion("1.10.2-dev"), [1, 10, 2]);
  assert.equal(parseVersion("ghostty"), null);
  assert.equal(parseVersion(undefined), null);
});
