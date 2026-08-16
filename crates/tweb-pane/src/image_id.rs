//! Which Kitty image ids a pane owns.
//!
//! The Kitty image id namespace is **terminal-wide**, not per-process, and a pane owns a whole
//! *range*: `imageId` for the whole frame and `imageId+1 .. imageId+PATCH_ID_COUNT` for its damage
//! patches (`patchIdBase = imageId + 1`, `PATCH_ID_COUNT = 8`, agreed with electron/main.cjs).
//!
//! It used to be `std::process::id()`, which is wrong twice over. Pids are handed out
//! consecutively, so two frontends at 30005 and 30007 put the second one's *base image* inside the
//! first one's patch pool — one pane's damage patch then overwrites the other pane's page, today,
//! with two panes in one terminal. And under a hosted engine there is no per-pane pid to derive
//! from at all: one process serves N panes.
//!
//! So an id is allocated from the pane's **identity** rather than from whoever happens to be
//! computing it, and pools are spaced by [`STRIDE`] rather than merely being distinct. Deriving it
//! from identity also means a pane that relaunches lands on the same pool and cleans up after its
//! own predecessor instead of stranding an image nothing will ever delete.

/// How many patch ids follow the base. Mirrors `PATCH_ID_COUNT` in electron/main.cjs.
pub const PATCH_ID_COUNT: u32 = 8;

/// How far apart two panes' bases are placed.
///
/// A pane occupies 9 ids (`imageId` plus 8 patches), so anything above that separates them. 16 is
/// used rather than 9 so the ranges stay legible in a terminal's image table when reading it by
/// hand, and so a later increase in [`PATCH_ID_COUNT`] does not silently start overlapping.
pub const STRIDE: u32 = 16;

/// Where allocated ids begin.
///
/// Deliberately far above any pid: a legacy per-pane engine still derives its id from
/// `std::process::id()`, and on this platform that is a five-to-six digit number. Starting at 2^29
/// puts every allocated pool out of reach of every pid-derived one, so a hosted pane and a legacy
/// pane in the same terminal cannot collide during the transition.
pub const ORIGIN: u32 = 0x2000_0000;

/// How many distinct pools exist before ids wrap.
///
/// Bounded so `ORIGIN + slot * STRIDE + PATCH_ID_COUNT` stays under 2^31 — some terminals treat the
/// id as a signed value, and an id that flips sign is one that gets rejected or, worse, clamped
/// onto somebody else's.
pub const SLOTS: u32 = (0x7FFF_FFFF - ORIGIN - PATCH_ID_COUNT) / STRIDE;

/// The base image id for a pane.
///
/// `tmux_server` and `pane` are the same identity the supervisor keys on, so the daemon and the
/// frontend compute the same answer without having to exchange one. `fallback` disambiguates the
/// case where there is no tmux identity at all: outside tmux every pane looks like `("", "%0")`,
/// and two bare-terminal panes hashing to the same slot would collide *exactly* — worse than the
/// adjacent-pid problem this replaces. The caller passes its pid there, which is unique among
/// live processes and is all that case needs.
pub fn base_for(tmux_server: &str, pane: &str, fallback: u32) -> u32 {
    let slot = if tmux_server.is_empty() {
        hash(&format!("{pane}\u{1}{fallback}"))
    } else {
        hash(&format!("{tmux_server}\u{1}{pane}"))
    };
    ORIGIN + (slot % u64::from(SLOTS)) as u32 * STRIDE
}

/// FNV-1a, written out rather than taken from `DefaultHasher`.
///
/// The mapping from a pane to its pool is a *persistent* property — a relaunched pane reusing its
/// predecessor's ids is what makes it clean up the stranded image — and `DefaultHasher`'s output is
/// explicitly not stable across std releases. A toolchain upgrade must not silently reshuffle every
/// pane onto a different pool.
fn hash(text: &str) -> u64 {
    let mut value: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        value ^= u64::from(*byte);
        value = value.wrapping_mul(0x100_0000_01b3);
    }
    value
}

