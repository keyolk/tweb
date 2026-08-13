"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PasteState, PASTE_START } = require("./paste-state.cjs");

function feed(state, ...chunks) {
  const results = [];
  for (const chunk of chunks) {
    let buffer = Buffer.from(chunk, "latin1");
    if (!state.active && state.begins(buffer)) {
      state.start();
      buffer = buffer.subarray(PASTE_START.length);
    }
    if (!state.active) {
      results.push({ passthrough: buffer.toString("latin1") });
      continue;
    }
    const done = state.push(buffer);
    if (done) results.push(done);
  }
  return results;
}

test("a paste arriving in one chunk yields its body", () => {
  const state = new PasteState();
  const [done] = feed(state, "\x1b[200~hello\x1b[201~");
  assert.equal(done.text, "hello");
  assert.equal(done.rest.length, 0);
  assert.equal(state.active, false);
});

test("a body split across chunks is reassembled", () => {
  const state = new PasteState();
  const results = feed(state, "\x1b[200~hel", "lo wo", "rld\x1b[201~");
  assert.equal(results.length, 1);
  assert.equal(results[0].text, "hello world");
});

test("a body containing ESC is not parsed as key sequences", () => {
  const state = new PasteState();
  // A closing-bracket lookalike and a real CSI both belong to the text.
  const [done] = feed(state, "\x1b[200~a\x1b[1;2Ab\x1b[201~");
  assert.equal(done.text, "a\x1b[1;2Ab");
});

test("a closing bracket split across chunks still ends the paste", () => {
  const state = new PasteState();
  const results = feed(state, "\x1b[200~text\x1b[2", "01~after");
  assert.equal(results.length, 1);
  assert.equal(results[0].text, "text");
  assert.equal(results[0].rest.toString("latin1"), "after");
});

test("input following the closing bracket is handed back unconsumed", () => {
  const state = new PasteState();
  const [done] = feed(state, "\x1b[200~body\x1b[201~\x1b[5020~");
  assert.equal(done.text, "body");
  assert.equal(done.rest.toString("latin1"), "\x1b[5020~");
});

test("an unterminated paste is dropped at the limit instead of eating input", () => {
  const state = new PasteState({ limit: 8 });
  const results = feed(state, "\x1b[200~", "aaaaaaaaaaaa");
  assert.equal(results[0].dropped, true);
  assert.equal(results[0].text, null);
  assert.equal(state.active, false);
});

test("multiline bodies survive, which is what unbracketed paste breaks", () => {
  const state = new PasteState();
  // Without bracketing these newlines dispatch as Enter and can send a
  // half-typed message before the rest of the text arrives.
  const [done] = feed(state, "\x1b[200~line one\nline two\nline three\x1b[201~");
  assert.equal(done.text, "line one\nline two\nline three");
});

test("a lone opening bracket keeps the state open for the next chunk", () => {
  const state = new PasteState();
  const results = feed(state, "\x1b[200~");
  assert.equal(results.length, 0);
  assert.equal(state.active, true);
});
