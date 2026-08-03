//! ResourceBroker, ResourceDescriptor — resource store 추상.
//!
//! DESIGN.md 섹션 12.3-12.5.

use crate::agent::ResourceKind;
use crate::page::PageId;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ResourceError {
    #[error("resource not found: {0}")]
    NotFound(String),
    #[error("resource expired: {0}")]
    Expired(String),
    #[error("resource io: {0}")]
    Io(String),
    #[error("resource: {0}")]
    Other(String),
}

pub type ResourceResult<T> = Result<T, ResourceError>;

/// opaque resource ID. 경로나 cookie 값을 포함하지 않음.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ResourceId(pub String);

/// resource descriptor (DESIGN.md 섹션 12.3).
/// 값이 아닌 metadata만.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceDescriptor {
    pub id: ResourceId,
    pub kind: ResourceKind,
    pub mime_type: String,
    pub producer: String,
    pub source_page: Option<PageId>,
    pub scope: ResourceScope,
    pub locality: ResourceLocality,
    pub size: u64,
    pub digest: String,
    pub sensitivity: Sensitivity,
    pub created_at: u64,
    pub expires_at: Option<u64>,
}

/// resource 범위 (DESIGN.md 섹션 12.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceScope {
    pub tmux_server_id: String,
    pub session_id: String,
    pub window_id: Option<String>,
    pub pane_id: Option<String>,
}

/// resource 저장 위치.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceLocality {
    pub host_id: String,
    pub storage_kind: StorageKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageKind {
    Inline,
    Object,
    File,
    Live,
    Bundle,
}

/// resource sensitivity (DESIGN.md 섹션 12.15).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sensitivity {
    Public,
    Workspace,
    Internal,
    Sensitive,
    CredentialBearing,
}

/// ResourceBroker trait.
/// opaque ID만으로 접근을 허용하지 않고 caller identity와 capability 확인.
pub trait ResourceBroker: Send + Sync {
    /// resource metadata 조회.
    fn inspect(&self, id: &ResourceId) -> ResourceResult<ResourceDescriptor>;

    /// resource body를 지정 경로에 materialize.
    fn materialize(&self, id: &ResourceId, to: &std::path::Path) -> ResourceResult<()>;

    /// resource 전송 (cross-host).
    fn transfer(&self, id: &ResourceId, to_host: &str) -> ResourceResult<()>;

    /// resource revoke. 새 handle 발급 차단.
    fn revoke(&self, id: &ResourceId) -> ResourceResult<()>;

    /// 만료된 resource 정리.
    fn gc_expired(&self) -> ResourceResult<usize>;
}
