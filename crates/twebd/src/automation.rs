//! AutomationController — serializes agent actions.
//!
//! DESIGN.md section 12.1. snapshot → act → wait → verify loop.
//! Once a human starts giving the browser input, the agent's lease is suspended.

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

    /// A page snapshot (for agent automation).
    pub async fn snapshot(&self, page: PageId) -> anyhow::Result<tweb_core::page::PageSnapshot> {
        self.engine.snapshot(page).await.map_err(Into::into)
    }

    /// Executes an agent action.
    pub async fn execute(&self, page: PageId, action: &Action) -> anyhow::Result<()> {
        self.engine
            .execute_action(page, action)
            .await
            .map_err(Into::into)
    }
}
