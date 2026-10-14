use base64::Engine as _;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PaneOrigin {
    pub left: u32,
    pub top: u32,
}

/// Where each channel sits in a captured 32-bit pixel, from the CGImage's alpha position
/// and byte order. WKWebView hands back little-endian premultiplied-first, i.e. BGRA in
/// memory, but the layout is read rather than assumed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChannelOrder {
    Rgba,
    Bgra,
    Argb,
    Abgr,
}

/// A snapshot exactly as WebKit produced it. The main thread only copies these bytes out;
/// every pass over the pixels happens on the output thread, because the snapshot completion
/// runs on the main thread that also delivers keys and mouse events to the page.
pub(crate) struct Capture {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub bytes_per_row: usize,
    pub order: ChannelOrder,
}

pub(crate) struct Frame {
    pub capture: Capture,
    pub cols: u32,
    pub rows: u32,
    pub generation: u64,
}

/// Tightly packed RGBA, which is what Kitty's `f=32` reads. Row padding is dropped and
/// the channels are moved into place in the same pass.
pub(crate) fn pack_rgba(capture: &Capture) -> Option<Vec<u8>> {
    let width = capture.width as usize;
    let height = capture.height as usize;
    let row_bytes = width.checked_mul(4)?;
    if capture.bytes_per_row < row_bytes
        || capture.bytes.len()
            < capture.bytes_per_row.checked_mul(height.checked_sub(1)?)? + row_bytes
    {
        return None;
    }
    let (r, g, b, a) = match capture.order {
        ChannelOrder::Rgba => (0, 1, 2, 3),
        ChannelOrder::Bgra => (2, 1, 0, 3),
        ChannelOrder::Argb => (1, 2, 3, 0),
        ChannelOrder::Abgr => (3, 2, 1, 0),
    };
    let mut rgba = Vec::with_capacity(row_bytes * height);
    for row in capture.bytes.chunks(capture.bytes_per_row).take(height) {
        if capture.order == ChannelOrder::Rgba {
            rgba.extend_from_slice(&row[..row_bytes]);
            continue;
        }
        for pixel in row[..row_bytes].as_chunks::<4>().0 {
            rgba.extend_from_slice(&[pixel[r], pixel[g], pixel[b], pixel[a]]);
        }
    }
    Some(rgba)
}

/// A content hash for skipping unchanged frames. SipHash (the std default) runs a 20MB
/// Retina frame at roughly 1GB/s; this word-at-a-time multiply-xor is several times faster,
/// and a collision costs one skipped repaint, not wrong pixels kept on screen for long —
/// the next interaction schedules another snapshot.
pub(crate) fn frame_hash(bytes: &[u8]) -> u64 {
    const K: u64 = 0x517c_c1b7_2722_0a95;
    let mut hash = bytes.len() as u64;
    let (words, remainder) = bytes.as_chunks::<8>();
    for word in words {
        let value = u64::from_le_bytes(*word);
        hash = (hash.rotate_left(5) ^ value).wrapping_mul(K);
    }
    for byte in remainder {
        hash = (hash.rotate_left(5) ^ u64::from(*byte)).wrapping_mul(K);
    }
    hash
}

fn wrap_tmux(sequence: &[u8]) -> Vec<u8> {
    let mut wrapped = Vec::with_capacity(sequence.len() + 16);
    wrapped.extend_from_slice(b"\x1bPtmux;");
    for byte in sequence {
        wrapped.push(*byte);
        if *byte == 0x1b {
            wrapped.push(0x1b);
        }
    }
    wrapped.extend_from_slice(b"\x1b\\");
    wrapped
}

fn kitty_command(header: &str, payload: &[u8]) -> Vec<u8> {
    let mut sequence = Vec::with_capacity(header.len() + payload.len() + 8);
    sequence.extend_from_slice(b"\x1b_G");
    sequence.extend_from_slice(header.as_bytes());
    if !payload.is_empty() {
        sequence.push(b';');
        sequence.extend_from_slice(payload);
    }
    sequence.extend_from_slice(b"\x1b\\");
    sequence
}

fn anchor_tmux_graphics(sequence: &[u8], origin: PaneOrigin) -> Vec<u8> {
    let mut anchored = Vec::with_capacity(sequence.len() + 32);
    anchored.extend_from_slice(b"\x1b7");
    anchored.extend_from_slice(format!("\x1b[{};{}H", origin.top + 1, origin.left + 1).as_bytes());
    anchored.extend_from_slice(sequence);
    anchored.extend_from_slice(b"\x1b8");
    wrap_tmux(&anchored)
}

fn anchor_graphics(sequence: &[u8], pane_origin: Option<PaneOrigin>) -> Vec<u8> {
    if std::env::var_os("TMUX").is_none() {
        return sequence.to_vec();
    }
    pane_origin.map_or_else(
        || wrap_tmux(sequence),
        |origin| anchor_tmux_graphics(sequence, origin),
    )
}

fn write_kitty_delete_to(
    output: &mut impl Write,
    image_id: u32,
    pane_origin: Option<PaneOrigin>,
) -> io::Result<()> {
    let sequence = kitty_command(&format!("a=d,d=I,i={image_id},q=2"), &[]);
    output.write_all(&anchor_graphics(&sequence, pane_origin))?;
    output.flush()
}

pub(crate) fn write_kitty_delete(image_id: u32, pane_origin: Option<PaneOrigin>) -> io::Result<()> {
    write_kitty_delete_to(&mut io::stdout().lock(), image_id, pane_origin)
}

