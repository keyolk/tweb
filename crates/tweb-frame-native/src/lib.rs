//! Shared-memory frames for the Kitty graphics `t=s` medium.
//!
//! DETAIL.md 8.5 measured the frame-file write as the only thing dropping whole frames at
//! 2880x1800/30fps — its p99 is 164% of the frame budget, and a run that skipped the write took
//! `droppedByBackpressure` from ~244 to 0. `o=z` bought that back on kitty, but it kills Ghostty
//! (deflate-policy.cjs), so on Ghostty every whole frame still goes through the disk. `t=s` is the
//! medium with no disk in it, and DETAIL.md 8.2 verified Ghostty reads and unlinks the object.
//! What stood in the way was that macOS has no `/dev/shm`: `shm_open` needs native code, and the
//! engine had none. This crate is that native code and nothing more.
//!
//! The copy into the mapping is also where the BGRA->RGBA swap happens, so a whole frame is one
//! pass over its pixels from Chromium's bitmap to what the terminal reads.

use std::ffi::CString;
use std::io;

/// Writes `pixels` into a fresh POSIX shared-memory object called `name`, swapping B and R
/// on the way when `swap` is set.
///
/// The object is unlinked first if it exists. A name is reused round a small ring, and the
/// terminal unlinks what it consumed — so an object still present is one the terminal never read
/// (a hidden pane, passthrough off), and its frame is long stale. Creating with `O_EXCL` after
/// that unlink guarantees the terminal can never open a half-written object, which is the same
/// fresh-object guarantee the file medium gets from `rename`.
pub fn write_frame(name: &str, pixels: &[u8], swap: bool) -> io::Result<()> {
    if swap && !pixels.len().is_multiple_of(4) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} bytes is not whole pixels", pixels.len()),
        ));
    }
    if pixels.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty frame"));
    }
    let c_name = shm_name(name)?;
    let _ = unlink_name(&c_name);
    // SAFETY: `c_name` is a valid NUL-terminated string; the mode is passed as the variadic
    // `c_uint` that `shm_open` reads when `O_CREAT` is set.
    let fd = unsafe {
        libc::shm_open(
            c_name.as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_RDWR,
            0o600 as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let result = fill(fd, pixels, swap);
    // SAFETY: `fd` came from the successful `shm_open` above and is closed exactly once.
    unsafe { libc::close(fd) };
    if result.is_err() {
        // Never leave a half-written object behind for a terminal to read.
        let _ = unlink_name(&c_name);
    }
    result
}

/// Removes a shared-memory object. `Ok(false)` when there was nothing to remove — the common case,
/// since the terminal unlinks every object it reads.
pub fn unlink(name: &str) -> io::Result<bool> {
    unlink_name(&shm_name(name)?)
}

fn unlink_name(name: &CString) -> io::Result<bool> {
    // SAFETY: `name` is a valid NUL-terminated string.
    if unsafe { libc::shm_unlink(name.as_ptr()) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOENT) {
        Ok(false)
    } else {
        Err(error)
    }
}

// macOS caps a shared-memory name at PSHMNAMLEN (31) bytes and rejects longer ones with
// ENAMETOOLONG; Linux allows more, but the engine's names have to work on both.
const MAX_NAME_BYTES: usize = 31;

fn shm_name(name: &str) -> io::Result<CString> {
    if !name.starts_with('/') || name[1..].contains('/') || name.len() > MAX_NAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a portable shared-memory name: {name:?}"),
        ));
    }
    CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in name"))
}

