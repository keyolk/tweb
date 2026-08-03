//! FrameTransport, SurfaceSource, FrameEvent — frame 전달/생산 추상.
//!
//! KittyGraphics/NativeSurface/RemoteVideo가 FrameTransport를 각각 구현.
//! engine이 SurfaceSource를 구현하여 frame을 생산.
//! DETAIL.md 섹션 9.2.

use crate::geometry::{ColorSpace, Generation, PixelFormat, PixelSize, Rect};
use crate::page::PageId;
use async_trait::async_trait;
use bytes::Bytes;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("page not found: {0}")]
    PageNotFound(PageId),
    #[error("terminal capability insufficient: {0}")]
    InsufficientCapability(String),
    #[error("transport io: {0}")]
    Io(String),
    #[error("transport: {0}")]
    Other(String),
}

pub type TransportResult<T> = Result<T, TransportError>;

/// terminal capability. graphics query(`a=q` + `ESC[c`) 결과.
/// FrameTransport이 이 capability로 전송 전략을 판정.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalCapability {
    /// Kitty graphics protocol 지원 여부.
    pub kitty_graphics: bool,
    /// animation frame + composite 지원.
    pub kitty_animation: bool,
    /// independent image placement + replace 지원.
    pub kitty_placement: bool,
    /// shared memory 전송(`t=s`) 지원.
    pub kitty_shared_memory: bool,
    /// pixel mouse 좌표(SGR).
    pub pixel_mouse: bool,
    /// extended keyboard protocol.
    pub extended_keyboard: bool,
    /// terminal pixel size (CSI 14t 결과).
    pub pixel_size: Option<PixelSize>,
    /// cell size.
    pub cell_size: Option<(u32, u32)>,
}

impl TerminalCapability {
    /// 최소 Kitty graphics 지원 여부.
    pub fn supports_kitty_basic(&self) -> bool {
        self.kitty_graphics
    }
}

/// frame 생산 추상. engine이 구현.
/// `next_frame`으로 frame event를 하나씩 반환. backpressure는 구현체가 처리.
pub trait SurfaceSource: Send {
    /// 다음 frame event. blocking 없이 현재 상태 반환.
    /// backpressure: 구현체가 intermediate generation을 버리고 최신 complete frame만 반환.
    fn next_frame(&mut self) -> TransportResult<FrameEvent>;
}

/// frame event. SurfaceSource가 반환.
#[derive(Debug)]
pub enum FrameEvent {
    /// dirty rect와 pixel data (CPU bitmap 경로, shared memory bitmap mode).
    Dirty {
        rects: Vec<Rect>,
        /// 전체 frame pixel data (BGRA 또는 RGBA).
        pixels: BitmapRef,
        size: PixelSize,
        format: PixelFormat,
        generation: Generation,
    },
    /// GPU texture handle (GPU fast path, shared texture mode).
    /// handle은 platform별. RemoteVideoTransport는 handle을 보내지 않고 video encode.
    Gpu {
        handle: SurfaceHandle,
        size: PixelSize,
        format: PixelFormat,
        color_space: ColorSpace,
        generation: Generation,
    },
    /// page가 idle, frame 없음. static page.
    Idle,
    /// page 종료. stream 종료.
    End,
}

/// pixel data 참조. 소유하지 않고 slice.
pub struct BitmapRef {
    pub data: Bytes,
    pub format: PixelFormat,
}

impl std::fmt::Debug for BitmapRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BitmapRef")
            .field("len", &self.data.len())
            .field("format", &self.format)
            .finish()
    }
}

/// GPU surface handle. platform별.
#[derive(Debug, Clone)]
pub enum SurfaceHandle {
    /// macOS IOSurface.
    Iosurface(u64),
    /// Linux DMA-BUF file descriptor.
    DmaBuf(i32),
    /// Windows DXGI shared handle.
    Dxgi(u64),
}

/// FrameTransport trait.
/// 구현체: KittyGraphicsTransport, NativeSurfaceTransport, RemoteVideoTransport.
#[async_trait]
pub trait FrameTransport: Send + Sync {
    /// terminal capability로 transport 선택.
    fn supports(&self, caps: &TerminalCapability) -> bool;

    /// surface source에서 frame을 받아 terminal에 전달.
    /// page lifetime 동안 stream 유지.
    async fn stream(&self, page: PageId, source: Box<dyn SurfaceSource>) -> TransportResult<()>;

    /// page visibility 변화. hidden page는 frame production 중지.
    async fn set_visible(&self, page: PageId, visible: bool) -> TransportResult<()>;

    /// page resize. generation 증가.
    async fn resize(&self, page: PageId, size: PixelSize) -> TransportResult<()>;

    /// page cleanup. surface/SHM 해제.
    async fn close(&self, page: PageId) -> TransportResult<()>;
}
