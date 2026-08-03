//! ProfileManager — session별 persistent profile 관리.
//!
//! DESIGN.md 섹션 6.2. 기본 profile key = hash(tmux server identity, session ID).
//! session rename이나 window reorder로 profile identity가 바뀌지 않아야 함.

use tweb_core::profile::{BrowserProfile, ProfileId, ProfileStore};

/// ProfileManager. ProfileStore를 위임.
pub struct ProfileManager {
    store: Box<dyn ProfileStore>,
}

impl ProfileManager {
    pub fn new(store: Box<dyn ProfileStore>) -> Self {
        Self { store }
    }

    /// session에 대한 profile ID 계산.
    /// hash(tmux server identity, session ID).
    pub fn profile_id_for(tmux_server_id: &str, session_id: &str) -> ProfileId {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        tmux_server_id.hash(&mut hasher);
        session_id.hash(&mut hasher);
        ProfileId(format!("{:016x}", hasher.finish()))
    }

    /// profile 가져오기 또는 생성.
    pub async fn get_or_create(&self, id: &ProfileId) -> anyhow::Result<BrowserProfile> {
        self.store.get_or_create(id).await.map_err(Into::into)
    }
}
