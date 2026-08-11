"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isRestorableUrl,
  normalizeWindowSession,
  windowSessionForSave,
  windowSessionKeys,
} = require("./window-session.cjs");

const tmuxIdentity = {
  socketPath: "/private/tmp/tmux-502/default",
  serverStartedAt: "100",
  session: "work",
  windowId: "@7",
  windowIndex: "3",
};

test("the primary session key survives a tmux server restart", () => {
  const before = windowSessionKeys(tmuxIdentity);
  const after = windowSessionKeys({
    ...tmuxIdentity,
    serverStartedAt: "200",
    windowId: "@1",
  });
  assert.equal(before.primary, after.primary);
  assert.notEqual(before.legacy, after.legacy);
});

test("session names and window slots keep independent state", () => {
  const original = windowSessionKeys(tmuxIdentity).primary;
  assert.notEqual(original, windowSessionKeys({ ...tmuxIdentity, session: "other" }).primary);
  assert.notEqual(original, windowSessionKeys({ ...tmuxIdentity, windowIndex: "4" }).primary);
});

test("internal blank and placeholder URLs are not restorable", () => {
  assert.equal(isRestorableUrl("about:blank"), false);
  assert.equal(isRestorableUrl("data:text/html,loading"), false);
  assert.equal(isRestorableUrl("https://example.com/path"), true);
});

test("legacy sessions without successful-load proof are not restored", () => {
  assert.equal(normalizeWindowSession({
    version: 1,
    activeIndex: 0,
    tabs: [{ url: "https://failed.example", zoom: 0.8 }],
  }, 0.8), null);
});

test("restore drops unconfirmed and internal tabs and selects the next loaded page", () => {
  assert.deepEqual(normalizeWindowSession({
    version: 2,
    activeIndex: 1,
    tabs: [
      { url: "https://one.example", zoom: 0.1, loaded: true },
      { url: "https://failed.example", zoom: 0.8, loaded: false },
      { url: "about:blank", zoom: 0.8, loaded: true },
      { url: "https://two.example", zoom: 3, loaded: true },
    ],
  }, 0.8), {
    activeIndex: 1,
    tabs: [
      { url: "https://one.example", zoom: 0.5 },
      { url: "https://two.example", zoom: 2 },
    ],
  });
});

test("restore falls back to the last loaded page when the active tab never loaded", () => {
  assert.deepEqual(normalizeWindowSession({
    version: 2,
    activeIndex: 2,
    tabs: [
      { url: "https://one.example", zoom: 0.8, loaded: true },
      { url: "https://two.example", zoom: 0.8, loaded: true },
      { url: "https://failed.example", zoom: 0.8, loaded: false },
    ],
  }, 0.8), {
    activeIndex: 1,
    tabs: [
      { url: "https://one.example", zoom: 0.8 },
      { url: "https://two.example", zoom: 0.8 },
    ],
  });
});

test("blank-only and never-loaded state does not replace the last useful session", () => {
  assert.equal(windowSessionForSave([
    { url: "about:blank", zoom: 0.8, loaded: true },
    { url: "data:text/html,loading", zoom: 0.8, loaded: true },
    { url: "https://failed.example", zoom: 0.8, loaded: false },
  ], 0, 0.8), null);
});

test("save emits only successfully loaded tabs and remaps the active index", () => {
  assert.deepEqual(windowSessionForSave([
    { url: "https://failed.example", zoom: 0.8, loaded: false },
    { url: "https://example.com", zoom: 1.25, loaded: true },
  ], 0, 0.8), {
    version: 2,
    activeIndex: 0,
    tabs: [{ url: "https://example.com", zoom: 1.25, loaded: true }],
  });
});
