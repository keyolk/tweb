mod browser;
mod frame_rate;
mod graphics;
mod input;
mod preload;
mod session_slot;
mod tmux;

use anyhow::{Context, Result};
use browser::BrowserRuntime;
use clap::{ArgAction, Parser};
use graphics::{
    frame_hash, pack_rgba, write_kitty_delete, write_kitty_png, write_kitty_raw_file, Capture,
    ChannelOrder, Frame, PaneOrigin,
};
use input::{DecodedInput, InputDecoder};
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Debug, Parser)]
#[command(name = "tweb-tauri")]
struct Args {
    /// Maximum active snapshot rate.
    #[arg(long, default_value_t = 30, value_parser = clap::value_parser!(u16).range(1..=60))]
    frame_rate: u16,

    /// Enable activity-aware frame-rate adaptation.
    #[arg(long, action = ArgAction::SetTrue, conflicts_with = "no_adaptive_frame_rate")]
    adaptive_frame_rate: bool,

    /// Disable activity-aware frame-rate adaptation.
    #[arg(long, action = ArgAction::SetTrue)]
    no_adaptive_frame_rate: bool,

    #[arg(default_value = "about:blank")]
    url: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Viewport {
    cols: u32,
    rows: u32,
    width: u32,
    height: u32,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            cols: 100,
            rows: 40,
            width: 1600,
            height: 1200,
        }
    }
}

struct FrameMailbox {
    latest: Mutex<Option<Frame>>,
    ready: Condvar,
}

impl FrameMailbox {
    fn new() -> Self {
        Self {
            latest: Mutex::new(None),
            ready: Condvar::new(),
        }
    }

    fn replace(&self, frame: Frame) {
        if let Ok(mut latest) = self.latest.lock() {
            *latest = Some(frame);
            self.ready.notify_one();
        }
    }

    fn receive(&self) -> Frame {
        let mut latest = self.latest.lock().unwrap();
        loop {
            if let Some(frame) = latest.take() {
                return frame;
            }
            latest = self.ready.wait(latest).unwrap();
        }
    }
}

pub(crate) struct SnapshotState {
    in_flight: AtomicBool,
    snapshot_pending: AtomicBool,
    stopping: AtomicBool,
    terminal_cleaned: AtomicBool,
    last_input_ms: AtomicU64,
    // When the output thread last sent a frame that differed from the one before it, and
    // how large it was; the scheduler reads both to pick the playback rate.
    last_change_ms: AtomicU64,
    frame_bytes: AtomicU64,
    generation: AtomicU64,
    last_hash: Mutex<Option<u64>>,
    viewport: Mutex<Viewport>,
    pane_origin: Mutex<Option<PaneOrigin>>,
    output_gate: Mutex<()>,
    scheduler_generation: Mutex<u64>,
    scheduler_wake: Condvar,
    frames: FrameMailbox,
    image_id: u32,
    frame_path: PathBuf,
}

impl SnapshotState {
    fn wake_scheduler(&self) {
        if let Ok(mut generation) = self.scheduler_generation.lock() {
            *generation = generation.wrapping_add(1);
            self.scheduler_wake.notify_one();
        }
    }

    pub(crate) fn mark_interaction(&self) {
        self.last_input_ms.store(now_ms(), Ordering::Release);
        self.snapshot_pending.store(true, Ordering::Release);
        self.wake_scheduler();
    }

    pub(crate) fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.wake_scheduler();
        if self.terminal_cleaned.swap(true, Ordering::AcqRel) {
            return;
        }
        let Ok(_output) = self.output_gate.lock() else {
            return;
        };
        let origin = self.pane_origin.lock().ok().and_then(|value| *value);
        if let Err(error) = write_kitty_delete(self.image_id, origin) {
            eprintln!("tweb: image delete failed: {error}");
        }
        // After the delete, so the terminal is never told to show a file that is gone.
        let _ = std::fs::remove_file(&self.frame_path);
    }
}

struct SnapshotFlight(Arc<SnapshotState>);

