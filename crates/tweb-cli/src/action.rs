//! `tweb action -- <agent-browser command>`: agent-browser on a tweb pane's tab.
//!
//! agent-browser is a CLI agents already know (snapshot, click, fill, eval, and newer builds'
//! WebMCP). It drives a browser over the Chrome DevTools Protocol, so this only has to point it at
//! the right target: the engine says which CDP port and which tab (`action-target`), this finds that
//! tab among the targets agent-browser lists, selects it, and runs the command. Everything after
//! `--` goes to agent-browser unchanged, and its output and exit status are this command's.
//!
//! What tweb adds over a bare `agent-browser --cdp`: the tab is this pane's, not whichever target
//! comes first on an engine that serves several panes; and a hidden pane's page is held at its real
//! size for the run (the engine collapses a page nobody looks at to one pixel).

use std::process::{Command, Stdio};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::agent;

/// agent-browser commands that would act on the browser rather than on a page, or take the
/// connection out of tweb's hands. `close` over CDP closes the whole browser: tweb's engine.
const BLOCKED: &[(&str, &str)] = &[
    (
        "launch",
        "tweb drives the browser already open in the pane — use: tweb open <url>",
    ),
    ("install", "tweb never downloads a second browser"),
    ("connect", "tweb picks the CDP port for you"),
    ("disconnect", "tweb manages the CDP connection"),
    (
        "close",
        "over CDP this closes tweb's engine — use: tweb tab close",
    ),
    (
        "quit",
        "over CDP this closes tweb's engine — use: tweb tab close",
    ),
    ("--cdp", "tweb picks the CDP port for you"),
    ("--auto-connect", "tweb picks the CDP port for you"),
    (
        "--session",
        "tweb names the agent-browser session after the engine",
    ),
];

