"use strict";

// Which URLs must leave TWeb for real Google Chrome — DESIGN.md sections 10.4 and 11.
//
// The reason is Okta's Device Trust, and it is worth being precise about why nothing
// cheaper works. The check is an attestation performed by an extension inside a managed
// Chrome, evaluated per authentication. A user agent string cannot answer it, and neither
// can a copied session cookie: the cookie is what the check produces, not what it accepts.
// DESIGN.md's own non-goals name both shortcuts and reject them —
//
//   - Do not imitate Google Chrome by spoofing the User-Agent.
//   - Do not replicate Okta session cookies automatically or continuously.
//
// — so the honest move is to hand the URL over and say so. The defaults mirror
// `BrowserRoutingPolicy::default()` in `crates/tweb-core/src/routing.rs`, which described
// this behaviour long before anything performed it.
const DEFAULT_SENSITIVE_DOMAINS = ["*.okta.com", "aws.amazon.com"];

// A pattern is either an exact host or a `*.` prefix meaning "this domain or any
// subdomain of it". `*.okta.com` covering a bare `okta.com` is deliberate: an org's tenant
// is a subdomain, and the apex redirects to one.
function hostMatches(host, pattern) {
  if (!host || !pattern) return false;
  const suffix = pattern.startsWith("*.") ? pattern.slice(2) : null;
  if (suffix) return host === suffix || host.endsWith(`.${suffix}`);
  return host === pattern;
}

// Reads the policy from the environment, so an org that needs another IdP domain — or a
// user who wants Okta back inside TWeb — can say so without a rebuild. An empty value
// disables routing entirely rather than falling back to the defaults, which is the only
// way to express "route nothing" in an environment variable.
function sensitiveDomains(env = process.env) {
  const configured = env.TWEB_MANAGED_CHROME_DOMAINS;
  if (configured === undefined) return DEFAULT_SENSITIVE_DOMAINS;
  return configured.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

/// Whether `url` has to be opened in managed Chrome instead of here.
///
/// Only http(s) is considered. A `file:`, `data:` or `about:` URL cannot be an IdP, and
/// the placeholder page this engine paints during a load is a `data:` URL — routing that
/// would hand Chrome a page TWeb generated for itself.
function needsManagedChrome(url, env = process.env) {
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    host = parsed.host.toLowerCase();
  } catch (error) {
    void error;
    return false;
  }
  // The host, not the hostname: a port belongs to a different service, and a policy that
  // matched `okta.com:8443` against a tenant would be guessing.
  const bare = host.replace(/:\d+$/, "");
  return sensitiveDomains(env).some((pattern) => hostMatches(bare, pattern));
}

module.exports = { needsManagedChrome, sensitiveDomains, hostMatches, DEFAULT_SENSITIVE_DOMAINS };