/// The ids a pane owns, base first. Used by the teardown path, which has to delete the patches as
/// well as the whole frame — deleting only the base leaves strips of a page that is gone.
pub fn owned_ids(base: u32) -> impl Iterator<Item = u32> {
    (0..=PATCH_ID_COUNT).map(move |offset| base + offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    // THE DEFECT. Two frontends at adjacent pids put the second one's base image inside the first
    // one's patch pool, and the id namespace is terminal-wide, so one pane's damage patch
    // overwrites the other pane's page.
    #[test]
    fn two_panes_never_land_inside_each_others_patch_pool() {
        let a = base_for("/tmp/tmux-501/default,1", "%5", 30005);
        let b = base_for("/tmp/tmux-501/default,1", "%7", 30007);
        assert_ne!(a, b);
        assert!(
            a.abs_diff(b) > PATCH_ID_COUNT,
            "{a} and {b} are closer than the {PATCH_ID_COUNT} ids a pane owns"
        );
    }

    // The property the pid scheme could not have: not merely distinct, but spaced. Every pair over
    // a realistic pane population is at least a stride apart.
    #[test]
    fn every_pair_of_panes_is_at_least_a_stride_apart() {
        let bases: Vec<u32> = (0..200)
            .map(|id| base_for("/tmp/tmux-501/default,1", &format!("%{id}"), 0))
            .collect();
        let unique: HashSet<u32> = bases.iter().copied().collect();
        assert_eq!(unique.len(), bases.len(), "two panes share a pool");
        let mut sorted = bases.clone();
        sorted.sort_unstable();
        for pair in sorted.windows(2) {
            assert!(
                pair[1] - pair[0] >= STRIDE,
                "{} and {} are under a stride apart",
                pair[0],
                pair[1]
            );
        }
    }

    // A pane that relaunches must reuse its own pool: its predecessor's image is still placed on
    // the terminal, and only a process addressing the same id can delete it.
    #[test]
    fn the_same_pane_always_gets_the_same_pool() {
        let first = base_for("/tmp/tmux-501/default,1", "%3", 111);
        let second = base_for("/tmp/tmux-501/default,1", "%3", 999);
        assert_eq!(
            first, second,
            "the pid must not be part of a tmux pane's id"
        );
    }

    // The same pane id on two tmux servers is two different panes — that is why the server is half
    // the supervisor's key — so it must be two different pools.
    #[test]
    fn the_same_pane_id_on_two_servers_gets_two_pools() {
        let a = base_for("/tmp/tmux-501/default,1", "%0", 0);
        let b = base_for("/tmp/tmux-501/other,2", "%0", 0);
        assert_ne!(a, b);
    }

    // Outside tmux every pane looks like ("", "%0"). Without the fallback in the hash, two bare
    // terminals would collide exactly, which is worse than the adjacent-pid case being replaced.
    #[test]
    fn without_a_tmux_identity_the_fallback_separates_panes() {
        let a = base_for("", "%0", 30005);
        let b = base_for("", "%0", 30007);
        assert_ne!(a, b);
        assert!(a.abs_diff(b) > PATCH_ID_COUNT);
    }

    // A legacy per-pane engine still derives its id from its pid. Every allocated pool has to sit
    // out of reach of every pid, or the transition collides with itself.
    #[test]
    fn allocated_pools_are_far_above_any_pid() {
        for pane in 0..500 {
            let base = base_for("/tmp/tmux-501/default,1", &format!("%{pane}"), 0);
            assert!(base >= ORIGIN, "{base} is in pid territory");
            // Some terminals read the id as signed; an id that flips sign is rejected or clamped.
            assert!(base + PATCH_ID_COUNT < 0x7FFF_FFFF, "{base} overflows");
        }
    }

    #[test]
    fn a_pane_owns_its_base_and_every_patch_id() {
        let ids: Vec<u32> = owned_ids(1000).collect();
        assert_eq!(ids.len() as u32, PATCH_ID_COUNT + 1);
        assert_eq!(ids[0], 1000);
        assert_eq!(ids[1], 1001, "patchIdBase is imageId + 1");
        assert_eq!(ids[ids.len() - 1], 1000 + PATCH_ID_COUNT);
    }

    // The mapping is persistent state in disguise: a relaunched pane reuses its predecessor's ids
    // to clean up the stranded image. A std upgrade reshuffling it would break that silently, so
    // the values are pinned here rather than merely asserted to be consistent within a run.
    #[test]
    fn the_hash_is_pinned_so_a_toolchain_upgrade_cannot_reshuffle_pools() {
        assert_eq!(hash(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(hash("a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(hash("foobar"), 0x85944171f73967e8);
    }
}
