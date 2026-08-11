//! ResourceBroker, ResourceDescriptor — the resource store abstraction.
//!
//! DESIGN.md sections 12.3–12.5.

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

/// An opaque resource ID. Carries neither a path nor a cookie value.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ResourceId(pub String);

/// A resource descriptor (DESIGN.md section 12.3).
/// Metadata only, never the value.
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

/// A resource's scope (DESIGN.md section 12.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceScope {
    pub tmux_server_id: String,
    pub session_id: String,
    pub window_id: Option<String>,
    pub pane_id: Option<String>,
}

/// Where a resource is stored.
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

/// A resource's sensitivity (DESIGN.md section 12.15).
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
/// An opaque ID alone does not grant access; the caller's identity and capability are checked.
pub trait ResourceBroker: Send + Sync {
    /// Reads a resource's metadata.
    fn inspect(&self, id: &ResourceId) -> ResourceResult<ResourceDescriptor>;

    /// Materializes a resource's body at the given path.
    fn materialize(&self, id: &ResourceId, to: &std::path::Path) -> ResourceResult<()>;

    /// Transfers a resource (cross-host).
    fn transfer(&self, id: &ResourceId, to_host: &str) -> ResourceResult<()>;

    /// Revokes a resource. Blocks any new handle from being issued.
    fn revoke(&self, id: &ResourceId) -> ResourceResult<()>;

    /// Cleans up expired resources.
    fn gc_expired(&self) -> ResourceResult<usize>;
}
