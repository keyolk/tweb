//! `tweb doctor` — terminal/tmux/GPU/extension capability 진단과 안전한 설정.
//!
//! `--fix`는 사용자 설정에 managed include만 갱신하고 기존 파일을 backup한다.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};

const GHOSTTY_BEGIN: &str = "# >>> tweb doctor managed passthrough >>>";
const GHOSTTY_END: &str = "# <<< tweb doctor managed passthrough <<<";
const TMUX_BEGIN: &str = "# >>> tweb doctor managed terminal options >>>";
const TMUX_END: &str = "# <<< tweb doctor managed terminal options <<<";

const LEGACY_GHOSTTY_TOGGLE: &str = r"keybind = ctrl+semicolon=text:\x1b[5001~";
const LEGACY_TMUX_BEGIN: &str =
    "# TWeb browser passthrough mode. Every unmatched key is forwarded to the pane,";
const LEGACY_TMUX_END: &str =
    "bind-key -T tweb-pass WheelDownPane send-keys -M \\; switch-client -T tweb-pass";

const GHOSTTY_MANAGED_BASE: &str = r#"# Managed by `tweb doctor --fix`; edit the main Ghostty config instead.
# Private CSI sequences preserve browser shortcuts through tmux.
keybind = ctrl+comma=text:\x1b[5009~
keybind = ctrl+shift+semicolon=text:\x1b[5010~
keybind = ctrl+equal=text:\x1b[5002~
keybind = ctrl+shift+equal=text:\x1b[5007~
keybind = ctrl+minus=text:\x1b[5003~
keybind = ctrl+zero=text:\x1b[5004~
keybind = shift+enter=text:\x1b[5008~

# Cmd combinations are delivered by CMD_PASSTHROUGH_KEYS below, appended to
# this block: Ghostty emits no PTY encoding of its own for them, so each one
# is carried as a private sequence instead.

# Ctrl-; carries the mode toggle as the private 5001 sequence rather than
# relying on the raw Ctrl-; encoding, which differs between modifyOtherKeys
# (ESC[27;5;59~) and Kitty CSI-u (ESC[59;5u).
#
# The Ghostty key table and the engine's N/P mode are deliberately *not* the
# same switch. The table only decides whether Cmd combinations get encoded at
# all, and those should reach the page in either mode — a web app's Cmd-K has
# nothing to do with TWeb's own single-letter shortcuts. So Ctrl-; enters the
# table on the first press and then stays there, while every press sends 5001
# and lets the engine flip N <-> P. (Re-activating the innermost table is
# refused by Ghostty, hence the separate in-table binding.)
#
# Leaving the table needs Ghostty's own key, since nothing in the terminal can
# deactivate it: Ctrl-Shift-; drops back to the default table, which is also
# the emergency detach key, so a wedged pane recovers with one chord.
keybind = ctrl+semicolon=activate_key_table:tweb
keybind = chain=text:\x1b[5001~
keybind = tweb/ctrl+semicolon=text:\x1b[5001~
keybind = tweb/ctrl+shift+semicolon=deactivate_key_table
keybind = chain=text:\x1b[5010~
# Ctrl-: toggles vimium shortcuts independently of bypass. Root binding —
# vimium on/off is useful in every mode, not only inside the tweb table.
keybind = ctrl+:=text:\x1b[5014~
# Inner-table catch-all bindings shadow Ghostty application shortcuts while
# unconsumed preserves each key's terminal encoding for TWeb.
keybind = tweb/unconsumed:super+catch_all=ignore
keybind = tweb/unconsumed:super+shift+catch_all=ignore
keybind = tweb/unconsumed:super+alt+catch_all=ignore
keybind = tweb/unconsumed:super+ctrl+catch_all=ignore
keybind = tweb/unconsumed:super+shift+alt+catch_all=ignore
keybind = tweb/unconsumed:super+shift+ctrl+catch_all=ignore
keybind = tweb/unconsumed:super+alt+ctrl+catch_all=ignore
keybind = tweb/unconsumed:super+shift+alt+ctrl+catch_all=ignore
"#;

const TMUX_MANAGED_BASE: &str = r#"# Managed by `tweb doctor --fix`; edit the main tmux config instead.
set-option -g allow-passthrough all
set-option -g mouse on
set-option -s extended-keys on
set-option -s extended-keys-format csi-u
"#;

/// Cmd combinations forwarded to the page, as (Ghostty trigger, private code,
/// tmux user-keys slot).
///
/// Ghostty emits no PTY encoding at all for Cmd — a key probe showed Cmd-K and
/// Cmd-A producing zero bytes in plain, modifyOtherKeys=2 and Kitty-flag modes
/// alike — so the key has to be carried as an explicit private sequence, the
/// way Ctrl-; already is. Three things must line up for one to arrive:
///
///   1. a `<trigger>=text:` binding that emits the sequence;
///   2. a tmux `user-keys` entry, or tmux re-encodes the leading ESC of a
///      sequence it does not recognise (ESC[5199~ arrived as ESC[91;3u5199~);
///   3. a matching entry in the engine's CMD_PRIVATE_KEYS, which turns the code
///      back into a real Cmd key event.
///
/// Codes start at 5020 and slots at 120 to stay clear of the existing 5001-5010
/// shortcuts and the tmux-chrome bridge on slots 100/101.
///
/// These are bound at the Ghostty root, not inside the tweb key table. A table
/// can only be entered by pressing its binding — Ghostty exposes no action, IPC
/// or escape sequence to activate one — so a table-scoped binding leaves a
/// freshly opened pane unable to deliver Cmd until the user presses Ctrl-;
/// first. Binding at the root costs the key everywhere in Ghostty, which is
/// why the list is kept to shortcuts whose terminal meaning is expendable:
/// Cmd-K only clears the screen, and Ctrl-L still does that.
///
/// Cmd-C/V/X are deliberately absent. They would matter most while typing
/// (mode `E`), but taking them at the root removes terminal copy and paste from
/// every Ghostty surface, which is too much to pay — inside a page, selection
/// copy is still reachable through the visual mode shortcuts.
const CMD_PASSTHROUGH_KEYS: &[(&str, u16, u16)] = &[("super+k", 5020, 120)];

fn cmd_passthrough_ghostty_bindings() -> String {
    CMD_PASSTHROUGH_KEYS
        .iter()
        .map(|(trigger, code, _)| format!("keybind = {trigger}=text:\\x1b[{code}~\n"))
        .collect()
}

fn cmd_passthrough_tmux_config() -> String {
    let mut config = String::new();
    for (_, code, slot) in CMD_PASSTHROUGH_KEYS {
        // "\\e" is the spelling tmux expands in a config file; the running
        // server is fed a real ESC byte instead, further down.
        config.push_str(&format!(
            "set-option -s user-keys[{slot}] \"\\e[{code}~\"\n"
        ));
    }
    for (_, code, slot) in CMD_PASSTHROUGH_KEYS {
        let hex = private_sequence_hex(*code);
        // Both tables: root covers ordinary panes and Shortcuts mode, tweb-pass
        // covers passthrough and must re-arm itself like its other bindings.
        config.push_str(&format!("bind-key -T root User{slot} send-keys -H {hex}\n"));
        config.push_str(&format!(
            "bind-key -T tweb-pass User{slot} send-keys -H {hex} \\; switch-client -T tweb-pass\n"
        ));
    }
    config
}

fn run_tmux(args: &[&str]) -> bool {
    Command::new("tmux")
        .args(args)
        .status()
        .is_ok_and(|status| status.success())
}

fn ghostty_managed_config() -> String {
    format!(
        "{GHOSTTY_MANAGED_BASE}\n# Cmd combinations Ghostty never encodes on its own.\n{}",
        cmd_passthrough_ghostty_bindings()
    )
}

fn tmux_managed_config() -> String {
    format!(
        "{TMUX_MANAGED_BASE}\n# Teach tmux the private sequences Ghostty emits for Cmd keys.\n{}",
        cmd_passthrough_tmux_config()
    )
}

/// `ESC [ <code> ~` as the space-separated hex bytes `send-keys -H` expects.
fn private_sequence_hex(code: u16) -> String {
    let mut bytes = vec!["1b".to_string(), "5b".to_string()];
    bytes.extend(code.to_string().bytes().map(|digit| format!("{digit:02x}")));
    bytes.push("7e".to_string());
    bytes.join(" ")
}

/// 진단 항목 결과.
struct Check {
    name: &'static str,
    status: CheckStatus,
    detail: String,
}

#[derive(Clone, Copy)]
enum CheckStatus {
    Ok,
    Warn,
    Fail,
}

impl CheckStatus {
    fn label(self) -> &'static str {
        match self {
            CheckStatus::Ok => "OK",
            CheckStatus::Warn => "WARN",
            CheckStatus::Fail => "FAIL",
        }
    }
}

/// doctor 실행. `fix`가 false면 어떤 설정도 변경하지 않는다.
pub async fn run(fix: bool) -> Result<()> {
    println!("tweb doctor — environment diagnosis\n");

    if fix {
        println!("Applying managed terminal configuration:");
        for result in [apply_tmux_fix(), apply_ghostty_fix()] {
            match result {
                Ok(message) => println!("  [ FIX] {message}"),
                Err(error) => println!("  [WARN] {error:#}"),
            }
        }
        println!();
    }

    let checks = vec![
        check_terminal(),
        check_tmux(),
        check_tmux_session(),
        check_tmux_version(),
        check_tmux_passthrough(),
        check_tmux_extended_keys(),
        check_tmux_mouse(),
        check_ghostty_version(),
        check_ghostty_cmd_passthrough(),
        check_pixel_size_query(),
    ];

    for check in &checks {
        println!(
            "  [{:>4}] {}: {}",
            check.status.label(),
            check.name,
            check.detail
        );
    }

    let ok = checks
        .iter()
        .filter(|check| matches!(check.status, CheckStatus::Ok))
        .count();
    let warn = checks
        .iter()
        .filter(|check| matches!(check.status, CheckStatus::Warn))
        .count();
    let fail = checks
        .iter()
        .filter(|check| matches!(check.status, CheckStatus::Fail))
        .count();
    println!("\n  {ok} OK, {warn} WARN, {fail} FAIL");

    if !fix && checks.iter().any(needs_fix) {
        println!("\n  Run `tweb doctor --fix` to install managed Ghostty/tmux settings.");
    }
    if fail > 0 {
        println!(
            "\n  tweb requires tmux 3.3+ with passthrough and a Kitty graphics capable terminal."
        );
    }
    Ok(())
}

fn needs_fix(check: &Check) -> bool {
    matches!(
        check.name,
        "tmux allow-passthrough" | "tmux extended keys" | "tmux mouse" | "Ghostty Cmd passthrough"
    ) && !matches!(check.status, CheckStatus::Ok)
}

fn check_terminal() -> Check {
    let term = std::env::var("TERM").unwrap_or_default();
    let term_program = std::env::var("TERM_PROGRAM").unwrap_or_default();
    let detail = if term_program.is_empty() {
        format!("TERM={term} (TERM_PROGRAM unset)")
    } else {
        format!("TERM={term}, TERM_PROGRAM={term_program}")
    };
    let status = if term_program.to_ascii_lowercase().contains("ghostty")
        || term_program.contains("WezTerm")
        || term == "xterm-kitty"
    {
        CheckStatus::Ok
    } else if term.is_empty() {
        CheckStatus::Fail
    } else {
        CheckStatus::Warn
    };
    Check {
        name: "terminal",
        status,
        detail,
    }
}

fn check_tmux() -> Check {
    match command_output("tmux", &["-V"]) {
        Some(version) => Check {
            name: "tmux",
            status: CheckStatus::Ok,
            detail: version,
        },
        None => Check {
            name: "tmux",
            status: CheckStatus::Fail,
            detail: "tmux not found".to_string(),
        },
    }
}

fn check_tmux_session() -> Check {
    match std::env::var("TMUX") {
        Ok(value) => Check {
            name: "tmux session",
            status: CheckStatus::Ok,
            detail: format!("attached: {}", value.split(',').next().unwrap_or("?")),
        },
        Err(_) => Check {
            name: "tmux session",
            status: CheckStatus::Warn,
            detail: "not inside tmux (TMUX unset)".to_string(),
        },
    }
}

fn check_tmux_version() -> Check {
    let Some(version) = command_output("tmux", &["-V"]) else {
        return Check {
            name: "tmux version",
            status: CheckStatus::Fail,
            detail: "cannot determine".to_string(),
        };
    };
    let parsed = version
        .strip_prefix("tmux ")
        .unwrap_or("")
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse::<u32>()
                .unwrap_or(0)
        })
        .collect::<Vec<_>>();
    let major = parsed.first().copied().unwrap_or(0);
    let minor = parsed.get(1).copied().unwrap_or(0);
    let supported = major > 3 || (major == 3 && minor >= 3);
    Check {
        name: "tmux version",
        status: if supported {
            CheckStatus::Ok
        } else {
            CheckStatus::Fail
        },
        detail: format!("{version} (3.3+ required)"),
    }
}

fn check_tmux_passthrough() -> Check {
    let value = tmux_option(&["show-options", "-g", "allow-passthrough"]);
    let enabled = value
        .as_deref()
        .is_some_and(|option| option.contains("all") || option.ends_with(" on"));
    Check {
        name: "tmux allow-passthrough",
        status: if enabled {
            CheckStatus::Ok
        } else {
            CheckStatus::Warn
        },
        detail: value.unwrap_or_else(|| "not set".to_string()),
    }
}

fn check_tmux_extended_keys() -> Check {
    let enabled = tmux_option(&["show-options", "-s", "extended-keys"]);
    let format = tmux_option(&["show-options", "-s", "extended-keys-format"]);
    let ok = enabled
        .as_deref()
        .is_some_and(|value| value.ends_with(" on"))
        && format
            .as_deref()
            .is_some_and(|value| value.ends_with(" csi-u"));
    Check {
        name: "tmux extended keys",
        status: if ok {
            CheckStatus::Ok
        } else {
            CheckStatus::Warn
        },
        detail: format!(
            "{}, {}",
            enabled.unwrap_or_else(|| "extended-keys unset".to_string()),
            format.unwrap_or_else(|| "extended-keys-format unset".to_string())
        ),
    }
}

fn check_tmux_mouse() -> Check {
    let value = tmux_option(&["show-options", "-g", "mouse"]);
    let enabled = value
        .as_deref()
        .is_some_and(|option| option.ends_with(" on"));
    Check {
        name: "tmux mouse",
        status: if enabled {
            CheckStatus::Ok
        } else {
            CheckStatus::Warn
        },
        detail: value.unwrap_or_else(|| "not set".to_string()),
    }
}

fn check_ghostty_version() -> Check {
    let Some(version) = command_output("ghostty", &["+version"]) else {
        return Check {
            name: "Ghostty version",
            status: CheckStatus::Warn,
            detail: "ghostty command not found (skip if another terminal is used)".to_string(),
        };
    };
    let supported = ghostty_version_supported(&version);
    Check {
        name: "Ghostty version",
        status: if supported {
            CheckStatus::Ok
        } else {
            CheckStatus::Warn
        },
        detail: format!(
            "{} ({})",
            version.lines().next().unwrap_or("Ghostty"),
            if supported {
                "1.3+ key tables available"
            } else {
                "upgrade to 1.3+ for managed Cmd passthrough"
            }
        ),
    }
}

fn check_ghostty_cmd_passthrough() -> Check {
    let path = ghostty_config_path();
    let managed_path = managed_config_dir().join("ghostty.conf");
    let content = fs::read_to_string(&path).unwrap_or_default();
    let expected = ghostty_include_block(&managed_path);
    let managed = fs::read_to_string(&managed_path).unwrap_or_default();
    let installed = managed_block(&content, GHOSTTY_BEGIN, GHOSTTY_END)
        .is_some_and(|block| block.trim() == expected.trim())
        && managed == ghostty_managed_config()
        && !content.lines().any(is_legacy_ghostty_binding);
    let conflict = command_output("ghostty", &["+show-config"])
        .is_some_and(|config| config.contains("keybind = super+k=clear_screen"));
    Check {
        name: "Ghostty Cmd passthrough",
        status: if installed {
            CheckStatus::Ok
        } else {
            CheckStatus::Warn
        },
        detail: if installed {
            format!("managed config included from {}", managed_path.display())
        } else if conflict {
            format!(
                "Cmd-K and other app shortcuts are consumed before PTY; configure {}",
                path.display()
            )
        } else {
            format!("managed include not installed in {}", path.display())
        },
    }
}

fn check_pixel_size_query() -> Check {
    Check {
        name: "pixel size query (CSI 14t)",
        status: CheckStatus::Warn,
        detail: "not yet probed (TODO)".to_string(),
    }
}

fn apply_tmux_fix() -> Result<String> {
    let path = tmux_config_path();
    let managed_path = managed_config_dir().join("tmux.conf");
    let include = tmux_include_block(&managed_path);
    let managed_original = fs::read(&managed_path).ok();
    let managed_changed = write_managed_config(&managed_path, &tmux_managed_config(), None)?;
    let main_changed = match install_managed_block(
        &path,
        TMUX_BEGIN,
        TMUX_END,
        &include,
        Some(migrate_legacy_tmux_config),
        None,
    ) {
        Ok(changed) => changed,
        Err(error) => {
            if managed_changed {
                restore_managed_config(&managed_path, managed_original)?;
            }
            return Err(error);
        }
    };

    let mut live = true;
    for args in [
        &["set-option", "-g", "allow-passthrough", "all"][..],
        &["set-option", "-g", "mouse", "on"][..],
        &["set-option", "-s", "extended-keys", "on"][..],
        &["set-option", "-s", "extended-keys-format", "csi-u"][..],
    ] {
        live &= Command::new("tmux")
            .args(args)
            .status()
            .is_ok_and(|status| status.success());
    }
    // The config file only takes effect on a fresh server, and the Cmd keys are
    // useless until tmux knows them, so apply them to the running one as well.
    for (_, code, slot) in CMD_PASSTHROUGH_KEYS {
        // A real ESC byte, not the "\033" spelling: tmux expands that escape
        // when parsing a config file but stores a CLI argument verbatim, so the
        // literal backslash form never matches the incoming sequence.
        let sequence = format!("\u{1b}[{code}~");
        live &= run_tmux(&["set-option", "-s", &format!("user-keys[{slot}]"), &sequence]);
        let hex = private_sequence_hex(*code);
        let mut root = vec!["bind-key", "-T", "root"];
        let user_key = format!("User{slot}");
        root.push(&user_key);
        root.extend(["send-keys", "-H"]);
        let bytes: Vec<&str> = hex.split(' ').collect();
        root.extend(bytes.iter().copied());
        live &= run_tmux(&root);

        let mut pass = vec!["bind-key", "-T", "tweb-pass", &user_key, "send-keys", "-H"];
        pass.extend(bytes.iter().copied());
        // Escaped so tmux treats it as a command separator rather than an
        // argument to send-keys.
        pass.extend(["\\;", "switch-client", "-T", "tweb-pass"]);
        live &= run_tmux(&pass);
    }

    Ok(format!(
        "tmux managed include {} from {}{}",
        if managed_changed || main_changed {
            "installed"
        } else {
            "already current"
        },
        managed_path.display(),
        if live {
            " and applied to the running server"
        } else {
            " (no running server to update)"
        }
    ))
}

/// Drops managed blocks from every Ghostty config we are *not* installing into.
///
/// Both candidate locations can exist on one machine, and Ghostty loads only
/// one of them — but if that one includes our managed file while the other
/// still holds an old inline block, the stale copy is parsed too and its later
/// keybind wins. That is how an obsolete `unconsumed:ctrl+semicolon` kept
/// overriding the current toggle.
fn remove_stale_ghostty_blocks(active: &Path) -> Result<bool> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let xdg = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let candidates = [
        xdg.join("ghostty/config"),
        home.join("Library/Application Support/com.mitchellh.ghostty/config"),
    ];

    let mut removed = false;
    for candidate in candidates {
        if candidate == active || !candidate.exists() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&candidate) else {
            continue;
        };
        let Some(block) = managed_block(&content, GHOSTTY_BEGIN, GHOSTTY_END) else {
            continue;
        };
        let stripped = content.replace(block, "");
        let backup = backup_path(&candidate);
        fs::copy(&candidate, &backup).with_context(|| format!("backup {}", candidate.display()))?;
        fs::write(&candidate, stripped.trim_end().to_string() + "\n")
            .with_context(|| format!("rewrite {}", candidate.display()))?;
        removed = true;
    }
    Ok(removed)
}

fn apply_ghostty_fix() -> Result<String> {
    let version = command_output("ghostty", &["+version"])
        .context("ghostty command not found; install Ghostty 1.3+ or skip this fix")?;
    if !ghostty_version_supported(&version) {
        bail!("Ghostty 1.3+ is required for surface-local key tables");
    }
    let path = ghostty_config_path();
    let managed_path = managed_config_dir().join("ghostty.conf");
    // Ghostty reads one config, but a machine can carry both candidate paths —
    // and a managed block left in the one we are not installing into silently
    // overrides ours, because a later keybind wins over an earlier one. Strip
    // the stale block instead of leaving two definitions of Ctrl-;.
    let stale_removed = remove_stale_ghostty_blocks(&path)?;
    let include = ghostty_include_block(&managed_path);
    let managed_original = fs::read(&managed_path).ok();
    let managed_changed = write_managed_config(
        &managed_path,
        &ghostty_managed_config(),
        Some(validate_ghostty_config),
    )?;
    let main_changed = match install_managed_block(
        &path,
        GHOSTTY_BEGIN,
        GHOSTTY_END,
        &include,
        Some(migrate_legacy_ghostty_config),
        Some(validate_ghostty_config),
    ) {
        Ok(changed) => changed,
        Err(error) => {
            if managed_changed {
                restore_managed_config(&managed_path, managed_original)?;
            }
            return Err(error);
        }
    };
    let changed = managed_changed || main_changed || stale_removed;
    let reload = if changed && std::env::var_os("TWEB_GHOSTTY_CONFIG").is_none() {
        if reload_ghostty_config() {
            " and reloaded in running Ghostty processes"
        } else {
            " (no running Ghostty process reloaded; use Cmd-Shift-,)"
        }
    } else {
        ""
    };
    Ok(format!(
        "Ghostty managed include {} from {}{}{}",
        if changed {
            "installed"
        } else {
            "already current"
        },
        managed_path.display(),
        if stale_removed {
            ", stale block removed from the unused config"
        } else {
            ""
        },
        reload
    ))
}

fn reload_ghostty_config() -> bool {
    Command::new("pkill")
        .args(["-USR2", "-x", "ghostty"])
        .status()
        .is_ok_and(|status| status.success())
}

fn ghostty_config_path() -> PathBuf {
    if let Some(path) = std::env::var_os("TWEB_GHOSTTY_CONFIG") {
        return PathBuf::from(path);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let xdg = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    select_ghostty_config_path(&home, &xdg, cfg!(target_os = "macos"))
}

fn select_ghostty_config_path(home: &Path, xdg: &Path, prefer_macos: bool) -> PathBuf {
    let xdg_path = xdg.join("ghostty/config");
    let macos_path = home.join("Library/Application Support/com.mitchellh.ghostty/config");
    let macos_exists = macos_path.exists();
    select_ghostty_config_candidate(xdg_path, macos_path, prefer_macos, macos_exists)
}

fn select_ghostty_config_candidate(
    xdg_path: PathBuf,
    macos_path: PathBuf,
    prefer_macos: bool,
    macos_exists: bool,
) -> PathBuf {
    if prefer_macos && macos_exists {
        macos_path
    } else {
        xdg_path
    }
}

fn tmux_config_path() -> PathBuf {
    if let Some(path) = std::env::var_os("TWEB_TMUX_CONFIG") {
        return PathBuf::from(path);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let conventional = home.join(".tmux.conf");
    let xdg = home.join(".config/tmux/tmux.conf");
    if conventional.exists() || !xdg.exists() {
        conventional
    } else {
        xdg
    }
}

fn managed_config_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("TWEB_CONFIG_DIR") {
        return PathBuf::from(path);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
        .join("tweb")
}

fn ghostty_include_block(path: &Path) -> String {
    format!(
        "{GHOSTTY_BEGIN}\nconfig-file = {}\n{GHOSTTY_END}",
        path.display()
    )
}

fn tmux_include_block(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("{TMUX_BEGIN}\nsource-file -q \"{escaped}\"\n{TMUX_END}")
}

fn is_legacy_ghostty_binding(line: &str) -> bool {
    let line = line.trim();
    [
        LEGACY_GHOSTTY_TOGGLE,
        r"keybind = ctrl+comma=text:\x1b[5009~",
        r"keybind = ctrl+shift+semicolon=text:\x1b[5010~",
        r"keybind = ctrl+equal=text:\x1b[5002~",
        r"keybind = ctrl+shift+equal=text:\x1b[5007~",
        r"keybind = ctrl+minus=text:\x1b[5003~",
        r"keybind = ctrl+zero=text:\x1b[5004~",
        r"keybind = shift+enter=text:\x1b[5008~",
        // The unconsumed:-based Ctrl-; toggle never emitted the 5001 sequence,
        // so the engine toggle depended on Ctrl-; surviving as CSI-u through
        // tmux — unreliable across keyboard encodings. Migrate to chain=.
        r"keybind = unconsumed:ctrl+semicolon=activate_key_table:tweb",
        r"keybind = tweb/unconsumed:ctrl+semicolon=deactivate_key_table",
    ]
    .iter()
    .any(|binding| line.eq_ignore_ascii_case(binding))
}

fn migrate_legacy_ghostty_config(content: &str) -> String {
    content
        .split_inclusive('\n')
        .filter(|line| !is_legacy_ghostty_binding(line))
        .collect()
}

fn migrate_legacy_tmux_config(content: &str) -> String {
    let mut migrated = content.to_string();
    while let Some(start) = migrated.find(LEGACY_TMUX_BEGIN) {
        let Some(relative_end) = migrated[start..].find(LEGACY_TMUX_END) else {
            break;
        };
        let finish = start + relative_end + LEGACY_TMUX_END.len();
        migrated.replace_range(start..finish, "");
    }
    migrated
}

fn restore_managed_config(path: &Path, original: Option<Vec<u8>>) -> Result<()> {
    match original {
        Some(content) => fs::write(path, content)
            .with_context(|| format!("restore managed config {}", path.display())),
        None if path.exists() => fs::remove_file(path)
            .with_context(|| format!("remove managed config {}", path.display())),
        None => Ok(()),
    }
}

fn write_managed_config(
    path: &Path,
    content: &str,
    validator: Option<fn(&Path) -> Result<()>>,
) -> Result<bool> {
    if fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(false);
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .with_context(|| format!("create config directory {}", parent.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let temporary = parent.join(format!(".{file_name}.tweb.tmp-{}", std::process::id()));
    {
        let mut file = fs::File::create(&temporary)
            .with_context(|| format!("create {}", temporary.display()))?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }
    if let Ok(metadata) = fs::metadata(path) {
        fs::set_permissions(&temporary, metadata.permissions())?;
    }
    if let Some(validate) = validator {
        if let Err(error) = validate(&temporary) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    }
    if path.exists() {
        let backup = backup_path(path);
        fs::copy(path, &backup)
            .with_context(|| format!("backup {} to {}", path.display(), backup.display()))?;
    }
    fs::rename(&temporary, path).with_context(|| format!("replace {}", path.display()))?;
    Ok(true)
}

fn install_managed_block(
    path: &Path,
    begin: &str,
    end: &str,
    block: &str,
    preprocess: Option<fn(&str) -> String>,
    validator: Option<fn(&Path) -> Result<()>>,
) -> Result<bool> {
    let original = fs::read_to_string(path).unwrap_or_default();
    let migrated = preprocess.map_or_else(|| original.clone(), |process| process(&original));
    let updated = upsert_managed_block(&migrated, begin, end, block)?;
    if original == updated {
        return Ok(false);
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .with_context(|| format!("create config directory {}", parent.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let temporary = parent.join(format!(".{file_name}.tweb.tmp-{}", std::process::id()));
    {
        let mut file = fs::File::create(&temporary)
            .with_context(|| format!("create {}", temporary.display()))?;
        file.write_all(updated.as_bytes())?;
        file.sync_all()?;
    }
    if let Ok(metadata) = fs::metadata(path) {
        fs::set_permissions(&temporary, metadata.permissions())?;
    }
    if let Some(validate) = validator {
        if let Err(error) = validate(&temporary) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    }
    if path.exists() {
        let backup = backup_path(path);
        fs::copy(path, &backup)
            .with_context(|| format!("backup {} to {}", path.display(), backup.display()))?;
    }
    fs::rename(&temporary, path).with_context(|| format!("replace {}", path.display()))?;
    Ok(true)
}

fn upsert_managed_block(content: &str, begin: &str, end: &str, block: &str) -> Result<String> {
    let replacement = block.trim_end();
    let begin_count = content.matches(begin).count();
    let end_count = content.matches(end).count();
    if begin_count > 1 || end_count > 1 {
        bail!("managed block markers are duplicated; remove stale blocks manually");
    }

    if let Some(start) = content.find(begin) {
        let Some(relative_end) = content[start..].find(end) else {
            bail!("managed block starts with {begin:?} but has no end marker");
        };
        let finish = start + relative_end + end.len();
        let mut updated = String::with_capacity(content.len() + replacement.len());
        updated.push_str(&content[..start]);
        updated.push_str(replacement);
        updated.push_str(&content[finish..]);
        return Ok(updated);
    }
    if content.contains(end) {
        bail!("managed block has end marker {end:?} but no start marker");
    }

    if content.trim().is_empty() {
        Ok(format!("{replacement}\n"))
    } else {
        Ok(format!("{}\n\n{replacement}\n", content.trim_end()))
    }
}

fn managed_block<'a>(content: &'a str, begin: &str, end: &str) -> Option<&'a str> {
    let start = content.find(begin)?;
    let finish = start + content[start..].find(end)? + end.len();
    Some(&content[start..finish])
}

fn validate_ghostty_config(path: &Path) -> Result<()> {
    let status = Command::new("ghostty")
        .arg("+validate-config")
        .arg(format!("--config-file={}", path.display()))
        .status()
        .context("run ghostty config validator")?;
    if !status.success() {
        bail!("Ghostty rejected the candidate config; original file was not changed");
    }
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    path.with_file_name(format!("{name}.tweb-backup-{stamp}-{}", std::process::id()))
}

fn ghostty_version_supported(value: &str) -> bool {
    let version = value.lines().find_map(|line| {
        let line = line.trim().trim_start_matches("- ");
        line.strip_prefix("Ghostty ")
            .or_else(|| line.strip_prefix("version: "))
    });
    let Some(version) = version else {
        return false;
    };
    let mut parts = version.split('.').filter_map(|part| {
        part.chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse::<u32>()
            .ok()
    });
    matches!((parts.next(), parts.next()), (Some(major), Some(minor)) if major > 1 || (major == 1 && minor >= 3))
}

fn command_output(command: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(command).args(args).output().ok()?;
    output.status.success().then(|| {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stdout.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        }
    })
}

fn tmux_option(args: &[&str]) -> Option<String> {
    command_output("tmux", args)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{
        cmd_passthrough_ghostty_bindings, cmd_passthrough_tmux_config, ghostty_include_block,
        ghostty_managed_config, ghostty_version_supported, managed_block,
        migrate_legacy_ghostty_config, migrate_legacy_tmux_config, private_sequence_hex,
        select_ghostty_config_candidate, tmux_include_block, tmux_managed_config,
        upsert_managed_block, CMD_PASSTHROUGH_KEYS, GHOSTTY_BEGIN, GHOSTTY_END, LEGACY_TMUX_BEGIN,
        LEGACY_TMUX_END, TMUX_BEGIN, TMUX_END,
    };

    fn ghostty_include() -> String {
        ghostty_include_block(Path::new("/home/user/.config/tweb/ghostty.conf"))
    }

    #[test]
    fn private_sequence_hex_matches_the_escape_bytes() {
        assert_eq!(private_sequence_hex(5020), "1b 5b 35 30 32 30 7e");
    }

    #[test]
    fn every_cmd_key_is_configured_on_all_three_layers() {
        // A Cmd key only arrives when Ghostty emits it, tmux recognises it, and
        // the engine maps it back — so a missing layer is a silent no-op.
        let ghostty = ghostty_managed_config();
        let tmux = tmux_managed_config();
        let engine = include_str!("../../../electron/main.cjs");
        for (trigger, code, slot) in CMD_PASSTHROUGH_KEYS {
            assert!(
                ghostty.contains(&format!("keybind = {trigger}=text:\\x1b[{code}~")),
                "{trigger} missing its Ghostty binding"
            );
            assert!(
                tmux.contains(&format!("user-keys[{slot}] \"\\e[{code}~\"")),
                "{trigger} missing its tmux user-key"
            );
            assert!(
                tmux.contains(&format!("bind-key -T tweb-pass User{slot}")),
                "{trigger} missing its passthrough binding"
            );
            assert!(
                engine.contains(&format!("[{code}, ")),
                "{trigger} missing from the engine CMD_PRIVATE_KEYS table"
            );
            // The engine parses private sequences with a bounded regex, and a
            // code outside its range is dropped before any table is consulted —
            // which is exactly how 5020 went missing while arriving intact.
            assert!(
                engine_parses_private_code(*code),
                "the engine's private-sequence regex does not cover {code}"
            );
        }
    }

    /// Mirrors the `50(?:0[1-9]|1[0-2]|[2-9][0-9])` alternation in main.cjs.
    fn engine_parses_private_code(code: u16) -> bool {
        let text = code.to_string();
        let Some(tail) = text.strip_prefix("50") else {
            return false;
        };
        let digits: Vec<char> = tail.chars().collect();
        let [first, second] = digits[..] else {
            return false;
        };
        match first {
            '0' => ('1'..='9').contains(&second),
            '1' => ('0'..='2').contains(&second),
            '2'..='9' => second.is_ascii_digit(),
            _ => false,
        }
    }

    #[test]
    fn cmd_passthrough_spares_the_editing_shortcuts() {
        // Root bindings take the key from every Ghostty surface, so the list has
        // to stay narrow. Claiming Cmd-C/V/X here would remove terminal copy and
        // paste everywhere — that regression already happened once.
        for (trigger, _, _) in CMD_PASSTHROUGH_KEYS {
            assert!(
                !matches!(*trigger, "super+c" | "super+v" | "super+x"),
                "{trigger} would cost terminal copy/paste across all of Ghostty"
            );
        }
        for line in cmd_passthrough_ghostty_bindings().lines() {
            // Table-scoped bindings cannot work: a key table is only enterable by
            // pressing its binding, so a new pane would deliver nothing until the
            // user pressed Ctrl-; first.
            assert!(
                !line.starts_with("keybind = tweb/"),
                "{line} is table-scoped and would not reach a fresh pane"
            );
        }
        assert!(cmd_passthrough_tmux_config().contains("switch-client -T tweb-pass"));
    }

    #[test]
    fn macos_config_wins_when_both_ghostty_locations_exist() {
        let xdg = PathBuf::from("/home/user/.config/ghostty/config");
        let macos =
            PathBuf::from("/home/user/Library/Application Support/com.mitchellh.ghostty/config");
        assert_eq!(
            select_ghostty_config_candidate(xdg.clone(), macos.clone(), true, true),
            macos
        );
        assert_eq!(
            select_ghostty_config_candidate(xdg.clone(), PathBuf::from("unused"), true, false),
            xdg
        );
    }

    #[test]
    fn managed_include_is_added_without_rewriting_user_config() {
        let original = "font-size = 13\nkeybind = super+k=clear_screen\n";
        let include = ghostty_include();
        let updated = upsert_managed_block(original, GHOSTTY_BEGIN, GHOSTTY_END, &include).unwrap();
        assert!(updated.starts_with(original.trim_end()));
        assert_eq!(
            managed_block(&updated, GHOSTTY_BEGIN, GHOSTTY_END)
                .unwrap()
                .trim(),
            include.trim()
        );
    }

    #[test]
    fn managed_include_update_is_idempotent() {
        let include = ghostty_include();
        let once = upsert_managed_block("", GHOSTTY_BEGIN, GHOSTTY_END, &include).unwrap();
        let twice = upsert_managed_block(&once, GHOSTTY_BEGIN, GHOSTTY_END, &include).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn replacing_a_middle_block_preserves_position_and_surrounding_lines() {
        let original =
            format!("font-size = 13\n\n{GHOSTTY_BEGIN}\nstale\n{GHOSTTY_END}\ntheme = Arthur\n");
        let updated =
            upsert_managed_block(&original, GHOSTTY_BEGIN, GHOSTTY_END, &ghostty_include())
                .unwrap();
        let include_position = updated.find(GHOSTTY_BEGIN).unwrap();
        assert!(include_position > updated.find("font-size = 13").unwrap());
        assert!(include_position < updated.find("theme = Arthur").unwrap());
        assert!(updated.ends_with("theme = Arthur\n"));
    }

    #[test]
    fn malformed_or_duplicate_managed_blocks_are_refused() {
        let include = ghostty_include();
        let missing_end = upsert_managed_block(GHOSTTY_BEGIN, GHOSTTY_BEGIN, GHOSTTY_END, &include);
        assert!(missing_end.is_err());
        let duplicate = format!("{include}\n{include}\n");
        assert!(upsert_managed_block(&duplicate, GHOSTTY_BEGIN, GHOSTTY_END, &include).is_err());
    }

    #[test]
    fn ghostty_migration_moves_only_tweb_bindings() {
        let original = concat!(
            "font-size = 13\n",
            "  KEYBIND = CTRL+SEMICOLON=TEXT:\\X1B[5001~  \n",
            "keybind = ctrl+equal=text:\\x1B[5002~\n",
            "keybind = ctrl+semicolon=text:\\x1b[5999~\n",
            "theme = Arthur\n",
        );
        assert_eq!(
            migrate_legacy_ghostty_config(original),
            concat!(
                "font-size = 13\n",
                "keybind = ctrl+semicolon=text:\\x1b[5999~\n",
                "theme = Arthur\n",
            )
        );
    }

    #[test]
    fn ghostty_migration_handles_final_line_without_newline() {
        assert_eq!(
            migrate_legacy_ghostty_config(
                "font-size = 13\nkeybind = ctrl+semicolon=text:\\x1b[5001~"
            ),
            "font-size = 13\n"
        );
    }

    #[test]
    fn tmux_migration_removes_duplicates_but_keeps_tmux_chrome() {
        let legacy = format!(
            "{LEGACY_TMUX_BEGIN}\nset -s user-keys[110] \"\\e[5001~\"\n{LEGACY_TMUX_END}\n"
        );
        let original = format!(
            "set-option -g mouse on\nset-option -gq allow-passthrough on\n\
             {legacy}{legacy}\
             # tmux-chrome tab group bridge\nset -s user-keys[100] \"\\e[5005~\"\n\
             set -s user-keys[101] \"\\e[5006~\"\n\
             {TMUX_BEGIN}\nset-option -g allow-passthrough all\n{TMUX_END}\n"
        );
        let migrated = migrate_legacy_tmux_config(&original);
        assert!(!migrated.contains(LEGACY_TMUX_BEGIN));
        assert!(migrated.contains("allow-passthrough on"));
        assert!(migrated.contains("set-option -g mouse on"));
        assert!(migrated.contains("user-keys[100]"));
        assert!(migrated.contains("user-keys[101]"));
        assert!(migrated.contains("tmux-chrome tab group bridge"));
    }

    #[test]
    fn tmux_migration_preserves_unmanaged_terminal_options() {
        let original = concat!(
            "set-option -g mouse on\n",
            "set-option -gq allow-passthrough on\n",
            "set-option -s extended-keys on\n",
        );
        assert_eq!(migrate_legacy_tmux_config(original), original);
    }

    #[test]
    fn include_blocks_reference_separate_managed_files() {
        let ghostty = ghostty_include();
        assert!(ghostty.contains("config-file = /home/user/.config/tweb/ghostty.conf"));
        let tmux = tmux_include_block(Path::new("/home/user/.config/tweb/tmux.conf"));
        assert_eq!(
            tmux,
            format!(
                "{TMUX_BEGIN}\nsource-file -q \"/home/user/.config/tweb/tmux.conf\"\n{TMUX_END}"
            )
        );
    }

    #[test]
    fn ghostty_key_tables_require_version_1_3() {
        assert!(!ghostty_version_supported("Ghostty 1.2.0"));
        assert!(ghostty_version_supported("Ghostty 1.3.1\nVersion"));
        assert!(ghostty_version_supported("  - version: 2.0.0"));
    }
}
