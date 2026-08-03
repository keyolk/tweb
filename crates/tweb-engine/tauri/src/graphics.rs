use base64::Engine as _;
use std::io::{self, Write};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PaneOrigin {
    pub left: u32,
    pub top: u32,
}

pub(crate) struct Frame {
    pub png: Vec<u8>,
    pub cols: u32,
    pub rows: u32,
    pub generation: u64,
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

fn write_kitty_png_to(
    output: &mut impl Write,
    frame: &Frame,
    image_id: u32,
    pane_origin: Option<PaneOrigin>,
) -> io::Result<()> {
    const CHUNK: usize = 4096;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&frame.png);
    let chunks: Vec<&[u8]> = encoded.as_bytes().chunks(CHUNK).collect();

    for (index, chunk) in chunks.iter().enumerate() {
        let more = index + 1 < chunks.len();
        let header = if index == 0 {
            format!(
                "a=T,f=100,i={image_id},C=1,c={},r={},t=d,q=2{}",
                frame.cols,
                frame.rows,
                if more { ",m=1" } else { "" }
            )
        } else {
            format!("q=2{}", if more { ",m=1" } else { "" })
        };
        let sequence = kitty_command(&header, chunk);
        output.write_all(&anchor_graphics(&sequence, pane_origin))?;
    }
    output.flush()
}

pub(crate) fn write_kitty_png(
    frame: &Frame,
    image_id: u32,
    pane_origin: Option<PaneOrigin>,
) -> io::Result<()> {
    write_kitty_png_to(&mut io::stdout().lock(), frame, image_id, pane_origin)
}

#[cfg(test)]
mod tests {
    use super::{anchor_tmux_graphics, kitty_command, wrap_tmux, PaneOrigin};

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
