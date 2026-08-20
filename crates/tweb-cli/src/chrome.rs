//! The managed Chrome handoff — DESIGN.md section 11.
//!
//! Some pages refuse to work anywhere but real Google Chrome. Okta's Device Trust is the
//! reason this exists: the check is an attestation performed by an extension in a
//! managed Chrome, so it is not something a user agent string can answer. TWeb does not
//! try. It hands the URL to Chrome and says so.
//!
//! The bridge is `tmux-chrome`, which already is the minimum this section asks for —
//! opening a URL, tracking the tab, focusing it — with none of the permissions section 11
//! withholds: no `debugger`, no broad `scripting`, no cookie access. When it is not
//! there, the URL still opens: `open -a "Google Chrome"` hands the URL over and nothing
//! else. Neither path reads or writes the profile.
//!
//! **Hand over a site, not an identity provider, and do not automate the choice.** That was
//! tried: the engine routed `*.okta.com` to Chrome on navigation. It fails, because an SSO
//! login is a redirect chain rather than a page — the service sets a state cookie, the IdP
//! authenticates, the callback needs that cookie again. Routing the IdP alone puts a browser
//! boundary inside the chain. Measured against a real Argo CD tenant: the login started in
//! TWeb, the callback landed in Chrome, and dex answered `Bad Request — User session error`,
//! because the session was in the other browser's store. Two browsers cannot share one OAuth
//! flow, so the unit that can be handed off is a whole site, chosen by someone who knows they
//! need it.

use std::path::PathBuf;
use std::process::Command;

use anyhow::{Context, Result};

/// Where `tmux-chrome`'s native-messaging bridge listens. Fixed by that project.
const BRIDGE_SOCKET: &str = "/tmp/tmux-chrome-bridge.sock";

/// How the handoff reached Chrome, for the caller to report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handoff {
    /// Through `tmux-chrome`, so the tab joins this tmux window's group.
    Bridge,
    /// Through the system opener. Chrome gets the URL; nothing groups it.
    SystemOpen,
}

/// What the bridge looks like right now.
pub struct BridgeStatus {
    pub socket: Option<PathBuf>,
    pub tmux_chrome: Option<PathBuf>,
    pub chrome_installed: bool,
}

fn which(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(program))
        .find(|candidate| candidate.is_file())
}

fn chrome_installed() -> bool {
    PathBuf::from("/Applications/Google Chrome.app").exists()
}

impl BridgeStatus {
    /// The status as `tweb chrome status` prints it — one fact per line, in the order a
    /// person diagnoses them: the bridge, then what would run it, then what it opens.
    pub fn report(&self) -> String {
        let bridge = match &self.socket {
            Some(path) => format!("{} (up)", path.display()),
            None => "not running".to_string(),
        };
        let tmux_chrome = match &self.tmux_chrome {
            Some(path) => path.display().to_string(),
            None => "not installed".to_string(),
        };
        let chrome = if self.chrome_installed {
            "installed"
        } else {
            "not installed"
        };
        format!("bridge:      {bridge}\ntmux-chrome: {tmux_chrome}\nchrome:      {chrome}")
    }
}

/// Reads the bridge state without changing it.
pub fn status() -> BridgeStatus {
    let socket = PathBuf::from(BRIDGE_SOCKET);
    BridgeStatus {
        socket: socket.exists().then_some(socket),
        tmux_chrome: which("tmux-chrome"),
        chrome_installed: chrome_installed(),
    }
}

/// Opens `url` in real Google Chrome.
///
/// The bridge is preferred because it puts the tab in this tmux window's group, which is
/// what makes the handoff feel like part of the same workspace rather than a page that
/// vanished into another application. Its absence is not an error — a URL that has to
/// reach Chrome is worth more than the grouping.
pub fn open(url: &str) -> Result<Handoff> {
    let state = status();
    if let (Some(bridge), Some(_)) = (&state.socket, &state.tmux_chrome) {
        let _ = bridge;
        let status = Command::new("tmux-chrome")
            .args(["open", url])
            .stdout(std::process::Stdio::null())
            .status();
        if matches!(status, Ok(code) if code.success()) {
            return Ok(Handoff::Bridge);
        }
        // Falling through rather than failing: the bridge answering badly is exactly the
        // case the system opener exists for.
    }

    anyhow::ensure!(
        state.chrome_installed,
        "Google Chrome is not installed; this URL needs it"
    );
    let status = Command::new("open")
        .args(["-a", "Google Chrome", url])
        .status()
        .context("cannot run `open`")?;
    anyhow::ensure!(status.success(), "`open -a \"Google Chrome\"` failed");
    Ok(Handoff::SystemOpen)
}
