//! TWeb core — the common types and traits, independent of platform and engine.
//!
//! core knows nothing about the engine/transport/agent/platform implementations; it only defines traits.
//! Adding a new implementation never changes existing code (DETAIL.md section 9).

pub mod agent;
pub mod engine;
pub mod extension;
pub mod frame;
pub mod input;
pub mod platform;
pub mod profile;
pub mod resource;
pub mod routing;

pub mod geometry;
pub mod page;

pub use geometry::{ColorSpace, Generation, PixelFormat, PixelPoint, PixelSize, Rect, SurfaceId};
pub use page::{PageId, PageSnapshot, PageStatus, PaneId};
