// Views, commands and the callbacks the delegates forward. Everything here runs on the main
// thread: commands arrive on a reader thread and are dispatched to the main queue, which the
// NSApplication run loop services.

use crate::delegates::{
    DownloadDelegate, NavigationDelegate, ScriptHandler, TwebWindow, UiDelegate,
};
use crate::input;
use crate::pixels::{self, Capture, ChannelOrder, Job};
use crate::protocol::{emit, log, profile, Command};
use block2::{DynBlock, RcBlock};
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject, Sel};
use objc2::{msg_send, sel, MainThreadMarker, MainThreadOnly, Message};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSImage, NSScreen,
    NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_foundation::{
    NSArray, NSData, NSDictionary, NSError, NSJSONSerialization, NSJSONWritingOptions, NSPoint,
    NSProgressReporting, NSRect, NSSize, NSString, NSURLRequest, NSURLResponse, NSURL,
};
use objc2_web_kit::{
    WKContentWorld, WKDownload, WKNavigationAction, WKOpenPanelParameters, WKScriptMessage,
    WKSnapshotConfiguration, WKUserContentController, WKUserScript, WKUserScriptInjectionTime,
    WKWebView, WKWebViewConfiguration, WKWindowFeatures,
};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const TWEB_WORLD: &str = "tweb";
// Handlers: the preload's channel lives in its own world; the audio and console probes run in
// the page's world, where the things they watch are.
const IPC_HANDLER: &str = "twebIpc";
const PAGE_HANDLER: &str = "twebPage";
// Ids the host gives popups WebKit opens on its own, apart from the ones Electron assigns.
const POPUP_ID_BASE: u32 = 1 << 30;
// How often the page's title, url and history are read for changes.
const STATE_POLL: Duration = Duration::from_millis(200);
// How long a view must go without input, a navigation or a changed picture before it is quiet,
// and how much smaller a quiet view's pictures are.
//
// WebKit has no paint event, so an idle page is found unchanged only by taking its picture: at
// main.cjs's idle rate (4/s) that measured 4% CPU on a static Retina page — the host's copy and
// diff, WebKit's GPU process rendering the snapshot, and the page process — where Electron, told
// when something paints, spends nothing.
//
// Taking those pictures less often was tried first and is the wrong trade: at once a second, a
// change the page made on its own (a message arriving) reached the pane 770ms late, against
// Electron's 34. So a quiet view is still looked at at its rate, but at a quarter of the width —
// measured 0.6% CPU against 1.8% for the full picture — and only a probe that differs from the
// last one asks for the full picture. A page that keeps changing never goes quiet.
const QUIET_AFTER: Duration = Duration::from_secs(2);
const PROBE_SCALE: f64 = 0.25;
const DOWNLOAD_POLL: Duration = Duration::from_millis(500);

struct View {
    window: Retained<TwebWindow>,
    webview: Retained<WKWebView>,
    /// The latest `WKFrameInfo` per subframe, by the frame's id: what an eval into that frame
    /// is addressed with. Refreshed by every message the frame sends.
    frames: HashMap<u64, Retained<objc2_web_kit::WKFrameInfo>>,
    painting: bool,
    rate: f64,
    force: bool,
    in_flight: bool,
    last_snapshot: Option<Instant>,
    /// The last input, navigation, page message or resize: anything after which the picture is
    /// likely to change soon.
    last_activity: Instant,
    /// The last quiet-mode probe's hash; None while the view is lively.
    probe_hash: Option<u64>,
    held_button: Option<u32>,
    last_state: Value,
    open_panel: Option<RcBlock<dyn Fn(*mut NSArray<NSURL>)>>,
    focus_hold: Option<Retained<AnyObject>>,
}

struct Download {
    download: Retained<WKDownload>,
    view: u32,
    destination: Option<RcBlock<dyn Fn(*mut NSURL)>>,
    path: Option<String>,
    last_received: i64,
}

struct Shared {
    handler: Retained<ScriptHandler>,
    navigation: Retained<NavigationDelegate>,
    ui: Retained<UiDelegate>,
    downloads: Retained<DownloadDelegate>,
    controller: Option<Retained<WKUserContentController>>,
    application_name: Option<String>,
}

#[derive(Default)]
struct State {
    shared: Option<Shared>,
    views: HashMap<u32, View>,
    by_webview: HashMap<usize, u32>,
    downloads: HashMap<u64, Download>,
    download_by_ptr: HashMap<usize, u64>,
    next_download: u64,
    next_popup: u32,
    last_state_poll: Option<Instant>,
    last_download_poll: Option<Instant>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|state| f(&mut state.borrow_mut()))
}

fn marker() -> MainThreadMarker {
    MainThreadMarker::new().expect("runs on the main thread")
}

fn webview_of(view: u32) -> Option<Retained<WKWebView>> {
    with_state(|state| state.views.get(&view).map(|v| v.webview.clone()))
}

pub fn view_id(webview: &WKWebView) -> Option<u32> {
    let key = webview as *const WKWebView as usize;
    with_state(|state| state.by_webview.get(&key).copied())
}

pub fn run() {
    let mtm = marker();
    let app = NSApplication::sharedApplication(mtm);
    // No Dock icon, no menu bar, and never active: the terminal keeps focus.
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    with_state(|state| {
        state.shared = Some(Shared {
            handler: ScriptHandler::new(mtm),
            navigation: NavigationDelegate::new(mtm),
            ui: UiDelegate::new(mtm),
            downloads: DownloadDelegate::new(mtm),
            controller: None,
            application_name: None,
        });
        state.next_popup = POPUP_ID_BASE;
    });
    pixels::start();
    spawn_reader();
    spawn_ticker();
    emit(json!({ "ev": "ready", "pid": std::process::id() }));
    app.run();
}

