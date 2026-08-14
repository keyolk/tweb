//! PaneRegistry — which panes are attached, and which registration each one currently is.
//!
//! DESIGN.md section 5.1 promised a page identity built from the tmux pane id *plus* the tmux
//! server identity *plus* a generation, because pane ids get reused. The previous version of this
//! file kept only the pane id as the key and carried the server identity as a passenger field, so
//! two different servers' `%3` collided and a reused id inherited the dead pane's entry. This
//! version keys on the pair and makes the generation the thing that decides whose message wins.
//!
//! The scope here is lifecycle only: no url, no visibility, no page state. Those belong to the
//! engine boundary, which is being measured separately, and a supervisor that cannot compile
//! without knowing the answer is not the slice every candidate architecture shares.

use crate::protocol::{Generation, PaneKey, PaneReport};
use parking_lot::Mutex;
use std::collections::HashMap;
use tweb_core::page::PageId;

/// One live registration of one pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registration {
    pub key: PaneKey,
    pub page_id: PageId,
    pub generation: Generation,
    /// The frontend's pid. Diagnostics only: liveness is the held connection, never this number.
    pub pid: u32,
    pub attached_at_ms: u64,
}

impl Registration {
    pub fn report(&self) -> PaneReport {
        PaneReport {
            pane: self.key.pane.to_string(),
            tmux_server: self.key.tmux_server.clone(),
            generation: self.generation,
            page: self.page_id.to_string(),
            pid: self.pid,
            attached_at_ms: self.attached_at_ms,
        }
    }
}

/// What an attach did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachOutcome {
    pub registration: Registration,
    /// The registration this attach displaced, if the pane id was in use. Present exactly when a
    /// pane id was reused (or a frontend re-attached) before the old one was reaped.
    pub superseded: Option<Registration>,
}

/// Whether a lifecycle message tagged with `incoming` still applies to `current`.
///
/// This is the whole reason a generation exists. A pane whose frontend died and was replaced has
/// a live registration and a dead one; the dead one's detach — or its connection closing, which
/// arrives at an unpredictable moment — must not take the live one down with it.
pub fn generation_is_current(current: Option<&Registration>, incoming: Generation) -> bool {
    current.is_some_and(|entry| entry.generation == incoming)
}

/// Whether a closing connection should reap the registration it created.
///
/// Same rule as `generation_is_current`, named separately because the call site reads as a
/// question about reaping and the two could plausibly diverge later (a grace period, say).
pub fn should_reap(current: Option<&Registration>, closing: Generation) -> bool {
    generation_is_current(current, closing)
}

#[derive(Default)]
struct State {
    panes: HashMap<PaneKey, Registration>,
    /// Never reset, never reused, shared across all panes. A per-pane counter would restart at
    /// zero when the last registration for a pane was reaped, and a stale message from before
    /// that point would then look current.
    next_generation: u64,
}

/// The registry. Thread-safe; the lock is never held across an await.
#[derive(Default)]
pub struct PaneRegistry {
    inner: Mutex<State>,
}

impl PaneRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a pane, displacing any existing registration for the same key.
    pub fn attach(&self, key: PaneKey, pid: u32, attached_at_ms: u64) -> AttachOutcome {
        let mut state = self.inner.lock();
        state.next_generation += 1;
        let registration = Registration {
            key: key.clone(),
            page_id: PageId::new(),
            generation: Generation(state.next_generation),
            pid,
            attached_at_ms,
        };
        let superseded = state.panes.insert(key, registration.clone());
        AttachOutcome {
            registration,
            superseded,
        }
    }

    /// Removes a pane's registration if `generation` is the one currently registered.
    ///
    /// Returns the removed registration, or `None` when the message was stale — which is a normal
    /// outcome, not an error: it is what happens every time a superseded frontend finally dies.
    pub fn detach(&self, key: &PaneKey, generation: Generation) -> Option<Registration> {
        let mut state = self.inner.lock();
        if !should_reap(state.panes.get(key), generation) {
            return None;
        }
        state.panes.remove(key)
    }

    pub fn get(&self, key: &PaneKey) -> Option<Registration> {
        self.inner.lock().get_cloned(key)
    }

    /// Every attached pane, ordered by registration so `list` output is stable between calls.
    pub fn list(&self) -> Vec<Registration> {
        let mut all: Vec<Registration> = self.inner.lock().panes.values().cloned().collect();
        all.sort_by_key(|entry| entry.generation);
        all
    }

    pub fn len(&self) -> usize {
        self.inner.lock().panes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The highest generation handed out so far.
    pub fn generation_counter(&self) -> Generation {
        Generation(self.inner.lock().next_generation)
    }
}

