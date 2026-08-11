//! KittyGraphicsTransport — SHM + Kitty graphics transfer (local).
//!
//! DESIGN.md section 7.3, DETAIL.md section 2.
//! Takes frames from a SurfaceSource and sends them through tweb-native's tile/convert/kitty.
//!
//! Key optimizations:
//! - never shm_open per paint (ShmPool owns the persistent buffer)
//! - convert/transfer dirty tiles only (never the whole frame)
//! - zero transfer for static pages (no frame is produced on an Idle event)
//! - image IDs are reused from a bounded pool

use async_trait::async_trait;
use parking_lot::Mutex;
use std::collections::HashMap;
use tweb_core::frame::{
    FrameEvent, FrameTransport, SurfaceSource, TerminalCapability, TransportError, TransportResult,
};
use tweb_core::geometry::{PixelFormat, PixelSize, Rect};
use tweb_core::page::PageId;
use tweb_native::convert;
use tweb_native::kitty::{self, ImageIdPool, KittyAction, KittyCommand, KittyMedium};
use tweb_native::shm::ShmPool;
use tweb_native::tile::{self, TileGrid, TilePlan};

/// KittyGraphicsTransport.
pub struct KittyGraphicsTransport {
    /// Per-page state.
    pages: Mutex<HashMap<PageId, PageTransportState>>,
    /// SHM pool (one persistent buffer per page).
    shm: ShmPool,
}

/// Per-page transfer state.
struct PageTransportState {
    /// tile grid.
    grid: TileGrid,
    /// image ID pool (bounded).
    image_ids: ImageIdPool,
    /// The tile image IDs currently allocated (tile index → image id).
    tile_image_ids: HashMap<(u32, u32), u32>,
    /// RGBA conversion buffer (reused).
    rgba_buffer: Vec<u8>,
    /// The current viewport size.
    viewport: PixelSize,
    /// Whether the page is visible.
    visible: bool,
}

impl KittyGraphicsTransport {
    pub fn new() -> Self {
        Self {
            pages: Mutex::new(HashMap::new()),
            shm: ShmPool::new(),
        }
    }

    /// Initializes the page's transfer state.
    fn init_page(&self, page_id: PageId, viewport: PixelSize) -> TransportResult<()> {
        self.shm
            .get_or_create(page_id, viewport)
            .map_err(|e| TransportError::Io(e.to_string()))?;

        let mut pages = self.pages.lock();
        pages.insert(
            page_id,
            PageTransportState {
                grid: TileGrid::default_256(viewport),
                image_ids: ImageIdPool::new(),
                tile_image_ids: HashMap::new(),
                rgba_buffer: Vec::with_capacity(viewport.rgba_bytes()),
                viewport,
                visible: true,
            },
        );
        Ok(())
    }