fn spawn_reader() {
    std::thread::Builder::new()
        .name("tweb-webkit-stdin".into())
        .spawn(|| {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Command>(&line) {
                    Ok(command) => DispatchQueue::main().exec_async(move || handle(command)),
                    Err(error) => log(format!("bad command {error}: {line}")),
                }
            }
            // The engine is gone: nothing can see these pages any more.
            std::process::exit(0);
        })
        .expect("stdin thread starts");
}

/// The snapshot clock. One tick per 8ms looks at every view and takes the snapshots that are
/// due; a tick still queued is not queued again, so a busy main thread is not flooded.
fn spawn_ticker() {
    static QUEUED: AtomicBool = AtomicBool::new(false);
    std::thread::Builder::new()
        .name("tweb-webkit-tick".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_millis(8));
            if QUEUED.swap(true, Ordering::AcqRel) {
                continue;
            }
            DispatchQueue::main().exec_async(|| {
                QUEUED.store(false, Ordering::Release);
                tick();
            });
        })
        .expect("tick thread starts");
}

fn tick() {
    let now = Instant::now();
    let due: Vec<(u32, bool)> = with_state(|state| {
        let mut due = Vec::new();
        for (id, view) in state.views.iter_mut() {
            if !view.painting || view.in_flight {
                continue;
            }
            if view.force {
                due.push((*id, false));
                continue;
            }
            let interval = Duration::from_secs_f64(1.0 / view.rate.max(0.5));
            if view
                .last_snapshot
                .is_some_and(|at| now.duration_since(at) < interval)
            {
                continue;
            }
            let lively = pixels::last_change(*id).map_or(view.last_activity, |changed| {
                changed.max(view.last_activity)
            });
            let quiet = is_quiet(now.saturating_duration_since(lively));
            if !quiet {
                view.probe_hash = None;
            }
            due.push((*id, quiet));
        }
        due
    });
    for (view, quiet) in due {
        if quiet {
            probe(view);
        } else {
            snapshot(view);
        }
    }
    let poll_state = with_state(|state| {
        let due = state
            .last_state_poll
            .is_none_or(|at| now.duration_since(at) >= STATE_POLL);
        if due {
            state.last_state_poll = Some(now);
        }
        due
    });
    if poll_state {
        poll_page_state();
    }
    let poll_downloads = with_state(|state| {
        let due = !state.downloads.is_empty()
            && state
                .last_download_poll
                .is_none_or(|at| now.duration_since(at) >= DOWNLOAD_POLL);
        if due {
            state.last_download_poll = Some(now);
        }
        due
    });
    if poll_downloads {
        poll_download_progress();
    }
}

/// Whether a view that has been without input, navigation or a changed picture this long is
/// looked at through probes rather than full pictures.
fn is_quiet(quiet_for: Duration) -> bool {
    quiet_for >= QUIET_AFTER
}

/// A word-at-a-time hash of a probe's bytes. A collision costs one missed change until the next
/// one, not wrong pixels: the full picture is still what reaches the pane.
fn probe_hash(bytes: &[u8]) -> u64 {
    let mut hash = bytes.len() as u64;
    let (words, rest) = bytes.as_chunks::<8>();
    for word in words {
        hash =
            (hash.rotate_left(5) ^ u64::from_le_bytes(*word)).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
    for byte in rest {
        hash = (hash.rotate_left(5) ^ u64::from(*byte)).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
    hash
}

/// A quiet view's cheap look: the page at a quarter of its width, hashed here on the main thread
/// (a 720x450 picture is 1.3MB). A probe that differs from the last one forces the full picture
/// at once and makes the view lively again. The first probe of a quiet spell has nothing to
/// compare with, so it forces one full picture too: a change made after the last full picture
/// and before the spell began would otherwise be taken into the baseline and never shown.
fn probe(view: u32) {
    let mtm = marker();
    let Some((webview, width)) = with_state(|state| {
        let v = state.views.get_mut(&view)?;
        v.in_flight = true;
        v.last_snapshot = Some(Instant::now());
        Some((v.webview.clone(), v.webview.bounds().size.width))
    }) else {
        return;
    };
    let configuration = unsafe { WKSnapshotConfiguration::new(mtm) };
    unsafe {
        configuration.setSnapshotWidth(Some(&objc2_foundation::NSNumber::new_f64(
            (width * PROBE_SCALE).max(1.0),
        )))
    };
    let block = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
        let hash = (!image.is_null())
            .then(|| capture_pixels(unsafe { &*image }))
            .flatten()
            .map(|capture| probe_hash(&capture.bytes));
        with_state(|state| {
            let Some(v) = state.views.get_mut(&view) else {
                return;
            };
            v.in_flight = false;
            let Some(hash) = hash else { return };
            if v.probe_hash != Some(hash) {
                let first = v.probe_hash.is_none();
                v.probe_hash = Some(hash);
                v.force = true;
                if !first {
                    v.last_activity = Instant::now();
                    profile(format!("probe view={view} changed"));
                }
            }
        });
    });
    unsafe {
        webview.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &block)
    };
}

fn mark_active(view: u32) {
    with_state(|state| {
        if let Some(v) = state.views.get_mut(&view) {
            v.last_activity = Instant::now();
        }
    });
}

