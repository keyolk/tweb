//! Shared geometry types.

use serde::{Deserialize, Serialize};

/// A size in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PixelSize {
    pub width: u32,
    pub height: u32,
}

impl PixelSize {
    pub fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    /// The RGBA byte count (width × height × 4).
    pub fn rgba_bytes(&self) -> usize {
        self.width as usize * self.height as usize * 4
    }
}

/// A point in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PixelPoint {
    pub x: i32,
    pub y: i32,
}

/// A rectangle in pixels. Shared by dirty rects, tiles and damage areas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Whether it overlaps another rect.
    pub fn intersects(&self, other: &Rect) -> bool {
        let self_right = self.x + self.width as i32;
        let self_bottom = self.y + self.height as i32;
        let other_right = other.x + other.width as i32;
        let other_bottom = other.y + other.height as i32;
        self.x < other_right
            && other.x < self_right
            && self.y < other_bottom
            && other.y < self_bottom
    }

    /// The union of two rects.
    pub fn union(&self, other: &Rect) -> Rect {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = (self.x + self.width as i32).max(other.x + other.width as i32);
        let bottom = (self.y + self.height as i32).max(other.y + other.height as i32);
        Rect::new(x, y, (right - x) as u32, (bottom - y) as u32)
    }
}

/// A surface identifier, assigned by the engine.
pub type SurfaceId = u64;

/// pixel format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PixelFormat {
    /// Blue, Green, Red, Alpha (the macOS NativeImage default).
    Bgra,
    /// Red, Green, Blue, Alpha (what Kitty graphics wants).
    Rgba,
}

/// color space.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ColorSpace {
    Srgb,
    DisplayP3,
}

/// The frame generation. Bumped on every resize; frames from an earlier generation are never displayed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct Generation(pub u64);

impl Generation {
    pub fn initial() -> Self {
        Self(0)
    }
    pub fn next(&self) -> Self {
        Self(self.0 + 1)
    }
}
