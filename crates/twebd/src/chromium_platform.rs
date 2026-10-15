//! The Chromium switches the Electron engine needs from the machine it starts on.
//!
//! macOS needs none. Linux needs two decisions, and both have to be made by whoever spawns the
//! engine rather than inside `main.cjs`, because Chromium reads them before any app code runs:
//!
//! - **Which display backend.** A workstation has X11 or Wayland. A remote box — a Coder
//!   workspace, a dev VM reached over SSH — has neither, and Electron started there exits with
//!   "Missing X server or $DISPLAY" before the first line of the app. The engine never shows a
//!   window (every page is an offscreen surface), so it does not need a display at all; it needs
//!   Ozone's `headless` platform, which is what is chosen when no display is set.
//! - **Whether renderers can be sandboxed.** Chromium builds its sandbox from unprivileged user
//!   namespaces, or failing that from the setuid `chrome-sandbox` helper. Containers commonly
//!   allow neither (measured on a Coder workspace: `user.max_user_namespaces = 0`, and the helper
//!   unpacked by the runtime install is owned by the user, not root). Chromium then aborts with
//!   "No usable sandbox!". Turning the sandbox off is the one-flag fix and is NOT made silently:
//!   a page's renderer is where untrusted code runs, and the sandbox is what keeps a renderer
//!   exploit from being an exploit of the user's account. So it happens only when the sandbox
//!   genuinely cannot be built AND the user said so with `TWEB_NO_SANDBOX=1`; otherwise the
//!   pane fails with the reason and the three ways out.

use std::path::Path;

/// What the engine's renderers can be sandboxed with on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sandbox {
    /// Not a platform where the question arises (macOS uses the Seatbelt sandbox, always there).
    NotApplicable,
    /// Chromium can build its sandbox; the string says from what.
    Available(&'static str),
    /// It cannot, and the user opted out with `TWEB_NO_SANDBOX=1`. The string says why not.
    DisabledByUser(String),
    /// It cannot, and nobody opted out. Starting would abort inside Chromium.
    Unavailable(String),
}

/// The variable that permits running without the sandbox where it cannot be built.
pub const NO_SANDBOX_VARIABLE: &str = "TWEB_NO_SANDBOX";

/// Switches that put Chromium on Ozone's headless platform.
///
/// `--screen-info` because headless Ozone reports a 1x1 screen unless told otherwise, and an
/// offscreen window larger than its screen is clamped to it by some Chromium paths. The value is
/// a ceiling, not a size anything is drawn at: every pane sets its own surface size.
///
/// `--use-angle=swiftshader` because without it the GPU process asks ANGLE for an X display,
/// fails, exits, is restarted, fails again, and only then does Chromium settle for software
/// compositing with WebGL off — measured on a Coder workspace (Electron 43.2.0, no GPU): two GPU
/// process deaths per engine start and `webgl: disabled_off`. With SwiftShader the GPU process
/// comes up first time, `gpu_compositing: enabled`, and WebGL works (a map or a whiteboard needs
/// it). `--enable-unsafe-swiftshader` is deliberately NOT passed: that is Chromium's opt-in to
/// lower security guarantees, and tweb renders untrusted pages.
pub const HEADLESS_SWITCHES: [&str; 3] = [
    "--ozone-platform=headless",
    "--screen-info={8192x8192}",
    "--use-angle=swiftshader",
];

/// Below this, `/dev/shm` is a container's default and too small for Chromium.
///
/// Docker and Kubernetes give a container 64MB of `/dev/shm`. Chromium puts every renderer's
/// shared memory there, and a heavy page exhausts it and the renderer dies with "Aw, Snap" — or,
/// offscreen, with a pane that simply stops painting. `--disable-dev-shm-usage` moves that memory
/// to `/tmp`, which in a container is the overlay disk.
const SMALL_DEV_SHM_BYTES: u64 = 512 * 1024 * 1024;

