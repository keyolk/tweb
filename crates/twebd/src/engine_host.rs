//! The hosted engine: one Electron process, N panes, owned by the supervisor.
//!
//! **Where the process lives, and why.** The engine is a child of `twebd`, not of any frontend.
//! It has to be: N frontends cannot each be the parent of one process, and making the first
//! frontend the parent would mean every other pane dies when that one pane closes. It is started
//! *lazily*, on the first pane that actually asks to be hosted, because DESIGN.md 5.1 measured the
//! runtime floor at 43 MB and an idle daemon should not be holding it.
//!
//! **What happens on each death.**
//! - *The engine dies with N panes attached.* Its exit is noticed by the reader task, every hosted
//!   pane is told `engine_lost`, and the engine is restarted if the crash budget allows. Past the
//!   budget the daemon reports `engine_unavailable` and every frontend spawns its own engine — a
//!   pane never ends up dead because the shared runtime is.
//! - *`twebd` dies with the engine alive.* The engine must not outlive its supervisor. An orphaned
//!   engine keeps painting into panes that have moved on — the four-hour stale-page bug
//!   `electron/orphan-watch.cjs` exists for. `TWEB_SUPERVISOR_PID` is passed so the engine's
//!   existing orphan watchdog reaps it on exactly the same rule it already applies to a dead
//!   frontend. The frontends see their socket close and fall back to spawning their own engines.
//! - *A frontend dies.* Its connection closes, the registration is reaped (`server::reap_connection`)
//!   and the pane is closed on the engine. The other panes are untouched.

use crate::engine_wire::{self, EngineEvent};
use crate::protocol::PaneKey;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

/// How many engine starts are allowed inside [`CRASH_WINDOW_MS`] before the daemon stops trying.
///
/// A restart loop against a permanently broken engine is worse than no engine at all: it burns the
/// machine while every pane waits for frames that will never come. Falling back to per-pane
/// engines is a working browser, so giving up quickly is the better failure.
pub const CRASH_BUDGET: usize = 3;
pub const CRASH_WINDOW_MS: u64 = 60_000;

/// Whether a crashed engine should be started again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartDecision {
    Restart,
    /// Too many starts too fast. Hosting is off until something changes.
    GiveUp,
}

/// Decides on the restart, given when the engine was started before.
///
/// Pure, and a sliding window rather than a counter: an engine that has run for a day and then
/// crashes once is not in a crash loop, and a counter that never forgets would refuse to restart
/// it. Only starts inside the window count.
pub fn restart_decision(recent_starts_ms: &[u64], now_ms: u64) -> RestartDecision {
    let in_window = recent_starts_ms
        .iter()
        .filter(|start| now_ms.saturating_sub(**start) < CRASH_WINDOW_MS)
        .count();
    if in_window >= CRASH_BUDGET {
        RestartDecision::GiveUp
    } else {
        RestartDecision::Restart
    }
}

/// Drops start timestamps that have aged out, so the window does not grow without bound over a
/// daemon's lifetime.
pub fn prune_starts(recent_starts_ms: &[u64], now_ms: u64) -> Vec<u64> {
    recent_starts_ms
        .iter()
        .copied()
        .filter(|start| now_ms.saturating_sub(*start) < CRASH_WINDOW_MS)
        .collect()
}

/// How long the daemon waits for an engine to declare itself a pane host.
///
/// Generous rather than tight: this is Electron reaching `app.whenReady()` on a cold start, and a
/// timeout that fired on a slow machine would fall an otherwise-working setup back to per-pane
/// engines. Falling back is safe, so being wrong in that direction only costs the memory win.
pub const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The engine's stdout, line by line.
type EngineLines = tokio::io::Lines<BufReader<tokio::process::ChildStdout>>;

/// Reads until the engine declares its host protocol, or its stdout ends.
///
/// Everything before the declaration is discarded: Chromium writes GPU and sandbox diagnostics to
/// this stream from the moment it starts, and none of them are an answer to this question.
async fn wait_for_ready(lines: &mut EngineLines) -> Option<u32> {
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(EngineEvent::Ready { protocol }) = engine_wire::parse_event(&line) {
            return Some(protocol);
        }
        tracing::debug!(line = %line, "engine stdout before the host handshake");
    }
    None
}

