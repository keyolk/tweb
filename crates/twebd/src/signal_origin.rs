//! Who sent the signal that ended this process.
//!
//! On 2026-11-23 every tweb pane frontend, its daemon and the panes of five private test servers
//! ended three times within a few seconds of each other, each time just after an agent's shell
//! command finished. The daemon log said `signal received` and the frontends simply disconnected;
//! neither said from whom, and by the time anyone looked the sender was gone. This records the
//! sender's pid (`si_pid`) when a shutdown signal arrives, and names it from the process table
//! when the process acts on the signal, so the next occurrence says who did it.
//!
//! Registered only for signals the process already handles (twebd: SIGINT and SIGTERM; a hosted
//! frontend: those and SIGHUP). `signal_hook_registry` replaces a signal's default action once
//! anything is registered for it, so registering SIGHUP in the daemon would have stopped a hangup
//! from ending it.

use std::sync::atomic::{AtomicI32, Ordering};

static SENDER: AtomicI32 = AtomicI32::new(0);
static SIGNAL: AtomicI32 = AtomicI32::new(0);

/// Starts recording the sender of each of `signals`.
pub fn record(signals: &[i32]) {
    for &signal in signals {
        // SAFETY: the action stores two integers in atomics, which is async-signal-safe.
        let registered = unsafe {
            signal_hook_registry::register_sigaction(signal, move |info: &libc::siginfo_t| {
                SENDER.store(sender_pid(info), Ordering::Relaxed);
                SIGNAL.store(signal, Ordering::Relaxed);
            })
        };
        if let Err(error) = registered {
            tracing::debug!(%error, signal, "cannot record the sender of this signal");
        }
    }
}

#[cfg(target_os = "macos")]
fn sender_pid(info: &libc::siginfo_t) -> i32 {
    info.si_pid
}

#[cfg(not(target_os = "macos"))]
fn sender_pid(info: &libc::siginfo_t) -> i32 {
    // SAFETY: reading the pid field of a siginfo the kernel filled in for a signal sent by kill(2).
    unsafe { info.si_pid() }
}

/// The last recorded signal and the pid that sent it, if any arrived.
pub fn last() -> Option<(i32, i32)> {
    let signal = SIGNAL.load(Ordering::Relaxed);
    (signal != 0).then(|| (signal, SENDER.load(Ordering::Relaxed)))
}

/// `SIGTERM from pid 123 (ppid 1): /bin/sh -c ...`, read from the process table now. The sender
/// may have exited already, as `pkill` does at once; the pid is still what to look for in other
/// logs.
pub fn describe() -> String {
    let Some((signal, pid)) = last() else {
        return "no signal recorded".to_string();
    };
    let name = signal_name(signal);
    if pid <= 0 {
        // The kernel or a tty line discipline (a hangup, a typed ^C in cooked mode) leaves 0.
        return format!("{name} from the kernel or the terminal (no sender pid)");
    }
    let who = std::process::Command::new("ps")
        .args(["-o", "ppid=,command=", "-p", &pid.to_string()])
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|text| !text.is_empty());
    match who {
        Some(text) => {
            let (ppid, command) = text.split_once(char::is_whitespace).unwrap_or((&text, ""));
            format!("{name} from pid {pid} (ppid {ppid}): {}", command.trim())
        }
        None => format!("{name} from pid {pid} (already gone)"),
    }
}

fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGINT => "SIGINT".into(),
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGHUP => "SIGHUP".into(),
        other => format!("signal {other}"),
    }
}

/// Appends one line to `signals.log` in this daemon's logs directory (`paths::logs_dir`:
/// `~/.cache/tweb/logs` for the person's own). One write per line, so processes ending together do
/// not interleave.
pub fn append_log(line: &str) {
    let Some(mut file) = crate::paths::open_log("signals.log", false) else {
        return;
    };
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64());
    let _ = std::io::Write::write_all(&mut file, format!("{at:.3} {line}\n").as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signal_from_this_process_is_traced_to_it() {
        // SIGUSR2 rather than a shutdown signal: nothing in the test harness handles it, and the
        // registration keeps the default action from ending the test process.
        record(&[libc::SIGUSR2]);
        // SAFETY: raising a signal this process has a handler for.
        unsafe { libc::kill(std::process::id() as i32, libc::SIGUSR2) };
        for _ in 0..100 {
            if last().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let (signal, pid) = last().expect("the signal was recorded");
        assert_eq!(signal, libc::SIGUSR2);
        assert_eq!(pid, std::process::id() as i32);
        let said = describe();
        assert!(
            said.contains(&format!("from pid {}", std::process::id())),
            "{said}"
        );
    }
}
