"use strict";

// `engine.chrome_sites`: which sites belong on the Chrome engine.
//
// Some sites only work in the user's managed Google Chrome — Okta Device Trust, Endpoint
// Verification, Cyberhaven — because what they check is an attestation the managed Chrome and its
// policy-installed extensions make. Electron and WebKit cannot make it and must not pretend to
// (DESIGN.md non-goals; Endpoint Verification reads `enterprise.deviceAttributes`, Cyberhaven
// talks to its native host, and neither API exists outside Chrome). So a URL the user types for a
// listed site is opened in a Chrome-engine pane instead.
//
// The rule is crates/tweb-cli/src/sites.rs's, which decides the same thing for `tweb open`; the
// test table in chrome-sites.test.cjs is that file's, so the two cannot drift.

/** The host an entry names: lower case, no scheme, path, port, user, `*.` or trailing dot. */
function siteHost(entry) {
  let rest = String(entry ?? "").trim();
  const scheme = rest.indexOf("://");
  if (scheme >= 0) rest = rest.slice(scheme + 3);
  rest = rest.split(/[/?#]/)[0];
  rest = rest.split("@").pop();
  rest = rest.split(":")[0];
  rest = rest.replace(/^\*\./, "").replace(/\.$/, "").toLowerCase();
  return rest && !/\s/.test(rest) ? rest : null;
}

/** The host of a web URL or a bare host; null for files, about: pages and anything else. */
function urlHost(input) {
  const text = String(input ?? "").trim();
  let parsed = null;
  try {
    parsed = new URL(text);
  } catch (_) {
    if (!text.includes("://") && !text.startsWith("about:")) {
      try { parsed = new URL(`https://${text}`); } catch (__) { parsed = null; }
    }
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return null;
  return parsed.hostname.replace(/\.$/, "").toLowerCase();
}

/**
 * The entry `input` falls under, or null. An entry covers its host and every subdomain of it:
 * `example.com` matches `login.example.com` but not `badexample.com`.
 */
function matchingSite(input, sites) {
  const host = urlHost(input);
  if (!host) return null;
  for (const entry of Array.isArray(sites) ? sites : []) {
    const site = siteHost(entry);
    if (site && (host === site || host.endsWith(`.${site}`))) return site;
  }
  return null;
}

// The engines a site can be pinned to, in the order a tie between equally specific entries is
// broken: Chrome first, because a site listed for Chrome is there for an attestation nothing else
// can make; WebKit next, because it is the narrower choice of the other two.
const PINNABLE_ENGINES = ["chrome", "webkit", "electron"];

/** The settings key that lists the sites pinned to `engine`. */
function sitesKey(engine) {
  return `engine.${engine}_sites`;
}

/**
 * The engine `input` is pinned to, and the entry that pins it, or null. `lists` maps an engine to
 * its site list. The most specific entry wins — `okta.com` on Chrome and `login.okta.com` on
 * Electron put `login.okta.com` on Electron — so one list can carve an exception out of another.
 */
function pinnedEngine(input, lists) {
  const host = urlHost(input);
  if (!host) return null;
  let best = null;
  for (const engine of PINNABLE_ENGINES) {
    for (const entry of Array.isArray(lists?.[engine]) ? lists[engine] : []) {
      const site = siteHost(entry);
      if (!site || (host !== site && !host.endsWith(`.${site}`))) continue;
      if (!best || site.length > best.site.length) best = { engine, site };
    }
  }
  return best;
}

/** `pinnedEngine` over the three settings lists. */
function pinnedEngineFromSettings(input, settings) {
  const lists = {};
  for (const engine of PINNABLE_ENGINES) lists[engine] = settings.get(sitesKey(engine));
  return pinnedEngine(input, lists);
}

module.exports = {
  PINNABLE_ENGINES, matchingSite, pinnedEngine, pinnedEngineFromSettings, siteHost, sitesKey, urlHost,
};
