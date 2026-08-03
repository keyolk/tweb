//! BrowserEngineAdapter — browser process 추상.
//!
//! Electron/ExternalChrome/CustomShell이 각각 구현.
//! core API는 page/profile/resource/automation을 다루고 engine 세부를 모름.
//! engine 교체가 core API를 바꾸지 않는다 (DETAIL.md 섹션 9.4).

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
/// 구현체: ElectronAdapter, ExternalChromeAdapter, CustomShellAdapter.
#[async_trait]
pub trait BrowserEngineAdapter: Send + Sync {
    /// page 생성. pane identity와 연결.
    async fn create_page(&self, pane: crate::page::PaneId, url: &Url) -> EngineResult<PageId>;

    /// page 종료.
    async fn close_page(&self, page: PageId) -> EngineResult<()>;

    /// navigation.
    async fn navigate(&self, page: PageId, url: &Url) -> EngineResult<()>;

    /// page viewport size. resize 시 호출.
    async fn resize(&self, page: PageId, size: PixelSize) -> EngineResult<()>;

    /// page 가시성. hidden page는 frame production 중지.
    async fn set_visible(&self, page: PageId, visible: bool) -> EngineResult<()>;

    /// frame 생산 source. FrameTransport이 소비.
    async fn frame_source(&self, page: PageId) -> EngineResult<Box<dyn SurfaceSource>>;

    /// 입력 주입 sink.
    async fn input_sink(&self, page: PageId) -> EngineResult<Box<dyn InputSink>>;

    /// extension host.
    fn extension_host(&self) -> &dyn ExtensionHost;

    /// profile store.
    fn profile_store(&self) -> &dyn ProfileStore;

    /// page 상태 snapshot (agent automation용).
    async fn snapshot(&self, page: PageId) -> EngineResult<PageSnapshot>;

    /// agent action 실행 (click/fill/press/scroll/navigate).
    async fn execute_action(&self, page: PageId, action: &Action) -> EngineResult<()>;

    /// engine 종료.
    async fn shutdown(&self) -> EngineResult<()>;
}
