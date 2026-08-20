//! BrowserRoutingPolicy — the URL routing policy.
//!
//! DESIGN.md section 11. embedded/managed-chrome/remote/ask.
//!
//! This type has no consumers, and that is not an oversight waiting to be fixed by calling
//! it from here. The routing decision has to be made in the process that owns the
//! navigation — the engine — because the useful hook is `will-navigate`, which is
//! cancellable and lives in Electron. `electron/browser-routing.cjs` performs it and
//! mirrors the defaults below deliberately; the two are kept in step by
//! `electron/browser-routing.test.cjs`, which asserts the same domains.
//!
//! What survives here is the shape: the four-way decision, including the `Remote` and
//! `Ask` arms the engine does not implement. Deleting it would lose the specification
//! along with the dead code.

use serde::{Deserialize, Serialize};
use url::Url;

/// The URL routing policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserRoutingPolicy {
    /// A denylist of sensitive domains (Okta, IdPs and the like).
    pub sensitive_domains: Vec<String>,
    /// URL patterns to open in managed Chrome.
    pub managed_chrome_patterns: Vec<String>,
    /// URL patterns to open in a remote browser.
    pub remote_patterns: Vec<String>,
}

impl Default for BrowserRoutingPolicy {
    fn default() -> Self {
        Self {
            sensitive_domains: vec!["*.okta.com".to_string(), "aws.amazon.com".to_string()],
            managed_chrome_patterns: vec![],
            remote_patterns: vec![],
        }
    }
}

/// The routing decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteDecision {
    /// TWeb embedded browser.
    Embedded,
    /// Real Google Chrome (the managed Chrome handoff).
    ManagedChrome,
    /// remote browser.
    Remote,
    /// Ask the user.
    Ask,
}

impl BrowserRoutingPolicy {
    /// The routing decision for a URL.
    pub fn route(&self, url: &Url) -> RouteDecision {
        let host = url.host_str().unwrap_or("");
        // Sensitive domains go to managed Chrome.
        for pattern in &self.sensitive_domains {
            if let Some(suffix) = pattern.strip_prefix("*.") {
                if host.ends_with(suffix) {
                    return RouteDecision::ManagedChrome;
                }
            } else if host == pattern.as_str() {
                return RouteDecision::ManagedChrome;
            }
        }
        // managed chrome pattern.
        for pattern in &self.managed_chrome_patterns {
            if host == pattern {
                return RouteDecision::ManagedChrome;
            }
        }
        // remote pattern.
        for pattern in &self.remote_patterns {
            if host == pattern {
                return RouteDecision::Remote;
            }
        }
        RouteDecision::Embedded
    }
}
