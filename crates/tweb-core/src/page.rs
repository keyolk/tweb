//! page/pane identity and state.

use serde::{Deserialize, Serialize};
use url::Url;

/// A browser page identifier. Assigned by the engine, opaque.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PageId(pub uuid::Uuid);

impl PageId {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }
}

impl Default for PageId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for PageId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "bpage_{}", self.0)
    }
}

/// A tmux pane identifier. A tmux pane ID such as `%3`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PaneId(pub i32);

impl std::fmt::Display for PaneId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "%{}", self.0)
    }
}

/// The page state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageSnapshot {
    pub page_id: PageId,
    pub url: Url,
    pub title: String,
    pub status: PageStatus,
    /// Semantic refs derived from accessibility/DOM (for agent automation).
    pub refs: Vec<SemanticRef>,
}

/// The page lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PageStatus {
    Loading,
    Loaded,
    Error,
    Crashed,
}

/// A semantic ref for agent automation. Tied to a document generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticRef {
    /// In the form `d1-n13`. Expires when the document generation changes.
    pub ref_id: String,
    pub role: String,
    pub tag: String,
    pub text: String,
}
