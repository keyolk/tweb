"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { hangulKeys } = require("./hangul-keys.cjs");

test("a syllable the IME composed is the keys that typed it", () => {
  assert.strictEqual(hangulKeys("러"), "fj");
  assert.strictEqual(hangulKeys("가"), "rk");
  // Compound final and compound vowel come apart into their two keys.
  assert.strictEqual(hangulKeys("읽"), "dlfr");
  assert.strictEqual(hangulKeys("과"), "rhk");
  assert.strictEqual(hangulKeys("힣"), "glg");
});

test("a lone jamo is its key, the doubled consonants shifted", () => {
  assert.strictEqual(hangulKeys("ㄹ"), "f");
  assert.strictEqual(hangulKeys("ㅃ"), "Q");
  assert.strictEqual(hangulKeys("ㅒ"), "O");
  assert.strictEqual(hangulKeys("ㅘ"), "hk");
  // Conjoining jamo, as NFD writes a syllable.
  assert.strictEqual([..."러".normalize("NFD")].map(hangulKeys).join(""), "fj");
  assert.strictEqual(hangulKeys("ᆰ"), "fr");
});

test("anything that is not Hangul is left alone", () => {
  for (const char of ["a", "J", "1", "中", "あ", " "]) assert.strictEqual(hangulKeys(char), null);
});
