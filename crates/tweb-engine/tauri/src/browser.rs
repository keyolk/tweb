use crate::preload::bridge_script;
use crate::tmux::TmuxRuntime;
use crate::{activate_offscreen_window, javascript_string, SnapshotState, Viewport};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Debug, Deserialize)]
pub(crate) struct BrowserAction {
    #[serde(default)]
    pub token: String,
    pub action: String,
    #[serde(default)]
    pub value: Value,
}

struct Tab {
    label: String,
    token: String,
    window: WebviewWindow,
    url: String,
    zoom: f64,
    title: String,
}

struct HistoryEntry {
    url: String,
    title: String,
    recency: u64,
}

#[derive(Debug, Deserialize, Serialize)]
struct SavedTab {
    url: String,
    zoom: f64,
}

#[derive(Debug, Deserialize, Serialize)]
struct WindowSession {
    version: u8,
    #[serde(rename = "activeIndex")]
    active_index: usize,
    tabs: Vec<SavedTab>,
}

struct Tabs {
    values: Vec<Tab>,
    active: usize,
    closed: Vec<String>,
    history: Vec<HistoryEntry>,
    serial: u64,
    history_serial: u64,
    shortcuts_enabled: bool,
}

fn record_navigation_history(tabs: &mut Tabs, url: &str, title: &str) {
    if url.is_empty() || url == "about:blank" || url.starts_with("tweb-action:") {
        return;
    }
    tabs.history.retain(|entry| entry.url != url);
    tabs.history_serial += 1;
    tabs.history.insert(
        0,
        HistoryEntry {
            url: url.to_string(),
            title: if title.trim().is_empty() { url } else { title }.to_string(),
            recency: tabs.history_serial,
        },
    );
    tabs.history.truncate(200);
}

const DOUBLE_CLICK_INTERVAL: Duration = Duration::from_millis(500);
const DOUBLE_CLICK_CELL_DISTANCE: u32 = 1;

#[derive(Clone, Copy)]
struct MousePress {
    button: u32,
    column: u32,
    row: u32,
    click_count: isize,
    dragged: bool,
}

#[derive(Clone, Copy)]
struct MouseClick {
    button: u32,
    column: u32,
    row: u32,
    at: Instant,
    count: isize,
}

#[derive(Default)]
struct MouseState {
    press: Option<MousePress>,
    last_click: Option<MouseClick>,
}

impl MouseState {
    fn begin_press(&mut self, button: u32, column: u32, row: u32, now: Instant) -> isize {
        let repeated = self.last_click.is_some_and(|click| {
            click.button == button
                && now.saturating_duration_since(click.at) <= DOUBLE_CLICK_INTERVAL
                && column.abs_diff(click.column) <= DOUBLE_CLICK_CELL_DISTANCE
                && row.abs_diff(click.row) <= DOUBLE_CLICK_CELL_DISTANCE
        });
        let click_count = if repeated {
            self.last_click.map_or(1, |click| (click.count + 1).min(3))
        } else {
            1
        };
        self.last_click = Some(MouseClick {
            button,
            column,
            row,
            at: now,
            count: click_count,
        });
        self.press = Some(MousePress {
            button,
            column,
            row,
            click_count,
            dragged: false,
        });
        click_count
    }

    fn move_pointer(&mut self, button: u32, column: u32, row: u32) {
        let dragged = self
            .press
            .as_mut()
            .filter(|press| press.button == button)
            .is_some_and(|press| {
                press.dragged |= press.column != column || press.row != row;
                press.dragged
            });
        if dragged {
            self.last_click = None;
        }
    }

    fn end_press(&mut self, button: u32) -> (bool, isize) {
        let Some(press) = self.press.take() else {
            self.last_click = None;
            return (false, 1);
        };
        if press.button != button {
            self.last_click = None;
            return (false, 1);
        }
        if press.dragged {
            self.last_click = None;
        }
        (press.dragged, press.click_count)
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

pub(crate) struct BrowserRuntime {
    app: AppHandle,
    snapshot: Arc<SnapshotState>,
    tabs: Mutex<Tabs>,
    mouse: Mutex<MouseState>,
    tmux: TmuxRuntime,
    window_session_path: Option<PathBuf>,
    restoring_session: AtomicBool,
    default_zoom: f64,
    show_window: bool,
}

impl BrowserRuntime {
    pub(crate) fn new(app: AppHandle, snapshot: Arc<SnapshotState>) -> Arc<Self> {
        let default_zoom = std::env::var("TWEB_DEFAULT_ZOOM")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.8)
            .clamp(0.5, 2.0);
        let tmux = TmuxRuntime::initialize();
        let window_session_path = tmux.window_session_key().and_then(|key| {
            let base = std::env::var_os("TWEB_USER_DATA_DIR")
                .map(PathBuf::from)
                .or_else(|| app.path().app_data_dir().ok())?;
            Some(base.join("window-sessions").join(format!("{key}.json")))
        });
        Arc::new(Self {
            app,
            snapshot,
            tabs: Mutex::new(Tabs {
                values: Vec::new(),
                active: 0,
                closed: Vec::new(),
                history: Vec::new(),
                serial: 0,
                history_serial: 0,
                shortcuts_enabled: true,
            }),
            mouse: Mutex::new(MouseState::default()),
            tmux,
            window_session_path,
            restoring_session: AtomicBool::new(false),
            default_zoom,
            show_window: std::env::var_os("TWEB_TAURI_SHOW_WINDOW").is_some(),
        })
    }

    pub(crate) fn open_tab(self: &Arc<Self>, input: &str, activate: bool) -> tauri::Result<()> {
        self.open_tab_with_zoom(input, activate, self.default_zoom)
    }

    fn open_tab_with_zoom(
        self: &Arc<Self>,
        input: &str,
        activate: bool,
        zoom: f64,
    ) -> tauri::Result<()> {
        let Some(url) = normalize_omnibox_input(input) else {
            return Ok(());
        };
        let zoom = zoom.clamp(0.5, 2.0);
        let parsed_url = url.parse().map_err(tauri::Error::InvalidUrl)?;
        let viewport = *self.snapshot.viewport.lock().unwrap();
        let (script, token) = bridge_script();
        let label = {
            let mut tabs = self.tabs.lock().unwrap();
            tabs.serial += 1;
            format!("tab-{}", tabs.serial)
        };
        let runtime = self.clone();
        let new_window_runtime = self.clone();
        let label_for_load = label.clone();
        let window = WebviewWindowBuilder::new(&self.app, &label, WebviewUrl::External(parsed_url))
            .title("TWeb Tauri")
            .inner_size(viewport.width as f64, viewport.height as f64)
            .visible(self.show_window)
            .focused(false)
            .decorations(false)
            .skip_taskbar(true)
            .devtools(true)
            .zoom_hotkeys_enabled(false)
            .initialization_script(script)
            .on_page_load(move |_window, payload| {
                runtime.page_loaded(&label_for_load, payload.url().as_str());
            })
            .on_new_window(move |url, _features| {
                let target = url.to_string();
                let runtime = new_window_runtime.clone();
                let app = runtime.app.clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = runtime.open_tab(&target, true);
                });
                tauri::webview::NewWindowResponse::Deny
            })
            .build()?;
        activate_offscreen_window(&window)?;
        set_native_zoom(&window, zoom);

