//! PageRegistry — tmux pane ID ↔ browser page 매핑.
//!
//! DESIGN.md 섹션 5.1. BrowserPageID를 tmux pane ID만으로 만들지 않고
//! tmux server identity와 opaque generation을 함께 저장 (pane ID 재사용 대비).

use parking_lot::Mutex;
use std::collections::HashMap;
use tweb_core::page::{PageId, PaneId};

/// pane ↔ page 매핑 entry.
#[derive(Debug, Clone)]
pub struct PageEntry {
    pub page_id: PageId,
    pub pane: PaneId,
    /// tmux server identity (pane ID 재사용 대비).
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

    /// pane에 page 등록.
    pub fn register(&self, entry: PageEntry) {
        let mut inner = self.inner.lock();
        inner.insert(entry.pane, entry);
    }

    /// pane의 page 등록 해제.
    pub fn unregister(&self, pane: &PaneId) -> Option<PageEntry> {
        let mut inner = self.inner.lock();
        inner.remove(pane)
    }

    /// pane의 page 조회.
    pub fn get(&self, pane: &PaneId) -> Option<PageEntry> {
        self.inner.lock().get(pane).cloned()
    }

    /// pane의 가시성 변경.
    pub fn set_visible(&self, pane: &PaneId, visible: bool) {
        if let Some(entry) = self.inner.lock().get_mut(pane) {
            entry.visible = visible;
        }
    }

    /// 모든 page 목록.
    pub fn list(&self) -> Vec<PageEntry> {
        self.inner.lock().values().cloned().collect()
    }
}
