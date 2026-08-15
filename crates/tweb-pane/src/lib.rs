//! tweb __pane — the foreground process of a tmux browser pane.
//!
//! DESIGN.md section 5.2. The actual foreground process of every tmux browser pane.
//! Core job: spawn the Electron offscreen process and forward paint events (frames)
//! to the terminal as Kitty graphics on stdout.
//!
//! Minimum feature set:
//! - `tweb __pane <url>` → spawn Electron, load the URL
//! - paint event → Kitty graphics → shown in the terminal
//! - pane resize → Electron viewport resize
//! - pane kill → Electron shutdown, image delete

pub mod attach;
pub mod display;
mod engine_app;
pub mod graphics;
pub mod hosted;
pub mod input;
pub mod pane_writer;
pub mod resize;
pub mod terminal;
pub mod visibility;

use anyhow::{Context, Result};
use std::io::Write;
use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BrowserEngine {
    #[default]
    Electron,
    Tauri,
}

#[derive(Clone, Copy, Debug)]
pub struct PaneOptions {
    pub engine: BrowserEngine,
    pub frame_rate: u16,
    pub adaptive_frame_rate: bool,
    pub restore_session: bool,
}

impl Default for PaneOptions {
    fn default() -> Self {
        Self {
            engine: BrowserEngine::Electron,
            frame_rate: 30,
            adaptive_frame_rate: true,
            restore_session: false,
        }
    }
}

/// How many damage-patch image ids the engine reserves after the base id. Must match
/// `PATCH_ID_COUNT` in electron/main.cjs: the frontend deletes on paths the engine cannot
/// reach (a pane torn down under it), and deleting only the base leaves the patches on
/// screen — small strips of a page that is no longer there.
const PATCH_ID_COUNT: u32 = 8;

fn raw_kitty_delete(image_id: u32) -> String {
    let mut sequence = format!("\x1b_Ga=d,d=I,i={image_id},q=2\x1b\\");
    for slot in 0..PATCH_ID_COUNT {
        let patch = image_id + 1 + slot;
        sequence.push_str(&format!("\x1b_Ga=d,d=I,i={patch},q=2\x1b\\"));
    }
    sequence
}

fn resize_control_message(geometry: terminal::WindowGeometry) -> String {
    let size = geometry.size;
    if let Some((left, top)) = geometry.origin {
        format!(
            "RESIZE {} {} {} {} {} {}\n",
            size.cols, size.rows, size.width, size.height, left, top,
        )
    } else {
        format!(
            "RESIZE {} {} {} {}\n",
            size.cols, size.rows, size.width, size.height,
        )
    }
}

fn changed_geometry_message(
    previous: &mut Option<terminal::WindowGeometry>,
    current: Option<terminal::WindowGeometry>,
) -> Option<String> {
    let geometry = current?;
    if *previous == Some(geometry) {
        return None;
    }
    *previous = Some(geometry);
    Some(resize_control_message(geometry))
}

fn forward_changed_geometry(
    control_tx: &tokio::sync::mpsc::UnboundedSender<String>,
    previous: &mut Option<terminal::WindowGeometry>,
) {
    let current = terminal::window_geometry();
    tracing::debug!(?current, ?previous, "geometry poll");
    if let Some(message) = changed_geometry_message(previous, current) {
        let _ = control_tx.send(message);
    }
}

/// The tick that keeps the engine's view of this pane current: where it sits, how big it
/// is, and which terminal clients can see it. All three come from one chained `tmux` call
/// inside tmux, so a tick costs one child process instead of the three it would take to
/// ask separately — and the engine spawns none at all.
///
/// Outside tmux there is nothing to be visible *to*, so only geometry is forwarded and the
/// engine stays on its no-frontend default of always-visible.
fn forward_pane_state(
    control_tx: &tokio::sync::mpsc::UnboundedSender<String>,
    pane: &str,
    previous_geometry: &mut Option<terminal::WindowGeometry>,
    previous_visibility: &mut Option<String>,
) {
    if std::env::var_os("TMUX").is_none() {
        forward_changed_geometry(control_tx, previous_geometry);
        return;
    }

    let Some(probe) = visibility::run_probe(pane) else {
        // A failed probe says nothing about the pane, so report nothing. Pushing a blank
        // result would land as "no client can see this pane" and stop painting.
        return;
    };
    tracing::debug!(?probe, "pane probe");

    // `window_geometry()` is deliberately not called here: it would spawn its own tmux
    // child for placement this probe already has. The PTY ioctl fallback it also owns
    // only matters when tmux cannot answer, which is the branch that returned above.
    if let Some(message) = changed_geometry_message(previous_geometry, probe.geometry) {
        let _ = control_tx.send(message);
    }
    if let Some(message) = visibility::changed_visibility_message(previous_visibility, &probe) {
        let _ = control_tx.send(message);
    }
}

