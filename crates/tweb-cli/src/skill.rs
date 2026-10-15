//! `tweb skill`: the agent skill that teaches a coding agent to drive tweb.
//!
//! The skill text lives in `skill/tweb/` and is compiled into the binary, so the installed skill
//! always describes the commands of the `tweb` that installed it. Re-running `tweb skill install`
//! after an upgrade brings it up to date.
//!
//! It is written as a FILE rather than a symlink into an install tree, because tweb has no install
//! tree: the binary is the whole installation (see the Makefile's `install`). The cost is that a
//! file can go stale; the marker line below is what lets `install` replace its own earlier copy
//! while refusing to overwrite a SKILL.md somebody wrote or edited by hand.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

const SKILL: &str = include_str!("../../../skill/tweb/SKILL.md");
const CODEX_OVERLAY: &str = include_str!("../../../skill/tweb/codex.md");

/// Written after the front matter of every installed copy. Its presence means "tweb wrote this
/// file and may rewrite it"; a SKILL.md without it is the user's and is left alone.
const MARKER: &str = "<!-- installed by `tweb skill install`; rerun it to update. -->";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    fn name(self) -> &'static str {
        match self {
            Agent::Claude => "Claude Code",
            Agent::Codex => "Codex",
        }
    }

    /// The agent's home: `CLAUDE_CONFIG_DIR` / `CODEX_HOME` when set, as each tool reads them.
    fn home(self, env: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
        let (variable, default) = match self {
            Agent::Claude => ("CLAUDE_CONFIG_DIR", ".claude"),
            Agent::Codex => ("CODEX_HOME", ".codex"),
        };
        env(variable)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(default))
    }

    fn skill_path(self, env: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
        self.home(env, home)
            .join("skills")
            .join("tweb")
            .join("SKILL.md")
    }
}

/// The skill as `agent` gets it: the shared text, the marker, and that agent's overlay.
pub fn render(agent: Agent) -> String {
    // The marker goes after the front matter: an agent reads the `---` block first and a comment
    // ahead of it would hide the skill's name and description.
    let (front, body) = split_front_matter(SKILL);
    let mut text = format!("{front}{MARKER}\n{body}");
    if agent == Agent::Codex {
        text.push_str(CODEX_OVERLAY);
    }
    text
}

fn split_front_matter(text: &str) -> (&str, &str) {
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            let split = 4 + end + 5;
            return (&text[..split], &text[split..]);
        }
    }
    ("", text)
}

/// Which agents to install for: the ones named, or, with none named, each whose home directory
/// exists — an agent that is not installed should not grow a config directory because of tweb.
fn chosen(agents: &[Agent], env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Vec<Agent> {
    if !agents.is_empty() {
        return agents.to_vec();
    }
    [Agent::Claude, Agent::Codex]
        .into_iter()
        .filter(|agent| agent.home(env, home).is_dir())
        .collect()
}

fn ours(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|text| text.contains(MARKER))
}

/// Writes the skill for each chosen agent. Returns the files written.
pub fn install_into(
    agents: &[Agent],
    force: bool,
    env: &dyn Fn(&str) -> Option<String>,
    home: &Path,
) -> Result<Vec<PathBuf>> {
    let targets = chosen(agents, env, home);
    if targets.is_empty() {
        bail!(
            "no agent found (~/.claude or ~/.codex); name one with --claude or --codex, \
             or print the skill with `tweb skill print`"
        );
    }
    let mut written = Vec::new();
    for agent in targets {
        let path = agent.skill_path(env, home);
        if path.exists() && !ours(&path) && !force {
            bail!(
                "{} exists and was not written by tweb; pass --force to replace it",
                path.display()
            );
        }
        let directory = path.parent().expect("a skill path has a parent");
        std::fs::create_dir_all(directory)
            .with_context(|| format!("cannot create {}", directory.display()))?;
        std::fs::write(&path, render(agent))
            .with_context(|| format!("cannot write {}", path.display()))?;
        println!(
            "installed the tweb skill for {}: {}",
            agent.name(),
            path.display()
        );
        written.push(path);
    }
    Ok(written)
}

/// Removes the skill tweb installed for each chosen agent. A SKILL.md without the marker is not
/// tweb's and is kept.
pub fn uninstall_from(
    agents: &[Agent],
    env: &dyn Fn(&str) -> Option<String>,
    home: &Path,
) -> Result<()> {
    for agent in chosen(agents, env, home) {
        let path = agent.skill_path(env, home);
        if !path.exists() {
            continue;
        }
        if !ours(&path) {
            eprintln!("tweb: left {} alone: tweb did not write it", path.display());
            continue;
        }
        std::fs::remove_file(&path).with_context(|| format!("cannot remove {}", path.display()))?;
        // Only the directory tweb made, and only if nothing else was put in it.
        if let Some(directory) = path.parent() {
            let _ = std::fs::remove_dir(directory);
        }
        println!("removed {}", path.display());
    }
    Ok(())
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn home_dir() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set")
}