/// Ignores the signals a hosted engine sends to the process it believes is its pane frontend.
///
/// The engine asks the owner of the pane's pty to re-declare keyboard mode by sending it SIGUSR1,
/// which is right when that owner is a per-pane frontend. A daemon hosting N panes owns no pty and
/// has nothing to re-declare — but it is the process the engine signals, and the default action for
/// SIGUSR1 is *terminate*. Measured: the daemon died with `rc=-30` the moment a real engine
/// started, which read as "the daemon randomly disappears when you use the feature".
///
/// Ignoring rather than handling: there is genuinely nothing to do, and a handler that did nothing
/// would only be a place for someone to later add something that does not belong in a supervisor.
pub fn ignore_frontend_signals() {
    // Safe: `signal` with SIG_IGN takes no pointers and cannot fail in a way that matters here —
    // a refusal leaves the default action, which is the behaviour without this call.
    unsafe {
        libc_signal(libc_sigusr1(), SIG_IGN);
    }
}

const SIG_IGN: usize = 1;

extern "C" {
    #[link_name = "signal"]
    fn libc_signal(signum: i32, handler: usize) -> usize;
}

/// SIGUSR1 is 30 on macOS and 10 on Linux, so it is spelled per platform rather than hardcoded.
const fn libc_sigusr1() -> i32 {
    if cfg!(target_os = "macos") {
        30
    } else {
        10
    }
}

/// Whether an engine app directory looks like it could host panes.
///
/// A cheap pre-filter and **not** the capability decision — the [`READY_TIMEOUT`] handshake is.
/// This exists only so an app that is obviously not a tweb engine at all is refused without paying
/// for an Electron start. Believing it instead of the handshake was measured to leave a pane blank
/// forever: the modules below shipped in a release *before* the host that uses them, so their
/// presence proved nothing, the daemon started a healthy single-pane engine, and that engine
/// painted its own default page into the pipe while the pane waited for frames.
pub fn app_dir_looks_like_an_engine(app_dir: &Path) -> bool {
    app_dir.join("main.cjs").is_file() && app_dir.join("package.json").is_file()
}

/// The engine's public state, for `status` and for deciding whether a `host` can be served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineState {
    /// Never started — no pane has asked for hosting yet.
    Idle,
    Running {
        pid: u32,
    },
    /// Started and gone, but startable again.
    Stopped,
    /// Past the crash budget, or never startable on this machine.
    Unavailable {
        reason: String,
    },
}

impl std::fmt::Display for EngineState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Idle => write!(f, "idle"),
            Self::Running { pid } => write!(f, "running (pid {pid})"),
            Self::Stopped => write!(f, "stopped"),
            Self::Unavailable { reason } => write!(f, "unavailable: {reason}"),
        }
    }
}

/// How the engine reaches the panes it hosts: one channel per attached frontend connection.
pub type PaneSink = UnboundedSender<EngineEvent>;

/// The engine process plus the routing table from pane key to the frontend serving it.
pub struct EngineHost {
    launcher: Launcher,
    inner: parking_lot::Mutex<HostState>,
}

struct HostState {
    state: EngineState,
    /// Writes to the engine's stdin. Every hosted pane's control lines go through this one sender,
    /// so ordering between panes is whatever order the daemon saw them in — which is the only
    /// ordering that can be defined across independent frontends.
    stdin: Option<UnboundedSender<String>>,
    sinks: HashMap<PaneKey, PaneSink>,
    recent_starts_ms: Vec<u64>,
}

/// Everything needed to start the engine, resolved once so a failure is reported at `host` time
/// rather than discovered per restart.
#[derive(Debug, Clone)]
pub struct Launcher {
    pub executable: PathBuf,
    pub app_dir: PathBuf,
}

impl EngineHost {
    pub fn new(launcher: Launcher) -> Self {
        Self {
            launcher,
            inner: parking_lot::Mutex::new(HostState {
                state: EngineState::Idle,
                stdin: None,
                sinks: HashMap::new(),
                recent_starts_ms: Vec::new(),
            }),
        }
    }

    /// An engine host that can never host, so `host` requests are refused with a reason instead of
    /// the daemon pretending it has an engine it could not find.
    pub fn unavailable(reason: impl Into<String>) -> Self {
        let host = Self::new(Launcher {
            executable: PathBuf::new(),
            app_dir: PathBuf::new(),
        });
        host.inner.lock().state = EngineState::Unavailable {
            reason: reason.into(),
        };
        host
    }

    pub fn state(&self) -> EngineState {
        self.inner.lock().state.clone()
    }

    pub fn hosted_pane_count(&self) -> usize {
        self.inner.lock().sinks.len()
    }

