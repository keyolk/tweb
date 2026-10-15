//! `--ssh <dest>`: a pane whose network is a remote host's.
//!
//! The pane frontend runs `ssh -N -D 127.0.0.1:<port> <dest>` and hands the engine
//! `socks5://127.0.0.1:<port>`, so every request the page makes — `localhost` included — leaves
//! from the remote host. That is the point of the mode: a dev server bound to the remote's
//! loopback opens in the pane as `http://localhost:<port>`, with no `-L` per port.
//!
//! The tunnel belongs to the FRONTEND, not to the engine, for two reasons:
//!
//! - ssh may have to ask something — a password, a passphrase, an unknown host key. It asks on
//!   `/dev/tty`, and only the frontend has the terminal in a state where a person can answer:
//!   before raw mode is entered, before the alternate screen. An engine-owned ssh would have to
//!   run with `BatchMode=yes` and refuse every host that is not key-only.
//! - The frontend IS the pane's lifetime. It is the process tmux SIGHUPs when the pane closes, and
//!   the engine is its child. Tying the tunnel to it ties the tunnel to the pane.
//!
//! What it must never do is outlive the pane. ssh is not a child that dies with its parent —
//! macOS has no PR_SET_PDEATHSIG, and `kill -9` on the frontend runs no destructor. So ssh is
//! started under a small `sh` guard that holds the read end of a pipe whose only write end is in
//! the frontend. However the frontend ends — clean exit, panic, SIGKILL — the kernel closes that
//! write end, the guard's `read` returns, and the guard kills ssh. The same reasoning as
//! electron/orphan-watch.cjs, applied one level down: no cooperation from the dying process is
//! needed.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

/// ssh flags that take a value, so the value is not mistaken for the destination.
const VALUE_FLAGS: &[&str] = &[
    "-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-P",
    "-p", "-Q", "-R", "-S", "-W", "-w",
];

/// Flags that change what ssh *is* rather than how it connects. Each one breaks the contract
/// this module relies on — a foreground process that serves one SOCKS port until it is killed:
/// `-f` forks into the background (the guard would see its child exit at once and the port would
/// be an orphan's), `-D` would add a second proxy the pane never uses, `-W`/`-O`/`-M`/`-S` turn it
/// into a stdio forward or a control-socket client, `-G`/`-V`/`-Q` only print and exit.
const REFUSED_FLAGS: &[&str] = &["-f", "-D", "-W", "-O", "-M", "-S", "-G", "-V", "-Q"];

/// How long a person gets to answer ssh's prompts before the pane gives up. Long, because the
/// common slow case is somebody typing a passphrase or reading a host-key fingerprint, not a
/// stuck network — `ConnectTimeout` in the user's ssh config bounds that one.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(120);

/// A parsed `--ssh` value: what to pass to ssh besides our own forwarding flags.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshTarget {
    /// The destination as ssh sees it (`user@host`, an ssh_config alias, …). Also the name the
    /// engine keys the pane's separate profile on.
    pub destination: String,
    /// The user's own flags, passed through in order before the destination.
    pub args: Vec<String>,
}

