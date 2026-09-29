"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { deflateFramesAllowed } = require("./deflate-policy.cjs");

// Ghostty 1.3.1 does not reject an `o=z` frame — it aborts on one, and the abort takes every
// Ghostty window down with it. See deflate-policy.cjs for the 13 crash reports this is built on.
test("Ghostty never gets a deflated frame", () => {
  assert.equal(deflateFramesAllowed({ clientTermname: "xterm-ghostty" }), false);
  assert.equal(deflateFramesAllowed({ term: "xterm-ghostty" }), false);
  assert.equal(deflateFramesAllowed({ termProgram: "ghostty" }), false);
  // Case is not something a terminfo name guarantees.
  assert.equal(deflateFramesAllowed({ clientTermname: "XTERM-GHOSTTY" }), false);
});

// Inside tmux, `TERM` and `TERM_PROGRAM` are tmux's own, so the outer terminal is invisible from
// the environment. Reading only those would have sent Ghostty the very frames that kill it.
test("the attached client's name wins over a tmux-owned environment", () => {
  assert.equal(deflateFramesAllowed({
    clientTermname: "xterm-ghostty", term: "tmux-256color", termProgram: "tmux",
  }), false);
});

test("kitty keeps the deflate path it was measured on", () => {
  assert.equal(deflateFramesAllowed({ clientTermname: "xterm-kitty" }), true);
  assert.equal(deflateFramesAllowed({ term: "xterm-kitty", termProgram: "tmux" }), true);
});

test("an unknown terminal keeps it too, since only the fatal one is named", () => {
  assert.equal(deflateFramesAllowed({ clientTermname: "xterm-256color" }), true);
  assert.equal(deflateFramesAllowed({}), true);
  assert.equal(deflateFramesAllowed(), true);
});

test("the override decides in both directions", () => {
  // Off everywhere — the escape hatch #42 added.
  assert.equal(deflateFramesAllowed({ clientTermname: "xterm-kitty", override: "0" }), false);
  // And on for a Ghostty someone is testing a fix on, without waiting for the list to change.
  assert.equal(deflateFramesAllowed({ clientTermname: "xterm-ghostty", override: "1" }), true);
  // Anything else is not an override.
  assert.equal(deflateFramesAllowed({ clientTermname: "xterm-ghostty", override: "yes" }), false);
});
