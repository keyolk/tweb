//! Resize — turns SIGWINCH into a pixel viewport resize.
//!
//! DESIGN.md section 8. No 100ms debounce; coalescing per display frame only.

use tweb_core::geometry::{Generation, PixelSize};

/// resize event.
#[derive(Debug, Clone)]
pub struct ResizeEvent {
    pub size: PixelSize,
    pub generation: Generation,
}

/// SIGWINCH handler. Bumps the viewport generation and queries the new size.
/// TODO: receive SIGWINCH via a signal hook, query the terminal pixel size.
pub fn handle_sigwinch(current_gen: Generation) -> ResizeEvent {
    let size = crate::terminal::query_pixel_size().unwrap_or(PixelSize::new(800, 600));
    ResizeEvent {
        size,
        generation: current_gen.next(),
    }
}