fn tmux_passthrough(sequence: &str) -> String {
    let escaped = sequence.replace('\x1b', "\x1b\x1b");
    format!("\x1bPtmux;{escaped}\x1b\\")
}

/// The client TTYs that are actually showing this pane.
///
/// A delete written to a client TTY bypasses tmux, so the set has to be the panes a client
/// can really see rather than every client on the window. A zoomed window keeps its window
/// id while showing only its active pane, so matching on session and window alone treats
/// every other pane in that window as visible and writes escape bytes into a terminal that
/// is displaying something else. `electron/tmux-visibility.cjs` has always applied the zoom
/// rule; this is the same rule on the Rust side, so the two agree about what "visible" means.
fn matching_client_ttys(identity: &str, clients: &str) -> Vec<String> {
    let mut identity_fields = identity.trim().split('\t');
    let Some(session) = identity_fields.next() else {
        return Vec::new();
    };
    let Some(window) = identity_fields.next() else {
        return Vec::new();
    };
    // An identity without a pane id predates the zoom rule; falling back to window-only
    // matching keeps such a caller working rather than silently deleting nothing.
    let pane = identity_fields.next();
    clients
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let tty = fields.next()?;
            let client_session = fields.next()?;
            let client_window = fields.next()?;
            if client_session != session || client_window != window || tty.is_empty() {
                return None;
            }
            let zoomed = fields.next().unwrap_or("");
            let active_pane = fields.next().unwrap_or("");
            if zoomed == "1" {
                // Only the active pane is on screen for this client.
                let pane = pane?;
                if active_pane != pane {
                    return None;
                }
            }
            Some(tty.to_string())
        })
        .collect()
}

fn visible_client_ttys(pane: &str) -> Vec<String> {
    let Ok(identity) = std::process::Command::new("tmux")
        .args([
            "display-message",
            "-p",
            "-t",
            pane,
            "#{session_name}\t#{window_id}\t#{pane_id}",
        ])
        .output()
    else {
        return Vec::new();
    };
    let Ok(clients) = std::process::Command::new("tmux")
        .args([
            "list-clients",
            "-F",
            "#{client_tty}\t#{client_session}\t#{window_id}\t#{window_zoomed_flag}\t#{pane_id}",
        ])
        .output()
    else {
        return Vec::new();
    };
    if !identity.status.success() || !clients.status.success() {
        return Vec::new();
    }
    matching_client_ttys(
        &String::from_utf8_lossy(&identity.stdout),
        &String::from_utf8_lossy(&clients.stdout),
    )
}

/// Removes the image both from the pane PTY and from every terminal client watching
/// this tmux window. PTY output can be lost while the pane is shutting down, so the
/// raw command also goes to the client TTYs.
fn write_kitty_delete(image_id: u32, pane: &str) {
    let delete = raw_kitty_delete(image_id);
    let sequence = if std::env::var_os("TMUX").is_some() {
        tmux_passthrough(&delete)
    } else {
        delete.clone()
    };
    let _ = std::io::stdout().write_all(sequence.as_bytes());
    let _ = std::io::stdout().flush();

    if std::env::var_os("TMUX").is_none() {
        return;
    }
    for tty in visible_client_ttys(pane) {
        if let Ok(mut client) = std::fs::OpenOptions::new().write(true).open(tty) {
            let _ = client.write_all(delete.as_bytes());
            let _ = client.flush();
        }
    }
}

/// Marks the current tmux pane as a TWeb browser. The root key binding enables
/// browser passthrough mode only in panes carrying this marker.
struct TmuxPaneMarker {
    pane: Option<String>,
}

impl TmuxPaneMarker {
    fn install(pane: &str) -> Self {
        if std::env::var_os("TMUX").is_some() {
            let _ = std::process::Command::new("tmux")
                .args(["set-option", "-p", "-t", pane, "@tweb_browser", "1"])
                .status();
            Self {
                pane: Some(pane.to_string()),
            }
        } else {
            Self { pane: None }
        }
    }
}

impl Drop for TmuxPaneMarker {
    fn drop(&mut self) {
        if let Some(pane) = &self.pane {
            let _ = std::process::Command::new("tmux")
                .args(["set-option", "-p", "-u", "-t", pane, "@tweb_browser"])
                .status();
        }
    }
}

