//! Terminal capability negotiation.
//!
//! DESIGN.md sections 5.2 and 7.3. Support is decided by the Kitty graphics query
//! (`a=q` + `ESC[c`) — by the query, never guessed from the terminal name.
//!
//! The cliweb approach: Kitty graphics straight to stdout, no passthrough.
//! tmux 3.5a allow-passthrough all lets Kitty graphics through on its own.

use anyhow::Result;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use tweb_core::frame::TerminalCapability;
use tweb_core::geometry::PixelSize;

/// The current pane size as reported by the PTY.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowSize {
    pub cols: u16,
    pub rows: u16,
    pub width: u16,
    pub height: u16,
}

/// The current pane's size plus its top-left cell coordinate in tmux client space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowGeometry {
    pub size: WindowSize,
    pub origin: Option<(u32, u32)>,
}

/// Queries the current pane geometry. Inside tmux, size and origin are read in one shot to
/// avoid racing values mid-resize, and to catch pane moves that leave the PTY size unchanged.
pub fn window_geometry() -> Option<WindowGeometry> {
    let tmux = query_tmux_window_geometry();
    if let Some(geometry) = tmux {
        if geometry.size.width > 0 && geometry.size.height > 0 {
            return Some(geometry);
        }
    }

    let fd = io::stdin().as_raw_fd();
    let mut size = unsafe { std::mem::zeroed::<libc::winsize>() };
    if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) } != 0 {
        return None;
    }
    if size.ws_col == 0 || size.ws_row == 0 {
        return None;
    }

    let origin = tmux.and_then(|geometry| geometry.origin);
    Some(WindowGeometry {
        origin,
        size: WindowSize {
            cols: size.ws_col,
            rows: size.ws_row,
            width: if size.ws_xpixel > 0 {
                size.ws_xpixel
            } else {
                size.ws_col.saturating_mul(8)
            },
            height: if size.ws_ypixel > 0 {
                size.ws_ypixel
            } else {
                size.ws_row.saturating_mul(16)
            },
        },
    })
}

pub fn window_size() -> Option<WindowSize> {
    window_geometry().map(|geometry| geometry.size)
}

fn tmux_query(pane: &str, format: &str) -> Option<String> {
    let output = std::process::Command::new("tmux")
        .args(["display-message", "-p", "-t", pane, format])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        return None;
    }
    Some(value)
}