#[cfg(target_os = "linux")]
fn dev_shm_bytes() -> Option<u64> {
    let path = std::ffi::CString::new("/dev/shm").ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // Safety: `path` is a valid C string and `stat` is written fully on success.
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return None;
    }
    let stat = unsafe { stat.assume_init() };
    #[allow(clippy::unnecessary_cast)] // the field widths differ between libcs
    Some(stat.f_blocks as u64 * stat.f_frsize as u64)
}

/// Whether Chromium should keep its shared memory out of `/dev/shm`.
pub fn small_dev_shm(bytes: Option<u64>) -> bool {
    bytes.is_some_and(|total| total < SMALL_DEV_SHM_BYTES)
}

/// Whether there is no display server to talk to. Empty counts as unset, as it does for Chromium.
pub fn is_headless(display: Option<&str>, wayland_display: Option<&str>) -> bool {
    display.is_none_or(str::is_empty) && wayland_display.is_none_or(str::is_empty)
}

fn headless_from_env() -> bool {
    is_headless(
        std::env::var("DISPLAY").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
    )
}

/// The sandbox decision, as a pure function of what was observed.
///
/// `opt_out` is only consulted when the sandbox cannot be built: a sandbox that works is kept even
/// with the variable set, because the variable is permission to run without one, not a request to.
pub fn decide_sandbox(
    user_namespaces: Result<(), String>,
    setuid_helper: Result<bool, &str>,
    opt_out: Option<&str>,
) -> Sandbox {
    if user_namespaces.is_ok() {
        return Sandbox::Available("unprivileged user namespaces");
    }
    if setuid_helper == Ok(true) {
        return Sandbox::Available("the setuid chrome-sandbox helper");
    }
    let helper = match setuid_helper {
        Err(blocker) => format!("chrome-sandbox is setuid root but cannot work: {blocker}"),
        _ => "chrome-sandbox is not setuid root".to_string(),
    };
    let reason = format!(
        "user namespaces are unavailable ({}) and {helper}",
        user_namespaces.err().unwrap_or_default()
    );
    if opt_out == Some("1") {
        Sandbox::DisabledByUser(reason)
    } else {
        Sandbox::Unavailable(reason)
    }
}

/// What stands between a setuid-root `chrome-sandbox` and the namespaces it creates.
///
/// Root is not enough on its own. The helper creates PID and network namespaces, which needs
/// `CAP_SYS_ADMIN`, and a setuid exec can only gain capabilities the bounding set still holds —
/// a container drops `CAP_SYS_ADMIN` from it (measured on a Coder workspace: `CapBnd` a80425fb).
/// There the helper is setuid root and still fails: "Failed to move to new namespace: ...
/// Operation not permitted", then Chromium's zygote aborts. `no_new_privs` defeats setuid
/// outright. Both are read from `/proc/self/status`, which the engine inherits unchanged.
pub fn setuid_blocker(status: &str) -> Option<&'static str> {
    const CAP_SYS_ADMIN: u32 = 21;
    let field = |name: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .map(str::trim)
    };
    if field("NoNewPrivs:").is_some_and(|value| value != "0") {
        return Some("no_new_privs is set, so setuid cannot raise privileges");
    }
    let bounding = field("CapBnd:").and_then(|hex| u64::from_str_radix(hex, 16).ok());
    if bounding.is_some_and(|caps| caps & (1 << CAP_SYS_ADMIN) == 0) {
        return Some("the capability bounding set has no CAP_SYS_ADMIN (a container)");
    }
    None
}

/// Whether `chrome-sandbox` beside the Electron binary is setuid root, and if it is, whether it
/// can work here: `Ok(true)` usable, `Ok(false)` not installed setuid, `Err` why it cannot work.
#[cfg(target_os = "linux")]
fn setuid_helper_beside(electron: &Path) -> Result<bool, &'static str> {
    use std::os::unix::fs::MetadataExt;
    let Some(directory) = electron.parent() else {
        return Ok(false);
    };
    let installed = std::fs::metadata(directory.join("chrome-sandbox"))
        .map(|meta| meta.uid() == 0 && meta.mode() & 0o4000 != 0)
        .unwrap_or(false);
    if !installed {
        return Ok(false);
    }
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    match setuid_blocker(&status) {
        Some(blocker) => Err(blocker),
        None => Ok(true),
    }
}

