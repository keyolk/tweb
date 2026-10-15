//! Whether the terminal that draws this pane is on this machine, and what follows from that.
//!
//! Every whole frame normally travels as `t=f`: the engine writes the pixels to a file and the
//! escape sequence carries only its path, which the terminal opens and reads. That is the fast
//! path on one machine and a broken one across two. Over SSH — a Coder workspace, a dev VM — the
//! path names a file on the remote box and the terminal looks for it on the laptop. Every frame
//! carries `q=2`, so the terminal cannot even say it failed: the pane simply stays blank.
//!
//! So a remote terminal gets `t=d`, the pixels inline in the escape sequence, as PNG. That also
//! rules out the two things the file path made affordable: raw `f=32` frames (20MB a frame does
//! not go down a network link) and therefore `o=z`, which only ever applied to raw frames — and
//! which kills Ghostty (see `electron/deflate-policy.cjs`), the terminal most likely to be on the
//! far end.
//!
//! The decision is made HERE, in the frontend, rather than in the engine, because this process is
//! the one standing in the pane: it has the pane's own environment, and the engine may be a daemon
//! started from some other pane, whose environment says nothing about this one.

/// Overrides the medium: `file` or `direct`. Also how the decision reaches the engine.
pub const TRANSPORT_VARIABLE: &str = "TWEB_FRAME_TRANSPORT";
/// Why the medium is what it is, for `tweb diag`. Set by the frontend, never by a user.
pub const REASON_VARIABLE: &str = "TWEB_FRAME_TRANSPORT_REASON";
/// `1` when the terminal is on another machine: the engine then paces whole frames by the bytes
/// that go down the link (`electron/frame-rate-policy.cjs`, `remoteFrameRateTiers`).
pub const REMOTE_VARIABLE: &str = "TWEB_REMOTE_TERMINAL";

/// The variables an SSH server sets in a session. Any one of them means the terminal is on the
/// client's machine. Coder sets them too (`SSH_CONNECTION=0.0.0.0 0 0.0.0.0 0`), and so does a
/// mosh server, which is started over SSH.
const SSH_VARIABLES: [&str; 3] = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Medium {
    /// `t=f`: a path to a file the terminal reads. Only works when it can see this filesystem.
    File,
    /// `t=d`: the pixels inline, base64 PNG.
    Direct,
}

impl Medium {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Direct => "direct",
        }
    }
}

/// What was found out about where the terminal is. Gathered by [`observe`], decided by [`decide`],
/// so the rules are testable without a tmux server or an SSH session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observed {
    /// `TWEB_FRAME_TRANSPORT` as set by the user.
    pub override_value: Option<String>,
    /// The first SSH variable set in this process's own environment.
    pub own_ssh: Option<String>,
    /// Whether this pane is inside tmux.
    pub in_tmux: bool,
    /// Inside tmux: the attached client's pid, and the SSH variable found in ITS environment
    /// (`Some(None)` when the environment was read and has none). `None` when it could not be read.
    pub client_ssh: Option<(u32, Option<String>)>,
    /// Inside tmux: whether the session's environment has `SSH_CONNECTION`, which tmux refreshes
    /// from each client that attaches (`update-environment`). `None` when it could not be read.
    pub session_ssh: Option<bool>,
}

/// Where the terminal is and which medium follows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub medium: Medium,
    pub remote: bool,
    /// One line a user can act on: what was observed, and whether it was overridden.
    pub reason: String,
}

