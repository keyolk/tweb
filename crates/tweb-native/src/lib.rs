//! tweb-native — frame transfer optimizations (SHM, tile, convert, kitty protocol).
//!
//! The part awrit delegated to `awrit-native-rs`. Avoids the bottleneck in DESIGN.md section 7.1.
//! Never shm_open per paint, convert/transfer dirty tiles only, bounded pools.

pub mod convert;
pub mod kitty;
pub mod shm;
pub mod tile;