/// Runs tweb __pane on the default Electron engine.
pub async fn run(url: &str) -> Result<()> {
    run_with_options(url, PaneOptions::default()).await
}

/// Runs tweb __pane on the chosen browser engine and frame policy.
pub async fn run_with_options(url: &str, options: PaneOptions) -> Result<()> {
    tracing::info!(url, ?options, "tweb __pane starting");

    // Before anything is installed or entered: a terminal that cannot render Kitty graphics
    // would otherwise get a running engine writing escape sequences at a pane that shows
    // nothing (DESIGN.md 5.2's missing text fallback). The probe reads stdin, so it has to
    // happen before the input loop takes it, and the message has to be written before the
    // alternate screen is entered or leaving the screen would erase it.
    //
    // This refuses only on proof — see `graphics::gate`. Inside tmux, on a pipe, or against
    // a terminal that never answers, it starts exactly as it did before this existed.
    let support = terminal::probe_graphics_support();
    let assume = std::env::var_os("TWEB_ASSUME_GRAPHICS").is_some();
    tracing::info!(?support, assume, "terminal graphics capability");
    if graphics::gate(support, assume) == graphics::Gate::Refuse {
        eprint!("{}", graphics::unsupported_message());
        // A clean exit rather than an error: the message above is the whole diagnosis, and
        // returning `Err` would stack anyhow's error formatting on top of text written to be
        // read as-is. Nothing here failed — tweb declined to start something unusable.
        return Ok(());
    }

    let pane = std::env::var("TMUX_PANE").unwrap_or_else(|_| "%0".to_string());
    tracing::info!(pane = %pane, "tmux pane identity");
    let _pane_marker = TmuxPaneMarker::install(&pane);

    // Enable raw terminal mode and browser input (mouse/Kitty keyboard).
    let _raw_guard = terminal::RawModeGuard::enter()?;
    let _input_guard = terminal::InputModeGuard::enter();
    // Declared after the others so it is dropped first: the screen has to still be
    // ours when the image is deleted, or the placement outlives the screen it was
    // put on.
    let _screen_guard = terminal::ScreenGuard::enter();

    // Spawn the engine process. stdin is the resize/raw input control channel, and
    // stdout is inherited so the engine writes Kitty graphics to the terminal itself.
    let initial_geometry = terminal::window_geometry();
    // Kitty image IDs live in a terminal-wide namespace, so each pane process needs its own.
    let image_id = std::process::id();

    // The daemon path, off unless asked for. Every uncertainty inside this call falls through to
    // the spawn below, which is the path that ships — so a pane that opted in and found no daemon,
    // an incompatible daemon, or a daemon whose engine cannot host, behaves exactly as it does
    // today rather than degrading.
    match try_hosted(url, options, &pane, image_id).await {
        HostedOutcome::Finished => return Ok(()),
        HostedOutcome::Spawn(reason) => {
            if !matches!(reason, attach::SpawnReason::FlagOff) {
                tracing::info!(reason = %reason, "spawning this pane's own engine");
            }
        }
    }

    let (mut command, engine_description) = match options.engine {
        BrowserEngine::Electron => {
            let (electron_path, electron_dir) = find_electron()?;
            tracing::debug!(path = %electron_path.display(), dir = %electron_dir.display(),
                "resolved electron engine");
            let description = format!(
                "{} (app dir {})",
                electron_path.display(),
                electron_dir.display()
            );
            let mut command = Command::new(&electron_path);
            command
                .arg(".")
                .arg("--tweb-frame-rate")
                .arg(options.frame_rate.to_string())
                .arg("--tweb-adaptive-frame-rate")
                .arg(if options.adaptive_frame_rate {
                    "1"
                } else {
                    "0"
                })
                .arg(url)
                .current_dir(electron_dir);
            (command, description)
        }
        BrowserEngine::Tauri => {
            let tauri_path = find_tauri()?;
            let description = tauri_path.display().to_string();
            let mut command = Command::new(tauri_path);
            command
                .arg("--frame-rate")
                .arg(options.frame_rate.to_string())
                .arg(if options.adaptive_frame_rate {
                    "--adaptive-frame-rate"
                } else {
                    "--no-adaptive-frame-rate"
                })
                .arg(url);
            (command, description)
        }
    };
    command
        .stdin(Stdio::piped())
        // stdout is the Kitty graphics channel and has to stay.
        .stdout(Stdio::inherit())
        .stderr(engine_stderr())
        .env("TWEB_FRONTEND_PID", std::process::id().to_string())
        .env("TWEB_IMAGE_ID", image_id.to_string())
        .env(
            "TWEB_RESTORE_SESSION",
            if options.restore_session { "1" } else { "0" },
        )
        .env("TWEB_URL", url);
    if let Some(geometry) = initial_geometry {
        if let Some((left, top)) = geometry.origin {
            command.env("TWEB_PANE_ORIGIN", format!("{left},{top}"));
        }
        let size = geometry.size;
        command.env(
            "TWEB_VIEWPORT",
            format!("{},{},{},{}", size.cols, size.rows, size.width, size.height),
        );
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to spawn browser engine: {engine_description}"))?;

    let child_stdin = child.stdin.take();
    let child_id = child.id();
    tracing::debug!(pid = ?child_id, "browser engine spawned");

    // Engine stdin carries resize/raw input control messages and is never mixed with terminal input.
    let (control_tx, mut control_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let control_handle = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let Some(mut stdin) = child_stdin else {
            return;
        };
        while let Some(message) = control_rx.recv().await {
            if stdin.write_all(message.as_bytes()).await.is_err() {
                break;
            }
            if stdin.flush().await.is_err() {
                break;
            }
        }
    });

    // Input task: forward every raw byte to Electron. Whether Ctrl-C quits or goes to
    // the page is also Electron's call, since it is the side that knows the browser mode.
    // Hex framing keeps newlines, escape sequences and UTF-8 chunks intact on the way over.
    let input_handle = tokio::spawn({
        let control_tx = control_tx.clone();
        async move {
            let mut tty = tokio::io::stdin();
            let mut buf = [0u8; 256];

            loop {
                match tty.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut hex = String::with_capacity(n * 2 + 7);
                        hex.push_str("INPUT ");
                        for byte in &buf[..n] {
                            use std::fmt::Write as _;
                            let _ = write!(hex, "{byte:02x}");
                        }
                        hex.push('\n');
                        if control_tx.send(hex).is_err() {
                            break;
                        }
                    }
                }
            }
        }
    });

    // SIGWINCH and tmux geometry polling are used together: tmux may not send SIGWINCH
    // for a layout change that moves the pane without changing its size. The same tick
    // carries visibility, which tmux cannot push at all — DESIGN.md 5.2 puts that
    // lifecycle here, and the engine no longer polls tmux for it.
    // SIGUSR1 is how Electron asks the frontend — the owner of the PTY stdout — to
    // re-declare keyboard mode after its native DevTools reset the terminal modes.
    let sig_handle = tokio::spawn({
        let control_tx = control_tx.clone();
        let pane = pane.clone();
        async move {
            let mut sighup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
                .expect("SIGHUP");
            let mut sigterm =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM");
            let mut sigwinch = tokio::signal::unix::signal(
                tokio::signal::unix::SignalKind::from_raw(libc::SIGWINCH),
            )
            .expect("SIGWINCH");
            let mut sigusr1 = tokio::signal::unix::signal(
                tokio::signal::unix::SignalKind::from_raw(libc::SIGUSR1),
            )
            .expect("SIGUSR1");
            let mut geometry_poll = tokio::time::interval(std::time::Duration::from_millis(250));
            geometry_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut previous_geometry = initial_geometry;
            // Nothing has been pushed yet, so the first tick always sends — which is what
            // gets the engine off its no-frontend default and onto the real answer.
            let mut previous_visibility = None;
            loop {
                tokio::select! {
                    _ = sighup.recv() => {
                        if let Some(pid) = child_id {
                            unsafe { libc::kill(pid as i32, libc::SIGTERM); }
                        }
                    }
                    _ = sigterm.recv() => {
                        if let Some(pid) = child_id {
                            unsafe { libc::kill(pid as i32, libc::SIGTERM); }
                        }
                    }
                    _ = sigwinch.recv() => {
                        forward_pane_state(
                            &control_tx,
                            &pane,
                            &mut previous_geometry,
                            &mut previous_visibility,
                        );
                    }
                    _ = geometry_poll.tick() => {
                        forward_pane_state(
                            &control_tx,
                            &pane,
                            &mut previous_geometry,
                            &mut previous_visibility,
                        );
                    }
                    _ = sigusr1.recv() => {
                        if std::env::var_os("TWEB_DEBUG").is_some() {
                            eprintln!("tweb-pane: keyboard mode restore signal");
                        }
                        terminal::restore_tracked_keyboard_mode();
                    }
                }
            }
        }
    });

    // Wait for the child to exit.
    let status = child.wait().await;
    tracing::info!(?status, engine = ?options.engine, "browser engine exited");

    // Even if the engine died abnormally, drop this pane's image from the pane PTY and the real clients.
    write_kitty_delete(image_id, &pane);

    input_handle.abort();
    sig_handle.abort();
    control_handle.abort();

    Ok(())
}