        {
            let mut tabs = self.tabs.lock().unwrap();
            tabs.values.push(Tab {
                label: label.clone(),
                token,
                window,
                url,
                zoom,
                title: "New tab".to_string(),
            });
            if activate || tabs.values.len() == 1 {
                tabs.active = tabs.values.len() - 1;
            }
        }
        if activate {
            self.activate_by_label(&label);
        } else {
            self.sync_windows();
            self.send_tab_state();
            self.write_window_session();
        }
        Ok(())
    }

    pub(crate) fn open_initial_session(self: &Arc<Self>, initial_url: &str) -> tauri::Result<()> {
        if std::env::var("TWEB_RESTORE_SESSION").as_deref() != Ok("1") {
            return self.open_tab(initial_url, true);
        }
        let Some(session) = self.read_window_session() else {
            return self.open_tab(initial_url, true);
        };

        self.restoring_session.store(true, Ordering::Release);
        for tab in &session.tabs {
            if let Err(error) = self.open_tab_with_zoom(&tab.url, false, tab.zoom) {
                if debug_enabled() {
                    eprintln!("tweb: window session tab restore failed: {error}");
                }
            }
        }
        let tab_count = self.tabs.lock().map(|tabs| tabs.values.len()).unwrap_or(0);
        if tab_count > 0 {
            self.activate_tab(session.active_index.min(tab_count - 1));
        }
        self.restoring_session.store(false, Ordering::Release);

        if tab_count == 0 {
            return self.open_tab(initial_url, true);
        }
        self.write_window_session();
        if debug_enabled() {
            eprintln!("tweb: restored {tab_count} tabs for tmux window");
        }
        Ok(())
    }

    fn read_window_session(&self) -> Option<WindowSession> {
        let path = self.window_session_path.as_ref()?;
        let data = fs::read(path).ok()?;
        let mut session: WindowSession = serde_json::from_slice(&data).ok()?;
        if session.version != 1 || session.tabs.is_empty() {
            return None;
        }
        session.tabs.truncate(50);
        session
            .tabs
            .retain(|tab| !tab.url.is_empty() && tab.url.len() <= 2_000_000);
        if session.tabs.is_empty() {
            return None;
        }
        for tab in &mut session.tabs {
            tab.zoom = if tab.zoom.is_finite() {
                tab.zoom.clamp(0.5, 2.0)
            } else {
                self.default_zoom
            };
        }
        session.active_index = session.active_index.min(session.tabs.len() - 1);
        Some(session)
    }

    fn write_window_session(&self) {
        if self.restoring_session.load(Ordering::Acquire) {
            return;
        }
        let Some(path) = self.window_session_path.as_ref() else {
            return;
        };
        let session = {
            let Ok(tabs) = self.tabs.lock() else {
                return;
            };
            if tabs.values.is_empty() {
                return;
            }
            WindowSession {
                version: 1,
                active_index: tabs.active.min(tabs.values.len() - 1),
                tabs: tabs
                    .values
                    .iter()
                    .map(|tab| SavedTab {
                        url: tab.url.clone(),
                        zoom: tab.zoom,
                    })
                    .collect(),
            }
        };
        let Ok(data) = serde_json::to_vec(&session) else {
            return;
        };
        let Some(parent) = path.parent() else {
            return;
        };
        let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
        let result = (|| -> std::io::Result<()> {
            fs::create_dir_all(parent)?;
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&data)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            fs::rename(&temporary, path)?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            if debug_enabled() {
                eprintln!("tweb: window session save failed: {error}");
            }
        }
    }

    pub(crate) fn cleanup(&self) {
        if let Ok(mut mouse) = self.mouse.lock() {
            mouse.reset();
        }
        self.write_window_session();
        self.snapshot.shutdown();
        self.tmux.cleanup();
    }

    pub(crate) fn active_window(&self) -> Option<WebviewWindow> {
        let tabs = self.tabs.lock().ok()?;
        tabs.values.get(tabs.active).map(|tab| tab.window.clone())
    }

    pub(crate) fn resize_all(&self, viewport: Viewport) {
        if let Ok(mut mouse) = self.mouse.lock() {
            mouse.reset();
        }
        let windows: Vec<WebviewWindow> = self
            .tabs
            .lock()
            .map(|tabs| tabs.values.iter().map(|tab| tab.window.clone()).collect())
            .unwrap_or_default();
        for window in windows {
            let _ = window.set_size(PhysicalSize::new(viewport.width, viewport.height));
        }
    }

    pub(crate) fn dispatch_action(self: &Arc<Self>, label: &str, action: BrowserAction) {
        if !self.authenticated_active_tab(label, &action.token) {
            return;
        }
        if debug_enabled() {
            eprintln!("tweb: action {} from {label}", action.action);
        }
        match action.action.as_str() {
            "tweb-preload-ready" => {
                self.update_page_meta(label, &action.value);
                self.send_shortcut_mode();
                self.send_tab_state();
            }
            "page-meta" => self.update_page_meta(label, &action.value),
            "history-back" => self.with_active_window(go_back),
            "history-forward" => self.with_active_window(go_forward),
            "previous-tab" => self.cycle_tab(-1),
            "next-tab" => self.cycle_tab(1),
            "list-tabs" => self.send_tab_list(),
            "omnibox-model" => self.send_omnibox_model(),
            "activate-tab" => {
                if let Some(index) = action.value.as_u64() {
                    self.activate_tab(index as usize);
                }
            }
            "close-tab" => self.close_active_tab(),
            "restore-tab" => self.restore_tab(),
            "reload" => self.with_active_window(|window| {
                let _ = window.reload();
            }),
            "zoom-in" => self.set_zoom(ZoomAction::In),
            "zoom-out" => self.set_zoom(ZoomAction::Out),
            "zoom-reset" => self.set_zoom(ZoomAction::Reset),
            "find" => self.find(&action.value),
            "stop-find" => self.with_active_window(|window| {
                let _ = window.eval("getSelection()?.removeAllRanges()");
            }),
            "copy-text" => copy_text(action.value.as_str().unwrap_or_default()),
            // The engine tracks the address the tab settled on; a subframe only
            // knows its own, and a cross-origin one cannot read the top frame's.
            "copy-url" => {
                if let Ok(tabs) = self.tabs.lock() {
                    if let Some(tab) = tabs.values.get(tabs.active) {
                        copy_text(&tab.url);
                    }
                }
            }
            "copy-image" => {
                if let Some(rect) = ImageRect::from_value(&action.value) {
                    self.with_active_window(|window| copy_image(window, rect));
                }
            }
            "download" => {
                if let Some(url) = action.value.as_str().filter(|url| is_downloadable_url(url)) {
                    let url = javascript_string(url);
                    self.with_active_window(|window| {
                        let _ = window.eval(format!(
                            "(()=>{{const a=document.createElement('a');a.href={url};a.download='';a.style.display='none';document.documentElement.append(a);a.click();a.remove()}})()"
                        ));
                    });
                }
            }
            "paste" => {
                if let Some(text) = read_text() {
                    let text = javascript_string(&text);
                    self.with_active_window(|window| {
                        let _ =
                            window.eval(format!("document.execCommand('insertText',false,{text})"));
                    });
                }
            }
            "native-hover" => {
                if let Some(point) = CssPoint::from_value(&action.value) {
                    self.with_active_window(|window| dispatch_native_hover(window, point));
                }
            }
            "native-click" => {
                if let Some(point) = CssPoint::from_value(&action.value) {
                    self.with_active_window(|window| dispatch_native_click(window, point));
                }
            }
            "native-drag" => {
                if let Some(drag) = CssDrag::from_value(&action.value) {
                    self.with_active_window(|window| dispatch_native_drag(window, drag));
                }
            }
            "inspect-devtools" => self.with_active_window(|window| {
                window.open_devtools();
                if let (Some(x), Some(y)) = (
                    action.value.get("x").and_then(Value::as_f64),
                    action.value.get("y").and_then(Value::as_f64),
                ) {
                    let _ = window.eval(format!(
                        "globalThis.inspect?.(document.elementFromPoint({x},{y}))"
                    ));
                }
                request_keyboard_mode_restore();
            }),
            "frame-mode" => self.emit_active("tweb-frame-mode", &action.value),
            "navigate" => {
                if let Some(value) = action.value.as_str().and_then(normalize_omnibox_input) {
                    self.with_active_window(|window| {
                        if let Ok(url) = value.parse() {
                            let _ = window.navigate(url);
                        }
                    });
                }
            }
            "new-tab" => {
                if let Some(value) = action.value.as_str() {
                    let _ = self.open_tab(value, true);
                }
            }
            _ => {}
        }
    }

    pub(crate) fn handle_key(
        self: &Arc<Self>,
        key: &str,
        modifier_mask: u32,
        event_kind: u32,
        text: Option<&str>,
    ) -> bool {
        let bits = modifier_mask.saturating_sub(1);
        let pressed = event_kind != 3;
        let shift = bits & 1 != 0;
        let control = bits & 4 != 0;
        let meta = bits & 8 != 0 || bits & 32 != 0;
        let shortcuts = self.tabs.lock().is_ok_and(|tabs| tabs.shortcuts_enabled);
        if debug_enabled() && event_kind != 3 {
            eprintln!(
                "tweb: key {key:?} modifiers={modifier_mask} mode={}",
                if shortcuts {
                    "shortcuts"
                } else {
                    "passthrough"
                }
            );
        }

        if control && key == ";" {
            if pressed {
                self.toggle_shortcuts();
            }
            return false;
        }
        if shortcuts && control && key.eq_ignore_ascii_case("c") {
            if pressed {
                self.cleanup();
                self.app.exit(0);
            }
            return false;
        }
        if shortcuts && pressed {
            if control && matches!(key, "Tab" | "PageDown" | "PageUp") {
                let direction = if key == "PageUp" || key == "Tab" && shift {
                    -1
                } else {
                    1
                };
                self.cycle_tab(direction);
                return false;
            }
            if control && key.eq_ignore_ascii_case("w") {
                self.close_active_tab();
                return false;
            }
            if control && !meta && matches!(key, "+" | "=" | "-" | "0") {
                let action = match key {
                    "+" | "=" => ZoomAction::In,
                    "-" => ZoomAction::Out,
                    _ => ZoomAction::Reset,
                };
                self.set_zoom(action);
                return false;
            }
        }
        self.with_active_window(|window| {
            if shortcuts {
                dispatch_key(window, key, modifier_mask, event_kind, text);
            } else {
                dispatch_native_key(window, key, modifier_mask, event_kind, text);
            }
        });
        true
    }

    pub(crate) fn handle_private(self: &Arc<Self>, code: u32) {
        if code == 5001 {
            self.toggle_shortcuts();
            return;
        }
        if matches!(code, 5011 | 5012) {
            self.set_shortcuts_enabled(code == 5012);
            return;
        }
        let shortcuts = self.tabs.lock().is_ok_and(|tabs| tabs.shortcuts_enabled);
        if shortcuts {
            match code {
                5002 | 5007 => self.set_zoom(ZoomAction::In),
                5003 => self.set_zoom(ZoomAction::Out),
                5004 => self.set_zoom(ZoomAction::Reset),
                5008 => {
                    self.handle_key("Enter", 2, 1, None);
                }
                5009 => {
                    self.handle_key(",", 5, 1, None);
                }
                _ => {}
            }
            return;
        }
        let (key, modifier) = match code {
            5002 => ("=", 5),
            5003 => ("-", 5),
            5004 => ("0", 5),
            5005 => ("H", 8),
            5006 => ("L", 8),
            5007 => ("+", 6),
            5008 => ("Enter", 2),
            5009 => (",", 5),
            _ => return,
        };
        self.handle_key(key, modifier, 1, None);
    }

    pub(crate) fn handle_mouse(&self, code: u32, column: u32, row: u32, release: bool) {
        let viewport = *self.snapshot.viewport.lock().unwrap();
        let wheel = code & 64 != 0;
        let wheel_direction = code & 3;
        let shortcuts = self.tabs.lock().is_ok_and(|tabs| tabs.shortcuts_enabled);
        if wheel && code & 16 != 0 && shortcuts {
            match wheel_direction {
                0 => self.set_zoom(ZoomAction::In),
                1 => self.set_zoom(ZoomAction::Out),
                _ => {}
            }
            return;
        }
        self.with_active_window(|window| {
            if wheel {
                let payload = json!({
                    "code": code,
                    "column": column,
                    "row": row,
                    "cols": viewport.cols,
                    "rows": viewport.rows,
                });
                let _ = window.eval(format!("window.__twebTerminalWheel?.({payload})"));
            } else {
                let motion = code & 32 != 0;
                let button = code & 3;
                let (cancelled, click_count) = self
                    .mouse
                    .lock()
                    .map(|mut mouse| {
                        if motion && button == 3 {
                            return (false, 0);
                        }
                        if motion {
                            mouse.move_pointer(button, column, row);
                            return (false, 0);
                        }
                        if release {
                            return mouse.end_press(button);
                        }
                        let click_count = mouse.begin_press(button, column, row, Instant::now());
                        (false, click_count)
                    })
                    .unwrap_or((false, 1));
                if motion && button == 3 {
                    dispatch_native_mouse(
                        window,
                        NativeMouseInput {
                            code: 0,
                            column,
                            row,
                            release: false,
                            cancelled: false,
                            probe: true,
                            click_count: 0,
                            viewport,
                        },
                    );
                    dispatch_native_mouse(
                        window,
                        NativeMouseInput {
                            code: 0,
                            column,
                            row,
                            release: false,
                            cancelled: true,
                            probe: true,
                            click_count: 0,
                            viewport,
                        },
                    );
                }
                dispatch_native_mouse(
                    window,
                    NativeMouseInput {
                        code,
                        column,
                        row,
                        release,
                        cancelled,
                        probe: false,
                        click_count,
                        viewport,
                    },
                );
            }
        });
    }

    fn update_page_meta(&self, label: &str, value: &Value) {
        let title = value
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .or_else(|| value.get("url").and_then(Value::as_str));
        let Some(title) = title else {
            return;
        };
        if debug_enabled() {
            eprintln!("tweb: page-meta {title:?} from {label}");
        }
        if let Ok(mut tabs) = self.tabs.lock() {
            let history = tabs
                .values
                .iter_mut()
                .find(|tab| tab.label == label)
                .map(|tab| {
                    tab.title = title.to_string();
                    (tab.url.clone(), tab.title.clone())
                });
            if let Some((url, title)) = history {
                record_navigation_history(&mut tabs, &url, &title);
            }
        }
        self.sync_title();
        self.send_tab_state();
    }

    fn page_loaded(&self, label: &str, url: &str) {
        let mut update = false;
        if let Ok(mut tabs) = self.tabs.lock() {
            let history = tabs
                .values
                .iter_mut()
                .find(|tab| tab.label == label)
                .map(|tab| {
                    tab.url = url.to_string();
                    tab.title = url.to_string();
                    set_native_zoom(&tab.window, tab.zoom);
                    (tab.url.clone(), tab.title.clone())
                });
            if let Some((url, title)) = history {
                record_navigation_history(&mut tabs, &url, &title);
                update = true;
            }
        }
        if update {
            self.snapshot.mark_interaction();
            self.send_shortcut_mode();
            self.sync_title();
            self.send_tab_state();
            self.write_window_session();
        }
    }

    fn authenticated_active_tab(&self, label: &str, token: &str) -> bool {
        self.tabs.lock().is_ok_and(|tabs| {
            tabs.values
                .get(tabs.active)
                .is_some_and(|tab| tab.label == label && tab.token == token)
        })
    }

    fn set_shortcuts_enabled(&self, enabled: bool) {
        if let Ok(mut tabs) = self.tabs.lock() {
            tabs.shortcuts_enabled = enabled;
        }
        // Reconcile even when the engine mode was already correct: Ghostty reloads
        // and pane restarts can reset the terminal side independently.
        self.tmux.set_shortcuts_enabled(enabled);
        self.send_shortcut_mode();
        if !enabled {
            self.with_active_window(focus_native_input);
        }
        self.tmux.notify(if enabled {
            "browser shortcuts ON"
        } else {
            "web passthrough ON"
        });
    }

    fn toggle_shortcuts(&self) {
        let enabled = !self.tabs.lock().is_ok_and(|tabs| tabs.shortcuts_enabled);
        self.set_shortcuts_enabled(enabled);
    }

    fn send_shortcut_mode(&self) {
        let enabled = self.tabs.lock().is_ok_and(|tabs| tabs.shortcuts_enabled);
        self.emit_active("tweb-shortcuts-enabled", &Value::Bool(enabled));
    }

    fn send_tab_state(&self) {
        let model = self.tabs.lock().ok().map(|tabs| {
            json!({
                "activeIndex": tabs.active,
                "count": tabs.values.len(),
                "tabs": tabs.values.iter().enumerate().map(|(index, tab)| json!({
                    "index": index,
                    "title": tab.title,
                })).collect::<Vec<_>>(),
            })
        });
        if let Some(model) = model {
            self.emit_active("tweb-tab-state", &model);
        }
    }

    fn send_tab_list(&self) {
        let model = self.tabs.lock().ok().map(|tabs| {
            json!({
                "activeIndex": tabs.active,
                "tabs": tabs.values.iter().enumerate().map(|(index, tab)| json!({
                    "index": index,
                    "title": tab.title,
                    "url": tab.window.url().map(|url| url.to_string()).unwrap_or_else(|_| "about:blank".to_string()),
                })).collect::<Vec<_>>(),
            })
        });
        if let Some(model) = model {
            self.emit_active("tweb-tabs", &model);
        }
    }

    fn send_omnibox_model(&self) {
        let model = self.tabs.lock().ok().map(|tabs| {
            let current = tabs
                .values
                .get(tabs.active)
                .map_or("", |tab| tab.url.as_str());
            let tab_recency = tabs.history_serial + tabs.values.len() as u64;
            let entries = tabs
                .values
                .iter()
                .enumerate()
                .map(|(index, tab)| {
                    json!({
                        "kind": "tab",
                        "index": index,
                        "url": tab.url,
                        "title": tab.title,
                        "recency": tab_recency.saturating_sub(index as u64),
                    })
                })
                .chain(tabs.history.iter().map(|entry| {
                    json!({
                        "kind": "history",
                        "url": entry.url,
                        "title": entry.title,
                        "recency": entry.recency,
                    })
                }))
                .collect::<Vec<_>>();
            json!({ "current": current, "entries": entries })
        });
        if let Some(model) = model {
            self.emit_active("tweb-omnibox", &model);
        }
    }

    fn emit_active(&self, channel: &str, value: &Value) {
        let script = format!(
            "window.__twebReceive?.({},{})",
            javascript_string(channel),
            value
        );
        self.with_active_window(|window| {
            let _ = window.eval(script);
        });
    }

    fn activate_by_label(&self, label: &str) {
        if let Some(index) = self
            .tabs
            .lock()
            .ok()
            .and_then(|tabs| tabs.values.iter().position(|tab| tab.label == label))
        {
            self.activate_tab(index);
        }
    }

    fn activate_tab(&self, index: usize) {
        {
            let mut tabs = self.tabs.lock().unwrap();
            if index >= tabs.values.len() {
                return;
            }
            tabs.active = index;
        }
        if let Ok(mut mouse) = self.mouse.lock() {
            mouse.reset();
        }
        self.snapshot.generation.fetch_add(1, Ordering::AcqRel);
        *self.snapshot.last_hash.lock().unwrap() = None;
        self.sync_windows();
        self.sync_title();
        self.send_shortcut_mode();
        self.send_tab_state();
        self.write_window_session();
    }

    fn cycle_tab(&self, direction: isize) {
        let index = {
            let tabs = self.tabs.lock().unwrap();
            if tabs.values.len() < 2 {
                return;
            }
            (tabs.active as isize + direction).rem_euclid(tabs.values.len() as isize) as usize
        };
        self.activate_tab(index);
    }

    fn close_active_tab(self: &Arc<Self>) {
        let (window, next_empty) = {
            let mut tabs = self.tabs.lock().unwrap();
            if tabs.values.is_empty() {
                return;
            }
            let active = tabs.active;
            let tab = tabs.values.remove(active);
            if let Ok(url) = tab.window.url() {
                tabs.closed.push(url.to_string());
                if tabs.closed.len() > 25 {
                    tabs.closed.remove(0);
                }
            }
            if !tabs.values.is_empty() {
                tabs.active = active.min(tabs.values.len() - 1);
            }
            (tab.window, tabs.values.is_empty())
        };
        let _ = window.destroy();
        if next_empty {
            self.cleanup();
            self.app.exit(0);
        } else {
            if let Ok(mut mouse) = self.mouse.lock() {
                mouse.reset();
            }
            self.snapshot.generation.fetch_add(1, Ordering::AcqRel);
            *self.snapshot.last_hash.lock().unwrap() = None;
            self.sync_windows();
            self.sync_title();
            self.send_tab_state();
            self.write_window_session();
        }
    }

    fn restore_tab(self: &Arc<Self>) {
        let url = self.tabs.lock().ok().and_then(|mut tabs| tabs.closed.pop());
        if let Some(url) = url {
            let _ = self.open_tab(&url, true);
        }
    }

    fn sync_windows(&self) {
        let windows = self.tabs.lock().ok().map(|tabs| {
            tabs.values
                .iter()
                .enumerate()
                .map(|(index, tab)| (index == tabs.active, tab.window.clone()))
                .collect::<Vec<_>>()
        });
        for (active, window) in windows.unwrap_or_default() {
            if active {
                let _ = activate_offscreen_window(&window);
            } else {
                let _ = window.hide();
            }
        }
    }

    fn sync_title(&self) {
        // Tab state belongs to this pane's in-page badge. Putting it in tmux's
        // pane title makes one active pane look like the state of the window.
        self.tmux.update_title("tweb");
    }

    fn set_zoom(&self, action: ZoomAction) {
        let window_and_zoom = {
            let mut tabs = self.tabs.lock().unwrap();
            let default_zoom = self.default_zoom;
            let Some(active) = tabs.active.checked_sub(0) else {
                return;
            };
            let Some(tab) = tabs.values.get_mut(active) else {
                return;
            };
            tab.zoom = match action {
                ZoomAction::Reset => default_zoom,
                ZoomAction::In => (tab.zoom * 1.2).clamp(0.5, 2.0),
                ZoomAction::Out => (tab.zoom / 1.2).clamp(0.5, 2.0),
            };
            (tab.window.clone(), tab.zoom)
        };
        let applied = set_native_zoom(&window_and_zoom.0, window_and_zoom.1);
        self.snapshot.mark_interaction();
        let snapshot = self.snapshot.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(16));
            snapshot.mark_interaction();
        });
        if debug_enabled() {
            eprintln!(
                "tweb: native zoom {:.3}",
                applied.unwrap_or(window_and_zoom.1)
            );
        }
        self.tmux
            .notify(&format!("zoom {}%", (window_and_zoom.1 * 100.0).round()));
        self.write_window_session();
    }

    fn find(&self, value: &Value) {
        let query = value
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if query.is_empty() {
            return;
        }
        let backwards = value.get("forward").and_then(Value::as_bool) == Some(false);
        let query = javascript_string(query);
        self.with_active_window(|window| {
            let _ = window.eval(format!(
                "(()=>{{const found=window.find({query},false,{backwards},true,false,false,false);window.__twebReceive?.('tweb-find-result',found?{{matches:1,activeMatchOrdinal:1}}:{{matches:0,activeMatchOrdinal:0}});}})()"
            ));
        });
    }

    fn with_active_window(&self, callback: impl FnOnce(&WebviewWindow)) {
        if let Some(window) = self.active_window() {
            callback(&window);
        }
    }
}