/// Whether the terminal is remote, and the evidence.
///
/// Inside tmux the pane's own environment is the weakest evidence there is: it is whatever the
/// tmux SERVER inherited when it started, which can be a session from days ago on a different
/// machine. So the client that is attached right now is asked first, then the session's
/// environment tmux refreshes on every attach, and only then the process's own.
fn remote_evidence(observed: &Observed) -> (bool, String) {
    if observed.in_tmux {
        if let Some((pid, ssh)) = &observed.client_ssh {
            return match ssh {
                Some(variable) => (
                    true,
                    format!("the attached tmux client (pid {pid}) has {variable}"),
                ),
                None => (
                    false,
                    format!("the attached tmux client (pid {pid}) has no SSH_* variable"),
                ),
            };
        }
        if let Some(session) = observed.session_ssh {
            return if session {
                (
                    true,
                    "the tmux session environment has SSH_CONNECTION".to_string(),
                )
            } else {
                (
                    false,
                    "the tmux session environment has no SSH_CONNECTION".to_string(),
                )
            };
        }
    }
    match &observed.own_ssh {
        Some(variable) => (true, format!("{variable} is set")),
        None => (false, "no SSH_* variable is set".to_string()),
    }
}

pub fn decide(observed: &Observed) -> Choice {
    let (remote, evidence) = remote_evidence(observed);
    let forced = match observed.override_value.as_deref() {
        Some("file") => Some(Medium::File),
        Some("direct") => Some(Medium::Direct),
        _ => None,
    };
    match forced {
        Some(medium) => Choice {
            medium,
            remote,
            reason: format!("{TRANSPORT_VARIABLE}={} ({evidence})", medium.as_str()),
        },
        None => Choice {
            medium: if remote { Medium::Direct } else { Medium::File },
            remote,
            reason: if remote {
                format!("remote terminal: {evidence}")
            } else {
                format!("local terminal: {evidence}")
            },
        },
    }
}

fn first_ssh_variable(lookup: impl Fn(&str) -> Option<String>) -> Option<String> {
    SSH_VARIABLES
        .iter()
        .find(|name| lookup(name).is_some_and(|value| !value.is_empty()))
        .map(|name| (*name).to_string())
}

/// The SSH variable in a NUL-separated `/proc/<pid>/environ`, if any.
pub fn ssh_variable_in_environ(environ: &[u8]) -> Option<String> {
    let entries: Vec<&[u8]> = environ.split(|byte| *byte == 0).collect();
    first_ssh_variable(|name| {
        let prefix = format!("{name}=");
        entries.iter().find_map(|entry| {
            entry
                .strip_prefix(prefix.as_bytes())
                .map(|value| String::from_utf8_lossy(value).to_string())
        })
    })
}

