//! `tweb doctor` — terminal/tmux/GPU/extension capability 진단.
//!
//! DESIGN.md 섹션 4.1. 지원 환경 진단.
//! terminal 이름으로 추측하지 않고 실제 capability query로 판정.

use std::process::Command;

/// 진단 항목 결과.
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

/// doctor 실행.
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

    // 출력.
    for c in &checks {
        println!("  [{:>4}] {}: {}", c.status.label(), c.name, c.detail);
    }

    // 요약.
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
    // Kitty graphics 지원은 이름이 아닌 query로 판정해야 하지만, doctor에서는 hint만.
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
            // "tmux 3.5a" → parse version. 접미사(a, b, rc) 제거.
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
            // 3.3+ 필요 (allow-passthrough 도입).
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
    // TODO: 실제 CSI 14t query로 terminal pixel size 확인.
    // 현재는 placeholder.
    Check {
        name: "pixel size query (CSI 14t)",
        status: CheckStatus::Warn,
        detail: "not yet probed (TODO)".to_string(),
    }
}
