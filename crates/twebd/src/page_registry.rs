//! PageRegistry — the tmux pane ID ↔ browser page mapping.
//!
//! DESIGN.md section 5.1. A BrowserPageID is not built from the tmux pane ID alone; the tmux server
//! identity and an opaque generation are stored alongside it (pane IDs get reused).

use parking_lot::Mutex;
use std::collections::HashMap;
use tweb_core::page::{PageId, PaneId};

/// A pane ↔ page mapping entry.
#[derive(Debug, Clone)]
pub struct PageEntry {
    pub page_id: PageId,
    pub pane: PaneId,
    /// tmux server identity (pane IDs get reused).
    pub tmux_server_id: String,
    pub url: String,
    pub visible: bool,
}

/// PageRegistry. thread-safe.
#[derive(Default)]
pub struct PageRegistry {
    inner: Mutex<HashMap<PaneId, PageEntry>>,
}

impl PageRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a page for a pane.
    pub fn register(&self, entry: PageEntry) {
        let mut inner = self.inner.lock();
        inner.insert(entry.pane, entry);
    }

    /// Unregisters a pane's page.
    pub fn unregister(&self, pane: &PaneId) -> Option<PageEntry> {
        let mut inner = self.inner.lock();
        inner.remove(pane)
    }

    /// Looks up a pane's page.
    pub fn get(&self, pane: &PaneId) -> Option<PageEntry> {
        self.inner.lock().get(pane).cloned()
    }

    /// Changes a pane's visibility.
    pub fn set_visible(&self, pane: &PaneId, visible: bool) {
        if let Some(entry) = self.inner.lock().get_mut(pane) {
            entry.visible = visible;
        }
    }

    /// Every page.
    pub fn list(&self) -> Vec<PageEntry> {
        self.inner.lock().values().cloned().collect()
    }
}
