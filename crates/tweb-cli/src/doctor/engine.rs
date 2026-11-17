//! Doctor checks about where the engine runs relative to the terminal, and what the engine
//! needs from the machine: the frame medium on every platform, and on Linux the display backend,
//! the renderer sandbox and Electron's shared libraries.
//!
//! Each of these fails in a way the pane cannot report on its own. A frame file the terminal
//! cannot open is answered with silence (`q=2`); a missing `libnss3` kills Electron before it
//! logs anything a user would read; and a sandbox Chromium cannot build aborts the engine.

use std::path::Path;
use std::process::Command;

use tweb_pane::remote_terminal::{self, Medium};
use twebd::chromium_platform::{self, Sandbox};

use super::{Check, CheckStatus};

/// How whole frames would reach this terminal, and why — the decision a pane opened here makes.
pub(super) fn check_frame_medium() -> Check {
    medium_check(&remote_terminal::decide(&remote_terminal::observe()))
}

fn medium_check(choice: &remote_terminal::Choice) -> Check {
    // Forcing frame files onto a remote terminal is the one combination that cannot work: the
    // terminal opens a path on its own machine, finds nothing, and `q=2` keeps it quiet.
    let status = if choice.remote && choice.medium == Medium::File {
        CheckStatus::Fail
    } else {
        CheckStatus::Ok
    };
    let what = match choice.medium {
        Medium::File => "t=f frame files",
        Medium::Direct => "t=d inline PNG, paced to the link budget",
    };
    Check {
        name: "frame medium",
        status,
        detail: format!("{what} — {}", choice.reason),
    }
}

/// Whether the engine will have a display server or run on Ozone's headless platform.
pub(super) fn check_engine_display() -> Check {
    let display = std::env::var("DISPLAY").ok();
    let wayland = std::env::var("WAYLAND_DISPLAY").ok();
    let detail = if chromium_platform::is_headless(display.as_deref(), wayland.as_deref()) {
        "no DISPLAY/WAYLAND_DISPLAY: the engine starts on Ozone headless".to_string()
    } else {
        format!(
            "display server present (DISPLAY={}, WAYLAND_DISPLAY={})",
            display.unwrap_or_default(),
            wayland.unwrap_or_default()
        )
    };
    Check {
        name: "engine display",
        status: CheckStatus::Ok,
        detail,
    }
}

pub(super) fn check_engine_sandbox(electron: Option<&Path>) -> Check {
    let Some(electron) = electron else {
        return Check {
            name: "engine sandbox",
            status: CheckStatus::Warn,
            detail: "no Electron runtime yet (the first `tweb open` installs it)".to_string(),
        };
    };
    let (status, detail) = match chromium_platform::sandbox_for(electron) {
        Sandbox::NotApplicable => (CheckStatus::Ok, "not applicable".to_string()),
        Sandbox::Available(source) => (CheckStatus::Ok, format!("sandboxed by {source}")),
        Sandbox::DisabledByUser(reason) => (
            CheckStatus::Warn,
            format!(
                "renderers run UNSANDBOXED ({}=1): {reason}",
                chromium_platform::NO_SANDBOX_VARIABLE
            ),
        ),
        Sandbox::Unavailable(reason) => (
            CheckStatus::Fail,
            chromium_platform::unavailable_message(electron, &reason).replace('\n', " "),
        ),
    };
    Check {
        name: "engine sandbox",
        status,
        detail,
    }
}

/// The libraries `ldd` cannot resolve for the Electron binary.
pub(super) fn missing_libraries(ldd_output: &str) -> Vec<String> {
    ldd_output
        .lines()
        .filter(|line| line.contains("=> not found"))
        .filter_map(|line| line.split_whitespace().next().map(str::to_string))
        .collect()
}