/// Parses `--ssh`.
///
/// Three shapes, in the order they are tried:
///
/// - `coder:<workspace>` — a Coder workspace through `coder ssh --stdio`, for a machine where
///   `coder config-ssh` has not been run. Where it has, its `coder.<workspace>` host works as a
///   plain destination and needs nothing from here.
/// - Several words, as on an ssh command line: `-J bastion -p 2222 me@box` (a leading `ssh` is
///   allowed and dropped). Flags pass through; exactly one word is the destination.
/// - One word: `host`, `user@host`, `user@host:port`, or any ssh_config `Host` alias.
///
/// A second non-flag word is refused rather than passed on: to ssh it is a remote COMMAND, and a
/// tunnel with a command attached is not a tunnel.
pub fn parse_target(value: &str) -> Result<SshTarget> {
    let value = value.trim();
    if let Some(workspace) = value.strip_prefix("coder:") {
        return coder_target(workspace);
    }
    let words: Vec<&str> = value.split_whitespace().collect();
    let words = match words.first() {
        Some(&"ssh") => &words[1..],
        _ => &words[..],
    };
    let mut args = Vec::new();
    let mut destination: Option<String> = None;
    let mut index = 0;
    while index < words.len() {
        let word = words[index];
        if word.starts_with('-') {
            // `-oFoo=bar` and `-p2222` carry their value in the same word; only the two-letter
            // form takes the next one.
            let flag = word.get(..2).unwrap_or(word);
            if REFUSED_FLAGS.contains(&flag) {
                bail!("--ssh cannot pass {flag} to ssh: tweb runs the tunnel itself");
            }
            if word == "-N" {
                // Ours already; passing it twice is harmless but noisy in `ps`.
                index += 1;
                continue;
            }
            args.push(word.to_string());
            if word.len() == 2 && VALUE_FLAGS.contains(&word) {
                let Some(next) = words.get(index + 1) else {
                    bail!("--ssh: {word} needs a value");
                };
                args.push((*next).to_string());
                index += 1;
            }
        } else if let Some(found) = &destination {
            bail!(
                "--ssh: both {found} and {word} look like destinations \
                 (a remote command is not allowed; the tunnel runs none)"
            );
        } else {
            let (host, port) = split_port(word)?;
            if let Some(port) = port {
                args.push("-p".to_string());
                args.push(port);
            }
            destination = Some(host);
        }
        index += 1;
    }
    let Some(destination) = destination else {
        bail!("--ssh needs a destination (host, user@host, user@host:port or an ssh_config alias)");
    };
    Ok(SshTarget { destination, args })
}

/// `user@host:port` → (`user@host`, Some(port)). Checked character by character because the word
/// becomes an argv entry for ssh and, through the engine, a profile directory name.
fn split_port(word: &str) -> Result<(String, Option<String>)> {
    let (host, port) = match word.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            (host, Some(port.to_string()))
        }
        Some(_) => bail!("--ssh: invalid destination {word}"),
        None => (word, None),
    };
    // `/` is allowed: Coder's config-ssh writes `Host owner/workspace.coder`.
    let valid = !host.is_empty()
        && !host.starts_with('-')
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@._-/".contains(&b));
    if !valid {
        bail!("--ssh: invalid destination {word}");
    }
    Ok((host.to_string(), port))
}

/// `coder:<workspace>` as an ssh target.
///
/// The host-key options mirror what `coder config-ssh` writes for its own hosts. They are safe for
/// the same reason they are there: the connection is `coder ssh --stdio`, which reaches the
/// workspace agent over Coder's own authenticated TLS tunnel, and the agent's host key changes
/// with every workspace build — checking it would only ever produce a warning to click through.
fn coder_target(workspace: &str) -> Result<SshTarget> {
    let valid = !workspace.is_empty()
        && !workspace.starts_with('-')
        && workspace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b));
    if !valid {
        bail!("--ssh coder:<workspace>: invalid workspace name {workspace:?}");
    }
    Ok(SshTarget {
        destination: format!("coder.{}", workspace.replace('/', ".")),
        args: [
            format!("ProxyCommand=coder ssh --stdio {workspace}"),
            "StrictHostKeyChecking=no".to_string(),
            "UserKnownHostsFile=/dev/null".to_string(),
            "LogLevel=ERROR".to_string(),
        ]
        .into_iter()
        .flat_map(|option| ["-o".to_string(), option])
        .collect(),
    })
}