    /// A pane already hosted under the same tmux pane id but a *different* tmux server, if any.
    ///
    /// The engine addresses control lines `@%N` and carries no server identity, so two panes with
    /// one id are indistinguishable to it: every `VIS`, `RESIZE` and `INPUT` for that id becomes
    /// ambiguous and the engine drops it rather than guessing. Refusing the second here is what
    /// keeps the answer unique — and it has to be refused HERE rather than only in the engine,
    /// because an engine-only refusal leaves this daemon believing the pane was accepted while the
    /// frontend stops falling back. That is the records-only accept this whole seam is built to
    /// avoid.
    pub fn conflicting_pane_id(&self, key: &PaneKey) -> Option<PaneKey> {
        self.inner
            .lock()
            .sinks
            .keys()
            .find(|hosted| hosted.pane == key.pane && hosted.tmux_server != key.tmux_server)
            .cloned()
    }

    pub fn can_host(&self) -> bool {
        !matches!(self.state(), EngineState::Unavailable { .. })
    }

    /// Starts the engine if it is not already running, and registers this pane's event sink.
    ///
    /// Returns the reason hosting is impossible, if it is. The caller turns that into a refusal the
    /// frontend answers by spawning its own engine.
    ///
    /// Async because starting the engine means *waiting for it to say it can host* — see
    /// [`Self::spawn_engine`]. Measured the hard way: an engine that ignores `TWEB_MULTIPANE`
    /// starts perfectly well, opens its own default page, paints into the pipe, and leaves the
    /// pane blank with no fallback, because nothing ever fails.
    pub async fn open(
        self: &Arc<Self>,
        key: PaneKey,
        sink: PaneSink,
        open: &engine_wire::OpenRequest<'_>,
        now_ms: u64,
    ) -> std::result::Result<(), String> {
        let line = engine_wire::open_line(open);
        let needs_start = {
            let mut inner = self.inner.lock();
            if let EngineState::Unavailable { reason } = &inner.state {
                return Err(reason.clone());
            }
            if inner.stdin.is_none() {
                inner.recent_starts_ms = prune_starts(&inner.recent_starts_ms, now_ms);
                if restart_decision(&inner.recent_starts_ms, now_ms) == RestartDecision::GiveUp {
                    let reason = format!(
                        "the hosted engine failed {CRASH_BUDGET} times in {}s",
                        CRASH_WINDOW_MS / 1000
                    );
                    inner.state = EngineState::Unavailable {
                        reason: reason.clone(),
                    };
                    return Err(reason);
                }
                inner.recent_starts_ms.push(now_ms);
                true
            } else {
                false
            }
        };
        if needs_start {
            if let Err(reason) = self.clone().spawn_engine().await {
                // An engine that started but cannot host is worse than none at all: it holds a
                // browser runtime while every pane waits for frames it will not produce. Marking
                // the host unavailable is what turns the next pane's request into a refusal, and a
                // refusal is a pane that spawns its own engine and works.
                self.inner.lock().state = EngineState::Unavailable {
                    reason: reason.clone(),
                };
                return Err(reason);
            }
        }
        let stdin = {
            let mut inner = self.inner.lock();
            inner.sinks.insert(key, sink);
            inner.stdin.clone()
        };
        match stdin {
            Some(stdin) => stdin
                .send(line)
                .map_err(|_| "engine stdin closed".to_string()),
            None => Err("engine stdin closed".to_string()),
        }
    }

    /// Forwards one control line to an already-hosted pane. A pane the engine does not have is not
    /// an error: it is what a frontend sees for the moment between the engine dying and the
    /// `engine_lost` push reaching it.
    pub fn control(&self, key: &PaneKey, body: &str) {
        let inner = self.inner.lock();
        if !inner.sinks.contains_key(key) {
            return;
        }
        if let Some(stdin) = &inner.stdin {
            let _ = stdin.send(engine_wire::control_line(&key.pane.to_string(), body));
        }
    }

    /// Drops a pane from the engine. Called when a frontend's connection closes for any reason.
    pub fn close(&self, key: &PaneKey) {
        let inner = self.inner.lock();
        if !inner.sinks.contains_key(key) {
            return;
        }
        if let Some(stdin) = &inner.stdin {
            let _ = stdin.send(engine_wire::close_line(&key.pane.to_string()));
        }
        drop(inner);
        self.inner.lock().sinks.remove(key);
    }

