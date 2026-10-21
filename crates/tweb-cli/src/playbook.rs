//! Playbooks: what an agent learned about driving one site, kept for the next session.
//!
//! A recording (`tweb record`) is one demonstration and is forgotten once read. A playbook is
//! the lesson drawn from it — "on coupang.com, search, filter to 로켓, open the item, 바로구매;
//! payment is the user's" — written by the agent as Markdown and read again the next time any
//! session drives that site. tweb does not write playbooks itself: deciding what a flow means
//! is the agent's job. It only fixes where each site's file lives and points at it, so every
//! agent and every session finds the same one.
//!
//! The files are `<config dir>/playbooks/<host>.md`. A host is looked up as itself and then as
//! each parent domain, so `checkout.coupang.com` reads `coupang.com.md`; `www.` is dropped,
//! because `www.coupang.com` and `coupang.com` are the same site to anyone writing one.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

use crate::sites::url_host;

/// Where playbooks live.
pub fn dir() -> PathBuf {
    crate::doctor::managed_config_dir().join("playbooks")
}

/// The name a site's playbook is filed under: its host without a leading `www.`. None for
/// anything without a web host (a file, `about:blank`).
pub fn site_key(target: &str) -> Option<String> {
    let host = url_host(target)?;
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    // A host is already restricted to name characters; this keeps a path out of the file name
    // even if that ever stops holding.
    (!host.is_empty() && !host.contains(['/', '\\']) && host != "." && host != "..").then_some(host)
}

/// The keys `target` is looked up under, most specific first: the host, then each parent
/// domain that still has two labels (`a.b.coupang.com` → `b.coupang.com` → `coupang.com`).
pub fn lookup_keys(target: &str) -> Vec<String> {
    let Some(key) = site_key(target) else {
        return Vec::new();
    };
    let mut keys = vec![key.clone()];
    let mut rest = key.as_str();
    while let Some((_, parent)) = rest.split_once('.') {
        if !parent.contains('.') {
            break;
        }
        keys.push(parent.to_string());
        rest = parent;
    }
    keys
}

/// The playbook that applies to `target` in `dir`, if one has been written.
pub fn find_in(dir: &Path, target: &str) -> Option<PathBuf> {
    lookup_keys(target)
        .into_iter()
        .map(|key| dir.join(format!("{key}.md")))
        .find(|path| path.is_file())
}

/// The playbook that applies to `target`, if one has been written.
pub fn find(target: &str) -> Option<PathBuf> {
    find_in(&dir(), target)
}

/// The file an agent should write for `target`: the one that already applies, so a lesson
/// learned on `checkout.coupang.com` joins `coupang.com.md` rather than starting a second
/// file, or a new one named after the host.
pub fn path_for_in(dir: &Path, target: &str) -> Option<PathBuf> {
    find_in(dir, target).or_else(|| Some(dir.join(format!("{}.md", site_key(target)?))))
}

/// `rendered` with a `playbook <path>` line after its `title` line, when the page's site has a
/// playbook. Snapshot output is what an agent reads before acting on a page, so this is where
/// it learns that someone has already worked out how this site goes.
pub fn annotate_snapshot(rendered: String, url: &str, playbook: Option<&Path>) -> String {
    let Some(path) = playbook.filter(|_| !url.is_empty()) else {
        return rendered;
    };
    let line = format!("playbook {} (read it before acting)\n", path.display());
    let mut out = String::with_capacity(rendered.len() + line.len());
    let mut inserted = false;
    for current in rendered.split_inclusive('\n') {
        out.push_str(current);
        if !inserted && current.starts_with("title ") {
            out.push_str(&line);
            inserted = true;
        }
    }
    if !inserted {
        out.insert_str(0, &line);
    }
    out
}

/// `tweb playbook show`: the playbook for `target`, or where to write one.
pub fn show(target: &str) -> Result<()> {
    print!("{}", show_text(target)?);
    Ok(())
}

/// What `show` prints, for the MCP tool as well as the CLI.
pub fn show_text(target: &str) -> Result<String> {
    let Some(key) = site_key(target) else {
        anyhow::bail!("{target} has no web host, so it has no playbook");
    };
    Ok(match find(target) {
        Some(path) => {
            let mut text = std::fs::read_to_string(&path)
                .with_context(|| format!("cannot read {}", path.display()))?;
            if !text.ends_with('\n') {
                text.push('\n');
            }
            format!("playbook {}\n\n{text}", path.display())
        }
        None => format!(
            "no playbook for {key}; write one at {}\n",
            dir().join(format!("{key}.md")).display()
        ),
    })
}

/// `tweb playbook path`: the file to read or write for `target`. The directory is created so
/// an agent can write the file straight away.
pub fn print_path(target: &str) -> Result<()> {
    let dir = dir();
    let path = path_for_in(&dir, target)
        .with_context(|| format!("{target} has no web host, so it has no playbook"))?;
    std::fs::create_dir_all(&dir).with_context(|| format!("cannot create {}", dir.display()))?;
    println!("{}", path.display());
    Ok(())
}

