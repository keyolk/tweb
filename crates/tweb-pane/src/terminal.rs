//! Terminal capability negotiation.
//!
//! DESIGN.md 섹션 5.2, 7.3. Kitty graphics query(`a=q` + `ESC[c`)로 지원 판정.
//! terminal 이름으로 추측하지 않고 graphics query로 판정.
//!
//! cliweb 방식: passthrough 없이 직접 stdout에 Kitty graphics.
//! tmux 3.5a allow-passthrough all이 Kitty graphics를 자동으로 통과시킴.

use anyhow::Result;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use tweb_core::frame::TerminalCapability;
use tweb_core::geometry::PixelSize;

/// PTY가 보고하는 현재 pane 크기.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowSize {
    pub cols: u16,
    pub rows: u16,
    pub width: u16,
    pub height: u16,
}

/// 현재 pane의 크기와 tmux client 기준 좌상단 cell 좌표.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowGeometry {
    pub size: WindowSize,
    pub origin: Option<(u32, u32)>,
}

/// 현재 pane geometry를 조회한다. tmux 안에서는 크기와 origin을 한 번에 읽어
/// resize 중 값의 race를 피하고, PTY 크기가 그대로인 pane 이동도 감지한다.
pub fn window_geometry() -> Option<WindowGeometry> {
    if let Some(geometry) = query_tmux_window_geometry() {
        return Some(geometry);
    }

    let fd = io::stdin().as_raw_fd();
    let mut size = unsafe { std::mem::zeroed::<libc::winsize>() };
    if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) } != 0 {
        return None;
    }
    if size.ws_col == 0 || size.ws_row == 0 {
        return None;
    }

    Some(WindowGeometry {
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
        origin: None,
    })
}

pub fn window_size() -> Option<WindowSize> {
    window_geometry().map(|geometry| geometry.size)
}

fn parse_tmux_window_geometry(value: &str) -> Option<WindowGeometry> {
    let mut fields = value.split_whitespace();
    let cols = fields.next()?.parse::<u16>().ok()?;
    let rows = fields.next()?.parse::<u16>().ok()?;
    let cell_width = fields.next()?.parse::<f64>().ok()?;
    let cell_height = fields.next()?.parse::<f64>().ok()?;
    let left = fields.next()?.parse::<u32>().ok()?;
    let top = fields.next()?.parse::<u32>().ok()?;
    if fields.next().is_some()
        || cols == 0
        || rows == 0
        || !cell_width.is_finite()
        || !cell_height.is_finite()
        || cell_width <= 0.0
        || cell_height <= 0.0
    {
        return None;
    }
    let width = (f64::from(cols) * cell_width).round();
    let height = (f64::from(rows) * cell_height).round();
    if width < 1.0 || height < 1.0 || width > f64::from(u16::MAX) || height > f64::from(u16::MAX) {
        return None;
    }
    Some(WindowGeometry {
        size: WindowSize {
            cols,
            rows,
            width: width as u16,
            height: height as u16,
        },
        origin: Some((left, top)),
    })
}