    /// Starts the engine and waits for it to declare that it can host panes.
    ///
    /// The handshake is the whole point. File presence is not evidence of behaviour: the modules a
    /// hosted engine needs shipped in a release *before* the host that uses them, so a daemon that
    /// checked for them started a perfectly healthy single-pane engine which opened its own default
    /// page, painted into the pipe, and left the requesting pane blank forever — with no failure
    /// anywhere to trigger a fallback. An engine that answers `READY` has run the code; an engine
    /// that does not is killed here and every pane falls back to spawning its own, which works.
    async fn spawn_engine(self: Arc<Self>) -> std::result::Result<(), String> {
        let mut child = start_process(&self.launcher).map_err(|err| err.to_string())?;
        let pid = child.id().unwrap_or(0);
        let stdout = child.stdout.take();
        let stdin = child.stdin.take();

        let Some(stdout) = stdout else {
            let _ = child.kill().await;
            return Err("engine has no stdout".to_string());
        };
        let mut lines = BufReader::new(stdout).lines();
        let ready = tokio::time::timeout(READY_TIMEOUT, wait_for_ready(&mut lines)).await;
        match ready {
            Ok(Some(protocol)) if protocol == crate::protocol::PROTOCOL_VERSION => {}
            Ok(Some(protocol)) => {
                let _ = child.kill().await;
                return Err(format!(
                    "engine speaks host protocol {protocol}, daemon speaks {}",
                    crate::protocol::PROTOCOL_VERSION
                ));
            }
            Ok(None) => {
                let _ = child.kill().await;
                return Err("engine exited before declaring itself a pane host".to_string());
            }
            Err(_) => {
                let _ = child.kill().await;
                return Err(format!(
                    "engine did not declare itself a pane host within {}ms — it is a build without multipane hosting",
                    READY_TIMEOUT.as_millis()
                ));
            }
        }

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        {
            let mut inner = self.inner.lock();
            inner.state = EngineState::Running { pid };
            inner.stdin = Some(tx);
        }
        if let Some(stdin) = stdin {
            tokio::spawn(pump_stdin(stdin, rx));
        }
        tokio::spawn(self.clone().pump_stdout(lines));
        tokio::spawn(self.watch_exit(child));
        Ok(())
    }

    async fn pump_stdout(self: Arc<Self>, mut lines: EngineLines) {
        while let Ok(Some(line)) = lines.next_line().await {
            let Some(event) = engine_wire::parse_event(&line) else {
                // Chromium's own diagnostics come out here. Logging at debug rather than warn
                // keeps a normal startup from looking like a fault.
                tracing::debug!(line = %line, "engine stdout line ignored");
                continue;
            };
            self.deliver(event);
        }
    }

    fn deliver(&self, event: EngineEvent) {
        let pane = match &event {
            EngineEvent::Ready { protocol } => {
                tracing::info!(protocol, "hosted engine ready");
                return;
            }
            EngineEvent::Frame { pane, .. }
            | EngineEvent::AgentSocket { pane, .. }
            | EngineEvent::Audio { pane, .. }
            | EngineEvent::KeyboardRestore { pane }
            | EngineEvent::Closed { pane, .. } => pane.clone(),
        };
        let inner = self.inner.lock();
        // The engine names a pane by its id alone, since a hosted engine only ever serves one tmux
        // server's worth of frontends per socket. Matching on the id is therefore exact here, and
        // the generation check that makes a late frame droppable happens on the frontend's own
        // connection, where the generation is known.
        let Some((_, sink)) = inner
            .sinks
            .iter()
            .find(|(key, _)| key.pane.to_string() == pane)
        else {
            return;
        };
        let _ = sink.send(event);
    }

    async fn watch_exit(self: Arc<Self>, mut child: Child) {
        let status = child.wait().await;
        let reason = match &status {
            Ok(status) => format!("engine exited: {status}"),
            Err(err) => format!("engine wait failed: {err}"),
        };
        tracing::warn!(%reason, "hosted engine is gone");
        let sinks: Vec<PaneSink> = {
            let mut inner = self.inner.lock();
            inner.stdin = None;
            inner.state = EngineState::Stopped;
            // Every hosted pane loses its page at once. Dropping the routing table here — rather
            // than waiting for each frontend to detach — is what makes a subsequent `host` from
            // any of them start a fresh engine instead of writing into a dead pipe.
            inner.sinks.drain().map(|(_, sink)| sink).collect()
        };
        for sink in sinks {
            let _ = sink.send(EngineEvent::Closed {
                pane: String::new(),
                reason: reason.clone(),
            });
        }
    }
}

async fn pump_stdin(mut stdin: tokio::process::ChildStdin, mut rx: UnboundedReceiver<String>) {
    while let Some(line) = rx.recv().await {
        if stdin.write_all(line.as_bytes()).await.is_err() {
            break;
        }
        if stdin.flush().await.is_err() {
            break;
        }
    }
}

/// Which pid a hosted engine's orphan watchdog must watch, and under which name.
///
/// A pure statement of the contract `electron/orphan-watch.cjs` reads, so the rule is asserted in
/// this repo's tests rather than only in the shape of a `Command`. Exactly one variable is set:
/// two would leave the watchdog choosing, and neither leaves a hosted engine with no watchdog at
/// all — which is the four-hour stale-page case that module exists for, now with N panes behind it.
///
/// Returns `(name, pid)`.
pub fn orphan_watch_variable(supervisor_pid: u32) -> (&'static str, String) {
    ("TWEB_SUPERVISOR_PID", supervisor_pid.to_string())
}

