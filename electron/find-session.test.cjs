"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { IDLE, findStep, endStep } = require("./find-session.cjs");

test("the first request of a session opens one", () => {
  const { options, state } = findStep(IDLE, "domain", true);
  assert.strictEqual(options.findNext, true, "a fresh query must open a session or nothing is emitted");
  assert.strictEqual(options.forward, true);
  assert.deepStrictEqual(state, { active: true, query: "domain" });
});

test("repeating the same query inside a live session advances rather than restarting", () => {
  const opened = findStep(IDLE, "domain", true).state;
  const { options } = findStep(opened, "domain", true);
  assert.strictEqual(options.findNext, false, "restarting would pin the counter at 1 and never advance");
});

test("a changed query starts over so the counter reads from the first match", () => {
  const opened = findStep(IDLE, "dom", true).state;
  const grown = findStep(opened, "doma", true);
  assert.strictEqual(grown.options.findNext, true);
  assert.strictEqual(grown.state.query, "doma");
});

test("direction is carried through without ending the session", () => {
  const opened = findStep(IDLE, "domain", true).state;
  const back = findStep(opened, "domain", false);
  assert.strictEqual(back.options.forward, false);
  assert.strictEqual(back.options.findNext, false);
  assert.strictEqual(back.state.active, true);
});

test("an ended session makes the next request open a new one", () => {
  const opened = findStep(IDLE, "domain", true).state;
  const stopped = endStep().state;
  assert.strictEqual(stopped.active, false);
  assert.strictEqual(findStep(stopped, "domain", true).options.findNext, true);
  assert.strictEqual(findStep(opened, "domain", true).options.findNext, false, "ending a copy leaves the live state alone");
});

test("unknown state is treated as no session", () => {
  // A tab first seen mid-run, or one whose state was dropped, must not send a follow-up
  // into a session that does not exist — that failure is silent.
  assert.strictEqual(findStep(undefined, "domain", true).options.findNext, true);
  assert.strictEqual(findStep(null, "domain", true).options.findNext, true);
});

test("forward defaults to true when the pane does not say", () => {
  assert.strictEqual(findStep(IDLE, "domain").options.forward, true);
  assert.strictEqual(findStep(IDLE, "domain", undefined).options.forward, true);
});