fn handle(command: Command) {
    if let Some(view) = command.activity_view() {
        mark_active(view);
    }
    match command {
        Command::Init {
            tweb_scripts,
            page_scripts,
            application_name,
        } => init(tweb_scripts, page_scripts, application_name),
        Command::Create {
            view,
            width,
            height,
            scale,
        } => {
            if let Err(error) = create(view, width, height, scale, None) {
                log(format!("view {view} failed: {error}"));
                emit(json!({ "ev": "crash", "view": view }));
            }
        }
        Command::Close { view } => close(view),
        Command::Load { view, url } => load(view, &url),
        Command::Reload { view, ignore_cache } => {
            if let Some(webview) = webview_of(view) {
                unsafe {
                    if ignore_cache {
                        webview.reloadFromOrigin();
                    } else {
                        webview.reload();
                    }
                }
            }
        }
        Command::Stop { view } => {
            if let Some(webview) = webview_of(view) {
                unsafe { webview.stopLoading() };
            }
        }
        Command::Go { view, offset } => go(view, offset),
        Command::Resize {
            view,
            width,
            height,
            scale,
        } => resize(view, width, height, scale),
        Command::Zoom { view, factor } => {
            if let Some(webview) = webview_of(view) {
                unsafe { webview.setPageZoom(factor.clamp(0.25, 5.0)) };
                force_paint(view);
            }
        }
        Command::Eval {
            view,
            req,
            frame,
            world,
            code,
        } => eval(view, req, frame, &world, &code),
        Command::Mouse {
            view,
            kind,
            x,
            y,
            button,
            clicks,
            modifiers,
            dx,
            dy,
        } => mouse(view, &kind, x, y, button, clicks, modifiers, dx, dy),
        Command::Key {
            view,
            kind,
            key,
            code,
            text,
            modifiers,
        } => {
            if let Some(webview) = webview_of(view) {
                input::key(
                    &webview,
                    input::Key {
                        kind: &kind,
                        key: &key,
                        code: &code,
                        text: &text,
                        modifiers,
                    },
                );
            }
        }
        Command::Text { view, text } => {
            if let Some(webview) = webview_of(view) {
                let text = NSString::from_str(&text);
                let _: () = unsafe { msg_send![&*webview, insertText: &*text] };
            }
        }
        Command::Edit { view, name } => edit_command(view, &name),
        Command::Paint { view, on } => with_state(|state| {
            if let Some(v) = state.views.get_mut(&view) {
                v.painting = on;
                v.force |= on;
            }
        }),
        Command::Rate { view, fps } => with_state(|state| {
            if let Some(v) = state.views.get_mut(&view) {
                v.rate = fps.clamp(0.5, 120.0);
            }
        }),
        Command::Invalidate { view } => {
            profile(format!("invalidate view={view}"));
            force_paint(view);
        }
        Command::Capture { view, req, rect } => capture(view, req, rect),
        Command::Pdf { view, req } => pdf(view, req),
        Command::UserAgent { view, ua } => {
            if let Some(webview) = webview_of(view) {
                let ua = ua
                    .filter(|ua| !ua.is_empty())
                    .map(|ua| NSString::from_str(&ua));
                unsafe { webview.setCustomUserAgent(ua.as_deref()) };
            }
        }
        Command::Devtools { view } => devtools(view),
        Command::Focus { view } => focus(view),
        Command::Download { view, url } => start_download(view, &url),
        Command::DownloadDest { dl, path } => download_destination(dl, path),
        Command::DownloadCancel { dl } => {
            let download = with_state(|state| state.downloads.get(&dl).map(|d| d.download.clone()));
            if let Some(download) = download {
                unsafe { download.cancel(None) };
            }
        }
        Command::Chooser { view, paths } => chooser(view, paths),
        Command::Quit => std::process::exit(0),
    }
}

fn init(tweb_scripts: Vec<String>, page_scripts: Vec<String>, application_name: Option<String>) {
    let mtm = marker();
    let controller = unsafe { WKUserContentController::new(mtm) };
    let tweb = unsafe { WKContentWorld::worldWithName(&NSString::from_str(TWEB_WORLD), mtm) };
    let page = unsafe { WKContentWorld::pageWorld(mtm) };
    let handler = with_state(|state| state.shared.as_ref().map(|s| s.handler.clone()))
        .expect("shared delegates exist");
    let handler = ProtocolObject::from_ref(&*handler);
    unsafe {
        controller.addScriptMessageHandler_contentWorld_name(
            handler,
            &tweb,
            &NSString::from_str(IPC_HANDLER),
        );
        controller.addScriptMessageHandler_contentWorld_name(
            handler,
            &page,
            &NSString::from_str(PAGE_HANDLER),
        );
    }
    for (scripts, world) in [(&tweb_scripts, &tweb), (&page_scripts, &page)] {
        for source in scripts {
            let script = unsafe {
                WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
                    WKUserScript::alloc(mtm),
                    &NSString::from_str(source),
                    WKUserScriptInjectionTime::AtDocumentStart,
                    false,
                    world,
                )
            };
            unsafe { controller.addUserScript(&script) };
        }
    }
    with_state(|state| {
        if let Some(shared) = state.shared.as_mut() {
            shared.controller = Some(controller);
            shared.application_name = application_name;
        }
    });
}

fn screen_for_scale(mtm: MainThreadMarker, scale: f64) -> Option<Retained<NSScreen>> {
    let screens = NSScreen::screens(mtm);
    let mut best = None;
    for screen in screens.iter() {
        if (screen.backingScaleFactor() - scale).abs() < 0.01 {
            return Some(screen);
        }
        if best.is_none() {
            best = Some(screen);
        }
    }
    best
}

fn new_window(mtm: MainThreadMarker, width: f64, height: f64, scale: f64) -> Retained<TwebWindow> {
    // On a screen whose backing scale is the pane's, so a snapshot comes out at exactly the
    // pane's pixel size: WebKit renders at the scale of the screen its window is on.
    let origin = screen_for_scale(mtm, scale).map_or(NSPoint::new(0.0, 0.0), |s| s.frame().origin);
    let rect = NSRect::new(origin, NSSize::new(width.max(1.0), height.max(1.0)));
    let window: Retained<TwebWindow> = unsafe {
        msg_send![
            TwebWindow::alloc(mtm),
            initWithContentRect: rect,
            styleMask: NSWindowStyleMask::Borderless,
            backing: NSBackingStoreType::Buffered,
            defer: false
        ]
    };
    unsafe {
        window.setReleasedWhenClosed(false);
        // Present but unseen and untouchable. WebKit throttles a page whose window is ordered out
        // or covered — measured: a covered window's page stopped painting entirely — so the
        // window stays ordered in, above everything, on every Space, and invisible.
        window.setAlphaValue(0.001);
        window.setOpaque(false);
        window.setHasShadow(false);
        window.setIgnoresMouseEvents(true);
        window.setExcludedFromWindowsMenu(true);
        window.setLevel(1000);
        window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    }
    window
}

