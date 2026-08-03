//! BrowserRoutingPolicy — URL routing 정책.
//!
//! DESIGN.md 섹션 11. embedded/managed-chrome/remote/ask.

use serde::{Deserialize, Serialize};
use url::Url;

/// URL routing 정책.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserRoutingPolicy {
    /// sensitive domain denylist (Okta, IdP 등).
    pub sensitive_domains: Vec<String>,
    /// managed Chrome으로 열 URL pattern.
    pub managed_chrome_patterns: Vec<String>,
    /// remote browser로 열 URL pattern.
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

/// routing 결정.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteDecision {
    /// TWeb embedded browser.
    Embedded,
    /// 실제 Google Chrome (managed Chrome handoff).
    ManagedChrome,
    /// remote browser.
    Remote,
    /// 사용자에게 묻기.
    Ask,
}

impl BrowserRoutingPolicy {
    /// URL에 대한 routing 결정.
    pub fn route(&self, url: &Url) -> RouteDecision {
        let host = url.host_str().unwrap_or("");
        // sensitive domain은 managed Chrome.
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
