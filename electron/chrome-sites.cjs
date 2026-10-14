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

module.exports = { matchingSite, siteHost, urlHost };
