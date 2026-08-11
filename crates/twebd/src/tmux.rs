//! tmux integration — pane lifecycle, hook, identity.
//!
//! DESIGN.md sections 5.2 and 9. Registers pane identity from `$TMUX` and `$TMUX_PANE`.
//! Collects the stable tmux server/session/window/pane IDs.

use tweb_core::page::PaneId;

/// tmux pane identity.
#[derive(Debug, Clone)]
pub struct TmuxPaneIdentity {
    pub pane: PaneId,
    pub tmux_server_id: String,
    pub session_id: String,
    pub window_id: String,
}

impl TmuxPaneIdentity {
    /// Collects the pane identity from the environment variables.
    /// `$TMUX_PANE` = `%3`, `$TMUX` = `/tmp/tmux-501/default,12345,0`.
    pub fn from_env() -> Option<Self> {
        let tmux_pane = std::env::var("TMUX_PANE").ok()?;
        let tmux = std::env::var("TMUX").ok()?;

        // $TMUX_PANE = "%3" → pane ID 3.
        let pane_id = tmux_pane
            .strip_prefix('%')
            .and_then(|s| s.parse::<i32>().ok())
            .map(PaneId)?;

        // $TMUX = "/tmp/tmux-501/default,12345,0" → socket path, pid, session.
        // Note that session_id does not appear in $TMUX, so it needs a separate query.
        let tmux_server_id = tmux
            .split(',')
            .next()
            .map(|s| s.to_string())
            .unwrap_or_default();

        Some(Self {
            pane: pane_id,
            tmux_server_id,
            session_id: String::new(), // TODO: tmux display-message -p '#{session_id}'
            window_id: String::new(),  // TODO: tmux display-message -p '#{window_id}'
        })
    }
}

/// Runs a tmux command (TODO: invoke the `tmux` CLI).
pub fn tmux_command(args: &[&str]) -> anyhow::Result<String> {
    let output = std::process::Command::new("tmux").args(args).output()?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        anyhow::bail!(
            "tmux command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
    }
}
