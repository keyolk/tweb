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
            let names = sockets
                .iter()
                .filter_map(|path| path.file_stem()?.to_str())
                .map(|stem| stem.trim_start_matches("agent-").to_string())
                .collect::<Vec<_>>()
                .join(", ");
            bail!("multiple browser panes are running ({names}); pass --pane")
        }
    }
}

/// One request/response round trip.
pub fn call(socket: &Path, method: &str, params: Value) -> Result<Value> {
    let stream = UnixStream::connect(socket)
        .with_context(|| format!("cannot reach browser pane at {}", socket.display()))?;
    stream.set_read_timeout(Some(Duration::from_secs(60)))?;
    let mut writer = stream.try_clone()?;
    let request = json!({ "id": 1, "method": method, "params": params });
    writeln!(writer, "{request}")?;
    writer.flush()?;

    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .context("browser pane closed the connection")?;
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
