//! Deleting the images of panes that no longer exist.
//!
//! A pane's page is a Kitty placement on the terminal, not text in tmux, so tmux does not remove it
//! when the pane goes away. The pane's own teardown deletes it (`write_kitty_delete`, and
//! `closePaneOnce` in electron/main.cjs). That teardown does not always run, or runs too late:
//! `kill-pane`, `kill-window` and `kill-session` take the pane before its process has written
//! anything, a crash or SIGKILL skips it, and by then tmux no longer reports which clients showed
//! the pane. Each of those left a page drawn over whatever the terminal showed next.
//!
//! So the cleanup also runs from tmux, after the fact:
//!
//! 1. Each pane frontend writes the base image id it owns to a registry file named for its pane.
//! 2. tmux hooks run `tweb __sweep-images` when a pane, window or session goes away. By the time a
//!    hook runs, tmux has already removed the pane from `list-panes` (measured on tmux 3.8).
//! 3. The sweep reads the registry, finds the panes tmux no longer lists, writes the delete for
//!    their ids to every attached client tty, and removes their files.
//!
//! The sweep never deletes an id of a pane tmux still lists, so a stray hook cannot blank a live
//! page. It also does nothing when tmux cannot be asked, since then no pane is known to be dead.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::image_id;

/// The hook index, beside the input-source hooks' 72 and edit mode's 71, so none replaces another
/// or a person's own hooks.
const HOOK_INDEX: u32 = 73;

/// The tmux events after which a pane may be gone. `window-unlinked` covers `kill-window`, which
/// fires no per-pane hook; `session-closed` covers `kill-session`.
const HOOKS: [&str; 4] = [
    "pane-exited",
    "after-kill-pane",
    "window-unlinked",
    "session-closed",
];

/// Where the panes of one tmux server are recorded. Keyed by the server identity, because pane ids
/// restart at `%0` on every server and a second server's `%3` is not this one's.
pub fn registry_dir(runtime: &Path, server: &str) -> PathBuf {
    runtime
        .join("images")
        .join(format!("{:016x}", image_id::hash(server)))
}

fn entry_path(dir: &Path, pane: &str) -> PathBuf {
    dir.join(pane.trim_start_matches('%'))
}

/// A pane's registry entry, removed again when the frontend exits normally (it deletes its own
/// image then). One that is killed leaves the entry behind, which is what the sweep is for.
pub struct Registration {
    path: PathBuf,
    owner: String,
}

impl Registration {
    /// Records that `pane` owns the ids starting at `base`. `None` outside tmux: there is no hook
    /// to sweep it, and no pane id to name it by.
    pub fn record(pane: &str, base: u32) -> Option<Self> {
        let server = twebd::tmux::server_identity_from(std::env::var("TMUX").ok().as_deref())?;
        Self::record_in(&registry_dir(&twebd::paths::runtime_dir(), &server), pane, base)
    }

    fn record_in(dir: &Path, pane: &str, base: u32) -> Option<Self> {
        std::fs::create_dir_all(dir).ok()?;
        let path = entry_path(dir, pane);
        // The pid goes in beside the id so a frontend only ever removes its own entry. After
        // `respawn-pane -k` the old frontend can exit after the new one recorded the same pane.
        let owner = format!("{base} {}", std::process::id());
        std::fs::write(&path, &owner).ok()?;
        Some(Self { path, owner })
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        if std::fs::read_to_string(&self.path).ok().as_deref() == Some(self.owner.as_str()) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// The recorded panes tmux no longer lists, with the base id each one owned.
fn dead_entries(dir: &Path, live: &HashSet<String>) -> Vec<(PathBuf, u32)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if live.contains(&format!("%{name}")) {
                return None;
            }
            let content = std::fs::read_to_string(entry.path()).ok()?;
            let base = content.split_whitespace().next()?.parse().ok()?;
            Some((entry.path(), base))
        })
        .collect()
}

fn tmux_lines(args: &[&str]) -> Option<Vec<String>> {
    let output = Command::new("tmux").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::to_string)
            .filter(|line| !line.is_empty())
            .collect(),
    )
}

