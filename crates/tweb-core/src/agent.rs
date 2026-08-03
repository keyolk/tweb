//! AgentBridge — agent 전달 추상.
//!
//! ClaudeCode/Codex/Generic/ShellInbox가 각각 구현.
//! DESIGN.md 섹션 12.6, DETAIL.md 섹션 9.2.

use crate::resource::ResourceBroker;
use crate::resource::ResourceDescriptor;
use async_trait::async_trait;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("agent not found: {0}")]
    NotFound(String),
    #[error("agent not alive: {0}")]
    NotAlive(String),
    #[error("delivery failed: {0}")]
    DeliveryFailed(String),
    #[error("agent: {0}")]
    Other(String),
}

pub type AgentResult<T> = Result<T, AgentError>;

/// agent가 받을 수 있는 resource kind/mime.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentCapability {
    pub accepted_kinds: Vec<ResourceKind>,
    pub accepted_mime_types: Vec<String>,
    pub max_inline_size: usize,
    pub supports_direct_attachment: bool,
}

/// resource 종류 (DESIGN.md 섹션 12.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    BrowserState,
    SemanticSnapshot,
    ElementContext,
    VisualCapture,
    TextContext,
    DiagnosticTrace,
    NetworkResource,
    BrowserFile,
    WorkspaceFile,
    ClipboardPayload,
}

/// 전달 상태.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Delivered,
    Pending,
    Rejected,
}

/// agent endpoint (DESIGN.md 섹션 12.6).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentEndpoint {
    pub agent_id: String,
    pub pane: crate::page::PaneId,
    pub provider: String,
    pub working_directory: String,
    pub host_id: String,
    pub capability: AgentCapability,
}

/// AgentBridge trait.
/// 구현체: ClaudeCodeBridge, CodexBridge, GenericTerminalAgentBridge, ShellInboxBridge.
#[async_trait]
pub trait AgentBridge: Send + Sync {
    /// agent가 받을 수 있는 capability.
    fn capability(&self) -> &AgentCapability;

    /// resource 전달.
    async fn deliver(
        &self,
        resource: &ResourceDescriptor,
        broker: &dyn ResourceBroker,
    ) -> AgentResult<DeliveryStatus>;

    /// agent alive 확인.
    async fn is_alive(&self) -> bool;
}
