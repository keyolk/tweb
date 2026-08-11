//! BGRA → RGBA conversion, dirty tiles only.
//!
//! DESIGN.md section 7.1. awrit converts the whole frame; TWeb SIMD-converts dirty tiles only.
//! macOS NativeImage is BGRA while Kitty graphics wants RGBA.

use tweb_core::geometry::{PixelFormat, Rect};

/// Converts pixel data's format to RGBA.
/// A BGRA source is byte-swapped (B and R exchanged); RGBA is left as is.
/// Only the dirty rect areas are converted (never the whole frame).
pub fn convert_to_rgba(
    src: &[u8],
    src_format: PixelFormat,
    src_size: &tweb_core::geometry::PixelSize,
    dirty_rects: &[Rect],
    dst: &mut Vec<u8>,
) {
    let dst_len = src.len();
    if dst.len() < dst_len {
        dst.resize(dst_len, 0);
    }

    match src_format {
        PixelFormat::Rgba => {
            // Already RGBA. Copy the dirty rects only.
            copy_dirty_regions(src, src_size, dirty_rects, dst);
        }
        PixelFormat::Bgra => {
            // BGRA → RGBA. Byte-swap the dirty rect areas only.
            swap_bgra_to_rgba_dirty(src, src_size, dirty_rects, dst);
        }
    }
}

/// Converts a whole frame to RGBA (for a full-frame transfer).
pub fn convert_full_to_rgba(src: &[u8], src_format: PixelFormat, dst: &mut Vec<u8>) {
    if dst.len() < src.len() {
        dst.resize(src.len(), 0);
    }
    match src_format {
        PixelFormat::Rgba => {
            dst[..src.len()].copy_from_slice(src);
        }
        PixelFormat::Bgra => {
            // Exchange B and R, 4 bytes at a time.
            for (i, chunk) in src.chunks_exact(4).enumerate() {
                let off = i * 4;
                dst[off] = chunk[2]; // R ← B
                dst[off + 1] = chunk[1]; // G
                dst[off + 2] = chunk[0]; // B ← R
                dst[off + 3] = chunk[3]; // A
            }
        }
    }
}

/// Copies the dirty rect areas only (src is already RGBA).
fn copy_dirty_regions(
    src: &[u8],
    size: &tweb_core::geometry::PixelSize,
    dirty_rects: &[Rect],
    dst: &mut [u8],
) {
    let stride = size.width as usize * 4;
    for rect in dirty_rects {
        let start_y = rect.y.max(0) as usize;
        let end_y = (rect.y + rect.height as i32).max(0) as usize;
        let start_x = rect.x.max(0) as usize * 4;
        let end_x = ((rect.x + rect.width as i32).max(0) as usize) * 4;
        for y in start_y..end_y {
            let src_off = y * stride + start_x;
            let dst_off = y * stride + start_x;
            let len = end_x - start_x;
            if src_off + len <= src.len() && dst_off + len <= dst.len() {
                dst[dst_off..dst_off + len].copy_from_slice(&src[src_off..src_off + len]);
            }
        }
    }
}

/// Converts BGRA → RGBA over the dirty rect areas only.
fn swap_bgra_to_rgba_dirty(
    src: &[u8],
    size: &tweb_core::geometry::PixelSize,
    dirty_rects: &[Rect],
    dst: &mut [u8],
) {
    let stride = size.width as usize * 4;
    for rect in dirty_rects {
        let start_y = rect.y.max(0) as usize;
        let end_y = (rect.y + rect.height as i32).max(0) as usize;
        let start_x = rect.x.max(0) as usize;
        let end_x = ((rect.x + rect.width as i32).max(0) as usize).min(size.width as usize);
        for y in start_y..end_y {
            for x in start_x..end_x {
                let off = y * stride + x * 4;
                if off + 3 < src.len() && off + 3 < dst.len() {
                    dst[off] = src[off + 2]; // R ← B
                    dst[off + 1] = src[off + 1]; // G
                    dst[off + 2] = src[off]; // B ← R
                    dst[off + 3] = src[off + 3]; // A
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tweb_core::geometry::PixelSize;

    #[test]
    fn bgra_to_rgba_full() {
        // 2x1 image. BGRA: [B,G,R,A] per pixel.
        let src = vec![10, 20, 30, 255, 40, 50, 60, 255];
        let mut dst = Vec::new();
        convert_full_to_rgba(&src, PixelFormat::Bgra, &mut dst);
        // RGBA: [R,G,B,A].
        assert_eq!(dst, vec![30, 20, 10, 255, 60, 50, 40, 255]);
    }

    #[test]
    fn rgba_passthrough() {
        let src = vec![10, 20, 30, 255, 40, 50, 60, 255];
        let mut dst = Vec::new();
        convert_full_to_rgba(&src, PixelFormat::Rgba, &mut dst);
        assert_eq!(dst, src);
    }

    #[test]
    fn bgra_to_rgba_dirty_only() {
        // 4x1 image. dirty rect = pixel 1 only.
        let src = vec![
            10, 20, 30, 255, // pixel 0 (unchanged)
            40, 50, 60, 255, // pixel 1 (dirty)
            70, 80, 90, 255, // pixel 2 (unchanged)
            1, 2, 3, 255, // pixel 3 (unchanged)
        ];
        let size = PixelSize::new(4, 1);
        let dirty = vec![Rect::new(1, 0, 1, 1)];
        let mut dst = src.clone(); // start with copy.
        swap_bgra_to_rgba_dirty(&src, &size, &dirty, &mut dst);
        // Only pixel 1 is converted: [40,50,60] → [60,50,40].
        assert_eq!(
            dst,
            vec![10, 20, 30, 255, 60, 50, 40, 255, 70, 80, 90, 255, 1, 2, 3, 255,]
        );
    }
}
