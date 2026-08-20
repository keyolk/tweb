"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { needsManagedChrome, sensitiveDomains, hostMatches } = require("./browser-routing.cjs");

// The tenant is a subdomain and the apex redirects to one, so `*.okta.com` has to cover
// both or the policy misses the URL a person actually opens.
test("a sensitive domain matches its subdomains and itself", () => {
  assert.equal(hostMatches("sendbird.okta.com", "*.okta.com"), true);
  assert.equal(hostMatches("okta.com", "*.okta.com"), true);
  assert.equal(hostMatches("aws.amazon.com", "aws.amazon.com"), true);
  // Not a suffix match on the raw string: `notokta.com` ends with `okta.com`.
  assert.equal(hostMatches("notokta.com", "*.okta.com"), false);
  // An exact pattern is exact.
  assert.equal(hostMatches("console.aws.amazon.com", "aws.amazon.com"), false);
});

test("the default policy routes Okta and nothing ordinary", () => {
  const env = {};
  assert.equal(needsManagedChrome("https://sendbird.okta.com/app/", env), true);
  assert.equal(needsManagedChrome("https://aws.amazon.com/console", env), true);
  assert.equal(needsManagedChrome("https://github.com/keyolk/tweb", env), false);
  assert.equal(needsManagedChrome("https://google.com", env), false);
});

// The placeholder this engine paints during a load is a data: URL, and the error page is
// too. Routing those would hand Chrome a page TWeb generated for itself.
test("only http(s) is ever routed", () => {
  const env = {};
  assert.equal(needsManagedChrome("data:text/html,<p>okta.com</p>", env), false);
  assert.equal(needsManagedChrome("file:///tmp/okta.com/index.html", env), false);
  assert.equal(needsManagedChrome("about:blank", env), false);
  assert.equal(needsManagedChrome("not a url at all", env), false);
});

// A port belongs to a different service, so it is stripped before matching rather than
// left to make `okta.com:8443` look like something else.
test("a port does not defeat the match", () => {
  assert.equal(needsManagedChrome("https://sendbird.okta.com:8443/app/", {}), true);
});

test("the policy is configurable, including down to nothing", () => {
  // An org on another IdP says so without a rebuild.
  assert.equal(
    needsManagedChrome("https://login.example.com/", { TWEB_MANAGED_CHROME_DOMAINS: "*.example.com" }),
    true);
  // ...and that replaces the defaults rather than adding to them.
  assert.equal(
    needsManagedChrome("https://sendbird.okta.com/", { TWEB_MANAGED_CHROME_DOMAINS: "*.example.com" }),
    false);
  // An empty value is "route nothing", which is the only way to express it in an
  // environment variable — falling back to the defaults there would make the setting
  // impossible to turn off.
  assert.deepEqual(sensitiveDomains({ TWEB_MANAGED_CHROME_DOMAINS: "" }), []);
  assert.equal(needsManagedChrome("https://sendbird.okta.com/", { TWEB_MANAGED_CHROME_DOMAINS: "" }), false);
});

// Two shortcuts are cheaper than a handoff and both are refused by name in DESIGN.md's
// non-goals. The reason is not taste: Device Trust is an attestation performed by an
// extension in a managed Chrome and evaluated per authentication, so a user agent string
// cannot answer it and a copied session cookie is the check's output rather than its input.
test("the handoff does not spoof a user agent or move cookies", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const handoff = main.slice(main.indexOf("function handOffToChrome(url)"),
    main.indexOf("function placeholderPage(target)"));
  assert.doesNotMatch(handoff, /setUserAgent|userAgent/);
  assert.doesNotMatch(handoff, /cookies/);
  // It hands over a URL and nothing else — the permission boundary DESIGN.md 11 draws.
  assert.match(handoff, /spawnSync\("tmux-chrome", \["open", url\]/);
  assert.match(handoff, /spawnSync\("open", \["-a", "Google Chrome", url\]/);
});

test("both navigation entry points are routed", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // Links followed inside a page. `will-navigate` because it is cancellable: stopping a
  // navigation that has already started leaves the pane on a half-abandoned page.
  assert.match(main, /onContents\("will-navigate", \(event, url\) => \{/);
  const navigate = main.slice(main.indexOf('onContents("will-navigate"'));
  assert.match(navigate.slice(0, 600), /event\.preventDefault\(\);/);
  // A handoff that cannot reach Chrome must not eat the navigation: failing that site in
  // TWeb is what happened before this existed, and it beats a pane showing nothing.
  assert.match(navigate.slice(0, 600), /if \(!how\) \{\s*void contents\.loadURL\(url\);/);

  // And everything that starts a tab already pointed at a URL.
  const create = main.slice(main.indexOf("  if (needsManagedChrome(url)) {"));
  assert.match(create.slice(0, 300), /void tab\.loadURL\(handedOffPage\(url, how\)\)/);
});
