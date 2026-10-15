// What the helper says, and the decisions that do not need AppKit to make.
//
// One JSON object per line on stdout, the same framing the WebKit host uses. Every coordinate is
// in global screen POINTS with the origin at the top-left of the primary display — CoreGraphics'
// space, the one `CGEvent.location` and `kCGWindowBounds` are both in, so a pointer and a window
// can be compared without converting either.

use serde_json::{json, Value};

/// One on-screen window, as `CGWindowListCopyWindowInfo` lists it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    pub number: u32,
    pub pid: i32,
    pub layer: i64,
    pub alpha: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Window {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// The window the pointer is over: the frontmost ordinary window containing it.
///
/// The list is front to back. Layer 0 is where application windows live; the menu bar, the Dock,
/// and the WebKit host's own always-on-top views (alpha 0.001, level 1000) sit elsewhere and must
/// never be mistaken for what the user is looking at. A window that is all but transparent is
/// skipped for the same reason — it is on screen and covers nothing.
pub fn window_at(windows: &[Window], x: f64, y: f64) -> Option<Window> {
    windows
        .iter()
        .find(|window| {
            window.layer == 0
                && window.alpha >= 0.05
                && window.width > 1.0
                && window.height > 1.0
                && window.contains(x, y)
        })
        .copied()
}

/// Asking the window server for its list costs about a millisecond, so it is asked when the
/// pointer has moved somewhere new and not more than every `PROBE_INTERVAL` seconds — unless a
/// scroll gesture begins, which is the moment the answer decides where a whole gesture goes.
/// A window can also move or be raised under a pointer that stays put (a keyboard shortcut, a
/// tab switch), so an answer older than `PROBE_STALE` is re-read on any event at all.
pub const PROBE_INTERVAL: f64 = 0.08;
const PROBE_TRAVEL: f64 = 2.0;
const PROBE_STALE: f64 = 0.5;

#[derive(Debug, Default)]
pub struct Probe {
    last: Option<(f64, f64, f64)>,
    window: Option<Window>,
    /// Whether anything has been reported yet: the first answer is news even when it is "none".
    reported: bool,
}

impl Probe {
    /// Whether a probe is due now.
    pub fn due(&self, x: f64, y: f64, now: f64, force: bool) -> bool {
        let Some((lx, ly, at)) = self.last else {
            return true;
        };
        let age = now - at;
        force
            || age >= PROBE_STALE
            || ((x - lx).hypot(y - ly) > PROBE_TRAVEL && age >= PROBE_INTERVAL)
    }

    /// Records a probe's answer and returns it when it differs from the last one reported.
    pub fn record(
        &mut self,
        x: f64,
        y: f64,
        now: f64,
        window: Option<Window>,
    ) -> Option<Option<Window>> {
        self.last = Some((x, y, now));
        let changed = !self.reported || window != self.window;
        self.reported = true;
        self.window = window;
        changed.then_some(window)
    }
}

pub fn window_line(window: Option<Window>, scale: f64) -> Value {
    match window {
        Some(window) => json!({
            "ev": "w",
            "id": window.number,
            "pid": window.pid,
            "x": window.x,
            "y": window.y,
            "w": window.width,
            "h": window.height,
            "scale": scale,
        }),
        None => json!({ "ev": "w", "id": null }),
    }
}

pub fn move_line(x: f64, y: f64, buttons: usize) -> Value {
    json!({ "ev": "m", "x": x, "y": y, "b": buttons })
}

/// A scroll event, as AppKit decoded it.
///
/// `dx`/`dy` are `scrollingDeltaX/Y`: points when `precise` (a trackpad, a Magic Mouse), lines
/// otherwise, already turned the way the user's natural-scrolling setting says. A positive `dy`
/// moves the content down. `phase` and `momentum` are the raw `NSEventPhase` masks — the finger
/// phase of the gesture and, once the fingers lift, the inertial phase AppKit synthesises — and
/// are passed on untouched so the engine can hand them to a page that understands them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scroll {
    pub x: f64,
    pub y: f64,
    pub dx: f64,
    pub dy: f64,
    pub phase: u64,
    pub momentum: u64,
    pub precise: bool,
    pub modifiers: u64,
}

pub fn scroll_line(scroll: Scroll) -> Value {
    json!({
        "ev": "s",
        "x": scroll.x,
        "y": scroll.y,
        "dx": scroll.dx,
        "dy": scroll.dy,
        "ph": scroll.phase,
        "mo": scroll.momentum,
        "pr": scroll.precise,
        "mods": scroll.modifiers,
    })
}

/// `NSEventPhaseBegan`. The gesture's first event, where the window under it is re-read.
// Only the macOS monitor reads this; elsewhere the helper is a stub that exits.
#[cfg(target_os = "macos")]
pub const PHASE_BEGAN: u64 = 1;

/// The control lines the engine writes. `arm <seconds>` asks for pointer and scroll events for
/// that long; anything else is ignored, so an older engine and a newer helper still talk.
pub fn parse_arm(line: &str) -> Option<f64> {
    let mut fields = line.split_whitespace();
    if fields.next()? != "arm" {
        return None;
    }
    let seconds: f64 = fields.next()?.parse().ok()?;
    (seconds.is_finite() && seconds >= 0.0).then_some(seconds.min(60.0))
}