pub(super) fn check_engine_libraries(electron: Option<&Path>) -> Check {
    let Some(electron) = electron else {
        return Check {
            name: "engine libraries",
            status: CheckStatus::Warn,
            detail: "no Electron runtime yet (the first `tweb open` installs it)".to_string(),
        };
    };
    let Some(output) = Command::new("ldd")
        .arg(electron)
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
    else {
        return Check {
            name: "engine libraries",
            status: CheckStatus::Warn,
            detail: "ldd not available; cannot check Electron's shared libraries".to_string(),
        };
    };
    let missing = missing_libraries(&output);
    // Chromium draws text through fontconfig, and a container image often ships no fonts at all:
    // the engine then starts, loads pages, and paints every glyph as nothing.
    let fonts = Path::new("/usr/share/fonts").is_dir()
        || std::env::var_os("FONTCONFIG_FILE").is_some()
        || std::env::var_os("FONTCONFIG_PATH").is_some();
    if !missing.is_empty() {
        return Check {
            name: "engine libraries",
            status: CheckStatus::Fail,
            detail: format!(
                "{} cannot load {} — install Electron's runtime libraries (README: Linux)",
                electron.display(),
                missing.join(", ")
            ),
        };
    }
    if !fonts {
        return Check {
            name: "engine libraries",
            status: CheckStatus::Warn,
            detail: "no /usr/share/fonts and no FONTCONFIG_FILE: pages will render without \
                     text (install fonts-dejavu-core, fonts-noto-cjk)"
                .to_string(),
        };
    }
    Check {
        name: "engine libraries",
        status: CheckStatus::Ok,
        detail: format!("{} resolves every shared library", electron.display()),
    }
}

/// The Linux-only engine checks, in the order a new user would hit them.
pub(super) fn linux_checks() -> Vec<Check> {
    if !cfg!(target_os = "linux") {
        return Vec::new();
    }
    let electron = tweb_pane::installed_electron();
    vec![
        check_engine_display(),
        check_engine_libraries(electron.as_deref()),
        check_engine_sandbox(electron.as_deref()),
    ]
}

#[cfg(test)]
mod tests {
    use super::{medium_check, missing_libraries};
    use tweb_pane::remote_terminal::{Choice, Medium};

    #[test]
    fn ldd_output_yields_only_the_unresolved_names() {
        let output = "\tlinux-vdso.so.1 (0x0000ffff)\n\
                      \tlibnss3.so => not found\n\
                      \tlibdl.so.2 => /lib/aarch64-linux-gnu/libdl.so.2 (0x0000ffff)\n\
                      \tlibgbm.so.1 => not found\n";
        assert_eq!(missing_libraries(output), vec!["libnss3.so", "libgbm.so.1"]);
        assert!(missing_libraries("").is_empty());
    }

    #[test]
    fn frame_files_to_a_remote_terminal_fail_and_everything_else_passes() {
        let forced = medium_check(&Choice {
            medium: Medium::File,
            remote: true,
            reason: "TWEB_FRAME_TRANSPORT=file (SSH_CONNECTION is set)".into(),
        });
        assert!(matches!(forced.status, super::CheckStatus::Fail));
        let remote = medium_check(&Choice {
            medium: Medium::Direct,
            remote: true,
            reason: "remote terminal: SSH_CONNECTION is set".into(),
        });
        assert!(matches!(remote.status, super::CheckStatus::Ok));
        assert!(remote.detail.contains("t=d"), "{}", remote.detail);
        assert!(
            remote.detail.contains("SSH_CONNECTION"),
            "{}",
            remote.detail
        );
    }
}

/// Which tweb engines are running on this machine's profile, by process title.
///
/// The engine names itself: `tweb host` is a daemon's engine, `tweb %N` is a pane's own
/// (electron/main.cjs `process.title`). Both open the same profile directory, and Chromium's
/// storage is one process at a time, so a pane's own engine beside a host — or two of them —
/// split the profile's locks. On 2026-11-17 eleven such engines, left from a fallback, kept the
/// service-worker and Local Storage locks for hours and every hosted pane lost CacheStorage.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ProfileEngines {
    pub hosts: Vec<u32>,
    /// (pid, pane id)
    pub standalone: Vec<(u32, String)>,
}

