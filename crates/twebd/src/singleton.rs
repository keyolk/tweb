//! Singleton acquisition, and what to do about a socket file that is already there.
//!
//! Two panes can start in the same millisecond, so "is a daemon already running?" cannot be
//! answered by looking — only by trying to become one. `flock(2)` on a lock file beside the
//! socket is that attempt: the kernel serialises it, and it releases when the holder's fd closes,
//! including on `kill -9` and including on a process that never got to run any cleanup.
//!
//! Probing the socket with `connect()` is specifically *not* how staleness is decided, and the
//! reason is narrower than "a dead owner's socket still accepts" — measured here, a `connect()` to
//! a `SIGKILL`ed owner's socket file gets ECONNREFUSED, so that probe would look conclusive. It is
//! not, for two measured reasons:
//!
//! - A daemon that is alive but wedged — not calling `accept()` — still completes the handshake
//!   from the kernel's backlog, so `connect()` succeeds three times in a row against a process
//!   that will never serve. "Refused" and "accepted" therefore do not partition dead from alive.
//! - ECONNREFUSED is also what a live daemon gives during the instant between binding and
//!   listening, and unlinking a socket on the strength of that would delete a live daemon's name.
//!
//! `flock` has neither ambiguity: it is held or it is not, the kernel decides, and it releases on
//! process death whatever killed it. The lock is the truth; the socket file is just a name. This
//! is the same lesson `electron/audio-owner.cjs` records — ownership must be judged, not trusted —
//! reached there with a `{pane,pid,at}` claim file because that code had no connection to lean on.
//!
//! **One constraint that comes with `flock`, now that this daemon spawns an engine.** The lock
//! belongs to the *open file description*, and `fork` duplicates every fd — so a child forked
//! while the lock is open holds it too, until its `exec` closes it under `FD_CLOEXEC`. Closing the
//! lock during that window does not release it. Measured here: with another thread spawning live
//! children, an immediate re-acquire failed 2 times in 400.
//!
//! It is harmless as this daemon is built, because the lock is taken once at startup and held for
//! the process lifetime — the window only matters to code that releases and retakes it. Anything
//! that later wants to hand the lock over, or to drop it around spawning the engine, has to deal
//! with this rather than assume a drop is immediate.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::io::AsRawFd;
use std::path::Path;

/// What the caller must do, given the two facts it can observe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Acquisition {
    /// The lock is ours and nothing is in the way. Bind.
    Bind,
    /// The lock is ours but a socket file is left over from a daemon that no longer holds the
    /// lock. Unlink it, then bind. Unlinking is safe *only* because we hold the lock.
    TakeOverStale,
    /// Someone else holds the lock. A daemon is running; do not touch the socket.
    Yield,
}

/// The singleton decision, as a pure function of the two observable facts.
pub fn decide(lock_acquired: bool, socket_exists: bool) -> Acquisition {
    match (lock_acquired, socket_exists) {
        (false, _) => Acquisition::Yield,
        (true, true) => Acquisition::TakeOverStale,
        (true, false) => Acquisition::Bind,
    }
}

/// A held exclusive lock. The lock lives exactly as long as this value: dropping it closes the
/// fd, which is what releases the lock, so it must outlive the listener it protects.
#[derive(Debug)]
pub struct DaemonLock {
    // Never read; held so the fd stays open. Closing it would release the lock while the daemon
    // is still serving, and a second daemon would then bind over our socket.
    _file: File,
}

const LOCK_EX: i32 = 2;
const LOCK_NB: i32 = 4;

extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
}

/// Tries to take the singleton lock without blocking.
///
/// `Ok(None)` means another daemon holds it, which is a normal outcome and not an error.
pub fn try_acquire(lock_path: &Path) -> io::Result<Option<DaemonLock>> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)?;
    // Safe: the fd is valid for the lifetime of `file`, and flock takes no pointers.
    let rc = unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };
    if rc == 0 {
        return Ok(Some(DaemonLock { _file: file }));
    }
    let err = io::Error::last_os_error();
    match err.raw_os_error() {
        // EWOULDBLOCK/EAGAIN — someone else is the daemon.
        Some(code) if code == wouldblock_errno() => Ok(None),
        _ => Err(err),
    }
}

