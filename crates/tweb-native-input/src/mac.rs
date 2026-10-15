// The AppKit half: global event monitors, the window-server probe, and the stdin control line.
//
// A global monitor receives a copy of every event the window server routes to OTHER applications.
// For the mouse and the scroll wheel that needs no permission at all — only key events are gated
// behind Accessibility — so this process never asks for one and never triggers a prompt. It also
// cannot change or swallow anything: a copy is all it gets, and the terminal under the pointer
// receives the real event exactly as before.
//
// The process is an application with no windows, no Dock icon and no menu bar
// (`Prohibited`), because a global monitor needs a running NSApplication event loop to deliver to.

use crate::wire::{self, Probe, Scroll, Window};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSEvent, NSEventMask, NSEventType, NSScreen,
};
use objc2_core_graphics::{CGEvent, CGWindowListCopyWindowInfo, CGWindowListOption};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
use std::cell::RefCell;
use std::io::{BufRead, Write};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

/// Until when (seconds on `now()`'s clock) the engine wants events, as f64 bits. Written by the
/// stdin thread, read on the main thread by every monitor callback.
static ARMED_UNTIL: AtomicU64 = AtomicU64::new(0);

fn now() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

fn armed() -> bool {
    now() < f64::from_bits(ARMED_UNTIL.load(Ordering::Acquire))
}

#[derive(Default)]
struct State {
    probe: Probe,
    last_move: f64,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn emit(line: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    // A closed pipe means the engine is gone; the stdin thread sees the same and exits.
    let _ = writeln!(out, "{line}").and_then(|()| out.flush());
}

pub fn run() {
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("tweb-native-input: must start on the main thread");
        std::process::exit(1);
    };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);

    let scroll = RcBlock::new(move |event: NonNull<NSEvent>| {
        // SAFETY: AppKit hands the monitor a live event for the duration of the call.
        let event = unsafe { event.as_ref() };
        on_scroll(mtm, event);
    });
    let pointer = RcBlock::new(move |event: NonNull<NSEvent>| {
        // SAFETY: as above.
        let event = unsafe { event.as_ref() };
        on_pointer(mtm, event);
    });
    let monitors = [
        NSEvent::addGlobalMonitorForEventsMatchingMask_handler(NSEventMask::ScrollWheel, &scroll),
        NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            NSEventMask::MouseMoved
                | NSEventMask::LeftMouseDragged
                | NSEventMask::RightMouseDragged
                | NSEventMask::OtherMouseDragged,
            &pointer,
        ),
    ];
    if monitors.iter().any(Option::is_none) {
        eprintln!("tweb-native-input: the window server refused a global event monitor");
        std::process::exit(1);
    }
    spawn_reader();
    emit(serde_json::json!({ "ev": "ready", "pid": std::process::id() }));
    app.run();
    // Kept alive for the life of the run loop; a dropped monitor stops delivering.
    drop(monitors);
}

/// `arm <seconds>` lines from the engine. EOF is the engine going away, and with it any reason
/// to watch the pointer.
fn spawn_reader() {
    std::thread::Builder::new()
        .name("tweb-native-input-stdin".into())
        .spawn(|| {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                if let Some(seconds) = wire::parse_arm(&line) {
                    ARMED_UNTIL.store((now() + seconds).to_bits(), Ordering::Release);
                }
            }
            std::process::exit(0);
        })
        .expect("stdin thread starts");
}

fn location(event: &NSEvent) -> Option<(f64, f64)> {
    let cg: Retained<CGEvent> = event.CGEvent()?;
    let point = CGEvent::location(Some(&cg));
    Some((point.x, point.y))
}

fn on_pointer(mtm: MainThreadMarker, event: &NSEvent) {
    if !armed() {
        return;
    }
    let Some((x, y)) = location(event) else {
        return;
    };
    let at = now();
    let due = STATE.with_borrow_mut(|state| {
        if at - state.last_move < wire::MOVE_INTERVAL && event.r#type() == NSEventType::MouseMoved {
            return false;
        }
        state.last_move = at;
        true
    });
    if !due {
        return;
    }
    probe(mtm, x, y, at, false);
    emit(wire::move_line(x, y, NSEvent::pressedMouseButtons()));
}