fn responds(object: &AnyObject, selector: Sel) -> bool {
    unsafe { msg_send![object, respondsToSelector: selector] }
}

/// A view and its window. `configuration` is WebKit's own when it opens a popup (the popup must
/// share its opener's process and `window.opener`); otherwise one is built from the shared
/// scripts.
fn create(
    view: u32,
    width: f64,
    height: f64,
    scale: f64,
    configuration: Option<&WKWebViewConfiguration>,
) -> anyhow::Result<Retained<WKWebView>> {
    let mtm = marker();
    let (controller, navigation, ui, application_name) = with_state(|state| {
        let shared = state.shared.as_ref().expect("shared delegates exist");
        (
            shared.controller.clone(),
            shared.navigation.clone(),
            shared.ui.clone(),
            shared.application_name.clone(),
        )
    });
    let configuration = match configuration {
        Some(configuration) => configuration.retain(),
        None => {
            let controller = controller.ok_or_else(|| anyhow::anyhow!("create before init"))?;
            let configuration = unsafe { WKWebViewConfiguration::new(mtm) };
            unsafe {
                configuration.setUserContentController(&controller);
                configuration
                    .preferences()
                    .setJavaScriptCanOpenWindowsAutomatically(true);
                if let Some(name) = &application_name {
                    configuration.setApplicationNameForUserAgent(Some(&NSString::from_str(name)));
                }
                configuration.setMediaTypesRequiringUserActionForPlayback(
                    objc2_web_kit::WKAudiovisualMediaTypes::None,
                );
            }
            configuration
        }
    };
    let window = new_window(mtm, width, height, scale);
    let frame = NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(width.max(1.0), height.max(1.0)),
    );
    let webview = unsafe {
        WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &configuration)
    };
    unsafe {
        webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*navigation)));
        webview.setUIDelegate(Some(ProtocolObject::from_ref(&*ui)));
        webview.setAllowsBackForwardNavigationGestures(false);
        // Safari's Develop menu can attach to every pane (macOS 13.3+).
        if responds(&webview, sel!(setInspectable:)) {
            webview.setInspectable(true);
        }
        // SPI, used only where it exists: keep the page painting whatever the window server
        // thinks is covering it.
        if responds(&webview, sel!(_setWindowOcclusionDetectionEnabled:)) {
            let _: () = msg_send![&*webview, _setWindowOcclusionDetectionEnabled: Bool::NO];
        }
        window.setContentView(Some(&webview));
        window.orderFrontRegardless();
        window.makeFirstResponder(Some(&webview));
    }
    // SPI: hold the page in the focused-and-active state a key window in an active app has, so
    // `document.hasFocus()` is true and a focused field shows its caret. The returned block
    // releases the hold; it is kept for the life of the view.
    let focus_hold = if responds(&webview, sel!(_retainActiveFocusedState)) {
        let block: *mut AnyObject = unsafe { msg_send![&*webview, _retainActiveFocusedState] };
        unsafe { Retained::retain(block) }
    } else {
        None
    };
    let key = &*webview as *const WKWebView as usize;
    with_state(|state| {
        state.by_webview.insert(key, view);
        state.views.insert(
            view,
            View {
                window,
                webview: webview.clone(),
                frames: HashMap::new(),
                painting: true,
                rate: 30.0,
                force: true,
                in_flight: false,
                last_snapshot: None,
                last_activity: Instant::now(),
                probe_hash: None,
                held_button: None,
                last_state: Value::Null,
                open_panel: None,
                focus_hold,
            },
        );
    });
    emit(json!({ "ev": "created", "view": view }));
    Ok(webview)
}

fn close(view: u32) {
    let removed = with_state(|state| {
        let removed = state.views.remove(&view);
        if let Some(v) = &removed {
            state
                .by_webview
                .remove(&(&*v.webview as *const WKWebView as usize));
        }
        removed
    });
    let Some(view_state) = removed else { return };
    pixels::submit(Job::Forget { view });
    if let Some(panel) = &view_state.open_panel {
        panel.call((std::ptr::null_mut(),));
    }
    unsafe {
        view_state.webview.stopLoading();
        view_state.webview.setNavigationDelegate(None);
        view_state.webview.setUIDelegate(None);
        view_state.window.orderOut(None);
        view_state.window.setContentView(None);
        view_state.window.close();
    }
    if let Some(hold) = view_state.focus_hold {
        // The hold's block releases the focused state when called.
        let block = &*hold as *const AnyObject as *const block2::Block<dyn Fn()>;
        unsafe { (*block).call(()) };
    }
    emit(json!({ "ev": "closed", "view": view }));
}

fn load(view: u32, url: &str) {
    let Some(webview) = webview_of(view) else {
        return;
    };
    let Some(target) = NSURL::URLWithString(&NSString::from_str(url)) else {
        emit(
            json!({ "ev": "nav", "view": view, "phase": "fail", "url": url,
            "code": -300, "error": "ERR_INVALID_URL" }),
        );
        return;
    };
    unsafe {
        if url.starts_with("file:") {
            // A file page may read its neighbours, as it can in Chrome.
            let root = NSURL::fileURLWithPath(&NSString::from_str("/"));
            webview.loadFileURL_allowingReadAccessToURL(&target, &root);
        } else {
            webview.loadRequest(&NSURLRequest::requestWithURL(&target));
        }
    }
}

fn go(view: u32, offset: i64) {
    let Some(webview) = webview_of(view) else {
        return;
    };
    unsafe {
        match offset {
            -1 => {
                webview.goBack();
            }
            1 => {
                webview.goForward();
            }
            _ => {
                let list = webview.backForwardList();
                if let Some(item) = list.itemAtIndex(offset as isize) {
                    webview.goToBackForwardListItem(&item);
                }
            }
        }
    }
}

