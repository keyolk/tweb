//! Where the supervisor's socket and lock live, and how a client finds them.
//!
//! The runtime directory is deliberately the same one the per-pane agent sockets already use
//! (`crates/tweb-cli/src/agent.rs::runtime_dir`). Two discovery conventions for one user's
//! runtime state is how a client ends up looking in the wrong place after an environment change.

use std::path::{Path, PathBuf};

/// Socket file name inside the runtime directory.
pub const SOCKET_NAME: &str = "twebd.sock";

/// Lock file name inside the runtime directory. Beside the socket rather than in a separate
/// place, because singleton acquisition and socket ownership have to be the same decision.
pub const LOCK_NAME: &str = "twebd.lock";

/// The environment inputs that pick a runtime directory, pulled out so the choice is testable
/// without mutating the process environment (which no test can do safely in parallel).
#[derive(Debug, Clone)]
pub struct RuntimeDirEnv<'a> {
    /// `$TWEB_RUNTIME_DIR` — an explicit override, honoured everywhere.
    pub tweb_runtime_dir: Option<&'a str>,
    /// `$XDG_RUNTIME_DIR` — honoured on non-macOS only, matching the agent socket convention.
    pub xdg_runtime_dir: Option<&'a str>,
    /// `$TMPDIR` resolved to a directory.
    pub temp_dir: &'a Path,
    pub uid: u32,
    pub is_macos: bool,
}

/// The runtime directory for a given environment.
///
/// macOS ignores `$XDG_RUNTIME_DIR` because launchd does not set it and a stray value inherited
/// from a Linux-flavoured shell profile would put the socket somewhere the CLI never looks.
pub fn runtime_dir_for(env: &RuntimeDirEnv<'_>) -> PathBuf {
    if let Some(dir) = env.tweb_runtime_dir.filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir);
    }
    if !env.is_macos {
        if let Some(dir) = env.xdg_runtime_dir.filter(|dir| !dir.is_empty()) {
            return PathBuf::from(dir).join("tweb");
        }
    }
    env.temp_dir.join(format!("tweb-{}", env.uid))
}

/// The runtime directory for this process.
pub fn runtime_dir() -> PathBuf {
    let tweb = std::env::var("TWEB_RUNTIME_DIR").ok();
    let xdg = std::env::var("XDG_RUNTIME_DIR").ok();
    runtime_dir_for(&RuntimeDirEnv {
        tweb_runtime_dir: tweb.as_deref(),
        xdg_runtime_dir: xdg.as_deref(),
        temp_dir: &std::env::temp_dir(),
        uid: current_uid(),
        is_macos: cfg!(target_os = "macos"),
    })
}

/// getuid(2) cannot fail, so it needs no error path and no libc dependency.
pub fn current_uid() -> u32 {
    extern "C" {
        fn getuid() -> u32;
    }
    unsafe { getuid() }
}

pub fn socket_path_in(dir: &Path) -> PathBuf {
    dir.join(SOCKET_NAME)
}

pub fn lock_path_in(dir: &Path) -> PathBuf {
    dir.join(LOCK_NAME)
}

/// Whether a peer may talk to the supervisor.
///
/// The runtime directory is 0700, so this is a second line rather than the only one — but a
/// directory mode is a property of the filesystem and this is a property of the connection,
/// and only the latter survives someone relaxing the former.
pub fn peer_allowed(peer_uid: u32, our_uid: u32) -> bool {
    peer_uid == our_uid
}

/// A unix socket path longer than `sun_path` fails at bind with a message that names neither the
/// limit nor the path, so it is worth refusing early with both.
pub const SUN_PATH_MAX: usize = 104;

pub fn socket_path_too_long(path: &Path) -> bool {
    path.as_os_str().len() >= SUN_PATH_MAX
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(
        tweb: Option<&'a str>,
        xdg: Option<&'a str>,
        temp: &'a Path,
        is_macos: bool,
    ) -> RuntimeDirEnv<'a> {
        RuntimeDirEnv {
            tweb_runtime_dir: tweb,
            xdg_runtime_dir: xdg,
            temp_dir: temp,
            uid: 501,
            is_macos,
        }
    }

    #[test]
    fn explicit_override_wins_everywhere() {
        let temp = Path::new("/tmp");
        for is_macos in [true, false] {
            let dir = runtime_dir_for(&env(
                Some("/run/custom"),
                Some("/run/user/501"),
                temp,
                is_macos,
            ));
            assert_eq!(dir, PathBuf::from("/run/custom"));
        }
    }

    #[test]
    fn empty_override_is_not_an_override() {
        let temp = Path::new("/tmp");
        let dir = runtime_dir_for(&env(Some(""), None, temp, true));
        assert_eq!(dir, PathBuf::from("/tmp/tweb-501"));
    }

    #[test]
    fn linux_uses_xdg_runtime_dir() {
        let temp = Path::new("/tmp");
        let dir = runtime_dir_for(&env(None, Some("/run/user/501"), temp, false));
        assert_eq!(dir, PathBuf::from("/run/user/501/tweb"));
    }

    #[test]
    fn macos_ignores_xdg_runtime_dir() {
        let temp = Path::new("/var/folders/xx/T");
        let dir = runtime_dir_for(&env(None, Some("/run/user/501"), temp, true));
        assert_eq!(dir, PathBuf::from("/var/folders/xx/T/tweb-501"));
    }

    #[test]
    fn socket_and_lock_sit_together() {
        let dir = Path::new("/tmp/tweb-501");
        assert_eq!(
            socket_path_in(dir),
            PathBuf::from("/tmp/tweb-501/twebd.sock")
        );
        assert_eq!(lock_path_in(dir), PathBuf::from("/tmp/tweb-501/twebd.lock"));
    }

    #[test]
    fn only_the_same_uid_is_allowed() {
        assert!(peer_allowed(501, 501));
        assert!(!peer_allowed(0, 501));
        assert!(!peer_allowed(502, 501));
    }

    #[test]
    fn overlong_socket_paths_are_rejected() {
        let ok = PathBuf::from("/tmp/tweb-501/twebd.sock");
        assert!(!socket_path_too_long(&ok));
        let long = PathBuf::from(format!("/tmp/{}/twebd.sock", "a".repeat(120)));
        assert!(socket_path_too_long(&long));
    }
}