/// The full ssh argv after the program name.
pub fn ssh_args(target: &SshTarget, port: u16, batch: bool) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if batch {
        // No terminal to answer on: fail at the first prompt instead of hanging until the
        // connect timeout with nobody able to see the question.
        args.extend(["-o".into(), "BatchMode=yes".into()]);
    }
    args.extend([
        "-N".into(),
        "-D".into(),
        format!("127.0.0.1:{port}"),
        // Without it a port already taken is a warning and ssh carries on serving nothing,
        // which the readiness probe would then wait on for the whole timeout.
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        // A dead link otherwise looks like a page that never loads. Three missed 15s probes end
        // the tunnel, and the pages then fail with a proxy error that says what happened.
        "-o".into(),
        "ServerAliveInterval=15".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
    ]);
    args.extend(target.args.iter().cloned());
    args.push(target.destination.clone());
    args
}

/// The guard. `$1` is the ssh program, the rest its argv. Prints ssh's pid, then waits for
/// either ssh to exit (status passed through) or fd 3 — the frontend's pipe — to reach EOF, in
/// which case ssh is killed. fd 3 is a copy of stdin made before stdin is pointed at /dev/null:
/// an asynchronous list in a non-interactive shell gets /dev/null as its stdin, so the watcher
/// has to name the pipe explicitly or it would read EOF at once.
const GUARD: &str = r#"program=$1; shift
exec 3<&0 </dev/null
"$program" "$@" 3<&- &
child=$!
echo "$child"
( read -r _ <&3; kill "$child" 2>/dev/null ) &
watcher=$!
exec 3<&-
wait "$child"; status=$?
kill "$watcher" 2>/dev/null
exit "$status""#;

/// A running tunnel. Dropping it ends ssh.
pub struct Tunnel {
    pub port: u16,
    pub destination: String,
    guard: Child,
    /// The write end the guard watches. Closing it is the stop signal.
    lifeline: Option<ChildStdin>,
    ssh_pid: Option<i32>,
}

impl Tunnel {
    /// The proxy rule the engine applies to its session.
    pub fn proxy_rules(&self) -> String {
        format!("socks5://127.0.0.1:{}", self.port)
    }

    /// Whether ssh is still running. A tunnel that died mid-session is reported, not restarted:
    /// a reconnect could prompt again, and the pane is in raw mode by then.
    pub fn alive(&mut self) -> bool {
        matches!(self.guard.try_wait(), Ok(None))
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        // The guard does the killing; closing the lifeline is how it is asked to.
        drop(self.lifeline.take());
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if !matches!(self.guard.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // The guard did not finish in time. ssh first: killing only the guard would orphan the
        // very process it exists to stop.
        if let Some(pid) = self.ssh_pid {
            // SAFETY: kill(2) on a pid this guard reported as its own child; no memory involved.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
        let _ = self.guard.kill();
        let _ = self.guard.wait();
    }
}

/// Opens the tunnel and waits until its SOCKS port answers.
///
/// `log` receives ssh's stderr: a pipe nobody reads after startup would fill and stall ssh, so
/// it goes to a file, and the tail of that file is what a failure reports.
pub fn open(target: &SshTarget, log: &Path) -> Result<Tunnel> {
    let program = std::env::var("TWEB_SSH").unwrap_or_else(|_| "ssh".to_string());
    // SAFETY: isatty(2) on fd 0 has no memory effects.
    let batch = unsafe { libc::isatty(0) } != 1;
    let port = free_port()?;
    let args = ssh_args(target, port, batch);
    let mut tunnel = spawn_guarded(&program, &args, log, target.destination.clone(), port)?;
    wait_for_socks(&mut tunnel, log, CONNECT_TIMEOUT)?;
    Ok(tunnel)
}

/// Starts `program args…` under the guard. Split from `open` so a test can guard any program.
fn spawn_guarded(
    program: &str,
    args: &[String],
    log: &Path,
    destination: String,
    port: u16,
) -> Result<Tunnel> {
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    let stderr = std::fs::File::create(log)
        .with_context(|| format!("cannot write the ssh log {}", log.display()))?;
    let mut guard = Command::new("/bin/sh")
        .arg("-c")
        .arg(GUARD)
        .arg("tweb-ssh-guard")
        .arg(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr))
        .spawn()
        .context("cannot start the ssh guard")?;
    let lifeline = guard.stdin.take();
    let mut line = String::new();
    if let Some(stdout) = guard.stdout.take() {
        let _ = BufReader::new(stdout).read_line(&mut line);
    }
    let ssh_pid = line.trim().parse::<i32>().ok();
    Ok(Tunnel {
        port,
        destination,
        guard,
        lifeline,
        ssh_pid,
    })
}

/// A port nothing listens on right now. The window between closing this listener and ssh
/// binding the port is a race in principle; `ExitOnForwardFailure` turns losing it into a clean
/// error instead of a tunnel serving nothing.
fn free_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").context("cannot find a free local port")?;
    Ok(listener.local_addr()?.port())
}

