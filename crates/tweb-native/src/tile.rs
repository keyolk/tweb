//! Dirty rect → adaptive tile 매핑.
//!
//! DESIGN.md 섹션 7.3. 256×256 기본 tile, workload에 따라 128~512 조정.
//! dirty rect와 겹치는 tile만 갱신. 한 display interval의 여러 damage event union.
//! scroll처럼 변경 면적이 크면 full-frame/stripe로 합침.

use tweb_core::geometry::{PixelSize, Rect};

/// tile grid.
#[derive(Debug, Clone)]
pub struct TileGrid {
    pub tile_size: u32,
    pub cols: u32,
    pub rows: u32,
    pub viewport: PixelSize,
}

impl TileGrid {
    /// viewport size와 tile size로 grid 생성.
    pub fn new(viewport: PixelSize, tile_size: u32) -> Self {
        let cols = viewport.width.div_ceil(tile_size);
        let rows = viewport.height.div_ceil(tile_size);
        Self {
            tile_size,
            cols,
            rows,
            viewport,
        }
    }

    /// default 256×256 tile.
    pub fn default_256(viewport: PixelSize) -> Self {
        Self::new(viewport, 256)
    }

    /// dirty rect와 겹치는 tile 집합 계산.
    pub fn tiles_for_rect(&self, rect: &Rect) -> Vec<TileIndex> {
        let mut tiles = Vec::new();

        let start_col = (rect.x.max(0) as u32 / self.tile_size).min(self.cols.saturating_sub(1));
        let end_col = (((rect.x + rect.width as i32).max(0) as u32 - 1) / self.tile_size)
            .min(self.cols.saturating_sub(1));
        let start_row = (rect.y.max(0) as u32 / self.tile_size).min(self.rows.saturating_sub(1));
        let end_row = (((rect.y + rect.height as i32).max(0) as u32 - 1) / self.tile_size)
            .min(self.rows.saturating_sub(1));

        for row in start_row..=end_row {
            for col in start_col..=end_col {
                tiles.push(TileIndex { col, row });
            }
        }
        tiles
    }

    /// 여러 dirty rect의 tile 집합 합집합.
    pub fn tiles_for_rects(&self, rects: &[Rect]) -> Vec<TileIndex> {
        let mut set: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
        let mut tiles = Vec::new();
        for rect in rects {
            for tile in self.tiles_for_rect(rect) {
                let key = (tile.col, tile.row);
                if set.insert(key) {
                    tiles.push(tile);
                }
            }
        }
        tiles
    }

    /// tile index → pixel rect.
    pub fn tile_rect(&self, tile: &TileIndex) -> Rect {
        let x = tile.col * self.tile_size;
        let y = tile.row * self.tile_size;
        let width = self.tile_size.min(self.viewport.width.saturating_sub(x));
        let height = self.tile_size.min(self.viewport.height.saturating_sub(y));
        Rect::new(x as i32, y as i32, width, height)
    }

    /// 변경 면적이 큰지 판정. viewport의 일정 비율 이상이면 full-frame/stripe로 합침.
    pub fn should_full_frame(&self, rects: &[Rect], threshold: f32) -> bool {
        let viewport_area = self.viewport.width as f32 * self.viewport.height as f32;
        let dirty_area: f32 = rects.iter().map(|r| r.width as f32 * r.height as f32).sum();
        dirty_area / viewport_area >= threshold
    }
}

/// tile index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TileIndex {
    pub col: u32,
    pub row: u32,
}

/// tile 전송 결정.
#[derive(Debug, Clone)]
pub enum TilePlan {
    /// tile별 전송.
    Tiles(Vec<TileIndex>),
    /// full-frame 전송 (변경 면적이 큼).
    FullFrame,
}

/// dirty rects에서 전송 계획 수립.
pub fn plan(grid: &TileGrid, rects: &[Rect], full_frame_threshold: f32) -> TilePlan {
    if rects.is_empty() {
        return TilePlan::Tiles(Vec::new());
    }
    if grid.should_full_frame(rects, full_frame_threshold) {
        return TilePlan::FullFrame;
    }
    TilePlan::Tiles(grid.tiles_for_rects(rects))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_grid_basic() {
        let grid = TileGrid::new(PixelSize::new(1920, 1080), 256);
        assert_eq!(grid.cols, 8); // 1920/256 = 7.5 → 8
        assert_eq!(grid.rows, 5); // 1080/256 = 4.2 → 5
    }

    #[test]
    fn tiles_for_small_rect() {
        let grid = TileGrid::new(PixelSize::new(1920, 1080), 256);
        let rect = Rect::new(300, 300, 50, 50);
        let tiles = grid.tiles_for_rect(&rect);
        // 300/256 = 1.17 → col 1. 350/256 = 1.37 → col 1.
        // 300/256 = 1.17 → row 1. 350/256 = 1.37 → row 1.
        assert_eq!(tiles.len(), 1);
        assert_eq!(tiles[0].col, 1);
        assert_eq!(tiles[0].row, 1);
    }

    #[test]
    fn tiles_for_crossing_boundary() {
        let grid = TileGrid::new(PixelSize::new(1920, 1080), 256);
        let rect = Rect::new(250, 250, 20, 20);
        let tiles = grid.tiles_for_rect(&rect);
        // 250-270이 tile 0(0-255)과 tile 1(256-511)에 걸침.
        assert_eq!(tiles.len(), 4);
    }

    #[test]
    fn should_full_frame_large() {
        let grid = TileGrid::new(PixelSize::new(1920, 1080), 256);
        let rect = Rect::new(0, 0, 1920, 1080);
        assert!(grid.should_full_frame(&[rect], 0.2));
    }

    #[test]
    fn should_not_full_frame_small() {
        let grid = TileGrid::new(PixelSize::new(1920, 1080), 256);
        let rect = Rect::new(100, 100, 50, 50);
        assert!(!grid.should_full_frame(&[rect], 0.2));
    }
}