/// The variable a hosted engine must *not* inherit.
///
/// It means "a per-pane frontend owns my pty". A supervisor owns no pty, and an engine that
/// believed otherwise sent it the SIGUSR1 that killed it.
pub const FRONTEND_PID_VARIABLE: &str = "TWEB_FRONTEND_PID";

/// Whether a hosted engine should still be running.
///
/// A parent that has gone means every pane this engine draws for is gone too. Mirrors
/// `isOrphaned` in `electron/orphan-watch.cjs`, including its refusal to act without a pid: an
/// engine started by hand or by a test has no parent to watch, and exiting on a guess would kill a
/// legitimately parentless run.
pub fn is_orphaned(watched_pid: Option<u32>, parent_pid: u32) -> bool {
    // Chromium reparents the engine during startup, so `ppid` is not a stable identity — but
    // landing on init specifically is unambiguous, because nothing else adopts a live child.
    matches!(watched_pid, Some(pid) if pid > 1) && parent_pid == 1
}

fn start_process(launcher: &Launcher) -> Result<Child> {
    let (watch_variable, watch_pid) = orphan_watch_variable(std::process::id());
    let mut command = Command::new(&launcher.executable);
    command
        .arg(".")
        .current_dir(&launcher.app_dir)
        .stdin(Stdio::piped())
        // Unlike the per-pane path, the engine's stdout is a pipe rather than a tty: it hosts N
        // panes and has no single terminal to inherit. Frames come back here and go out over each
        // frontend's own connection.
        .stdout(Stdio::piped())
        .stderr(engine_stderr())
        // The engine must die when its supervisor does. An orphaned engine keeps painting into
        // panes that have moved on — `electron/orphan-watch.cjs` exists because one drew a stale
        // page over two other panes for four hours, and a hosted engine is that hazard with N
        // panes behind it.
        //
        // **Exactly one of the two pid variables is ever set, and which one says what kind of
        // parent this engine has.** `TWEB_FRONTEND_PID` means "a per-pane frontend owns my pty";
        // `TWEB_SUPERVISOR_PID` means "a twebd supervisor owns me and I own no pty". The daemon
        // therefore removes the frontend variable rather than impersonating a frontend with it,
        // which is what it used to do — and that lie had teeth: the engine SIGUSR1s whatever it
        // believes is its frontend to ask for a keyboard-mode re-declaration, the default action
        // for SIGUSR1 is terminate, and the daemon died of it with every hosted pane attached
        // (measured, rc=-30). A hosted engine now asks the pane's own frontend over the wire
        // (`KEYBOARD restore`), which is the process that actually holds the pty.
        //
        // `orphan-watch.cjs` watches whichever variable is present, so the "my parent became init"
        // rule applies unchanged — and the daemon genuinely *is* this process's parent, so it is
        // the right pid to watch.
        .env(watch_variable, watch_pid)
        .env_remove(FRONTEND_PID_VARIABLE)
        .env("TWEB_MULTIPANE", "1")
        // No pane's url, viewport or image id here: a hosted engine gets those per pane, over the
        // control channel, because one process cannot have N values of an environment variable.
        .env_remove("TWEB_URL")
        .env_remove("TWEB_VIEWPORT")
        .env_remove("TWEB_PANE_ORIGIN")
        .env_remove("TWEB_IMAGE_ID");
    command
        .spawn()
        .with_context(|| format!("cannot start {}", launcher.executable.display()))
}