pub fn install(agents: &[Agent], force: bool) -> Result<()> {
    install_into(agents, force, &process_env, &home_dir()?).map(|_| ())
}

pub fn uninstall(agents: &[Agent]) -> Result<()> {
    uninstall_from(agents, &process_env, &home_dir()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tweb-skill-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_front_matter_stays_first() {
        let text = render(Agent::Claude);
        assert!(text.starts_with("---\nname: tweb\ndescription: "));
        let (front, body) = split_front_matter(&text);
        assert!(front.ends_with("\n---\n"));
        assert!(body.starts_with(MARKER));
        assert!(!text.contains("## Codex"));
        assert!(render(Agent::Codex)
            .trim_end()
            .ends_with("even while\nthe user can see one."));
    }

    /// The skill must not teach a command or flag this build does not have. Every `tweb <word>`
    /// in a code block is parsed with the real CLI definition.
    #[test]
    fn every_command_the_skill_shows_exists() {
        use clap::CommandFactory;
        let cli = crate::Cli::command();
        let mut checked = 0;
        for line in SKILL.lines().chain(CODEX_OVERLAY.lines()) {
            for segment in line.split(" / ") {
                let segment = segment.split('#').next().unwrap_or("").trim();
                let Some(rest) = segment.strip_prefix("tweb ") else {
                    continue;
                };
                let name = rest.split_whitespace().next().unwrap_or("");
                assert!(
                    cli.find_subcommand(name).is_some(),
                    "SKILL.md shows `tweb {name}`, which does not exist"
                );
                for flag in rest.split_whitespace().filter(|w| w.starts_with("--")) {
                    let flag = flag.trim_start_matches("--");
                    let flag = flag.split('=').next().unwrap_or(flag);
                    let sub = cli.find_subcommand(name).unwrap();
                    let known = sub.get_arguments().any(|arg| arg.get_long() == Some(flag))
                        || sub.get_subcommands().any(|nested| {
                            nested
                                .get_arguments()
                                .any(|arg| arg.get_long() == Some(flag))
                        });
                    assert!(
                        known,
                        "SKILL.md shows `tweb {name} --{flag}`, which does not exist"
                    );
                }
                checked += 1;
            }
        }
        assert!(
            checked > 30,
            "only {checked} commands found; the parser above is wrong"
        );
    }

    #[test]
    fn install_goes_where_each_agent_reads_skills() {
        let home = scratch("home");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        // Only Claude is installed here, so a bare install writes only Claude's copy.
        let written = install_into(&[], false, &no_env, &home).unwrap();
        assert_eq!(written, vec![home.join(".claude/skills/tweb/SKILL.md")]);
        assert!(!home.join(".codex").exists());

        let codex_home = home.join("elsewhere");
        let env = |name: &str| (name == "CODEX_HOME").then(|| codex_home.display().to_string());
        let written = install_into(&[Agent::Codex], false, &env, &home).unwrap();
        assert_eq!(written, vec![codex_home.join("skills/tweb/SKILL.md")]);
        assert!(std::fs::read_to_string(&written[0])
            .unwrap()
            .contains("## Codex"));
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn a_skill_somebody_wrote_is_never_overwritten_or_removed_without_force() {
        let home = scratch("theirs");
        let path = home.join(".claude/skills/tweb/SKILL.md");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "my own notes").unwrap();

        assert!(install_into(&[Agent::Claude], false, &no_env, &home).is_err());
        uninstall_from(&[Agent::Claude], &no_env, &home).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "my own notes");

        install_into(&[Agent::Claude], true, &no_env, &home).unwrap();
        // Ours now, so a reinstall and an uninstall both go through.
        install_into(&[Agent::Claude], false, &no_env, &home).unwrap();
        uninstall_from(&[Agent::Claude], &no_env, &home).unwrap();
        assert!(!path.exists());
        assert!(!path.parent().unwrap().exists());
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn nothing_to_install_for_is_an_error_not_a_silent_success() {
        let home = scratch("none");
        assert!(install_into(&[], false, &no_env, &home).is_err());
        std::fs::remove_dir_all(home).ok();
    }
}
