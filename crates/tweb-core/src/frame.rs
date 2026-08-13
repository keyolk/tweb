//! FrameTransport, SurfaceSource, FrameEvent — the frame delivery/production abstractions.
//!
//! KittyGraphics/NativeSurface/RemoteVideo each implement FrameTransport.
//! The engine implements SurfaceSource to produce frames.
//! DETAIL.md section 9.2.

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

/// Terminal capabilities — the result of the graphics query (`a=q` + `ESC[c`).
/// FrameTransport picks its transfer strategy from these capabilities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalCapability {
    /// Whether the Kitty graphics protocol is supported.
    pub kitty_graphics: bool,
    /// animation frame + composite support.
    pub kitty_animation: bool,
    /// independent image placement + replace support.
    pub kitty_placement: bool,
    /// shared memory transfer (`t=s`) support.
    pub kitty_shared_memory: bool,
    /// pixel mouse coordinates (SGR).
    pub pixel_mouse: bool,
    /// extended keyboard protocol.
    pub extended_keyboard: bool,
    /// terminal pixel size (the CSI 14t result).
    pub pixel_size: Option<PixelSize>,
    /// cell size.
    pub cell_size: Option<(u32, u32)>,
}

impl TerminalCapability {
    /// Whether the minimum Kitty graphics support is present.
    pub fn supports_kitty_basic(&self) -> bool {
        self.kitty_graphics
    }
}

/// The frame production abstraction, implemented by the engine.
/// `next_frame` returns frame events one at a time; backpressure is the implementation's job.
pub trait SurfaceSource: Send {
    /// The next frame event. Returns the current state without blocking.
    /// Backpressure: the implementation drops intermediate generations and returns only the
    /// latest complete frame.
    fn next_frame(&mut self) -> TransportResult<FrameEvent>;
}

/// A frame event, returned by SurfaceSource.
#[derive(Debug)]
pub enum FrameEvent {
    /// Dirty rects plus pixel data (the CPU bitmap path, shared memory bitmap mode).
    Dirty {
        rects: Vec<Rect>,
        /// The whole frame's pixel data (BGRA or RGBA).
        pixels: BitmapRef,
        size: PixelSize,
        format: PixelFormat,
        generation: Generation,
    },
    /// GPU texture handle (GPU fast path, shared texture mode).
    /// The handle is platform-specific. RemoteVideoTransport does not send a handle; it encodes video.
    Gpu {
        handle: SurfaceHandle,
        size: PixelSize,
        format: PixelFormat,
        color_space: ColorSpace,
        generation: Generation,
    },
    /// The page is idle, no frame. A static page.
    Idle,
    /// The page ended. The stream ends.
    End,
}

/// A reference to pixel data. Borrowed as a slice, not owned.
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

/// A GPU surface handle. Platform-specific.
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
/// Implementations: KittyGraphicsTransport, NativeSurfaceTransport, RemoteVideoTransport.
#[async_trait]
pub trait FrameTransport: Send + Sync {
    /// Selects a transport from the terminal capabilities.
    fn supports(&self, caps: &TerminalCapability) -> bool;

    /// Takes frames from a surface source and delivers them to the terminal.
    /// Keeps the stream alive for the page's lifetime.
    async fn stream(&self, page: PageId, source: Box<dyn SurfaceSource>) -> TransportResult<()>;

    /// A change in page visibility. Hidden pages stop producing frames.
    async fn set_visible(&self, page: PageId, visible: bool) -> TransportResult<()>;

    /// A page resize. Bumps the generation.
    async fn resize(&self, page: PageId, size: PixelSize) -> TransportResult<()>;

    /// Page cleanup. Releases the surface/SHM.
    async fn close(&self, page: PageId) -> TransportResult<()>;
}