fn resize(view: u32, width: f64, height: f64, scale: f64) {
    let mtm = marker();
    let Some((window, webview)) = with_state(|state| {
        state
            .views
            .get(&view)
            .map(|v| (v.window.clone(), v.webview.clone()))
    }) else {
        return;
    };
    let size = NSSize::new(width.max(1.0), height.max(1.0));
    if (window.backingScaleFactor() - scale).abs() > 0.01 {
        if let Some(screen) = screen_for_scale(mtm, scale) {
            window.setFrameOrigin(screen.frame().origin);
        }
    }
    window.setContentSize(size);
    webview.setFrameSize(size);

    pixels::submit(Job::Forget { view });
    force_paint(view);
}

fn force_paint(view: u32) {
    with_state(|state| {
        if let Some(v) = state.views.get_mut(&view) {
            v.force = true;
            v.last_activity = Instant::now();
        }
    });
}

fn snapshot(view: u32) {
    let Some(webview) = with_state(|state| {
        let v = state.views.get_mut(&view)?;
        v.in_flight = true;
        v.last_snapshot = Some(Instant::now());
        Some(v.webview.clone())
    }) else {
        return;
    };
    let started = Instant::now();
    let block = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
        let waited = started.elapsed().as_secs_f64() * 1000.0;
        let force = with_state(|state| {
            let v = state.views.get_mut(&view)?;
            v.in_flight = false;
            let force = v.force;
            v.force = false;
            Some(force)
        });
        let Some(force) = force else { return };
        if image.is_null() {
            return;
        }
        let copied = Instant::now();
        if let Some(capture) = capture_pixels(unsafe { &*image }) {
            profile(format!(
                "snapshot view={view} force={force} took={waited:.1}ms copy={:.1}ms",
                copied.elapsed().as_secs_f64() * 1000.0
            ));
            pixels::submit(Job::Paint {
                view,
                capture,
                force,
            });
        }
    });
    unsafe { webview.takeSnapshotWithConfiguration_completionHandler(None, &block) };
}

fn capture(view: u32, req: u64, rect: Option<[f64; 4]>) {
    let Some(webview) = webview_of(view) else {
        pixels::submit(Job::Capture { req, capture: None });
        return;
    };
    let mtm = marker();
    let configuration = unsafe { WKSnapshotConfiguration::new(mtm) };
    if let Some([x, y, width, height]) = rect {
        unsafe {
            configuration.setRect(NSRect::new(NSPoint::new(x, y), NSSize::new(width, height)))
        };
    }
    let block = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
        let capture = (!image.is_null())
            .then(|| capture_pixels(unsafe { &*image }))
            .flatten();
        pixels::submit(Job::Capture { req, capture });
    });
    unsafe {
        webview.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &block)
    };
}

fn pdf(view: u32, req: u64) {
    let Some(webview) = webview_of(view) else {
        pixels::submit(Job::Bytes { req, bytes: None });
        return;
    };
    let block = RcBlock::new(move |data: *mut NSData, _error: *mut NSError| {
        let bytes = (!data.is_null()).then(|| unsafe { (*data).to_vec() });
        pixels::submit(Job::Bytes { req, bytes });
    });
    unsafe { webview.createPDFWithConfiguration_completionHandler(None, &block) };
}

/// The snapshot's bytes, copied out — the only pass over them this thread makes. Everything
/// else is the pixel thread's (see pixels.rs).
fn capture_pixels(image: &NSImage) -> Option<Capture> {
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

#[allow(clippy::too_many_arguments)]
fn mouse(
    view: u32,
    kind: &str,
    x: f64,
    y: f64,
    button: u32,
    clicks: i64,
    modifiers: u32,
    dx: f64,
    dy: f64,
) {
    let Some((webview, held)) = with_state(|state| {
        let v = state.views.get_mut(&view)?;
        let held = v.held_button;
        match kind {
            "down" => v.held_button = Some(button),
            "up" => v.held_button = None,
            _ => {}
        }
        // Input is what a pane is about to show the result of: take the next picture now rather
        // than at the next tick of an idle rate.
        v.force = true;
        Some((v.webview.clone(), held))
    }) else {
        return;
    };
    input::mouse(
        &webview,
        input::Mouse {
            kind,
            x,
            y,
            button,
            clicks,
            modifiers,
            dx,
            dy,
            held,
        },
    );
}

fn edit_command(view: u32, name: &str) {
    let Some(webview) = webview_of(view) else {
        return;
    };
    let selector = match name {
        "copy" => sel!(copy:),
        "cut" => sel!(cut:),
        "paste" => sel!(paste:),
        "pasteAndMatchStyle" => sel!(pasteAsPlainText:),
        "selectAll" => sel!(selectAll:),
        "undo" => sel!(undo:),
        "redo" => sel!(redo:),
        "delete" => sel!(delete:),
        _ => return,
    };
    let none: Option<&AnyObject> = None;
    let _: Bool = unsafe { msg_send![&*webview, tryToPerform: selector, with: none] };
}

fn devtools(view: u32) {
    let Some(webview) = webview_of(view) else {
        return;
    };
    // SPI: the Web Inspector of this view, in a window of its own.
    if responds(&webview, sel!(_inspector)) {
        let inspector: *mut AnyObject = unsafe { msg_send![&*webview, _inspector] };
        if !inspector.is_null() && responds(unsafe { &*inspector }, sel!(show)) {
            let _: () = unsafe { msg_send![inspector, show] };
            return;
        }
    }
    log("this WebKit has no Web Inspector SPI; use Safari > Develop instead");
}

fn focus(view: u32) {
    let Some((window, webview)) = with_state(|state| {
        state
            .views
            .get(&view)
            .map(|v| (v.window.clone(), v.webview.clone()))
    }) else {
        return;
    };
    window.makeFirstResponder(Some(&webview));
}

// --- eval ---------------------------------------------------------------------------------

fn eval(view: u32, req: u64, frame: Option<u64>, world: &str, code: &str) {
    let mtm = marker();
    let Some((webview, frame_info)) = with_state(|state| {
        let v = state.views.get(&view)?;
        Some((
            v.webview.clone(),
            frame.and_then(|id| v.frames.get(&id).cloned()),
        ))
    }) else {
        reply_error(req, "view gone");
        return;
    };
    if frame.is_some() && frame_info.is_none() {
        reply_error(req, "frame gone");
        return;
    }
    let content_world = if world == TWEB_WORLD {
        unsafe { WKContentWorld::worldWithName(&NSString::from_str(TWEB_WORLD), mtm) }
    } else {
        unsafe { WKContentWorld::pageWorld(mtm) }
    };
    // Electron's `executeJavaScript` evaluates a script and resolves a promise it ends in. An
    // async function body that awaits the code as an expression does both; code that is a
    // statement list is not an expression, so a syntax error retries it as a plain script
    // (completion value, no await) — which is what most such code wants anyway.
    let body = NSString::from_str(&format!("return await (\n{code}\n);"));
    let started = Instant::now();
    let fallback = (
        webview.clone(),
        frame_info.clone(),
        content_world.clone(),
        code.to_string(),
    );
    let block = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
        if !error.is_null() {
            let message = js_error(unsafe { &*error });
            if message.contains("SyntaxError") {
                let (webview, frame_info, content_world, code) = fallback.clone();
                eval_script(&webview, frame_info.as_deref(), &content_world, &code, req);
                return;
            }
            reply_error(req, &message);
            return;
        }
        profile(format!(
            "eval req={req} took={:.1}ms",
            started.elapsed().as_secs_f64() * 1000.0
        ));
        reply_value(req, result);
    });
    unsafe {
        webview.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
            &body,
            None,
            frame_info.as_deref(),
            &content_world,
            Some(&block),
        );
    }
}

