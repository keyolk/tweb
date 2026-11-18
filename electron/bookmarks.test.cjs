"use strict";

// Bookmarks (`b` / `B`, `:bookmark`): the pure half from bookmarks.cjs (the file fold, Chrome's
// JSON, merging, filtering), the overlay code run out of preload.cjs against fakes, and the wiring
// in main.cjs that the overlay depends on.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  foldBookmarkLines, bookmarkLine, tombstoneLine, parseChromeBookmarks, mergeBookmarks, filterBookmarks,
} = require("./bookmarks.cjs");

const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

// A synthetic Chrome profile file — the real one is the user's and is never read in a test.
const CHROME = JSON.stringify({
  checksum: "x",
  roots: {
    bookmark_bar: {
      type: "folder", name: "Bookmarks bar", children: [
        { type: "url", name: "Grafana", url: "https://grafana.example.com/d/1" },
        { type: "folder", name: "Work", children: [
          { type: "url", name: "Jira", url: "https://jira.example.com/" },
          { type: "url", name: "Run me", url: "javascript:alert(1)" },
        ] },
      ],
    },
    other: { type: "folder", name: "Other bookmarks", children: [{ type: "url", name: "Local", url: "file:///tmp/a.html" }] },
    synced: { type: "folder", name: "Mobile bookmarks", children: [] },
  },
  version: 1,
});

test("Chrome's Bookmarks JSON flattens to url rows with their folder, bookmarklets dropped", () => {
  const rows = parseChromeBookmarks(CHROME);
  assert.deepEqual(rows.map((row) => [row.name, row.url, row.folder, row.source]), [
    ["Grafana", "https://grafana.example.com/d/1", "Bookmarks bar", "chrome"],
    ["Jira", "https://jira.example.com/", "Bookmarks bar/Work", "chrome"],
    ["Local", "file:///tmp/a.html", "Other bookmarks", "chrome"],
  ]);
});

test("an unreadable or foreign Chrome file is null, not an empty list", () => {
  assert.equal(parseChromeBookmarks("{not json"), null);
  assert.equal(parseChromeBookmarks(JSON.stringify({ hello: 1 })), null);
  assert.deepEqual(parseChromeBookmarks(JSON.stringify({ roots: {} })), []);
});

test("the tweb file folds newest-wins: rename, delete, re-add, torn lines", () => {
  const lines = [
    bookmarkLine("https://a.example/", "A", 1),
    bookmarkLine("https://b.example/", "B", 2),
    "{torn\n",
    bookmarkLine("https://a.example/", "A renamed", 3),
    tombstoneLine("https://b.example/", 4),
    bookmarkLine("https://c.example/", "", 5),
  ].join("").split("\n");
  const folded = foldBookmarkLines(lines);
  assert.deepEqual(folded.map((row) => [row.url, row.name]), [
    ["https://c.example/", "https://c.example/"],
    ["https://a.example/", "A renamed"],
  ]);
  const readded = foldBookmarkLines([...lines, bookmarkLine("https://b.example/", "B again", 6)]);
  assert.equal(readded[0].name, "B again");
  assert.throws(() => bookmarkLine("", "x"));
});

test("merging puts tweb's first and keeps one row per URL, tweb's winning", () => {
  const tweb = [{ url: "https://jira.example.com/", name: "My Jira", source: "tweb" }];
  const merged = mergeBookmarks(tweb, parseChromeBookmarks(CHROME));
  assert.deepEqual(merged.map((row) => [row.name, row.source]), [
    ["My Jira", "tweb"], ["Grafana", "chrome"], ["Local", "chrome"],
  ]);
});

test("the filter matches every word in name, URL or folder, in any order, keeping order", () => {
  const rows = parseChromeBookmarks(CHROME);
  assert.deepEqual(filterBookmarks(rows, "work jira").map((row) => row.name), ["Jira"]);
  assert.deepEqual(filterBookmarks(rows, "EXAMPLE").map((row) => row.name), ["Grafana", "Jira"]);
  assert.equal(filterBookmarks(rows, "").length, 3);
  assert.deepEqual(filterBookmarks(rows, "nothing-here"), []);
});

