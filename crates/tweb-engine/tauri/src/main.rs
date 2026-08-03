mod browser;
mod graphics;
mod input;
mod preload;
mod tmux;

use anyhow::{Context, Result};
use browser::BrowserRuntime;
use clap::{ArgAction, Parser};
use graphics::{write_kitty_delete, write_kitty_png, Frame, PaneOrigin};
use input::{DecodedInput, InputDecoder};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::BufRead;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
    generation: AtomicU64,
    last_hash: Mutex<Option<u64>>,
    viewport: Mutex<Viewport>,
    pane_origin: Mutex<Option<PaneOrigin>>,
    output_gate: Mutex<()>,
    scheduler_generation: Mutex<u64>,
    scheduler_wake: Condvar,
    frames: FrameMailbox,
    image_id: u32,
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
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
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
            let callback = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let _flight = SnapshotFlight(callback_state.clone());
                if !error.is_null() || image.is_null() {
                    return;
                }
                let image = &*image;
                let Some(tiff) = image.TIFFRepresentation() else {
                    return;
                };
                let Some(bitmap) = NSBitmapImageRep::imageRepWithData(&tiff) else {
                    return;
                };
                let properties =
                    NSDictionary::<objc2_app_kit::NSBitmapImageRepPropertyKey, AnyObject>::new();
                let Some(png) = bitmap
                    .representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
                else {
                    return;
                };
                if callback_state.stopping.load(Ordering::Acquire)
                    || callback_state.generation.load(Ordering::Acquire) != generation
                {
                    return;
                }
                let png = png.to_vec();
                let mut hasher = DefaultHasher::new();
                png.hash(&mut hasher);
                let hash = hasher.finish();
                let mut last_hash = callback_state.last_hash.lock().unwrap();
                if callback_state.generation.load(Ordering::Acquire) != generation
                    || last_hash.as_ref() == Some(&hash)
                {
                    return;
                }
                *last_hash = Some(hash);
                callback_state.frames.replace(Frame {
                    png,
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

#[cfg(not(target_os = "macos"))]
fn request_snapshot(_window: &WebviewWindow, state: Arc<SnapshotState>) {
    state.in_flight.store(false, Ordering::Release);
}

#[cfg(target_os = "macos")]
pub(crate) fn activate_offscreen_window(window: &WebviewWindow) -> tauri::Result<()> {
    use objc2_app_kit::NSWindow;

    window.with_webview(|platform| unsafe {
        let native_window = &*(platform.ns_window() as *mut NSWindow);
        // WKWebView는 ordered-out window에서 visibility를 hidden으로 바꾼다. 입력을
        // 받지 않는 거의 투명한 capture surface로 ordered 상태만 유지한다.
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
        loop {
            let line = if decoder.has_pending_escape() {
                match lines_rx.recv_timeout(Duration::from_millis(35)) {
                    Ok(line) => Some(line),
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        dispatch_inputs(&runtime, decoder.flush_escape());
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => None,
                }
            } else {
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
        generation: AtomicU64::new(0),
        last_hash: Mutex::new(None),
        viewport: Mutex::new(viewport),
        pane_origin: Mutex::new(parse_pane_origin()),
        output_gate: Mutex::new(()),
        scheduler_generation: Mutex::new(0),
        scheduler_wake: Condvar::new(),
        frames: FrameMailbox::new(),
        image_id,
    });

    let output_state = state.clone();
    std::thread::spawn(move || loop {
        let frame = output_state.frames.receive();
        if output_state.stopping.load(Ordering::Acquire) {
            break;
        }
        let _output = output_state.output_gate.lock().unwrap();
        if output_state.stopping.load(Ordering::Acquire)
            || frame.generation != output_state.generation.load(Ordering::Acquire)
        {
            continue;
        }
        let origin = *output_state.pane_origin.lock().unwrap();
        if let Err(error) = write_kitty_png(&frame, image_id, origin) {
            eprintln!("tweb: frame output failed: {error}");
            break;
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
                let recently_changed = now_ms()
                    .saturating_sub(scheduler_state.last_input_ms.load(Ordering::Acquire))
                    < 700;
                let rate = if adaptive && !recently_changed {
                    1
                } else {
                    max_rate
                };
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
    use super::{parse_input_line, parse_resize_line, Frame, FrameMailbox, PaneOrigin, Viewport};

    #[test]
    fn frame_mailbox_keeps_only_the_latest_frame() {
        let mailbox = FrameMailbox::new();
        mailbox.replace(Frame {
            png: vec![1],
            cols: 80,
            rows: 24,
            generation: 1,
        });
        mailbox.replace(Frame {
            png: vec![2],
            cols: 100,
            rows: 30,
            generation: 2,
        });

        let frame = mailbox.receive();
        assert_eq!(frame.png, vec![2]);
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