/// EWOULDBLOCK. Same value as EAGAIN on both macOS (35) and Linux (11), but spelled through the
/// standard library so neither number is hardcoded here.
fn wouldblock_errno() -> i32 {
    io::Error::from(io::ErrorKind::WouldBlock)
        .raw_os_error()
        .unwrap_or(35)
}

/// Removes a socket file left over from a daemon that is gone.
///
/// Only ever called while holding the lock. `NotFound` is success: the previous daemon may have
/// unlinked the socket during its own shutdown, and racing that is not a failure.
pub fn clear_stale_socket(socket_path: &Path) -> io::Result<()> {
    match std::fs::remove_file(socket_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

/// Creates the runtime directory, private to this user.
///
/// 0700 rather than the default umask because the socket inside it is an unauthenticated-by-path
/// control channel; the connection-level uid check is the second line, not the first.
pub fn ensure_runtime_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    match std::fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(dir)
    {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn losing_the_lock_means_yield_regardless_of_the_socket() {
        assert_eq!(decide(false, true), Acquisition::Yield);
        assert_eq!(decide(false, false), Acquisition::Yield);
    }

    #[test]
    fn holding_the_lock_over_a_leftover_socket_is_a_takeover() {
        assert_eq!(decide(true, true), Acquisition::TakeOverStale);
    }

    #[test]
    fn holding_the_lock_with_no_socket_is_a_plain_bind() {
        assert_eq!(decide(true, false), Acquisition::Bind);
    }

    // The re-acquire retries, and the reason is a real POSIX property rather than test flakiness.
    // `flock` is held by the *open file description*, and `fork` duplicates every fd — so a child
    // forked while this lock is open holds it too, until `exec` closes it under `FD_CLOEXEC`.
    // During that window a drop here does not release the lock. Measured directly: with another
    // thread spawning live children, an immediate re-acquire failed 2 times in 400.
    //
    // It is harmless for the daemon, which takes the lock once and holds it for its whole life,
    // and it stays harmless only because of that — a design that dropped and retook the lock
    // around spawning the engine would hit this for real.
    #[test]
    fn a_second_acquisition_of_a_held_lock_fails_without_blocking() {
        let dir = tempdir();
        let lock_path = dir.join("twebd.lock");
        let first = try_acquire(&lock_path).expect("io ok").expect("first wins");
        let second = try_acquire(&lock_path).expect("io ok");
        assert!(second.is_none(), "a second daemon must not get the lock");
        drop(first);
        let mut third = None;
        for _ in 0..50 {
            third = try_acquire(&lock_path).expect("io ok");
            if third.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            third.is_some(),
            "the lock must be free once the holder drops"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clearing_an_absent_socket_is_success() {
        let dir = tempdir();
        assert!(clear_stale_socket(&dir.join("nothing.sock")).is_ok());
        std::fs::write(dir.join("there.sock"), b"").expect("write");
        assert!(clear_stale_socket(&dir.join("there.sock")).is_ok());
        assert!(!dir.join("there.sock").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_runtime_dir_is_private_and_idempotent() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().join("nested/runtime");
        ensure_runtime_dir(&dir).expect("created");
        ensure_runtime_dir(&dir).expect("second call is a no-op");
        let mode = std::fs::metadata(&dir).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        std::fs::remove_dir_all(dir.parent().expect("parent")).ok();
    }

    /// A unique scratch directory. The crate has no dev-dependency on a temp-dir helper, and
    /// adding one would rewrite the workspace lockfile for the sake of six lines.
    ///
    /// The counter is what makes it unique, not the thread id: a test harness reuses thread ids as
    /// tests finish, so two tests that ran on the same worker shared a directory — and since these
    /// tests are about a *lock file*, sharing one made `try_acquire` see a lock another test still
    /// held and fail intermittently.
    fn tempdir() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "twebd-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }
}