fn write_chunked_to(
    output: &mut impl Write,
    first_header: &str,
    payload: &[u8],
    pane_origin: Option<PaneOrigin>,
) -> io::Result<()> {
    const CHUNK: usize = 4096;
    let encoded = base64::engine::general_purpose::STANDARD.encode(payload);
    let chunks: Vec<&[u8]> = encoded.as_bytes().chunks(CHUNK).collect();

    for (index, chunk) in chunks.iter().enumerate() {
        let more = if index + 1 < chunks.len() { ",m=1" } else { "" };
        let header = if index == 0 {
            format!("{first_header}{more}")
        } else {
            format!("q=2{more}")
        };
        let sequence = kitty_command(&header, chunk);
        output.write_all(&anchor_graphics(&sequence, pane_origin))?;
    }
    output.flush()
}

fn placement(image_id: u32, cols: u32, rows: u32) -> String {
    format!("a=T,i={image_id},C=1,c={cols},r={rows}")
}

/// Raw pixels through a file, the same medium and format the Electron engine uses for whole
/// frames. The file is renamed into place because the terminal may read it at any moment and
/// a half-written file is a sheared frame.
pub(crate) fn write_kitty_raw_file(
    rgba: &[u8],
    frame: &Frame,
    path: &Path,
    image_id: u32,
    pane_origin: Option<PaneOrigin>,
) -> io::Result<()> {
    let staging = path.with_extension("rgba.tmp");
    fs::write(&staging, rgba)?;
    fs::rename(&staging, path)?;
    let header = format!(
        "{},f=32,s={},v={},t=f,q=2",
        placement(image_id, frame.cols, frame.rows),
        frame.capture.width,
        frame.capture.height
    );
    write_chunked_to(
        &mut io::stdout().lock(),
        &header,
        path.as_os_str().as_encoded_bytes(),
        pane_origin,
    )
}

/// The fallback when frame files cannot be written: PNG inline. Slower to encode and far
/// larger on the wire than the file path, but it needs nothing but the tty.
pub(crate) fn write_kitty_png(
    rgba: &[u8],
    frame: &Frame,
    image_id: u32,
    pane_origin: Option<PaneOrigin>,
) -> io::Result<()> {
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, frame.capture.width, frame.capture.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(io::Error::other)?;
        writer.write_image_data(rgba).map_err(io::Error::other)?;
    }
    let header = format!(
        "{},f=100,t=d,q=2",
        placement(image_id, frame.cols, frame.rows)
    );
    write_chunked_to(&mut io::stdout().lock(), &header, &png, pane_origin)
}

#[cfg(test)]
mod tests {
    use super::{
        anchor_tmux_graphics, frame_hash, kitty_command, pack_rgba, wrap_tmux, Capture,
        ChannelOrder, PaneOrigin,
    };

    fn capture(bytes: Vec<u8>, bytes_per_row: usize, order: ChannelOrder) -> Capture {
        Capture {
            bytes,
            width: 2,
            height: 2,
            bytes_per_row,
            order,
        }
    }

    #[test]
    fn packs_bgra_with_row_padding_into_rgba() {
        // Two rows of two pixels, each row padded to 12 bytes the way CoreGraphics aligns rows.
        let bytes = vec![
            3, 2, 1, 255, 13, 12, 11, 255, 0, 0, 0, 0, //
            23, 22, 21, 255, 33, 32, 31, 255, 9, 9, 9, 9,
        ];
        let rgba = pack_rgba(&capture(bytes, 12, ChannelOrder::Bgra)).unwrap();
        assert_eq!(
            rgba,
            vec![1, 2, 3, 255, 11, 12, 13, 255, 21, 22, 23, 255, 31, 32, 33, 255]
        );
    }

    #[test]
    fn packs_alpha_first_layouts() {
        let argb = capture([255, 1, 2, 3].repeat(4), 8, ChannelOrder::Argb);
        assert_eq!(&pack_rgba(&argb).unwrap()[..4], &[1, 2, 3, 255]);
        let abgr = capture([255, 3, 2, 1].repeat(4), 8, ChannelOrder::Abgr);
        assert_eq!(&pack_rgba(&abgr).unwrap()[..4], &[1, 2, 3, 255]);
    }

    #[test]
    fn refuses_a_capture_shorter_than_its_geometry() {
        assert!(pack_rgba(&capture(vec![0; 15], 8, ChannelOrder::Rgba)).is_none());
        assert!(pack_rgba(&capture(vec![0; 16], 4, ChannelOrder::Rgba)).is_none());
    }

    #[test]
    fn frame_hash_sees_a_single_changed_pixel() {
        let mut pixels = vec![7u8; 4096 + 3];
        let before = frame_hash(&pixels);
        pixels[4096 + 2] = 8;
        assert_ne!(before, frame_hash(&pixels));
        pixels[4096 + 2] = 7;
        assert_eq!(before, frame_hash(&pixels));
    }

    #[test]
    fn anchors_kitty_graphics_at_tmux_pane_origin() {
        let command = kitty_command("a=T,i=9,q=2", b"YWJj");
        let anchored = anchor_tmux_graphics(&command, PaneOrigin { left: 7, top: 3 });
        let mut expected = b"\x1b7\x1b[4;8H".to_vec();
        expected.extend_from_slice(&command);
        expected.extend_from_slice(b"\x1b8");
        assert_eq!(anchored, wrap_tmux(&expected));
        assert!(anchored
            .windows(9)
            .any(|window| window == b"[4;8H\x1b\x1b_G"));
    }

    #[test]
    fn wraps_every_inner_escape_for_tmux_passthrough() {
        let wrapped = wrap_tmux(b"\x1b_Gq=2;abc\x1b\\");
        assert_eq!(wrapped, b"\x1bPtmux;\x1b\x1b_Gq=2;abc\x1b\x1b\\\x1b\\");
    }
}