fn query_tmux_window_geometry() -> Option<WindowGeometry> {
    let pane = std::env::var("TMUX_PANE").ok()?;
    let output = std::process::Command::new("tmux")
        .args([
            "display-message",
            "-p",
            "-t",
            &pane,
            "#{pane_width} #{pane_height} #{client_cell_width} #{client_cell_height} #{pane_left} #{pane_top}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_tmux_window_geometry(&String::from_utf8_lossy(&output.stdout))
}

/// tmux client 기준 pane 좌상단 cell 좌표를 반환한다.
pub fn tmux_pane_origin() -> Option<(u32, u32)> {
    window_geometry()?.origin
}

/// 원래 termios 상태. Drop에서 원복.
struct OriginalTermios {
    fd: i32,
    termios: libc::termios,
}

/// raw terminal mode guard. 종료 시 원복.
pub struct RawModeGuard {
    original: Option<OriginalTermios>,
}

impl RawModeGuard {
    /// raw terminal mode 진입.
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

/// browser pane 입력 mode. mouse와 modified-key reporting을 활성화하고 Drop에서 복원한다.
pub struct InputModeGuard {
    inside_tmux: bool,
}

impl InputModeGuard {
    pub fn enter() -> Self {
        let inside_tmux = std::env::var_os("TMUX").is_some();
        let stdout = io::stdout();
        let mut lock = stdout.lock();
        // Focus reporting(1004)은 tmux window 전환 시 ESC[I/ESC[O가 다른 pane의
        // shell로 새어 나갈 수 있으므로 사용하지 않는다.
        let _ =
            lock.write_all(b"\x1b[?1004l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1016h");
        if inside_tmux {
            // tmux가 추적하는 modifyOtherKeys mode 2를 요청한다. tmux는 이를
            // pane_key_mode=Ext 2로 기록하고 terminal protocol을 client별로
            // 동기화한다. Kitty CSI > ... u를 tmux 너머 terminal에 직접 보내면
            // tmux는 VT10x로 남은 채 Ghostty만 Kitty mode가 되어 입력이 막힌다.
            let _ = lock.write_all(b"\x1b[>4;2m");
        } else {
            // tmux 밖에서는 Kitty flags 1|2|4|8을 직접 사용할 수 있다.
            let _ = lock.write_all(b"\x1b[>15u");
        }
        let _ = lock.flush();
        Self { inside_tmux }
    }
}

/// tmux가 추적하는 modified-key mode를 PTY stdout에서 재선언한다.
/// native DevTools 같은 보조 window가 terminal mode를 reset한 경우 사용한다.
pub fn restore_tracked_keyboard_mode() {
    if std::env::var_os("TMUX").is_none() {
        return;
    }
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    // tmux가 pane mode로 추적하는 sequence만 단독으로 출력한다. Kitty
    // reset을 같은 write에 섞으면 일부 tmux parser 경로에서 뒤 sequence까지
    // VT10x input으로 취급할 수 있다.
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
        let _ = lock.flush();
    }
}

/// terminal mode 설정 (cliweb output.ts 방식).
/// alternate screen, mouse SGR pixel, auto wrap, clear.
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

/// terminal 복원.
pub fn terminal_cleanup() {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    // alternate screen 복원.
    let _ = lock.write_all(b"\x1b[?1049l");
    let _ = lock.flush();
}

/// terminal capability 탐지.
pub fn detect_capability() -> Result<TerminalCapability> {
    let has_kitty = query_kitty_graphics();
    let pixel_size = query_pixel_size();

    Ok(TerminalCapability {
        kitty_graphics: has_kitty,
        kitty_animation: false,
        kitty_placement: false,
        kitty_shared_memory: false,
        pixel_mouse: false,
        extended_keyboard: false,
        pixel_size,
        cell_size: query_cell_size(),
    })
}

/// Kitty graphics query 전송, 응답 확인.
/// passthrough 없이 직접 전송 (cliweb 방식).
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

/// terminal pixel size query (CSI 14t).
pub fn query_pixel_size() -> Option<PixelSize> {
    if std::env::var("TMUX").is_ok() {
        return query_tmux_pixel_size();
    }
    None // TODO: 직접 CSI 14t query.
}

/// tmux pane pixel size query.
fn query_tmux_pixel_size() -> Option<PixelSize> {
    let pane = std::env::var("TMUX_PANE").ok()?;
    let output = std::process::Command::new("tmux")
        .args([
            "display-message",
            "-p",
            "-t",
            &pane,
            "#{pane_width} #{pane_height}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<u32> = line
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
    if parts.len() < 2 {
        return None;
    }
    let cols = parts[0];
    let rows = parts[1];
    let (cell_w, cell_h) = query_cell_size().unwrap_or((8, 16));
    Some(PixelSize::new(cols * cell_w, rows * cell_h))
}

/// cell size query (CSI 16t). TODO: 실제 query.
pub fn query_cell_size() -> Option<(u32, u32)> {
    None
}

#[cfg(test)]
mod tests {
    use super::{parse_tmux_window_geometry, WindowGeometry, WindowSize};

    #[test]
    fn parses_fractional_tmux_cell_size_and_origin() {
        assert_eq!(
            parse_tmux_window_geometry("145 83 7.5 12 102 4\n"),
            Some(WindowGeometry {
                size: WindowSize {
                    cols: 145,
                    rows: 83,
                    width: 1088,
                    height: 996,
                },
                origin: Some((102, 4)),
            })
        );
    }

    #[test]
    fn parses_integer_tmux_cell_size_and_origin() {
        assert_eq!(
            parse_tmux_window_geometry("160 40 6 12 0 42"),
            Some(WindowGeometry {
                size: WindowSize {
                    cols: 160,
                    rows: 40,
                    width: 960,
                    height: 480,
                },
                origin: Some((0, 42)),
            })
        );
    }

    #[test]
    fn rejects_invalid_tmux_window_geometry() {
        assert_eq!(parse_tmux_window_geometry("0 40 7.5 12 0 0"), None);
        assert_eq!(parse_tmux_window_geometry("80 24 nan 12 0 0"), None);
        assert_eq!(parse_tmux_window_geometry("80 24 7.5 12"), None);
    }
}
