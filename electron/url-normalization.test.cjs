"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeUrl } = require("./url-normalization.cjs");

test("absolute local paths become encoded file URLs", () => {
  assert.equal(
    normalizeUrl("/private/tmp/TWeb 계획 #1.html"),
    "file:///private/tmp/TWeb%20%EA%B3%84%ED%9A%8D%20%231.html"
  );
});

test("explicit relative paths resolve against the caller directory", () => {
  assert.equal(
    normalizeUrl("./README.md", "/Users/example/project"),
    "file:///Users/example/project/README.md"
  );
  assert.equal(
    normalizeUrl("../docs/계획 #1.md", "/Users/example/project"),
    "file:///Users/example/docs/%EA%B3%84%ED%9A%8D%20%231.md"
  );
});

test("web URLs and local development hosts keep existing behavior", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
  assert.equal(normalizeUrl("file:///private/tmp/page.html"), "file:///private/tmp/page.html");
});
