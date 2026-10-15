//! tweb CLI — `tweb open/split/snapshot/click/profile/doctor`.
//!
//! DESIGN.md section 4.1. The subcommand always comes before the action, target selectors
//! after: `tweb snapshot --pane %3`. Global selectors and per-subcommand selectors are never mixed.

pub mod agent;
pub mod chrome;
pub mod config;
pub mod daemon;
pub mod doctor;
pub mod mcp;
pub mod sites;
pub mod skill;

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use serde_json::json;

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum BrowserEngineArg {
    Electron,
    /// The user's real Google Chrome over CDP, for sites that need managed Chrome: Okta device
    /// trust, Endpoint Verification, policy-installed extensions. Hosted by the Electron engine.
    Chrome,
    /// macOS WebKit, through the tweb-webkit page host. Hosted by the Electron engine, so every
    /// feature but the Chromium-only ones (extensions, CDP) is the same code.
    #[value(alias = "tauri")]
    Webkit,
}

#[derive(Args, Clone, Debug)]
pub struct BrowserOptions {
    /// Browser rendering engine.
    /// Default: electron, or chrome for a URL listed in `engine.chrome_sites`.
    #[arg(long, value_enum)]
    pub engine: Option<BrowserEngineArg>,

    /// Maximum active frame rate. Default: `frame_rate.max` in config.toml (30).
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..=60))]
    pub frame_rate: Option<u16>,

    /// Explicitly enable activity-aware frame-rate adaptation (default).
    #[arg(long, overrides_with = "no_adaptive_frame_rate")]
    pub adaptive_frame_rate: bool,

    /// Disable activity-aware frame-rate adaptation.
    #[arg(long, overrides_with = "adaptive_frame_rate")]
    pub no_adaptive_frame_rate: bool,

    /// Send the pane's network through an ssh host, so its `localhost` is that host's.
    /// `host`, `user@host[:port]`, an ssh_config alias (`coder.<workspace>` after
    /// `coder config-ssh`), `coder:<workspace>`, or ssh flags and a destination in one
    /// quoted string (`"-J bastion me@box"`). The tunnel closes with the pane.
    /// Electron engine only; the pane gets its own profile for that host.
    // Hyphen values allowed: the pass-through form starts with an ssh flag (`-J bastion me@box`).
    #[arg(long, value_name = "DEST", allow_hyphen_values = true)]
    pub ssh: Option<String>,

    /// Let the terminal show through pages that paint no background of their own.
    /// `page.transparent` in config.toml turns it on for every pane. Electron engine only.
    #[arg(long)]
    pub transparent: bool,
}

impl BrowserOptions {
    /// The engine for `url`: the flag when given; otherwise chrome for a site listed in
    /// `engine.chrome_sites`, electron for everything else (and for a restored session).
    fn with_engine_for(&self, url: Option<&str>) -> BrowserOptions {
        let mut resolved = self.clone();
        // A tunnelled pane is an Electron pane: the Chrome engine's browser is shared by every
        // Chrome pane, so a proxy there would reroute all of them, and the WebKit host has no
        // per-pane proxy. `engine.chrome_sites` therefore does not apply to it.
        if resolved.ssh.is_some() && resolved.engine.is_none() {
            resolved.engine = Some(BrowserEngineArg::Electron);
        }
        if resolved.engine.is_none() {
            let site = url.and_then(|url| sites::matching_site(url, &config::chrome_sites()));
            if let Some(site) = &site {
                eprintln!(
                    "tweb: {site} is in engine.chrome_sites; opening on the Chrome engine \
                     (--engine electron to override)"
                );
            }
            resolved.engine = Some(if site.is_some() {
                BrowserEngineArg::Chrome
            } else {
                BrowserEngineArg::Electron
            });
        }
        resolved
    }

    fn engine(&self) -> BrowserEngineArg {
        self.engine.unwrap_or(BrowserEngineArg::Electron)
    }

    /// `--ssh`, parsed. Checked in the calling process, before any pane is split, so a typo is
    /// reported where it was typed rather than in a pane that closes as it opens.
    fn ssh_target(&self) -> Result<Option<tweb_pane::ssh::SshTarget>> {
        let Some(value) = &self.ssh else {
            return Ok(None);
        };
        if !matches!(self.engine(), BrowserEngineArg::Electron) {
            anyhow::bail!(
                "--ssh needs the Electron engine: the Chrome engine shares one browser across \
                 panes and the WebKit host has no per-pane proxy"
            );
        }
        tweb_pane::ssh::parse_target(value).map(Some)
    }

