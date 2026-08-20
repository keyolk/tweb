//! BrowserRoutingPolicy — the URL routing policy.
//!
//! DESIGN.md section 11. embedded/managed-chrome/remote/ask.
//!
//! This type has no consumers, and after an attempt to give it some, that is a decision
//! rather than an oversight.
//!
//! Automatic routing by domain was built into the engine and removed. An SSO login is not a
//! page but a redirect chain — the service sets a state cookie, the IdP authenticates, the
//! callback needs that cookie again — so sending only the IdP to another browser puts a
//! boundary in the middle of the flow. Measured against a real Argo CD tenant: the login
//! started in TWeb, the callback landed in Chrome, and dex answered `Bad Request — User
//! session error`, because the session was in the other browser's cookie store. Two browsers
//! cannot share one OAuth flow.
//!
//! What ships instead is `tweb chrome open <url>`: a person hands over a whole site, entry
//! point included, and the entire chain happens in one browser. `sensitive_domains` below
//! therefore describes a judgement nobody automates.
//!
//! The type survives as the specification — the four-way decision, including the `Remote`
//! and `Ask` arms nothing implements. Deleting it would lose that along with the dead code.

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
