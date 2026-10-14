//! `engine.chrome_sites`: which sites open on the Chrome engine.
//!
//! Some sites only work in the user's managed Google Chrome — Okta Device Trust, Endpoint
//! Verification, Cyberhaven — because what they check is an attestation the managed Chrome and its
//! policy-installed extensions make. Electron and WebKit cannot make it and must not pretend to
//! (DESIGN.md non-goals), so the useful thing is to send those sites to `--engine chrome` without
//! the user having to remember the flag. electron/chrome-sites.cjs is the same rule for URLs a
//! user types inside a pane; the two are kept identical by the shared test table below.

/// The host an entry names, normalised: lower case, no scheme, path, port, `*.` or trailing dot.
/// `https://Argo.Example.com/applications` and `*.argo.example.com` both name `argo.example.com`.
pub fn site_host(entry: &str) -> Option<String> {
    let mut rest = entry.trim();
    if let Some(index) = rest.find("://") {
        rest = &rest[index + 3..];
    }
    let rest = rest.split(['/', '?', '#']).next().unwrap_or("");
    // A user@ prefix, then a :port suffix.
    let rest = rest.rsplit('@').next().unwrap_or("");
    let rest = rest.split(':').next().unwrap_or("");
    let rest = rest.trim_start_matches("*.").trim_end_matches('.');
    let host = rest.to_ascii_lowercase();
    (!host.is_empty() && !host.contains(char::is_whitespace)).then_some(host)
}

/// The host of something passed to `tweb open`: a URL, or a bare host the engine would load as
/// https. Only web URLs have one; a file path or `about:blank` has none.
pub fn url_host(input: &str) -> Option<String> {
    let input = input.trim();
    let parsed = url::Url::parse(input)
        .ok()
        .filter(|url| url.has_host())
        .or_else(|| {
            (!input.contains("://") && !input.starts_with("about:"))
                .then(|| url::Url::parse(&format!("https://{input}")).ok())
                .flatten()
        })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    parsed
        .host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
}

/// The entry `input` falls under, if any: a host matches an entry that is itself or a parent
/// domain of it, so `example.com` covers `login.example.com` but not `badexample.com`.
pub fn matching_site(input: &str, sites: &[String]) -> Option<String> {
    let host = url_host(input)?;
    sites
        .iter()
        .filter_map(|entry| site_host(entry))
        .find(|site| {
            host == *site
                || host
                    .strip_suffix(site.as_str())
                    .is_some_and(|prefix| prefix.ends_with('.'))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same table electron/chrome-sites.test.cjs checks, so both sides decide alike.
    const CASES: &[(&str, &[&str], Option<&str>)] = &[
        (
            "https://sendbird.okta.com/app",
            &["okta.com"],
            Some("okta.com"),
        ),
        ("sendbird.okta.com", &["okta.com"], Some("okta.com")),
        ("https://okta.com/", &["okta.com"], Some("okta.com")),
        ("https://notokta.com/", &["okta.com"], None),
        ("https://okta.com.evil.test/", &["okta.com"], None),
        (
            "https://ARGO.example.com:8443/x",
            &["https://argo.example.com/applications"],
            Some("argo.example.com"),
        ),
        (
            "https://a.argo.example.com/",
            &["*.argo.example.com"],
            Some("argo.example.com"),
        ),
        ("https://example.com/", &["argo.example.com"], None),
        ("file:///tmp/okta.com.html", &["okta.com"], None),
        ("about:blank", &["okta.com"], None),
        ("https://okta.com/", &[], None),
        ("https://okta.com/", &["", "  "], None),
    ];

    #[test]
    fn matches_a_host_and_its_subdomains_only() {
        for (input, sites, expected) in CASES {
            let sites: Vec<String> = sites.iter().map(|s| s.to_string()).collect();
            assert_eq!(
                matching_site(input, &sites).as_deref(),
                *expected,
                "{input} against {sites:?}"
            );
        }
    }

    #[test]
    fn normalises_entries() {
        assert_eq!(site_host("  *.Okta.COM. ").as_deref(), Some("okta.com"));
        assert_eq!(site_host("user@host.test:22").as_deref(), Some("host.test"));
        assert_eq!(site_host("").as_deref(), None);
    }
}