/// What a hosted attempt produced.
enum HostedOutcome {
    /// The pane ran hosted and has ended. The caller returns.
    Finished,
    /// Spawn an engine for this pane — today's path, with the reason for the log.
    Spawn(attach::SpawnReason),
}

/// Runs this pane against the daemon, or says why it cannot be.
///
/// The frontend keeps every job it has on the spawn path except starting a process: it still owns
/// the terminal, raw input, geometry and visibility polling, and — decisively — it is still the
/// only writer of this pane's pty. That is not incidental. A pty write is not atomic at any size,
/// and the frontend already writes caret, cursor-shape and teardown sequences to this tty, so
/// routing frames through it is what keeps one serialising writer per pane tty.
async fn try_hosted(url: &str, options: PaneOptions, pane: &str, image_id: u32) -> HostedOutcome {
    let socket = twebd::paths::socket_path_in(&twebd::paths::runtime_dir());
    let flag = std::env::var(attach::DAEMON_FLAG).ok();
    if let Err(reason) = attach::initial_route(flag.as_deref(), socket.exists()) {
        return HostedOutcome::Spawn(reason);
    }
    // A pane the daemon cannot name is a pane it cannot key, and its whole identity model is
    // (tmux server, pane id). Outside tmux there is no server identity, so there is nothing to
    // host against.
    let Some(tmux_server) =
        twebd::tmux::server_identity_from(std::env::var("TMUX").ok().as_deref())
    else {
        return HostedOutcome::Spawn(attach::SpawnReason::NoSocket);
    };
    // Resolved here rather than in the daemon: resolution walks up from the current directory, and
    // this process is the one standing in the pane's shell.
    let (executable, app_dir) = match find_electron() {
        Ok(paths) => paths,
        Err(err) => {
            return HostedOutcome::Spawn(attach::SpawnReason::ConnectFailed(err.to_string()))
        }
    };

    let pane_ref = twebd::protocol::PaneRef {
        pane: pane.to_string(),
        tmux_server,
    };
    let request = hosted::HostRequest {
        pane: pane_ref.clone(),
        image_id,
        url,
        frame_rate: options.frame_rate,
        adaptive_frame_rate: options.adaptive_frame_rate,
        restore_session: options.restore_session,
        engine_executable: executable.display().to_string(),
        engine_app_dir: app_dir.display().to_string(),
    };
    let (stream, generation) = match hosted::connect_and_host(&socket, &request, std::process::id())
    {
        Ok(session) => session,
        Err(reason) => return HostedOutcome::Spawn(reason),
    };
    tracing::info!(pane, %generation, "hosted by twebd");

    let outcome = run_hosted_session(stream, pane, &pane_ref, generation, options).await;
    // Whichever way the session ended, this pane's image has to come off the terminal before
    // anything else draws there. Skipping it on the fallback path leaves the hosted page's pixels
    // under the freshly spawned engine's.
    write_kitty_delete(image_id, pane);
    match outcome {
        Some(reason) => HostedOutcome::Spawn(reason),
        None => HostedOutcome::Finished,
    }
}

