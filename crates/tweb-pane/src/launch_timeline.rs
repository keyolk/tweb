//! How long a pane took to come up: one line per pane in `launch.log`.
//!
//! "A new pane is slow to open" had nothing to measure it with. Measured on 2026-11-23 on a private
//! daemon, a pane on a running daemon drew its first picture 0.3s after it started and a pane that
//! had to start the daemon took 2.5-5s; what the person saw on their own daemon could not be
//! measured without touching it. So each frontend writes where its time went:
//!
//! - `daemon`: the daemon is answering (started by this pane, or already there).
//! - `hosted`: the daemon took the pane and sent it to the engine.
//! - `page`: the engine created the page (its agent socket arrived).
//! - `first_frame`: the first picture reached this pane's tty.
//! - `loaded`: the page's active tab stopped loading.
//!
//! Milliseconds from the frontend starting. A pane that runs its own engine never sees its frames
//! (the engine writes the tty itself), so its line ends at the reason it did not go to the daemon.

use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// After this the line is written with whatever was reached: a page that never finishes loading
/// (a long poll, a stalled request) must not keep the record back.
const LIMIT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Daemon,
    Hosted,
    Page,
    FirstFrame,
    Loaded,
}

const STEPS: [(Step, &str); 5] = [
    (Step::Daemon, "daemon"),
    (Step::Hosted, "hosted"),
    (Step::Page, "page"),
    (Step::FirstFrame, "first_frame"),
    (Step::Loaded, "loaded"),
];

fn index(step: Step) -> usize {
    STEPS
        .iter()
        .position(|(each, _)| *each == step)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub struct Record {
    pub started_at: f64,
    pub pane: String,
    pub pid: u32,
    pub engine: String,
    pub url: String,
    pub route: Option<String>,
    pub marks: [Option<u64>; 5],
    /// The engine answered `status` without a `loading` field: an engine from before it was added,
    /// still running in a daemon that was not restarted.
    pub load_not_reported: bool,
    /// Whether a tmux client showed the pane when the daemon took it. A hidden pane gets no frames
    /// until it is shown, so its `first_frame` measures the wait for a client, not the start-up.
    pub visible: Option<bool>,
}

struct Timeline {
    started: Instant,
    record: Record,
    written: bool,
}

static TIMELINE: Mutex<Option<Timeline>> = Mutex::new(None);

/// Writes the line when dropped, if nothing wrote it first: a pane closed before its page loaded
/// still says how far it got.
pub struct Guard;

impl Drop for Guard {
    fn drop(&mut self) {
        finish();
    }
}

/// Starts this pane's timeline. Called first thing in the frontend.
pub fn begin(pane: &str, engine: &str, url: &str) -> Guard {
    let started_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64());
    if let Ok(mut slot) = TIMELINE.lock() {
        *slot = Some(Timeline {
            started: Instant::now(),
            record: Record {
                started_at,
                pane: pane.to_string(),
                pid: std::process::id(),
                engine: engine.to_string(),
                url: url.to_string(),
                route: None,
                marks: [None; 5],
                load_not_reported: false,
                visible: None,
            },
            written: false,
        });
    }
    std::thread::spawn(|| {
        std::thread::sleep(LIMIT);
        finish();
    });
    Guard
}

/// Records `step` the first time it happens. Later ones (a reattach) do not move it. Writes the
/// line as soon as nothing more is coming (see `complete`).
pub fn mark(step: Step) {
    with(|timeline| {
        let slot = &mut timeline.record.marks[index(step)];
        if slot.is_none() {
            *slot = Some(timeline.started.elapsed().as_millis() as u64);
        }
    });
    settle();
}

/// Whether the pane was on a tmux client's screen when it was hosted.
pub fn visible(shown: Option<bool>) {
    with(|timeline| timeline.record.visible = shown);
}

/// Whether the line has everything it is going to get: the page loaded, or — on an engine that
/// does not report loading — the first frame arrived. Without the second case the line waited for
/// the 60-second limit on every pane of a daemon not yet restarted onto a reporting engine.
pub fn complete(record: &Record) -> bool {
    record.marks[index(Step::Loaded)].is_some()
        || (record.load_not_reported && record.marks[index(Step::FirstFrame)].is_some())
}

fn settle() {
    let mut done = false;
    with(|timeline| done = complete(&timeline.record));
    if done {
        finish();
    }
}

pub fn marked(step: Step) -> bool {
    let mut seen = false;
    with(|timeline| seen = timeline.record.marks[index(step)].is_some());
    seen
}

/// How the pane is being served: `hosted`, or why it runs its own engine.
pub fn route(text: &str) {
    with(|timeline| {
        if timeline.record.route.is_none() {
            timeline.record.route = Some(text.to_string());
        }
    });
}

fn with(apply: impl FnOnce(&mut Timeline)) {
    if let Ok(mut slot) = TIMELINE.lock() {
        if let Some(timeline) = slot.as_mut() {
            apply(timeline);
        }
    }
}

