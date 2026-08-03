//! KittyGraphicsTransport — SHM + Kitty graphics 전송 (로컬).
//!
//! DESIGN.md 섹션 7.3, DETAIL.md 섹션 2.
//! SurfaceSource에서 frame을 받아 tweb-native의 tile/convert/kitty로 전송.
//!
//! 핵심 최적화:
//! - 매 paint shm_open 금지 (ShmPool이 persistent buffer 관리)
//! - dirty tile만 변환/전송 (전체 frame 변환 금지)
//! - static page zero transfer (Idle event 시 frame 생성 안 함)
//! - bounded pool로 image ID 재사용

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
    /// page별 상태.
    pages: Mutex<HashMap<PageId, PageTransportState>>,
    /// SHM pool (page별 persistent buffer).
    shm: ShmPool,
}

/// page별 전송 상태.
struct PageTransportState {
    /// tile grid.
    grid: TileGrid,
    /// image ID pool (bounded).
    image_ids: ImageIdPool,
    /// 현재 할당된 tile image ID map (tile index → image id).
    tile_image_ids: HashMap<(u32, u32), u32>,
    /// RGBA 변환 buffer (재사용).
    rgba_buffer: Vec<u8>,
    /// 현재 viewport size.
    viewport: PixelSize,
    /// visible 여부.
    visible: bool,
}

impl KittyGraphicsTransport {
    pub fn new() -> Self {
        Self {
            pages: Mutex::new(HashMap::new()),
            shm: ShmPool::new(),
        }
    }

    /// page 전송 상태 초기화.
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

    /// frame event 처리.
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
                    return Ok(()); // hidden page는 전송 안 함.
                }

                // tile plan 수립.
                let plan = tile::plan(&state.grid, &rects, 0.2);

                match plan {
                    TilePlan::FullFrame => {
                        // full-frame 전송.
                        convert::convert_full_to_rgba(&pixels.data, format, &mut state.rgba_buffer);

                        // SHM에 write.
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
                            medium: KittyMedium::Direct, // TODO: SHM로 전환.
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
                        // tile별 전송.
                        for tile_idx in &tiles {
                            let tile_rect = state.grid.tile_rect(tile_idx);
                            let key = (tile_idx.col, tile_idx.row);

                            // tile image ID 가져오기 또는 할당.
                            let image_id = *state
                                .tile_image_ids
                                .entry(key)
                                .or_insert_with(|| state.image_ids.acquire());

                            // dirty rect와 tile rect 교집합의 pixel data 추출.
                            let tile_pixels =
                                extract_tile_pixels(&pixels.data, &size, format, &tile_rect);

                            // RGBA 변환.
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

                            // placement (제자리 갱신).
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
                // static page. frame 전송 안 함.
            }
            FrameEvent::End => {
                // page 종료. image delete.
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
        // page가 아직 초기화되지 않았으면 기본 viewport로 초기화.
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

            // TODO: display frame 단위 coalescing. 현재는 매 frame 처리.
            tokio::task::yield_now().await;
        }

        Ok(())
    }

    async fn set_visible(&self, page_id: PageId, visible: bool) -> TransportResult<()> {
        let mut pages = self.pages.lock();
        if let Some(state) = pages.get_mut(&page_id) {
            state.visible = visible;
            if !visible {
                // hidden: 마지막 image는 유지하되, 새 frame 전송 중지.
                // TODO: compositor begin-frame 중지.
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
                // 이전 tile image ID 해제.
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

/// tile 영역의 pixel data 추출.
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