fn eval_script(
    webview: &WKWebView,
    frame: Option<&objc2_web_kit::WKFrameInfo>,
    world: &WKContentWorld,
    code: &str,
    req: u64,
) {
    let block = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
        if !error.is_null() {
            reply_error(req, &js_error(unsafe { &*error }));
            return;
        }
        reply_value(req, result);
    });
    unsafe {
        webview.evaluateJavaScript_inFrame_inContentWorld_completionHandler(
            &NSString::from_str(code),
            frame,
            world,
            Some(&block),
        );
    }
}

fn js_error(error: &NSError) -> String {
    let info = error.userInfo();
    let key = NSString::from_str("WKJavaScriptExceptionMessage");
    if let Some(message) = info.objectForKey(&key) {
        if let Ok(message) = message.downcast::<NSString>() {
            return message.to_string();
        }
    }
    error.localizedDescription().to_string()
}

fn reply_error(req: u64, message: &str) {
    emit(json!({ "ev": "result", "req": req, "ok": false, "error": message }));
}

/// A JavaScript result as JSON. NSJSONSerialization takes exactly the types WebKit returns
/// (string, number, bool, null, array, dictionary); anything else is reported as null, which is
/// what Electron gives for a value it cannot clone.
fn reply_value(req: u64, result: *mut AnyObject) {
    let value = if result.is_null() {
        Value::Null
    } else {
        let object = unsafe { &*result };
        let wrapped = NSArray::from_slice(&[object]);
        unsafe {
            NSJSONSerialization::dataWithJSONObject_options_error(
                &wrapped,
                NSJSONWritingOptions::empty(),
            )
        }
        .ok()
        .and_then(|data| serde_json::from_slice::<Value>(&data.to_vec()).ok())
        .and_then(|value| value.get(0).cloned())
        .unwrap_or(Value::Null)
    };
    emit(json!({ "ev": "result", "req": req, "ok": true, "value": value }));
}

// --- callbacks from the delegates -----------------------------------------------------------

/// SPI `-[WKFrameInfo _handle].frameID`: a frame's identity across its documents. Without it a
/// frame is known only by the document id its preload made up, which is new on every load.
fn frame_id(frame: &objc2_web_kit::WKFrameInfo) -> Option<u64> {
    let object: &AnyObject = frame.as_ref();
    if !responds(object, sel!(_handle)) {
        return None;
    }
    let handle: *mut AnyObject = unsafe { msg_send![frame, _handle] };
    if handle.is_null() || !responds(unsafe { &*handle }, sel!(frameID)) {
        return None;
    }
    let id: u64 = unsafe { msg_send![handle, frameID] };
    Some(id)
}

pub fn on_script_message(message: &WKScriptMessage) {
    let frame = unsafe { message.frameInfo() };
    let Some(webview) = (unsafe { frame.webView() }) else {
        return;
    };
    let Some(view) = view_id(&webview) else {
        return;
    };
    let main = unsafe { frame.isMainFrame() };
    let fid = frame_id(&frame);
    let url = unsafe { frame.request().URL() }
        .and_then(|url| url.absoluteString())
        .map(|url| url.to_string())
        .unwrap_or_default();
    let body = unsafe { message.body() };
    let Ok(body) = body.downcast::<NSString>() else {
        return;
    };
    let name = unsafe { message.name() }.to_string();
    mark_active(view);
    if !main {
        if let Some(fid) = fid {
            with_state(|state| {
                if let Some(v) = state.views.get_mut(&view) {
                    v.frames.insert(fid, frame.clone());
                }
            });
        }
    }
    emit(json!({
        "ev": "msg", "view": view, "name": name, "main": main, "fid": fid, "url": url,
        "body": body.to_string(),
    }));
}

