"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { matchingSite, siteHost } = require("./chrome-sites.cjs");
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

// Only what the user types moves to a Chrome pane; a link or redirect is told, not moved, because an
// SSO chain split across two browsers breaks at the cookie boundary.
test("typed URLs for a listed site go to a Chrome pane; links are only told", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  assert.match(main, /case "navigate": \{\s+const url = normalizeOmniboxInput\(value\);\s+if \(url && !sendToChromeEngine\(tab, url\)\) void contents\.loadURL\(url\);/);
  assert.match(main, /case "new-tab": \{\s+const url = normalizeOmniboxInput\(value\);\s+if \(url && !sendToChromeEngine\(tab, url\)\) createTab\(url, true\);/);
  const send = main.slice(main.indexOf("function sendToChromeEngine("), main.indexOf("function openInChromePane("));
  assert.match(send, /if \(pageBackend\.kind === "chrome"\) return false;/, "a Chrome pane must not hand itself on");
  const open = main.slice(main.indexOf("function openInChromePane("), main.indexOf("const chromeSiteNotices"));
  assert.match(open, /\["split", "--engine", "chrome", url\]/);
  assert.match(open, /TMUX_PANE: paneId/, "the split goes beside this pane, not the client's active one");
  assert.match(open, /handOffToChrome\(url\)/, "outside tmux, or if the split fails, the URL still reaches Chrome");
  // The did-navigate handler only notices; it never loads anything elsewhere.
  const notice = main.slice(main.indexOf("function noticeChromeSite("), main.indexOf("function sendToMainTabFrame("));
  assert.doesNotMatch(notice, /openInChromePane|loadURL|execFile/);
  assert.match(main, /noticeChromeSite\(tab, url\);/);
  assert.match(preload, /\{ name: "chrome-pane", label: "Reopen in Chrome pane", action: \(\) => send\("chrome-pane"\) \}/);
  assert.match(preload, /ipcRenderer\.on\("tweb-flash"/);
});