impl Drop for SnapshotFlight {
    fn drop(&mut self) {
        self.0.in_flight.store(false, Ordering::Release);
        if self.0.snapshot_pending.load(Ordering::Acquire) {
            self.0.wake_scheduler();
        }
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn parse_viewport() -> Viewport {
    let Some(value) = std::env::var_os("TWEB_VIEWPORT") else {
        return Viewport::default();
    };
    let values: Vec<u32> = value
        .to_string_lossy()
        .split([',', ' '])
        .filter_map(|part| part.parse().ok())
        .collect();
    if values.len() == 4 && values.iter().all(|value| *value > 0) {
        Viewport {
            cols: values[0],
            rows: values[1],
            width: values[2],
            height: values[3],
        }
    } else {
        Viewport::default()
    }
}

fn parse_pane_origin() -> Option<PaneOrigin> {
    let value = std::env::var_os("TWEB_PANE_ORIGIN")?;
    let values: Vec<u32> = value
        .to_string_lossy()
        .split([',', ' '])
        .filter_map(|part| part.parse().ok())
        .collect();
    match values.as_slice() {
        [left, top] => Some(PaneOrigin {
            left: *left,
            top: *top,
        }),
        _ => None,
    }
}

pub(crate) fn javascript_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

#[cfg(target_os = "macos")]
fn request_snapshot(window: &WebviewWindow, state: Arc<SnapshotState>) {
    use block2::RcBlock;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::WKWebView;

    if state.stopping.load(Ordering::Acquire) {
        return;
    }
    if state.in_flight.swap(true, Ordering::AcqRel) {
        state.snapshot_pending.store(true, Ordering::Release);
        return;
    }
    state.snapshot_pending.store(false, Ordering::Release);
    let generation = state.generation.load(Ordering::Acquire);
    let viewport = *state.viewport.lock().unwrap();
    let callback_state = state.clone();
    if window
        .with_webview(move |platform| unsafe {
            let webview = &*(platform.inner() as *mut WKWebView);
            // This completion runs on the main thread, the same thread that delivers keys and
            // mouse events to the page. It used to re-encode the snapshot TIFF -> PNG here,
            // measured at 37-51ms per 2880x1800 frame, which stalled input for that long on
            // every frame. Now it only copies the CGImage's bytes out (~1.6ms) and leaves every
            // pass over the pixels to the output thread.
            let callback = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let _flight = SnapshotFlight(callback_state.clone());
                if !error.is_null() || image.is_null() {
                    return;
                }
                if callback_state.stopping.load(Ordering::Acquire)
                    || callback_state.generation.load(Ordering::Acquire) != generation
                {
                    return;
                }
                let Some(capture) = capture_pixels(&*image) else {
                    return;
                };
                callback_state.frames.replace(Frame {
                    capture,
                    cols: viewport.cols,
                    rows: viewport.rows,
                    generation,
                });
            });
            webview.takeSnapshotWithConfiguration_completionHandler(None, &callback);
        })
        .is_err()
    {
        state.in_flight.store(false, Ordering::Release);
    }
}

#[cfg(target_os = "macos")]
fn capture_pixels(image: &objc2_app_kit::NSImage) -> Option<Capture> {
    use objc2_core_graphics::{CGDataProvider, CGImage, CGImageAlphaInfo, CGImageByteOrderInfo};

    let image =
        unsafe { image.CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None) }?;
    let image = Some(&*image);
    if CGImage::bits_per_pixel(image) != 32 || CGImage::bits_per_component(image) != 8 {
        return None;
    }
    let alpha_first = match CGImage::alpha_info(image) {
        CGImageAlphaInfo::PremultipliedFirst
        | CGImageAlphaInfo::First
        | CGImageAlphaInfo::NoneSkipFirst => true,
        CGImageAlphaInfo::PremultipliedLast
        | CGImageAlphaInfo::Last
        | CGImageAlphaInfo::NoneSkipLast => false,
        _ => return None,
    };
    let little = CGImage::byte_order_info(image) == CGImageByteOrderInfo::Order32Little;
    let order = match (alpha_first, little) {
        (true, true) => ChannelOrder::Bgra,
        (true, false) => ChannelOrder::Argb,
        (false, true) => ChannelOrder::Abgr,
        (false, false) => ChannelOrder::Rgba,
    };
    let data = CGDataProvider::data(CGImage::data_provider(image).as_deref())?;
    Some(Capture {
        bytes: data.to_vec(),
        width: u32::try_from(CGImage::width(image)).ok()?,
        height: u32::try_from(CGImage::height(image)).ok()?,
        bytes_per_row: CGImage::bytes_per_row(image),
        order,
    })
}