#[derive(Clone, Copy)]
enum ZoomAction {
    In,
    Out,
    Reset,
}

fn debug_enabled() -> bool {
    std::env::var_os("TWEB_DEBUG").is_some()
}

pub(crate) fn parse_bridge_url(url: &url::Url) -> Option<BrowserAction> {
    if url.scheme() != "tweb-action" {
        return None;
    }
    let token = url.host_str()?.to_string();
    let payload = url
        .query_pairs()
        .find_map(|(name, value)| (name == "payload").then(|| value.into_owned()))?;
    let mut action: BrowserAction = serde_json::from_str(&payload).ok()?;
    action.token = token;
    Some(action)
}

pub(crate) fn normalize_url(input: &str) -> String {
    normalize_omnibox_input(input).unwrap_or_else(|| "https://example.com".to_string())
}

fn normalize_omnibox_input(input: &str) -> Option<String> {
    let value = input.trim();
    if value.is_empty() {
        return None;
    }
    if std::path::Path::new(value).is_absolute() {
        return url::Url::from_file_path(value).ok().map(|url| url.into());
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("localhost")
        || lower.starts_with("127.0.0.1")
        || lower.starts_with("[::1]")
    {
        return Some(format!("http://{value}"));
    }
    if has_scheme(value) {
        return Some(value.to_string());
    }
    if !value.chars().any(char::is_whitespace)
        && (value
            .split('/')
            .next()
            .is_some_and(|host| host.contains('.'))
            || value.split('/').next().is_some_and(|host| {
                host.rsplit_once(':')
                    .is_some_and(|(_, port)| port.parse::<u16>().is_ok())
            }))
    {
        return Some(format!("https://{value}"));
    }
    Some(format!(
        "https://www.google.com/search?q={}",
        url_encode(value)
    ))
}

fn has_scheme(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once(':') else {
        return false;
    };
    !scheme.is_empty()
        && scheme.chars().enumerate().all(|(index, character)| {
            if index == 0 {
                character.is_ascii_alphabetic()
            } else {
                character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
            }
        })
}

fn is_downloadable_url(value: &str) -> bool {
    url::Url::parse(value)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https" | "file" | "data" | "blob"))
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn cell_center_point(
    column: u32,
    row: u32,
    cols: u32,
    rows: u32,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let x = (f64::from(column.max(1)) - 0.5) * width / f64::from(cols.max(1));
    let y = (f64::from(row.max(1)) - 0.5) * height / f64::from(rows.max(1));
    (
        x.clamp(0.0, (width - 1.0).max(0.0)),
        y.clamp(0.0, (height - 1.0).max(0.0)),
    )
}

#[derive(Clone, Copy)]
struct NativeMouseInput {
    code: u32,
    column: u32,
    row: u32,
    release: bool,
    cancelled: bool,
    probe: bool,
    click_count: isize,
    viewport: Viewport,
}

#[cfg(target_os = "macos")]
fn dispatch_native_mouse(window: &WebviewWindow, input: NativeMouseInput) {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::NSPoint;
    use objc2_web_kit::WKWebView;
    use std::sync::atomic::{AtomicIsize, Ordering as AtomicOrdering};
    use std::sync::OnceLock;
    use std::time::Instant;

    static EVENT_NUMBER: AtomicIsize = AtomicIsize::new(1);
    static EVENT_CLOCK: OnceLock<Instant> = OnceLock::new();

    let _ = window.with_webview(move |platform| unsafe {
        let webview = &*(platform.inner() as *mut WKWebView);
        let bounds = webview.bounds();
        let (x, y) = cell_center_point(
            input.column,
            input.row,
            input.viewport.cols,
            input.viewport.rows,
            bounds.size.width,
            bounds.size.height,
        );
        let local_point = NSPoint::new(x, y);
        let location = webview.convertPoint_toView(local_point, None);
        let Some(native_window) = webview.window() else {
            return;
        };
        let motion = input.code & 32 != 0;
        let button = input.code & 3;
        let event_type = if input.cancelled {
            NSEventType::MouseCancelled
        } else if motion {
            match button {
                0 => NSEventType::LeftMouseDragged,
                1 => NSEventType::OtherMouseDragged,
                2 => NSEventType::RightMouseDragged,
                _ => NSEventType::MouseMoved,
            }
        } else if input.release {
            match button {
                0 => NSEventType::LeftMouseUp,
                1 => NSEventType::OtherMouseUp,
                2 => NSEventType::RightMouseUp,
                _ => NSEventType::MouseMoved,
            }
        } else {
            match button {
                0 => NSEventType::LeftMouseDown,
                1 => NSEventType::OtherMouseDown,
                2 => NSEventType::RightMouseDown,
                _ => NSEventType::MouseMoved,
            }
        };
        let mut modifiers = NSEventModifierFlags::empty();
        if input.probe || input.code & 4 != 0 {
            modifiers.insert(NSEventModifierFlags::Shift);
        }
        if input.probe || input.code & 8 != 0 {
            modifiers.insert(NSEventModifierFlags::Option);
        }
        if input.probe || input.code & 16 != 0 {
            modifiers.insert(NSEventModifierFlags::Control);
        }
        if input.probe {
            modifiers.insert(NSEventModifierFlags::Command);
        }
        let timestamp = EVENT_CLOCK.get_or_init(Instant::now).elapsed().as_secs_f64();
        let event_number = EVENT_NUMBER.fetch_add(1, AtomicOrdering::Relaxed);
        let Some(event) = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            event_type,
            location,
            modifiers,
            timestamp,
            native_window.windowNumber(),
            None,
            event_number,
            if motion || input.cancelled { 0 } else { input.click_count },
            if input.release || input.cancelled { 0.0 } else { 1.0 },
        ) else {
            return;
        };
        match event_type {
            NSEventType::LeftMouseDown => webview.mouseDown(&event),
            NSEventType::LeftMouseUp => webview.mouseUp(&event),
            NSEventType::RightMouseDown => webview.rightMouseDown(&event),
            NSEventType::RightMouseUp => webview.rightMouseUp(&event),
            NSEventType::OtherMouseDown => webview.otherMouseDown(&event),
            NSEventType::OtherMouseUp => webview.otherMouseUp(&event),
            NSEventType::LeftMouseDragged => webview.mouseDragged(&event),
            NSEventType::RightMouseDragged => webview.rightMouseDragged(&event),
            NSEventType::OtherMouseDragged => webview.otherMouseDragged(&event),
            NSEventType::MouseCancelled => webview.mouseCancelled(&event),
            _ => webview.mouseMoved(&event),
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn dispatch_native_mouse(_window: &WebviewWindow, _input: NativeMouseInput) {}

fn dispatch_key(
    window: &WebviewWindow,
    key: &str,
    modifier_mask: u32,
    event_kind: u32,
    text: Option<&str>,
) {
    let bits = modifier_mask.saturating_sub(1);
    let payload = json!({
        "key": key,
        "code": "",
        "event": if event_kind == 3 { "keyup" } else { "keydown" },
        "text": text,
        "shiftKey": bits & 1 != 0,
        "altKey": bits & 2 != 0,
        "ctrlKey": bits & 4 != 0,
        "metaKey": bits & (8 | 32) != 0,
        "synthesizeKeyUp": event_kind == 1,
    });
    let _ = window.eval(format!("window.__twebTerminalKey?.({payload})"));
}

#[cfg(target_os = "macos")]
fn native_key_data(key: &str, text: Option<&str>) -> (String, u16) {
    use objc2_app_kit::{
        NSDeleteFunctionKey, NSDownArrowFunctionKey, NSEndFunctionKey, NSHomeFunctionKey,
        NSInsertFunctionKey, NSLeftArrowFunctionKey, NSPageDownFunctionKey, NSPageUpFunctionKey,
        NSRightArrowFunctionKey, NSUpArrowFunctionKey,
    };

    let special = match key {
        "Escape" => Some(('\u{1b}', 53)),
        "Enter" => Some(('\r', 36)),
        "Tab" => Some(('\t', 48)),
        "Backspace" => Some(('\u{8}', 51)),
        "Delete" => char::from_u32(NSDeleteFunctionKey).map(|value| (value, 117)),
        "Insert" => char::from_u32(NSInsertFunctionKey).map(|value| (value, 114)),
        "ArrowLeft" => char::from_u32(NSLeftArrowFunctionKey).map(|value| (value, 123)),
        "ArrowRight" => char::from_u32(NSRightArrowFunctionKey).map(|value| (value, 124)),
        "ArrowDown" => char::from_u32(NSDownArrowFunctionKey).map(|value| (value, 125)),
        "ArrowUp" => char::from_u32(NSUpArrowFunctionKey).map(|value| (value, 126)),
        "Home" => char::from_u32(NSHomeFunctionKey).map(|value| (value, 115)),
        "End" => char::from_u32(NSEndFunctionKey).map(|value| (value, 119)),
        "PageUp" => char::from_u32(NSPageUpFunctionKey).map(|value| (value, 116)),
        "PageDown" => char::from_u32(NSPageDownFunctionKey).map(|value| (value, 121)),
        _ => None,
    };
    if let Some((character, code)) = special {
        return (character.to_string(), code);
    }

    let value = text.filter(|value| !value.is_empty()).unwrap_or(key);
    let code = match key.to_ascii_lowercase().as_str() {
        "a" => 0,
        "s" => 1,
        "d" => 2,
        "f" => 3,
        "h" => 4,
        "g" => 5,
        "z" => 6,
        "x" => 7,
        "c" => 8,
        "v" => 9,
        "b" => 11,
        "q" => 12,
        "w" => 13,
        "e" => 14,
        "r" => 15,
        "y" => 16,
        "t" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "=" => 24,
        "9" => 25,
        "7" => 26,
        "-" => 27,
        "8" => 28,
        "0" => 29,
        "]" => 30,
        "o" => 31,
        "u" => 32,
        "[" => 33,
        "i" => 34,
        "p" => 35,
        "l" => 37,
        "j" => 38,
        "'" => 39,
        "k" => 40,
        ";" => 41,
        "\\" => 42,
        "," => 43,
        "/" => 44,
        "n" => 45,
        "m" => 46,
        "." => 47,
        " " => 49,
        "`" => 50,
        _ => 0,
    };
    (value.to_string(), code)
}

#[cfg(target_os = "macos")]
fn focus_native_input(window: &WebviewWindow) {
    use objc2_web_kit::WKWebView;
    let _ = window.with_webview(|platform| unsafe {
        let webview = &*(platform.inner() as *mut WKWebView);
        if let Some(native_window) = webview.window() {
            native_window.makeFirstResponder(Some(webview));
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn focus_native_input(_window: &WebviewWindow) {}

#[cfg(target_os = "macos")]
fn dispatch_native_key(
    window: &WebviewWindow,
    key: &str,
    modifier_mask: u32,
    event_kind: u32,
    text: Option<&str>,
) {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{NSPoint, NSString};
    use objc2_web_kit::WKWebView;
    use std::sync::OnceLock;
    use std::time::Instant;

    static EVENT_CLOCK: OnceLock<Instant> = OnceLock::new();

    let (characters, key_code) = native_key_data(key, text);
    let bits = modifier_mask.saturating_sub(1);
    let synthesize_key_up = event_kind == 1;
    let event_type = if event_kind == 3 {
        NSEventType::KeyUp
    } else {
        NSEventType::KeyDown
    };
    let _ = window.with_webview(move |platform| unsafe {
        let webview = &*(platform.inner() as *mut WKWebView);
        let Some(native_window) = webview.window() else {
            return;
        };
        let mut modifiers = NSEventModifierFlags::empty();
        if bits & 1 != 0 {
            modifiers.insert(NSEventModifierFlags::Shift);
        }
        if bits & 2 != 0 {
            modifiers.insert(NSEventModifierFlags::Option);
        }
        if bits & 4 != 0 {
            modifiers.insert(NSEventModifierFlags::Control);
        }
        if bits & (8 | 32) != 0 {
            modifiers.insert(NSEventModifierFlags::Command);
        }
        let characters = NSString::from_str(&characters);
        let timestamp = EVENT_CLOCK.get_or_init(Instant::now).elapsed().as_secs_f64();
        let make_event = |event_type| {
            NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                event_type,
                NSPoint::new(0.0, 0.0),
                modifiers,
                timestamp,
                native_window.windowNumber(),
                None,
                &characters,
                &characters,
                false,
                key_code,
            )
        };
        if let Some(event) = make_event(event_type) {
            if event_type == NSEventType::KeyUp {
                webview.keyUp(&event);
            } else {
                webview.keyDown(&event);
            }
        }
        if synthesize_key_up {
            if let Some(event) = make_event(NSEventType::KeyUp) {
                webview.keyUp(&event);
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn dispatch_native_key(
    window: &WebviewWindow,
    key: &str,
    modifier_mask: u32,
    event_kind: u32,
    text: Option<&str>,
) {
    dispatch_key(window, key, modifier_mask, event_kind, text);
}

#[cfg(target_os = "macos")]
fn go_back(window: &WebviewWindow) {
    use objc2_web_kit::WKWebView;
    let _ = window.with_webview(|platform| unsafe {
        let webview = &*(platform.inner() as *mut WKWebView);
        let _ = webview.goBack();
    });
}

#[cfg(not(target_os = "macos"))]
fn go_back(_window: &WebviewWindow) {}

#[cfg(target_os = "macos")]
fn go_forward(window: &WebviewWindow) {
    use objc2_web_kit::WKWebView;
    let _ = window.with_webview(|platform| unsafe {
        let webview = &*(platform.inner() as *mut WKWebView);
        let _ = webview.goForward();
    });
}

#[cfg(not(target_os = "macos"))]
fn go_forward(_window: &WebviewWindow) {}

#[cfg(target_os = "macos")]
fn set_native_zoom(window: &WebviewWindow, zoom: f64) -> Option<f64> {
    use objc2_web_kit::WKWebView;
    use std::sync::mpsc;

    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .with_webview(move |platform| unsafe {
            let webview = &*(platform.inner() as *mut WKWebView);
            webview.setPageZoom(zoom);
            let _ = sender.send(webview.pageZoom());
        })
        .ok()?;
    receiver.recv().ok()
}

#[cfg(not(target_os = "macos"))]
fn set_native_zoom(_window: &WebviewWindow, _zoom: f64) -> Option<f64> {
    None
}

fn request_keyboard_mode_restore() {
    let Ok(pid) = std::env::var("TWEB_FRONTEND_PID")
        .unwrap_or_default()
        .parse::<i32>()
    else {
        return;
    };
    if pid > 1 {
        unsafe { libc::kill(pid, libc::SIGUSR1) };
    }
}

#[cfg(target_os = "macos")]
fn copy_text(text: &str) {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;
    unsafe {
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        pasteboard.setString_forType(&NSString::from_str(text), NSPasteboardTypeString);
    }
}

#[cfg(not(target_os = "macos"))]
fn copy_text(_text: &str) {}

#[cfg(target_os = "macos")]
fn read_text() -> Option<String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    unsafe {
        NSPasteboard::generalPasteboard()
            .stringForType(NSPasteboardTypeString)
            .map(|value| value.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn read_text() -> Option<String> {
    None
}

#[derive(Clone, Copy)]
struct ImageRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl ImageRect {
    fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            x: value.get("x")?.as_f64()?.max(0.0),
            y: value.get("y")?.as_f64()?.max(0.0),
            width: value.get("width")?.as_f64()?.max(1.0),
            height: value.get("height")?.as_f64()?.max(1.0),
        })
    }
}

#[derive(Clone, Copy)]
struct CssPoint {
    x: f64,
    y: f64,
}

impl CssPoint {
    fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            x: value.get("x")?.as_f64()?.max(0.0),
            y: value.get("y")?.as_f64()?.max(0.0),
        })
    }
}

#[derive(Clone, Copy)]
struct CssDrag {
    from: CssPoint,
    to: CssPoint,
}

impl CssDrag {
    fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            from: CssPoint::from_value(value.get("from")?)?,
            to: CssPoint::from_value(value.get("to")?)?,
        })
    }
}

#[cfg(target_os = "macos")]
fn dispatch_native_hover(window: &WebviewWindow, point: CssPoint) {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::NSPoint;
    use objc2_web_kit::WKWebView;
    use std::sync::atomic::{AtomicIsize, Ordering as AtomicOrdering};
    use std::sync::OnceLock;
    use std::time::Instant;

    static EVENT_NUMBER: AtomicIsize = AtomicIsize::new(1);
    static EVENT_CLOCK: OnceLock<Instant> = OnceLock::new();

    let _ = window.with_webview(move |platform| unsafe {
        let webview = &*(platform.inner() as *mut WKWebView);
        let bounds = webview.bounds();
        let local_point = NSPoint::new(
            point.x.clamp(0.0, (bounds.size.width - 1.0).max(0.0)),
            point.y.clamp(0.0, (bounds.size.height - 1.0).max(0.0)),
        );
        let location = webview.convertPoint_toView(local_point, None);
        let Some(native_window) = webview.window() else {
            return;
        };
        let event_number = EVENT_NUMBER.fetch_add(1, AtomicOrdering::Relaxed);
        let timestamp = EVENT_CLOCK.get_or_init(Instant::now).elapsed().as_secs_f64();
        let Some(event) = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::MouseMoved,
            location,
            NSEventModifierFlags::empty(),
            timestamp,
            native_window.windowNumber(),
            None,
            event_number,
            0,
            0.0,
        ) else {
            return;
        };
        webview.mouseMoved(&event);
    });
}

#[cfg(not(target_os = "macos"))]
fn dispatch_native_hover(_window: &WebviewWindow, _point: CssPoint) {}

#[cfg(target_os = "macos")]
fn dispatch_native_click(window: &WebviewWindow, point: CssPoint) {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::NSPoint;
    use objc2_web_kit::WKWebView;
    use std::sync::atomic::{AtomicIsize, Ordering as AtomicOrdering};
    use std::sync::OnceLock;
    use std::time::Instant;

    static EVENT_NUMBER: AtomicIsize = AtomicIsize::new(1);
    static EVENT_CLOCK: OnceLock<Instant> = OnceLock::new();

    let _ = window.with_webview(move |platform| unsafe {
        let webview = &*(platform.inner() as *mut WKWebView);
        let bounds = webview.bounds();
        let local_point = NSPoint::new(
            point.x.clamp(0.0, (bounds.size.width - 1.0).max(0.0)),
            point.y.clamp(0.0, (bounds.size.height - 1.0).max(0.0)),
        );
        let location = webview.convertPoint_toView(local_point, None);
        let Some(native_window) = webview.window() else {
            return;
        };
        let timestamp = EVENT_CLOCK.get_or_init(Instant::now).elapsed().as_secs_f64();
        for event_type in [
            NSEventType::MouseMoved,
            NSEventType::LeftMouseDown,
            NSEventType::LeftMouseUp,
        ] {
            let event_number = EVENT_NUMBER.fetch_add(1, AtomicOrdering::Relaxed);
            let Some(event) = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                event_type,
                location,
                NSEventModifierFlags::empty(),
                timestamp,
                native_window.windowNumber(),
                None,
                event_number,
                if event_type == NSEventType::MouseMoved { 0 } else { 1 },
                if event_type == NSEventType::LeftMouseDown { 1.0 } else { 0.0 },
            ) else {
                continue;
            };
            match event_type {
                NSEventType::LeftMouseDown => webview.mouseDown(&event),
                NSEventType::LeftMouseUp => webview.mouseUp(&event),
                _ => webview.mouseMoved(&event),
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn dispatch_native_click(_window: &WebviewWindow, _point: CssPoint) {}

#[cfg(target_os = "macos")]
fn dispatch_native_drag(window: &WebviewWindow, drag: CssDrag) {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::NSPoint;
    use objc2_web_kit::WKWebView;
    use std::sync::atomic::{AtomicIsize, Ordering as AtomicOrdering};
    use std::sync::OnceLock;
    use std::time::Instant;

    static EVENT_NUMBER: AtomicIsize = AtomicIsize::new(1);
    static EVENT_CLOCK: OnceLock<Instant> = OnceLock::new();

    let _ = window.with_webview(move |platform| unsafe {
        let webview = &*(platform.inner() as *mut WKWebView);
        let bounds = webview.bounds();
        let clamp = |point: CssPoint| {
            NSPoint::new(
                point.x.clamp(0.0, (bounds.size.width - 1.0).max(0.0)),
                point.y.clamp(0.0, (bounds.size.height - 1.0).max(0.0)),
            )
        };
        let start = clamp(drag.from);
        let end = clamp(drag.to);
        let points = [
            start,
            NSPoint::new(
                start.x + (end.x - start.x) * 0.34,
                start.y + (end.y - start.y) * 0.34,
            ),
            NSPoint::new(
                start.x + (end.x - start.x) * 0.67,
                start.y + (end.y - start.y) * 0.67,
            ),
            end,
        ];
        let Some(native_window) = webview.window() else {
            return;
        };
        let timestamp = EVENT_CLOCK.get_or_init(Instant::now).elapsed().as_secs_f64();
        let events = [
            (NSEventType::MouseMoved, points[0]),
            (NSEventType::LeftMouseDown, points[0]),
            (NSEventType::LeftMouseDragged, points[1]),
            (NSEventType::LeftMouseDragged, points[2]),
            (NSEventType::LeftMouseDragged, points[3]),
            (NSEventType::LeftMouseUp, points[3]),
        ];
        for (event_type, point) in events {
            let location = webview.convertPoint_toView(point, None);
            let event_number = EVENT_NUMBER.fetch_add(1, AtomicOrdering::Relaxed);
            let Some(event) = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                event_type,
                location,
                NSEventModifierFlags::empty(),
                timestamp,
                native_window.windowNumber(),
                None,
                event_number,
                if event_type == NSEventType::MouseMoved { 0 } else { 1 },
                if matches!(event_type, NSEventType::LeftMouseDown | NSEventType::LeftMouseDragged) { 1.0 } else { 0.0 },
            ) else {
                continue;
            };
            match event_type {
                NSEventType::LeftMouseDown => webview.mouseDown(&event),
                NSEventType::LeftMouseDragged => webview.mouseDragged(&event),
                NSEventType::LeftMouseUp => webview.mouseUp(&event),
                _ => webview.mouseMoved(&event),
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn dispatch_native_drag(_window: &WebviewWindow, _drag: CssDrag) {}

#[cfg(target_os = "macos")]
fn copy_image(window: &WebviewWindow, rect: ImageRect) {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeTIFF};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::NSError;
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    let _ = window.with_webview(move |platform| unsafe {
        let webview = &*(platform.inner() as *mut WKWebView);
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let configuration = WKSnapshotConfiguration::new(mtm);
        configuration.setRect(CGRect::new(
            CGPoint::new(rect.x, rect.y),
            CGSize::new(rect.width, rect.height),
        ));
        let callback = RcBlock::new(
            move |image: *mut objc2_app_kit::NSImage, error: *mut NSError| {
                if !error.is_null() || image.is_null() {
                    return;
                }
                let Some(data) = image.as_ref().and_then(|value| value.TIFFRepresentation()) else {
                    return;
                };
                let pasteboard = NSPasteboard::generalPasteboard();
                pasteboard.clearContents();
                pasteboard.setData_forType(Some(&data), NSPasteboardTypeTIFF);
            },
        );
        webview.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &callback);
    });
}

#[cfg(not(target_os = "macos"))]
fn copy_image(_window: &WebviewWindow, _rect: ImageRect) {}

#[cfg(test)]
mod tests {
    use super::{
        cell_center_point, normalize_omnibox_input, normalize_url, parse_bridge_url, MouseState,
        DOUBLE_CLICK_INTERVAL,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn maps_terminal_cells_to_webview_centers() {
        assert_eq!(cell_center_point(1, 1, 80, 24, 800.0, 480.0), (5.0, 10.0));
        assert_eq!(
            cell_center_point(80, 24, 80, 24, 800.0, 480.0),
            (795.0, 470.0)
        );
        assert_eq!(cell_center_point(0, 0, 80, 24, 800.0, 480.0), (5.0, 10.0));
        assert_eq!(
            cell_center_point(999, 999, 80, 24, 800.0, 480.0),
            (799.0, 479.0)
        );
    }

    #[test]
    fn counts_nearby_mouse_presses_as_double_clicks() {
        let mut mouse = MouseState::default();
        let start = Instant::now();
        assert_eq!(mouse.begin_press(0, 10, 20, start), 1);
        assert_eq!(mouse.end_press(0), (false, 1));
        assert_eq!(
            mouse.begin_press(0, 11, 20, start + Duration::from_millis(100)),
            2
        );
        assert_eq!(mouse.end_press(0), (false, 2));
        let expired =
            start + Duration::from_millis(100) + DOUBLE_CLICK_INTERVAL + Duration::from_millis(1);
        assert_eq!(mouse.begin_press(0, 11, 20, expired), 1);
        assert_eq!(mouse.end_press(0), (false, 1));
        assert_eq!(
            mouse.begin_press(2, 11, 20, expired + Duration::from_millis(1)),
            1
        );
    }

    #[test]
    fn handles_hover_drag_mismatch_and_reset_safely() {
        let mut mouse = MouseState::default();
        let start = Instant::now();
        mouse.move_pointer(3, 50, 50);
        assert_eq!(mouse.end_press(0), (false, 1));

        assert_eq!(mouse.begin_press(0, 10, 20, start), 1);
        mouse.move_pointer(0, 12, 20);
        assert_eq!(mouse.end_press(0), (true, 1));
        assert_eq!(
            mouse.begin_press(0, 10, 20, start + Duration::from_millis(100)),
            1
        );
        assert_eq!(mouse.end_press(2), (false, 1));
        assert_eq!(
            mouse.begin_press(0, 10, 20, start + Duration::from_millis(200)),
            1
        );
        mouse.reset();
        mouse.move_pointer(0, 30, 20);
        assert_eq!(
            mouse.begin_press(0, 10, 20, start + Duration::from_millis(300)),
            1
        );
    }

    #[test]
    fn normalizes_urls_and_searches() {
        assert_eq!(normalize_url("example.com"), "https://example.com");
        assert_eq!(normalize_url("localhost:3000"), "http://localhost:3000");
        assert_eq!(normalize_url("about:blank"), "about:blank");
        assert_eq!(
            normalize_url("/private/tmp/TWeb 계획 #1.html"),
            "file:///private/tmp/TWeb%20%EA%B3%84%ED%9A%8D%20%231.html"
        );
        assert_eq!(
            normalize_omnibox_input("two words").as_deref(),
            Some("https://www.google.com/search?q=two%20words")
        );
        assert!(normalize_omnibox_input(" ").is_none());
    }

    #[test]
    fn parses_authenticated_bridge_navigation() {
        let url = "tweb-action://abc123/?payload=%7B%22action%22%3A%22new-tab%22%2C%22value%22%3A%22https%3A%2F%2Fexample.com%22%7D"
            .parse()
            .unwrap();
        let action = parse_bridge_url(&url).unwrap();
        assert_eq!(action.token, "abc123");
        assert_eq!(action.action, "new-tab");
        assert_eq!(action.value, "https://example.com");
        assert!(parse_bridge_url(&"https://example.com".parse().unwrap()).is_none());
    }
}