fn tmux_pane_placement(pane: &str) -> Option<(u16, u16, u32, u32)> {
    let output = std::process::Command::new("tmux")
        .args([
            "list-panes",
            "-a",
            "-F",
            "#{pane_id} #{pane_width} #{pane_height} #{pane_left} #{pane_top}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_pane_placement(pane, &String::from_utf8_lossy(&output.stdout))
}

fn parse_pane_placement(pane: &str, listing: &str) -> Option<(u16, u16, u32, u32)> {
    for line in listing.lines() {
        let mut fields = line.split_whitespace();
        if fields.next() != Some(pane) {
            continue;
        }
        let cols = fields.next()?.parse::<u16>().ok()?;
        let rows = fields.next()?.parse::<u16>().ok()?;
        let left = fields.next()?.parse::<u32>().ok()?;
        let top = fields.next()?.parse::<u32>().ok()?;
        if cols == 0 || rows == 0 {
            return None;
        }
        return Some((cols, rows, left, top));
    }
    None
}

fn parse_pane_geometry(value: &str) -> Option<WindowGeometry> {
    let mut fields = value.split_whitespace();
    let cols = fields.next()?.parse::<u16>().ok()?;
    let rows = fields.next()?.parse::<u16>().ok()?;
    let left = fields.next()?.parse::<u32>().ok()?;
    let top = fields.next()?.parse::<u32>().ok()?;
    if cols == 0 || rows == 0 {
        return None;
    }
    let (width, height) = fields
        .next()
        .zip(fields.next())
        .and_then(|(w, h)| pixel_size_from_cells(cols, rows, &format!("{w} {h}")))
        .unwrap_or((0, 0));
    Some(WindowGeometry {
        size: WindowSize {
            cols,
            rows,
            width,
            height,
        },
        origin: Some((left, top)),
    })
}

fn query_tmux_window_geometry() -> Option<WindowGeometry> {
    let pane = std::env::var("TMUX_PANE").ok()?;

    // Every tmux call costs ~9ms, and this runs on the resize path where the pane
    // shows the terminal until the new geometry reaches the engine — so ask for
    // placement and cell size together and settle for one round trip.
    if let Some(geometry) = tmux_query(
        &pane,
        "#{pane_width} #{pane_height} #{pane_left} #{pane_top} \
         #{client_cell_width} #{client_cell_height}",
    )
    .as_deref()
    .and_then(parse_pane_geometry)
    {
        return Some(geometry);
    }

    // `display-message` resolves against a target client and fails outright when
    // none is attached — which used to cost us the pane origin as well, leaving a
    // moved pane drawing at its old anchor. `list-panes` needs no client.
    let (cols, rows, left, top) = tmux_pane_placement(&pane)?;

    let cells = tmux_query(&pane, "#{client_cell_width} #{client_cell_height}");
    let (width, height) = cells
        .and_then(|value| pixel_size_from_cells(cols, rows, &value))
        .unwrap_or((0, 0));

    Some(WindowGeometry {
        size: WindowSize {
            cols,
            rows,
            width,
            height,
        },
        origin: Some((left, top)),
    })
}

fn pixel_size_from_cells(cols: u16, rows: u16, value: &str) -> Option<(u16, u16)> {
    let mut fields = value.split_whitespace();
    let cell_width = fields.next()?.parse::<f64>().ok()?;
    let cell_height = fields.next()?.parse::<f64>().ok()?;
    let width = (f64::from(cols) * cell_width).round();
    let height = (f64::from(rows) * cell_height).round();
    if !cell_width.is_finite()
        || !cell_height.is_finite()
        || cell_width <= 0.0
        || cell_height <= 0.0
        || width < 1.0
        || height < 1.0
        || width > f64::from(u16::MAX)
        || height > f64::from(u16::MAX)
    {
        return None;
    }
    Some((width as u16, height as u16))
}

/// Returns the pane's top-left cell coordinate in tmux client space.
pub fn tmux_pane_origin() -> Option<(u32, u32)> {
    window_geometry()?.origin
}

/// The original termios state. Restored on Drop.
struct OriginalTermios {
    fd: i32,
    termios: libc::termios,
}

/// Raw terminal mode guard. Restores on exit.
pub struct RawModeGuard {
    original: Option<OriginalTermios>,
}

impl RawModeGuard {
    /// Enters raw terminal mode.
    pub fn enter() -> Result<Self> {
        let fd = io::stdin().as_raw_fd();

        let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
        let rc = unsafe { libc::tcgetattr(fd, &mut original) };
        if rc != 0 {
            return Ok(Self { original: None });
        }

        let mut raw = original;
        unsafe { libc::cfmakeraw(&mut raw) };
        let rc = unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) };
        if rc != 0 {
            return Ok(Self { original: None });
        }

        Ok(Self {
            original: Some(OriginalTermios {
                fd,
                termios: original,
            }),
        })
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        if let Some(orig) = &self.original {
            unsafe {
                libc::tcsetattr(orig.fd, libc::TCSANOW, &orig.termios);
            }
        }
    }
}

/// Browser pane input mode. Enables mouse and modified-key reporting, restoring both on Drop.
pub struct InputModeGuard {
    inside_tmux: bool,
}

