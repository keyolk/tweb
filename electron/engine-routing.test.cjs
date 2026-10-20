"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { engineBadgeModel, pinTable, routeNavigation } = require("./engine-routing.cjs");
const { pinnedEngine } = require("./chrome-sites.cjs");

const lists = { chrome: ["okta.com"], webkit: ["localhost"], electron: ["login.okta.com"] };
const everywhere = () => ({ ok: true });

test("a navigation the user made moves the tab to the pinned engine", () => {
  for (const cause of ["typed", "link", "new-tab"]) {
    assert.deepStrictEqual(
      routeNavigation({ url: "https://sendbird.okta.com/", tabEngine: "electron", lists, cause, availability: everywhere }),
      { action: "switch", engine: "chrome", site: "okta.com" },
      cause,
    );
  }
});

// An SSO chain moved mid-way loses the state it was started with.
test("a redirect onto a pinned site is only told", () => {
  assert.deepStrictEqual(
    routeNavigation({ url: "https://sendbird.okta.com/", tabEngine: "electron", lists, cause: "redirect", availability: everywhere }),
    { action: "notice", engine: "chrome", site: "okta.com", reason: null },
  );
});

test("unpinned pages and pages already on their engine stay", () => {
  const route = (url, tabEngine) => routeNavigation({ url, tabEngine, lists, cause: "typed", availability: everywhere });
  assert.deepStrictEqual(route("https://github.com/", "chrome"), { action: "stay" });
  assert.deepStrictEqual(route("https://a.okta.com/", "chrome"), { action: "stay" });
  // The more specific Electron entry wins over okta.com on Chrome.
  assert.deepStrictEqual(route("https://login.okta.com/", "chrome"), { action: "switch", engine: "electron", site: "login.okta.com" });
});

test("an engine that cannot run here, or an --ssh pane, keeps the tab and says why", () => {
  const noWebKit = (engine) => (engine === "webkit" ? { ok: false, reason: "macOS only" } : { ok: true });
  assert.deepStrictEqual(
    routeNavigation({ url: "http://localhost:5173/", tabEngine: "electron", lists, cause: "typed", availability: noWebKit }),
    { action: "notice", engine: "webkit", site: "localhost", reason: "macOS only" },
  );
  assert.deepStrictEqual(
    routeNavigation({ url: "https://x.okta.com/", tabEngine: "electron", lists, cause: "typed", availability: everywhere, remote: true }),
    { action: "notice", engine: "chrome", site: "okta.com", reason: "--ssh panes stay on Electron" },
  );
});

test("the preload's pin table picks what pinnedEngine picks", () => {
  const table = pinTable(lists);
  assert.deepStrictEqual(table[0], { site: "login.okta.com", engine: "electron" });
  const first = (host) => table.find(({ site }) => host === site || host.endsWith(`.${site}`)) || null;
  for (const url of ["https://login.okta.com/", "https://a.okta.com/", "http://localhost/", "https://github.com/"]) {
    const host = new URL(url).hostname;
    const want = pinnedEngine(url, lists);
    const got = first(host);
    assert.deepStrictEqual(got && got.engine, want && want.engine, url);
  }
  // Equal specificity: Chrome before WebKit before Electron, as pinnedEngine breaks the tie.
  assert.deepStrictEqual(pinTable({ electron: ["a.test"], webkit: ["a.test"], chrome: ["a.test"] }).map((r) => r.engine),
    ["chrome", "webkit", "electron"]);
});

test("the badge shows a pinned page on another engine as a mismatch, with the pinned engine marked", () => {
  const model = engineBadgeModel({
    url: "https://sendbird.okta.com/", tabEngine: "electron", paneEngine: "electron", lists, availability: everywhere,
  });
  assert.strictEqual(model.emphasis, "mismatch");
  assert.deepStrictEqual(model.pin, { engine: "chrome", site: "okta.com", label: "Chrome" });
  assert.deepStrictEqual(model.choices.map((c) => [c.engine, c.current, c.pinned]),
    [["electron", true, false], ["chrome", false, true], ["webkit", false, false]]);

  const quiet = engineBadgeModel({ url: "https://github.com/", tabEngine: "electron", paneEngine: "electron", lists, availability: everywhere });
  assert.strictEqual(quiet.emphasis, "plain");
  const moved = engineBadgeModel({ url: "https://github.com/", tabEngine: "webkit", paneEngine: "electron", lists, availability: everywhere });
  assert.strictEqual(moved.emphasis, "other");
  const home = engineBadgeModel({ url: "https://a.okta.com/", tabEngine: "chrome", paneEngine: "electron", lists, availability: everywhere });
  assert.strictEqual(home.emphasis, "pinned");
});

test("the badge greys out engines that cannot run, with the reason", () => {
  const model = engineBadgeModel({
    url: "https://github.com/", tabEngine: "electron", paneEngine: "electron", lists,
    availability: (engine) => (engine === "webkit" ? { ok: false, reason: "macOS only" } : { ok: true }), remote: true,
  });
  assert.deepStrictEqual(model.choices.map((c) => [c.engine, c.ok, c.reason]), [
    ["electron", true, null],
    ["chrome", false, "--ssh panes stay on Electron"],
    ["webkit", false, "macOS only"],
  ]);
});
