//! tweb CLI — `tweb open/split/snapshot/click/profile/doctor`.
//!
//! DESIGN.md 섹션 4.1. subcommand가 항상 동작보다 먼저, target selector는 뒤.
//! `tweb snapshot --pane %3`. 전역 selector와 subcommand별 selector를 섞지 않는다.

pub mod agent;
pub mod doctor;
pub mod mcp;

use std::ffi::OsString;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use serde_json::json;

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
    /// automation 가능한 browser pane 목록.
    Panes {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// resolve된 browser page 이동.
    Navigate {
        url: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// history 뒤로.
    Back {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// history 앞으로.
    Forward {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// page reload.
    Reload {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// browser page 상태.
    Status {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// 상호작용 가능한 요소 snapshot. ref는 `f` hint label과 같다.
    Snapshot {
        /// link/heading/text까지 포함한 읽기용 snapshot.
        #[arg(long)]
        text: bool,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// ref로 CSS selector 조회 (snapshot 없이 단건).
    Query {
        selector: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// element click.
    Click {
        /// snapshot이 부여한 ref (예: a, sd).
        r#ref: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// element hover.
    Hover {
        r#ref: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// input/textarea/contenteditable 값 설정.
    Fill {
        r#ref: String,
        value: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// focus된 element에 text 입력.
    Type {
        text: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// key press (예: Enter, Tab, Escape).
    Press {
        key: String,
        /// modifier (shift, control, alt, meta). 반복 가능.
        #[arg(long = "mod")]
        modifiers: Vec<String>,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// select option 선택.
    Select {
        r#ref: String,
        value: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// checkbox/radio 체크.
    Check {
        r#ref: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// checkbox 해제.
    Uncheck {
        r#ref: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// element text 읽기.
    Text {
        r#ref: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// element outer HTML 읽기.
    Html {
        r#ref: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// page에서 JavaScript 실행.
    Eval {
        script: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// 조건 충족까지 대기.
    Wait {
        /// CSS selector 등장 대기.
        #[arg(long)]
        selector: Option<String>,
        /// 본문 text 등장 대기.
        #[arg(long)]
        text: Option<String>,
        /// URL 부분 일치 대기.
        #[arg(long)]
        url: Option<String>,
        /// 로딩 완료 대기.
        #[arg(long)]
        load: bool,
        /// 고정 시간 대기 (ms).
        #[arg(long)]
        ms: Option<u64>,
        #[arg(long, default_value_t = 10000)]
        timeout: u64,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// console 기록.
    Console {
        #[arg(long, default_value_t = 100)]
        limit: usize,
        /// 읽은 뒤 버퍼 비우기.
        #[arg(long)]
        clear: bool,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// console error만.
    Errors {
        #[arg(long, default_value_t = 50)]
        limit: usize,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// tab 목록.
    Tabs {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// tab 전환·생성·닫기.
    Tab {
        #[command(subcommand)]
        action: TabAction,
    },
    /// screenshot.
    Screenshot {
        /// 저장 경로. 없으면 base64 PNG를 출력한다.
        path: Option<String>,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// agent용 MCP server (stdio).
    Mcp {
        #[command(flatten)]
        agent: AgentOptions,
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
    /// 실행 중인 pane의 geometry·zoom·frame·input 상태.
    Diag {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// engine debug log (TWEB_DEBUG 줄) 조회.
    EngineLog {
        #[arg(long, default_value_t = 60)]
        limit: usize,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// terminal/tmux/GPU/extension capability 진단.
    Doctor,
    /// internal: pane frontend (tmux가 실행, 문서화된 automation API가 아님).
    #[command(name = "__pane", hide = true)]
    PaneInternal {
        #[command(flatten)]
        browser: BrowserOptions,
        /// resolve된 page id. 지정하면 URL 대신 사용한다.
        #[arg(long)]
        page: Option<String>,
        url: Option<String>,
    },
}

/// Shared options for every command that drives a running browser pane.
#[derive(Args, Clone, Debug)]
pub struct AgentOptions {
    /// 대상 tmux pane (예: %3). 생략하면 실행 중인 유일한 pane.
    #[arg(long, global = true)]
    pub pane: Option<String>,

    /// 사람이 읽는 요약 대신 원본 JSON 출력.
    #[arg(long, global = true)]
    pub json: bool,
}

#[derive(Subcommand, Debug)]
pub enum TabAction {
    /// index로 tab 전환.
    Switch {
        index: usize,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// 새 tab.
    New {
        url: Option<String>,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// tab 닫기.
    Close {
        index: Option<usize>,
        #[command(flatten)]
        agent: AgentOptions,
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

fn default_open_args(mut args: Vec<OsString>) -> Vec<OsString> {
    // The installed command is the browser entry point. Requiring an otherwise
    // redundant `open` makes `make install && tweb` look like a broken install.
    if args.len() == 1 {
        args.push(OsString::from("open"));
    }
    args
}

/// CLI 실행.
pub async fn run() -> Result<()> {
    let cli = Cli::parse_from(default_open_args(std::env::args_os().collect()));
    tracing::debug!(?cli, "tweb command");

    match cli.command {
        Command::Open { browser, url } => {
            // URL 미지정은 pane frontend까지 보존해 tmux window session을 복원한다.
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
        Command::PaneInternal { browser, page, url } => {
            // URL이 없으면 tmux window session을 복원한다.
            run_pane(page.as_deref().or(url.as_deref()), &browser).await?;
        }
        Command::Doctor => {
            doctor::run().await;
        }
        Command::Panes { agent } => agent::list_panes(agent.json)?,
        Command::Mcp { agent } => mcp::serve(agent.pane.as_deref())?,
        Command::Tab { action } => {
            let (method, params, agent) = match action {
                TabAction::Switch { index, agent } => ("tab", json!({ "index": index }), agent),
                TabAction::New { url, agent } => ("tab-new", json!({ "url": url }), agent),
                TabAction::Close { index, agent } => {
                    ("tab-close", json!({ "index": index }), agent)
                }
            };
            agent::run(agent.pane.as_deref(), method, params, agent.json)?;
        }
        other => {
            let (method, params, agent) = agent_call(other)?;
            agent::run(agent.pane.as_deref(), method, params, agent.json)?;
        }
    }

    Ok(())
}

/// Map a page-driving subcommand onto its JSON-RPC method and params.
fn agent_call(command: Command) -> Result<(&'static str, serde_json::Value, AgentOptions)> {
    let act = |r#ref: String, action: &str, value: Option<String>| json!({ "ref": r#ref, "action": action, "value": value });
    Ok(match command {
        Command::Navigate { url, agent } => ("navigate", json!({ "url": url }), agent),
        Command::Back { agent } => ("back", json!({}), agent),
        Command::Forward { agent } => ("forward", json!({}), agent),
        Command::Reload { agent } => ("reload", json!({}), agent),
        Command::Status { agent } => ("status", json!({}), agent),
        Command::Diag { agent } => ("diag", json!({}), agent),
        Command::EngineLog { limit, agent } => ("engine-log", json!({ "limit": limit }), agent),
        Command::Snapshot { text, agent } => (
            "snapshot",
            json!({ "mode": if text { "text" } else { "interactive" } }),
            agent,
        ),
        Command::Query { selector, agent } => ("query", json!({ "selector": selector }), agent),
        Command::Click { r#ref, agent } => ("act", act(r#ref, "click", None), agent),
        Command::Hover { r#ref, agent } => ("act", act(r#ref, "hover", None), agent),
        Command::Fill {
            r#ref,
            value,
            agent,
        } => ("act", act(r#ref, "fill", Some(value)), agent),
        Command::Select {
            r#ref,
            value,
            agent,
        } => ("act", act(r#ref, "select", Some(value)), agent),
        Command::Check { r#ref, agent } => ("act", act(r#ref, "check", None), agent),
        Command::Uncheck { r#ref, agent } => ("act", act(r#ref, "uncheck", None), agent),
        Command::Text { r#ref, agent } => ("act", act(r#ref, "text", None), agent),
        Command::Html { r#ref, agent } => ("act", act(r#ref, "html", None), agent),
        Command::Type { text, agent } => ("type", json!({ "text": text }), agent),
        Command::Press {
            key,
            modifiers,
            agent,
        } => (
            "press",
            json!({ "key": key, "modifiers": modifiers }),
            agent,
        ),
        Command::Eval { script, agent } => ("eval", json!({ "script": script }), agent),
        Command::Screenshot { path, agent } => ("screenshot", json!({ "path": path }), agent),
        Command::Console {
            limit,
            clear,
            agent,
        } => ("console", json!({ "limit": limit, "clear": clear }), agent),
        Command::Errors { limit, agent } => ("errors", json!({ "limit": limit }), agent),
        Command::Tabs { agent } => ("tabs", json!({}), agent),
        Command::Wait {
            selector,
            text,
            url,
            load,
            ms,
            timeout,
            agent,
        } => (
            "wait",
            json!({
                "selector": selector, "text": text, "url": url,
                "load": load, "ms": ms, "timeout": timeout,
            }),
            agent,
        ),
        other => anyhow::bail!("command not yet implemented: {other:?}"),
    })
}

/// 현재 pane에서 browser frontend 실행.
///
/// `tweb`은 하나의 multi-call executable이므로 pane frontend를 별도 binary로
/// spawn하지 않고 같은 process에서 직접 돌린다. 그래야 CLI와 frontend 사이에
/// version skew가 생기지 않는다 (DESIGN.md 4.1).
async fn run_pane(url: Option<&str>, browser: &BrowserOptions) -> Result<()> {
    // engine 경로는 frontend가 직접 찾는다. CLI가 추측해서 넘기면 binary와 app
    // directory가 어긋날 수 있고 (node_modules/electron에도 package.json이 있다)
    // 같은 process이므로 넘길 이유도 없다.
    // URL 미지정은 tmux window session 복원 요청이다.
    let options = tweb_pane::PaneOptions {
        engine: match browser.engine {
            BrowserEngineArg::Electron => tweb_pane::BrowserEngine::Electron,
            BrowserEngineArg::Tauri => tweb_pane::BrowserEngine::Tauri,
        },
        frame_rate: browser.frame_rate,
        adaptive_frame_rate: browser.adaptive(),
        restore_session: url.is_none(),
    };
    tweb_pane::run_with_options(url.unwrap_or("about:blank"), options).await
}

/// tmux split-window 인자. 호출 pane을 알면 client의 active window가 아니라
/// 그 pane이 속한 window를 분할한다.
fn split_window_args(pane: Option<&str>, command: &str) -> Vec<String> {
    let mut args = ["split-window", "-h", "-p", "50"]
        .map(String::from)
        .to_vec();
    if let Some(pane) = pane {
        args.extend(["-t".to_string(), pane.to_string()]);
    }
    args.push(command.to_string());
    args
}

/// tmux split-window로 pane 만들고 그 안에서 `tweb __pane` 실행.
async fn split_and_run_pane(
    url: Option<&str>,
    browser: &BrowserOptions,
    _horizontal: bool,
) -> Result<()> {
    // 같은 executable을 internal subcommand로 다시 부른다. 별도 binary를 찾지
    // 않으므로 split pane이 이 CLI와 다른 build를 실행할 수 없다.
    let executable = std::env::current_exe().context("cannot resolve the running tweb binary")?;
    let pane_bin_str = executable.to_string_lossy().to_string();

    // 선택한 engine binary를 split pane에 명시적으로 전달한다.
    let mut env_str = String::new();
    match browser.engine {
        BrowserEngineArg::Electron => {
            if let Some(path) = find_electron_binary() {
                env_str.push_str(&format!(
                    "TWEB_ELECTRON={} ",
                    shell_quote(&path.to_string_lossy())
                ));
                if let Some(directory) = electron_app_dir(&path) {
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
        "{}{} __pane {}{}",
        env_str,
        shell_quote(&pane_bin_str),
        browser.shell_args(),
        url_arg
    );
    let target_pane = std::env::var("TMUX_PANE").ok();
    let split_args = split_window_args(target_pane.as_deref(), &pane_command);
    let status = std::process::Command::new("tmux")
        .args(split_args)
        .status()?;

    if !status.success() {
        anyhow::bail!("tmux split-window failed: {:?}", status);
    }
    Ok(())
}

/// Tauri engine binary 경로 찾기 (환경 변수로 전달).
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
    // An installed tweb runs from outside the workspace, so the relative
    // candidates above never match; the engine sits next to the binary instead.
    if let Some(binary) = tweb_pane::installed_electron_dir()
        .as_deref()
        .and_then(tweb_pane::electron_binary_in)
    {
        return Some(binary);
    }
    which::which("electron").ok()
}

/// Electron이 `.`으로 로드할 app directory.
///
/// `node_modules/electron`에도 package.json이 있어서 단순히 가장 가까운
/// package.json을 고르면 Electron package 자체를 app으로 실행하게 되고,
/// 화면에 아무것도 뜨지 않는다. node_modules 안쪽은 건너뛴다.
fn electron_app_dir(binary: &std::path::Path) -> Option<std::path::PathBuf> {
    binary
        .ancestors()
        .filter(|ancestor| {
            !ancestor
                .components()
                .any(|part| part.as_os_str() == "node_modules")
        })
        .find(|ancestor| ancestor.join("package.json").exists())
        .map(std::path::Path::to_path_buf)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use clap::Parser;

    use super::{default_open_args, electron_app_dir, split_window_args, Cli, Command};

    #[test]
    fn no_subcommand_opens_the_browser() {
        let cli = Cli::try_parse_from(default_open_args(vec![OsString::from("tweb")]))
            .expect("bare tweb should parse as open");
        match cli.command {
            Command::Open { browser, url } => {
                assert!(url.is_none());
                assert_eq!(browser.frame_rate, 30);
                assert!(browser.adaptive());
            }
            other => panic!("bare tweb parsed as {other:?}"),
        }
    }

    #[test]
    fn explicit_arguments_are_not_rewritten() {
        let args = vec![OsString::from("tweb"), OsString::from("--version")];
        assert_eq!(default_open_args(args.clone()), args);
    }

    #[test]
    fn split_targets_the_calling_pane() {
        assert_eq!(
            split_window_args(Some("%42"), "tweb __pane"),
            vec!["split-window", "-h", "-p", "50", "-t", "%42", "tweb __pane"]
        );
        assert_eq!(
            split_window_args(None, "tweb __pane"),
            vec!["split-window", "-h", "-p", "50", "tweb __pane"]
        );
    }

    /// The bug this guards: picking `node_modules/electron` as the app directory
    /// makes Electron load itself instead of TWeb, and the pane stays blank.
    #[test]
    fn app_dir_skips_the_electron_package() {
        let root = std::env::temp_dir().join(format!("tweb-appdir-{}", std::process::id()));
        let package = root.join("electron/node_modules/electron");
        let binary = package.join("dist/Electron.app/Contents/MacOS");
        std::fs::create_dir_all(&binary).expect("temp tree");
        std::fs::write(root.join("electron/package.json"), "{}").expect("app manifest");
        std::fs::write(package.join("package.json"), "{}").expect("package manifest");

        let found = electron_app_dir(&binary.join("Electron"));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(found, Some(root.join("electron")));
    }
}