impl ProfileEngines {
    /// From `ps -axo pid=,command=` output. Only main processes count: helpers carry `--type=`.
    pub(crate) fn from_ps(output: &str) -> Self {
        let mut found = Self::default();
        for line in output.lines() {
            let line = line.trim_start();
            let Some((pid, command)) = line.split_once(char::is_whitespace) else {
                continue;
            };
            let Ok(pid) = pid.parse::<u32>() else {
                continue;
            };
            let command = command.trim();
            if command.contains("--type=") {
                continue;
            }
            if command == "tweb host" || command.starts_with("tweb host ") {
                found.hosts.push(pid);
            } else if let Some(rest) = command.strip_prefix("tweb %") {
                let pane = rest.split_whitespace().next().unwrap_or_default();
                if !pane.is_empty() && pane.chars().all(|c| c.is_ascii_digit()) {
                    found.standalone.push((pid, format!("%{pane}")));
                }
            }
        }
        found
    }

    pub(crate) fn observe() -> Self {
        Command::new("ps")
            .args(["-axo", "pid=,command="])
            .output()
            .ok()
            .map(|out| Self::from_ps(&String::from_utf8_lossy(&out.stdout)))
            .unwrap_or_default()
    }

    /// Whether more than one engine shares the profile.
    pub(crate) fn shared(&self) -> bool {
        self.hosts.len() + self.standalone.len() > 1 && !self.standalone.is_empty()
    }

    pub(crate) fn describe(&self) -> String {
        let standalone = self
            .standalone
            .iter()
            .map(|(pid, pane)| format!("{pane} pid {pid}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "{} host engine(s) {:?}; pane-own engine(s): {}",
            self.hosts.len(),
            self.hosts,
            if standalone.is_empty() {
                "none".to_string()
            } else {
                standalone
            }
        )
    }
}

/// Doctor: warns when a pane's own engine shares the profile with another engine.
pub(super) fn check_profile_engines() -> Check {
    profile_engines_check(&ProfileEngines::observe())
}

fn profile_engines_check(engines: &ProfileEngines) -> Check {
    let shared = engines.shared();
    Check {
        name: "profile engines",
        status: if shared {
            CheckStatus::Warn
        } else {
            CheckStatus::Ok
        },
        detail: if shared {
            format!(
                "{} — they share one profile and split its storage locks (blank YouTube icons, \
                 stalled IndexedDB). Close those panes and reopen them so the daemon hosts them.",
                engines.describe()
            )
        } else {
            engines.describe()
        },
    }
}

#[cfg(test)]
mod profile_engine_tests {
    use super::*;

    #[test]
    fn a_panes_own_engine_beside_a_host_is_reported_with_its_pid() {
        let ps = "  101 tweb host\n  102 /Applications/x/Electron Helper --type=renderer tweb\n\
                  87551 tweb %119\n 87536 tweb %125   \n 300 /usr/bin/vim\n";
        let engines = ProfileEngines::from_ps(ps);
        assert_eq!(engines.hosts, vec![101]);
        assert_eq!(
            engines.standalone,
            vec![(87551, "%119".to_string()), (87536, "%125".to_string())]
        );
        let check = profile_engines_check(&engines);
        assert!(matches!(check.status, CheckStatus::Warn));
        assert!(check.detail.contains("%119 pid 87551"), "{}", check.detail);
    }

    #[test]
    fn one_host_alone_is_fine() {
        let engines = ProfileEngines::from_ps(" 101 tweb host\n");
        assert!(!engines.shared());
        assert!(matches!(
            profile_engines_check(&engines).status,
            CheckStatus::Ok
        ));
    }
}
