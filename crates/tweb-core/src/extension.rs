//! ExtensionHost — extension loading 추상.
//!
//! Electron/Chrome/Shell이 각각 구현.
//! DETAIL.md 섹션 9.2.

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

/// extension 식별자.
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

/// extension compatibility 분류 (DESIGN.md 섹션 10.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ExtensionClass {
    /// 자동 재설치 가능.
    Compatible,
    /// native messaging, toolbar, side panel 등 host 구현 필요.
    NeedsAdapter,
    /// Device Trust, enterprise policy, Chrome identity 의존.
    ManagedChromeOnly,
}

/// Native Messaging channel. 1Password 등이 사용.
#[async_trait]
pub trait NativeMessagingChannel: Send + Sync {
    /// host로 message 전송.
    async fn send(&self, message: &serde_json::Value) -> ExtensionResult<()>;

    /// host에서 message 수신.
    async fn recv(&self) -> ExtensionResult<serde_json::Value>;

    /// channel 종료.
    async fn close(&self) -> ExtensionResult<()>;
}

/// ExtensionHost trait.
/// 구현체: ElectronExtensionHost, ChromeExtensionHost, ShellExtensionHost.
#[async_trait]
pub trait ExtensionHost: Send + Sync {
    /// unpacked extension 로드.
    async fn load_extension(&self, path: &Path) -> ExtensionResult<ExtensionId>;

    /// extension 목록.
    async fn list_extensions(&self) -> ExtensionResult<Vec<ExtensionInfo>>;

    /// extension 제거.
    async fn remove_extension(&self, id: &ExtensionId) -> ExtensionResult<()>;

    /// extension compatibility 분류.
    async fn classify(&self, id: &ExtensionId) -> ExtensionResult<ExtensionClass>;

    /// native messaging host 연결.
    async fn connect_native(&self, name: &str) -> ExtensionResult<Box<dyn NativeMessagingChannel>>;
}
