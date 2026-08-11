//! BrowserEngineAdapter — the browser process abstraction.
//!
//! Implemented separately for Electron/ExternalChrome/CustomShell.
//! The core API deals in pages/profiles/resources/automation and knows nothing about engine internals.
//! Swapping the engine never changes the core API (DETAIL.md section 9.4).

use crate::extension::ExtensionHost;
use crate::frame::SurfaceSource;
use crate::geometry::PixelSize;
use crate::input::InputSink;
use crate::page::{PageId, PageSnapshot};
use crate::profile::ProfileStore;
use async_trait::async_trait;
use thiserror::Error;
use url::Url;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("page not found: {0}")]
    PageNotFound(PageId),
    #[error("navigation failed: {0}")]
    NavigationFailed(String),
    #[error("page crashed: {0}")]
    PageCrashed(PageId),
    #[error("engine io: {0}")]
    Io(String),
    #[error("engine: {0}")]
    Other(String),
}

pub type EngineResult<T> = Result<T, EngineError>;

/// agent action (click/fill/press/scroll/navigate).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Click { ref_id: String },
    Fill { ref_id: String, value: String },
    Press { key: String },
    Scroll { dx: i32, dy: i32 },
    Navigate { url: Url },
}

/// BrowserEngineAdapter trait.
/// Implementations: ElectronAdapter, ExternalChromeAdapter, CustomShellAdapter.
#[async_trait]
pub trait BrowserEngineAdapter: Send + Sync {
    /// Creates a page, tied to a pane identity.
    async fn create_page(&self, pane: crate::page::PaneId, url: &Url) -> EngineResult<PageId>;

    /// Closes a page.
    async fn close_page(&self, page: PageId) -> EngineResult<()>;

    /// navigation.
    async fn navigate(&self, page: PageId, url: &Url) -> EngineResult<()>;

    /// The page's viewport size. Called on resize.
    async fn resize(&self, page: PageId, size: PixelSize) -> EngineResult<()>;

    /// Page visibility. Hidden pages stop producing frames.
    async fn set_visible(&self, page: PageId, visible: bool) -> EngineResult<()>;

    /// The frame production source. Consumed by FrameTransport.
    async fn frame_source(&self, page: PageId) -> EngineResult<Box<dyn SurfaceSource>>;

    /// The input injection sink.
    async fn input_sink(&self, page: PageId) -> EngineResult<Box<dyn InputSink>>;

    /// extension host.
    fn extension_host(&self) -> &dyn ExtensionHost;

    /// profile store.
    fn profile_store(&self) -> &dyn ProfileStore;

    /// A snapshot of the page state (for agent automation).
    async fn snapshot(&self, page: PageId) -> EngineResult<PageSnapshot>;

    /// Executes an agent action (click/fill/press/scroll/navigate).
    async fn execute_action(&self, page: PageId, action: &Action) -> EngineResult<()>;

    /// Shuts the engine down.
    async fn shutdown(&self) -> EngineResult<()>;
}