impl InputModeGuard {
    pub fn enter() -> Self {
        let inside_tmux = std::env::var_os("TMUX").is_some();
        let stdout = io::stdout();
        let mut lock = stdout.lock();
        // Focus reporting (1004) is left off: on a tmux window switch its ESC[I/ESC[O can
        // leak into another pane's shell.
        let _ =
            lock.write_all(b"\x1b[?1004l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1016h");
        // Bracketed paste (2004) is the only path by which Cmd-V reaches the page.
        // Ghostty produces no PTY encoding for Cmd combinations, but
        // paste_from_clipboard writes the clipboard content through as is. Only
        // with 2004 on do tmux and Ghostty wrap it in ESC[200~ ... ESC[201~, which
        // is what lets the engine see the boundaries and handle it as one paste.
        let _ = lock.write_all(b"\x1b[?2004h");
        if inside_tmux {
            // Ask for modifyOtherKeys mode 2, which tmux tracks: it records this as
            // pane_key_mode=Ext 2 and keeps the terminal protocol in sync per client.
            // Sending Kitty CSI > ... u straight through tmux to the terminal leaves tmux
            // on VT10x while only Ghostty switches to Kitty mode, and input stops working.
            let _ = lock.write_all(b"\x1b[>4;2m");
        } else {
            // Outside tmux, Kitty flags 1|2|4|8 can be used directly.
            let _ = lock.write_all(b"\x1b[>15u");
        }
        let _ = lock.flush();
        Self { inside_tmux }
    }
}

/// Re-declares the modified-key mode tmux tracks on the PTY stdout.
/// Used when an auxiliary window such as the native DevTools reset the terminal modes.
pub fn restore_tracked_keyboard_mode() {
    if std::env::var_os("TMUX").is_none() {
        return;
    }
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    // Emit only the sequence tmux tracks as a pane mode, on its own. Mixing a Kitty reset
    // into the same write can make some tmux parser paths treat the trailing sequence as
    // VT10x input too.
    let _ = lock.write_all(b"\x1b[>4;2m");
    let _ = lock.flush();
}

impl Drop for InputModeGuard {
    fn drop(&mut self) {
        let stdout = io::stdout();
        let mut lock = stdout.lock();
        if self.inside_tmux {
            let _ = lock.write_all(b"\x1b[>4;0m");
        } else {
            let _ = lock.write_all(b"\x1b[<1u");
        }
        let _ =
            lock.write_all(b"\x1b[?1004l\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
        let _ = lock.write_all(b"\x1b[?2004l");
        let _ = lock.flush();
    }
}

/// Terminal mode setup (the cliweb output.ts approach).
/// alternate screen, mouse SGR pixel, auto wrap, clear.
/// alternate screen.
///
/// `tweb open` starts inside the pane the user was already working in. The shell prompt and
/// output left in that pane were hidden while the page image sat **above** the text, but they
/// show through the page once the image moved below it. Entering the alternate screen starts
/// from a blank screen, and leaving it brings the user's screen back untouched.
pub struct ScreenGuard;

impl ScreenGuard {
    pub fn enter() -> Self {
        // Escape hatch for comparing against the pre-alternate-screen behaviour.
        if std::env::var("TWEB_NO_ALT_SCREEN").is_err() {
            terminal_setup();
        }
        Self
    }
}

impl Drop for ScreenGuard {
    fn drop(&mut self) {
        if std::env::var("TWEB_NO_ALT_SCREEN").is_err() {
            terminal_cleanup();
        }
    }
}

pub fn terminal_setup() {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    // alternate screen.
    let _ = lock.write_all(b"\x1b[?1049h");
    // mouse SGR pixel.
    let _ = lock.write_all(b"\x1b[?1016h");
    // auto wrap.
    let _ = lock.write_all(b"\x1b[?7h");
    // clear screen.
    let _ = lock.write_all(b"\x1b[2J");
    // cursor home.
    let _ = lock.write_all(b"\x1b[H");
    let _ = lock.flush();
}

/// Restores the terminal.
pub fn terminal_cleanup() {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    // Leave the alternate screen.
    let _ = lock.write_all(b"\x1b[?1049l");
    let _ = lock.flush();
}

/// Detects terminal capabilities.
///
/// Runs before the input loop takes stdin, so the interactive probe is allowed here.
/// Inside tmux the pane's own geometry wins: CSI 14t describes the whole terminal
/// window, and the pane is only a part of it.
pub fn detect_capability() -> Result<TerminalCapability> {
    let has_kitty = query_kitty_graphics();
    let probe = probe_terminal_pixels();

    Ok(TerminalCapability {
        kitty_graphics: has_kitty,
        kitty_animation: false,
        kitty_placement: false,
        kitty_shared_memory: false,
        pixel_mouse: false,
        extended_keyboard: false,
        pixel_size: query_pixel_size().or(probe.pixel_size),
        cell_size: query_cell_size().or(probe.cell_size),
    })
}

/// Sends the Kitty graphics query and checks the response.
/// Sent directly, without passthrough (the cliweb approach).
fn query_kitty_graphics() -> bool {
    let query = b"\x1b_Ga=q\x1b\\";

    let fd = io::stdin().as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return false;
    }
    let saved_flags = flags;
    unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };

    {
        let stdout = io::stdout();
        let mut lock = stdout.lock();
        let _ = lock.write_all(query);
        let _ = lock.flush();
    }

    std::thread::sleep(std::time::Duration::from_millis(50));

    let mut buf = [0u8; 256];
    let mut stdin = io::stdin();
    let n = stdin.read(&mut buf).unwrap_or(0);

    unsafe { libc::fcntl(fd, libc::F_SETFL, saved_flags) };

    buf[..n].windows(3).any(|w| w == b"Gi=")
}

