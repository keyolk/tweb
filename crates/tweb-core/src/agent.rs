//! AgentBridge — the agent delivery abstraction.
//!
//! Implemented separately for ClaudeCode/Codex/Generic/ShellInbox.
//! DESIGN.md section 12.6, DETAIL.md section 9.2.

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

/// The resource kinds/mimes an agent can accept.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentCapability {
    pub accepted_kinds: Vec<ResourceKind>,
    pub accepted_mime_types: Vec<String>,
    pub max_inline_size: usize,
    pub supports_direct_attachment: bool,
}

/// The kinds of resource (DESIGN.md section 12.4).
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

/// The delivery status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Delivered,
    Pending,
    Rejected,
}

/// An agent endpoint (DESIGN.md section 12.6).
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
/// Implementations: ClaudeCodeBridge, CodexBridge, GenericTerminalAgentBridge, ShellInboxBridge.
#[async_trait]
pub trait AgentBridge: Send + Sync {
    /// What this agent is able to accept.
    fn capability(&self) -> &AgentCapability;

    /// Delivers a resource.
    async fn deliver(
        &self,
        resource: &ResourceDescriptor,
        broker: &dyn ResourceBroker,
    ) -> AgentResult<DeliveryStatus>;

    /// Checks whether the agent is alive.
    async fn is_alive(&self) -> bool;
}
