//! tweb CLI — `tweb open/split/snapshot/click/profile/doctor`.
//!
//! DESIGN.md 섹션 4.1. subcommand가 항상 동작보다 먼저, target selector는 뒤.
//! `tweb snapshot --pane %3`. 전역 selector와 subcommand별 selector를 섞지 않는다.

pub mod doctor;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum BrowserEngineArg {
    Electron,
    Tauri,
}

#[derive(Args, Clone, Debug)]
pub struct BrowserOptions {
    /// Browser rendering engine.
    #[arg(long, value_enum, default_value_t = BrowserEngineArg::Electron)]
    pub engine: BrowserEngineArg,

    /// Maximum active frame rate.
    #[arg(long, default_value_t = 30, value_parser = clap::value_parser!(u16).range(1..=60))]
    pub frame_rate: u16,

    /// Explicitly enable activity-aware frame-rate adaptation (default).
    #[arg(long, overrides_with = "no_adaptive_frame_rate")]
    pub adaptive_frame_rate: bool,

    /// Disable activity-aware frame-rate adaptation.
    #[arg(long, overrides_with = "adaptive_frame_rate")]
    pub no_adaptive_frame_rate: bool,
}

impl BrowserOptions {
    fn adaptive(&self) -> bool {
        self.adaptive_frame_rate || !self.no_adaptive_frame_rate
    }

    fn append_pane_args(&self, command: &mut std::process::Command) {
        command
            .arg("--engine")
            .arg(match self.engine {
                BrowserEngineArg::Electron => "electron",
                BrowserEngineArg::Tauri => "tauri",
            })
            .arg("--frame-rate")
            .arg(self.frame_rate.to_string());
        command.arg(if self.adaptive() {
            "--adaptive-frame-rate"
        } else {
            "--no-adaptive-frame-rate"
        });
    }

    fn shell_args(&self) -> String {
        let mut value = format!(
            "--engine {} --frame-rate {}",
            match self.engine {
                BrowserEngineArg::Electron => "electron",
                BrowserEngineArg::Tauri => "tauri",
            },
            self.frame_rate
        );
        value.push_str(if self.adaptive() {
            " --adaptive-frame-rate"
        } else {
            " --no-adaptive-frame-rate"
        });
        value
    }
}