/// The pane's pixel size.
///
/// Never reads stdin, so it is safe to call while the input loop owns it — which is
/// what the resize path does. Inside tmux the pane's cells are scaled by the client
/// cell size; outside it the PTY's `ws_xpixel`/`ws_ypixel` answer. The interactive
/// CSI 14t probe belongs to one-shot contexts only: see [`probe_terminal_pixels`].
pub fn query_pixel_size() -> Option<PixelSize> {
    let size = window_geometry()?.size;
    if size.width == 0 || size.height == 0 {
        return None;
    }
    Some(PixelSize::new(
        u32::from(size.width),
        u32::from(size.height),
    ))
}

/// The cell size as tmux reports it for the attached client. No stdin, same reason.
pub fn query_cell_size() -> Option<(u32, u32)> {
    let pane = std::env::var("TMUX_PANE").ok()?;
    let value = tmux_query(&pane, "#{client_cell_width} #{client_cell_height}")?;
    // Reuse the cell scaler on a 1x1 pane: it already rejects nan, zero and negatives.
    let (width, height) = pixel_size_from_cells(1, 1, &value)?;
    Some((u32::from(width), u32::from(height)))
}

/// What the terminal answered to the pixel-size probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PixelProbe {
    /// The window's pixel size, from CSI 14t.
    pub pixel_size: Option<PixelSize>,
    /// One cell's pixel size, from CSI 16t.
    pub cell_size: Option<(u32, u32)>,
}

/// Asks the terminal for its pixel size (CSI 14t) and cell size (CSI 16t).
///
/// This reads stdin, so it may only run in a one-shot context — `tweb doctor`, or
/// capability detection before the input loop starts. Calling it once the input loop
/// owns stdin would race it and swallow the user's keystrokes.
///
/// The queries are followed by DA1 (`ESC[c`). Terminals answer in order and every one
/// of them answers DA1, so a DA reply with no `t` reply ahead of it means "not
/// supported" rather than "too slow" — no fixed sleep needed, and nothing is left
/// unread to leak onto the shell prompt after we exit.
pub fn probe_terminal_pixels() -> PixelProbe {
    let Some(response) = query_with_da1(b"\x1b[14t\x1b[16t\x1b[c") else {
        return PixelProbe::default();
    };
    parse_pixel_probe(&response)
}

