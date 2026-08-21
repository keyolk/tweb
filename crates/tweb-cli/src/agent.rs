//! Agent automation client.
//!
//! Talks line-delimited JSON-RPC to the unix socket a running browser pane
//! exposes (see `electron/agent-server.cjs`). Refs are the same labels the `f`
//! hint overlay paints, so an agent and the human at the terminal address the
//! page identically.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Runtime directory holding one socket per live browser pane.
pub fn runtime_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("TWEB_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    if !cfg!(target_os = "macos") {
        if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
            return PathBuf::from(dir).join("tweb");
        }
    }
    // getuid(2) cannot fail, so it needs no error path and no libc dependency.
    extern "C" {
        fn getuid() -> u32;
    }
    std::env::temp_dir().join(format!("tweb-{}", unsafe { getuid() }))
}

/// Pane ids sharing a tmux window with us, nearest first (ours, then the rest in
/// layout order).
///
/// Without this, a second browser pane anywhere — another window, another session
/// — made `--pane` mandatory, so every call had to be preceded by a `panes`
/// lookup. `list-panes -a` is used rather than `display-message` because the
/// latter needs an attached client and fails outright without one.
pub fn panes_in_our_window() -> Vec<String> {
    let Ok(ours) = std::env::var("TMUX_PANE") else {
        return Vec::new();
    };
    let Ok(output) = std::process::Command::new("tmux")
        .args(["list-panes", "-a", "-F", "#{pane_id} #{window_id}"])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let listing = String::from_utf8_lossy(&output.stdout);
    let rows: Vec<(&str, &str)> = listing
        .lines()
        .filter_map(|line| line.split_once(' '))
        .map(|(pane, window)| (pane.trim(), window.trim()))
        .collect();
    let Some(window) = rows
        .iter()
        .find(|(pane, _)| *pane == ours)
        .map(|(_, window)| *window)
    else {
        return Vec::new();
    };
    rows.iter()
        .filter(|(_, candidate)| *candidate == window)
        .map(|(pane, _)| (*pane).to_string())
        .collect()
}

/// Sockets that currently accept connections.
pub fn discover_sockets() -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(runtime_dir())
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("agent-") && name.ends_with(".sock"))
        })
        .filter(|path| UnixStream::connect(path).is_ok())
        .collect();
    found.sort();
    found
}

