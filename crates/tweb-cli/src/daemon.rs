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

use std::process::Command;

use anyhow::{bail, Context, Result};

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
    twebd("stop").ok();
    let path = twebd_binary()?;
    // `serve` is the long-running supervisor. It must not inherit this process's stdout — the
    // Kitty graphics channel owns that — so detach both stdout and stderr.
    let status = Command::new(&path)
        .arg("serve")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .with_context(|| format!("cannot start {} serve", path.display()))?;
    // The child is detached: we do not wait for it. A serve that binds the socket and then
    // runs forever is the success case, so spawning is all this command needs to see.
    drop(status);
    println!("twebd restarted");
    Ok(())
}