/// Writes the line once. Every later call is a no-op.
pub fn finish() {
    let record = {
        let Ok(mut slot) = TIMELINE.lock() else {
            return;
        };
        let Some(timeline) = slot.as_mut() else {
            return;
        };
        if timeline.written {
            return;
        }
        timeline.written = true;
        timeline.record.clone()
    };
    if let Some(mut file) = twebd::paths::open_log("launch.log", false) {
        // One write per line: panes started together append whole lines.
        let _ = file.write_all(format_line(&record).as_bytes());
    }
}

/// `1795416756.101 pane=%5 pid=123 engine=electron route=hosted daemon=12ms hosted=150ms ... url=...`
pub fn format_line(record: &Record) -> String {
    let mut line = format!(
        "{:.3} pane={} pid={} engine={} route={} visible={}",
        record.started_at,
        record.pane,
        record.pid,
        record.engine,
        record.route.as_deref().unwrap_or("-").replace(' ', "_"),
        match record.visible {
            Some(true) => "1",
            Some(false) => "0",
            None => "-",
        },
    );
    for (index, (step, name)) in STEPS.iter().enumerate() {
        let value = match record.marks[index] {
            Some(ms) => format!("{ms}ms"),
            None if *step == Step::Loaded && record.load_not_reported => "n/a".to_string(),
            None => "-".to_string(),
        };
        line.push_str(&format!(" {name}={value}"));
    }
    line.push_str(&format!(" url={}\n", record.url));
    line
}