/// Pick the socket to drive: explicit override, named pane, or the only one up.
pub fn resolve_socket(pane: Option<&str>) -> Result<PathBuf> {
    if let Ok(path) = std::env::var("TWEB_AGENT_SOCKET") {
        return Ok(PathBuf::from(path));
    }
    if let Some(pane) = pane {
        let name = pane
            .strip_prefix('%')
            .map_or(pane.to_string(), |rest| format!("%{rest}"));
        let path = runtime_dir().join(format!("agent-{name}.sock"));
        if !path.exists() {
            bail!(
                "no browser pane at {name} (socket {} missing)",
                path.display()
            );
        }
        return Ok(path);
    }
    let sockets = discover_sockets();
    match sockets.len() {
        0 => bail!(
            "no running tweb browser pane found in {}",
            runtime_dir().display()
        ),
        1 => Ok(sockets.into_iter().next().expect("checked length")),
        _ => {
            let names: Vec<String> = sockets
                .iter()
                .filter_map(|path| path.file_stem()?.to_str())
                .map(|stem| stem.trim_start_matches("agent-").to_string())
                .collect();
            // Panes in other windows are almost never what a caller in this window
            // means, so they do not count towards the ambiguity.
            let nearby = panes_in_our_window();
            let ours: Vec<&String> = names
                .iter()
                .filter(|name| nearby.iter().any(|pane| pane == *name))
                .collect();
            if let [only] = ours[..] {
                return Ok(runtime_dir().join(format!("agent-{only}.sock")));
            }
            let listed = if ours.is_empty() {
                names.join(", ")
            } else {
                ours.iter()
                    .map(|name| name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            bail!("multiple browser panes are running ({listed}); pass --pane")
        }
    }
}

/// How long to wait for a pane to answer before giving up.
///
/// A page that wedges its main thread — an infinite loop in a script, a synchronous XHR —
/// stops answering the page-side methods while the engine itself stays perfectly healthy.
/// The wait has to outlast an ordinary slow page and still end.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// One request/response round trip.
pub fn call(socket: &Path, method: &str, params: Value) -> Result<Value> {
    let stream = UnixStream::connect(socket)
        .with_context(|| format!("cannot reach browser pane at {}", socket.display()))?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let mut writer = stream.try_clone()?;
    let request = json!({ "id": 1, "method": method, "params": params });
    writeln!(writer, "{request}")?;
    writer.flush()?;

    let mut line = String::new();
    // A timeout and a closed socket are different diagnoses and were reported as the same
    // one. Measured on a live pane whose renderer was wedged for 90s: the pane was up and
    // `status` answered instantly, yet `eval` reported "browser pane closed the connection"
    // — which sends someone looking for a dead engine that is not dead.
    let read = BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => anyhow::anyhow!(
                "browser pane did not answer {method} within {}s; the page is busy or its \
                 renderer is gone (run `tweb diag --pane ...`: its `page` field probes the \
                 page with its own short timeout, while `status` only reports the engine)",
                READ_TIMEOUT.as_secs()
            ),
            _ => anyhow::Error::new(error).context("browser pane closed the connection"),
        })?;
    // Zero bytes is EOF: the engine went away mid-call rather than answering with nothing.
    if read == 0 {
        bail!("browser pane closed the connection before answering {method}");
    }
    if line.trim().is_empty() {
        bail!("browser pane returned an empty response");
    }
    let response: Value = serde_json::from_str(line.trim())
        .with_context(|| format!("malformed response: {}", line.trim()))?;
    if let Some(error) = response.get("error").and_then(Value::as_str) {
        bail!("{error}");
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

/// Resolve the pane and issue one call.
pub fn request(pane: Option<&str>, method: &str, params: Value) -> Result<Value> {
    call(&resolve_socket(pane)?, method, params)
}

fn text_field(node: &Value, key: &str) -> String {
    node.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Compact one-line-per-node rendering; agents read this instead of JSON.
pub fn render_snapshot(result: &Value) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "url {}\ntitle {}\n",
        text_field(result, "url"),
        text_field(result, "title")
    ));
    for node in result
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let mut line = format!(
            "@{} {} {:?}",
            text_field(node, "ref"),
            text_field(node, "role"),
            text_field(node, "name")
        );
        if let Some(value) = node.get("value").and_then(Value::as_str) {
            if !value.is_empty() {
                line.push_str(&format!(" value={value:?}"));
            }
        }
        if let Some(href) = node.get("href").and_then(Value::as_str) {
            line.push_str(&format!(" href={href}"));
        }
        if let Some(state) = node.get("state").and_then(Value::as_object) {
            let flags = state
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join(" ");
            line.push_str(&format!(" [{flags}]"));
        }
        if let Some(text) = node.get("text").and_then(Value::as_str) {
            if !text.is_empty() {
                line.push_str(&format!("\n    {text}"));
            }
        }
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// Human-facing rendering per method; falls back to pretty JSON.
pub fn render(method: &str, result: &Value) -> String {
    match method {
        "snapshot" => render_snapshot(result),
        // Read actions carry their payload alongside the ok flag; print the payload.
        "act" => {
            for key in ["text", "html", "value"] {
                if let Some(Value::String(value)) = result.get(key) {
                    return format!("{value}\n");
                }
            }
            "ok\n".to_string()
        }
        // A dead service worker leaves the rules unarmed while everything still reports
        // success, so the state column names that rather than showing a bare "loaded".
        "extensions" => {
            let entries = result
                .get("extensions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if entries.is_empty() {
                let dir = text_field(result, "dir");
                return if dir.is_empty() {
                    "no extensions\n".to_string()
                } else {
                    format!("no extensions in {dir}\n")
                };
            }
            entries
                .iter()
                .map(|entry| {
                    format!(
                        "{:<10} {:<28} {}",
                        text_field(entry, "state"),
                        text_field(entry, "name"),
                        text_field(entry, "detail")
                    )
                    .trim_end()
                    .to_string()
                })
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
        }
        // Two shapes from one command: a written file, or the bytes themselves when the
        // caller gave no path. Printing the base64 raw keeps it pipeable into `base64 -d`.
        "pdf" => {
            if let Some(Value::String(encoded)) = result.get("pdf") {
                return format!("{encoded}\n");
            }
            format!(
                "{} ({} bytes)\n",
                text_field(result, "path"),
                result.get("size").and_then(Value::as_i64).unwrap_or(0)
            )
        }
        "console" | "errors" => {
            let key = if method == "console" {
                "messages"
            } else {
                "errors"
            };
            let entries = result
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if entries.is_empty() {
                return format!("no {key}\n");
            }
            entries
                .iter()
                .map(|entry| {
                    format!(
                        "{:<7} {} {}",
                        text_field(entry, "level"),
                        text_field(entry, "message"),
                        text_field(entry, "source")
                    )
                    .trim_end()
                    .to_string()
                })
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
        }
        // An entry with no status is a request that has not come back yet (or one whose
        // completion arrived after it aged out of the ring) — "-" says that, where a bare
        // 0 would read as a real status code.
        "network" => {
            let entries = result
                .get("requests")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if entries.is_empty() {
                return "no requests\n".to_string();
            }
            entries
                .iter()
                .map(|entry| {
                    let status = entry
                        .get("statusCode")
                        .and_then(Value::as_i64)
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "-".to_string());
                    let cached = if entry
                        .get("fromCache")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        " (cached)"
                    } else {
                        ""
                    };
                    format!(
                        "{:<7} {:<4} {}{}",
                        text_field(entry, "method"),
                        status,
                        text_field(entry, "url"),
                        cached
                    )
                    .trim_end()
                    .to_string()
                })
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
        }
        // A summary, not the three logs: the point of the combined call is to see at a glance
        // whether anything was recorded, and `tweb console` / `tweb network` print the entries
        // themselves. The inline PNG is counted rather than printed — it is a screenful of
        // base64 that would bury the two lines above it.
        "capture" => {
            let count = |key: &str| {
                result
                    .get(key)
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0)
            };
            let shot = result.get("screenshot");
            let screenshot = match shot.and_then(|value| value.get("path")) {
                Some(Value::String(path)) => path.clone(),
                _ => {
                    let bytes = shot
                        .and_then(|value| value.get("png"))
                        .and_then(Value::as_str)
                        .map(str::len)
                        .unwrap_or(0);
                    format!("inline png ({bytes} base64 chars)")
                }
            };
            format!(
                "console: {}\nnetwork: {}\nscreenshot: {}\n",
                count("console"),
                count("network"),
                screenshot
            )
        }
        "tabs" | "tab" | "tab-new" | "tab-close" => {
            let tabs = result
                .get("tabs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            tabs.iter()
                .map(|tab| {
                    format!(
                        "{}{} {} {}",
                        if tab.get("active").and_then(Value::as_bool).unwrap_or(false) {
                            "*"
                        } else {
                            " "
                        },
                        tab.get("index").and_then(Value::as_i64).unwrap_or(-1),
                        text_field(tab, "title"),
                        text_field(tab, "url")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
        }
        _ => match result {
            Value::Null => String::new(),
            Value::String(value) => format!("{value}\n"),
            Value::Object(map) if map.len() == 1 => {
                let (_, value) = map.iter().next().expect("checked length");
                match value {
                    Value::String(text) => format!("{text}\n"),
                    other => format!("{other}\n"),
                }
            }
            other => format!(
                "{}\n",
                serde_json::to_string_pretty(other).unwrap_or_default()
            ),
        },
    }
}

/// Run one command and print it.
pub fn run(pane: Option<&str>, method: &str, params: Value, as_json: bool) -> Result<()> {
    let result = request(pane, method, params)?;
    if as_json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        print!("{}", render(method, &result));
    }
    Ok(())
}

/// `tweb panes` — every browser pane an agent could drive.
pub fn list_panes(as_json: bool) -> Result<()> {
    let sockets = discover_sockets();
    let mut entries = Vec::new();
    for socket in &sockets {
        let name = socket
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("")
            .trim_start_matches("agent-")
            .to_string();
        let status = call(socket, "status", json!({})).unwrap_or(Value::Null);
        entries.push(json!({ "pane": name, "socket": socket, "status": status }));
    }
    if as_json {
        println!("{}", serde_json::to_string_pretty(&entries)?);
        return Ok(());
    }
    if entries.is_empty() {
        println!("no running tweb browser pane");
        return Ok(());
    }
    for entry in &entries {
        let active = entry
            .pointer("/status/tabs/tabs")
            .and_then(Value::as_array)
            .and_then(|tabs| {
                tabs.iter()
                    .find(|tab| tab.get("active").and_then(Value::as_bool) == Some(true))
            })
            .cloned()
            .unwrap_or(Value::Null);
        println!(
            "{} {} {}",
            text_field(entry, "pane"),
            text_field(&active, "title"),
            text_field(&active, "url")
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    /// Outside tmux there is no window to scope to, and the lookup must not shell
    /// out or panic — resolution just falls back to the ambiguity error.
    #[test]
    fn scoping_needs_a_tmux_pane() {
        let saved = std::env::var("TMUX_PANE").ok();
        std::env::remove_var("TMUX_PANE");
        assert!(super::panes_in_our_window().is_empty());
        if let Some(value) = saved {
            std::env::set_var("TMUX_PANE", value);
        }
    }

    /// A request still in flight has no status. Rendering its `null` as a number would
    /// print `0`, which reads as a real (and alarming) status code.
    #[test]
    fn pending_requests_render_without_a_status_code() {
        let result = serde_json::json!({
            "requests": [
                { "method": "GET", "url": "https://example.com/a.js", "statusCode": 200,
                  "fromCache": true },
                { "method": "POST", "url": "https://example.com/api", "statusCode": null,
                  "fromCache": false },
            ]
        });
        let rendered = super::render("network", &result);
        assert!(
            rendered.contains("GET     200  https://example.com/a.js (cached)"),
            "{rendered}"
        );
        assert!(
            rendered.contains("POST    -    https://example.com/api"),
            "{rendered}"
        );
    }
}
