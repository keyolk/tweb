//! ProfileStore — browser profile 추상.
//!
//! DESIGN.md 섹션 6.2. engine이 각각 구현.

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

/// browser profile 식별자. hash(tmux server identity, session ID) 기반.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ProfileId(pub String);

/// profile metadata (DESIGN.md 섹션 6.2).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BrowserProfile {
    pub id: ProfileId,
    pub display_name: String,
    pub storage_root: String,
    pub source: ProfileSource,
}

/// profile 출처.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ProfileSource {
    /// 새 profile.
    Fresh,
    /// Chrome profile에서 bootstrap.
    ChromeBootstrap,
    /// import된 bundle.
    ImportedBundle,
}

/// cookie descriptor. 값은 포함하지 않음 (보안).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CookieDescriptor {
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: String,
    pub partitioned: bool,
}

/// cookie transfer 결과. 값이 아닌 개수와 속성만.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CookieTransferResult {
    pub origin: String,
    pub count: usize,
    pub preserved: Vec<CookieDescriptor>,
}

/// ProfileStore trait.
#[async_trait]
pub trait ProfileStore: Send + Sync {
    /// profile 생성 또는 가져오기.
    async fn get_or_create(&self, id: &ProfileId) -> ProfileResult<BrowserProfile>;

    /// profile 목록.
    async fn list(&self) -> ProfileResult<Vec<BrowserProfile>>;

    /// cookie transfer (origin-scoped one-shot). 값은 내부적으로만 처리.
    async fn transfer_cookies(
        &self,
        profile: &ProfileId,
        origin: &str,
    ) -> ProfileResult<CookieTransferResult>;

    /// profile 삭제.
    async fn remove(&self, id: &ProfileId) -> ProfileResult<()>;
}
