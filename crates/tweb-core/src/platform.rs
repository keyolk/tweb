//! PlatformService — OS 추상.
//!
//! macOS/Linux/Windows가 각각 구현.
//! DESIGN.md 섹션 6.6, DETAIL.md 섹션 9.2.

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

/// local IPC 추상. Unix socket/XPC(macOS), Unix socket(Linux), named pipe(Windows).
#[async_trait]
pub trait LocalIpcTransport: Send + Sync {
    /// socket path.
    fn path(&self) -> &str;

    /// peer credential 확인.
    fn verify_peer(&self, peer_uid: u32) -> bool;
}

/// handle transfer 추상. Mach port(macOS), SCM_RIGHTS(Linux), DuplicateHandle(Windows).
pub trait HandleTransfer: Send + Sync {
    /// surface handle을 다른 process로 전달.
    fn send_surface(&self, handle: &crate::frame::SurfaceHandle) -> PlatformResult<()>;

    /// surface handle 수신.
    fn recv_surface(&self) -> PlatformResult<crate::frame::SurfaceHandle>;
}

/// credential store 추상. Keychain(macOS), Secret Service(Linux), DPAPI(Windows).
#[async_trait]
pub trait CredentialStore: Send + Sync {
    /// credential 저장.
    async fn set(&self, key: &str, value: &[u8]) -> PlatformResult<()>;

    /// credential 조회.
    async fn get(&self, key: &str) -> PlatformResult<Vec<u8>>;

    /// credential 삭제.
    async fn delete(&self, key: &str) -> PlatformResult<()>;
}

/// browser discovery 추상. Chrome app bundle(macOS), desktop entry(Linux), registry(Windows).
pub trait BrowserDiscovery: Send + Sync {
    /// system Chrome 경로.
    fn chrome_path(&self) -> Option<&str>;
}

/// platform path 추상.
pub trait PlatformPaths: Send + Sync {
    fn config_home(&self) -> &std::path::Path;
    fn data_home(&self) -> &std::path::Path;
    fn runtime_dir(&self) -> &std::path::Path;
}

/// process supervisor 추상.
#[async_trait]
pub trait ProcessSupervisor: Send + Sync {
    /// child process 시작.
    async fn spawn(&self, cmd: &str, args: &[&str]) -> PlatformResult<u32>;

    /// child process 종료.
    async fn kill(&self, pid: u32) -> PlatformResult<()>;
}

/// PlatformService trait. 모든 OS service를 통합.
pub trait PlatformService: Send + Sync {
    fn local_ipc(&self) -> &dyn LocalIpcTransport;
    fn handle_transfer(&self) -> &dyn HandleTransfer;
    fn credential_store(&self) -> &dyn CredentialStore;
    fn browser_discovery(&self) -> &dyn BrowserDiscovery;
    fn paths(&self) -> &dyn PlatformPaths;
    fn process_supervisor(&self) -> &dyn ProcessSupervisor;
}
