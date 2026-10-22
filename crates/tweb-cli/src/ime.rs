//! `tweb __ime normal|restore`: the input source a tweb pane's keys need.
//!
//! A tweb pane's normal mode is single-letter commands (`f`, `j`, `t`). Under a Korean input source
//! the terminal's IME gets those keys first: `f` is `ㄹ`, held as an unfinished syllable and sent
//! only when the next key closes it, often merged into one (`f` then `j` arrives as `러`). So the
//! shortcuts seemed dead until the person switched to English by hand, and back again to type.
//!
//! The fix is the input source itself: ABC while the pane takes commands, the person's own source
//! back when they type in a text field or leave the pane. tmux's pane-focus hooks run `normal` and
//! `restore` the instant focus moves (main.cjs `ensureTmuxPassthroughTable`), and the engine runs
//! them when a field takes or gives up focus inside a focused pane.
//!
//! The source in use before `normal` is kept in the tmux global option `@tweb_ime_saved`, so the
//! hook processes and every pane's engine share one record. Switching uses `macism`, which can
//! select a CJK input source reliably. Without it this does nothing: the engine still maps the
//! Hangul it receives to keys (electron/hangul-keys.cjs), only with the IME's lag.

use std::path::PathBuf;
use std::process::Command;

/// The source commands are typed in. `TWEB_IME_SOURCE` picks another (a Dvorak user's, say).
pub const DEFAULT_SOURCE: &str = "com.apple.keylayout.ABC";
const SAVED_OPTION: &str = "@tweb_ime_saved";

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Normal,
    Restore,
}

impl Action {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "normal" => Some(Self::Normal),
            "restore" => Some(Self::Restore),
            _ => None,
        }
    }
}

/// What to do, from the source in use and the one saved: `Some(source)` to select, with the
/// saved record to write first (`Some(Some(x))` to save x, `Some(None)` to clear it).
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub select: Option<String>,
    pub save: Option<Option<String>>,
}

pub fn plan(action: &Action, current: &str, saved: &str, target: &str) -> Plan {
    match action {
        // Already the command source: nothing to remember, so a later restore leaves the person's
        // choice alone. A saved record from an earlier pane survives, since that is still where
        // they came from.
        Action::Normal if current.is_empty() || current == target => Plan {
            select: None,
            save: None,
        },
        Action::Normal => Plan {
            select: Some(target.to_string()),
            save: Some(Some(current.to_string())),
        },
        Action::Restore if saved.is_empty() => Plan {
            select: None,
            save: None,
        },
        Action::Restore => Plan {
            select: (saved != current).then(|| saved.to_string()),
            save: Some(None),
        },
    }
}

fn macism() -> Option<PathBuf> {
    ["/opt/homebrew/bin/macism", "/usr/local/bin/macism"]
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .or_else(|| {
            std::env::var_os("PATH").and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|dir| dir.join("macism"))
                    .find(|path| path.is_file())
            })
        })
}

fn output(command: &mut Command) -> String {
    command
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Runs `action`. Never fails the caller: a hook that errors would print into the person's pane.
pub fn run(action: Action) {
    let Some(macism) = macism() else { return };
    let target = std::env::var("TWEB_IME_SOURCE").unwrap_or_else(|_| DEFAULT_SOURCE.to_string());
    let current = output(&mut Command::new(&macism));
    let saved = output(Command::new("tmux").args(["show-options", "-gqv", SAVED_OPTION]));
    let plan = plan(&action, &current, &saved, &target);
    match &plan.save {
        Some(Some(source)) => {
            let _ = Command::new("tmux")
                .args(["set-option", "-g", SAVED_OPTION, source])
                .status();
        }
        Some(None) => {
            let _ = Command::new("tmux")
                .args(["set-option", "-gu", SAVED_OPTION])
                .status();
        }
        None => {}
    }
    if let Some(source) = plan.select {
        let _ = Command::new(&macism).arg(source).status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABC: &str = DEFAULT_SOURCE;
    const KO: &str = "com.apple.inputmethod.Korean.2SetKorean";

    #[test]
    fn normal_switches_to_abc_and_remembers_korean() {
        assert_eq!(
            plan(&Action::Normal, KO, "", ABC),
            Plan {
                select: Some(ABC.into()),
                save: Some(Some(KO.into()))
            }
        );
    }

    #[test]
    fn normal_on_abc_changes_nothing_and_keeps_an_earlier_record() {
        assert_eq!(
            plan(&Action::Normal, ABC, KO, ABC),
            Plan {
                select: None,
                save: None
            }
        );
        assert_eq!(
            plan(&Action::Normal, "", "", ABC),
            Plan {
                select: None,
                save: None
            }
        );
    }

    #[test]
    fn restore_puts_the_saved_source_back_once() {
        assert_eq!(
            plan(&Action::Restore, ABC, KO, ABC),
            Plan {
                select: Some(KO.into()),
                save: Some(None)
            }
        );
        // Nothing saved: the person was on ABC, or switched themselves; leave it.
        assert_eq!(
            plan(&Action::Restore, ABC, "", ABC),
            Plan {
                select: None,
                save: None
            }
        );
        // Already back on it (they switched by hand): only the record goes.
        assert_eq!(
            plan(&Action::Restore, KO, KO, ABC),
            Plan {
                select: None,
                save: Some(None)
            }
        );
    }

    #[test]
    fn actions_parse() {
        assert_eq!(Action::parse("normal"), Some(Action::Normal));
        assert_eq!(Action::parse("restore"), Some(Action::Restore));
        assert_eq!(Action::parse("x"), None);
    }
}