#[cfg(not(target_os = "macos"))]
fn request_snapshot(_window: &WebviewWindow, state: Arc<SnapshotState>) {
    state.in_flight.store(false, Ordering::Release);
}

#[cfg(target_os = "macos")]
pub(crate) fn activate_offscreen_window(window: &WebviewWindow) -> tauri::Result<()> {
    use objc2_app_kit::NSWindow;

    window.with_webview(|platform| unsafe {
        let native_window = &*(platform.ns_window() as *mut NSWindow);
        // WKWebView flips visibility to hidden in an ordered-out window. Keep only the ordered
        // state, as a nearly transparent capture surface that takes no input.
        native_window.orderFrontRegardless();
        native_window.setAlphaValue(0.001);
        native_window.setHasShadow(false);
        native_window.setAcceptsMouseMovedEvents(true);
        native_window.setIgnoresMouseEvents(true);
        native_window.setExcludedFromWindowsMenu(true);
    })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn activate_offscreen_window(_window: &WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

const RAW_FRAME_FAILURE_LIMIT: u32 = 3;
const FRAME_FILE_PREFIX: &str = "tweb-tauri-frame-";

/// Where whole frames are staged for the terminal to read. The pid is in the name so a
/// later engine can tell a dead engine's leftover from a live one's; the image id keeps two
/// panes' files apart. `$TMPDIR` on macOS is per-user and private.
fn frame_file_path(image_id: u32) -> PathBuf {
    std::env::temp_dir().join(format!(
        "{FRAME_FILE_PREFIX}{}-{image_id}.rgba",
        std::process::id()
    ))
}

/// The pid inside a frame file name, for names this engine writes and nothing else.
fn frame_file_owner(name: &str) -> Option<i32> {
    let rest = name.strip_prefix(FRAME_FILE_PREFIX)?;
    let rest = rest
        .strip_suffix(".rgba")
        .or_else(|| rest.strip_suffix(".rgba.tmp"))?;
    let (pid, image_id) = rest.split_once('-')?;
    image_id.parse::<u32>().ok()?;
    pid.parse().ok().filter(|pid| *pid > 0)
}

/// A SIGKILLed engine never reaches `shutdown`, and a 20MB frame file per dead pane adds up.
/// Only files whose owner pid is gone are removed; EPERM means alive.
fn sweep_abandoned_frame_files() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(frame_file_owner) else {
            continue;
        };
        let alive = unsafe { libc::kill(pid, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
        if !alive {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// How long a half-decoded escape sequence waits for its remaining bytes before being
/// flushed as-is.
const ESCAPE_FLUSH: Duration = Duration::from_millis(35);

fn spawn_control_thread(
    app: AppHandle,
    runtime: Arc<BrowserRuntime>,
    state: Arc<SnapshotState>,
    image_id: u32,
) {
    let (lines_tx, lines_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(line) => {
                    if lines_tx.send(line).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    eprintln!("tweb: control input failed: {error}");
                    return;
                }
            }
        }
    });

    std::thread::spawn(move || {
        let mut decoder = InputDecoder::default();
        // When an escape sequence is half-decoded, the rest of it has 35ms to arrive.
        // That budget is an absolute deadline rather than a fresh timeout per receive:
        // control lines the loop does not consume as input (RESIZE, and the frontend's
        // visibility push) also wake the receive, and restarting the timer on each one
        // would let a steady stream of them hold the escape unflushed indefinitely —
        // swallowing the keypress.
        let mut escape_deadline: Option<Instant> = None;
        loop {
            let line = if decoder.has_pending_escape() {
                let deadline =
                    *escape_deadline.get_or_insert_with(|| Instant::now() + ESCAPE_FLUSH);
                match deadline
                    .checked_duration_since(Instant::now())
                    .map(|remaining| lines_rx.recv_timeout(remaining))
                    .unwrap_or(Err(mpsc::RecvTimeoutError::Timeout))
                {
                    Ok(line) => Some(line),
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        escape_deadline = None;
                        dispatch_inputs(&runtime, decoder.flush_escape());
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => None,
                }
            } else {
                escape_deadline = None;
                lines_rx.recv().ok()
            };
            let Some(line) = line else {
                runtime.cleanup();
                app.exit(0);
                break;
            };
            if let Some(viewport) = parse_resize_line(&line) {
                let _output = state.output_gate.lock().unwrap();
                *state.viewport.lock().unwrap() = viewport.0;
                state.generation.fetch_add(1, Ordering::AcqRel);
                *state.last_hash.lock().unwrap() = None;
                let mut pane_origin = state.pane_origin.lock().unwrap();
                if let Err(error) = write_kitty_delete(image_id, *pane_origin) {
                    eprintln!("tweb: image delete failed: {error}");
                }
                if let Some(origin) = viewport.1 {
                    *pane_origin = Some(origin);
                }
                drop(pane_origin);
                runtime.resize_all(viewport.0);
                state.mark_interaction();
                continue;
            }
            if let Some(bytes) = parse_input_line(&line) {
                dispatch_inputs(&runtime, decoder.push(&bytes));
                state.mark_interaction();
            }
        }
    });
}

fn dispatch_inputs(runtime: &Arc<BrowserRuntime>, inputs: Vec<DecodedInput>) {
    for input in inputs {
        match input {
            DecodedInput::Key {
                key,
                modifier_mask,
                event_kind,
                text,
            } => {
                runtime.handle_key(&key, modifier_mask, event_kind, text.as_deref());
            }
            DecodedInput::Mouse {
                code,
                column,
                row,
                release,
            } => runtime.handle_mouse(code, column, row, release),
            DecodedInput::Private(code) => runtime.handle_private(code),
        }
    }
}

fn parse_resize_line(line: &str) -> Option<(Viewport, Option<PaneOrigin>)> {
    let rest = line.strip_prefix("RESIZE ")?;
    let values: Vec<u32> = rest
        .split_whitespace()
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()
        .ok()?;
    if !(values.len() == 4 || values.len() == 6) || values[..4].contains(&0) {
        return None;
    }
    Some((
        Viewport {
            cols: values[0],
            rows: values[1],
            width: values[2],
            height: values[3],
        },
        if values.len() == 6 {
            Some(PaneOrigin {
                left: values[4],
                top: values[5],
            })
        } else {
            None
        },
    ))
}

fn parse_input_line(line: &str) -> Option<Vec<u8>> {
    let hex = line.strip_prefix("INPUT ")?;
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).ok())
        .collect()
}

