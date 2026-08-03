//! tweb-native — frame 전송 최적화 (SHM, tile, convert, kitty protocol).
//!
//! awrit가 `awrit-native-rs`에 위임했던 부분. DESIGN.md 섹션 7.1 병목 회피.
//! 매 paint shm_open 금지, dirty tile만 변환/전송, bounded pool.

pub mod convert;
pub mod kitty;
pub mod shm;
pub mod tile;