/// Where the hosted engine's stderr goes.
///
/// A file, for the same reason the per-pane path uses one: Chromium's diagnostics on a terminal
/// show through on top of the page. The daemon has no terminal at all, but its stderr is the
/// operator's log and interleaving Chromium's output into it would bury the supervisor's own.
fn engine_stderr() -> Stdio {
    let Some(home) = std::env::var_os("HOME") else {
        return Stdio::null();
    };
    let directory = PathBuf::from(home).join(".cache/tweb/logs");
    if std::fs::create_dir_all(&directory).is_err() {
        return Stdio::null();
    }
    std::fs::File::create(directory.join("engine-hosted.log"))
        .map_or_else(|_| Stdio::null(), Stdio::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_first_start_is_always_allowed() {
        assert_eq!(restart_decision(&[], 1_000), RestartDecision::Restart);
    }

    #[test]
    fn a_crash_loop_stops_inside_the_window() {
        let starts = vec![1_000, 2_000, 3_000];
        assert_eq!(restart_decision(&starts, 4_000), RestartDecision::GiveUp);
        assert_eq!(
            restart_decision(&starts[..2], 4_000),
            RestartDecision::Restart
        );
    }

    // An engine that ran for a day and then crashed once is not in a crash loop. A plain counter
    // would refuse to restart it, which is the failure mode this window exists to avoid.
    #[test]
    fn starts_older_than_the_window_do_not_count() {
        let starts = vec![1_000, 2_000, 3_000];
        let now = 3_000 + CRASH_WINDOW_MS;
        assert_eq!(restart_decision(&starts, now), RestartDecision::Restart);
        assert_eq!(prune_starts(&starts, now), Vec::<u64>::new());
    }

    #[test]
    fn pruning_keeps_only_what_is_still_in_the_window() {
        let starts = vec![1_000, 50_000, 59_000];
        assert_eq!(prune_starts(&starts, 62_000), vec![50_000, 59_000]);
    }

    // A clock that went backwards must not be read as "these starts are far in the future and
    // therefore outside the window", which would silently reset the budget.
    #[test]
    fn a_backwards_clock_does_not_reset_the_budget() {
        let starts = vec![10_000, 11_000, 12_000];
        assert_eq!(restart_decision(&starts, 5_000), RestartDecision::GiveUp);
    }

    #[test]
    fn an_app_dir_that_is_not_an_engine_at_all_is_refused_without_starting_one() {
        let dir = tempdir();
        assert!(!app_dir_looks_like_an_engine(&dir));
        std::fs::write(dir.join("main.cjs"), "").expect("write");
        assert!(!app_dir_looks_like_an_engine(&dir));
        std::fs::write(dir.join("package.json"), "{}").expect("write");
        assert!(
            app_dir_looks_like_an_engine(&dir),
            "this only says 'an engine' — whether it HOSTS is the READY handshake's answer"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_ready_line_is_the_capability_answer_and_noise_before_it_is_skipped() {
        // Chromium writes diagnostics from the moment it starts; none of them answer this
        // question, and treating one as an answer either way is how a pane ends up blank.
        assert_eq!(
            engine_wire::parse_event("READY 1"),
            Some(EngineEvent::Ready { protocol: 1 })
        );
        assert_eq!(
            engine_wire::parse_event(
                "[1:0814/221500.1:ERROR:gpu_init.cc(521)] Passthrough is not supported"
            ),
            None
        );
    }

    #[tokio::test]
    async fn an_unavailable_host_refuses_with_its_reason() {
        let host = EngineHost::unavailable("no engine here");
        assert!(!host.can_host());
        assert_eq!(host.state().to_string(), "unavailable: no engine here");
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let host = Arc::new(host);
        let error = host
            .open(
                PaneKey {
                    pane: tweb_core::page::PaneId(3),
                    tmux_server: "srv".into(),
                },
                tx,
                &engine_wire::OpenRequest {
                    pane: "%3",
                    tmux_server: "srv",
                    generation: crate::protocol::Generation(1),
                    image_id: 1,
                    frame_rate: 30,
                    adaptive_frame_rate: true,
                    restore_session: false,
                    geometry: crate::protocol::PaneGeometry {
                        cols: 80,
                        rows: 24,
                        width: 800,
                        height: 480,
                        origin: None,
                    },
                    tty: None,
                    url: "https://example.com",
                },
                0,
            )
            .await
            .expect_err("cannot host");
        assert_eq!(error, "no engine here");
        assert_eq!(host.hosted_pane_count(), 0);
    }

    // THE CONTRACT `electron/orphan-watch.cjs` READS. The daemon used to set `TWEB_FRONTEND_PID`
    // to its own pid, impersonating a per-pane frontend. The engine then SIGUSR1'd it to ask for a
    // keyboard-mode re-declaration, and SIGUSR1's default action is terminate: the daemon died
    // with every hosted pane attached (measured, rc=-30).
    #[test]
    fn a_hosted_engine_is_handed_the_supervisor_pid_and_never_a_frontend_pid() {
        let (name, pid) = orphan_watch_variable(4711);
        assert_eq!(name, "TWEB_SUPERVISOR_PID");
        assert_eq!(pid, "4711");
        assert_ne!(
            name, FRONTEND_PID_VARIABLE,
            "a supervisor owns no pty and must not claim to"
        );
    }

    // Exactly one of the two is set. Both would leave the watchdog choosing; neither would leave a
    // hosted engine with no watchdog at all — it would keep painting after its supervisor died,
    // which is precisely the four-hour stale-page case, now with N panes behind it.
    #[test]
    fn a_hosted_engine_always_has_exactly_one_watchable_pid() {
        let (name, pid) = orphan_watch_variable(std::process::id());
        assert!(!pid.is_empty());
        // What the engine resolves: the frontend variable is absent, so it falls to the supervisor
        // one, and the result is a pid it can actually watch.
        let watched: Option<u32> = None
            .or_else(|| Some(pid.parse::<u32>().expect("a pid")))
            .filter(|value| *value > 1);
        assert!(watched.is_some(), "{name} must yield a watchable pid");
        assert!(is_orphaned(watched, 1), "a reparented engine is orphaned");
        assert!(!is_orphaned(watched, 999), "a live parent is not init");
    }

    // An engine started by hand or by a test has no parent to watch, and exiting on a guess would
    // kill a legitimately parentless run.
    #[test]
    fn an_engine_with_no_watchable_pid_is_never_reaped() {
        assert!(!is_orphaned(None, 1));
        assert!(!is_orphaned(Some(1), 1));
    }

    #[test]
    fn engine_state_reads_as_one_diagnostic_line() {
        assert_eq!(EngineState::Idle.to_string(), "idle");
        assert_eq!(
            EngineState::Running { pid: 42 }.to_string(),
            "running (pid 42)"
        );
        assert_eq!(EngineState::Stopped.to_string(), "stopped");
    }

    fn tempdir() -> PathBuf {
        // A counter, not the thread id: a harness reuses thread ids as tests finish, so two tests
        // on the same worker would share a directory — and these write shell scripts into it.
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "twebd-engine-host-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// A stand-in engine: a shell script that behaves the way a real one would.
    ///
    /// A script rather than a mock, because the thing under test is what happens to a *process* —
    /// its stdout, its handshake and its death. A mock of the handshake would have passed against
    /// the very build that left a pane blank.
    fn fake_engine(name: &str, script: &str) -> Launcher {
        let dir = tempdir().join(name);
        std::fs::create_dir_all(&dir).expect("create app dir");
        std::fs::write(dir.join("main.cjs"), "").expect("write");
        std::fs::write(dir.join("package.json"), "{}").expect("write");
        let executable = dir.join("engine.sh");
        std::fs::write(&executable, script).expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
        Launcher {
            executable,
            app_dir: dir,
        }
    }

    fn open_request<'a>() -> engine_wire::OpenRequest<'a> {
        engine_wire::OpenRequest {
            pane: "%3",
            tmux_server: "srv",
            generation: crate::protocol::Generation(1),
            image_id: 4242,
            frame_rate: 30,
            adaptive_frame_rate: true,
            restore_session: false,
            geometry: crate::protocol::PaneGeometry {
                cols: 80,
                rows: 24,
                width: 800,
                height: 480,
                origin: Some((20, 0)),
            },
            tty: Some("/dev/ttys004"),
            url: "https://example.com",
        }
    }

    fn key() -> PaneKey {
        PaneKey {
            pane: tweb_core::page::PaneId(3),
            tmux_server: "srv".into(),
        }
    }

    // THE REGRESSION. A perfectly healthy engine that does not implement hosting used to be
    // accepted, because the check was "are the host's source files on disk" and those shipped
    // one release ahead of the host itself. The daemon then started it, it painted its own default
    // page into the pipe, and the requesting pane sat blank forever with nothing failing anywhere
    // to trigger a fallback. Nothing short of starting the process and demanding an answer catches
    // this.
    #[tokio::test]
    async fn an_engine_that_never_says_ready_is_refused_rather_than_left_running() {
        let launcher = fake_engine(
            "silent",
            "#!/bin/sh\necho '[0814/1:ERROR:gpu_init.cc(1)] noise'\nsleep 30\n",
        );
        let host = Arc::new(EngineHost::new(launcher));
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        // The real timeout is 10s of Electron cold start; the test drives virtual time so it
        // costs nothing to wait for it.
        tokio::time::pause();
        let error = host
            .open(key(), tx, &open_request(), 0)
            .await
            .expect_err("a silent engine cannot host");
        assert!(
            error.contains("did not declare itself a pane host"),
            "the refusal has to name the cause: {error}"
        );
        // And it stays refused, so the next pane does not pay for another ten-second start.
        assert!(!host.can_host());
        assert_eq!(host.hosted_pane_count(), 0);
    }

    // Two panes with one tmux pane id cannot both be hosted here, because the engine addresses
    // control lines `@%N` and carries no server identity: every `VIS`, `RESIZE` and `INPUT` for that
    // id would be ambiguous, and the engine answers ambiguity with silence rather than a guess.
    //
    // This is the daemon's half of the refusal, and it is the half that matters. An engine-only
    // refusal leaves the daemon answering `Hosted`, which is the frontend's signal to stop falling
    // back — so the pane would sit blank with nothing reporting a fault.
    #[tokio::test]
    async fn a_pane_id_hosted_for_another_tmux_server_is_reported_as_a_conflict() {
        let launcher = fake_engine(
            "pane-id-conflict",
            &format!(
                "#!/bin/sh\necho 'READY {}'\nwhile IFS= read -r line; do :; done\n",
                crate::protocol::PROTOCOL_VERSION,
            ),
        );
        let host = Arc::new(EngineHost::new(launcher));
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        host.open(key(), tx, &open_request(), 0)
            .await
            .expect("a ready engine hosts");

        // Same pane id, different tmux server: a conflict the caller must refuse.
        let twin = PaneKey {
            pane: tweb_core::page::PaneId(3),
            tmux_server: "another-server".into(),
        };
        let conflict = host
            .conflicting_pane_id(&twin)
            .expect("the conflict is reported");
        assert_eq!(conflict.tmux_server, "srv");
        assert_eq!(conflict.pane, tweb_core::page::PaneId(3));

        // The same pane on the SAME server is the reattach case, not a conflict — supersession
        // handles that, and treating it as a conflict would refuse every pane whose frontend was
        // restarted.
        assert!(host.conflicting_pane_id(&key()).is_none());

        // A different id on another server is not a conflict either.
        let other = PaneKey {
            pane: tweb_core::page::PaneId(9),
            tmux_server: "another-server".into(),
        };
        assert!(host.conflicting_pane_id(&other).is_none());
    }

    #[tokio::test]
    async fn an_engine_that_says_ready_is_hosted_and_gets_the_open_line() {
        // Echoes its stdin to a file so the test can assert the pane was actually opened on it.
        let record = tempdir().join("opened.txt");
        // Appends each control line as it arrives rather than on EOF: the daemon holds the engine's
        // stdin open for the process lifetime, so a script waiting for EOF would never write.
        let launcher = fake_engine(
            "ready",
            &format!(
                "#!/bin/sh\necho 'READY {}'\nwhile IFS= read -r line; do echo \"$line\" >> {}; done\n",
                crate::protocol::PROTOCOL_VERSION,
                record.display()
            ),
        );
        let host = Arc::new(EngineHost::new(launcher));
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        host.open(key(), tx, &open_request(), 0)
            .await
            .expect("a ready engine hosts");
        assert!(matches!(host.state(), EngineState::Running { .. }));
        assert_eq!(host.hosted_pane_count(), 1);

        // The engine appends each line as it arrives, so the assertion waits for the close rather
        // than for the process to exit.
        host.close(&key());
        for _ in 0..100 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            if let Ok(written) = std::fs::read_to_string(&record) {
                if written.contains("DETACH") {
                    assert!(
                        written.contains(
                            "@%3 ATTACH srv 1 4242 30 1 0 80 24 800 480 20 0 /dev/ttys004 https://example.com"
                        ),
                        "the open line has to reach the engine: {written:?}"
                    );
                    return;
                }
            }
        }
        panic!("the engine never received the pane's control lines");
    }

    // An engine from a different build answers, but with a version this daemon cannot talk to.
    // Refusing is what turns that into a pane running its own engine rather than a pane waiting
    // for frames in a shape nobody is sending.
    #[tokio::test]
    async fn an_engine_speaking_another_host_protocol_is_refused() {
        let launcher = fake_engine("wrong-version", "#!/bin/sh\necho 'READY 99'\nsleep 30\n");
        let host = Arc::new(EngineHost::new(launcher));
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let error = host
            .open(key(), tx, &open_request(), 0)
            .await
            .expect_err("a mismatched engine cannot host");
        assert!(error.contains("99"), "say which version: {error}");
        assert!(!host.can_host());
    }

    // The engine dying with panes attached must reach every one of them, or they wait forever for
    // frames from a process that no longer exists.
    #[tokio::test]
    async fn an_engine_that_dies_tells_every_hosted_pane() {
        let launcher = fake_engine(
            "dies",
            &format!(
                "#!/bin/sh\necho 'READY {}'\nexit 0\n",
                crate::protocol::PROTOCOL_VERSION
            ),
        );
        let host = Arc::new(EngineHost::new(launcher));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        host.open(key(), tx, &open_request(), 0)
            .await
            .expect("a ready engine hosts");
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("the pane is told within a reasonable time")
            .expect("the sink is still open");
        // An unnamed close is the host's own death, which the daemon turns into `engine_lost`.
        assert!(matches!(
            event,
            EngineEvent::Closed { ref pane, .. } if pane.is_empty()
        ));
        assert_eq!(host.hosted_pane_count(), 0, "the routing table is dropped");
    }
}
