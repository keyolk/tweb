//! page/pane identity와 상태.

use serde::{Deserialize, Serialize};
use url::Url;

/// browser page 식별자. engine이 할당, opaque.
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

/// tmux pane 식별자. `%3` 같은 tmux pane ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PaneId(pub i32);

impl std::fmt::Display for PaneId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "%{}", self.0)
    }
}

/// page 상태.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageSnapshot {
    pub page_id: PageId,
    pub url: Url,
    pub title: String,
    pub status: PageStatus,
    /// accessibility/DOM 기반 semantic ref (agent automation용).
    pub refs: Vec<SemanticRef>,
}

/// page lifecycle 상태.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PageStatus {
    Loading,
    Loaded,
    Error,
    Crashed,
}

/// agent automation용 semantic ref. document generation에 종속.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticRef {
    /// `d1-n13` 형태. document generation이 바뀌면 만료.
    pub ref_id: String,
    pub role: String,
    pub tag: String,
    pub text: String,
}