pub fn on_navigation(webview: &WKWebView, phase: &str, error: Option<&NSError>) {
    let Some(view) = view_id(webview) else { return };
    mark_active(view);
    let url = unsafe { webview.URL() }
        .and_then(|url| url.absoluteString())
        .map(|url| url.to_string())
        .unwrap_or_default();
    if phase == "commit" {
        // The old document's frames went with it.
        with_state(|state| {
            if let Some(v) = state.views.get_mut(&view) {
                v.frames.clear();
                v.force = true;
            }
        });
    }
    let mut event = json!({ "ev": "nav", "view": view, "phase": phase, "url": url });
    if let Some(error) = error {
        event["code"] = json!(error.code());
        event["domain"] = json!(error.domain().to_string());
        event["error"] = json!(error.localizedDescription().to_string());
        // The url that failed, which is not the one the view still shows.
        let key = NSString::from_str("NSErrorFailingURLStringKey");
        if let Some(failed) = error.userInfo().objectForKey(&key) {
            if let Ok(failed) = failed.downcast::<NSString>() {
                event["url"] = json!(failed.to_string());
            }
        }
    }
    emit(event);
    poll_page_state();
}

pub fn on_crash(webview: &WKWebView) {
    if let Some(view) = view_id(webview) {
        emit(json!({ "ev": "crash", "view": view }));
    }
}

pub fn on_page_close(webview: &WKWebView) {
    if let Some(view) = view_id(webview) {
        emit(json!({ "ev": "page-close", "view": view }));
    }
}

pub fn on_dialog(webview: &WKWebView, kind: &str, message: &NSString) {
    if let Some(view) = view_id(webview) {
        emit(json!({ "ev": "dialog", "view": view, "kind": kind, "message": message.to_string() }));
    }
}

pub fn is_attachment(response: &NSURLResponse) -> bool {
    let object: &AnyObject = response.as_ref();
    if !responds(object, sel!(allHeaderFields)) {
        return false;
    }
    let headers: *mut NSDictionary<AnyObject, AnyObject> =
        unsafe { msg_send![response, allHeaderFields] };
    if headers.is_null() {
        return false;
    }
    let key = NSString::from_str("Content-Disposition");
    let value = unsafe { (*headers).objectForKey(&key) };
    value
        .and_then(|value| value.downcast::<NSString>().ok())
        .is_some_and(|value| {
            value
                .to_string()
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("attachment")
        })
}

/// `window.open`, `target=_blank` and middle-clicks. WebKit wants the new view back
/// synchronously, while the decision is main.cjs's and a round trip away. So a popup that asked
/// for a window (it passed features — an OAuth or sign-in flow that needs `window.opener`) is
/// created here and offered to the engine, which adopts or closes it, exactly as the Chrome
/// engine adopts or closes the target Chrome already made. Everything else is a new tab, which
/// main.cjs opens itself: WebKit gets nothing back.
pub fn on_window_open(
    webview: &WKWebView,
    configuration: &WKWebViewConfiguration,
    action: &WKNavigationAction,
    features: &WKWindowFeatures,
) -> Option<Retained<WKWebView>> {
    let opener = view_id(webview)?;
    let url = unsafe { action.request().URL() }
        .and_then(|url| url.absoluteString())
        .map(|url| url.to_string())
        .unwrap_or_default();
    let sized = unsafe { features.width().is_some() || features.height().is_some() };
    let flags = unsafe { action.modifierFlags() };
    let background = unsafe { action.buttonNumber() } == 2
        || flags.contains(objc2_app_kit::NSEventModifierFlags::Command);
    let disposition = if sized {
        "new-window"
    } else if background {
        "background-tab"
    } else {
        "foreground-tab"
    };
    if disposition != "new-window" {
        emit(json!({ "ev": "open", "view": opener, "url": url, "disposition": disposition }));
        return None;
    }
    let (width, height, scale) = with_state(|state| {
        let v = state.views.get(&opener)?;
        let size = v.webview.frame().size;
        Some((size.width, size.height, v.window.backingScaleFactor()))
    })?;
    let id = with_state(|state| {
        state.next_popup += 1;
        state.next_popup
    });
    let popup = create(id, width, height, scale, Some(configuration)).ok()?;
    emit(
        json!({ "ev": "popup", "opener": opener, "view": id, "url": url, "disposition": disposition }),
    );
    Some(popup)
}

pub fn on_open_panel(
    webview: &WKWebView,
    parameters: &WKOpenPanelParameters,
    handler: &DynBlock<dyn Fn(*mut NSArray<NSURL>)>,
) {
    let Some(view) = view_id(webview) else {
        handler.call((std::ptr::null_mut(),));
        return;
    };
    let multiple = unsafe { parameters.allowsMultipleSelection() };
    let directories = unsafe { parameters.allowsDirectories() };
    let previous = with_state(|state| {
        let v = state.views.get_mut(&view)?;
        v.open_panel.replace(handler.copy())
    });
    // A page that opens a second chooser before the first was answered cancels the first.
    if let Some(previous) = previous {
        previous.call((std::ptr::null_mut(),));
    }
    emit(
        json!({ "ev": "chooser", "view": view, "multiple": multiple, "directories": directories }),
    );
}

fn chooser(view: u32, paths: Option<Vec<String>>) {
    let Some(handler) = with_state(|state| state.views.get_mut(&view)?.open_panel.take()) else {
        return;
    };
    match paths.filter(|paths| !paths.is_empty()) {
        Some(paths) => {
            let urls: Vec<Retained<NSURL>> = paths
                .iter()
                .map(|path| NSURL::fileURLWithPath(&NSString::from_str(path)))
                .collect();
            let array = NSArray::from_retained_slice(&urls);
            handler.call((Retained::as_ptr(&array) as *mut NSArray<NSURL>,));
        }
        None => handler.call((std::ptr::null_mut(),)),
    }
}

// --- downloads ----------------------------------------------------------------------------

fn start_download(view: u32, url: &str) {
    let Some(webview) = webview_of(view) else {
        return;
    };
    let Some(target) = NSURL::URLWithString(&NSString::from_str(url)) else {
        return;
    };
    let request = NSURLRequest::requestWithURL(&target);
    let block = RcBlock::new(move |download: std::ptr::NonNull<WKDownload>| {
        let download = unsafe { download.as_ref() };
        register_download(view, download);
    });
    unsafe { webview.startDownloadUsingRequest_completionHandler(&request, &block) };
}

