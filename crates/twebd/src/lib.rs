//! twebd — TWeb browser daemon.
//!
//! One daemon per host. Rather than duplicating Electron/Node/V8 per pane, a single browser
//! process manages many pages. DESIGN.md section 5.1.
//!
//! Responsibilities:
//! - authenticated local IPC (user-private runtime directory, peer credential check)
//! - PageRegistry (tmux pane ID ↔ page mapping)
//! - ProfileManager (a persistent profile per session)
//! - ResourceBroker (immutable resource store, scope, TTL)
//! - AutomationController (serializing agent actions)
//! - tmux integration (pane lifecycle, hooks)

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

/// The twebd daemon's whole state.
pub struct Daemon {
    /// browser engine adapter (Electron/ExternalChrome/CustomShell).
    pub engine: Box<dyn BrowserEngineAdapter>,
    /// frame transport (KittyGraphics/NativeSurface/RemoteVideo).
    pub transport: Box<dyn FrameTransport>,
    /// platform service (macOS/Linux/Windows).
    pub platform: Box<dyn PlatformService>,
    /// The URL routing policy.
    pub routing: BrowserRoutingPolicy,
    /// page registry (pane ID ↔ page mapping).
    pub pages: page_registry::PageRegistry,
    /// profile manager.
    pub profiles: profile_manager::ProfileManager,
    /// resource broker.
    pub resources: resource_broker::ResourceBrokerImpl,
}

impl Daemon {
    /// Starts the daemon.
    pub async fn run(self) -> anyhow::Result<()> {
        tracing::info!("twebd starting");

        // Start the IPC server.
        let ipc_path = self.platform.paths().runtime_dir().join("twebd.sock");
        let daemon = std::sync::Arc::new(self);

        ipc::serve(daemon.clone(), &ipc_path).await?;

        Ok(())
    }
}
