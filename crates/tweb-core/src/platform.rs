//! PlatformService — the OS abstraction.
//!
//! Implemented separately for macOS/Linux/Windows.
//! DESIGN.md section 6.6, DETAIL.md section 9.2.

use async_trait::async_trait;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PlatformError {
    #[error("platform io: {0}")]
    Io(String),
    #[error("handle transfer failed: {0}")]
    HandleTransfer(String),
    #[error("credential store: {0}")]
    Credential(String),
    #[error("platform: {0}")]
    Other(String),
}

pub type PlatformResult<T> = Result<T, PlatformError>;

/// The local IPC abstraction. Unix socket/XPC (macOS), Unix socket (Linux), named pipe (Windows).
#[async_trait]
pub trait LocalIpcTransport: Send + Sync {
    /// socket path.
    fn path(&self) -> &str;

    /// Checks the peer's credentials.
    fn verify_peer(&self, peer_uid: u32) -> bool;
}

/// The handle transfer abstraction. Mach port (macOS), SCM_RIGHTS (Linux), DuplicateHandle (Windows).
pub trait HandleTransfer: Send + Sync {
    /// Passes a surface handle to another process.
    fn send_surface(&self, handle: &crate::frame::SurfaceHandle) -> PlatformResult<()>;

    /// Receives a surface handle.
    fn recv_surface(&self) -> PlatformResult<crate::frame::SurfaceHandle>;
}

/// The credential store abstraction. Keychain (macOS), Secret Service (Linux), DPAPI (Windows).
#[async_trait]
pub trait CredentialStore: Send + Sync {
    /// Stores a credential.
    async fn set(&self, key: &str, value: &[u8]) -> PlatformResult<()>;

    /// Reads a credential.
    async fn get(&self, key: &str) -> PlatformResult<Vec<u8>>;

    /// Deletes a credential.
    async fn delete(&self, key: &str) -> PlatformResult<()>;
}

/// The browser discovery abstraction. Chrome app bundle (macOS), desktop entry (Linux), registry (Windows).
pub trait BrowserDiscovery: Send + Sync {
    /// The system Chrome path.
    fn chrome_path(&self) -> Option<&str>;
}

/// The platform path abstraction.
pub trait PlatformPaths: Send + Sync {
    fn config_home(&self) -> &std::path::Path;
    fn data_home(&self) -> &std::path::Path;
    fn runtime_dir(&self) -> &std::path::Path;
}

/// The process supervisor abstraction.
#[async_trait]
pub trait ProcessSupervisor: Send + Sync {
    /// Starts a child process.
    async fn spawn(&self, cmd: &str, args: &[&str]) -> PlatformResult<u32>;

    /// Terminates a child process.
    async fn kill(&self, pid: u32) -> PlatformResult<()>;
}

/// PlatformService trait. Ties all the OS services together.
pub trait PlatformService: Send + Sync {
    fn local_ipc(&self) -> &dyn LocalIpcTransport;
    fn handle_transfer(&self) -> &dyn HandleTransfer;
    fn credential_store(&self) -> &dyn CredentialStore;
    fn browser_discovery(&self) -> &dyn BrowserDiscovery;
    fn paths(&self) -> &dyn PlatformPaths;
    fn process_supervisor(&self) -> &dyn ProcessSupervisor;
}