fn wait_for_socks(tunnel: &mut Tunnel, log: &Path, timeout: Duration) -> Result<()> {
    let address = SocketAddr::from(([127, 0, 0, 1], tunnel.port));
    let deadline = Instant::now() + timeout;
    loop {
        if !tunnel.alive() {
            bail!(
                "ssh to {} exited before its proxy started{}",
                tunnel.destination,
                log_tail(log)
            );
        }
        if socks_answers(address) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!(
                "ssh to {} did not open its proxy within {}s{}",
                tunnel.destination,
                timeout.as_secs(),
                log_tail(log)
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Whether a SOCKS5 server answers on `address`: a no-auth greeting, and the reply must accept
/// it. More than "something is listening" — another process that grabbed the port would accept
/// the connect too, and pages would then fail in a way that names the wrong cause.
pub fn socks_answers(address: SocketAddr) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(&[0x05, 0x01, 0x00]).is_err() {
        return false;
    }
    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).is_ok() && reply == [0x05, 0x00]
}

fn log_tail(log: &Path) -> String {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    let start = lines.len().saturating_sub(5);
    format!(":\n  {}", lines[start..].join("\n  "))
}

/// Where a pane's ssh stderr goes.
pub fn log_path(cache_logs: PathBuf, pane: &str) -> PathBuf {
    cache_logs.join(format!("ssh-{}.log", pane.trim_start_matches('%')))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(value: &str) -> SshTarget {
        parse_target(value).unwrap()
    }

    #[test]
    fn a_single_word_is_the_destination() {
        assert_eq!(
            target("me@box"),
            SshTarget {
                destination: "me@box".into(),
                args: vec![]
            }
        );
        assert_eq!(target("box:2222").args, vec!["-p", "2222"]);
        assert_eq!(target("box:2222").destination, "box");
        // config-ssh's own host names
        assert_eq!(target("coder.regular").destination, "coder.regular");
        assert_eq!(
            target("gavin-jeong/regular.coder").destination,
            "gavin-jeong/regular.coder"
        );
    }

    #[test]
    fn several_words_pass_the_flags_through() {
        let parsed = target("ssh -J bastion -p 2222 -oLogLevel=ERROR -N me@box");
        assert_eq!(parsed.destination, "me@box");
        assert_eq!(
            parsed.args,
            vec!["-J", "bastion", "-p", "2222", "-oLogLevel=ERROR"]
        );
    }

    #[test]
    fn what_would_break_the_tunnel_is_refused() {
        for value in [
            "-f box",
            "-D 9000 box",
            "-W host:22 box",
            "box uptime",
            "",
            "-p",
            "box;rm",
            "box:abc",
        ] {
            assert!(parse_target(value).is_err(), "{value:?} should be refused");
        }
    }

    #[test]
    fn a_coder_workspace_goes_through_coder_ssh() {
        let parsed = target("coder:gavin-jeong/regular");
        assert_eq!(parsed.destination, "coder.gavin-jeong.regular");
        assert!(parsed
            .args
            .contains(&"ProxyCommand=coder ssh --stdio gavin-jeong/regular".to_string()));
        assert!(parse_target("coder:a;b").is_err());
        assert!(parse_target("coder:").is_err());
    }

    #[test]
    fn our_flags_come_first_and_the_destination_last() {
        let args = ssh_args(&target("-J bastion me@box"), 4321, true);
        assert_eq!(&args[..2], ["-o", "BatchMode=yes"]);
        assert!(args.windows(2).any(|w| w == ["-D", "127.0.0.1:4321"]));
        assert_eq!(args.last().unwrap(), "me@box");
        assert!(!ssh_args(&target("box"), 1, false).contains(&"BatchMode=yes".to_string()));
    }

    #[test]
    fn the_probe_wants_a_socks_reply_not_just_a_listener() {
        let socks = TcpListener::bind("127.0.0.1:0").unwrap();
        let socks_address = socks.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = socks.accept().unwrap();
            let mut greeting = [0u8; 3];
            stream.read_exact(&mut greeting).unwrap();
            stream.write_all(&[0x05, 0x00]).unwrap();
        });
        assert!(socks_answers(socks_address));

        let silent = TcpListener::bind("127.0.0.1:0").unwrap();
        let silent_address = silent.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = silent.accept().unwrap();
            stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").ok();
        });
        assert!(!socks_answers(silent_address));
        assert!(!socks_answers(SocketAddr::from((
            [127, 0, 0, 1],
            free_port().unwrap()
        ))));
    }

    fn running(pid: i32) -> bool {
        // SAFETY: signal 0 only checks for existence.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn wait_until_gone(pid: i32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if !running(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn dropping_the_tunnel_ends_the_guarded_process() {
        let dir = std::env::temp_dir().join(format!("tweb-ssh-test-{}", std::process::id()));
        let tunnel = spawn_guarded(
            "sleep",
            &["30".to_string()],
            &dir.join("drop.log"),
            "box".into(),
            1,
        )
        .unwrap();
        let pid = tunnel.ssh_pid.expect("the guard reports its child");
        assert!(running(pid));
        drop(tunnel);
        assert!(
            wait_until_gone(pid),
            "the guarded process outlived its tunnel"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// The SIGKILL case: no destructor runs, only the kernel closing the frontend's pipe. Leaking
    /// the lifeline's ownership and closing its fd by hand is the same event without killing the
    /// test process.
    #[test]
    fn the_guard_ends_ssh_when_the_owner_vanishes_without_cleanup() {
        use std::os::fd::IntoRawFd;
        let dir = std::env::temp_dir().join(format!("tweb-ssh-test-k-{}", std::process::id()));
        let mut tunnel = spawn_guarded(
            "sleep",
            &["30".to_string()],
            &dir.join("kill.log"),
            "box".into(),
            1,
        )
        .unwrap();
        let pid = tunnel.ssh_pid.unwrap();
        let fd = tunnel.lifeline.take().unwrap().into_raw_fd();
        // SAFETY: closing a descriptor this test owns and no longer uses.
        unsafe {
            libc::close(fd);
        }
        assert!(
            wait_until_gone(pid),
            "ssh survived its owner's pipe closing"
        );
        assert!(!tunnel.alive());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn an_ssh_that_exits_early_is_reported_with_its_stderr() {
        let dir = std::env::temp_dir().join(format!("tweb-ssh-test-e-{}", std::process::id()));
        let log = dir.join("early.log");
        let mut tunnel = spawn_guarded(
            "sh",
            &[
                "-c".to_string(),
                "echo 'Permission denied (publickey).' >&2; exit 255".to_string(),
            ],
            &log,
            "box".into(),
            free_port().unwrap(),
        )
        .unwrap();
        let error = wait_for_socks(&mut tunnel, &log, Duration::from_secs(5)).unwrap_err();
        assert!(error.to_string().contains("Permission denied"), "{error}");
        std::fs::remove_dir_all(dir).ok();
    }
}
