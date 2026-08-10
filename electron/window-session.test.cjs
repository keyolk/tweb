"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isRestorableUrl,
  normalizeWindowSession,
  windowSessionForSave,
} = require("./window-session.cjs");

test("internal blank and placeholder URLs are not restorable", () => {
  assert.equal(isRestorableUrl("about:blank"), false);
  assert.equal(isRestorableUrl("data:text/html,loading"), false);
  assert.equal(isRestorableUrl("https://example.com/path"), true);
});

test("restore drops an internal active tab and selects the next surviving page", () => {
  assert.deepEqual(normalizeWindowSession({
    version: 1,
    activeIndex: 1,
    tabs: [
      { url: "https://one.example", zoom: 0.1 },
      { url: "about:blank", zoom: 0.8 },
      { url: "https://two.example", zoom: 3 },
    ],
  }, 0.8), {
    activeIndex: 1,
    tabs: [
      { url: "https://one.example", zoom: 0.5 },
      { url: "https://two.example", zoom: 2 },
    ],
  });
});

test("restore falls back to the last page when an internal active tab was last", () => {
  assert.deepEqual(normalizeWindowSession({
    version: 1,
    activeIndex: 2,
    tabs: [
      { url: "https://one.example", zoom: 0.8 },
      { url: "https://two.example", zoom: 0.8 },
      { url: "about:blank", zoom: 0.8 },
    ],
  }, 0.8), {
    activeIndex: 1,
    tabs: [
      { url: "https://one.example", zoom: 0.8 },
      { url: "https://two.example", zoom: 0.8 },
    ],
  });
});

test("blank-only state does not replace the last useful session", () => {
  assert.equal(windowSessionForSave([
    { url: "about:blank", zoom: 0.8 },
    { url: "data:text/html,loading", zoom: 0.8 },
  ], 0, 0.8), null);
});

test("save omits internal tabs and remaps the active index", () => {
  assert.deepEqual(windowSessionForSave([
    { url: "about:blank", zoom: 0.8 },
    { url: "https://example.com", zoom: 1.25 },
  ], 0, 0.8), {
    version: 1,
    activeIndex: 0,
    tabs: [{ url: "https://example.com", zoom: 1.25 }],
  });
});