/// Writes `query` and reads the reply up to the terminating DA1 response.
fn query_with_da1(query: &[u8]) -> Option<Vec<u8>> {
    let fd = io::stdin().as_raw_fd();
    if unsafe { libc::isatty(fd) } != 1 {
        return None;
    }

    // Without raw mode the reply is line buffered and echoed back at the user.
    let _raw = RawModeGuard::enter().ok()?;

    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return None;
    }
    unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };

    {
        let stdout = io::stdout();
        let mut lock = stdout.lock();
        let _ = lock.write_all(query);
        let _ = lock.flush();
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
    let mut response = Vec::new();
    let mut chunk = [0u8; 256];
    let mut stdin = io::stdin();
    while std::time::Instant::now() < deadline {
        match stdin.read(&mut chunk) {
            Ok(0) => {}
            Ok(n) => {
                response.extend_from_slice(&chunk[..n]);
                if has_da1_reply(&response) {
                    break;
                }
                continue;
            }
            Err(_) => {}
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }

    unsafe { libc::fcntl(fd, libc::F_SETFL, flags) };
    Some(response)
}

/// Whether the buffer holds a complete DA1 reply (`ESC [ ? ... c`).
fn has_da1_reply(response: &[u8]) -> bool {
    let mut rest = response;
    while let Some(start) = rest.windows(3).position(|w| w == b"\x1b[?") {
        let tail = &rest[start + 3..];
        if tail.contains(&b'c') {
            return true;
        }
        rest = tail;
    }
    false
}

/// Reads the XTWINOPS replies out of a probe response.
///
/// `ESC [ 4 ; height ; width t` is the window size and `ESC [ 6 ; height ; width t`
/// the cell size — height first in both, which is the opposite of every other size
/// in this codebase.
fn parse_pixel_probe(response: &[u8]) -> PixelProbe {
    let mut probe = PixelProbe::default();
    let text = String::from_utf8_lossy(response);
    for report in text.split('\u{1b}') {
        let Some(body) = report.strip_prefix('[') else {
            continue;
        };
        let Some(body) = body.split('t').next() else {
            continue;
        };
        let mut fields = body.split(';');
        let kind = fields.next().unwrap_or_default();
        let Some(height) = fields
            .next()
            .and_then(|value| value.trim().parse::<u32>().ok())
        else {
            continue;
        };
        let Some(width) = fields
            .next()
            .and_then(|value| value.trim().parse::<u32>().ok())
        else {
            continue;
        };
        if fields.next().is_some() || width == 0 || height == 0 {
            continue;
        }
        match kind {
            "4" => probe.pixel_size = Some(PixelSize::new(width, height)),
            "6" => probe.cell_size = Some((width, height)),
            _ => {}
        }
    }
    probe
}

/// Asks the terminal whether it speaks the Kitty graphics protocol.
///
/// Separate from [`detect_capability`]'s `query_kitty_graphics` because that one cannot be
/// used as a gate: it sends a bare `a=q` with no payload and waits a fixed 50ms. Measured
/// against a real Ghostty on a bare tty, that form draws no reply at all — the terminal
/// answers a payload-carrying query in 0.2ms and ignores the bare one — so it reports "no
/// graphics" on every terminal in every context. Sending an id and a one-pixel payload is
/// what makes the reply mandatory and self-identifying (`Gi=31;...`).
///
/// Only ever queries on a bare tty. Inside tmux the answer cannot come back at all (see
/// [`crate::graphics`]), so nothing is sent: an APC query whose reply tmux swallows leaves
/// bytes on the wire for no possible benefit.
pub fn probe_graphics_support() -> crate::graphics::GraphicsSupport {
    use crate::graphics::GraphicsSupport;

    if std::env::var_os("TMUX").is_some() {
        return GraphicsSupport::Unknown;
    }
    // A one-pixel RGB payload: `a=q` validates and answers without storing an image, so
    // there is nothing to clean up afterwards.
    let Some(response) = query_with_da1(b"\x1b_Ga=q,i=31,s=1,v=1,f=24;AAAA\x1b\\\x1b[c") else {
        return GraphicsSupport::Unknown;
    };
    classify_graphics_reply(&response)
}

/// Reads a graphics verdict out of a probe response.
///
/// The DA1 reply is what separates "no" from "too slow": every terminal answers it, and it
/// is sent after the graphics reply. So a complete DA1 with no graphics reply ahead of it
/// means the terminal was listening and had nothing to say, while no DA1 at all means the
/// probe simply did not get an answer and nothing may be concluded.
///
/// Any `_G` reply counts as support, including an error such as `Gi=31;ENOENT`. A terminal
/// that can report a protocol error is a terminal that parsed the protocol.
pub fn classify_graphics_reply(response: &[u8]) -> crate::graphics::GraphicsSupport {
    use crate::graphics::GraphicsSupport;

    if response.windows(3).any(|window| window == b"\x1b_G") {
        return GraphicsSupport::Supported;
    }
    if has_da1_reply(response) {
        return GraphicsSupport::Unsupported;
    }
    GraphicsSupport::Unknown
}

#[cfg(test)]
mod tests {
    use super::{
        classify_graphics_reply, has_da1_reply, parse_pane_geometry, parse_pane_placement,
        parse_pixel_probe, pixel_size_from_cells,
    };
    use crate::graphics::GraphicsSupport;
    use tweb_core::geometry::PixelSize;

    /// The three byte strings below were captured from real terminals rather than written
    /// from the specification, because the specification is what the shipping bare-`a=q`
    /// probe was written against and it never worked.
    #[test]
    fn classifies_the_replies_real_terminals_actually_sent() {
        // Ghostty 1.3.1 on a bare tty: the graphics reply, then DA1.
        assert_eq!(
            classify_graphics_reply(b"\x1b_Gi=31;OK\x1b\\\x1b[?62;22;52c"),
            GraphicsSupport::Supported
        );
        // Apple Terminal on a bare tty: DA1 alone. It was listening, and it cannot draw.
        assert_eq!(
            classify_graphics_reply(b"\x1b[?1;2c"),
            GraphicsSupport::Unsupported
        );
        // Inside tmux 3.5a with a Ghostty client: also DA1 alone, because tmux answers it
        // itself and never forwards the terminal's graphics reply. Identical bytes to the
        // case above, which is exactly why the probe never runs inside tmux.
        assert_eq!(
            classify_graphics_reply(b"\x1b[?1;2;4c"),
            GraphicsSupport::Unsupported
        );
        // Nothing came back: unknowable, never a refusal.
        assert_eq!(classify_graphics_reply(b""), GraphicsSupport::Unknown);
    }

    /// A terminal that answers the graphics query with an error still parsed the protocol,
    /// and half a DA1 is not a verdict — it is a read that ended early.
    #[test]
    fn an_error_reply_still_proves_support_and_a_partial_da1_proves_nothing() {
        assert_eq!(
            classify_graphics_reply(b"\x1b_Gi=31;ENOENT:bad\x1b\\\x1b[?62;c"),
            GraphicsSupport::Supported
        );
        assert_eq!(
            classify_graphics_reply(b"\x1b[?62;22"),
            GraphicsSupport::Unknown
        );
    }

    /// The pane's own row picks out its placement; a sibling's must not.
    #[test]
    fn reads_this_panes_placement_from_the_listing() {
        let listing = "%0 180 5 0 0\n%1 180 17 0 6\n%2 90 17 181 6\n";
        assert_eq!(parse_pane_placement("%1", listing), Some((180, 17, 0, 6)));
        assert_eq!(parse_pane_placement("%2", listing), Some((90, 17, 181, 6)));
        assert_eq!(parse_pane_placement("%9", listing), None);
    }

    #[test]
    fn reads_placement_and_cell_size_from_one_query() {
        let geometry = parse_pane_geometry("166 35 108 0 7 14").expect("geometry");
        assert_eq!(geometry.origin, Some((108, 0)));
        assert_eq!((geometry.size.cols, geometry.size.rows), (166, 35));
        assert_eq!((geometry.size.width, geometry.size.height), (1162, 490));
    }

    #[test]
    fn keeps_the_origin_when_tmux_reports_no_cell_size() {
        // Pixel size then has to come from the ioctl, but losing the origin would
        // leave a moved pane drawing at its old anchor.
        let geometry = parse_pane_geometry("166 35 108 4").expect("geometry");
        assert_eq!(geometry.origin, Some((108, 4)));
        assert_eq!((geometry.size.width, geometry.size.height), (0, 0));
    }

    #[test]
    fn scales_cells_to_pixels() {
        assert_eq!(pixel_size_from_cells(145, 83, "7.5 12"), Some((1088, 996)));
        assert_eq!(pixel_size_from_cells(160, 40, "6 12"), Some((960, 480)));
    }

    /// A detached or pixel-unaware client reports no usable cell size. The pane
    /// origin must survive that, so the caller falls back to the PTY for pixels
    /// instead of discarding the whole reading — without the origin a moved pane
    /// keeps drawing at its old anchor.
    #[test]
    fn refuses_unusable_cell_sizes() {
        for value in ["nan 12", "0 0", "-1 12", "12"] {
            assert_eq!(pixel_size_from_cells(80, 24, value), None, "{value}");
        }
    }

    /// XTWINOPS reports height before width — the opposite of every other size here.
    #[test]
    fn reads_the_xtwinops_replies() {
        let probe = parse_pixel_probe(b"\x1b[4;1050;1680t\x1b[6;28;14t\x1b[?62;c");
        assert_eq!(probe.pixel_size, Some(PixelSize::new(1680, 1050)));
        assert_eq!(probe.cell_size, Some((14, 28)));
    }

    /// A terminal that answers DA but not XTWINOPS is how "unsupported" arrives.
    #[test]
    fn reports_nothing_when_only_da_answers() {
        let probe = parse_pixel_probe(b"\x1b[?62;22c");
        assert_eq!(probe.pixel_size, None);
        assert_eq!(probe.cell_size, None);
    }

    /// A zero or malformed report is no report — a zero size would divide by zero
    /// downstream, and a text report (`ESC[4;...;...;...t`) is not a size at all.
    #[test]
    fn refuses_malformed_reports() {
        for response in [
            &b"\x1b[4;0;1680t"[..],
            &b"\x1b[4;1050;0t"[..],
            &b"\x1b[4;abc;1680t"[..],
            &b"\x1b[4;1050t"[..],
            &b"\x1b[4;1;2;3t"[..],
        ] {
            let probe = parse_pixel_probe(response);
            assert_eq!(
                probe.pixel_size,
                None,
                "{}",
                String::from_utf8_lossy(response)
            );
        }
    }

    /// The DA reply is the read loop's stop signal, so a partial one must not end it.
    #[test]
    fn waits_for_a_complete_da_reply() {
        assert!(has_da1_reply(b"\x1b[?62;22c"));
        assert!(has_da1_reply(b"\x1b[4;1050;1680t\x1b[?6c"));
        assert!(!has_da1_reply(b"\x1b[?62;22"));
        assert!(!has_da1_reply(b"\x1b[4;1050;1680t"));
        // A 'c' before the DA introducer is not the DA terminator.
        assert!(!has_da1_reply(b"c\x1b[?62;22"));
    }
}
