//! IPC — authenticated local IPC between twebd and tweb CLI / tweb __pane.
//!
//! Unix socket + peer credential check. DESIGN.md section 5.1.
//! No API ever returns a cookie/token value; only opaque IDs are used.

use crate::Daemon;
use std::path::Path;
use std::sync::Arc;

/// An IPC request. Opaque IDs only — never a cookie/token value.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Request {
    /// Create a page. Pane identity plus URL.
    CreatePage {
        pane: i32,
        tmux_server_id: String,
        url: String,
    },
    /// Close a page.
    ClosePage { pane: i32 },
    /// page navigation.
    Navigate { pane: i32, url: String },
    /// A page snapshot (for agent automation).
    Snapshot { pane: i32 },
    /// Execute an agent action.
    ExecuteAction {
        pane: i32,
        action: serde_json::Value,
    },
    /// page resize.
    Resize { pane: i32, width: u32, height: u32 },
    /// page visibility.
    SetVisible { pane: i32, visible: bool },
    /// List resources.
    ResourceList { window: Option<String> },
    /// daemon status.
    Status,
}

/// An IPC response.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    Ok,
    PageId { id: String },
    Snapshot { snapshot: serde_json::Value },
    ResourceList { resources: Vec<serde_json::Value> },
    Status { pages: Vec<serde_json::Value> },
    Error { message: String },
}

/// Starts the IPC server.
pub async fn serve(_daemon: Arc<Daemon>, socket_path: &Path) -> anyhow::Result<()> {
    // Remove the socket if it already exists.
    if socket_path.exists() {
        std::fs::remove_file(socket_path)?;
    }

    // TODO: Unix socket bind, peer credential check (SO_PEERCRED on Linux,
    // getpeereid on macOS), request dispatch.
    tracing::info!(?socket_path, "IPC server listening");

    // placeholder: wait until the daemon shuts down.
    tokio::signal::ctrl_c().await?;

    tracing::info!("twebd shutting down");
    Ok(())
}
