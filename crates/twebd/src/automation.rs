//! AutomationController — agent action 직렬화.
//!
//! DESIGN.md 섹션 12.1. snapshot → act → wait → verify loop.
//! 사람이 browser input을 시작하면 agent lease 일시 중단.

use std::sync::Arc;
use tweb_core::engine::{Action, BrowserEngineAdapter};
use tweb_core::page::PageId;

/// AutomationController.
pub struct AutomationController {
    engine: Arc<dyn BrowserEngineAdapter>,
}

impl AutomationController {
    pub fn new(engine: Arc<dyn BrowserEngineAdapter>) -> Self {
        Self { engine }
    }

    /// page snapshot (agent automation용).
    pub async fn snapshot(&self, page: PageId) -> anyhow::Result<tweb_core::page::PageSnapshot> {
        self.engine.snapshot(page).await.map_err(Into::into)
    }

    /// agent action 실행.
    pub async fn execute(&self, page: PageId, action: &Action) -> anyhow::Result<()> {
        self.engine
            .execute_action(page, action)
            .await
            .map_err(Into::into)
    }
}
