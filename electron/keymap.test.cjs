"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseKeymap } = require("./keymap.cjs");

test("NEW=OLD binds, -KEY unbinds, a later entry for the same key wins", () => {
  const { pairs, warnings } = parseKeymap(["n=j", "e=k", "-x", "n=d", "==j"]);
  assert.deepEqual(new Map(pairs), new Map([["n", "d"], ["e", "k"], ["x", null], ["=", "j"]]));
  assert.deepEqual(warnings, []);
});

test("chords, named keys and malformed entries are refused with a reason", () => {
  const { pairs, warnings } = parseKeymap(["gg=G", "Escape=x", "-Escape", "nj", "n=", "", null, "a=a"]);
  assert.deepEqual(pairs, []);
  assert.equal(warnings.length, 5);
  assert.match(warnings[0], /single keys/);
  assert.match(warnings[2], /single key can be unbound/);
  assert.match(warnings[3], /NEW=OLD or -KEY/);
});

test("anything that is not a list is no keymap", () => {
  assert.deepEqual(parseKeymap(undefined), { pairs: [], warnings: [] });
  assert.deepEqual(parseKeymap("n=j"), { pairs: [], warnings: [] });
});
