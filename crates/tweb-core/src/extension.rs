//! ExtensionHost — the extension loading abstraction.
//!
//! Implemented separately for Electron/Chrome/Shell.
//! DETAIL.md section 9.2.

use async_trait::async_trait;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ExtensionError {
    #[error("extension not found: {0}")]
    NotFound(String),
    #[error("extension load failed: {0}")]
    LoadFailed(String),
    #[error("native messaging host not found: {0}")]
    NativeHostNotFound(String),
    #[error("extension: {0}")]
    Other(String),
}

pub type ExtensionResult<T> = Result<T, ExtensionError>;

/// An extension identifier.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ExtensionId(pub String);

/// extension metadata.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExtensionInfo {
    pub id: ExtensionId,
    pub name: String,
    pub version: String,
    pub path: String,
}

/// Extension compatibility classes (DESIGN.md section 10.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ExtensionClass {
    /// Can be reinstalled automatically.
    Compatible,
    /// Needs host support: native messaging, toolbar, side panel and the like.
    NeedsAdapter,
    /// Depends on Device Trust, enterprise policy or Chrome identity.
    ManagedChromeOnly,
}

/// A Native Messaging channel. Used by 1Password among others.
#[async_trait]
pub trait NativeMessagingChannel: Send + Sync {
    /// Sends a message to the host.
    async fn send(&self, message: &serde_json::Value) -> ExtensionResult<()>;

    /// Receives a message from the host.
    async fn recv(&self) -> ExtensionResult<serde_json::Value>;

    /// Closes the channel.
    async fn close(&self) -> ExtensionResult<()>;
}

/// ExtensionHost trait.
/// Implementations: ElectronExtensionHost, ChromeExtensionHost, ShellExtensionHost.
#[async_trait]
pub trait ExtensionHost: Send + Sync {
    /// Loads an unpacked extension.
    async fn load_extension(&self, path: &Path) -> ExtensionResult<ExtensionId>;

    /// Lists the extensions.
    async fn list_extensions(&self) -> ExtensionResult<Vec<ExtensionInfo>>;

    /// Removes an extension.
    async fn remove_extension(&self, id: &ExtensionId) -> ExtensionResult<()>;

    /// Classifies an extension's compatibility.
    async fn classify(&self, id: &ExtensionId) -> ExtensionResult<ExtensionClass>;

    /// Connects to a native messaging host.
    async fn connect_native(&self, name: &str) -> ExtensionResult<Box<dyn NativeMessagingChannel>>;
}
