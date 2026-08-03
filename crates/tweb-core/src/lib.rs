//! TWeb core — platform/engine 무관 공통 type과 trait.
//!
//! core는 engine/transport/agent/platform 구현체를 모르고 trait만 정의한다.
//! 새 구현체 추가가 기존 코드를 바꾸지 않는다 (DETAIL.md 섹션 9).

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
