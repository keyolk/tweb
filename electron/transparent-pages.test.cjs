"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { transparentPages, transparentWindowOptions } = require("./transparent-pages.cjs");

test("off unless the flag or the setting asks", () => {
  assert.equal(transparentPages(), false);
  assert.equal(transparentPages({ flag: true }), true);
  assert.equal(transparentPages({ setting: true }), true);
});

test("only the Electron engine can draw a clear page", () => {
  // Chrome's screencast is JPEG and the WebKit host has no transparent path.
  for (const backend of ["chrome", "webkit"]) {
    assert.equal(transparentPages({ flag: true, setting: true, backend }), false);
  }
});

test("a transparent tab gets a fully clear base background", () => {
  assert.deepEqual(transparentWindowOptions(true), { transparent: true, backgroundColor: "#00000000" });
  assert.deepEqual(transparentWindowOptions(false), {});
});
