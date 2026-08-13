//! ProfileStore — the browser profile abstraction.
//!
//! DESIGN.md section 6.2. Implemented separately by each engine.

use async_trait::async_trait;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("profile not found: {0}")]
    NotFound(String),
    #[error("profile io: {0}")]
    Io(String),
    #[error("profile: {0}")]
    Other(String),
}

pub type ProfileResult<T> = Result<T, ProfileError>;

/// A browser profile identifier. Derived from hash(tmux server identity, session ID).
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ProfileId(pub String);

/// Profile metadata (DESIGN.md section 6.2).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BrowserProfile {
    pub id: ProfileId,
    pub display_name: String,
    pub storage_root: String,
    pub source: ProfileSource,
}

/// Where a profile came from.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ProfileSource {
    /// A fresh profile.
    Fresh,
    /// Bootstrapped from a Chrome profile.
    ChromeBootstrap,
    /// An imported bundle.
    ImportedBundle,
}

/// A cookie descriptor. The value is not included (for security).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CookieDescriptor {
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: String,
    pub partitioned: bool,
}

/// The result of a cookie transfer. Counts and attributes only, never values.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CookieTransferResult {
    pub origin: String,
    pub count: usize,
    pub preserved: Vec<CookieDescriptor>,
}

/// ProfileStore trait.
#[async_trait]
pub trait ProfileStore: Send + Sync {
    /// Fetches or creates a profile.
    async fn get_or_create(&self, id: &ProfileId) -> ProfileResult<BrowserProfile>;

    /// Lists the profiles.
    async fn list(&self) -> ProfileResult<Vec<BrowserProfile>>;

    /// Cookie transfer (origin-scoped, one-shot). The values are only ever handled internally.
    async fn transfer_cookies(
        &self,
        profile: &ProfileId,
        origin: &str,
    ) -> ProfileResult<CookieTransferResult>;

    /// Deletes a profile.
    async fn remove(&self, id: &ProfileId) -> ProfileResult<()>;
}