/// Tries what Chromium's namespace sandbox does first, in a throwaway child.
///
/// A new user namespace together with PID and network namespaces owned by it, which is the set
/// Chromium creates. Asking for all three rather than the user namespace alone is deliberate: on
/// Ubuntu 24.04 an unconfined program may create a user namespace but gets no capabilities in it,
/// so the user namespace alone succeeds and Chromium still fails at the next step. The sysctls are
/// not read instead because they are not the whole story — a container's seccomp filter can
/// refuse `unshare` with every sysctl permissive.
///
/// The child is `/bin/true` and the unshare runs between fork and exec, so the frontend itself
/// never changes namespace. A forked child is single-threaded, which `CLONE_NEWUSER` requires.
#[cfg(target_os = "linux")]
fn probe_user_namespaces() -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let mut command = std::process::Command::new("/bin/true");
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Safety: the closure only calls `unshare`, which is async-signal-safe, and reads errno.
    unsafe {
        command.pre_exec(|| {
            if libc::unshare(libc::CLONE_NEWUSER | libc::CLONE_NEWPID | libc::CLONE_NEWNET) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    let restricted =
        std::fs::read_to_string("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
            .map(|value| value.trim() == "1")
            .unwrap_or(false);
    match command.status() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("probe exited {status}")),
        Err(error) if restricted => Err(format!(
            "unshare: {error}; AppArmor restricts unprivileged user namespaces"
        )),
        Err(error) => Err(format!("unshare: {error}")),
    }
}

/// The sandbox Chromium will be able to use for an Electron binary at `electron`.
pub fn sandbox_for(electron: &Path) -> Sandbox {
    #[cfg(target_os = "linux")]
    {
        decide_sandbox(
            probe_user_namespaces(),
            setuid_helper_beside(electron),
            std::env::var(NO_SANDBOX_VARIABLE).ok().as_deref(),
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = electron;
        Sandbox::NotApplicable
    }
}

/// What to tell a user whose machine cannot sandbox Chromium, with the ways out in the order a
/// security-minded user would want to try them.
pub fn unavailable_message(electron: &Path, reason: &str) -> String {
    let helper = electron
        .parent()
        .map(|directory| directory.join("chrome-sandbox").display().to_string())
        .unwrap_or_else(|| "chrome-sandbox".to_string());
    format!(
        "Chromium cannot sandbox its page renderers here: {reason}.\n\
         Fix one of these, then reopen the pane:\n  \
         1. allow unprivileged user namespaces (sysctl user.max_user_namespaces / \
         kernel.unprivileged_userns_clone, an AppArmor profile for Electron on Ubuntu 24.04+, \
         or in a container the runtime's seccomp/userns settings)\n  \
         2. outside a container, make the setuid helper root's:  \
         sudo chown root:root {helper} && sudo chmod 4755 {helper}\n  \
         3. run without the sandbox, accepting that a compromised renderer is not contained:  \
         export {NO_SANDBOX_VARIABLE}=1"
    )
}

/// The switches to start the engine with, or why it cannot be started.
///
/// Logged where the decision is taken rather than returned, because both callers would log the
/// same lines and neither has anything to add to them.
pub fn engine_switches(electron: &Path) -> Result<Vec<String>, String> {
    if !cfg!(target_os = "linux") {
        return Ok(Vec::new());
    }
    let mut switches = Vec::new();
    if headless_from_env() {
        switches.extend(HEADLESS_SWITCHES.iter().map(|switch| (*switch).to_string()));
    }
    #[cfg(target_os = "linux")]
    if small_dev_shm(dev_shm_bytes()) {
        switches.push("--disable-dev-shm-usage".to_string());
    }
    match sandbox_for(electron) {
        Sandbox::NotApplicable => {}
        Sandbox::Available(source) => tracing::debug!(source, "chromium sandbox available"),
        Sandbox::DisabledByUser(reason) => {
            // Not `warn!`: the frontend's stderr is the pane, and by now the pane is the page's
            // screen — a log line there sits on top of the page for the pane's whole life. The
            // state is reported where it is looked for instead: `tweb doctor` (engine sandbox)
            // and `tweb diag` (`sandboxed: false`).
            tracing::info!(%reason, "running the engine WITHOUT the chromium sandbox ({NO_SANDBOX_VARIABLE}=1)");
            switches.push("--no-sandbox".to_string());
        }
        Sandbox::Unavailable(reason) => return Err(unavailable_message(electron, &reason)),
    }
    Ok(switches)
}

#[cfg(test)]
mod tests {
    use super::{
        decide_sandbox, is_headless, setuid_blocker, small_dev_shm, unavailable_message, Sandbox,
    };
    use std::path::Path;

    #[test]
    fn no_display_of_either_kind_is_headless() {
        assert!(is_headless(None, None));
        assert!(is_headless(Some(""), Some("")));
        assert!(!is_headless(Some(":0"), None));
        assert!(!is_headless(None, Some("wayland-0")));
    }

    #[test]
    fn only_a_container_sized_dev_shm_moves_shared_memory_out() {
        assert!(small_dev_shm(Some(64 * 1024 * 1024)));
        assert!(!small_dev_shm(Some(8 * 1024 * 1024 * 1024)));
        // Unmeasurable is not small: the flag costs speed and is only worth it when needed.
        assert!(!small_dev_shm(None));
    }

    #[test]
    fn a_working_sandbox_is_kept_even_when_the_user_permits_none() {
        assert_eq!(
            decide_sandbox(Ok(()), Ok(false), Some("1")),
            Sandbox::Available("unprivileged user namespaces")
        );
        assert_eq!(
            decide_sandbox(Err("EPERM".into()), Ok(true), Some("1")),
            Sandbox::Available("the setuid chrome-sandbox helper")
        );
    }

    #[test]
    fn no_sandbox_needs_both_the_failure_and_the_opt_out() {
        assert!(matches!(
            decide_sandbox(Err("EPERM".into()), Ok(false), None),
            Sandbox::Unavailable(_)
        ));
        // Only the exact value opts out; a stray `0` or `true` must not switch the sandbox off.
        for value in ["0", "true", ""] {
            assert!(matches!(
                decide_sandbox(Err("EPERM".into()), Ok(false), Some(value)),
                Sandbox::Unavailable(_)
            ));
        }
        assert!(matches!(
            decide_sandbox(Err("EPERM".into()), Ok(false), Some("1")),
            Sandbox::DisabledByUser(reason) if reason.contains("EPERM")
        ));
    }

    #[test]
    fn a_setuid_helper_without_the_capability_it_needs_is_not_a_sandbox() {
        // The Coder workspace this was measured on: setuid root, and the zygote still aborted.
        let container = "NoNewPrivs:\t0\nCapBnd:\t00000000a80425fb\n";
        assert!(setuid_blocker(container).is_some());
        let host = "NoNewPrivs:\t0\nCapBnd:\t000001ffffffffff\n";
        assert_eq!(setuid_blocker(host), None);
        assert!(setuid_blocker("NoNewPrivs:\t1\nCapBnd:\t000001ffffffffff\n").is_some());

        let blocked = decide_sandbox(
            Err("EPERM".into()),
            Err("the capability bounding set has no CAP_SYS_ADMIN (a container)"),
            None,
        );
        assert!(
            matches!(&blocked, Sandbox::Unavailable(reason) if reason.contains("CAP_SYS_ADMIN")),
            "{blocked:?}"
        );
    }

    #[test]
    fn the_refusal_names_the_helper_and_every_way_out() {
        let message = unavailable_message(Path::new("/c/electron-43/dist/electron"), "why");
        assert!(message.contains("why"));
        assert!(message.contains("sudo chmod 4755 /c/electron-43/dist/chrome-sandbox"));
        assert!(message.contains("user namespaces"));
        assert!(message.contains("TWEB_NO_SANDBOX=1"));
    }
}