// The overlay, run out of preload.cjs.
function slice(from, to) {
  const start = preload.indexOf(from);
  const end = preload.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} is gone`);
  return preload.slice(start, end);
}

function fakeNode(tag = "div") {
  return {
    localName: tag,
    style: {},
    children: [],
    textContent: "",
    value: "",
    listeners: {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren() { this.children = []; },
    attachShadow() { return fakeNode("#shadow"); },
    remove() { this.removed = true; },
    setAttribute() {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    focus() {},
    scrollIntoView() {},
  };
}

function harness() {
  const env = { sent: [], flashes: [], modes: [], appended: [], normal: 0 };
  const api = new Function("env", `
    let bookmarksState = null;
    const document = {
      createElement: (tag) => (${fakeNode.toString()})(tag),
      documentElement: { append: (node) => env.appended.push(node) },
    };
    const requestAnimationFrame = (fn) => fn();
    const cancelTransient = () => {};
    const paintNow = () => {};
    const normalMode = () => { env.normal += 1; };
    const send = (...args) => env.sent.push(args);
    const flash = (message) => env.flashes.push(message);
    const setMode = (mode, detail) => env.modes.push([mode, detail]);
    ${slice("  // --- bookmarks (`b` / `B`) ---", "  // --- downloads page ---")}
    return {
      show: (newTab) => showBookmarks(newTab),
      render: (model) => renderBookmarksModel(model),
      state: () => bookmarksState,
      key: (key, extra = {}) => {
        const event = { key, code: extra.code || "", ctrlKey: Boolean(extra.ctrl), shiftKey: Boolean(extra.shift),
          prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
        const handled = handleBookmarksKey(event);
        return { handled, prevented: event.prevented, stopped: event.stopped };
      },
    };
  `)(env);
  return { api, env };
}

const MODEL = {
  query: "",
  rows: [
    { url: "https://a.example/", name: "A", folder: "", source: "tweb" },
    { url: "https://grafana.example.com/d/1", name: "Grafana", folder: "Bookmarks bar", source: "chrome" },
  ],
  total: 2, tweb: 1, chrome: 1, note: "",
};

test("b asks main for the list, renders both sources, and Enter opens the pick here", () => {
  const { api, env } = harness();
  api.show(false);
  assert.deepEqual(env.sent[0], ["bookmarks-model", { query: "" }]);
  api.render(MODEL);
  assert.equal(api.state().rows.length, 2);
  assert.equal(api.state().count.textContent, "1 tweb · 1 Chrome");
  api.key("ArrowDown", { code: "ArrowDown" });
  api.key("Enter", { code: "Enter" });
  assert.deepEqual(env.sent.at(-1), ["navigate", "https://grafana.example.com/d/1"]);
  assert.equal(api.state(), null);
});

test("B opens the pick in a new tab; Shift-Enter does from b", () => {
  for (const [newTab, shift] of [[true, false], [false, true]]) {
    const { api, env } = harness();
    api.show(newTab);
    api.render(MODEL);
    api.key("Enter", { code: "Enter", shift });
    assert.deepEqual(env.sent.at(-1), ["new-tab", "https://a.example/"]);
  }
});

test("Ctrl-D deletes a tweb bookmark; a Chrome row is read only", () => {
  const { api, env } = harness();
  api.show(false);
  api.render(MODEL);
  api.key("d", { ctrl: true });
  assert.deepEqual(env.sent.at(-1), ["bookmark-delete", { url: "https://a.example/", query: "" }]);
  api.key("ArrowDown", { code: "ArrowDown" });
  const before = env.sent.length;
  api.key("d", { ctrl: true });
  assert.equal(env.sent.length, before, "a Chrome row sent a delete");
  assert.deepEqual(env.flashes, ["Chrome bookmark · read only"]);
});

test("the list owns its keys while open, and a stale reply is dropped", () => {
  const { api, env } = harness();
  api.show(false);
  api.render(MODEL);
  // Letters go to the filter input, never on to the page or the normal-mode table.
  const letter = api.key("j");
  assert.ok(letter.handled && letter.stopped && !letter.prevented);
  api.key("j", { ctrl: true });
  assert.equal(api.state().selected, 1);
  api.state().input.value = "gra";
  api.render({ ...MODEL, query: "" });
  assert.equal(api.state().rows.length, 2, "kept the rows; the reply answered an old query");
  api.key("Escape", { code: "Escape" });
  assert.equal(api.state(), null);
  assert.equal(env.normal, 1);
});

test("an unreadable Chrome file shows a one-line notice in the footer", () => {
  const { api } = harness();
  api.show(false);
  api.render({ ...MODEL, rows: MODEL.rows.slice(0, 1), chrome: 0, note: "Chrome bookmarks unreadable (EACCES)" });
  assert.equal(api.state().footer.textContent, "Chrome bookmarks unreadable (EACCES)");
  assert.equal(api.state().footer.style.display, "block");
});

test("with the list closed, b and B are the normal-mode table's and nothing else is", () => {
  const start = preload.indexOf("  const shortcutHelpSections = [");
  const table = preload.slice(start, preload.indexOf("  const normalKeyActions", start));
  assert.match(table, /\{ b: \(\) => showBookmarks\(false\), B: \(\) => showBookmarks\(true\) \}/);
  // The list's handler returns false when it is closed, so it cannot swallow a key then.
  assert.match(preload, /function handleBookmarksKey\(event\) \{\n\s+if \(!bookmarksState\) return false;/);
  // And it is torn down with every other transient overlay.
  assert.match(preload, /cancelHistory\(false\);\n\s+cancelBookmarks\(false\);/);
});

test(":bookmark and :bookmarks are commands the help lists; main wires the IPC and the omnibox", () => {
  assert.match(preload, /\{ name: "bookmark", label: "Bookmark this page", argumentOptional: "name"/);
  assert.match(preload, /\{ name: "bookmarks", help: "search bookmarks/);
  assert.match(preload, /entry\.argumentOptional \? ` \[\$\{entry\.argumentOptional\}\]`/);
  for (const action of ["bookmarks-model", "bookmark-delete", "bookmark-add"]) {
    assert.match(main, new RegExp(`case "${action}":`));
  }
  // Bookmarks rank above history and below open tabs in the omnibox.
  assert.match(main, /\.\.\.tabEntries,\n\s+\.\.\.bookmarkEntries,\n\s+\.\.\.history\.map/);
  assert.match(main, /recency: base \+ bookmarks\.length - index/);
  // Chrome's file is only ever read.
  assert.doesNotMatch(main, /(?:writeFileSync|appendFileSync|renameSync)\(chromeBookmarksPath/);
});
