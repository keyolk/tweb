//! MCP server over stdio.
//!
//! Exposes the same automation surface as the CLI so an agent can drive the
//! browser pane the user is watching. Every tool maps onto one JSON-RPC method
//! of the pane's agent socket; there is no second implementation to drift.

use anyhow::Result;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

use crate::agent;

const PROTOCOL_VERSION: &str = "2025-06-18";

struct Tool {
    name: &'static str,
    method: &'static str,
    description: &'static str,
    /// (property name, JSON type, description, required)
    fields: &'static [(&'static str, &'static str, &'static str, bool)],
    /// Fixed params merged into every call, e.g. the act action.
    fixed: &'static [(&'static str, &'static str)],
}

const REF_FIELD: (&str, &str, &str, bool) = (
    "ref",
    "string",
    "Ref from snapshot — the same label the f hint overlay shows",
    true,
);

const TOOLS: &[Tool] = &[
    Tool {
        name: "tweb_diag",
        method: "diag",
        description: "Report the pane's geometry, window size, zoom, frame state and \
                      input mode. Use it when the pane looks wrong rather than the \
                      page: a frame size that disagrees with the pane means frames \
                      are being dropped.",
        fields: &[],
        fixed: &[],
    },
    Tool {
        name: "tweb_engine_log",
        method: "engine-log",
        description: "Recent engine debug lines (resize and frame accounting). These \
                      otherwise only reach the pane's stderr.",
        fields: &[(
            "limit",
            "integer",
            "How many lines to return (default 60).",
            false,
        )],
        fixed: &[],
    },
    Tool {
        name: "tweb_snapshot",
        method: "snapshot",
        description: "List the interactive elements of the visible page with refs. \
                      Refs match the labels the user sees when pressing f, so both \
                      sides of the terminal can talk about the same element.",
        fields: &[(
            "mode",
            "string",
            "\"interactive\" (default) or \"text\" for readable content",
            false,
        )],
        fixed: &[],
    },
    Tool {
        name: "tweb_click",
        method: "act",
        description: "Click the element behind a ref with a trusted native mouse event.",
        fields: &[REF_FIELD],
        fixed: &[("action", "click")],
    },
    Tool {
        name: "tweb_fill",
        method: "act",
        description: "Set the value of an input, textarea or contenteditable (framework-safe).",
        fields: &[REF_FIELD, ("value", "string", "Text to set", true)],
        fixed: &[("action", "fill")],
    },
    Tool {
        name: "tweb_hover",
        method: "act",
        description: "Move the pointer over the element behind a ref.",
        fields: &[REF_FIELD],
        fixed: &[("action", "hover")],
    },
    Tool {
        name: "tweb_select",
        method: "act",
        description: "Choose an option in a <select>.",
        fields: &[
            REF_FIELD,
            ("value", "string", "Option value, label or text", true),
        ],
        fixed: &[("action", "select")],
    },
    Tool {
        name: "tweb_text",
        method: "act",
        description: "Read the visible text of the element behind a ref.",
        fields: &[REF_FIELD],
        fixed: &[("action", "text")],
    },
    Tool {
        name: "tweb_html",
        method: "act",
        description: "Read the outer HTML of the element behind a ref.",
        fields: &[REF_FIELD],
        fixed: &[("action", "html")],
    },
    Tool {
        name: "tweb_navigate",
        method: "navigate",
        description: "Load a URL in the active tab.",
        fields: &[("url", "string", "URL or bare host", true)],
        fixed: &[],
    },
    Tool {
        name: "tweb_back",
        method: "back",
        description: "Go back one history entry.",
        fields: &[],
        fixed: &[],
    },
    Tool {
        name: "tweb_reload",
        method: "reload",
        description: "Reload the active tab.",
        fields: &[],
        fixed: &[],
    },
    Tool {
        name: "tweb_press",
        method: "press",
        description: "Send a key to the page (Enter, Tab, Escape, ArrowDown, a single character).",
        fields: &[
            ("key", "string", "Key name", true),
            ("modifiers", "array", "shift/control/alt/meta", false),
        ],
        fixed: &[],
    },
    Tool {
        name: "tweb_type",
        method: "type",
        description: "Insert text at the current focus.",
        fields: &[("text", "string", "Text to insert", true)],
        fixed: &[],
    },
    Tool {
        name: "tweb_eval",
        method: "eval",
        description: "Evaluate JavaScript in the page and return the result.",
        fields: &[("script", "string", "JavaScript expression", true)],
        fixed: &[],
    },
    Tool {
        name: "tweb_wait",
        method: "wait",
        description: "Wait for a selector, body text, URL fragment, load completion, or a delay.",
        fields: &[
            ("selector", "string", "CSS selector to await", false),
            ("text", "string", "Body text to await", false),
            ("url", "string", "URL substring to await", false),
            ("load", "boolean", "Await readyState complete", false),
            ("ms", "number", "Fixed delay in milliseconds", false),
            (
                "timeout",
                "number",
                "Give up after this many ms (default 10000)",
                false,
            ),
        ],
        fixed: &[],
    },
    Tool {
        name: "tweb_console",
        method: "console",
        description: "Read buffered console output of the page — the first thing to check \
                      when a frontend misbehaves.",
        fields: &[
            (
                "limit",
                "number",
                "Most recent N entries (default 100)",
                false,
            ),
            ("clear", "boolean", "Drain the buffer after reading", false),
        ],
        fixed: &[],
    },
    Tool {
        name: "tweb_errors",
        method: "errors",
        description: "Read only console errors.",
        fields: &[(
            "limit",
            "number",
            "Most recent N entries (default 50)",
            false,
        )],
        fixed: &[],
    },
    Tool {
        name: "tweb_screenshot",
        method: "screenshot",
        description: "Capture the page. With a path it writes a PNG, otherwise it returns base64.",
        fields: &[("path", "string", "File path to write", false)],
        fixed: &[],
    },
    Tool {
        name: "tweb_tabs",
        method: "tabs",
        description: "List open tabs.",
        fields: &[],
        fixed: &[],
    },
    Tool {
        name: "tweb_status",
        method: "status",
        description: "Report the pane, its pid and its tabs.",
        fields: &[],
        fixed: &[],
    },
];

