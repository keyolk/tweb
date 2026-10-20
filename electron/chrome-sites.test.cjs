"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { matchingSite, pinnedEngine, siteHost } = require("./chrome-sites.cjs");
const { parseToml, resolve } = require("./settings.cjs");

// The same table crates/tweb-cli/src/sites.rs checks, so `tweb open` and a URL typed in a pane
// decide alike.
const CASES = [
  ["https://sendbird.okta.com/app", ["okta.com"], "okta.com"],
  ["sendbird.okta.com", ["okta.com"], "okta.com"],
  ["https://okta.com/", ["okta.com"], "okta.com"],
  ["https://notokta.com/", ["okta.com"], null],
  ["https://okta.com.evil.test/", ["okta.com"], null],
  ["https://ARGO.example.com:8443/x", ["https://argo.example.com/applications"], "argo.example.com"],
  ["https://a.argo.example.com/", ["*.argo.example.com"], "argo.example.com"],
  ["https://example.com/", ["argo.example.com"], null],
  ["file:///tmp/okta.com.html", ["okta.com"], null],
  ["about:blank", ["okta.com"], null],
  ["https://okta.com/", [], null],
  ["https://okta.com/", ["", "  "], null],
];

test("a site covers its host and subdomains only, as the CLI decides it", () => {
  for (const [input, sites, expected] of CASES) {
    assert.strictEqual(matchingSite(input, sites), expected, `${input} against ${JSON.stringify(sites)}`);
  }
});

// The same table crates/tweb-cli/src/sites.rs checks for `pinned_engine`.
const PIN_CASES = [
  ["https://sendbird.okta.com/", { chrome: ["okta.com"] }, ["chrome", "okta.com"]],
  ["https://github.com/", { chrome: ["okta.com"] }, null],
  ["https://login.okta.com/", { chrome: ["okta.com"], electron: ["login.okta.com"] }, ["electron", "login.okta.com"]],
  ["https://app.example.com/", { webkit: ["example.com"], electron: ["app.example.com"] }, ["electron", "app.example.com"]],
  ["https://example.com/", { chrome: ["example.com"], webkit: ["example.com"] }, ["chrome", "example.com"]],
  ["https://example.com/", { webkit: ["example.com"], electron: ["example.com"] }, ["webkit", "example.com"]],
  ["http://localhost:5173/", { webkit: ["localhost"] }, ["webkit", "localhost"]],
  ["file:///tmp/a.html", { electron: ["a.html"] }, null],
  ["https://example.com/", {}, null],
];

test("the most specific pinned entry wins; ties go to Chrome, then WebKit", () => {
  for (const [input, lists, expected] of PIN_CASES) {
    const got = pinnedEngine(input, lists);
    assert.deepStrictEqual(got && [got.engine, got.site], expected, `${input} against ${JSON.stringify(lists)}`);
  }
});

test("entries are normalised", () => {
  assert.strictEqual(siteHost("  *.Okta.COM. "), "okta.com");
  assert.strictEqual(siteHost("user@host.test:22"), "host.test");
  assert.strictEqual(siteHost(""), null);
});

test("engine.chrome_sites reads as a list from the file, one line or several, and from the environment", () => {
  const oneLine = parseToml('[engine]\nchrome_sites = ["okta.com", \'google.com\']\n');
  assert.deepStrictEqual(oneLine.warnings, []);
  assert.deepStrictEqual(resolve(oneLine.values, {}).values["engine.chrome_sites"], ["okta.com", "google.com"]);

  const multi = parseToml('[engine]\nchrome_sites = [\n  "okta.com", # sign-in\n  "argo.example.com",\n]\nother = 1\n');
  assert.deepStrictEqual(multi.values["engine.chrome_sites"], ["okta.com", "argo.example.com"]);

  const env = resolve({}, { TWEB_CHROME_SITES: " okta.com, ,google.com " });
  assert.deepStrictEqual(env.values["engine.chrome_sites"], ["okta.com", "google.com"]);
  assert.strictEqual(env.sources["engine.chrome_sites"], "env");

  assert.deepStrictEqual(resolve({}, {}).values["engine.chrome_sites"], []);
  const bad = resolve(parseToml('[engine]\nchrome_sites = [1, 2]\n').values, {});
  assert.deepStrictEqual(bad.values["engine.chrome_sites"], [], "a non-string list falls back to the default");
});

// A typed URL, a followed link or a new tab for a pinned site moves the tab to that engine in place;
// a redirect is only told, because an SSO chain moved mid-way fails (engine-routing.cjs).
test("typed URLs, links and new tabs follow pins in place; redirects are only told", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  assert.match(main, /case "navigate": \{\s+const url = normalizeOmniboxInput\(value\);\s+if \(url && !followPin\(tab, url, "typed"\)\) void contents\.loadURL\(url\);/);
  assert.match(main, /case "new-tab": \{\s+const url = normalizeOmniboxInput\(value\);\s+if \(url\) openTabRouted\(tab, url, true\);/);
  assert.match(main, /if \(\/\^https\?:\/i\.test\(url\) && !tab\.isDestroyed\(\) && !followPin\(tab, url, "link"\)\)/);
  // did-navigate (redirects and every other load) only notices; it never moves the tab.
  const notice = main.slice(main.indexOf("const pinNotices"), main.indexOf("function openInChromePane("));
  assert.doesNotMatch(notice, /switchTabEngine|loadURL|execFile/);
  assert.match(notice, /navigationRoute\(tab, url, "redirect"\)/);
  assert.match(main, /noticePinnedNavigation\(tab, url\);/);
  // The switch replaces the tab at its own index and closes the old one only after.
  const sw = main.slice(main.indexOf("async function switchTabEngine("), main.indexOf("const pinNotices"));
  assert.match(sw, /createTab\(target, wasActive, zoom, false, \{ engine, insertAt: index \}\);\s+\/\/[^\n]*\n[^\n]*\n\s+tab\.close\(\);/);
  // A separate Chrome pane is still on offer.
  const open = main.slice(main.indexOf("function openInChromePane("), main.indexOf("function sendToMainTabFrame("));
  assert.match(open, /\["split", "--engine", "chrome", url\]/);
  assert.match(open, /TMUX_PANE: paneId/, "the split goes beside this pane, not the client's active one");
  assert.match(preload, /\{ name: "chrome-pane", label: "Reopen in Chrome pane", action: \(\) => send\("chrome-pane"\) \}/);
  assert.match(preload, /\{ name: "engine-chrome", label: "Switch tab engine: Chrome", action: \(\) => send\("switch-engine", "chrome"\) \}/);
  assert.match(preload, /if \(topFrame\) window\.addEventListener\("click", holdPinnedLink, false\);/);
  assert.match(preload, /ipcRenderer\.on\("tweb-flash"/);
});
