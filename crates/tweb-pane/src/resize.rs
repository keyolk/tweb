//! Resize — SIGWINCH를 pixel viewport resize로 변환.
//!
//! DESIGN.md 섹션 8. 100ms debounce 금지, display frame 단위 coalescing만.

use tweb_core::geometry::{Generation, PixelSize};

/// resize event.
#[derive(Debug, Clone)]
pub struct ResizeEvent {
    pub size: PixelSize,
    pub generation: Generation,
}

/// SIGWINCH handler. viewport generation 증가, 새 size query.
/// TODO: signal hook으로 SIGWINCH 수신, terminal pixel query.
pub fn handle_sigwinch(current_gen: Generation) -> ResizeEvent {
    let size = crate::terminal::query_pixel_size().unwrap_or(PixelSize::new(800, 600));
    ResizeEvent {
        size,
        generation: current_gen.next(),
    }
}