fn main() -> Result<()> {
    #[cfg(not(target_os = "macos"))]
    anyhow::bail!("the Tauri engine currently requires macOS WKWebView snapshot support");

    let args = Args::parse();
    let adaptive = !args.no_adaptive_frame_rate;
    let viewport = parse_viewport();
    let image_id = std::env::var("TWEB_IMAGE_ID")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);
    let state = Arc::new(SnapshotState {
        in_flight: AtomicBool::new(false),
        snapshot_pending: AtomicBool::new(true),
        stopping: AtomicBool::new(false),
        terminal_cleaned: AtomicBool::new(false),
        last_input_ms: AtomicU64::new(now_ms()),
        last_change_ms: AtomicU64::new(0),
        frame_bytes: AtomicU64::new(0),
        generation: AtomicU64::new(0),
        last_hash: Mutex::new(None),
        viewport: Mutex::new(viewport),
        pane_origin: Mutex::new(parse_pane_origin()),
        output_gate: Mutex::new(()),
        scheduler_generation: Mutex::new(0),
        scheduler_wake: Condvar::new(),
        frames: FrameMailbox::new(),
        image_id,
        frame_path: frame_file_path(image_id),
    });

    sweep_abandoned_frame_files();
    let output_state = state.clone();
    let frame_path = state.frame_path.clone();
    std::thread::spawn(move || {
        let mut raw_frames = std::env::var("TWEB_RAW_FRAMES").as_deref() != Ok("0");
        let mut raw_failures = 0;
        loop {
            let frame = output_state.frames.receive();
            if output_state.stopping.load(Ordering::Acquire) {
                break;
            }
            let Some(rgba) = pack_rgba(&frame.capture) else {
                eprintln!("tweb: snapshot geometry does not match its bytes; frame dropped");
                continue;
            };
            let hash = frame_hash(&rgba);
            let _output = output_state.output_gate.lock().unwrap();
            if output_state.stopping.load(Ordering::Acquire)
                || frame.generation != output_state.generation.load(Ordering::Acquire)
            {
                continue;
            }
            {
                let mut last_hash = output_state.last_hash.lock().unwrap();
                if *last_hash == Some(hash) {
                    continue;
                }
                *last_hash = Some(hash);
            }
            output_state
                .last_change_ms
                .store(now_ms(), Ordering::Release);
            output_state
                .frame_bytes
                .store(rgba.len() as u64, Ordering::Release);
            let origin = *output_state.pane_origin.lock().unwrap();
            if raw_frames {
                match write_kitty_raw_file(&rgba, &frame, &frame_path, image_id, origin) {
                    Ok(()) => continue,
                    // Mirrors the Electron engine: a few failed frame files give raw up for
                    // PNG rather than leaving the pane blank.
                    Err(error) => {
                        raw_failures += 1;
                        eprintln!("tweb: raw frame failed: {error}");
                        if raw_failures >= RAW_FRAME_FAILURE_LIMIT {
                            raw_frames = false;
                            eprintln!(
                                "tweb: raw frames failed {raw_failures}x, falling back to PNG"
                            );
                        }
                    }
                }
            }
            if let Err(error) = write_kitty_png(&rgba, &frame, image_id, origin) {
                eprintln!("tweb: frame output failed: {error}");
                break;
            }
        }
    });

    let setup_state = state.clone();
    let initial_url = browser::normalize_url(&args.url);
    let max_rate = args.frame_rate;
    let runtime_slot = Arc::new(Mutex::new(None::<Arc<BrowserRuntime>>));
    let setup_slot = runtime_slot.clone();
    tauri::Builder::default()
        .register_uri_scheme_protocol("tweb-action", |context, request| {
            let label = context.webview_label().to_string();
            if let Ok(url) = request.uri().to_string().parse() {
                if let Some(action) = browser::parse_bridge_url(&url) {
                    if let Some(runtime) = context.app_handle().try_state::<Arc<BrowserRuntime>>() {
                        let runtime = runtime.inner().clone();
                        let app = context.app_handle().clone();
                        let _ = app.run_on_main_thread(move || {
                            runtime.dispatch_action(&label, action);
                        });
                    }
                }
            }
            tauri::http::Response::builder()
                .status(204)
                .body(Vec::new())
                .expect("static custom protocol response is valid")
        })
        .setup(move |app| {
            let runtime = BrowserRuntime::new(app.handle().clone(), setup_state.clone());
            app.manage(runtime.clone());
            runtime.open_initial_session(&initial_url)?;
            spawn_control_thread(
                app.handle().clone(),
                runtime.clone(),
                setup_state.clone(),
                image_id,
            );
            let scheduler_runtime = runtime.clone();
            let scheduler_state = setup_state.clone();
            std::thread::spawn(move || loop {
                if scheduler_state.stopping.load(Ordering::Acquire) {
                    break;
                }
                let observed_generation = *scheduler_state.scheduler_generation.lock().unwrap();
                if let Some(window) = scheduler_runtime.active_window() {
                    request_snapshot(&window, scheduler_state.clone());
                }
                let rate = frame_rate::snapshot_rate(
                    adaptive,
                    max_rate,
                    &frame_rate::Activity {
                        now_ms: now_ms(),
                        last_input_ms: scheduler_state.last_input_ms.load(Ordering::Acquire),
                        last_change_ms: scheduler_state.last_change_ms.load(Ordering::Acquire),
                        frame_bytes: scheduler_state.frame_bytes.load(Ordering::Acquire),
                    },
                );
                let interval = Duration::from_millis((1000 / u64::from(rate)).max(1));
                let generation = scheduler_state.scheduler_generation.lock().unwrap();
                let _ = scheduler_state.scheduler_wake.wait_timeout_while(
                    generation,
                    interval,
                    |generation| {
                        *generation == observed_generation
                            && !scheduler_state.stopping.load(Ordering::Acquire)
                    },
                );
            });
            *setup_slot.lock().unwrap() = Some(runtime);
            Ok(())
        })
        .run(tauri::generate_context!())
        .context("failed to run Tauri engine")?;

    if let Some(runtime) = runtime_slot.lock().unwrap().as_ref() {
        runtime.cleanup();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        frame_file_owner, parse_input_line, parse_resize_line, Capture, ChannelOrder, Frame,
        FrameMailbox, PaneOrigin, Viewport,
    };

    fn frame(marker: u8, cols: u32, rows: u32, generation: u64) -> Frame {
        Frame {
            capture: Capture {
                bytes: vec![marker; 4],
                width: 1,
                height: 1,
                bytes_per_row: 4,
                order: ChannelOrder::Rgba,
            },
            cols,
            rows,
            generation,
        }
    }

    #[test]
    fn reads_the_owner_only_from_our_frame_files() {
        assert_eq!(frame_file_owner("tweb-tauri-frame-412-7.rgba"), Some(412));
        assert_eq!(
            frame_file_owner("tweb-tauri-frame-412-7.rgba.tmp"),
            Some(412)
        );
        assert_eq!(frame_file_owner("tweb-tauri-frame-412.rgba"), None);
        assert_eq!(frame_file_owner("tweb-frame-412-7.rgba"), None);
        assert_eq!(frame_file_owner("tweb-tauri-frame-0-7.rgba"), None);
    }

    #[test]
    fn frame_mailbox_keeps_only_the_latest_frame() {
        let mailbox = FrameMailbox::new();
        mailbox.replace(frame(1, 80, 24, 1));
        mailbox.replace(frame(2, 100, 30, 2));

        let frame = mailbox.receive();
        assert_eq!(frame.capture.bytes, vec![2; 4]);
        assert_eq!((frame.cols, frame.rows, frame.generation), (100, 30, 2));
    }

    #[test]
    fn parses_control_protocol_lines() {
        assert_eq!(parse_input_line("INPUT 1b5b41"), Some(b"\x1b[A".to_vec()));
        assert_eq!(parse_input_line("INPUT 1"), None);
        assert_eq!(
            parse_resize_line("RESIZE 80 24 1200 800 7 3"),
            Some((
                Viewport {
                    cols: 80,
                    rows: 24,
                    width: 1200,
                    height: 800,
                },
                Some(PaneOrigin { left: 7, top: 3 }),
            ))
        );
        // A pane-origin-less RESIZE must not index the optional origin fields.
        assert_eq!(
            parse_resize_line("RESIZE 100 30 1200 800"),
            Some((
                Viewport {
                    cols: 100,
                    rows: 30,
                    width: 1200,
                    height: 800,
                },
                None,
            ))
        );
        assert_eq!(parse_resize_line("RESIZE 0 24 1200 800"), None);
    }
}