/// Drives one hosted pane until it ends. `None` means the pane finished; `Some` means fall back.
async fn run_hosted_session(
    stream: std::os::unix::net::UnixStream,
    pane: &str,
    pane_ref: &twebd::protocol::PaneRef,
    generation: twebd::protocol::Generation,
    options: PaneOptions,
) -> Option<attach::SpawnReason> {
    use std::io::Write as _;

    // stdout is this pane's tty. The frontend owns it on the spawn path too — what changes is only
    // that the bytes arrive over a socket instead of being written by a child that inherited it.
    let writer = std::sync::Arc::new(pane_writer::PaneWriter::new(Box::new(std::io::stdout())));

    // Control lines go up to the daemon on the same connection the frames come down. One writer
    // task owns the socket's write half so the input loop and the geometry tick cannot interleave
    // two JSON lines.
    let (control_tx, mut control_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut socket_writer = match stream.try_clone() {
        Ok(clone) => clone,
        Err(err) => return Some(attach::SpawnReason::HostedSessionLost(err.to_string())),
    };
    let pane_for_control = pane_ref.clone();
    let control_handle = tokio::task::spawn_blocking(move || {
        while let Some(body) = control_rx.blocking_recv() {
            let request = hosted::control_request(&pane_for_control, generation, &body);
            let line = twebd::protocol::encode_request(&request);
            if socket_writer.write_all(line.as_bytes()).is_err() {
                break;
            }
            if socket_writer.flush().is_err() {
                break;
            }
        }
    });

    let input_handle = tokio::spawn({
        let control_tx = control_tx.clone();
        async move {
            let mut tty = tokio::io::stdin();
            let mut buf = [0u8; 256];
            loop {
                match tty.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut hex = String::with_capacity(n * 2 + 7);
                        hex.push_str("INPUT ");
                        for byte in &buf[..n] {
                            use std::fmt::Write as _;
                            let _ = write!(hex, "{byte:02x}");
                        }
                        if control_tx.send(hex).is_err() {
                            break;
                        }
                    }
                }
            }
        }
    });

    let state_handle = tokio::spawn({
        let control_tx = control_tx.clone();
        let pane = pane.to_string();
        async move {
            let mut sigwinch = tokio::signal::unix::signal(
                tokio::signal::unix::SignalKind::from_raw(libc::SIGWINCH),
            )
            .expect("SIGWINCH");
            let mut poll = tokio::time::interval(std::time::Duration::from_millis(250));
            poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut previous_geometry = terminal::window_geometry();
            let mut previous_visibility = None;
            if let Some(geometry) = previous_geometry {
                let _ = control_tx.send(resize_control_message(geometry));
            }
            loop {
                tokio::select! {
                    _ = sigwinch.recv() => {}
                    _ = poll.tick() => {}
                }
                forward_pane_state(
                    &control_tx,
                    &pane,
                    &mut previous_geometry,
                    &mut previous_visibility,
                );
            }
        }
    });

    let _ = options;
    // The read side blocks, so it goes on its own thread: a frame must not wait behind the input
    // loop or the geometry tick.
    let reason = tokio::task::spawn_blocking(move || hosted::pump(stream, generation, writer))
        .await
        .unwrap_or_else(|err| attach::SpawnReason::HostedSessionLost(err.to_string()));

    input_handle.abort();
    state_handle.abort();
    control_handle.abort();
    Some(reason)
}

