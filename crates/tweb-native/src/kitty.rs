//! Kitty graphics protocol transfer.
//!
//! DESIGN.md section 7.3. `a=t` (transmit-only) + `a=p,U=1` (virtual placement).
//! Stable tile image IDs updated in place. Image IDs are reused from a bounded pool.
//! Spec: https://sw.kovidgoyal.net/kitty/graphics-protocol/

use std::io::Write;
use tweb_core::geometry::{PixelSize, Rect};

/// A Kitty graphics transfer command.
#[derive(Debug, Clone)]
pub struct KittyCommand {
    /// The pixel data to transfer (RGBA).
    pub data: Vec<u8>,
    /// The image size.
    pub size: PixelSize,
    /// The source rect (for a partial transfer).
    pub src_rect: Option<Rect>,
    /// The image ID (reused from the bounded pool).
    pub image_id: u32,
    /// How it is transferred.
    pub medium: KittyMedium,
    /// action.
    pub action: KittyAction,
}

/// How data is transferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KittyMedium {
    /// shared memory (`t=s`). The local fast path.
    SharedMemory,
    /// direct in escape sequence (`t=d`). For small images.
    Direct,
}

/// Kitty action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KittyAction {
    /// transmit-only (`a=t`). Sends the image data alone, no placement.
    Transmit,
    /// virtual placement (`a=p`, `U=1`). Defines the render rectangle.
    VirtualPlacement,
    /// query (`a=q`). Checks capabilities.
    Query,
    /// delete (`a=d`). Removes the image.
    Delete,
}

/// Builds a Kitty graphics escape sequence.
///
/// format: `ESC _ G <key=value>,... <ESC> \`
/// chunk size 4096 bytes (as the spec recommends).
pub fn encode(cmd: &KittyCommand) -> Vec<u8> {
    let mut out = Vec::new();

    match cmd.action {
        KittyAction::Query => {
            // capability query: a=q
            out.extend_from_slice(b"\x1b_Ga=q\x1b\\");
        }
        KittyAction::Transmit => {
            // a=t, i=<image_id>, s=<width>, v=<height>, f=32 (RGBA)
            let header = format!(
                "a=t,i={},s={},v={},f=32",
                cmd.image_id, cmd.size.width, cmd.size.height,
            );
            let medium_key = match cmd.medium {
                KittyMedium::Direct => "t=d",
                KittyMedium::SharedMemory => "t=s",
            };
            let full_header = format!("{},{}", header, medium_key);

            if cmd.medium == KittyMedium::Direct {
                // direct: base64 encode data, 4096 byte chunk.
                let encoded = base64_encode(&cmd.data);
                write_chunked(&mut out, &full_header, &encoded, cmd.data.is_empty());
            } else {
                // shared memory: the data lives in SHM and the escape carries metadata only.
                // The SHM name is what gets sent. (The actual name is created by the shm module.)
                // TODO: include the SHM name in the header.
                write_chunked(&mut out, &full_header, "", true);
            }
        }
        KittyAction::VirtualPlacement => {
            // a=p, U=1, i=<image_id>. virtual placement.
            let header = format!("a=p,U=1,i={}", cmd.image_id);
            out.extend_from_slice(b"\x1b_G");
            out.extend_from_slice(header.as_bytes());
            out.extend_from_slice(b"\x1b\\");
        }
        KittyAction::Delete => {
            // a=d, i=<image_id>. Removes the image.
            let header = format!("a=d,i={}", cmd.image_id);
            out.extend_from_slice(b"\x1b_G");
            out.extend_from_slice(header.as_bytes());
            out.extend_from_slice(b"\x1b\\");
        }
    }

    out
}

/// Chunked transfer. The header rides on the first chunk; later chunks are `m=1` continuations.
/// `q=2` suppresses failure responses (in production, q=1 suppresses only the OKs).
fn write_chunked(out: &mut Vec<u8>, header: &str, data: &str, _empty: bool) {
    const CHUNK: usize = 4096;

    if data.is_empty() {
        out.extend_from_slice(b"\x1b_G");
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(b"\x1b\\");
        return;
    }

    let bytes = data.as_bytes();
    let mut first = true;
    let mut pos = 0;

    while pos < bytes.len() {
        let end = (pos + CHUNK).min(bytes.len());
        let chunk = &bytes[pos..end];
        let more = end < bytes.len();

        out.extend_from_slice(b"\x1b_G");
        if first {
            out.extend_from_slice(header.as_bytes());
            out.extend_from_slice(b",q=2");
            if more {
                out.extend_from_slice(b",m=1");
            }
            first = false;
        } else {
            if more {
                out.extend_from_slice(b"m=1,q=2");
            } else {
                out.extend_from_slice(b"q=2");
            }
        }
        out.push(b';');
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\x1b\\");

        pos = end;
    }
}

/// base64 encode (standard alphabet, not URL-safe).
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 2 < data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        i += 3;
    }
    if i < data.len() {
        let n = (data[i] as u32) << 16
            | if i + 1 < data.len() {
                (data[i + 1] as u32) << 8
            } else {
                0
            };
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if i + 1 < data.len() {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        out.push('=');
    }
    out
}

/// A bounded pool of image IDs. IDs are reused rather than minted without limit.
pub struct ImageIdPool {
    next: u32,
    free: Vec<u32>,
}

impl ImageIdPool {
    pub fn new() -> Self {
        Self {
            next: 1, // 0 is not used.
            free: Vec::new(),
        }
    }

    /// Allocates an image ID.
    pub fn acquire(&mut self) -> u32 {
        self.free.pop().unwrap_or_else(|| {
            let id = self.next;
            self.next += 1;
            id
        })
    }

    /// Returns an image ID to the pool (for reuse).
    pub fn release(&mut self, id: u32) {
        self.free.push(id);
    }
}

impl Default for ImageIdPool {
    fn default() -> Self {
        Self::new()
    }
}

/// Writes a Kitty command straight to stdout.
pub fn write_to_stdout(cmd: &KittyCommand) -> std::io::Result<()> {
    let encoded = encode(cmd);
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    lock.write_all(&encoded)?;
    lock.flush()
}
