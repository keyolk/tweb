//! ProfileManager — manages one persistent profile per session.
//!
//! DESIGN.md section 6.2. The default profile key = hash(tmux server identity, session ID).
//! Renaming a session or reordering windows must not change the profile identity.

use tweb_core::profile::{BrowserProfile, ProfileId, ProfileStore};

/// ProfileManager. Delegates to a ProfileStore.
pub struct ProfileManager {
    store: Box<dyn ProfileStore>,
}

impl ProfileManager {
    pub fn new(store: Box<dyn ProfileStore>) -> Self {
        Self { store }
    }

    /// Computes the profile ID for a session.
    /// hash(tmux server identity, session ID).
    pub fn profile_id_for(tmux_server_id: &str, session_id: &str) -> ProfileId {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        tmux_server_id.hash(&mut hasher);
        session_id.hash(&mut hasher);
        ProfileId(format!("{:016x}", hasher.finish()))
    }

    /// Fetches or creates a profile.
    pub async fn get_or_create(&self, id: &ProfileId) -> anyhow::Result<BrowserProfile> {
        self.store.get_or_create(id).await.map_err(Into::into)
    }
}