fn find_tauri() -> Result<std::path::PathBuf> {
    if let Ok(path) = std::env::var("TWEB_TAURI") {
        return Ok(std::path::PathBuf::from(path));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(directory) = exe.parent() {
            let candidate = directory.join("tweb-tauri");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    which::which("tweb-tauri")
        .context("Tauri engine binary not found; build tweb-tauri or set TWEB_TAURI")
}

/// Where `make install` puts things: if the binary is `<prefix>/bin/tweb`, the Electron
/// runtime sits at `<prefix>/libexec/tweb/electron`. An installed copy never runs from
/// inside the workspace, so a path relative to current_exe is the only clue available.
pub fn installed_electron_dir() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.parent()?.join("libexec/tweb/electron");
    dir.is_dir().then_some(dir)
}

/// The Electron executable inside the given directory.
pub fn electron_binary_in(directory: &std::path::Path) -> Option<std::path::PathBuf> {
    for relative in [
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        "node_modules/.bin/electron",
        // The shape a one-shot install unpacks into: dist only, no node_modules.
        "dist/Electron.app/Contents/MacOS/Electron",
        "Electron.app/Contents/MacOS/Electron",
    ] {
        let candidate = directory.join(relative);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// `electron/` candidates for when we are running from the workspace.
fn workspace_electron_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        // target/release/tweb → target/release → target → workspace root.
        if let Some(target) = exe.parent().and_then(|p| p.parent()) {
            let root = target.parent().unwrap_or(target);
            dirs.push(root.join("electron"));
        }
    }
    dirs.push(std::path::PathBuf::from("electron"));
    dirs.push(std::path::PathBuf::from("../electron"));
    dirs
}

/// The app directory Electron loads as `.`.
///
/// When running inside the workspace, use its `electron/` — development only works if an
/// edited preload takes effect without a rebuild. Elsewhere, unpack the app embedded in
/// the binary into the cache.
fn electron_app_directory() -> Result<std::path::PathBuf> {
    if let Ok(dir) = std::env::var("TWEB_ELECTRON_DIR") {
        return Ok(std::path::PathBuf::from(dir));
    }
    for candidate in workspace_electron_dirs() {
        if candidate.join("main.cjs").exists() && candidate.join("package.json").exists() {
            return Ok(candidate);
        }
    }
    engine_app::extracted_app_dir()
}

/// Finds the Electron executable. The app code is embedded in the binary, so this is the
/// only piece that has to come from outside.
fn electron_executable() -> Result<std::path::PathBuf> {
    if let Ok(path) = std::env::var("TWEB_ELECTRON") {
        return Ok(std::path::PathBuf::from(path));
    }
    let mut searched = Vec::new();
    for directory in workspace_electron_dirs()
        .into_iter()
        .chain(installed_electron_dir())
        .chain(std::iter::once(engine_app::runtime_dir()))
    {
        if let Some(binary) = electron_binary_in(&directory) {
            return Ok(binary);
        }
        searched.push(directory);
    }
    if let Ok(binary) = which::which("electron") {
        return Ok(binary);
    }
    // Nowhere to be found: install it once. Rather than ship 295MB inside the binary, fetch it on demand.
    engine_app::install_runtime().with_context(|| {
        format!(
            "Could not find the Electron runtime, and installing it failed. Looked in: {}",
            searched
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}

/// Where the engine's stderr goes.
///
/// Chromium writes its own diagnostics to stderr. Since the pane image started being drawn
/// **below** the terminal text, those lines show through on top of the page, so they cannot
/// go to the screen. What an agent actually needs is the `engine-log` the engine keeps in
/// memory, so stderr goes to a file — a startup that fails outright still has to be diagnosable.
fn engine_stderr() -> Stdio {
    if std::env::var("TWEB_DEBUG").is_ok() {
        return Stdio::inherit();
    }
    let name = std::env::var("TMUX_PANE")
        .map(|pane| pane.trim_start_matches('%').to_string())
        .unwrap_or_else(|_| format!("pid-{}", std::process::id()));
    let directory = engine_app::cache_root().join("logs");
    if std::fs::create_dir_all(&directory).is_err() {
        return Stdio::null();
    }
    std::fs::File::create(directory.join(format!("engine-{name}.log")))
        .map_or_else(|_| Stdio::null(), Stdio::from)
}

fn absolute_from(path: std::path::PathBuf, directory: &std::path::Path) -> std::path::PathBuf {
    if path.is_absolute() {
        path
    } else {
        directory.join(path)
    }
}

fn resolve_electron_paths(
    executable: std::path::PathBuf,
    app_directory: std::path::PathBuf,
    current_directory: &std::path::Path,
) -> (std::path::PathBuf, std::path::PathBuf) {
    (
        absolute_from(executable, current_directory),
        absolute_from(app_directory, current_directory),
    )
}

/// Finds the Electron binary path and the app directory.
/// Returns: (electron binary path, electron app dir with package.json)
fn find_electron() -> Result<(std::path::PathBuf, std::path::PathBuf)> {
    // `Command::current_dir` is applied before a relative program path is resolved.
    // Resolve workspace-relative selections before changing into the Electron app
    // directory, or `electron/node_modules/...` becomes `electron/electron/...`.
    let directory = std::env::current_dir().context("cannot resolve the current directory")?;
    Ok(resolve_electron_paths(
        electron_executable()?,
        electron_app_directory()?,
        &directory,
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        changed_geometry_message, matching_client_ttys, raw_kitty_delete, resolve_electron_paths,
        tmux_passthrough, PATCH_ID_COUNT,
    };
    use crate::terminal::{WindowGeometry, WindowSize};

    // The engine reserves `PATCH_ID_COUNT` ids after the base for damage patches. The
    // frontend deletes on paths the engine cannot reach, so it has to know about them too —
    // and the two constants live in different languages, where a drift is silent and shows
    // up only as strips of a dead page left on screen.
    #[test]
    fn deleting_covers_the_base_image_and_every_patch_slot() {
        let sequence = raw_kitty_delete(4242);
        assert!(
            sequence.contains("i=4242,"),
            "base image id must be deleted"
        );
        for slot in 0..PATCH_ID_COUNT {
            let patch = 4243 + slot;
            assert!(
                sequence.contains(&format!("i={patch},")),
                "patch slot {patch} must be deleted"
            );
        }
        // One command per id, and nothing beyond the reserved range.
        assert_eq!(
            sequence.matches("a=d,d=I").count() as u32,
            PATCH_ID_COUNT + 1
        );
        let past_end = 4243 + PATCH_ID_COUNT;
        assert!(!sequence.contains(&format!("i={past_end},")));
    }

    #[test]
    fn electron_paths_resolve_against_the_original_working_directory() {
        let cwd = std::path::Path::new("/workspace/tweb");
        let paths = resolve_electron_paths(
            std::path::PathBuf::from("electron/node_modules/electron"),
            std::path::PathBuf::from("electron"),
            cwd,
        );
        assert_eq!(
            paths,
            (
                std::path::PathBuf::from("/workspace/tweb/electron/node_modules/electron"),
                std::path::PathBuf::from("/workspace/tweb/electron"),
            )
        );

        let absolute = resolve_electron_paths(
            std::path::PathBuf::from("/opt/electron"),
            std::path::PathBuf::from("/opt/tweb-app"),
            cwd,
        );
        assert_eq!(
            absolute,
            (
                std::path::PathBuf::from("/opt/electron"),
                std::path::PathBuf::from("/opt/tweb-app"),
            )
        );
    }

    // Every delete is q=2: the terminal must not answer. A reply would be read as terminal
    // input by whatever is running in the pane once the browser is gone.
    #[test]
    fn kitty_delete_asks_for_no_response() {
        let sequence = raw_kitty_delete(42);
        assert_eq!(
            sequence.matches("q=2").count(),
            sequence.matches("a=d,d=I").count()
        );
        assert!(sequence.starts_with("\x1b_Ga=d,d=I,i=42,q=2\x1b\\"));
    }

    #[test]
    fn tmux_passthrough_escapes_inner_sequences() {
        assert_eq!(
            tmux_passthrough("\x1b_Ga=d,d=I,i=7,q=2\x1b\\"),
            "\x1bPtmux;\x1b\x1b_Ga=d,d=I,i=7,q=2\x1b\x1b\\\x1b\\"
        );
    }

    #[test]
    fn forwards_size_and_origin_changes_once() {
        let size = WindowSize {
            cols: 80,
            rows: 24,
            width: 800,
            height: 480,
        };
        let initial = WindowGeometry {
            size,
            origin: Some((0, 0)),
        };
        let moved = WindowGeometry {
            size,
            origin: Some((20, 0)),
        };
        let fallback = WindowGeometry { size, origin: None };
        let mut previous = Some(initial);

        assert_eq!(changed_geometry_message(&mut previous, Some(initial)), None);
        assert_eq!(
            changed_geometry_message(&mut previous, Some(moved)).as_deref(),
            Some("RESIZE 80 24 800 480 20 0\n")
        );
        assert_eq!(changed_geometry_message(&mut previous, Some(moved)), None);
        assert_eq!(
            changed_geometry_message(&mut previous, Some(fallback)).as_deref(),
            Some("RESIZE 80 24 800 480\n")
        );
        assert_eq!(changed_geometry_message(&mut previous, None), None);
    }

    #[test]
    fn cleanup_only_targets_clients_showing_the_same_window() {
        let clients = concat!(
            "/dev/ttys001\twork\t@3\t0\t%1\n",
            "/dev/ttys002\twork\t@4\t0\t%9\n",
            "/dev/ttys003\tother\t@3\t0\t%1\n",
            "/dev/ttys004\twork\t@3\t0\t%1\n",
        );
        assert_eq!(
            matching_client_ttys("work\t@3\t%1\n", clients),
            vec!["/dev/ttys001", "/dev/ttys004"]
        );
        assert!(matching_client_ttys("invalid", clients).is_empty());
    }

    #[test]
    fn a_zoomed_window_shows_only_its_active_pane() {
        // The window id is unchanged by zoom, so matching on session and window alone
        // would write a delete into a terminal that is displaying a different pane.
        let clients = concat!(
            "/dev/ttys001\twork\t@3\t1\t%7\n", // zoomed onto another pane
            "/dev/ttys002\twork\t@3\t1\t%1\n", // zoomed onto us
            "/dev/ttys003\twork\t@3\t0\t%7\n", // not zoomed: every pane is on screen
        );
        assert_eq!(
            matching_client_ttys("work\t@3\t%1", clients),
            vec!["/dev/ttys002", "/dev/ttys003"]
        );
    }

    #[test]
    fn a_client_line_without_zoom_fields_is_still_matched() {
        // Field order is append-only, but a truncated line must not silently drop a client
        // that is genuinely showing the pane.
        let clients = "/dev/ttys001\twork\t@3\n";
        assert_eq!(
            matching_client_ttys("work\t@3\t%1", clients),
            vec!["/dev/ttys001"]
        );
    }

    #[test]
    fn an_identity_without_a_pane_id_falls_back_to_window_matching() {
        let clients = concat!(
            "/dev/ttys001\twork\t@3\t0\t%1\n",
            "/dev/ttys002\twork\t@3\t1\t%7\n",
        );
        // Unzoomed still matches; a zoomed client cannot be judged without a pane id, so it
        // is left alone rather than written to.
        assert_eq!(
            matching_client_ttys("work\t@3", clients),
            vec!["/dev/ttys001"]
        );
    }
}
