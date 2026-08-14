//! tmux identity — how a pane names itself to the supervisor.
//!
//! DESIGN.md sections 5.2 and 9. Only the identity half lives here; pane hooks and lifecycle
//! commands belong to whichever process ends up owning the engine, which is still being measured.

use crate::protocol::PaneRef;
use tweb_core::page::PaneId;

/// The tmux server identity out of `$TMUX`.
///
/// `$TMUX` is `socket-path,server-pid,session-index`. The socket path and the server pid together
/// name the server; the session index is positional and changes when sessions are created or
/// killed, so it is dropped. Keeping the pid matters: a tmux restarted on the same socket path is
/// a different server that starts reissuing `%0`, and a supervisor that could not tell those
/// apart would hand a fresh pane the dead one's registration.
pub fn server_identity_from(tmux: Option<&str>) -> Option<String> {
    let value = tmux?.trim();
    if value.is_empty() {
        return None;
    }
    let mut parts = value.split(',');
    let socket = parts.next()?.trim();
    if socket.is_empty() {
        return None;
    }
    match parts.next().map(str::trim).filter(|pid| !pid.is_empty()) {
        Some(pid) => Some(format!("{socket},{pid}")),
        None => Some(socket.to_string()),
    }
}

/// A pane reference from `$TMUX_PANE` and `$TMUX`.
pub fn pane_ref_from(tmux_pane: Option<&str>, tmux: Option<&str>) -> Option<PaneRef> {
    let pane = tmux_pane?.trim();
    if pane.is_empty() {
        return None;
    }
    Some(PaneRef {
        pane: pane.to_string(),
        tmux_server: server_identity_from(tmux)?,
    })
}

/// This process's pane reference, if it is running inside tmux.
pub fn pane_ref_from_env() -> Option<PaneRef> {
    let pane = std::env::var("TMUX_PANE").ok();
    let tmux = std::env::var("TMUX").ok();
    pane_ref_from(pane.as_deref(), tmux.as_deref())
}

/// Runs a tmux command.
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

/// The pane id a tmux pane reference names, for callers that need the parsed form.
pub fn pane_id_of(reference: &PaneRef) -> Option<PaneId> {
    crate::protocol::parse_pane_id(&reference.pane).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_identity_keeps_the_socket_and_the_server_pid() {
        assert_eq!(
            server_identity_from(Some("/tmp/tmux-501/default,12345,0")),
            Some("/tmp/tmux-501/default,12345".to_string())
        );
    }

    #[test]
    fn the_session_index_is_dropped_because_it_moves() {
        let first = server_identity_from(Some("/tmp/tmux-501/default,12345,0"));
        let second = server_identity_from(Some("/tmp/tmux-501/default,12345,4"));
        assert_eq!(first, second);
    }

    #[test]
    fn a_restarted_server_on_the_same_socket_is_a_different_identity() {
        assert_ne!(
            server_identity_from(Some("/tmp/tmux-501/default,111,0")),
            server_identity_from(Some("/tmp/tmux-501/default,222,0"))
        );
    }

    #[test]
    fn no_tmux_means_no_identity() {
        assert_eq!(server_identity_from(None), None);
        assert_eq!(server_identity_from(Some("   ")), None);
        assert_eq!(server_identity_from(Some(",123,0")), None);
        assert!(pane_ref_from(None, Some("/tmp/s,1,0")).is_none());
        assert!(pane_ref_from(Some("%3"), None).is_none());
    }

    #[test]
    fn a_pane_ref_carries_both_halves_of_the_identity() {
        let reference =
            pane_ref_from(Some("%3"), Some("/tmp/tmux-501/default,12345,0")).expect("in tmux");
        assert_eq!(reference.pane, "%3");
        assert_eq!(reference.tmux_server, "/tmp/tmux-501/default,12345");
        assert_eq!(pane_id_of(&reference), Some(PaneId(3)));
    }
}
