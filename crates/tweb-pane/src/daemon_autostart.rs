//! Starting the supervisor when a pane needs one and none is running.
//!
//! The daemon is a per-user singleton that nothing else launches: there is no service manager
//! entry, no login hook, and a user who never runs `twebd serve` by hand would otherwise never
//! have one. While the daemon was opt-in that was fine — the flag and the daemon were turned on
//! together, by hand. With the daemon on by default it is the whole difference between shipping
//! the measurement and shipping the saving, because a pane that finds no socket falls back to
//! spawning its own engine and nothing changes.
//!
//! **The race is the point, and it is why nothing here checks first.** N panes can start in the
//! same millisecond, all find no socket, and all try. That is not a failure mode to prevent, it is
//! the ordinary case for a user opening a split: `twebd serve` takes an `flock` and the losers
//! exit silently with status 0 (`server::bind` returns `Ok(None)` when the lock is held). So this
//! spawns unconditionally and waits for the socket, rather than asking "is one running?" — a
//! question that cannot be answered by looking, which `singleton.rs` records at length.
//!
//! Everything here resolves towards the pane spawning its own engine. A daemon that cannot be
//! found, cannot be started, or does not come up in time is not an error the user has to see: it
//! is today's path, which works.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long to wait for a freshly started daemon to bind its socket.
///
/// It is a bind and a listen, not a page load — measured at well under 100ms on a cold start. The
/// budget is generous because the cost of being wrong in each direction is asymmetric: waiting an
/// extra half second delays one pane's first frame, while giving up early spawns a second Electron
/// that will be the process this user keeps for the session.
const SOCKET_WAIT: Duration = Duration::from_millis(1500);
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Where the `twebd` binary is, or `None` when this build cannot find one.
///
/// Beside the running `tweb` first, because that is what `make install` produces and what a
/// workspace `cargo build` produces — and it is the answer that cannot pick up a *different*
/// build's daemon from somewhere else on `PATH`. Running a daemon from another build is not
/// hypothetical: an installed `twebd` left running while a workspace `tweb` is rebuilt is the
/// ordinary case the protocol version exists to catch.
pub fn find_twebd() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("TWEB_TWEBD") {
        let path = PathBuf::from(path);
        return path.exists().then_some(path);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(directory) = exe.parent() {
            let candidate = directory.join("twebd");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    which::which("twebd").ok()
}

/// Whether the socket appeared within the budget.
///
/// Polls rather than watching the directory: the wait is bounded and short, and a filesystem
/// watcher is a dependency and a second failure mode for something a loop answers exactly.
fn wait_for_socket(socket: &Path, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        // Liveness, not existence — a stale socket file is present the whole time the daemon we
        // just started is taking it over, so polling `exists()` would return immediately and hand
        // the pane a name nothing is listening on.
        if socket_is_live(socket) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Whether something is listening on the socket right now.
///
/// A `connect()` and not a `stat()`, because a socket FILE outlives its daemon: a `SIGKILL`ed
/// daemon leaves the name behind, and every later pane would then see a socket, skip the start,
/// and fail at connect — falling back forever while a daemon was one spawn away. Measured exactly
/// that way: kill the daemon, and `exists()` is true while `connect()` gives ECONNREFUSED.
///
/// This is a liveness check for THIS decision only, and deliberately not the staleness rule the
/// daemon itself uses. `singleton.rs` records why a probe cannot decide staleness — a wedged
/// daemon still completes the handshake from the kernel's backlog, and ECONNREFUSED is also what a
/// live daemon gives in the instant between bind and listen. Neither ambiguity matters here: a
/// wedged daemon answers connect, so this yields to it and the pane's own `host` request times out
/// into a fallback; a daemon mid-bind is missed and this starts a second one, which loses the
/// `flock` and exits 0. Both cost one pane a fallback, and neither unlinks anything.
fn socket_is_live(socket: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(socket).is_ok()
}

/// Starts a daemon if nothing is listening, and reports whether one is there afterwards.
///
/// Returns `Ok(())` when the socket is live — whether this call started the daemon, another pane
/// did, or one was already running. The error is a string for the caller's `SpawnReason`, because
/// the caller's next move is the same for every failure: spawn an engine.
pub fn ensure_running(socket: &Path) -> Result<(), String> {
    let twebd = find_twebd().ok_or_else(|| "twebd not found beside tweb or on PATH".to_string());
    start_with(socket, twebd)
}

/// `ensure_running` with the binary already resolved.
///
/// Split out so the tests pass a path rather than setting `TWEB_TWEBD`: they run on one process and
/// a shared environment variable made them race — each test's cleanup cleared the next one's setup,
/// and which test failed depended on scheduling.
fn start_with(socket: &Path, twebd: Result<PathBuf, String>) -> Result<(), String> {
    if socket_is_live(socket) {
        return Ok(());
    }
    let twebd = twebd?;

    let mut command = std::process::Command::new(&twebd);
    command.arg("serve");
    // The daemon outlives this pane and must not hold its terminal: stdout is this pane's Kitty
    // graphics channel, and a daemon inheriting it would write log lines into the frame stream.
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(daemon_log());
    // The pane's identity must not leak into the daemon. `twebd` reads `TMUX_PANE` to name the
    // pane a bare `twebd attach` means, and the engine it spawns inherits its environment — an
    // engine that derived anything per-pane from the daemon's `$TMUX_PANE` would be deriving it
    // from whichever pane happened to start the daemon. Measured before the host was per-pane: an
    // agent socket claimed as `agent-%304.sock`, a name in an unrelated pane's namespace.
    command.env_remove("TMUX_PANE");
    // A pane's own engine settings are per-pane and travel in the ATTACH line instead.
    for name in [
        "TWEB_URL",
        "TWEB_VIEWPORT",
        "TWEB_PANE_ORIGIN",
        "TWEB_IMAGE_ID",
        "TWEB_FRONTEND_PID",
        "TWEB_MULTIPANE",
    ] {
        command.env_remove(name);
    }
    // Detached from this process group, or a Ctrl-C in the pane that started it would take the
    // daemon down with every other pane it serves.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: `setsid` is async-signal-safe and this runs in the forked child before exec.
        unsafe {
            command.pre_exec(|| {
                // Failure here is not fatal: the daemon still runs, it is merely still in this
                // process group. libc::setsid returns -1 when the caller is already a group
                // leader, which is a state, not an error.
                libc::setsid();
                Ok(())
            });
        }
    }

    let mut child = command
        .spawn()
        .map_err(|err| format!("{}: {err}", twebd.display()))?;

    let bound = wait_for_socket(socket, SOCKET_WAIT);
    if !bound {
        // It may have lost the singleton race and exited, which is a success for every other pane
        // but leaves this one with no socket to use — or it may be a daemon that cannot start at
        // all. Either way this pane spawns its own engine; the distinction is worth logging.
        let status = child.try_wait().ok().flatten();
        // A daemon that started but never bound is not ours to keep: it holds no socket, so no pane
        // will ever reach it, and leaving it running is a process that accumulates once per pane
        // that tried. Measured: the test for this path left a 30-second child behind every run.
        // A daemon that already EXITED is not signalled — `try_wait` reaped it.
        if status.is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
        return Err(match status {
            Some(status) => format!("twebd exited with {status} before binding its socket"),
            None => format!("twebd did not bind {} in time", socket.display()),
        });
    }
    // Not waited on: the daemon is meant to outlive this pane. It is `setsid`-detached and
    // reparented to init, so there is no zombie to reap here.
    Ok(())
}

/// Where a daemon this process starts writes its log.
///
/// A file rather than inherited stderr, which in a pane is the terminal — a daemon logging over
/// the page would be a visible defect, and the log is wanted either way when a pane silently falls
/// back.
fn daemon_log() -> std::process::Stdio {
    let Some(home) = std::env::var_os("HOME") else {
        return std::process::Stdio::null();
    };
    let directory = PathBuf::from(home).join(".cache/tweb/logs");
    if std::fs::create_dir_all(&directory).is_err() {
        return std::process::Stdio::null();
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("twebd.log"))
        .map_or_else(|_| std::process::Stdio::null(), std::process::Stdio::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp directory that is removed however the test ends.
    ///
    /// Written rather than reached for, because the manual form was not hermetic and said so: a
    /// failing test never reaches a trailing `remove_dir_all`, so it leaves a socket file behind —
    /// and the next run under the same pid reuses that directory and sees a socket where the test
    /// meant there to be none. Which test failed then depended on what an earlier run had left,
    /// which is why this passed on its own and failed under `cargo test --workspace`.
    ///
    /// The name has to be unique across PROCESSES, not just across threads, and a pid is not
    /// enough on its own. `tweb-pane` is linked into three test binaries — its own, `tweb`'s and
    /// `tweb-tauri`'s — and `cargo test` runs them concurrently, each with a counter that starts at
    /// zero. So `<pid>-<counter>` collided between binaries: one process bound a listener on the
    /// name while another asserted nothing was listening on it. That is what made this pass alone
    /// and fail about half the time under `cargo test --workspace`.
    ///
    /// A clock reading closes it — but the name also has to stay SHORT. These directories hold unix
    /// sockets, whose paths cannot exceed `SUN_PATH_MAX` (104 on macOS, and `twebd::paths` already
    /// carries that constant for the same reason). A nanosecond stamp spent the budget and every
    /// bind failed with `path must be shorter than SUN_LEN`. Base-36 of the low bits of the
    /// microsecond clock is ~8 characters and still separates two processes started in the same
    /// millisecond.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            use std::time::{SystemTime, UNIX_EPOCH};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let micros = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| since.as_micros() as u64);
            let mut stamp = String::new();
            let mut value = micros & 0xffff_ffff;
            while value > 0 {
                let digit = (value % 36) as u32;
                stamp.push(char::from_digit(digit, 36).unwrap_or('0'));
                value /= 36;
            }
            let dir = std::env::temp_dir().join(format!(
                "tw-as-{label}-{}-{stamp}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            // Removed first, not just created: a previous run that died mid-test owns this name.
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // A daemon that is actually listening is left alone, and nothing is spawned: the early return
    // is what keeps the ordinary case — a daemon already running — free of a process spawn per
    // pane.
    #[test]
    fn a_live_socket_needs_no_daemon_started() {
        let dir = TempDir::new("live");
        let socket = dir.join("twebd.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind");
        // The resolution is handed in as an error, so a call that tried to start one would fail —
        // proving the early return happened rather than merely that the result was `Ok`.
        assert!(start_with(&socket, Err("no binary".into())).is_ok());
    }

    // THE CASE A `stat()` GETS WRONG. A `SIGKILL`ed daemon leaves its socket file behind, so a
    // check for existence sees a daemon that is not there — and every pane afterwards skips the
    // start and fails at connect, falling back forever while a daemon was one spawn away.
    // Measured against a real daemon: kill it, and `exists()` is true while `connect()` gives
    // ECONNREFUSED.
    #[test]
    fn a_socket_file_with_nothing_listening_is_not_a_running_daemon() {
        let dir = TempDir::new("stale");
        let socket = dir.join("twebd.sock");
        // A socket path that was never bound at all — the plainest form of "a name with nothing
        // behind it", and the one that cannot depend on kernel timing.
        //
        // Dropping a listener in-process was the first shape of this test and it was flaky:
        // closing the fd does not synchronously tear the endpoint down, so a `connect()` on the
        // next line still succeeded sometimes. That is the same ambiguity `singleton.rs` records —
        // a probe cannot decide staleness — and a test that races it proves nothing either way.
        // The real stale case is covered where it can be produced honestly: `bench/daemon-e2e.py`
        // SIGKILLs a real daemon and the socket file it leaves is the one this guard is for.
        std::fs::write(&socket, b"").expect("write a plain file where a socket would be");
        assert!(socket.exists(), "the name is present");
        assert!(!socket_is_live(&socket), "but nothing is listening on it");
        let error =
            start_with(&socket, Err("not found".into())).expect_err("a start must be attempted");
        assert!(error.contains("not found"), "{error}");
    }

    #[test]
    fn a_missing_binary_is_a_reason_to_spawn_an_engine_not_an_error_to_raise() {
        let dir = TempDir::new("none");
        // The resolution is handed in as an error, standing for a `twebd` nothing can find.
        let error =
            start_with(&dir.join("twebd.sock"), Err("not found".into())).expect_err("no binary");
        assert!(error.contains("not found"), "{error}");
    }

    // A daemon that starts and never binds must not hold the pane past the budget: the pane has a
    // page to draw and an engine it can spawn itself.
    #[test]
    fn a_daemon_that_never_binds_gives_up_within_the_budget() {
        let dir = TempDir::new("slow");
        let fake = dir.join("twebd");
        std::fs::write(&fake, "#!/bin/sh\nsleep 30\n").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        let started = Instant::now();
        let error = start_with(&dir.join("twebd.sock"), Ok(fake.clone())).expect_err("never binds");
        let waited = started.elapsed();
        assert!(error.contains("did not bind"), "{error}");
        assert!(
            waited < SOCKET_WAIT + Duration::from_millis(500),
            "waited {waited:?}, budget is {SOCKET_WAIT:?}"
        );
    }
}
