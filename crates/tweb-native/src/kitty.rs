//! Kitty graphics protocol 전송.
//!
//! DESIGN.md 섹션 7.3. `a=t`(transmit-only) + `a=p,U=1`(virtual placement).
//! stable tile image ID 제자리 갱신. bounded pool로 image ID 재사용.
//! 공식: https://sw.kovidgoyal.net/kitty/graphics-protocol/

use std::io::Write;
use tweb_core::geometry::{PixelSize, Rect};

/// Kitty graphics 전송 명령.
#[derive(Debug, Clone)]
pub struct KittyCommand {
    /// 전송할 pixel data (RGBA).
    pub data: Vec<u8>,
    /// image 크기.
    pub size: PixelSize,
    /// source rect (부분 전송 시).
    pub src_rect: Option<Rect>,
    /// image ID (bounded pool에서 재사용).
    pub image_id: u32,
    /// 전송 방식.
    pub medium: KittyMedium,
    /// action.
    pub action: KittyAction,
}

/// 전송 방식.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KittyMedium {
    /// shared memory (`t=s`). 로컬 fast path.
    SharedMemory,
    /// direct in escape sequence (`t=d`). small image용.
    Direct,
}

/// Kitty action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KittyAction {
    /// transmit-only (`a=t`). placement 없이 image data만 전송.
    Transmit,
    /// virtual placement (`a=p`, `U=1`). render rectangle 정의.
    VirtualPlacement,
    /// query (`a=q`). capability 확인.
    Query,
    /// delete (`a=d`). image 제거.
    Delete,
}

/// Kitty graphics escape sequence 생성.
///
/// format: `ESC _ G <key=value>,... <ESC> \`
/// chunk size 4096 bytes (공식 권장).
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
                // shared memory: data는 SHM에 있고, escape는 metadata만.
                // SHM name을 전송. (실제 SHM name은 shm module에서 생성)
                // TODO: SHM name을 header에 포함.
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
            // a=d, i=<image_id>. image 제거.
            let header = format!("a=d,i={}", cmd.image_id);
            out.extend_from_slice(b"\x1b_G");
            out.extend_from_slice(header.as_bytes());
            out.extend_from_slice(b"\x1b\\");
        }
    }

    out
}

/// chunked 전송. 첫 chunk에 header, 이후 chunk는 `m=1` continuation.
/// `q=2`로 failure response 억제 (production에서는 q=1로 OK만).
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

/// base64 encode (URL-safe 아님, 표준).
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

/// image ID bounded pool. 무한 생성 금지, 재사용.
pub struct ImageIdPool {
    next: u32,
    free: Vec<u32>,
}

impl ImageIdPool {
    pub fn new() -> Self {
        Self {
            next: 1, // 0은 사용하지 않음.
            free: Vec::new(),
        }
    }

    /// image ID 할당.
    pub fn acquire(&mut self) -> u32 {
        self.free.pop().unwrap_or_else(|| {
            let id = self.next;
            self.next += 1;
            id
        })
    }

    /// image ID 반환 (재사용).
    pub fn release(&mut self, id: u32) {
        self.free.push(id);
    }
}

impl Default for ImageIdPool {
    fn default() -> Self {
        Self::new()
    }
}

/// stdout에 Kitty command 직접 write.
pub fn write_to_stdout(cmd: &KittyCommand) -> std::io::Result<()> {
    let encoded = encode(cmd);
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    lock.write_all(&encoded)?;
    lock.flush()
}
