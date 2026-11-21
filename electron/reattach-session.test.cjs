"use strict";

// A pane that comes back — after `tweb daemon restart`, a lost hosted session, a bare `tweb open` —
// asks to be restored and still carries the URL it was first opened with. That URL used to count as
// a fresh request: it was added to the restored tabs, or the tab holding it was activated, so every
// pane came back showing its first page. Measured in an isolated daemon: tabs [a, *b, c] before a
// restart came back as [*a, b, c].

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { normalizeWindowSession, sessionWithOpenedUrl } = require("./window-session.cjs");

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

test("a hosted pane asking to be restored does not open its launch URL again", () => {
  assert.match(main, /const explicitUrl = Boolean\(command\.url\) && !command\.restoreSession;/);
  assert.match(main, /createWindow\(url, frames, \{ explicit: explicitUrl \}\)/);
});

test("nor does a pane's own engine started to restore", () => {
  assert.match(main, /explicit: Boolean\(process\.env\.TWEB_URL \|\| commandLineUrl\(\)\) && process\.env\.TWEB_RESTORE_SESSION !== "1",/);
});

test("why it matters: an opened URL takes the active tab, a restore keeps the saved one", () => {
  const saved = normalizeWindowSession({ version: 1, activeIndex: 1, tabs: [{ url: "file:///a" }, { url: "file:///b" }, { url: "file:///c" }] }, 0.8);
  assert.equal(saved.activeIndex, 1);
  // What an explicit open does with the same saved list: the launch URL's tab becomes active.
  assert.equal(sessionWithOpenedUrl(saved, "file:///a").activeIndex, 0);
  // And a launch URL not among them is appended — the extra tab every pane grew after a restart.
  assert.equal(sessionWithOpenedUrl(saved, "file:///z").tabs.length, 4);
});