/// Whether tty bytes from the engine put a picture up: any Kitty graphics command other than a
/// delete (`a=d`) or a query (`a=q`). The engine deletes and probes before it draws.
pub fn is_picture(bytes: &[u8]) -> bool {
    let mut rest = bytes;
    while let Some(at) = find(rest, b"\x1b_G") {
        let control = &rest[at + 3..];
        let end = control
            .iter()
            .position(|byte| *byte == b';' || *byte == 0x1b)
            .unwrap_or(control.len());
        let keys = &control[..end];
        let action = keys
            .split(|byte| *byte == b',')
            .find_map(|pair| pair.strip_prefix(b"a="));
        match action {
            Some(b"d") | Some(b"q") => {}
            _ => return true,
        }
        rest = &control[end..];
    }
    false
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[derive(Debug, PartialEq, Eq)]
pub enum LoadState {
    /// The engine's `status` has no `loading` field.
    NotReported,
    Loading,
    Idle {
        url: String,
    },
    /// No active tab yet, or an answer this does not understand.
    Unknown,
}

/// The active tab's load state from an agent `status` answer (`tabs: {active, tabs: [...]}`).
pub fn load_state(status: &Value) -> LoadState {
    let result = status.get("result").unwrap_or(status);
    let Some(tabs) = result.get("tabs") else {
        return LoadState::Unknown;
    };
    let active = tabs.get("active").and_then(Value::as_u64);
    let Some(tab) = active.and_then(|index| {
        tabs.get("tabs")
            .and_then(Value::as_array)
            .and_then(|list| list.get(index as usize))
    }) else {
        return LoadState::Unknown;
    };
    match tab.get("loading") {
        None => LoadState::NotReported,
        Some(Value::Bool(true)) => LoadState::Loading,
        Some(Value::Bool(false)) => LoadState::Idle {
            url: tab
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
        Some(_) => LoadState::Unknown,
    }
}

/// Whether an idle tab means the page has loaded, rather than not having started: before the
/// first navigation the tab is idle on nothing. Seen loading, or idle on a real address, is done.
pub fn counts_as_loaded(state: &LoadState, seen_loading: bool, requested: &str) -> bool {
    match state {
        LoadState::Idle { url } => {
            seen_loading || (!url.is_empty() && url != "about:blank") || requested == "about:blank"
        }
        _ => false,
    }
}

/// Polls the pane's agent socket until its page has loaded, then writes the line. `status` is the
/// call `tweb panes` makes on every pane and does not light the agent badge; `wait --load` would.
pub fn watch_load(socket: String) {
    let requested = {
        let mut url = String::new();
        with(|timeline| url = timeline.record.url.clone());
        url
    };
    std::thread::spawn(move || {
        let deadline = Instant::now() + LIMIT;
        let mut seen_loading = false;
        while Instant::now() < deadline {
            if let Some(answer) = status(&socket) {
                let state = load_state(&answer);
                if state == LoadState::NotReported {
                    with(|timeline| timeline.record.load_not_reported = true);
                    // The first frame may already be here; if not, its mark writes the line.
                    settle();
                    return;
                }
                seen_loading |= state == LoadState::Loading;
                if counts_as_loaded(&state, seen_loading, &requested) {
                    mark(Step::Loaded);
                    return;
                }
            }
            std::thread::sleep(POLL);
        }
    });
}

fn status(socket: &str) -> Option<Value> {
    let stream = UnixStream::connect(socket).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut writer = stream.try_clone().ok()?;
    writeln!(
        writer,
        "{}",
        serde_json::json!({"id": 1, "method": "status", "params": {}})
    )
    .ok()?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).ok()?;
    serde_json::from_str(line.trim()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record() -> Record {
        Record {
            started_at: 1795416756.1014,
            pane: "%5".into(),
            pid: 123,
            engine: "electron".into(),
            url: "https://example.test/a".into(),
            route: Some("hosted".into()),
            marks: [Some(12), Some(150), Some(172), Some(310), Some(1840)],
            load_not_reported: false,
            visible: Some(true),
        }
    }

    #[test]
    fn a_full_launch_is_one_line_of_milliseconds() {
        assert_eq!(
            format_line(&record()),
            "1795416756.101 pane=%5 pid=123 engine=electron route=hosted visible=1 daemon=12ms \
             hosted=150ms page=172ms first_frame=310ms loaded=1840ms url=https://example.test/a\n"
        );
    }

    // A pane that ran its own engine, or closed early, still says how far it got and why.
    #[test]
    fn steps_not_reached_are_dashes_and_the_route_stays_one_field() {
        let mut partial = record();
        partial.marks = [Some(3), None, None, None, None];
        partial.route = Some("spawn (twebd declined (EngineUnavailable): x)".into());
        let line = format_line(&partial);
        assert!(
            line.contains(" route=spawn_(twebd_declined_(EngineUnavailable):_x) "),
            "{line}"
        );
        assert!(
            line.contains(" hosted=- page=- first_frame=- loaded=- "),
            "{line}"
        );
        partial.load_not_reported = true;
        assert!(format_line(&partial).contains(" loaded=n/a "));
    }

    #[test]
    fn deletes_and_queries_are_not_a_picture() {
        assert!(!is_picture(b"\x1b_Ga=d,d=I,i=7\x1b\\"));
        assert!(!is_picture(b"\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\"));
        assert!(!is_picture(b"plain text"));
        assert!(is_picture(
            b"\x1b_Ga=d,i=7\x1b\\\x1b_Ga=T,f=100,t=f,i=7;cGF0aA==\x1b\\"
        ));
        assert!(is_picture(b"\x1b_Ga=p,i=7,p=1\x1b\\"));
        // A transmission without `a=` is a plain transmit-and-display.
        assert!(is_picture(b"\x1b_Gf=100,i=7;AAAA\x1b\\"));
    }

    fn status_with(tab: Value) -> Value {
        json!({"id": 1, "result": {"pid": 1, "tabs": {"active": 0, "tabs": [tab]}}})
    }

    #[test]
    fn the_active_tabs_load_state_is_read_from_status() {
        assert_eq!(
            load_state(&status_with(
                json!({"url": "https://a.test/", "loading": true})
            )),
            LoadState::Loading
        );
        assert_eq!(
            load_state(&status_with(
                json!({"url": "https://a.test/", "loading": false})
            )),
            LoadState::Idle {
                url: "https://a.test/".into()
            }
        );
        // An engine from before `loading` was added: stop asking rather than poll for a minute.
        assert_eq!(
            load_state(&status_with(json!({"url": "https://a.test/"}))),
            LoadState::NotReported
        );
        assert_eq!(
            load_state(&json!({"result": {"pid": 1}})),
            LoadState::Unknown
        );
    }

    // Before its first navigation the tab is idle on nothing; that is not "loaded".
    #[test]
    fn idle_before_the_first_navigation_is_not_loaded() {
        let blank = LoadState::Idle { url: "".into() };
        assert!(!counts_as_loaded(&blank, false, "https://a.test/"));
        assert!(counts_as_loaded(&blank, true, "https://a.test/"));
        let real = LoadState::Idle {
            url: "https://a.test/".into(),
        };
        assert!(counts_as_loaded(&real, false, "https://a.test/"));
        let about = LoadState::Idle {
            url: "about:blank".into(),
        };
        assert!(!counts_as_loaded(&about, false, "https://a.test/"));
        assert!(counts_as_loaded(&about, false, "about:blank"));
        assert!(!counts_as_loaded(
            &LoadState::Loading,
            true,
            "https://a.test/"
        ));
    }

    // A hidden pane's first frame waits for a client to show it; the line says so.
    #[test]
    fn the_line_says_whether_the_pane_was_on_screen() {
        let mut hidden = record();
        hidden.visible = Some(false);
        assert!(format_line(&hidden).contains(" route=hosted visible=0 daemon="));
        hidden.visible = None;
        assert!(format_line(&hidden).contains(" visible=- "));
    }

    // 2026-11-23: on the person's daemon, still running an engine without `loading`, the line for
    // a pane was written only at the 60-second limit. With no load to wait for, the first frame is
    // the last step.
    #[test]
    fn without_a_load_report_the_first_frame_completes_the_line() {
        let mut waiting = record();
        waiting.marks = [Some(1), Some(2), Some(3), None, None];
        waiting.load_not_reported = true;
        assert!(!complete(&waiting), "no first frame yet");
        waiting.marks[index(Step::FirstFrame)] = Some(300);
        assert!(complete(&waiting));

        // A reporting engine still waits for the load.
        let mut reporting = record();
        reporting.marks = [Some(1), Some(2), Some(3), Some(300), None];
        assert!(!complete(&reporting));
        reporting.marks[index(Step::Loaded)] = Some(900);
        assert!(complete(&reporting));
    }
}