/// Pointer moves arrive at the trackpad's rate, up to 120 a second and more with a gaming mouse.
/// One per 8ms is a frame at 120Hz: as fine as anything can be drawn, and no more lines to parse.
// Only the macOS monitor reads this; elsewhere the helper is a stub that exits.
#[cfg(target_os = "macos")]
pub const MOVE_INTERVAL: f64 = 0.008;

#[cfg(test)]
mod tests {
    use super::*;

    fn window(number: u32, layer: i64, alpha: f64, rect: (f64, f64, f64, f64)) -> Window {
        Window {
            number,
            pid: 7,
            layer,
            alpha,
            x: rect.0,
            y: rect.1,
            width: rect.2,
            height: rect.3,
        }
    }

    #[test]
    fn the_frontmost_ordinary_window_under_the_pointer_wins() {
        let windows = [
            // The menu bar: above everything, but not a window anyone points into.
            window(1, 24, 1.0, (0.0, 0.0, 1800.0, 25.0)),
            // The WebKit host's view: on top, all but invisible.
            window(2, 1000, 0.001, (0.0, 0.0, 1800.0, 1100.0)),
            window(3, 0, 1.0, (100.0, 100.0, 400.0, 300.0)),
            window(4, 0, 1.0, (0.0, 0.0, 1800.0, 1100.0)),
        ];
        assert_eq!(window_at(&windows, 200.0, 200.0).map(|w| w.number), Some(3));
        assert_eq!(window_at(&windows, 600.0, 200.0).map(|w| w.number), Some(4));
        assert_eq!(window_at(&windows, 10.0, 10.0).map(|w| w.number), Some(4));
        assert_eq!(window_at(&windows, 1900.0, 10.0), None);
    }

    #[test]
    fn a_window_ends_where_its_bounds_end() {
        let windows = [window(3, 0, 1.0, (100.0, 100.0, 400.0, 300.0))];
        assert!(window_at(&windows, 100.0, 100.0).is_some());
        assert!(window_at(&windows, 500.0, 200.0).is_none());
        assert!(window_at(&windows, 200.0, 400.0).is_none());
    }

    #[test]
    fn a_probe_waits_for_travel_and_time_unless_a_gesture_begins() {
        let mut probe = Probe::default();
        assert!(
            probe.due(10.0, 10.0, 0.0, false),
            "the first probe is always due"
        );
        probe.record(10.0, 10.0, 0.0, None);
        assert!(
            !probe.due(11.0, 10.0, 0.2, false),
            "a pointer that has not moved needs no probe"
        );
        assert!(
            probe.due(11.0, 10.0, PROBE_STALE, false),
            "until the last answer is stale"
        );
        assert!(
            !probe.due(50.0, 10.0, 0.01, false),
            "nor one asked again within the interval"
        );
        assert!(probe.due(50.0, 10.0, PROBE_INTERVAL, false));
        assert!(
            probe.due(10.0, 10.0, 0.01, true),
            "a beginning gesture always probes"
        );
    }

    #[test]
    fn only_a_changed_answer_is_reported() {
        let mut probe = Probe::default();
        let terminal = window(3, 0, 1.0, (0.0, 0.0, 100.0, 100.0));
        assert_eq!(
            probe.record(1.0, 1.0, 0.0, None),
            Some(None),
            "the first answer is news"
        );
        assert_eq!(probe.record(5.0, 5.0, 1.0, None), None);
        assert_eq!(
            probe.record(5.0, 5.0, 2.0, Some(terminal)),
            Some(Some(terminal))
        );
        assert_eq!(probe.record(9.0, 9.0, 3.0, Some(terminal)), None);
        let moved = Window {
            x: 10.0,
            ..terminal
        };
        assert_eq!(
            probe.record(9.0, 9.0, 4.0, Some(moved)),
            Some(Some(moved)),
            "a moved window is news"
        );
    }

    #[test]
    fn lines_carry_what_the_engine_reads() {
        let line = scroll_line(Scroll {
            x: 1.5,
            y: 2.0,
            dx: 0.0,
            dy: -3.25,
            phase: 4,
            momentum: 0,
            precise: true,
            modifiers: 0,
        });
        assert_eq!(line["ev"], "s");
        assert_eq!(line["dy"], -3.25);
        assert_eq!(line["ph"], 4);
        assert_eq!(line["pr"], true);
        assert_eq!(window_line(None, 2.0)["id"], Value::Null);
        let terminal = window(9, 0, 1.0, (0.0, 30.0, 800.0, 600.0));
        let line = window_line(Some(terminal), 2.0);
        assert_eq!(
            (line["id"].clone(), line["y"].clone(), line["scale"].clone()),
            (json!(9), json!(30.0), json!(2.0))
        );
        assert_eq!(move_line(3.0, 4.0, 1)["b"], 1);
    }

    #[test]
    fn arming_reads_seconds_and_ignores_anything_else() {
        assert_eq!(parse_arm("arm 8"), Some(8.0));
        assert_eq!(parse_arm("arm 0"), Some(0.0));
        assert_eq!(
            parse_arm("arm 900"),
            Some(60.0),
            "capped, so a stuck engine cannot pin it on"
        );
        assert_eq!(parse_arm("arm -1"), None);
        assert_eq!(parse_arm("arm"), None);
        assert_eq!(parse_arm("positions 1"), None);
    }
}
