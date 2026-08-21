//! tweb CLI — `tweb open/split/snapshot/click/profile/doctor`.
//!
//! DESIGN.md section 4.1. The subcommand always comes before the action, target selectors
//! after: `tweb snapshot --pane %3`. Global selectors and per-subcommand selectors are never mixed.

pub mod agent;
pub mod chrome;
pub mod daemon;
pub mod doctor;
pub mod mcp;

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

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
/// Runs a real Chromium browser inside a tmux pane. Humans and agents share the same page.
#[derive(Parser, Debug)]
#[command(name = "tweb", version, about, long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Run the browser frontend in the current terminal/pane.
    Open {
        #[command(flatten)]
        browser: BrowserOptions,
        url: Option<String>,
    },
    /// Create a browser pane in the current tmux window.
    Split {
        #[command(flatten)]
        browser: BrowserOptions,
        url: Option<String>,
        #[arg(short = 'H')]
        horizontal: bool,
    },
    /// List automatable browser panes.
    Panes {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Navigate the resolved browser page.
    Navigate {
        url: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Go back in history.
    Back {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Go forward in history.
    Forward {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// page reload.
    Reload {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Browser page state.
    Status {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Snapshot of the interactive elements. The refs match the `f` hint labels.
    Snapshot {
        /// Reading snapshot that also includes links, headings and text.
        #[arg(long)]
        text: bool,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Look up a CSS selector by ref (single lookup, no snapshot needed).
    Query {
        selector: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// element click.
    Click {
        /// The ref a snapshot assigned (e.g. a, sd).
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
    /// Set the value of an input/textarea/contenteditable.
    Fill {
        r#ref: String,
        value: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Type text into the focused element.
    Type {
        text: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// key press (e.g. Enter, Tab, Escape).
    Press {
        key: String,
        /// modifier (shift, control, alt, meta). Repeatable.
        #[arg(long = "mod")]
        modifiers: Vec<String>,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Pick a select option.
    Select {
        r#ref: String,
        value: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Check a checkbox/radio.
    Check {
        r#ref: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Uncheck a checkbox.
    Uncheck {
        r#ref: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Read an element's text.
    Text {
        r#ref: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Read an element's outer HTML.
    Html {
        r#ref: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Run JavaScript in the page.
    Eval {
        script: String,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Wait until a condition holds.
    Wait {
        /// Wait for a CSS selector to appear.
        #[arg(long)]
        selector: Option<String>,
        /// Wait for text to appear in the body.
        #[arg(long)]
        text: Option<String>,
        /// Wait for a partial URL match.
        #[arg(long)]
        url: Option<String>,
        /// Wait for loading to finish.
        #[arg(long)]
        load: bool,
        /// Wait a fixed amount of time (ms).
        #[arg(long)]
        ms: Option<u64>,
        #[arg(long, default_value_t = 10000)]
        timeout: u64,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// console records.
    Console {
        #[arg(long, default_value_t = 100)]
        limit: usize,
        /// Clear the buffer after reading.
        #[arg(long)]
        clear: bool,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Network requests the page made.
    Network {
        #[arg(long, default_value_t = 100)]
        limit: usize,
        /// Clear the buffer after reading.
        #[arg(long)]
        clear: bool,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// console errors only.
    Errors {
        #[arg(long, default_value_t = 50)]
        limit: usize,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// List tabs.
    Tabs {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Switch, create and close tabs.
    Tab {
        #[command(subcommand)]
        action: TabAction,
    },
    /// screenshot.
    Screenshot {
        /// Where to save it. Without a path, a base64 PNG is printed.
        path: Option<String>,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Screenshot of the whole document, including what is below the fold.
    FullScreenshot {
        /// Where to save it. Without a path, a base64 PNG is printed.
        path: Option<String>,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Emulate a mobile device viewport.
    Device {
        /// iPhone 12, iPad or Pixel 5. Matched without regard to case.
        name: Option<String>,
        /// Go back to the pane's own viewport and user agent.
        #[arg(long)]
        reset: bool,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Save the page as a PDF.
    Pdf {
        /// Where to save it. Without a path, a base64 PDF is printed.
        path: Option<String>,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Console, network and a screenshot from one moment.
    Capture {
        /// Where to save the screenshot. Without a path, the PNG comes back inline.
        path: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// The element the user picked in inspect mode — selector, HTML, text, box.
    InspectElement {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// MCP server for agents (stdio).
    Mcp {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Inspect, hand off and materialize resources.
    Resource {
        #[command(subcommand)]
        action: ResourceAction,
    },
    /// Bootstrap and manage profiles.
    Profile {
        #[command(subcommand)]
        action: ProfileAction,
    },
    /// Manage the managed-Chrome handoff and bridge.
    Chrome {
        #[command(subcommand)]
        action: ChromeAction,
    },
    /// Supervisor (twebd) status, stop and restart.
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },
    /// A running pane's geometry, zoom, frame and input state.
    Diag {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Which browser extensions loaded, and what each one actually got.
    Extensions {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Read the engine debug log (the TWEB_DEBUG lines).
    EngineLog {
        #[arg(long, default_value_t = 60)]
        limit: usize,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Diagnose and configure terminal/tmux/GPU capabilities.
    Doctor {
        /// Install the safely managed configuration block, then diagnose again.
        #[arg(long)]
        fix: bool,
    },
    /// internal: the pane frontend (launched by tmux; not a documented automation API).
    #[command(name = "__pane", hide = true)]
    PaneInternal {
        #[command(flatten)]
        browser: BrowserOptions,
        /// A resolved page id. When given, it is used instead of the URL.
        #[arg(long)]
        page: Option<String>,
        url: Option<String>,
    },
}

/// Shared options for every command that drives a running browser pane.
#[derive(Args, Clone, Debug)]
pub struct AgentOptions {
    /// Target tmux pane (e.g. %3). Omitted, it means the only running pane.
    #[arg(long, global = true)]
    pub pane: Option<String>,

    /// Print raw JSON instead of the human-readable summary.
    #[arg(long, global = true)]
    pub json: bool,
}

#[derive(Subcommand, Debug)]
pub enum TabAction {
    /// Switch to a tab by index.
    Switch {
        index: usize,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// New tab.
    New {
        url: Option<String>,
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Close a tab.
    Close {
        index: Option<usize>,
        #[command(flatten)]
        agent: AgentOptions,
    },
}

#[derive(Subcommand, Debug)]
pub enum ResourceAction {
    /// List resources.
    List {
        #[arg(long)]
        window: Option<String>,
    },
    /// Resource details.
    Inspect { id: String },
    /// Materialize a resource at a path.
    Materialize {
        id: String,
        #[arg(long)]
        to: String,
    },
    /// Hand a resource to another pane.
    Send {
        id: String,
        #[arg(long)]
        to_pane: i32,
    },
    /// Clean up expired resources.
    Gc,
}

#[derive(Subcommand, Debug)]
pub enum ProfileAction {
    /// Chrome profile bootstrap.
    Bootstrap { source: String },
    /// List profiles.
    List,
}

#[derive(Subcommand, Debug)]
pub enum ChromeAction {
    /// Open a URL in managed Chrome.
    Open { url: String },
    /// Bridge status.
    Status,
}

#[derive(Subcommand, Debug)]
pub enum DaemonAction {
    /// Show the supervisor's pid, socket, uptime, pane count and engine state.
    Status,
    /// Shut the supervisor down. Every hosted pane goes with it.
    Stop,
    /// Stop the supervisor and start a fresh one. Panes reattach on their next navigation.
    Restart,
}

fn default_open_args(mut args: Vec<OsString>) -> Vec<OsString> {
    // The installed command is the browser entry point. Requiring an otherwise
    // redundant `open` makes `make install && tweb` look like a broken install.
    if args.len() == 1 {
        args.push(OsString::from("open"));
    }
    args
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized.file_name().is_some() {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    normalized
}

/// Resolves a file path an agent asked us to write, against the caller's directory.
///
/// The engine is the process that writes the file, and its cwd is the Electron app
/// directory — not wherever the user ran `tweb`. So `tweb screenshot shot.png` used to
/// land in the app directory (in a dev checkout, inside the source tree) while the caller
/// looked for it beside them and found nothing. The path is made absolute here, where the
/// caller's directory is still known.
pub(crate) fn resolve_output_path(value: &str, working_directory: &Path) -> String {
    let path = Path::new(value.trim());
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        working_directory.join(path)
    };
    normalize_path(&absolute).to_string_lossy().into_owned()
}

fn resolve_url_argument(value: &str, working_directory: &Path) -> String {
    let value = value.trim();
    let path = Path::new(value);
    let explicit_relative =
        value == "." || value == ".." || value.starts_with("./") || value.starts_with("../");
    let candidate: Option<PathBuf> = if path.is_absolute() {
        Some(path.to_path_buf())
    } else {
        let joined = working_directory.join(path);
        (explicit_relative || joined.exists()).then_some(joined)
    };

    candidate
        .map(|path| normalize_path(&path))
        .and_then(|path| url::Url::from_file_path(path).ok())
        .map(Into::into)
        .unwrap_or_else(|| value.to_string())
}

/// Runs the CLI.
pub async fn run() -> Result<()> {
    let cli = Cli::parse_from(default_open_args(std::env::args_os().collect()));
    tracing::debug!(?cli, "tweb command");
    let working_directory =
        std::env::current_dir().context("cannot resolve the current directory")?;

    match cli.command {
        Command::Open { browser, url } => {
            // Resolve local paths before Electron changes into its app directory or a
            // split pane starts in a different shell directory.
            let url = url.map(|value| resolve_url_argument(&value, &working_directory));
            // An omitted URL is carried through to the pane frontend so it restores the tmux window session.
            run_pane(url.as_deref(), &browser).await?;
        }
        Command::Split {
            browser,
            url,
            horizontal,
        } => {
            let url = url.map(|value| resolve_url_argument(&value, &working_directory));
            // An omitted URL is preserved across tmux split-window too.
            split_and_run_pane(url.as_deref(), &browser, horizontal).await?;
        }
        Command::PaneInternal { browser, page, url } => {
            // Without a URL, restore the tmux window session.
            run_pane(page.as_deref().or(url.as_deref()), &browser).await?;
        }
        Command::Doctor { fix } => {
            doctor::run(fix).await?;
        }
        Command::Chrome { action } => match action {
            ChromeAction::Open { url } => {
                let url = resolve_url_argument(&url, &working_directory);
                match chrome::open(&url)? {
                    chrome::Handoff::Bridge => println!("Opened in managed Chrome: {url}"),
                    chrome::Handoff::SystemOpen => {
                        println!("Opened in Google Chrome (no tmux-chrome bridge): {url}");
                    }
                }
            }
            ChromeAction::Status => println!("{}", chrome::status().report()),
        },
        Command::Daemon { action } => match action {
            DaemonAction::Status => daemon::status()?,
            DaemonAction::Stop => daemon::stop()?,
            DaemonAction::Restart => daemon::restart()?,
        },
        Command::Panes { agent } => agent::list_panes(agent.json)?,
        Command::Mcp { agent } => mcp::serve(agent.pane.as_deref())?,
        Command::Tab { action } => {
            let (method, params, agent) = match action {
                TabAction::Switch { index, agent } => ("tab", json!({ "index": index }), agent),
                TabAction::New { url, agent } => {
                    let url = url.map(|value| resolve_url_argument(&value, &working_directory));
                    ("tab-new", json!({ "url": url }), agent)
                }
                TabAction::Close { index, agent } => {
                    ("tab-close", json!({ "index": index }), agent)
                }
            };
            agent::run(agent.pane.as_deref(), method, params, agent.json)?;
        }
        other => {
            let (method, params, agent) = agent_call(other, &working_directory)?;
            agent::run(agent.pane.as_deref(), method, params, agent.json)?;
        }
    }

    Ok(())
}

/// Map a page-driving subcommand onto its JSON-RPC method and params.
fn agent_call(
    command: Command,
    working_directory: &Path,
) -> Result<(&'static str, serde_json::Value, AgentOptions)> {
    let act = |r#ref: String, action: &str, value: Option<String>| json!({ "ref": r#ref, "action": action, "value": value });
    Ok(match command {
        Command::Navigate { url, agent } => {
            let url = resolve_url_argument(&url, working_directory);
            ("navigate", json!({ "url": url }), agent)
        }
        Command::Back { agent } => ("back", json!({}), agent),
        Command::Forward { agent } => ("forward", json!({}), agent),
        Command::Reload { agent } => ("reload", json!({}), agent),
        Command::Status { agent } => ("status", json!({}), agent),
        Command::Diag { agent } => ("diag", json!({}), agent),
        Command::Extensions { agent } => ("extensions", json!({}), agent),
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
        Command::Screenshot { path, agent } => {
            // Without a path the PNG comes back as base64 and nothing is written, so
            // there is nothing to resolve.
            let path = path.map(|value| resolve_output_path(&value, working_directory));
            ("screenshot", json!({ "path": path }), agent)
        }
        Command::FullScreenshot { path, agent } => {
            // Same resolution as `screenshot`, and the same reason: the engine writes the
            // file from its own directory rather than the caller's.
            let path = path.map(|value| resolve_output_path(&value, working_directory));
            ("full-screenshot", json!({ "path": path }), agent)
        }
        Command::Device { name, reset, agent } => {
            ("device", json!({ "name": name, "reset": reset }), agent)
        }
        Command::Pdf { path, agent } => {
            // Same resolution as the screenshot path, and for the same reason: the engine
            // writes the file from its own directory, not the caller's.
            let path = path.map(|value| resolve_output_path(&value, working_directory));
            ("pdf", json!({ "path": path }), agent)
        }
        Command::Capture { path, limit, agent } => {
            // Same resolution as the screenshot path: the screenshot inside the capture is
            // written by the engine, from the engine's directory rather than the caller's.
            let path = path.map(|value| resolve_output_path(&value, working_directory));
            ("capture", json!({ "path": path, "limit": limit }), agent)
        }
        Command::InspectElement { agent } => ("inspect-element", json!({}), agent),
        Command::Console {
            limit,
            clear,
            agent,
        } => ("console", json!({ "limit": limit, "clear": clear }), agent),
        Command::Network {
            limit,
            clear,
            agent,
        } => ("network", json!({ "limit": limit, "clear": clear }), agent),
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

/// Runs the browser frontend in the current pane.
///
/// `tweb` is a single multi-call executable, so the pane frontend runs in this very process
/// rather than being spawned as a separate binary. That is what keeps version skew from
/// appearing between the CLI and the frontend (DESIGN.md 4.1).
async fn run_pane(url: Option<&str>, browser: &BrowserOptions) -> Result<()> {
    // The frontend locates the engine paths itself. If the CLI guessed and passed them in, the
    // binary and the app directory could end up mismatched (node_modules/electron has a
    // package.json too), and being the same process there is no reason to pass them anyway.
    // An omitted URL is a request to restore the tmux window session.
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

/// Arguments for tmux split-window. Knowing the calling pane, we split the window that pane
/// belongs to rather than the client's active window.
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

/// Creates a pane via tmux split-window and runs `tweb __pane` inside it.
async fn split_and_run_pane(
    url: Option<&str>,
    browser: &BrowserOptions,
    _horizontal: bool,
) -> Result<()> {
    // Re-invoke the same executable through an internal subcommand. Nothing looks up a separate
    // binary, so a split pane cannot end up running a different build than this CLI.
    let executable = std::env::current_exe().context("cannot resolve the running tweb binary")?;
    let pane_bin_str = executable.to_string_lossy().to_string();

    // Pass the chosen engine binary to the split pane explicitly.
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

/// Finds the Tauri engine binary path (passed through an environment variable).
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

/// The app directory Electron loads as `.`.
///
/// `node_modules/electron` carries a package.json of its own, so simply picking the nearest
/// package.json would run the Electron package itself as the app and nothing would appear on
/// screen. Anything under node_modules is skipped.
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
    use std::path::Path;

    use clap::Parser;

    use super::{
        default_open_args, electron_app_dir, resolve_output_path, resolve_url_argument,
        split_window_args, Cli, Command,
    };

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
    fn local_paths_resolve_against_the_calling_directory() {
        let directory = Path::new("/Users/example/project");
        assert_eq!(
            resolve_url_argument("./README.md", directory),
            "file:///Users/example/project/README.md"
        );
        assert_eq!(
            resolve_url_argument("../docs/계획 #1.md", directory),
            "file:///Users/example/docs/%EA%B3%84%ED%9A%8D%20%231.md"
        );
        assert_eq!(
            resolve_url_argument("example.com", directory),
            "example.com"
        );
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
    /// The bug this guards: a relative screenshot path was sent to the engine verbatim,
    /// and the engine resolved it against *its* cwd — the Electron app directory. In a dev
    /// checkout that wrote the PNG into the source tree while the caller found nothing.
    #[test]
    fn screenshot_paths_resolve_against_the_calling_directory() {
        let directory = Path::new("/Users/example/project");
        assert_eq!(
            resolve_output_path("shot.png", directory),
            "/Users/example/project/shot.png"
        );
        assert_eq!(
            resolve_output_path("./out/shot.png", directory),
            "/Users/example/project/out/shot.png"
        );
        assert_eq!(
            resolve_output_path("../shot.png", directory),
            "/Users/example/shot.png"
        );
        // Whitespace around a shell-quoted path is the caller's, not part of the name.
        assert_eq!(
            resolve_output_path("  shot.png  ", directory),
            "/Users/example/project/shot.png"
        );
    }

    #[test]
    fn an_absolute_screenshot_path_is_left_where_the_caller_put_it() {
        let directory = Path::new("/Users/example/project");
        assert_eq!(
            resolve_output_path("/tmp/shot.png", directory),
            "/tmp/shot.png"
        );
        // Still normalized, so the engine never has to interpret a `..` of its own.
        assert_eq!(
            resolve_output_path("/tmp/a/../shot.png", directory),
            "/tmp/shot.png"
        );
    }

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
