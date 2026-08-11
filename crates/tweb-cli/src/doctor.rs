//! `tweb doctor` — diagnoses terminal/tmux/GPU/extension capabilities.
//!
//! DESIGN.md section 4.1. Diagnoses whether the environment is supported.
//! Decided by an actual capability query, never guessed from the terminal name.

use std::process::Command;

/// The result of one diagnostic check.
struct Check {
    name: &'static str,
    status: CheckStatus,
    detail: String,
}

enum CheckStatus {
    Ok,
    Warn,
    Fail,
}

impl CheckStatus {
    fn label(&self) -> &'static str {
        match self {
            CheckStatus::Ok => "OK",
            CheckStatus::Warn => "WARN",
            CheckStatus::Fail => "FAIL",
        }
    }
}

/// Runs doctor.
pub async fn run() {
    println!("tweb doctor — environment diagnosis\n");

    let checks = vec![
        check_terminal(),
        check_tmux(),
        check_tmux_session(),
        check_tmux_version(),
        check_tmux_passthrough(),
        check_tmux_focus_events(),
        check_tmux_mouse(),
        check_pixel_size_query(),
    ];

    // Output.
    for c in &checks {
        println!("  [{:>4}] {}: {}", c.status.label(), c.name, c.detail);
    }

    // Summary.
    let ok = checks
        .iter()
        .filter(|c| matches!(c.status, CheckStatus::Ok))
        .count();
    let warn = checks
        .iter()
        .filter(|c| matches!(c.status, CheckStatus::Warn))
        .count();
    let fail = checks
        .iter()
        .filter(|c| matches!(c.status, CheckStatus::Fail))
        .count();
    println!("\n  {} OK, {} WARN, {} FAIL", ok, warn, fail);

    if fail > 0 {
        println!("\n  tweb requires tmux 3.3+ with allow-passthrough and a Kitty graphics capable terminal.");
    }
}

fn check_terminal() -> Check {
    let term = std::env::var("TERM").unwrap_or_default();
    let term_program = std::env::var("TERM_PROGRAM").unwrap_or_default();
    let detail = if term_program.is_empty() {
        format!("TERM={} (TERM_PROGRAM unset)", term)
    } else {
        format!("TERM={}, TERM_PROGRAM={}", term, term_program)
    };
    // Kitty graphics support should be decided by a query rather than a name; doctor only hints here.
    let status = if term_program.contains("ghostty")
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
    let result = Command::new("tmux").arg("-V").output();
    match result {
        Ok(out) if out.status.success() => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Check {
                name: "tmux",
                status: CheckStatus::Ok,
                detail: v,
            }
        }
        _ => Check {
            name: "tmux",
            status: CheckStatus::Fail,
            detail: "tmux not found".to_string(),
        },
    }
}

fn check_tmux_session() -> Check {
    let tmux = std::env::var("TMUX");
    match tmux {
        Ok(v) => {
            let parts: Vec<&str> = v.split(',').collect();
            let socket = parts.first().copied().unwrap_or("?");
            Check {
                name: "tmux session",
                status: CheckStatus::Ok,
                detail: format!("attached: {}", socket),
            }
        }
        Err(_) => Check {
            name: "tmux session",
            status: CheckStatus::Warn,
            detail: "not inside tmux (TMUX unset)".to_string(),
        },
    }
}

fn check_tmux_version() -> Check {
    let result = Command::new("tmux").arg("-V").output();
    match result {
        Ok(out) if out.status.success() => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            // "tmux 3.5a" → parse the version. Strip the suffix (a, b, rc).
            let version = v.strip_prefix("tmux ").unwrap_or("");
            let parts: Vec<u32> = version
                .split('.')
                .map(|s| {
                    // "5a" → 5, "3" → 3.
                    s.chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect::<String>()
                        .parse()
                        .unwrap_or(0)
                })
                .collect();
            let major = parts.first().copied().unwrap_or(0);
            let minor = parts.get(1).copied().unwrap_or(0);
            // 3.3+ is required (where allow-passthrough was introduced).
            if major > 3 || (major == 3 && minor >= 3) {
                Check {
                    name: "tmux version",
                    status: CheckStatus::Ok,
                    detail: format!("{} (3.3+ required)", v),
                }
            } else {
                Check {
                    name: "tmux version",
                    status: CheckStatus::Fail,
                    detail: format!("{} (3.3+ required)", v),
                }
            }
        }
        _ => Check {
            name: "tmux version",
            status: CheckStatus::Fail,
            detail: "cannot determine".to_string(),
        },
    }
}

fn check_tmux_passthrough() -> Check {
    let result = Command::new("tmux")
        .args(["show-options", "-g", "allow-passthrough"])
        .output();
    match result {
        Ok(out) if out.status.success() => {
            let opts = String::from_utf8_lossy(&out.stdout);
            let enabled = opts.contains("all") || opts.contains("on");
            Check {
                name: "tmux allow-passthrough",
                status: if enabled {
                    CheckStatus::Ok
                } else {
                    CheckStatus::Warn
                },
                detail: opts.trim().to_string(),
            }
        }
        _ => Check {
            name: "tmux allow-passthrough",
            status: CheckStatus::Warn,
            detail: "not set (set -g allow-passthrough all)".to_string(),
        },
    }
}

fn check_tmux_focus_events() -> Check {
    let result = Command::new("tmux")
        .args(["show-options", "-g", "focus-events"])
        .output();
    match result {
        Ok(out) if out.status.success() => {
            let opts = String::from_utf8_lossy(&out.stdout);
            let enabled = opts.contains("on");
            Check {
                name: "tmux focus-events",
                status: if enabled {
                    CheckStatus::Ok
                } else {
                    CheckStatus::Warn
                },
                detail: opts.trim().to_string(),
            }
        }
        _ => Check {
            name: "tmux focus-events",
            status: CheckStatus::Warn,
            detail: "not set (set -g focus-events on)".to_string(),
        },
    }
}

fn check_tmux_mouse() -> Check {
    let result = Command::new("tmux")
        .args(["show-options", "-g", "mouse"])
        .output();
    match result {
        Ok(out) if out.status.success() => {
            let opts = String::from_utf8_lossy(&out.stdout);
            let enabled = opts.contains("on");
            Check {
                name: "tmux mouse",
                status: if enabled {
                    CheckStatus::Ok
                } else {
                    CheckStatus::Warn
                },
                detail: opts.trim().to_string(),
            }
        }
        _ => Check {
            name: "tmux mouse",
            status: CheckStatus::Warn,
            detail: "not set (set -g mouse on)".to_string(),
        },
    }
}

fn check_pixel_size_query() -> Check {
    // TODO: confirm the terminal pixel size with a real CSI 14t query.
    // A placeholder for now.
    Check {
        name: "pixel size query (CSI 14t)",
        status: CheckStatus::Warn,
        detail: "not yet probed (TODO)".to_string(),
    }
}
