"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createControlGate } = require("./control-gate.cjs");

test("lines before the gate opens wait, then arrive in order", () => {
  const seen = [];
  const gate = createControlGate((line) => seen.push(line));
  gate.push("RESIZE 60 18 420 252 127 48\nINPUT 61\n");
  assert.deepEqual(seen, []);
  assert.equal(gate.heldCount, 2);
  gate.open();
  assert.deepEqual(seen, ["RESIZE 60 18 420 252 127 48", "INPUT 61"]);
  gate.push("VIS 00\n");
  assert.deepEqual(seen.at(-1), "VIS 00");
});

test("a chunk that ends mid-line keeps its tail for the next one", () => {
  const seen = [];
  const gate = createControlGate((line) => seen.push(line));
  gate.open();
  gate.push("RESIZE 80 24 ");
  assert.deepEqual(seen, []);
  gate.push("800 480\nINP");
  assert.deepEqual(seen, ["RESIZE 80 24 800 480"]);
  gate.push("UT 1b\n");
  assert.deepEqual(seen, ["RESIZE 80 24 800 480", "INPUT 1b"]);
});

test("opening twice delivers the held lines once", () => {
  const seen = [];
  const gate = createControlGate((line) => seen.push(line));
  gate.push("INPUT 61\n");
  gate.open();
  gate.open();
  assert.deepEqual(seen, ["INPUT 61"]);
});