impl State {
    fn get_cloned(&self, key: &PaneKey) -> Option<Registration> {
        self.panes.get(key).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tweb_core::page::PaneId;

    fn key(pane: i32, server: &str) -> PaneKey {
        PaneKey {
            pane: PaneId(pane),
            tmux_server: server.to_string(),
        }
    }

    #[test]
    fn attach_then_lookup_returns_the_registration() {
        let registry = PaneRegistry::new();
        let outcome = registry.attach(key(3, "srv"), 100, 1_000);
        assert!(outcome.superseded.is_none());
        let found = registry.get(&key(3, "srv")).expect("registered");
        assert_eq!(found, outcome.registration);
        assert_eq!(found.pid, 100);
        assert_eq!(found.attached_at_ms, 1_000);
    }

    #[test]
    fn lookup_of_an_unattached_pane_is_none() {
        let registry = PaneRegistry::new();
        registry.attach(key(3, "srv"), 100, 0);
        assert!(registry.get(&key(4, "srv")).is_none());
    }

    #[test]
    fn the_same_pane_id_on_a_different_tmux_server_is_a_different_pane() {
        let registry = PaneRegistry::new();
        let first = registry.attach(key(3, "srv-a"), 1, 0);
        let second = registry.attach(key(3, "srv-b"), 2, 0);
        assert!(second.superseded.is_none());
        assert_eq!(registry.len(), 2);
        assert_ne!(first.registration.page_id, second.registration.page_id);
    }

    #[test]
    fn generations_are_unique_across_panes() {
        let registry = PaneRegistry::new();
        let a = registry.attach(key(3, "srv"), 1, 0);
        let b = registry.attach(key(4, "srv"), 2, 0);
        assert_ne!(a.registration.generation, b.registration.generation);
        assert!(a.registration.generation < b.registration.generation);
    }

    #[test]
    fn reattaching_a_reused_pane_id_supersedes_and_bumps_the_generation() {
        let registry = PaneRegistry::new();
        let first = registry.attach(key(3, "srv"), 1, 0);
        let second = registry.attach(key(3, "srv"), 2, 10);
        let displaced = second.superseded.expect("first registration displaced");
        assert_eq!(displaced, first.registration);
        assert!(second.registration.generation > first.registration.generation);
        assert_eq!(registry.len(), 1);
        assert_eq!(registry.get(&key(3, "srv")).expect("live").pid, 2);
    }

    #[test]
    fn a_reused_pane_id_gets_a_fresh_page_id() {
        let registry = PaneRegistry::new();
        let first = registry.attach(key(3, "srv"), 1, 0);
        let second = registry.attach(key(3, "srv"), 2, 0);
        assert_ne!(first.registration.page_id, second.registration.page_id);
    }

    #[test]
    fn detach_with_the_current_generation_removes_the_pane() {
        let registry = PaneRegistry::new();
        let attached = registry.attach(key(3, "srv"), 1, 0);
        let removed = registry
            .detach(&key(3, "srv"), attached.registration.generation)
            .expect("removed");
        assert_eq!(removed, attached.registration);
        assert!(registry.is_empty());
    }

    #[test]
    fn a_dead_predecessor_cannot_reap_its_successor() {
        let registry = PaneRegistry::new();
        let first = registry.attach(key(3, "srv"), 1, 0);
        let second = registry.attach(key(3, "srv"), 2, 0);
        // The first frontend's connection closes only now, after the pane id was reused.
        assert!(registry
            .detach(&key(3, "srv"), first.registration.generation)
            .is_none());
        assert_eq!(
            registry.get(&key(3, "srv")).expect("still live"),
            second.registration
        );
    }

    #[test]
    fn detaching_twice_is_a_no_op_not_an_error() {
        let registry = PaneRegistry::new();
        let attached = registry.attach(key(3, "srv"), 1, 0);
        assert!(registry
            .detach(&key(3, "srv"), attached.registration.generation)
            .is_some());
        assert!(registry
            .detach(&key(3, "srv"), attached.registration.generation)
            .is_none());
    }

    #[test]
    fn generation_freed_by_a_reap_is_never_handed_out_again() {
        let registry = PaneRegistry::new();
        let first = registry.attach(key(3, "srv"), 1, 0);
        registry.detach(&key(3, "srv"), first.registration.generation);
        let second = registry.attach(key(3, "srv"), 2, 0);
        assert!(second.registration.generation > first.registration.generation);
    }

    #[test]
    fn list_is_ordered_by_attach_order() {
        let registry = PaneRegistry::new();
        registry.attach(key(9, "srv"), 1, 0);
        registry.attach(key(2, "srv"), 2, 0);
        registry.attach(key(5, "srv"), 3, 0);
        let pids: Vec<u32> = registry.list().iter().map(|entry| entry.pid).collect();
        assert_eq!(pids, vec![1, 2, 3]);
    }

    #[test]
    fn generation_comparison_rejects_stale_and_missing() {
        let registration = Registration {
            key: key(3, "srv"),
            page_id: PageId::new(),
            generation: Generation(5),
            pid: 1,
            attached_at_ms: 0,
        };
        assert!(generation_is_current(Some(&registration), Generation(5)));
        assert!(!generation_is_current(Some(&registration), Generation(4)));
        assert!(!generation_is_current(Some(&registration), Generation(6)));
        assert!(!generation_is_current(None, Generation(5)));
        assert!(should_reap(Some(&registration), Generation(5)));
        assert!(!should_reap(None, Generation(5)));
    }

    #[test]
    fn a_report_names_the_pane_the_way_tmux_does() {
        let registry = PaneRegistry::new();
        let attached = registry.attach(key(3, "/tmp/tmux-501/default,1,0"), 42, 77);
        let report = attached.registration.report();
        assert_eq!(report.pane, "%3");
        assert_eq!(report.tmux_server, "/tmp/tmux-501/default,1,0");
        assert_eq!(report.pid, 42);
        assert_eq!(report.attached_at_ms, 77);
        assert!(report.page.starts_with("bpage_"));
    }
}