pub fn on_download(webview: &WKWebView, download: &WKDownload) {
    if let Some(view) = view_id(webview) {
        register_download(view, download);
    }
}

fn register_download(view: u32, download: &WKDownload) {
    let delegate = with_state(|state| state.shared.as_ref().map(|s| s.downloads.clone()));
    if let Some(delegate) = delegate {
        unsafe { download.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    }
    with_state(|state| {
        state.next_download += 1;
        let id = state.next_download;
        state
            .download_by_ptr
            .insert(download as *const WKDownload as usize, id);
        state.downloads.insert(
            id,
            Download {
                download: download.retain(),
                view,
                destination: None,
                path: None,
                last_received: -1,
            },
        );
    });
}

fn download_id(download: &WKDownload) -> Option<u64> {
    let key = download as *const WKDownload as usize;
    with_state(|state| state.download_by_ptr.get(&key).copied())
}

pub fn on_download_destination(
    download: &WKDownload,
    response: &NSURLResponse,
    filename: &NSString,
    handler: &DynBlock<dyn Fn(*mut NSURL)>,
) {
    let Some(id) = download_id(download) else {
        handler.call((std::ptr::null_mut(),));
        return;
    };
    let url = unsafe { download.originalRequest() }
        .and_then(|request| request.URL())
        .and_then(|url| url.absoluteString())
        .map(|url| url.to_string())
        .unwrap_or_default();
    let total = response.expectedContentLength();
    let view = with_state(|state| {
        let entry = state.downloads.get_mut(&id)?;
        entry.destination = Some(handler.copy());
        Some(entry.view)
    });
    emit(json!({
        "ev": "download-start", "dl": id, "view": view, "url": url,
        "filename": filename.to_string(), "total": total,
    }));
}

fn download_destination(dl: u64, path: Option<String>) {
    let Some(handler) = with_state(|state| {
        let entry = state.downloads.get_mut(&dl)?;
        entry.path = path.clone();
        entry.destination.take()
    }) else {
        return;
    };
    match path {
        Some(path) => {
            // WebKit refuses to overwrite, and main.cjs has already picked a name it means.
            let _ = std::fs::remove_file(&path);
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path));
            handler.call((Retained::as_ptr(&url) as *mut NSURL,));
        }
        None => handler.call((std::ptr::null_mut(),)),
    }
}

pub fn on_download_end(download: &WKDownload, error: Option<&NSError>) {
    let Some(id) = download_id(download) else {
        return;
    };
    let entry = with_state(|state| {
        state
            .download_by_ptr
            .remove(&(download as *const WKDownload as usize));
        state.downloads.remove(&id)
    });
    let path = entry.and_then(|entry| entry.path);
    let state = match error {
        None => "completed",
        // NSURLErrorCancelled
        Some(error) if error.code() == -999 => "cancelled",
        Some(_) => "interrupted",
    };
    emit(json!({
        "ev": "download-done", "dl": id, "state": state, "path": path,
        "error": error.map(|e| e.localizedDescription().to_string()),
    }));
}

fn poll_download_progress() {
    let entries: Vec<(u64, Retained<WKDownload>)> = with_state(|state| {
        state
            .downloads
            .iter()
            .map(|(id, entry)| (*id, entry.download.clone()))
            .collect()
    });
    for (id, download) in entries {
        let progress = download.progress();
        let received = progress.completedUnitCount();
        let total = progress.totalUnitCount();
        let changed = with_state(|state| {
            let entry = state.downloads.get_mut(&id)?;
            let changed = entry.last_received != received;
            entry.last_received = received;
            Some(changed)
        });
        if changed == Some(true) {
            emit(
                json!({ "ev": "download-progress", "dl": id, "received": received, "total": total }),
            );
        }
    }
}

// --- page state ---------------------------------------------------------------------------

/// Title, url, loading and history, read from each view and reported when they change. WebKit
/// reports these by KVO; reading them every 200ms is the same information without observer
/// bookkeeping, and costs a handful of property reads.
fn poll_page_state() {
    let views: Vec<(u32, Retained<WKWebView>)> = with_state(|state| {
        state
            .views
            .iter()
            .map(|(id, v)| (*id, v.webview.clone()))
            .collect()
    });
    for (view, webview) in views {
        let current = unsafe {
            json!({
                "url": webview.URL().and_then(|u| u.absoluteString()).map(|u| u.to_string()).unwrap_or_default(),
                "title": webview.title().map(|t| t.to_string()).unwrap_or_default(),
                "loading": webview.isLoading(),
                "back": webview.canGoBack(),
                "forward": webview.canGoForward(),
                "index": webview.backForwardList().backList().count(),
                "length": webview.backForwardList().backList().count()
                    + webview.backForwardList().forwardList().count() + 1,
            })
        };
        let changed = with_state(|state| {
            let v = state.views.get_mut(&view)?;
            let changed = v.last_state != current;
            if changed {
                v.last_state = current.clone();
            }
            Some(changed)
        });
        if changed == Some(true) {
            let mut event = current;
            event["ev"] = json!("state");
            event["view"] = json!(view);
            emit(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_quiet, probe_hash, QUIET_AFTER};
    use std::time::Duration;

    #[test]
    fn a_view_goes_quiet_only_after_the_quiet_spell() {
        assert!(!is_quiet(Duration::ZERO));
        assert!(!is_quiet(QUIET_AFTER - Duration::from_millis(1)));
        assert!(is_quiet(QUIET_AFTER));
    }

    #[test]
    fn a_probe_hash_sees_one_changed_byte() {
        let mut bytes = vec![9u8; 720 * 4 + 3];
        let before = probe_hash(&bytes);
        bytes[720 * 4 + 1] = 10;
        assert_ne!(before, probe_hash(&bytes));
        bytes[720 * 4 + 1] = 9;
        assert_eq!(before, probe_hash(&bytes));
    }
}