/// TWeb — terminal-native browser runtime.
///
/// tmux pane 안에서 실제 Chromium browser를 실행. 사람과 agent가 동일 page 공유.
#[derive(Parser, Debug)]
#[command(name = "tweb", version, about, long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// 현재 terminal/pane에서 browser frontend 실행.
    Open {
        #[command(flatten)]
        browser: BrowserOptions,
        url: Option<String>,
    },
    /// 현재 tmux window에 browser pane 생성.
    Split {
        #[command(flatten)]
        browser: BrowserOptions,
        url: Option<String>,
        #[arg(short = 'H')]
        horizontal: bool,
    },
    /// resolve된 browser page 이동.
    Navigate {
        url: String,
        #[arg(long)]
        pane: Option<i32>,
    },
    /// browser page 상태.
    Status {
        #[arg(long)]
        pane: Option<i32>,
    },
    /// browser page 제어 snapshot (agent automation용).
    Snapshot {
        #[arg(long)]
        pane: Option<i32>,
        #[arg(long)]
        pretty: bool,
    },
    /// element click.
    Click {
        #[arg(long)]
        pane: Option<i32>,
        /// semantic ref (예: d1-n13).
        r#ref: String,
    },
    /// element fill.
    Fill {
        #[arg(long)]
        pane: Option<i32>,
        r#ref: String,
        value: String,
    },
    /// key press.
    Press {
        #[arg(long)]
        pane: Option<i32>,
        key: String,
    },
    /// page resize.
    Resize {
        #[arg(long)]
        pane: Option<i32>,
        width: u32,
        height: u32,
    },
    /// screenshot.
    Screenshot {
        #[arg(long)]
        pane: Option<i32>,
        #[arg(long)]
        send_to: Option<i32>,
    },
    /// resource 조회·전달·materialize.
    Resource {
        #[command(subcommand)]
        action: ResourceAction,
    },
    /// profile bootstrap·관리.
    Profile {
        #[command(subcommand)]
        action: ProfileAction,
    },
    /// managed Chrome handoff·bridge 관리.
    Chrome {
        #[command(subcommand)]
        action: ChromeAction,
    },
    /// terminal/tmux/GPU/extension capability 진단.
    Doctor,
    /// internal: pane frontend (tmux가 실행, 문서화된 automation API가 아님).
    #[command(name = "__pane", hide = true)]
    PaneInternal {
        #[command(flatten)]
        browser: BrowserOptions,
        #[arg(long)]
        page: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum ResourceAction {
    /// resource 목록.
    List {
        #[arg(long)]
        window: Option<String>,
    },
    /// resource 상세.
    Inspect { id: String },
    /// resource를 경로에 materialize.
    Materialize {
        id: String,
        #[arg(long)]
        to: String,
    },
    /// resource를 다른 pane에 전달.
    Send {
        id: String,
        #[arg(long)]
        to_pane: i32,
    },
    /// 만료된 resource 정리.
    Gc,
}

#[derive(Subcommand, Debug)]
pub enum ProfileAction {
    /// Chrome profile bootstrap.
    Bootstrap { source: String },
    /// profile 목록.
    List,
}

#[derive(Subcommand, Debug)]
pub enum ChromeAction {
    /// managed Chrome으로 URL 열기.
    Open { url: String },
    /// bridge 상태.
    Status,
}

/// CLI 실행.
pub async fn run() -> Result<()> {
    let cli = Cli::parse();
    tracing::debug!(?cli, "tweb command");

    match cli.command {
        Command::Open { browser, url } => {
            // URL 미지정은 tweb-pane까지 보존해 tmux window session을 복원한다.
            run_pane(url.as_deref(), &browser).await?;
        }
        Command::Split {
            browser,
            url,
            horizontal,
        } => {
            // tmux split-window에서도 URL 미지정을 보존한다.
            split_and_run_pane(url.as_deref(), &browser, horizontal).await?;
        }
        Command::PaneInternal { browser, page } => {
            run_pane(Some(&page), &browser).await?;
        }
        Command::Doctor => {
            doctor::run().await;
        }
        _ => {
            println!("tweb: command not yet implemented");
        }
    }

    Ok(())
}

/// 현재 pane에서 tweb-pane 실행.
async fn run_pane(url: Option<&str>, browser: &BrowserOptions) -> Result<()> {
    let pane_bin = find_pane_binary()?;
    let mut cmd = std::process::Command::new(&pane_bin);
    browser.append_pane_args(&mut cmd);
    if let Some(url) = url {
        cmd.arg(url);
    }
    set_engine_env(&mut cmd, browser.engine);
    let status = cmd.status()?;
    if !status.success() {
        anyhow::bail!("tweb-pane exited with {:?}", status);
    }
    Ok(())
}

/// tmux split-window로 pane 만들고 tweb-pane 실행.
async fn split_and_run_pane(
    url: Option<&str>,
    browser: &BrowserOptions,
    _horizontal: bool,
) -> Result<()> {
    let pane_bin = find_pane_binary()?;
    let pane_bin_str = pane_bin.to_string_lossy().to_string();

    // 선택한 engine binary를 split pane에 명시적으로 전달한다.
    let mut env_str = String::new();
    match browser.engine {
        BrowserEngineArg::Electron => {
            if let Some(path) = find_electron_binary() {
                env_str.push_str(&format!(
                    "TWEB_ELECTRON={} ",
                    shell_quote(&path.to_string_lossy())
                ));
                if let Some(directory) = path
                    .ancestors()
                    .find(|ancestor| ancestor.join("package.json").exists())
                {
                    env_str.push_str(&format!(
                        "TWEB_ELECTRON_DIR={} ",
                        shell_quote(&directory.to_string_lossy())
                    ));
                }
            }
        }
        BrowserEngineArg::Tauri => {
            if let Some(path) = find_tauri_binary() {
                env_str.push_str(&format!(
                    "TWEB_TAURI={} ",
                    shell_quote(&path.to_string_lossy())
                ));
            }
        }
    }

    let url_arg = url
        .map(|value| format!(" {}", shell_quote(value)))
        .unwrap_or_default();
    let pane_command = format!(
        "{}{} {}{}",
        env_str,
        shell_quote(&pane_bin_str),
        browser.shell_args(),
        url_arg
    );
    let status = std::process::Command::new("tmux")
        .args(["split-window", "-h", "-p", "50", &pane_command])
        .status()?;

    if !status.success() {
        anyhow::bail!("tmux split-window failed: {:?}", status);
    }
    Ok(())
}

/// tweb-pane binary 경로 찾기.
fn find_pane_binary() -> Result<std::path::PathBuf> {
    if let Ok(path) = std::env::var("TWEB_PANE") {
        return Ok(std::path::PathBuf::from(path));
    }
    for candidate in [
        "target/release/tweb-pane",
        "../target/release/tweb-pane",
        "target/debug/tweb-pane",
        "../target/debug/tweb-pane",
    ] {
        let path = std::path::PathBuf::from(candidate);
        if path.exists() {
            return Ok(path.canonicalize().unwrap_or(path));
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            let sibling = directory.join("tweb-pane");
            if sibling.exists() {
                return Ok(sibling);
            }
        }
    }
    which::which("tweb-pane").context("tweb-pane binary not found")
}

/// Tauri binary 경로 찾기 (tweb-pane에 환경 변수로 전달용).
fn find_tauri_binary() -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("TWEB_TAURI") {
        return Some(std::path::PathBuf::from(path));
    }
    for candidate in [
        "target/release/tweb-tauri",
        "../target/release/tweb-tauri",
        "target/debug/tweb-tauri",
        "../target/debug/tweb-tauri",
    ] {
        let path = std::path::PathBuf::from(candidate);
        if path.exists() {
            return Some(path.canonicalize().unwrap_or(path));
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            let sibling = directory.join("tweb-tauri");
            if sibling.exists() {
                return Some(sibling);
            }
        }
    }
    which::which("tweb-tauri").ok()
}

fn find_electron_binary() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("TWEB_ELECTRON") {
        return Some(std::path::PathBuf::from(p));
    }
    let candidates = [
        "electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        "../electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        "electron/node_modules/.bin/electron",
        "../electron/node_modules/.bin/electron",
    ];
    for c in &candidates {
        let p = std::path::PathBuf::from(c);
        if p.exists() {
            return Some(p.canonicalize().unwrap_or(p));
        }
    }
    which::which("electron").ok()
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 선택한 engine의 실행 경로를 환경 변수로 설정한다.
fn set_engine_env(cmd: &mut std::process::Command, engine: BrowserEngineArg) {
    if matches!(engine, BrowserEngineArg::Tauri) {
        if let Some(path) = find_tauri_binary() {
            cmd.env("TWEB_TAURI", path);
        }
        return;
    }
    if let Some(path) = find_electron_binary() {
        cmd.env("TWEB_ELECTRON", &path);
        // app dir (package.json이 있는 디렉토리)도 전달.
        let app_dir = path
            .ancestors()
            .find(|p| p.join("package.json").exists())
            .map(|p| p.to_path_buf());
        if let Some(dir) = app_dir {
            cmd.env("TWEB_ELECTRON_DIR", dir);
        }
    }
}