fn tmux_output(args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("tmux")
        .args(args)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The attached client's environment, on a system that exposes another process's environment.
///
/// Linux only: `/proc/<pid>/environ` is readable for the user's own processes. macOS has no
/// equivalent short of parsing `ps`, and there the session environment below answers instead.
fn attached_client_ssh() -> Option<(u32, Option<String>)> {
    let pane = std::env::var("TMUX_PANE").ok()?;
    let pid: u32 = tmux_output(&["display-message", "-p", "-t", &pane, "#{client_pid}"])?
        .parse()
        .ok()?;
    let environ = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    Some((pid, ssh_variable_in_environ(&environ)))
}

fn session_ssh() -> Option<bool> {
    // `-SSH_CONNECTION` is how tmux records "removed by the last attach"; unknown means never set.
    let line = tmux_output(&["show-environment", "SSH_CONNECTION"]).unwrap_or_default();
    Some(line.starts_with("SSH_CONNECTION=") && line.len() > "SSH_CONNECTION=".len())
}

/// Gathers the evidence for this pane, from its own environment and its tmux server.
pub fn observe() -> Observed {
    let in_tmux = std::env::var("TMUX").is_ok_and(|value| !value.is_empty());
    Observed {
        override_value: std::env::var(TRANSPORT_VARIABLE).ok(),
        own_ssh: first_ssh_variable(|name| std::env::var(name).ok()),
        in_tmux,
        client_ssh: if in_tmux { attached_client_ssh() } else { None },
        session_ssh: if in_tmux { session_ssh() } else { None },
    }
}

/// The scale to render at when there is no display to ask.
///
/// The engine reads its scale from the display it runs on, and a headless engine has none: Ozone
/// headless reports 1, and a 2880x1800 pane on a Retina laptop then renders its pages at 2880 CSS
/// pixels — text at half size. What the far end's scale is cannot be asked over the link, but the
/// cell size says it plainly enough: a 12-14pt monospace cell is 15-20 device pixels tall at 1x and
/// 30-40 at 2x, so the gap between the two is wide and 26 sits in it.
pub fn scale_for_cell_height(cell_height: f64) -> f64 {
    if cell_height >= 26.0 {
        2.0
    } else {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::{decide, scale_for_cell_height, ssh_variable_in_environ, Medium, Observed};

    #[test]
    fn a_local_terminal_keeps_frame_files() {
        let choice = decide(&Observed::default());
        assert_eq!(choice.medium, Medium::File);
        assert!(!choice.remote);
    }

    #[test]
    fn ssh_outside_tmux_sends_frames_inline() {
        let choice = decide(&Observed {
            own_ssh: Some("SSH_CONNECTION".into()),
            ..Observed::default()
        });
        assert_eq!(choice.medium, Medium::Direct);
        assert!(choice.remote);
        assert!(
            choice.reason.contains("SSH_CONNECTION"),
            "{}",
            choice.reason
        );
    }

    #[test]
    fn inside_tmux_the_attached_client_outranks_the_servers_environment() {
        // A tmux server started over SSH, now attached from a local terminal: the pane inherited
        // SSH_CONNECTION from the server, and it is stale.
        let local_now = decide(&Observed {
            own_ssh: Some("SSH_CONNECTION".into()),
            in_tmux: true,
            client_ssh: Some((42, None)),
            session_ssh: Some(true),
            ..Observed::default()
        });
        assert_eq!(local_now.medium, Medium::File);
        assert!(local_now.reason.contains("pid 42"), "{}", local_now.reason);

        let remote_now = decide(&Observed {
            in_tmux: true,
            client_ssh: Some((42, Some("SSH_TTY".into()))),
            ..Observed::default()
        });
        assert_eq!(remote_now.medium, Medium::Direct);
    }

    #[test]
    fn inside_tmux_without_proc_the_session_environment_answers() {
        let choice = decide(&Observed {
            in_tmux: true,
            session_ssh: Some(true),
            ..Observed::default()
        });
        assert_eq!(choice.medium, Medium::Direct);
        let local = decide(&Observed {
            own_ssh: Some("SSH_CONNECTION".into()),
            in_tmux: true,
            session_ssh: Some(false),
            ..Observed::default()
        });
        assert_eq!(local.medium, Medium::File);
    }

    #[test]
    fn the_override_wins_and_still_reports_the_evidence() {
        let choice = decide(&Observed {
            override_value: Some("file".into()),
            own_ssh: Some("SSH_CONNECTION".into()),
            ..Observed::default()
        });
        assert_eq!(choice.medium, Medium::File);
        assert!(
            choice.remote,
            "the override picks the medium, not the location"
        );
        assert!(choice.reason.starts_with("TWEB_FRAME_TRANSPORT=file"));
        // Anything else is not an override.
        let ignored = decide(&Observed {
            override_value: Some("inline".into()),
            ..Observed::default()
        });
        assert_eq!(ignored.medium, Medium::File);
    }

    #[test]
    fn a_proc_environ_is_read_by_exact_name() {
        assert_eq!(
            ssh_variable_in_environ(b"HOME=/h\0SSH_CONNECTION=1 2 3 4\0TERM=x\0"),
            Some("SSH_CONNECTION".into())
        );
        assert_eq!(ssh_variable_in_environ(b"MY_SSH_TTY=/dev/pts/1\0"), None);
        assert_eq!(ssh_variable_in_environ(b"SSH_TTY=\0"), None);
    }

    #[test]
    fn cell_height_separates_1x_from_2x() {
        assert_eq!(scale_for_cell_height(17.0), 1.0);
        assert_eq!(scale_for_cell_height(20.0), 1.0);
        assert_eq!(scale_for_cell_height(34.0), 2.0);
        assert_eq!(scale_for_cell_height(40.0), 2.0);
    }
}
