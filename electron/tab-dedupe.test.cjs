"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { dedupeSessionTabs, pageKey, tabShowingPage } = require("./tab-dedupe.cjs");

test("a page is its URL without the fragment, in parsed form", () => {
  assert.equal(pageKey("file:///Users/a/briefs/index.html#t=sec"), "file:///Users/a/briefs/index.html");
  assert.equal(pageKey("file:///a/b c.html"), pageKey("file:///a/b%20c.html"));
  assert.equal(pageKey("https://x.test/p?q=1#top"), "https://x.test/p?q=1");
  assert.notEqual(pageKey("https://x.test/p?q=1"), pageKey("https://x.test/p?q=2"));
  assert.equal(pageKey(""), "");
  assert.equal(pageKey(undefined), "");
});

test("the tab showing a page is found, the active one first, never the excluded one", () => {
  const urls = ["file:///b/index.html", "file:///b/x.html", "file:///b/index.html#t=a"];
  assert.equal(tabShowingPage(urls, "file:///b/index.html"), 0);
  assert.equal(tabShowingPage(urls, "file:///b/index.html", { active: 2 }), 2);
  assert.equal(tabShowingPage(urls, "file:///b/index.html", { except: 0 }), 2);
  assert.equal(tabShowingPage(urls, "file:///b/y.html"), -1);
  // A blank or data page is never "the same page" as another blank one.
  assert.equal(tabShowingPage(["about:blank"], "about:blank"), -1);
  assert.equal(tabShowingPage(["data:text/html,a"], "data:text/html,a"), -1);
});

test("a saved session keeps each URL once and the active tab follows its survivor", () => {
  const tab = (url) => ({ url, zoom: 0.8 });
  // Measured shape: the first tab repeated in the middle, the active tab last.
  const saved = [tab("a"), tab("b"), tab("c"), tab("a"), tab("a"), tab("b"), tab("d")];
  assert.deepEqual(dedupeSessionTabs(saved, 6), { tabs: [tab("a"), tab("b"), tab("c"), tab("d")], activeIndex: 3 });
  // The active tab was a repeat: the kept copy becomes active.
  assert.deepEqual(dedupeSessionTabs([tab("a"), tab("a")], 1), { tabs: [tab("a")], activeIndex: 0 });
  // Fragments differ: two places on one page, both kept.
  assert.equal(dedupeSessionTabs([tab("i#t=x"), tab("i#t=y")], 0).tabs.length, 2);
  assert.deepEqual(dedupeSessionTabs([tab("a"), tab("b")], 1), { tabs: [tab("a"), tab("b")], activeIndex: 1 });
});

const fs = require("node:fs");
const path = require("node:path");
const { normalizeWindowSession, sessionWithOpenedUrl, windowSessionForSave } = require("./window-session.cjs");

test("a saved session with repeats restores and saves each URL once", () => {
  const restored = normalizeWindowSession({
    version: 1,
    activeIndex: 3,
    tabs: [{ url: "file:///b/index.html" }, { url: "file:///b/x.html" }, { url: "file:///b/index.html" }, { url: "file:///b/index.html" }],
  }, 0.8);
  assert.deepEqual(restored.tabs.map((tab) => tab.url), ["file:///b/index.html", "file:///b/x.html"]);
  assert.equal(restored.activeIndex, 0);
  const saved = windowSessionForSave([{ url: "a" }, { url: "a" }, { url: "b" }], 1, 0.8);
  assert.deepEqual(saved.tabs.map((tab) => tab.url), ["a", "b"]);
  assert.equal(saved.activeIndex, 0);
});

test("a pane opened with a URL uses the saved tab showing that page at another fragment", () => {
  const session = { tabs: [{ url: "file:///b/index.html#t=sec" }, { url: "file:///b/x.html" }], activeIndex: 1 };
  assert.deepEqual(sessionWithOpenedUrl(session, "file:///b/index.html"), { tabs: session.tabs, activeIndex: 0 });
});

test("navigate goes to the tab already showing the page; tab new does too, the active one included", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const navigate = main.slice(main.indexOf('case "navigate": {\n      // `tweb back`'), main.indexOf('case "back": {'));
  assert.match(navigate, /activateTabShowing\(normalizeUrl\(String\(params\.url \|\| ""\)\)\);\n      const tab = agentTab\(\);/);
  const tabNew = main.slice(main.indexOf('case "tab-new":'), main.indexOf('case "tab-engine":'));
  assert.match(tabNew, /activateTabShowing\(url, \{ countActive: true \}\)/);
  assert.match(tabNew, /existing\.webContents\.loadURL\(url\)/);
  assert.match(tabNew, /else openTabRouted\(currentWindows\(\)\.win, url, true\);/);
});