fn tool_schema(tool: &Tool) -> Value {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    for (name, kind, description, is_required) in tool.fields {
        properties.insert(
            (*name).to_string(),
            json!({ "type": kind, "description": description }),
        );
        if *is_required {
            required.push(Value::String((*name).to_string()));
        }
    }
    json!({
        "name": tool.name,
        "description": tool.description,
        "inputSchema": {
            "type": "object",
            "properties": Value::Object(properties),
            "required": required,
        },
    })
}

fn call_tool(pane: Option<&str>, name: &str, arguments: &Value) -> Result<String> {
    let tool = TOOLS
        .iter()
        .find(|candidate| candidate.name == name)
        .ok_or_else(|| anyhow::anyhow!("unknown tool {name}"))?;
    let mut params = arguments.as_object().cloned().unwrap_or_default();
    for (key, value) in tool.fixed {
        params.insert((*key).to_string(), Value::String((*value).to_string()));
    }
    // The engine writes the file, and its working directory is the Electron app
    // directory rather than the agent's. A relative path would land there silently, so it
    // is anchored to this server's directory — which is the agent's — before it is sent.
    if tool.method == "screenshot" {
        if let Some(Value::String(path)) = params.get("path") {
            let resolved = crate::resolve_output_path(path, &std::env::current_dir()?);
            params.insert("path".to_string(), Value::String(resolved));
        }
    }
    let result = agent::request(pane, tool.method, Value::Object(params))?;
    Ok(agent::render(tool.method, &result))
}

fn respond(id: Option<Value>, payload: Result<Value>) -> Option<Value> {
    let id = id?;
    Some(match payload {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32000, "message": error.to_string() },
        }),
    })
}

/// Serve MCP on stdin/stdout until the client closes the stream.
pub fn serve(pane: Option<&str>) -> Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let message = json!({
                    "jsonrpc": "2.0", "id": Value::Null,
                    "error": { "code": -32700, "message": error.to_string() },
                });
                writeln!(stdout, "{message}")?;
                stdout.flush()?;
                continue;
            }
        };
        let id = request.get("id").cloned();
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or(Value::Null);

        let payload = match method {
            "initialize" => Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "tweb", "version": env!("CARGO_PKG_VERSION") },
            })),
            "tools/list" => Ok(json!({
                "tools": TOOLS.iter().map(tool_schema).collect::<Vec<_>>(),
            })),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
                match call_tool(pane, name, &arguments) {
                    Ok(text) => Ok(json!({ "content": [{ "type": "text", "text": text }] })),
                    // Tool failures are results, not transport errors: the agent
                    // needs to read them and adjust rather than see a dead server.
                    Err(error) => Ok(json!({
                        "content": [{ "type": "text", "text": error.to_string() }],
                        "isError": true,
                    })),
                }
            }
            "ping" => Ok(json!({})),
            "notifications/initialized" | "notifications/cancelled" => continue,
            other => Err(anyhow::anyhow!("unsupported method {other}")),
        };

        if let Some(message) = respond(id, payload) {
            writeln!(stdout, "{message}")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    /// A pane that stopped following its size is invisible from the page, so an
    /// agent needs the engine's own view of it.
    #[test]
    fn the_surface_exposes_pane_diagnostics() {
        let names: Vec<&str> = super::TOOLS.iter().map(|tool| tool.name).collect();
        assert!(
            names.contains(&"tweb_diag"),
            "tweb_diag is missing: {names:?}"
        );
        assert!(
            names.contains(&"tweb_engine_log"),
            "tweb_engine_log is missing: {names:?}"
        );
    }

    use super::*;

    #[test]
    fn every_tool_maps_to_a_method_and_documents_its_fields() {
        for tool in TOOLS {
            assert!(
                tool.name.starts_with("tweb_"),
                "{} needs the tweb_ prefix",
                tool.name
            );
            assert!(!tool.method.is_empty());
            assert!(
                !tool.description.is_empty(),
                "{} needs a description",
                tool.name
            );
            let schema = tool_schema(tool);
            let properties = schema["inputSchema"]["properties"].as_object().unwrap();
            assert_eq!(properties.len(), tool.fields.len());
            for (name, _, description, _) in tool.fields {
                assert!(
                    !description.is_empty(),
                    "{}.{name} needs a description",
                    tool.name
                );
            }
        }
    }

    #[test]
    fn act_tools_pin_their_action() {
        for tool in TOOLS.iter().filter(|tool| tool.method == "act") {
            assert!(
                tool.fixed.iter().any(|(key, _)| *key == "action"),
                "{} must pin an action",
                tool.name
            );
        }
    }

    #[test]
    fn tool_names_are_unique() {
        let mut names: Vec<_> = TOOLS.iter().map(|tool| tool.name).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(names.len(), count, "duplicate tool name");
    }
}
