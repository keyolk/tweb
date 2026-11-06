//! `tweb daemon status|stop|restart` — thin wrappers over `twebd`.
//!
//! The supervisor (`twebd`) already has `status`, `list` and `stop` subcommands, but they live
//! on the `twebd` binary — which a person running `tweb` does not type. `tweb status` is the
//! *page* state, and `tweb diag` is geometry, so neither answers "is the engine up, what is it
//! doing, and how do I make it reload the preload I just changed?" This surfaces that without
//! asking the user to know about a second binary.
//!
//! Each subcommand shells out to `twebd` rather than speaking the socket protocol from here.
//! The protocol is `twebd`'s own, and the daemon binary is the one thing guaranteed to speak
//! the current version of it — a `tweb` built against a different `twebd` would produce a
//! protocol-mismatch error that `twebd status` already reports in plain language.

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use twebd::protocol::{Request, Response};

/// Finds the supervisor binary beside this `tweb`, then on `PATH`. Reuses the pane's resolver
/// because it is the same question and the same precedence — `make install` puts both beside
/// each other, and a workspace `cargo build` does too.
fn twebd_binary() -> Result<std::path::PathBuf> {
    tweb_pane::daemon_autostart::find_twebd().context("twebd not found beside tweb or on PATH")
}

/// Runs `twebd <sub>` and lets its stdout/stderr through unchanged.
fn twebd(sub: &str) -> Result<()> {
    let path = twebd_binary()?;
    let status = Command::new(&path)
        .arg(sub)
        .status()
        .with_context(|| format!("cannot run {} {}", path.display(), sub))?;
    if !status.success() {
        bail!("twebd {sub} exited with {status}");
    }
    Ok(())
}

/// `tweb daemon status` — supervisor diagnostics: pid, socket, uptime, pane count, engine state.
pub fn status() -> Result<()> {
    twebd("status")
}

/// `tweb daemon stop` — shut the supervisor down. Every pane it hosted goes with it; the next
/// `tweb open` or `tweb split` starts a fresh one.
pub fn stop() -> Result<()> {
    twebd("stop")
}

/// `tweb daemon restart` — stop, then start a new supervisor in the background.
///
/// `serve` detaches so this command returns once the new daemon has bound its socket, not when
/// it exits — `serve` keeps running. The pane frontend (`tweb open`) reattaches on its next
/// navigation, so no pane needs to be reopened by hand.
pub fn restart() -> Result<()> {
    let socket = twebd::paths::socket_path_in(&twebd::paths::runtime_dir());
    let old = daemon_pid(&socket);
    twebd("stop").ok();
    let path = twebd_binary()?;
    // `serve` is the long-running supervisor. It must not inherit this process's stdout — the
    // Kitty graphics channel owns that — so stdout is detached and stderr goes to the same log a
    // pane-started daemon writes.
    let mut serve = Command::new(&path);
    serve.arg("serve");
    // A restart is usually how newly installed code is loaded, but the engine app is named by
    // whichever pane reattaches first — an old frontend, naming the app it extracted when it
    // started. This `tweb` is the installed one, so its engine is pinned for the new daemon.
    if let Ok((executable, app_dir)) = tweb_pane::find_electron() {
        serve
            .env(twebd::server::PINNED_ENGINE_EXECUTABLE, executable)
            .env(twebd::server::PINNED_ENGINE_APP_DIR, app_dir);
    }
    let mut child = serve
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(tweb_pane::daemon_autostart::daemon_log())
        .spawn()
        .with_context(|| format!("cannot start {} serve", path.display()))?;
    // Printed "restarted" unconditionally before, with the new daemon's stderr discarded, so a
    // `serve` that lost the lock to a daemon a reattaching pane started looked like a success.
    match wait_for_serve(&mut child, old, &socket, SERVE_BUDGET) {
        ServeStart::Ours => println!("twebd restarted"),
        // Panes reattach every 750ms, so one can still win the gap. Its daemon works, but runs
        // whichever engine app that pane names — say so rather than claim new code is loaded.
        ServeStart::Other(pid) => bail!(
            "another twebd (pid {pid}) started first, likely by a reattaching pane, so the \
             installed engine is not pinned; run `tweb daemon restart` again"
        ),
        ServeStart::Exited(status) => bail!("twebd serve exited with {status} before listening"),
        ServeStart::Timeout => bail!("twebd serve did not listen on {}", socket.display()),
    }
    Ok(())
}

const SERVE_BUDGET: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(20);

enum ServeStart {
    Ours,
    Other(u32),
    Exited(std::process::ExitStatus),
    Timeout,
}

/// Which daemon ended up listening: the `serve` this command started, or another one.
///
/// `old` is the daemon `stop` was sent to, which can still answer for a moment after its `ok`.
fn wait_for_serve(
    child: &mut std::process::Child,
    old: Option<u32>,
    socket: &Path,
    budget: Duration,
) -> ServeStart {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        // A live socket is not enough: a daemon a pane started answers on the same name.
        match daemon_pid(socket) {
            Some(pid) if pid == child.id() => return ServeStart::Ours,
            Some(pid) if Some(pid) != old => return ServeStart::Other(pid),
            _ => {}
        }
        // Checked after the socket: a `serve` that lost the lock exits 0, and the winner is then
        // the daemon to report.
        if let Ok(Some(status)) = child.try_wait() {
            if !status.success() {
                return ServeStart::Exited(status);
            }
        }
        std::thread::sleep(POLL);
    }
    ServeStart::Timeout
}

/// The pid of the daemon listening on `socket`, if one answers.
fn daemon_pid(socket: &Path) -> Option<u32> {
    let mut client = twebd::client::Client::connect(socket).ok()?;
    match client.call(&Request::Status).ok()? {
        Response::Status { pid, .. } => Some(pid),
        _ => None,
    }
}