/// `tweb __sweep-images`: deletes the images of recorded panes that tmux no longer lists.
pub fn run() {
    let Some(server) = twebd::tmux::server_identity_from(std::env::var("TMUX").ok().as_deref())
    else {
        return;
    };
    let dir = registry_dir(&twebd::paths::runtime_dir(), &server);
    let Some(live) = tmux_lines(&["list-panes", "-a", "-F", "#{pane_id}"]) else {
        return;
    };
    let dead = dead_entries(&dir, &live.into_iter().collect());
    if dead.is_empty() {
        return;
    }
    // Every client, not only the ones that showed the pane: that set died with the pane. A delete
    // for an id a terminal does not hold is a no-op, and `q=2` keeps it silent.
    let delete: String = dead
        .iter()
        .map(|(_, base)| crate::raw_kitty_delete(*base))
        .collect();
    for tty in tmux_lines(&["list-clients", "-F", "#{client_tty}"]).unwrap_or_default() {
        if let Ok(mut client) = std::fs::OpenOptions::new().write(true).open(&tty) {
            let _ = client.write_all(delete.as_bytes());
            let _ = client.flush();
        }
    }
    for (path, _) in dead {
        let _ = std::fs::remove_file(path);
    }
}

fn tmux_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '"' | '\\' | '$') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The `tmux` argument lists that install the sweep hooks for `tweb`.
///
/// `|| true` because tmux reports a failed `run-shell` on the person's screen ("returned 127"),
/// and a hook left pointing at a binary that was removed would otherwise do that on every pane
/// close. A sweep that cannot run only means the next one cleans up.
pub fn hook_commands(tweb: &str) -> Vec<Vec<String>> {
    let shell = format!(
        "{} __sweep-images >/dev/null 2>&1 || true",
        shell_quote(tweb)
    );
    let run = format!("run-shell -b \"{}\"", tmux_escape(&shell));
    HOOKS
        .iter()
        .map(|hook| {
            vec![
                "set-hook".to_string(),
                "-g".to_string(),
                format!("{hook}[{HOOK_INDEX}]"),
                run.clone(),
            ]
        })
        .collect()
}

/// The binary the hooks run: the installed one, as the input-source hooks use (main.cjs
/// `twebBinary`), so a development build that is later deleted does not stay in the hooks.
fn hook_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("TWEB_BIN").filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join(".local").join("bin").join("tweb")
}

/// Installs the sweep hooks. Idempotent: each start sets the same indexed hooks again.
pub fn install_hooks() {
    if std::env::var_os("TMUX").is_none() {
        return;
    }
    for args in hook_commands(&hook_binary().to_string_lossy()) {
        let _ = Command::new("tmux").args(&args).status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tweb-image-sweep-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn only_panes_tmux_no_longer_lists_are_swept() {
        let dir = scratch("dead");
        let live = Registration::record_in(&dir, "%3", 100).unwrap();
        let gone = Registration::record_in(&dir, "%7", 200).unwrap();
        std::mem::forget(gone);
        let listed: HashSet<String> = ["%3".to_string(), "%9".to_string()].into();
        let dead = dead_entries(&dir, &listed);
        assert_eq!(dead.len(), 1);
        assert_eq!(dead[0].1, 200);
        assert!(dead[0].0.ends_with("7"));
        drop(live);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_frontend_removes_its_own_entry_but_not_its_successors() {
        let dir = scratch("owner");
        let first = Registration::record_in(&dir, "%4", 100).unwrap();
        drop(first);
        assert!(!entry_path(&dir, "%4").exists());

        // respawn-pane -k: the new frontend records the pane before the old one exits.
        let old = Registration::record_in(&dir, "%4", 100).unwrap();
        std::fs::write(entry_path(&dir, "%4"), "100 1").unwrap();
        drop(old);
        assert_eq!(std::fs::read_to_string(entry_path(&dir, "%4")).unwrap(), "100 1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn servers_do_not_share_a_registry() {
        let runtime = Path::new("/run/tweb");
        assert_ne!(
            registry_dir(runtime, "/tmp/tmux-501/default,1"),
            registry_dir(runtime, "/tmp/tmux-501/default,2")
        );
    }

    #[test]
    fn hooks_cover_every_way_a_pane_goes_away_and_never_report_failure() {
        let commands = hook_commands("/tmp/my dir/it's/tweb");
        let hooks: Vec<&str> = commands.iter().map(|args| args[2].as_str()).collect();
        assert_eq!(
            hooks,
            [
                "pane-exited[73]",
                "after-kill-pane[73]",
                "window-unlinked[73]",
                "session-closed[73]"
            ]
        );
        assert_eq!(
            commands[0][3],
            r#"run-shell -b "'/tmp/my dir/it'\\''s/tweb' __sweep-images >/dev/null 2>&1 || true""#
        );
    }
}