    /// Refuses `--transparent` where it cannot be honoured. Only the flag: `page.transparent`
    /// from config.toml is ignored by those engines instead, because a setting meant for every
    /// pane must not stop a Chrome pane from opening.
    fn check_transparent(&self) -> Result<()> {
        if self.transparent && !matches!(self.engine(), BrowserEngineArg::Electron) {
            anyhow::bail!(
                "--transparent needs the Electron engine: the Chrome engine's frames are JPEG and \
                 the WebKit host has no transparent path"
            );
        }
        Ok(())
    }

    /// A flag on this command line wins; otherwise `frame_rate.adaptive` from config.toml.
    fn adaptive(&self) -> bool {
        if self.adaptive_frame_rate {
            true
        } else if self.no_adaptive_frame_rate {
            false
        } else {
            config::frame_rate_adaptive()
        }
    }

    /// A flag on this command line wins; otherwise `frame_rate.max` from config.toml.
    fn max_frame_rate(&self) -> u16 {
        self.frame_rate.unwrap_or_else(config::frame_rate_max)
    }

    fn shell_args(&self) -> String {
        let mut value = format!(
            "--engine {} --frame-rate {}",
            match self.engine() {
                BrowserEngineArg::Electron => "electron",
                BrowserEngineArg::Chrome => "chrome",
                BrowserEngineArg::Webkit => "webkit",
            },
            self.max_frame_rate()
        );
        value.push_str(if self.adaptive() {
            " --adaptive-frame-rate"
        } else {
            " --no-adaptive-frame-rate"
        });
        if let Some(ssh) = &self.ssh {
            value.push_str(&format!(" --ssh={}", shell_quote(ssh)));
        }
        if self.transparent {
            value.push_str(" --transparent");
        }
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
    /// Navigate the resolved browser page. Exits non-zero when the page fails to load.
    Navigate {
        /// URL, host or local path. `back`, `forward` and `reload` run those commands instead.
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
    /// Open Chrome's DevTools for a Chrome-engine pane's page in a pane beside it.
    ///
    /// Without `--pane`, the Chrome-engine panes are listed and you pick one (a single one is
    /// used as is). The DevTools pane starts with TWeb's shortcuts off, so DevTools gets every
    /// key; `Ctrl-/` turns them back on.
    Devtools {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// The element the user picked in inspect mode — selector, HTML, text, box.
    InspectElement {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Show the current pane's page as an OS desktop window (floating mode).
    Float {
        #[command(flatten)]
        agent: AgentOptions,
    },
    /// Bring a floating page back into the tmux pane.
    Pin {
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
    /// The agent skill that teaches Claude Code or Codex to drive tweb: install, uninstall, print.
    Skill {
        #[command(subcommand)]
        action: SkillAction,
    },
    /// Settings in config.toml: list, get, set, unset, edit, path.
    Config {
        #[command(subcommand)]
        action: Option<ConfigAction>,
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
    /// Print the Electron binary and the app directory this tweb runs its engine from,
    /// unpacking the embedded app first if needed. For frontends that start the engine themselves.
    #[command(name = "engine-paths")]
    EnginePaths {
        /// Print `{"electron": ..., "app": ...}` instead of two lines.
        #[arg(long)]
        json: bool,
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

#[derive(Args, Clone, Debug)]
pub struct SkillAgents {
    /// Claude Code: `~/.claude/skills/tweb/SKILL.md` (`$CLAUDE_CONFIG_DIR` when set).
    #[arg(long)]
    pub claude: bool,
    /// Codex: `~/.codex/skills/tweb/SKILL.md` (`$CODEX_HOME` when set).
    #[arg(long)]
    pub codex: bool,
}

impl SkillAgents {
    fn agents(&self) -> Vec<skill::Agent> {
        let mut agents = Vec::new();
        if self.claude {
            agents.push(skill::Agent::Claude);
        }
        if self.codex {
            agents.push(skill::Agent::Codex);
        }
        agents
    }
}

#[derive(Subcommand, Debug)]
pub enum SkillAction {
    /// Write the skill for the agents named, or for each agent installed here when none is.
    Install {
        #[command(flatten)]
        agents: SkillAgents,
        /// Replace a SKILL.md that tweb did not write.
        #[arg(long)]
        force: bool,
    },
    /// Remove the skill tweb installed. A SKILL.md it did not write is kept.
    Uninstall {
        #[command(flatten)]
        agents: SkillAgents,
    },
    /// Print the skill to stdout, for an agent tweb does not know where to install for.
    Print {
        /// Include the Codex section.
        #[arg(long)]
        codex: bool,
    },
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
    /// Not built yet (DESIGN.md §10): it will import a Chrome profile's state into tweb.
    ///
    /// Today it exits with "not yet implemented". To browse as your everyday Chrome account, run a
    /// pane with `--engine chrome` and sign that profile in once with `tweb chrome login`.
    Bootstrap {
        /// The Chrome profile to import from: a profile directory name such as `Default` or
        /// `"Profile 1"` (see `chrome://version` → Profile Path), or a path to one.
        source: String,
    },
    /// The browser profiles panes run on, and the Google account each is signed in as.
    List {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum ConfigAction {
    /// Every setting, its value, and where the value came from (the default with no subcommand).
    List {
        #[arg(long)]
        json: bool,
    },
    /// One setting's value as it is in effect now.
    Get { key: String },
    /// Write one setting to config.toml.
    Set { key: String, value: String },
    /// Remove one setting from config.toml, back to its default.
    Unset { key: String },
    /// Open config.toml in $VISUAL / $EDITOR (created with every setting commented out).
    Edit,
    /// Print where config.toml is.
    Path,
}

#[derive(Subcommand, Debug)]
pub enum ChromeAction {
    /// Open a URL in managed Chrome.
    Open { url: String },
    /// Open the current tab's URL in managed Chrome.
    Current,
    /// Bridge status.
    Status,
    /// Open the `--engine chrome` profile in a normal Chrome window to sign in (Google refuses
    /// sign-in inside the engine's automated Chrome). Quit that window when done.
    Login {
        #[arg(default_value = "https://accounts.google.com/")]
        url: String,
    },
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
            run_pane(url.as_deref(), &browser.with_engine_for(url.as_deref())).await?;
        }
        Command::Split {
            browser,
            url,
            horizontal,
        } => {
            let url = url.map(|value| resolve_url_argument(&value, &working_directory));
            // An omitted URL is preserved across tmux split-window too.
            let browser = browser.with_engine_for(url.as_deref());
            browser.ssh_target()?;
            browser.check_transparent()?;
            split_and_run_pane(url.as_deref(), &browser, horizontal, None, &[]).await?;
        }
        Command::PaneInternal { browser, page, url } => {
            // Without a URL, restore the tmux window session.
            let result = run_pane(page.as_deref().or(url.as_deref()), &browser).await;
            // A split pane closes the moment this returns, taking the error with it — and an ssh
            // that could not connect is the one failure here a person has to read to fix (a host
            // name, a key, a refused login). So that pane waits for Enter first.
            if let (Err(error), Some(_)) = (&result, &browser.ssh) {
                use std::io::{BufRead, IsTerminal};
                if std::io::stdin().is_terminal() {
                    eprintln!("tweb: {error:#}\n\npress Enter to close this pane");
                    let _ = std::io::stdin().lock().read_line(&mut String::new());
                    // Already reported. Returning the error would print it a second time, after
                    // the person dismissed the first. The tunnel is gone with `run_pane`'s frame,
                    // so there is nothing left for a destructor to do.
                    std::process::exit(1);
                }
            }
            result?;
        }
        Command::EnginePaths { json } => {
            let (electron, app) = tweb_pane::find_electron()?;
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "electron": electron.display().to_string(), "app": app.display().to_string() })
                );
            } else {
                println!("{}\n{}", electron.display(), app.display());
            }
        }
        Command::Doctor { fix } => {
            doctor::run(fix).await?;
        }
        Command::Skill { action } => match action {
            SkillAction::Install { agents, force } => skill::install(&agents.agents(), force)?,
            SkillAction::Uninstall { agents } => skill::uninstall(&agents.agents())?,
            SkillAction::Print { codex } => print!(
                "{}",
                skill::render(if codex {
                    skill::Agent::Codex
                } else {
                    skill::Agent::Claude
                })
            ),
        },
        Command::Config { action } => match action.unwrap_or(ConfigAction::List { json: false }) {
            ConfigAction::List { json } => config::list(json)?,
            ConfigAction::Get { key } => config::get(&key)?,
            ConfigAction::Set { key, value } => config::set(&key, &value)?,
            ConfigAction::Unset { key } => config::unset(&key)?,
            ConfigAction::Edit => config::edit()?,
            ConfigAction::Path => println!("{}", config::path().display()),
        },
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
            ChromeAction::Login { url } => chrome::login(&url)?,
            ChromeAction::Current => {
                // Ask the pane for the URL it is showing, then hand it to Chrome.
                // `agent::run` prints the rendered result, so call `request` directly
                // to get the JSON back and pull the URL out of it.
                let result = agent::request(None, "status", json!({}))?;
                let url = result
                    .get("url")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if url.is_empty() {
                    println!("no browser pane to hand off");
                } else {
                    match chrome::open(&url)? {
                        chrome::Handoff::Bridge => println!("Opened in managed Chrome: {url}"),
                        chrome::Handoff::SystemOpen => {
                            println!("Opened in Google Chrome (no tmux-chrome bridge): {url}");
                        }
                    }
                }
            }
        },
        Command::Daemon { action } => match action {
            DaemonAction::Status => daemon::status()?,
            DaemonAction::Stop => daemon::stop()?,
            DaemonAction::Restart => daemon::restart()?,
        },
        Command::Panes { agent } => agent::list_panes(agent.json)?,
        Command::Devtools { agent } => open_devtools(agent.pane.as_deref()).await?,
        Command::Profile {
            action: ProfileAction::List { json },
        } => chrome::list_profiles(json)?,
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
        // `back`, `forward` and `reload` are commands, not hosts: as URLs they became
        // `https://back`, a DNS failure that left every following read on an error page.
        Command::Navigate { url, agent } => match url.trim().to_ascii_lowercase().as_str() {
            "back" => ("back", json!({}), agent),
            "forward" => ("forward", json!({}), agent),
            "reload" => ("reload", json!({}), agent),
            _ => {
                let url = resolve_url_argument(&url, working_directory);
                ("navigate", json!({ "url": url }), agent)
            }
        },
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
        Command::Float { agent } => ("float", json!({}), agent),
        Command::Pin { agent } => ("pin", json!({}), agent),
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
    browser.check_transparent()?;
    // The frontend locates the engine paths itself. If the CLI guessed and passed them in, the
    // binary and the app directory could end up mismatched (node_modules/electron has a
    // package.json too), and being the same process there is no reason to pass them anyway.
    // An omitted URL is a request to restore the tmux window session.
    let options = tweb_pane::PaneOptions {
        engine: match browser.engine() {
            BrowserEngineArg::Electron => tweb_pane::BrowserEngine::Electron,
            BrowserEngineArg::Chrome => tweb_pane::BrowserEngine::Chrome,
            BrowserEngineArg::Webkit => tweb_pane::BrowserEngine::Webkit,
        },
        frame_rate: browser.max_frame_rate(),
        adaptive_frame_rate: browser.adaptive(),
        restore_session: url.is_none(),
        ssh: browser.ssh_target()?,
        transparent: browser.transparent,
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
/// `beside` splits that pane instead of the calling one; `extra_env` is set for the new pane only.
async fn split_and_run_pane(
    url: Option<&str>,
    browser: &BrowserOptions,
    _horizontal: bool,
    beside: Option<&str>,
    extra_env: &[(&str, &str)],
) -> Result<()> {
    // Re-invoke the same executable through an internal subcommand. Nothing looks up a separate
    // binary, so a split pane cannot end up running a different build than this CLI.
    let executable = std::env::current_exe().context("cannot resolve the running tweb binary")?;
    let pane_bin_str = executable.to_string_lossy().to_string();

    // The split pane is this same executable, so it resolves the Electron engine and its app code
    // by the same rules — from where the binary lives, not from the directory `tweb split` was run
    // in. Resolving them here instead looked for `electron/` under the cwd, so a split opened from
    // inside a checkout ran that checkout's older app code. Only an explicit override is passed on.
    let mut env_str = String::new();
    for name in ["TWEB_ELECTRON", "TWEB_ELECTRON_DIR", "TWEB_WEBKIT"] {
        if let Ok(value) = std::env::var(name) {
            env_str.push_str(&format!("{name}={} ", shell_quote(&value)));
        }
    }

    for (name, value) in extra_env {
        env_str.push_str(&format!("{name}={} ", shell_quote(value)));
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
    let target_pane = beside
        .map(str::to_string)
        .or_else(|| std::env::var("TMUX_PANE").ok());
    let split_args = split_window_args(target_pane.as_deref(), &pane_command);
    let status = std::process::Command::new("tmux")
        .args(split_args)
        .status()?;

    if !status.success() {
        anyhow::bail!("tmux split-window failed: {:?}", status);
    }
    Ok(())
}

/// `tweb devtools`: ask the pane for its page's DevTools URL and open it beside that pane.
///
/// The URL is Chrome's own DevTools page, served by the engine Chrome over its debugging port, so
/// the new pane is a Chrome-engine pane too: it reaches 127.0.0.1 on the same machine, and its
/// origin is the one the engine Chrome allows (see `chromeArgs` in electron/cdp/connection.cjs).
async fn open_devtools(pane: Option<&str>) -> Result<()> {
    // Which page to inspect is the user's choice, not something to infer: without `--pane` the
    // Chrome-engine panes are listed and one is picked, rather than the caller having to look a
    // pane id up first, or getting whichever pane happens to sit next to the shell.
    let picked;
    let pane = match pane {
        Some(pane) => pane,
        None => {
            picked = pick_inspect_target()?;
            picked.as_str()
        }
    };
    let result = agent::request(Some(pane), "devtools", json!({}))?;
    let Some(url) = result.get("url").and_then(serde_json::Value::as_str) else {
        let message = result
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("the pane did not return a DevTools URL");
        anyhow::bail!("{message}");
    };
    // Beside the inspected pane, which is not necessarily the one `tweb devtools` was typed in.
    // A pane started outside tmux is named `pid-<N>` and has nothing to split; the DevTools pane
    // then opens beside the caller instead.
    let beside = pane.starts_with('%').then(|| pane.to_string());
    let browser = BrowserOptions {
        engine: Some(BrowserEngineArg::Chrome),
        frame_rate: None,
        adaptive_frame_rate: false,
        no_adaptive_frame_rate: false,
        ssh: None,
        transparent: false,
    };
    split_and_run_pane(
        Some(url),
        &browser,
        false,
        beside.as_deref(),
        &[("TWEB_START_VIMIUM", "0")],
    )
    .await
}

/// The pane `tweb devtools` inspects when none was named: the only Chrome-engine pane, or the one
/// picked from a numbered list.
fn pick_inspect_target() -> Result<String> {
    use std::io::{BufRead, IsTerminal, Write};
    let targets = agent::inspect_targets();
    match targets.as_slice() {
        [] => anyhow::bail!("no Chrome-engine pane is running (open one with --engine chrome)"),
        [only] => {
            eprintln!("inspecting {} {}", only.pane, describe_target(only));
            return Ok(only.pane.clone());
        }
        _ => {}
    }
    let listing = targets
        .iter()
        .enumerate()
        .map(|(index, target)| {
            format!(
                "  {}) {:<5} {}{}",
                index + 1,
                target.pane,
                describe_target(target),
                if target.nearby { "" } else { "  (elsewhere)" }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !std::io::stdin().is_terminal() {
        anyhow::bail!("several Chrome-engine panes are running; pass --pane:\n{listing}");
    }
    eprintln!("Inspect which page?\n{listing}");
    let mut stderr = std::io::stderr();
    loop {
        write!(stderr, "number [1]: ")?;
        stderr.flush()?;
        let mut line = String::new();
        if std::io::stdin().lock().read_line(&mut line)? == 0 {
            anyhow::bail!("no pane picked");
        }
        let line = line.trim();
        let choice = if line.is_empty() {
            Ok(1)
        } else {
            line.parse::<usize>()
        };
        match choice {
            Ok(number) if (1..=targets.len()).contains(&number) => {
                return Ok(targets[number - 1].pane.clone());
            }
            _ => eprintln!("pick a number from 1 to {}", targets.len()),
        }
    }
}

fn describe_target(target: &agent::InspectTarget) -> String {
    let title: String = target.title.chars().take(48).collect();
    let url: String = target.url.chars().take(60).collect();
    if title.is_empty() {
        url
    } else {
        format!("{title} — {url}")
    }
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
        default_open_args, resolve_output_path, resolve_url_argument, split_window_args, Cli,
        Command,
    };

    #[test]
    fn engine_paths_is_a_command_of_its_own_not_an_open_url() {
        // `default_open_args` turns an unknown first word into `open <url>`; this must not.
        let cli = Cli::try_parse_from(default_open_args(vec![
            OsString::from("tweb"),
            OsString::from("engine-paths"),
            OsString::from("--json"),
        ]))
        .expect("engine-paths should parse");
        assert!(matches!(cli.command, Command::EnginePaths { json: true }));
    }

    #[test]
    fn no_subcommand_opens_the_browser() {
        let cli = Cli::try_parse_from(default_open_args(vec![OsString::from("tweb")]))
            .expect("bare tweb should parse as open");
        match cli.command {
            Command::Open { browser, url } => {
                assert!(url.is_none());
                // Unset on the command line, so config.toml (or its default) decides.
                assert_eq!(browser.frame_rate, None);
                assert!(!browser.no_adaptive_frame_rate);
            }
            other => panic!("bare tweb parsed as {other:?}"),
        }
    }

    /// `tweb split --ssh` re-runs this binary as `__pane` through a shell command line, so the
    /// value has to survive quoting — including the pass-through form that starts with a flag.
    #[test]
    fn ssh_survives_the_split_command_line() {
        let cli = Cli::try_parse_from([
            "tweb",
            "split",
            "--frame-rate",
            "30",
            "--adaptive-frame-rate",
            "--ssh",
            "-J bastion me@box",
            "http://localhost:3000",
        ])
        .expect("split --ssh should parse");
        let Command::Split { browser, .. } = cli.command else {
            panic!("not a split");
        };
        // Electron without consulting `engine.chrome_sites`, which would read config.toml.
        let browser = browser.with_engine_for(Some("http://localhost:3000"));
        assert!(matches!(
            browser.engine,
            Some(super::BrowserEngineArg::Electron)
        ));
        let target = browser.ssh_target().unwrap().unwrap();
        assert_eq!(target.destination, "me@box");
        let args = browser.shell_args();
        assert!(args.ends_with("--ssh='-J bastion me@box'"), "{args}");
        // And the pane parses what the split wrote.
        let pane =
            Cli::try_parse_from(["tweb", "__pane", "--ssh=-J bastion me@box", "about:blank"])
                .expect("__pane --ssh= should parse");
        let Command::PaneInternal { browser, .. } = pane.command else {
            panic!("not a pane");
        };
        assert_eq!(browser.ssh.as_deref(), Some("-J bastion me@box"));
    }

    #[test]
    fn ssh_refuses_the_engines_that_cannot_proxy_one_pane() {
        let cli =
            Cli::try_parse_from(["tweb", "open", "--engine", "chrome", "--ssh", "box"]).unwrap();
        let Command::Open { browser, .. } = cli.command else {
            panic!("not an open");
        };
        assert!(browser.ssh_target().is_err());
    }

    #[test]
    fn transparent_reaches_the_split_pane_and_only_on_electron() {
        let cli = Cli::try_parse_from([
            "tweb",
            "split",
            "--frame-rate",
            "30",
            "--adaptive-frame-rate",
            "--transparent",
            "--engine",
            "electron",
        ])
        .unwrap();
        let Command::Split { browser, .. } = cli.command else {
            panic!("not a split");
        };
        assert!(browser.check_transparent().is_ok());
        assert!(browser.shell_args().ends_with(" --transparent"));
        for engine in ["chrome", "webkit"] {
            let cli =
                Cli::try_parse_from(["tweb", "open", "--engine", engine, "--transparent"]).unwrap();
            let Command::Open { browser, .. } = cli.command else {
                panic!("not an open");
            };
            assert!(browser.check_transparent().is_err(), "{engine}");
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

    /// `tweb navigate back` loaded https://back, failed DNS, and every read after it ran on the
    /// error page. History words map onto their own commands, even with a `./back` file around.
    #[test]
    fn navigate_history_words_are_history_commands() {
        let directory = std::env::temp_dir().join(format!("tweb-nav-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("dir");
        std::fs::write(directory.join("back"), "").expect("file");
        for (word, method) in [
            ("back", "back"),
            ("Forward", "forward"),
            ("reload", "reload"),
        ] {
            let cli = Cli::try_parse_from(["tweb", "navigate", word]).expect("parse");
            let (called, params, _) = super::agent_call(cli.command, &directory).expect("call");
            assert_eq!(called, method, "{word}");
            assert_eq!(params, serde_json::json!({}));
        }
        let cli = Cli::try_parse_from(["tweb", "navigate", "back.example.com"]).expect("parse");
        let (called, params, _) = super::agent_call(cli.command, &directory).expect("call");
        assert_eq!(called, "navigate");
        assert_eq!(params["url"], "back.example.com");
        let _ = std::fs::remove_dir_all(&directory);
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
}