fn fill(fd: libc::c_int, pixels: &[u8], swap: bool) -> io::Result<()> {
    let len = pixels.len();
    let size = libc::off_t::try_from(len)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    // SAFETY: `fd` is an open shared-memory descriptor owned by the caller.
    if unsafe { libc::ftruncate(fd, size) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: mapping `len` bytes of an object just sized to `len`, shared so the terminal sees
    // what is written.
    let map = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            len,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED,
            fd,
            0,
        )
    };
    if map == libc::MAP_FAILED {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `map` is a fresh writable mapping of exactly `len` bytes that nothing else aliases
    // until it is unmapped below.
    let out = unsafe { std::slice::from_raw_parts_mut(map.cast::<u8>(), len) };
    if swap {
        swap_into(pixels, out);
    } else {
        out.copy_from_slice(pixels);
    }
    // SAFETY: unmapping exactly the mapping created above.
    if unsafe { libc::munmap(map, len) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// An Electron shared texture's IOSurface, read on the CPU. macOS only.
///
/// With `offscreen.useSharedTexture`, a paint hands over a GPU surface instead of a CPU bitmap;
/// `textureInfo.handle.ioSurface` is a Buffer holding the `IOSurfaceRef` pointer. This locks it
/// read-only and copies its rows out tightly packed, which is the CPU pass the default path's
/// `toBitmap()` stands for — present so `bench/shared-texture.cjs` can price the two against each
/// other. zenbu-labs/terminal-browser reads the surface the same way (pixel-node/src/iosurface.rs).
#[cfg(target_os = "macos")]
pub mod iosurface {
    use std::ffi::c_void;

    type IOSurfaceRef = *mut c_void;
    const LOCK_READ_ONLY: u32 = 1;

    #[link(name = "IOSurface", kind = "framework")]
    extern "C" {
        fn IOSurfaceLock(surface: IOSurfaceRef, options: u32, seed: *mut u32) -> i32;
        fn IOSurfaceUnlock(surface: IOSurfaceRef, options: u32, seed: *mut u32) -> i32;
        fn IOSurfaceGetBaseAddress(surface: IOSurfaceRef) -> *mut c_void;
        fn IOSurfaceGetWidth(surface: IOSurfaceRef) -> usize;
        fn IOSurfaceGetHeight(surface: IOSurfaceRef) -> usize;
        fn IOSurfaceGetBytesPerRow(surface: IOSurfaceRef) -> usize;
    }

    /// Copies the whole surface out as tightly packed 4-byte pixels, in the surface's own order.
    ///
    /// # Safety
    /// `surface` must be a live `IOSurfaceRef` for the duration of the call — Electron guarantees
    /// that until the texture's `release()` is called.
    pub unsafe fn read(surface: usize) -> Result<(u32, u32, Vec<u8>), String> {
        let surface = surface as IOSurfaceRef;
        if surface.is_null() {
            return Err("null IOSurface".into());
        }
        // SAFETY: the caller guarantees a live surface; locked read-only and unlocked below.
        unsafe {
            let status = IOSurfaceLock(surface, LOCK_READ_ONLY, std::ptr::null_mut());
            if status != 0 {
                return Err(format!("IOSurfaceLock failed: {status}"));
            }
            let width = IOSurfaceGetWidth(surface);
            let height = IOSurfaceGetHeight(surface);
            let stride = IOSurfaceGetBytesPerRow(surface);
            let base = IOSurfaceGetBaseAddress(surface).cast::<u8>();
            let row = width * 4;
            let mut out = vec![0u8; row * height];
            if !base.is_null() && stride >= row {
                for y in 0..height {
                    let src = std::slice::from_raw_parts(base.add(y * stride), row);
                    out[y * row..(y + 1) * row].copy_from_slice(src);
                }
            }
            IOSurfaceUnlock(surface, LOCK_READ_ONLY, std::ptr::null_mut());
            if base.is_null() {
                return Err("IOSurface has no CPU address".into());
            }
            if stride < row {
                return Err(format!("stride {stride} shorter than a {width}px row"));
            }
            Ok((width as u32, height as u32, out))
        }
    }
}

/// BGRA to RGBA. Byte-indexed rather than through `u32` views: neither the Node buffer nor the
/// mapping is guaranteed to be 4-byte aligned for a cast, and in a release build this loop is
/// already memory-bandwidth bound (gfx-worker.cjs records a bare 20MB memcpy at 0.35ms).
fn swap_into(bgra: &[u8], rgba: &mut [u8]) {
    let (src, _) = bgra.as_chunks::<4>();
    let (dst, _) = rgba.as_chunks_mut::<4>();
    for (src, dst) in src.iter().zip(dst) {
        dst[0] = src[2];
        dst[1] = src[1];
        dst[2] = src[0];
        dst[3] = src[3];
    }
}

// Test builds leave the Node-API surface out: its symbols only exist inside the Electron process
// that loads the addon, so a test executable referencing them would not link.
#[cfg(not(test))]
mod node {
    use napi::bindgen_prelude::Buffer;
    use napi_derive::napi;

    /// `writeShmFrame(name, pixels, swap)`: see [`crate::write_frame`].
    #[napi(js_name = "writeShmFrame")]
    pub fn write_shm_frame(name: String, pixels: Buffer, swap: bool) -> napi::Result<()> {
        crate::write_frame(&name, &pixels, swap)
            .map_err(|error| napi::Error::from_reason(format!("shm frame {name}: {error}")))
    }

    /// `readIOSurface(handle)`: `{ width, height, pixels }` from a shared texture's
    /// `textureInfo.handle.ioSurface`. macOS only.
    #[cfg(target_os = "macos")]
    #[napi(object)]
    pub struct SurfacePixels {
        pub width: u32,
        pub height: u32,
        pub pixels: Buffer,
    }

    #[cfg(target_os = "macos")]
    #[napi(js_name = "readIOSurface")]
    pub fn read_io_surface(handle: Buffer) -> napi::Result<SurfacePixels> {
        let bytes: [u8; 8] = handle
            .get(..8)
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| napi::Error::from_reason("IOSurface handle is not 8 bytes"))?;
        let address = usize::from_ne_bytes(bytes);
        // SAFETY: Electron keeps the surface alive until the texture is released, and the caller
        // reads it inside the paint handler before calling `release()`.
        let (width, height, pixels) =
            unsafe { crate::iosurface::read(address) }.map_err(napi::Error::from_reason)?;
        Ok(SurfacePixels {
            width,
            height,
            pixels: pixels.into(),
        })
    }

    /// `unlinkShm(name)`: true when an object was removed.
    #[napi(js_name = "unlinkShm")]
    pub fn unlink_shm(name: String) -> napi::Result<bool> {
        crate::unlink(&name)
            .map_err(|error| napi::Error::from_reason(format!("shm unlink {name}: {error}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_name(tag: &str) -> String {
        format!("/twbt.{}.{tag}", std::process::id())
    }

    fn read_back(name: &str, len: usize) -> Vec<u8> {
        let c_name = shm_name(name).unwrap();
        // SAFETY: test-only read of an object this test created.
        unsafe {
            let fd = libc::shm_open(c_name.as_ptr(), libc::O_RDONLY, 0 as libc::c_uint);
            assert!(fd >= 0, "object must exist: {}", io::Error::last_os_error());
            let map = libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ,
                libc::MAP_SHARED,
                fd,
                0,
            );
            assert_ne!(map, libc::MAP_FAILED);
            let bytes = std::slice::from_raw_parts(map.cast::<u8>(), len).to_vec();
            libc::munmap(map, len);
            libc::close(fd);
            bytes
        }
    }

    #[test]
    fn swaps_blue_and_red_into_the_object() {
        let name = test_name("swap");
        write_frame(&name, &[1, 2, 3, 4, 10, 20, 30, 40], true).unwrap();
        assert_eq!(read_back(&name, 8), vec![3, 2, 1, 4, 30, 20, 10, 40]);
        assert!(unlink(&name).unwrap());
    }

    #[test]
    fn copies_unchanged_without_swap() {
        let name = test_name("copy");
        write_frame(&name, &[9, 8, 7], false).unwrap();
        assert_eq!(read_back(&name, 3), vec![9, 8, 7]);
        unlink(&name).unwrap();
    }

    #[test]
    fn replaces_an_object_the_terminal_never_consumed() {
        let name = test_name("ring");
        write_frame(&name, &[0; 16], false).unwrap();
        write_frame(&name, &[5; 8], false).unwrap();
        assert_eq!(read_back(&name, 8), vec![5; 8]);
        unlink(&name).unwrap();
    }

    #[test]
    fn unlink_of_a_missing_object_is_not_an_error() {
        assert!(!unlink(&test_name("gone")).unwrap());
    }

    #[test]
    fn rejects_names_that_are_not_portable() {
        assert!(write_frame("no-slash", &[0; 4], false).is_err());
        assert!(write_frame("/a/b", &[0; 4], false).is_err());
        assert!(write_frame(&format!("/{}", "x".repeat(31)), &[0; 4], false).is_err());
    }

    #[test]
    fn rejects_partial_pixels_when_swapping() {
        assert!(write_frame(&test_name("odd"), &[0; 6], true).is_err());
    }
}
