//! tweb __pane — tmux browser pane의 foreground process.
//!
//! DESIGN.md 섹션 5.2. 각 tmux browser pane의 실제 foreground process.
//! 핵심: Electron offscreen process를 spawn하고, paint event(frame)를
//! stdout Kitty graphics로 terminal에 전달.
//!
//! 최소 기능:
//! - `tweb __pane <url>` → Electron spawn, URL 로드
//! - paint event → Kitty graphics → terminal 표시
//! - pane resize → Electron viewport resize
//! - pane kill → Electron 종료, image delete

pub mod display;
mod engine_app;
pub mod input;
pub mod resize;
pub mod terminal;

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

fn raw_kitty_delete(image_id: u32) -> String {
    format!("\x1b_Ga=d,d=I,i={image_id},q=2\x1b\\")
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

fn tmux_passthrough(sequence: &str) -> String {
    let escaped = sequence.replace('\x1b', "\x1b\x1b");
    format!("\x1bPtmux;{escaped}\x1b\\")
}

fn matching_client_ttys(identity: &str, clients: &str) -> Vec<String> {
    let Some((session, window)) = identity.trim().split_once('\t') else {
        return Vec::new();
    };
    clients
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let tty = fields.next()?;
            let client_session = fields.next()?;
            let client_window = fields.next()?;
            (client_session == session && client_window == window && !tty.is_empty())
                .then(|| tty.to_string())
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
            "#{session_name}\t#{window_id}",
        ])
        .output()
    else {
        return Vec::new();
    };
    let Ok(clients) = std::process::Command::new("tmux")
        .args([
            "list-clients",
            "-F",
            "#{client_tty}\t#{client_session}\t#{window_id}",
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

/// Pane PTY와 이 tmux window를 보고 있는 terminal client 모두에서 image를 제거한다.
/// Pane 종료 중에는 PTY 출력이 유실될 수 있으므로 client TTY에도 raw command를 쓴다.
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

/// 현재 tmux pane을 TWeb browser로 표시한다. root key binding은 이 marker가
/// 있는 pane에서만 browser passthrough mode를 활성화한다.
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

/// 기본 Electron engine으로 tweb __pane을 실행한다.
pub async fn run(url: &str) -> Result<()> {
    run_with_options(url, PaneOptions::default()).await
}

/// 선택한 browser engine과 frame policy로 tweb __pane을 실행한다.
pub async fn run_with_options(url: &str, options: PaneOptions) -> Result<()> {
    tracing::info!(url, ?options, "tweb __pane starting");

    let pane = std::env::var("TMUX_PANE").unwrap_or_else(|_| "%0".to_string());
    tracing::info!(pane = %pane, "tmux pane identity");
    let _pane_marker = TmuxPaneMarker::install(&pane);

    // raw terminal mode와 browser 입력(mouse/Kitty keyboard) 활성화.
    let _raw_guard = terminal::RawModeGuard::enter()?;
    let _input_guard = terminal::InputModeGuard::enter();
    // Declared after the others so it is dropped first: the screen has to still be
    // ours when the image is deleted, or the placement outlives the screen it was
    // put on.
    let _screen_guard = terminal::ScreenGuard::enter();

    // Engine process spawn. stdin은 resize/raw input control channel이고,
    // stdout은 engine이 Kitty graphics를 terminal에 직접 쓰도록 상속한다.
    let initial_geometry = terminal::window_geometry();
    // Kitty image ID는 terminal 전체 namespace이므로 pane process마다 고유해야 한다.
    let image_id = std::process::id();
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

    // Engine stdin은 terminal 입력과 섞지 않고 resize/raw input control message에 사용한다.
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

    // 입력 처리 task: 모든 raw bytes를 Electron에 전달한다. Ctrl-C의 종료/웹 전달
    // 여부도 browser mode를 아는 Electron이 결정한다.
    // hex framing을 사용해 newline, escape sequence, UTF-8 chunk를 손실 없이 보낸다.
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

    // SIGWINCH와 tmux geometry polling을 함께 사용한다. tmux는 pane 크기가 같고
    // 위치만 바뀐 layout 변경에는 SIGWINCH를 보내지 않을 수 있다.
    // SIGUSR1은 Electron의 native DevTools가 terminal mode를 초기화한 뒤
    // PTY stdout 소유자인 frontend에 keyboard mode 재선언을 요청한다.
    let sig_handle = tokio::spawn({
        let control_tx = control_tx.clone();
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
                        forward_changed_geometry(&control_tx, &mut previous_geometry);
                    }
                    _ = geometry_poll.tick() => {
                        forward_changed_geometry(&control_tx, &mut previous_geometry);
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

    // child 종료 대기.
    let status = child.wait().await;
    tracing::info!(?status, engine = ?options.engine, "browser engine exited");

    // Engine이 비정상 종료해도 이 pane 소유 image를 pane PTY와 실제 client에서 제거한다.
    write_kitty_delete(image_id, &pane);

    input_handle.abort();
    sig_handle.abort();
    control_handle.abort();

    Ok(())
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

/// `make install`이 놓는 위치: binary가 `<prefix>/bin/tweb`이면 Electron runtime은
/// `<prefix>/libexec/tweb/electron`에 있다. 설치본은 workspace 안에서 돌지 않으므로
/// current_exe 기준 상대 경로 말고는 찾을 단서가 없다.
pub fn installed_electron_dir() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.parent()?.join("libexec/tweb/electron");
    dir.is_dir().then_some(dir)
}

/// 주어진 directory 안의 Electron 실행 파일.
pub fn electron_binary_in(directory: &std::path::Path) -> Option<std::path::PathBuf> {
    for relative in [
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        "node_modules/.bin/electron",
        // 1회성 설치가 풀어놓는 모양: node_modules 없이 dist만 온다.
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

/// workspace를 실행 중일 때의 `electron/` 후보들.
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

/// Electron이 `.`으로 로드할 app directory.
///
/// workspace 안에서 돌고 있으면 그 `electron/`을 쓴다 — 고친 preload가 rebuild 없이 바로
/// 반영되어야 개발이 된다. 그 밖에서는 binary에 담긴 app을 cache에 푼다.
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

/// Electron 실행 파일 찾기. app 코드는 binary에 담겨 있으므로 이것만 밖에서 온다.
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
    // 어디에도 없으면 한 번 설치한다. 295MB를 binary에 넣지 않는 대신 필요할 때 가져온다.
    engine_app::install_runtime().with_context(|| {
        format!(
            "Electron runtime을 찾을 수 없고 설치도 실패했습니다. 확인한 위치: {}",
            searched
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}

/// engine stderr 목적지.
///
/// Chromium은 자기 진단을 stderr로 쓴다. pane image가 terminal text **아래**에
/// 그려지게 된 뒤로 그 줄들이 page 위에 그대로 보이기 때문에 화면으로 내보낼 수 없다.
/// agent가 실제로 필요한 것은 engine이 메모리에 들고 있는 `engine-log`이므로, stderr는
/// 파일로 보낸다 — 시작 자체가 실패하는 경우를 그래도 진단할 수 있어야 한다.
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

/// Electron binary 경로와 app directory 찾기.
/// 반환: (electron binary path, electron app dir with package.json)
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
        tmux_passthrough,
    };
    use crate::terminal::{WindowGeometry, WindowSize};

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

    #[test]
    fn kitty_delete_targets_one_image_without_response() {
        assert_eq!(raw_kitty_delete(42), "\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
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
            "/dev/ttys001\twork\t@3\n",
            "/dev/ttys002\twork\t@4\n",
            "/dev/ttys003\tother\t@3\n",
            "/dev/ttys004\twork\t@3\n",
        );
        assert_eq!(
            matching_client_ttys("work\t@3\n", clients),
            vec!["/dev/ttys001", "/dev/ttys004"]
        );
        assert!(matching_client_ttys("invalid", clients).is_empty());
    }
}