/// Why `args` cannot be passed through, if it cannot.
pub fn blocked(args: &[String]) -> Option<String> {
    for arg in args {
        let name = arg.split('=').next().unwrap_or(arg);
        if let Some((_, why)) = BLOCKED.iter().find(|(blocked, _)| *blocked == name) {
            return Some(format!("`{name}` is not passed to agent-browser: {why}"));
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentTab {
    pub id: String,
    pub url: String,
}

/// The tabs in `agent-browser tab list --json`. The shape has moved between releases (`data.tabs`
/// in newer ones, a bare `tabs` in older), so both are read; an entry without an id is skipped.
pub fn parse_tabs(stdout: &str) -> Vec<AgentTab> {
    let Ok(parsed) = serde_json::from_str::<Value>(stdout) else {
        return Vec::new();
    };
    let rows = parsed
        .pointer("/data/tabs")
        .or_else(|| parsed.get("tabs"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    rows.iter()
        .filter_map(|row| {
            let id = match row
                .get("tabId")
                .or_else(|| row.get("index"))
                .or_else(|| row.get("id"))
            {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                _ => return None,
            };
            let url = row
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Some(AgentTab { id, url })
        })
        .collect()
}

fn binary() -> Result<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("TWEB_AGENT_BROWSER") {
        return Ok(path.into());
    }
    which::which("agent-browser").context(
        "agent-browser is not on PATH — install it (npm i -g agent-browser, or brew install agent-browser), \
         or point TWEB_AGENT_BROWSER at it",
    )
}

fn run_captured(bin: &std::path::Path, args: &[&str]) -> Result<(bool, String)> {
    let output = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("running {}", bin.display()))?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    ))
}

fn eval_number(stdout: &str) -> Option<f64> {
    let parsed: Value = serde_json::from_str(stdout).ok()?;
    parsed
        .pointer("/data/result")
        .or_else(|| parsed.get("result"))
        .and_then(Value::as_f64)
}

/// Selects the pane's tab in `session` and returns its agent-browser id.
fn select_tab(bin: &std::path::Path, session: &str, port: &str, target: &Value) -> Result<String> {
    // `--cdp` on the listing (re)connects the session to this port. Never `close` to reset a
    // session: over CDP that closes the browser at the other end, which is tweb's engine.
    let listing = run_captured(
        bin,
        &["--session", session, "--cdp", port, "tab", "list", "--json"],
    )?;
    if !listing.0 {
        bail!("agent-browser could not list the tabs on CDP port {port}");
    }
    let tabs = parse_tabs(&listing.1);
    if tabs.is_empty() {
        bail!("agent-browser sees no tabs on CDP port {port}");
    }
    let url = target.get("url").and_then(Value::as_str).unwrap_or("");
    let same_url: Vec<&AgentTab> = tabs.iter().filter(|tab| tab.url == url).collect();
    if same_url.len() == 1 {
        let id = same_url[0].id.clone();
        run_captured(bin, &["--session", session, "tab", &id])?;
        return Ok(id);
    }
    // Several tabs on one URL (or none, after a redirect the listing has not caught up with):
    // performance.timeOrigin tells documents apart, and the engine read the pane's.
    let origin = target.get("timeOrigin").and_then(Value::as_f64);
    let candidates: Vec<&AgentTab> = if same_url.is_empty() {
        tabs.iter().collect()
    } else {
        same_url
    };
    if let Some(origin) = origin {
        for tab in &candidates {
            run_captured(bin, &["--session", session, "tab", &tab.id])?;
            let (ok, out) = run_captured(
                bin,
                &[
                    "--session",
                    session,
                    "eval",
                    "performance.timeOrigin",
                    "--json",
                ],
            )?;
            if ok && eval_number(&out).is_some_and(|value| (value - origin).abs() < 0.5) {
                return Ok(tab.id.clone());
            }
        }
    }
    bail!(
        "could not tell which of {} agent-browser tabs is this pane's ({url})",
        candidates.len()
    )
}

/// `tweb action [--done] -- <agent-browser args>`. Returns agent-browser's exit code.
pub fn run(pane: Option<&str>, done: bool, args: &[String]) -> Result<i32> {
    if done {
        agent::request(pane, "action-release", json!({}))?;
        return Ok(0);
    }
    if args.is_empty() {
        bail!("nothing to run: tweb action -- <agent-browser command>, e.g. tweb action -- snapshot -i");
    }
    if let Some(why) = blocked(args) {
        bail!(why);
    }
    let bin = binary()?;
    let target = agent::request(pane, "action-target", json!({ "holdMs": 60_000 }))?;
    let port = target
        .get("port")
        .and_then(Value::as_u64)
        .context("the engine reported no CDP port")?
        .to_string();
    // One agent-browser session per engine port: its daemon keeps the CDP connection warm
    // between calls, and two panes on one engine share it the way they share the port.
    let session = format!("tweb-{port}");
    let outcome = (|| -> Result<i32> {
        select_tab(&bin, &session, &port, &target)?;
        let status = Command::new(&bin)
            .arg("--session")
            .arg(&session)
            .args(args)
            .status()
            .with_context(|| format!("running {}", bin.display()))?;
        Ok(status.code().unwrap_or(1))
    })();
    // Always end the hold; a failed release is only a late collapse (the engine's timer ends it).
    let _ = agent::request(pane, "action-release", json!({})); // ok: the hold also times out in the engine
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_level_commands_and_connection_flags_are_refused() {
        for args in [
            &["close"][..],
            &["connect", "9222"],
            &["--cdp", "1", "snapshot"],
            &["--session=x", "snapshot"],
        ] {
            let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            assert!(blocked(&args).is_some(), "{args:?}");
        }
        let fine: Vec<String> = ["snapshot", "-i", "click", "@e3", "tab", "list"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(blocked(&fine), None);
    }

    #[test]
    fn tab_listings_old_and_new_are_read() {
        let new = r#"{"success":true,"data":{"tabs":[{"tabId":"0","url":"https://a/","active":true},{"tabId":1,"url":"https://b/"}]}}"#;
        assert_eq!(
            parse_tabs(new),
            vec![
                AgentTab {
                    id: "0".into(),
                    url: "https://a/".into()
                },
                AgentTab {
                    id: "1".into(),
                    url: "https://b/".into()
                },
            ]
        );
        let old = r#"{"tabs":[{"index":2,"url":"https://c/"},{"url":"https://no-id/"}]}"#;
        assert_eq!(
            parse_tabs(old),
            vec![AgentTab {
                id: "2".into(),
                url: "https://c/".into()
            }]
        );
        assert!(parse_tabs("not json").is_empty());
    }
}