/// `tweb playbook write`: `content` as the playbook for `target`, replacing it or appended to
/// it. For an agent with no file tools of its own (an MCP client), and so a script does not have
/// to know the path. The file is the one `path` names, so a subdomain still joins its site's.
pub fn write_in(dir: &Path, target: &str, content: &str, append: bool) -> Result<PathBuf> {
    let path = path_for_in(dir, target)
        .with_context(|| format!("{target} has no web host, so it has no playbook"))?;
    if content.trim().is_empty() {
        anyhow::bail!("refusing to write an empty playbook to {}", path.display());
    }
    std::fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
    let mut text = if append {
        match std::fs::read_to_string(&path) {
            Ok(existing) if !existing.is_empty() => {
                let separator = if existing.ends_with("\n\n") {
                    ""
                } else if existing.ends_with('\n') {
                    "\n"
                } else {
                    "\n\n"
                };
                format!("{existing}{separator}{content}")
            }
            Ok(_) => content.to_string(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => content.to_string(),
            Err(error) => {
                return Err(error).with_context(|| format!("cannot read {}", path.display()))
            }
        }
    } else {
        content.to_string()
    };
    if !text.ends_with('\n') {
        text.push('\n');
    }
    std::fs::write(&path, text).with_context(|| format!("cannot write {}", path.display()))?;
    Ok(path)
}

pub fn write(target: &str, content: &str, append: bool) -> Result<PathBuf> {
    write_in(&dir(), target, content, append)
}

/// `tweb playbook list`: every site with a playbook, and its file.
pub fn list() -> Result<()> {
    print!("{}", list_text()?);
    Ok(())
}

/// What `list` prints.
pub fn list_text() -> Result<String> {
    let dir = dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(format!("no playbooks yet ({})\n", dir.display()));
        }
        Err(error) => return Err(error).with_context(|| format!("cannot read {}", dir.display())),
    };
    let mut rows: Vec<(String, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
        .filter_map(|path| Some((path.file_stem()?.to_str()?.to_string(), path)))
        .collect();
    rows.sort();
    if rows.is_empty() {
        return Ok(format!("no playbooks yet ({})\n", dir.display()));
    }
    Ok(rows
        .into_iter()
        .map(|(site, path)| format!("{site:<32} {}\n", path.display()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_drops_www_and_needs_a_web_host() {
        assert_eq!(
            site_key("https://www.coupang.com/vp/products/1").as_deref(),
            Some("coupang.com")
        );
        assert_eq!(site_key("Coupang.com").as_deref(), Some("coupang.com"));
        assert_eq!(site_key("about:blank"), None);
        assert_eq!(site_key("file:///tmp/x.html"), None);
    }

    #[test]
    fn lookup_walks_parents_but_never_to_a_bare_tld() {
        assert_eq!(
            lookup_keys("https://a.checkout.coupang.com/x"),
            [
                "a.checkout.coupang.com",
                "checkout.coupang.com",
                "coupang.com"
            ]
        );
        assert_eq!(lookup_keys("coupang.com"), ["coupang.com"]);
    }

    /// A test directory removed when the test ends, pass or fail.
    struct Dir(PathBuf);
    impl Dir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn a_subdomain_finds_and_extends_its_sites_playbook() {
        let dir = std::env::temp_dir().join(format!("tweb-playbooks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = Dir(dir);
        let checkout = "https://checkout.coupang.com/direct/checkout/1";
        assert_eq!(find_in(dir.path(), checkout), None);
        // Nothing written yet: the new file is named for the host itself.
        assert_eq!(
            path_for_in(dir.path(), checkout),
            Some(dir.path().join("checkout.coupang.com.md"))
        );
        std::fs::write(dir.path().join("coupang.com.md"), "# coupang\n").unwrap();
        let site = dir.path().join("coupang.com.md");
        assert_eq!(find_in(dir.path(), checkout), Some(site.clone()));
        assert_eq!(path_for_in(dir.path(), checkout), Some(site));
    }

    #[test]
    fn write_replaces_or_appends_and_joins_the_sites_file() {
        let dir = std::env::temp_dir().join(format!("tweb-playbooks-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let dir = Dir(dir);
        let first = write_in(dir.path(), "https://www.coupang.com/", "# coupang", false).unwrap();
        assert_eq!(first, dir.path().join("coupang.com.md"));
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "# coupang\n");
        // A lesson from a subdomain lands in the site's file, after what is there.
        let second = write_in(
            dir.path(),
            "https://checkout.coupang.com/x",
            "## checkout",
            true,
        )
        .unwrap();
        assert_eq!(second, first);
        assert_eq!(
            std::fs::read_to_string(&first).unwrap(),
            "# coupang\n\n## checkout\n"
        );
        write_in(dir.path(), "coupang.com", "# new", false).unwrap();
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "# new\n");
        assert!(write_in(dir.path(), "coupang.com", "  \n", false).is_err());
        assert!(write_in(dir.path(), "about:blank", "# x", false).is_err());
    }

    #[test]
    fn snapshot_names_the_playbook_under_its_title() {
        let rendered = "url https://www.coupang.com/\ntitle 쿠팡\n@a link \"로그인\"\n".to_string();
        let path = Path::new("/p/coupang.com.md");
        let out = annotate_snapshot(rendered.clone(), "https://www.coupang.com/", Some(path));
        assert_eq!(
            out,
            "url https://www.coupang.com/\ntitle 쿠팡\nplaybook /p/coupang.com.md (read it before acting)\n@a link \"로그인\"\n"
        );
        assert_eq!(
            annotate_snapshot(rendered.clone(), "https://x/", None),
            rendered
        );
    }
}
