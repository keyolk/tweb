//! IPC — twebd와 tweb CLI / tweb __pane 간 authenticated local IPC.
//!
//! Unix socket + peer credential 확인. DESIGN.md 섹션 5.1.
//! cookie/token 값을 반환하는 API는 만들지 않고 opaque ID만 사용.

use crate::Daemon;
use std::path::Path;
use std::sync::Arc;

/// IPC 요청. opaque ID만 사용, cookie/token 값 포함 금지.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Request {
    /// page 생성. pane identity와 URL.
    CreatePage {
        pane: i32,
        tmux_server_id: String,
        url: String,
    },
    /// page 종료.
    ClosePage { pane: i32 },
    /// page navigation.
    Navigate { pane: i32, url: String },
    /// page snapshot (agent automation용).
    Snapshot { pane: i32 },
    /// agent action 실행.
    ExecuteAction {
        pane: i32,
        action: serde_json::Value,
    },
    /// page resize.
    Resize { pane: i32, width: u32, height: u32 },
    /// page visibility.
    SetVisible { pane: i32, visible: bool },
    /// resource 목록.
    ResourceList { window: Option<String> },
    /// daemon 상태.
    Status,
}

/// IPC 응답.
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

/// IPC server 시작.
pub async fn serve(_daemon: Arc<Daemon>, socket_path: &Path) -> anyhow::Result<()> {
    // socket 이 이미 존재하면 제거.
    if socket_path.exists() {
        std::fs::remove_file(socket_path)?;
    }

    // TODO: Unix socket bind, peer credential 확인 (SO_PEERCRED on Linux,
    // getpeereid on macOS), request dispatch.
    tracing::info!(?socket_path, "IPC server listening");

    // placeholder: daemon 종료까지 대기.
    tokio::signal::ctrl_c().await?;

    tracing::info!("twebd shutting down");
    Ok(())
}