    /// Handles a frame event.
    fn handle_frame(
        &self,
        page_id: PageId,
        event: FrameEvent,
        state: &mut PageTransportState,
    ) -> TransportResult<()> {
        match event {
            FrameEvent::Dirty {
                rects,
                pixels,
                size,
                format,
                generation: _,
            } => {
                if !state.visible {
                    return Ok(()); // Hidden pages transfer nothing.
                }

                // Work out the tile plan.
                let plan = tile::plan(&state.grid, &rects, 0.2);

                match plan {
                    TilePlan::FullFrame => {
                        // Full-frame transfer.
                        convert::convert_full_to_rgba(&pixels.data, format, &mut state.rgba_buffer);

                        // Write into SHM.
                        self.shm
                            .write(page_id, &state.rgba_buffer)
                            .map_err(|e| TransportError::Io(e.to_string()))?;

                        // Kitty transmit + placement.
                        let image_id = state.image_ids.acquire();
                        let cmd = KittyCommand {
                            data: state.rgba_buffer.clone(),
                            size,
                            src_rect: None,
                            image_id,
                            medium: KittyMedium::Direct, // TODO: switch to SHM.
                            action: KittyAction::Transmit,
                        };
                        kitty::write_to_stdout(&cmd)
                            .map_err(|e| TransportError::Io(e.to_string()))?;

                        // virtual placement.
                        let place_cmd = KittyCommand {
                            data: Vec::new(),
                            size,
                            src_rect: None,
                            image_id,
                            medium: KittyMedium::Direct,
                            action: KittyAction::VirtualPlacement,
                        };
                        kitty::write_to_stdout(&place_cmd)
                            .map_err(|e| TransportError::Io(e.to_string()))?;
                    }
                    TilePlan::Tiles(tiles) => {
                        // Per-tile transfer.
                        for tile_idx in &tiles {
                            let tile_rect = state.grid.tile_rect(tile_idx);
                            let key = (tile_idx.col, tile_idx.row);

                            // Fetch or allocate the tile's image ID.
                            let image_id = *state
                                .tile_image_ids
                                .entry(key)
                                .or_insert_with(|| state.image_ids.acquire());

                            // Extract the pixel data where the dirty rect and the tile rect overlap.
                            let tile_pixels =
                                extract_tile_pixels(&pixels.data, &size, format, &tile_rect);

                            // Convert to RGBA.
                            let mut rgba = Vec::with_capacity(tile_pixels.len());
                            convert::convert_full_to_rgba(&tile_pixels, format, &mut rgba);

                            // Kitty transmit (replace).
                            let cmd = KittyCommand {
                                data: rgba,
                                size: PixelSize::new(tile_rect.width, tile_rect.height),
                                src_rect: None,
                                image_id,
                                medium: KittyMedium::Direct,
                                action: KittyAction::Transmit,
                            };
                            kitty::write_to_stdout(&cmd)
                                .map_err(|e| TransportError::Io(e.to_string()))?;

                            // placement (updated in place).
                            let place_cmd = KittyCommand {
                                data: Vec::new(),
                                size: PixelSize::new(tile_rect.width, tile_rect.height),
                                src_rect: None,
                                image_id,
                                medium: KittyMedium::Direct,
                                action: KittyAction::VirtualPlacement,
                            };
                            kitty::write_to_stdout(&place_cmd)
                                .map_err(|e| TransportError::Io(e.to_string()))?;
                        }
                    }
                }
            }
            FrameEvent::Gpu { .. } => {
                // TODO: GPU fast path (Tier 3, SharedTexture).
                tracing::warn!("GPU frame event not yet supported in KittyGraphicsTransport");
            }
            FrameEvent::Idle => {
                // A static page. Nothing is transferred.
            }
            FrameEvent::End => {
                // The page ended. Delete the images.
                let mut pages = self.pages.lock();
                if let Some(state) = pages.get_mut(&page_id) {
                    for (_, image_id) in state.tile_image_ids.drain() {
                        let cmd = KittyCommand {
                            data: Vec::new(),
                            size: PixelSize::new(0, 0),
                            src_rect: None,
                            image_id,
                            medium: KittyMedium::Direct,
                            action: KittyAction::Delete,
                        };
                        let _ = kitty::write_to_stdout(&cmd);
                    }
                }
            }
        }
        Ok(())
    }
}

impl Default for KittyGraphicsTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl FrameTransport for KittyGraphicsTransport {
    fn supports(&self, caps: &TerminalCapability) -> bool {
        caps.supports_kitty_basic()
    }