fn on_scroll(mtm: MainThreadMarker, event: &NSEvent) {
    if !armed() {
        return;
    }
    let Some((x, y)) = location(event) else {
        return;
    };
    let phase = event.phase().0 as u64;
    probe(mtm, x, y, now(), phase & wire::PHASE_BEGAN != 0);
    emit(wire::scroll_line(Scroll {
        x,
        y,
        dx: event.scrollingDeltaX(),
        dy: event.scrollingDeltaY(),
        phase,
        momentum: event.momentumPhase().0 as u64,
        precise: event.hasPreciseScrollingDeltas(),
        modifiers: event.modifierFlags().0 as u64,
    }));
}

/// Re-reads the window under the pointer when due, and says so when it changed.
fn probe(mtm: MainThreadMarker, x: f64, y: f64, at: f64, force: bool) {
    if !STATE.with_borrow(|state| state.probe.due(x, y, at, force)) {
        return;
    }
    let window = wire::window_at(&on_screen_windows(), x, y);
    let changed = STATE.with_borrow_mut(|state| state.probe.record(x, y, at, window));
    if let Some(window) = changed {
        emit(wire::window_line(window, scale_at(mtm, x, y)));
    }
}

/// The backing scale of the display the point is on: what one point is in device pixels there,
/// and so what turns the terminal's cell size (pixels) into the points the pointer moves in.
fn scale_at(mtm: MainThreadMarker, x: f64, y: f64) -> f64 {
    let screens = NSScreen::screens(mtm);
    // AppKit frames are bottom-up from the primary display's bottom edge; the point is top-down.
    let primary_height = screens
        .firstObject()
        .map(|s| s.frame().size.height)
        .unwrap_or(0.0);
    let flipped = primary_height - y;
    for screen in screens.iter() {
        let frame = screen.frame();
        if x >= frame.origin.x
            && x < frame.origin.x + frame.size.width
            && flipped > frame.origin.y
            && flipped <= frame.origin.y + frame.size.height
        {
            return screen.backingScaleFactor();
        }
    }
    screens
        .firstObject()
        .map(|s| s.backingScaleFactor())
        .unwrap_or(1.0)
}

fn number(dictionary: &NSDictionary, key: &str) -> Option<Retained<NSNumber>> {
    let key = NSString::from_str(key);
    let value = dictionary.objectForKey(&key)?;
    value.downcast::<NSNumber>().ok()
}

/// Every on-screen window, front to back. Window bounds, numbers, layers and owners are readable
/// without Screen Recording permission; only titles are withheld, and none is read here.
fn on_screen_windows() -> Vec<Window> {
    let Some(list) = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        0,
    ) else {
        return Vec::new();
    };
    // SAFETY: CFArray is toll-free bridged to NSArray, and the list is retained for this scope.
    let array: &NSArray<AnyObject> = unsafe {
        &*(objc2_core_foundation::CFRetained::as_ptr(&list).as_ptr() as *const NSArray<AnyObject>)
    };
    let mut windows = Vec::with_capacity(array.count());
    for entry in array.iter() {
        let Ok(info) = entry.downcast::<NSDictionary>() else {
            continue;
        };
        let bounds = info
            .objectForKey(&NSString::from_str("kCGWindowBounds"))
            .and_then(|value| value.downcast::<NSDictionary>().ok());
        let Some(bounds) = bounds else { continue };
        let field = |key: &str| number(&bounds, key).map(|n| n.as_f64());
        let (Some(x), Some(y), Some(width), Some(height)) =
            (field("X"), field("Y"), field("Width"), field("Height"))
        else {
            continue;
        };
        windows.push(Window {
            number: number(&info, "kCGWindowNumber")
                .map(|n| n.as_u32())
                .unwrap_or(0),
            pid: number(&info, "kCGWindowOwnerPID")
                .map(|n| n.as_i32())
                .unwrap_or(0),
            layer: number(&info, "kCGWindowLayer")
                .map(|n| n.as_i64())
                .unwrap_or(0),
            alpha: number(&info, "kCGWindowAlpha")
                .map(|n| n.as_f64())
                .unwrap_or(1.0),
            x,
            y,
            width,
            height,
        });
    }
    windows
}
