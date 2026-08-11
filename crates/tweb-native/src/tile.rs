//! Dirty rect → adaptive tile mapping.
//!
//! DESIGN.md section 7.3. 256×256 tiles by default, adjusted between 128 and 512 by workload.
//! Only tiles overlapping a dirty rect are updated, and the damage events of one display interval
//! are unioned together.
//! When the changed area is large — a scroll, say — everything is folded into a full-frame/stripe.

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
    /// Builds the grid from a viewport size and a tile size.
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

    /// Computes the set of tiles a dirty rect overlaps.
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

    /// The union of the tile sets of several dirty rects.
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

    /// Decides whether the changed area is large. Past a set fraction of the viewport, it is folded
    /// into a full-frame/stripe.
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

/// The tile transfer decision.
#[derive(Debug, Clone)]
pub enum TilePlan {
    /// Per-tile transfer.
    Tiles(Vec<TileIndex>),
    /// Full-frame transfer (the changed area is large).
    FullFrame,
}

/// Works out the transfer plan from the dirty rects.
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
        // 250-270 straddles tile 0 (0-255) and tile 1 (256-511).
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