    async fn stream(
        &self,
        page_id: PageId,
        mut source: Box<dyn SurfaceSource>,
    ) -> TransportResult<()> {
        // If the page has not been initialized yet, initialize it with the default viewport.
        {
            let pages = self.pages.lock();
            if !pages.contains_key(&page_id) {
                drop(pages);
                self.init_page(page_id, PixelSize::new(800, 600))?;
            }
        }

        loop {
            let event = source.next_frame()?;
            let should_break = matches!(event, FrameEvent::End);

            {
                let mut pages = self.pages.lock();
                if let Some(state) = pages.get_mut(&page_id) {
                    self.handle_frame(page_id, event, state)?;
                } else {
                    break;
                }
            }

            if should_break {
                break;
            }

            // TODO: coalesce per display frame. For now every frame is handled.
            tokio::task::yield_now().await;
        }

        Ok(())
    }

    async fn set_visible(&self, page_id: PageId, visible: bool) -> TransportResult<()> {
        let mut pages = self.pages.lock();
        if let Some(state) = pages.get_mut(&page_id) {
            state.visible = visible;
            if !visible {
                // hidden: keep the last image, but stop transferring new frames.
                // TODO: stop the compositor's begin-frame.
            }
        }
        Ok(())
    }

    async fn resize(&self, page_id: PageId, size: PixelSize) -> TransportResult<()> {
        {
            let mut pages = self.pages.lock();
            if let Some(state) = pages.get_mut(&page_id) {
                state.grid = TileGrid::default_256(size);
                state.viewport = size;
                state.rgba_buffer = Vec::with_capacity(size.rgba_bytes());
                // Release the previous tile image IDs.
                for (_, image_id) in state.tile_image_ids.drain() {
                    state.image_ids.release(image_id);
                }
            }
        }
        self.shm
            .resize(page_id, size)
            .map_err(|e| TransportError::Io(e.to_string()))?;
        Ok(())
    }

    async fn close(&self, page_id: PageId) -> TransportResult<()> {
        // image delete.
        {
            let mut pages = self.pages.lock();
            if let Some(state) = pages.get_mut(&page_id) {
                for (_, image_id) in state.tile_image_ids.drain() {
                    let cmd = KittyCommand {
                        data: Vec::new(),
                        size: PixelSize::new(0, 0),
                        src_rect: None,
                        image_id,
                        medium: KittyMedium::Direct,
                        action: KittyAction::Delete,
                    };
                    let _ = kitty::write_to_stdout(&cmd);
                }
            }
            pages.remove(&page_id);
        }
        self.shm.remove(&page_id);
        Ok(())
    }
}

/// Extracts the pixel data for a tile's area.
fn extract_tile_pixels(
    src: &[u8],
    size: &PixelSize,
    _format: PixelFormat,
    tile_rect: &Rect,
) -> Vec<u8> {
    let stride = size.width as usize * 4;
    let start_x = tile_rect.x.max(0) as usize;
    let start_y = tile_rect.y.max(0) as usize;
    let end_x = (tile_rect.x + tile_rect.width as i32).max(0) as usize;
    let end_y = (tile_rect.y + tile_rect.height as i32).max(0) as usize;
    let row_len = (end_x - start_x) * 4;

    let mut out = Vec::with_capacity(row_len * (end_y - start_y));
    for y in start_y..end_y {
        let off = y * stride + start_x * 4;
        if off + row_len <= src.len() {
            out.extend_from_slice(&src[off..off + row_len]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_kitty_basic() {
        let transport = KittyGraphicsTransport::new();
        let caps = TerminalCapability {
            kitty_graphics: true,
            kitty_animation: false,
            kitty_placement: false,
            kitty_shared_memory: false,
            pixel_mouse: false,
            extended_keyboard: false,
            pixel_size: None,
            cell_size: None,
        };
        assert!(transport.supports(&caps));
    }

    #[test]
    fn does_not_support_no_kitty() {
        let transport = KittyGraphicsTransport::new();
        let caps = TerminalCapability {
            kitty_graphics: false,
            kitty_animation: false,
            kitty_placement: false,
            kitty_shared_memory: false,
            pixel_mouse: false,
            extended_keyboard: false,
            pixel_size: None,
            cell_size: None,
        };
        assert!(!transport.supports(&caps));
    }
}
