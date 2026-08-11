//! `tweb doctor` — terminal/tmux/GPU/extension capability 진단과 안전한 설정.
//!
//! `--fix`는 marker로 둘러싼 TWeb 관리 block만 갱신하고 기존 파일을 backup한다.

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

const GHOSTTY_BLOCK: &str = r#"# >>> tweb doctor managed passthrough >>>
# Ctrl-; toggles TWeb and a surface-local Cmd forwarding table together.
keybind = ctrl+semicolon=activate_key_table:tweb
keybind = chain=text:\x1b[5001~
keybind = tweb/ctrl+semicolon=deactivate_key_table
keybind = chain=text:\x1b[5001~
# Shadow Ghostty application shortcuts while preserving terminal encoding.
keybind = tweb/unconsumed:super+catch_all=ignore
keybind = tweb/unconsumed:super+shift+catch_all=ignore
keybind = tweb/unconsumed:super+alt+catch_all=ignore
keybind = tweb/unconsumed:super+ctrl+catch_all=ignore
keybind = tweb/unconsumed:super+shift+alt+catch_all=ignore
keybind = tweb/unconsumed:super+shift+ctrl+catch_all=ignore
keybind = tweb/unconsumed:super+alt+ctrl+catch_all=ignore
keybind = tweb/unconsumed:super+shift+alt+ctrl+catch_all=ignore
# <<< tweb doctor managed passthrough <<<"#;

const TMUX_BLOCK: &str = r#"# >>> tweb doctor managed terminal options >>>
set-option -g allow-passthrough all
set-option -g mouse on
set-option -s extended-keys on
set-option -s extended-keys-format csi-u
# <<< tweb doctor managed terminal options <<<"#;

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
    if fix {
        println!("\n  Reload Ghostty config (Cmd-Shift-,) before testing Cmd shortcuts.");
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
    let content = fs::read_to_string(&path).unwrap_or_default();
    let installed = managed_block(&content, GHOSTTY_BEGIN, GHOSTTY_END)
        .is_some_and(|block| block.trim() == GHOSTTY_BLOCK.trim());
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
            format!("managed surface-local key table: {}", path.display())
        } else if conflict {
            format!(
                "Cmd-K and other app shortcuts are consumed before PTY; configure {}",
                path.display()
            )
        } else {
            format!("managed key table not installed: {}", path.display())
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
    let changed = install_managed_block(&path, TMUX_BEGIN, TMUX_END, TMUX_BLOCK, None)?;

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

    Ok(format!(
        "tmux options {} in {}{}",
        if changed {
            "installed"
        } else {
            "already current"
        },
        path.display(),
        if live {
            " and applied to the running server"
        } else {
            " (no running server to update)"
        }
    ))
}

fn apply_ghostty_fix() -> Result<String> {
    let version = command_output("ghostty", &["+version"])
        .context("ghostty command not found; install Ghostty 1.3+ or skip this fix")?;
    if !ghostty_version_supported(&version) {
        bail!("Ghostty 1.3+ is required for surface-local key tables");
    }
    let path = ghostty_config_path();
    let changed = install_managed_block(
        &path,
        GHOSTTY_BEGIN,
        GHOSTTY_END,
        GHOSTTY_BLOCK,
        Some(validate_ghostty_config),
    )?;
    Ok(format!(
        "Ghostty Cmd passthrough {} in {}",
        if changed {
            "installed"
        } else {
            "already current"
        },
        path.display()
    ))
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
    let xdg_path = xdg.join("ghostty/config");
    let macos_path = home.join("Library/Application Support/com.mitchellh.ghostty/config");
    if xdg_path.exists() || !macos_path.exists() {
        xdg_path
    } else {
        macos_path
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

fn install_managed_block(
    path: &Path,
    begin: &str,
    end: &str,
    block: &str,
    validator: Option<fn(&Path) -> Result<()>>,
) -> Result<bool> {
    let original = fs::read_to_string(path).unwrap_or_default();
    let updated = upsert_managed_block(&original, begin, end, block)?;
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

    let mut without = content.trim_end().to_string();
    if let Some(start) = content.find(begin) {
        let Some(relative_end) = content[start..].find(end) else {
            bail!("managed block starts with {begin:?} but has no end marker");
        };
        let finish = start + relative_end + end.len();
        let before = content[..start].trim_end();
        let after = content[finish..].trim_start();
        without = match (before.is_empty(), after.is_empty()) {
            (true, _) => after.to_string(),
            (_, true) => before.to_string(),
            (false, false) => format!("{before}\n{after}"),
        };
    } else if content.contains(end) {
        bail!("managed block has end marker {end:?} but no start marker");
    }

    if without.is_empty() {
        Ok(format!("{replacement}\n"))
    } else {
        Ok(format!("{}\n\n{replacement}\n", without.trim_end()))
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
    use super::{
        ghostty_version_supported, managed_block, upsert_managed_block, GHOSTTY_BEGIN,
        GHOSTTY_BLOCK, GHOSTTY_END,
    };

    #[test]
    fn managed_block_is_added_without_rewriting_user_config() {
        let original = "font-size = 13\nkeybind = super+k=clear_screen\n";
        let updated =
            upsert_managed_block(original, GHOSTTY_BEGIN, GHOSTTY_END, GHOSTTY_BLOCK).unwrap();
        assert!(updated.starts_with(original.trim_end()));
        assert_eq!(
            managed_block(&updated, GHOSTTY_BEGIN, GHOSTTY_END)
                .unwrap()
                .trim(),
            GHOSTTY_BLOCK.trim()
        );
    }

    #[test]
    fn managed_block_update_is_idempotent() {
        let once = upsert_managed_block("", GHOSTTY_BEGIN, GHOSTTY_END, GHOSTTY_BLOCK).unwrap();
        let twice = upsert_managed_block(&once, GHOSTTY_BEGIN, GHOSTTY_END, GHOSTTY_BLOCK).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn replacing_a_middle_block_preserves_surrounding_lines() {
        let original =
            format!("font-size = 13\n\n{GHOSTTY_BEGIN}\nstale\n{GHOSTTY_END}\ntheme = Arthur\n");
        let updated =
            upsert_managed_block(&original, GHOSTTY_BEGIN, GHOSTTY_END, GHOSTTY_BLOCK).unwrap();
        assert!(updated.contains("font-size = 13\ntheme = Arthur\n\n"));
        assert!(!updated.contains("13theme"));
    }

    #[test]
    fn malformed_or_duplicate_managed_blocks_are_refused() {
        let missing_end =
            upsert_managed_block(GHOSTTY_BEGIN, GHOSTTY_BEGIN, GHOSTTY_END, GHOSTTY_BLOCK);
        assert!(missing_end.is_err());
        let duplicate = format!("{GHOSTTY_BLOCK}\n{GHOSTTY_BLOCK}\n");
        assert!(
            upsert_managed_block(&duplicate, GHOSTTY_BEGIN, GHOSTTY_END, GHOSTTY_BLOCK).is_err()
        );
    }

    #[test]
    fn ghostty_key_tables_require_version_1_3() {
        assert!(!ghostty_version_supported("Ghostty 1.2.0"));
        assert!(ghostty_version_supported("Ghostty 1.3.1\nVersion"));
        assert!(ghostty_version_supported("  - version: 2.0.0"));
    }
}
