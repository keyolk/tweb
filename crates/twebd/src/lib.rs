//! twebd — TWeb browser daemon.
//!
//! Host당 하나의 daemon. pane마다 Electron/Node/V8를 복제하지 않고
//! browser process 하나가 여러 page를 관리. DESIGN.md 섹션 5.1.
//!
//! 책임:
//! - authenticated local IPC (사용자 전용 runtime directory, peer credential 확인)
//! - PageRegistry (tmux pane ID ↔ page 매핑)
//! - ProfileManager (session별 persistent profile)
//! - ResourceBroker (immutable resource store, scope, TTL)
//! - AutomationController (agent action 직렬화)
//! - tmux integration (pane lifecycle, hook)

pub mod automation;
pub mod ipc;
pub mod page_registry;
pub mod profile_manager;
pub mod resource_broker;
pub mod tmux;

use tweb_core::engine::BrowserEngineAdapter;
use tweb_core::frame::FrameTransport;
use tweb_core::platform::PlatformService;
use tweb_core::routing::BrowserRoutingPolicy;

/// twebd daemon 전체 상태.
pub struct Daemon {
    /// browser engine adapter (Electron/ExternalChrome/CustomShell).
    pub engine: Box<dyn BrowserEngineAdapter>,
    /// frame transport (KittyGraphics/NativeSurface/RemoteVideo).
    pub transport: Box<dyn FrameTransport>,
    /// platform service (macOS/Linux/Windows).
    pub platform: Box<dyn PlatformService>,
    /// URL routing 정책.
    pub routing: BrowserRoutingPolicy,
    /// page registry (pane ID ↔ page 매핑).
    pub pages: page_registry::PageRegistry,
    /// profile manager.
    pub profiles: profile_manager::ProfileManager,
    /// resource broker.
    pub resources: resource_broker::ResourceBrokerImpl,
}

impl Daemon {
    /// daemon 시작.
    pub async fn run(self) -> anyhow::Result<()> {
        tracing::info!("twebd starting");

        // IPC server 시작.
        let ipc_path = self.platform.paths().runtime_dir().join("twebd.sock");
        let daemon = std::sync::Arc::new(self);

        ipc::serve(daemon.clone(), &ipc_path).await?;

        Ok(())
    }
}
