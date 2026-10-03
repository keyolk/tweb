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

/// The Chrome profile `--engine chrome` runs on — the same path electron/cdp/backend.cjs resolves:
/// `TWEB_CHROME_PROFILE`, else `chrome-profile` under the engine's userData directory.
pub fn engine_profile_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("TWEB_CHROME_PROFILE") {
        return PathBuf::from(dir);
    }
    engine_user_data_dir().join("chrome-profile")
}

/// Electron's `app.getPath("userData")` for this app: `TWEB_USER_DATA_DIR`, else the platform's
/// application-data directory named after `package.json`'s `name`.
fn engine_user_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("TWEB_USER_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/tweb-electron")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("tweb-electron")
    }
}

/// Chrome binaries `--engine chrome` looks for, in the order electron/cdp/connection.cjs does.
const CHROME_BINARIES: &[&str] = &[
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
];

fn chrome_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("TWEB_CHROME") {
        return Some(PathBuf::from(path));
    }
    CHROME_BINARIES
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.exists())
}

/// Whether a Chrome currently holds `profile`. Chrome keeps a `SingletonLock` symlink in the
/// profile pointing at `<host>-<pid>` while it runs; a lock whose pid is gone is stale.
fn profile_in_use(profile: &std::path::Path) -> Option<u32> {
    let target = std::fs::read_link(profile.join("SingletonLock")).ok()?;
    let pid: u32 = target.to_string_lossy().rsplit('-').next()?.parse().ok()?;
    // Signal 0 checks existence without touching the process.
    let alive = std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    alive.then_some(pid)
}

/// Opens the `--engine chrome` profile in an ordinary Chrome window, so the user can sign in.
///
/// WHY a separate window: Google refuses sign-in with "This browser or app may not be secure"
/// inside the engine, and it is right to — the engine's Chrome is headless (`HeadlessChrome` in
/// its user agent) and CDP-controlled (`navigator.webdriver` is true), which is exactly what that
/// check exists to stop. Hiding either would be defeating a security control, so this does not.
/// Instead the same profile is opened with no DevTools port and no automation flags: a real
/// Chrome, signed into by the user, whose cookies and account then stay in the profile the
/// engine uses. Nothing is copied from the user's own Chrome.
pub fn login(url: &str) -> Result<()> {
    let profile = engine_profile_dir();
    if let Some(pid) = profile_in_use(&profile) {
        anyhow::bail!(
            "the Chrome engine profile is in use (Chrome pid {pid}); close every `--engine chrome` pane first, then run `tweb chrome login` again"
        );
    }
    let binary = chrome_binary()
        .ok_or_else(|| anyhow::anyhow!("Google Chrome not found; install it or set TWEB_CHROME"))?;
    std::fs::create_dir_all(&profile)?;
    println!(
        "Opening the TWeb Chrome profile ({}) in a normal Chrome window.",
        profile.display()
    );
    println!("Sign in there, then quit that Chrome window (Cmd-Q). `--engine chrome` panes keep the session.");
    let status = std::process::Command::new(&binary)
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if !status.success() {
        anyhow::bail!("Chrome exited with {status}");
    }
    println!("Chrome closed; the sign-in is stored in the profile.");
    Ok(())
}

#[cfg(test)]
mod login_tests {
    use super::profile_in_use;

    #[test]
    fn a_profile_without_a_lock_is_free() {
        let dir = std::env::temp_dir().join(format!("tweb-login-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(profile_in_use(&dir), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_lock_naming_a_live_pid_is_in_use_and_a_dead_one_is_stale() {
        let dir = std::env::temp_dir().join(format!("tweb-login-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let me = std::process::id();
        std::os::unix::fs::symlink(format!("host.local-{me}"), dir.join("SingletonLock")).unwrap();
        assert_eq!(profile_in_use(&dir), Some(me));
        std::fs::remove_file(dir.join("SingletonLock")).unwrap();
        // pid 1 cannot be signalled by us on macOS/Linux as a normal user, and a huge pid does
        // not exist; either way the lock is not ours to honour.
        std::os::unix::fs::symlink("host.local-999999", dir.join("SingletonLock")).unwrap();
        assert_eq!(profile_in_use(&dir), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
