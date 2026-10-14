// Per-window session slots, ported from electron/window-session.cjs.
//
// The key used to hash only the tmux window, so two Tauri panes split into one window
// shared one session file and silently overwrote each other's tabs. Each engine now
// claims the lowest slot no live engine holds, exactly as the Electron engine does; see
// window-session.cjs for why a slot rather than the pane id. The hashing is byte-for-byte
// the Electron scheme, and the old Tauri key — socket, server start, window id — is the
// Electron "legacy" key, so a session already on disk is still found by slot 0.

use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

// Matches MAX_SESSION_SLOTS: enough for any real window, small enough not to spin.
const MAX_SESSION_SLOTS: u32 = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WindowIdentity {
    pub socket_path: String,
    pub server_started_at: String,
    pub session: String,
    pub window_id: String,
    pub window_index: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SessionKeys {
    pub primary: String,
    pub legacy: Option<String>,
}

#[derive(Debug)]
pub(crate) struct SlotClaim {
    pub slot: u32,
    pub keys: SessionKeys,
    pub claim_path: Option<PathBuf>,
}

fn session_key(parts: &[&str]) -> String {
    let digest = Sha256::digest(parts.join("\0").as_bytes());
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn window_session_keys(identity: &WindowIdentity, slot: u32) -> SessionKeys {
    let slot_part = format!("slot{slot}");
    let mut parts = vec![
        "v2",
        identity.socket_path.as_str(),
        identity.session.as_str(),
        identity.window_index.as_str(),
    ];
    // Appended rather than always present, so slot 0 hashes the same four parts Electron does.
    if slot > 0 {
        parts.push(&slot_part);
    }
    let primary = session_key(&parts);
    // Only the window's first pane may inherit the pre-slot file; offering it to slot 1
    // would hand a second pane a copy of the first pane's tabs.
    let legacy = (slot == 0).then(|| {
        session_key(&[
            &identity.socket_path,
            &identity.server_started_at,
            &identity.window_id,
        ])
    });
    SessionKeys {
        legacy: legacy.filter(|legacy| *legacy != primary),
        primary,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Claim {
    pid: i32,
    pane: Option<String>,
}

fn parse_claim(text: &str) -> Option<Claim> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let pid = value.get("pid")?.as_i64()?;
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return None;
    }
    let pane = value
        .get("pane")
        .and_then(|pane| pane.as_str())
        .filter(|pane| !pane.is_empty())
        .map(str::to_owned);
    Some(Claim {
        pid: pid as i32,
        pane,
    })
}

// A claim with no pane recorded matches on pid alone, so an older writer's live claim
// is not orphaned.
fn owned_by(claim: Option<&Claim>, pid: i32, pane: Option<&str>) -> bool {
    claim.is_some_and(|claim| {
        claim.pid == pid
            && claim
                .pane
                .as_deref()
                .is_none_or(|owner| Some(owner) == pane)
    })
}

// EPERM means the process exists and belongs to someone else; only ESRCH is gone.
// Reading EPERM as dead would let a second pane take a live pane's slot.
fn process_alive(pid: i32) -> bool {
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn read_claim(path: &Path) -> Option<Claim> {
    parse_claim(&fs::read_to_string(path).ok()?)
}

// The exclusive create is the arbitration: it fails instead of truncating when another
// engine got there first.
fn create_claim(path: &Path, text: &str) -> bool {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .is_ok()
}

fn take_slot(path: &Path, mine: &str, pid: i32, pane: Option<&str>) -> bool {
    if create_claim(path, mine) {
        return owned_by(read_claim(path).as_ref(), pid, pane);
    }
    let existing = read_claim(path);
    if owned_by(existing.as_ref(), pid, pane) {
        return true;
    }
    if existing
        .as_ref()
        .is_some_and(|claim| process_alive(claim.pid))
    {
        return false;
    }
    let _ = fs::remove_file(path);
    // Read back after the create: two engines racing on one stale slot can both create,
    // and the readback settles which of them won.
    create_claim(path, mine) && owned_by(read_claim(path).as_ref(), pid, pane)
}

pub(crate) fn claim_slot(
    identity: &WindowIdentity,
    directory: &Path,
    pane: Option<&str>,
) -> SlotClaim {
    let pid = std::process::id() as i32;
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    let mine = format!(
        "{}\n",
        serde_json::json!({ "pane": pane, "pid": pid, "at": at })
    );
    for slot in 0..MAX_SESSION_SLOTS {
        let keys = window_session_keys(identity, slot);
        let claim_path = directory.join(format!("{}.claim", keys.primary));
        if take_slot(&claim_path, &mine, pid, pane) {
            return SlotClaim {
                slot,
                keys,
                claim_path: Some(claim_path),
            };
        }
    }
    // Every slot looks held: fall back to the old shared slot 0 rather than no session.
    SlotClaim {
        slot: 0,
        keys: window_session_keys(identity, 0),
        claim_path: None,
    }
}

// Only the process (and pane) named in a claim may delete it; deleting a sibling's claim
// would hand a live pane's session to another pane.
pub(crate) fn release_slot(claim_path: &Path, pane: Option<&str>) {
    let pid = std::process::id() as i32;
    if owned_by(read_claim(claim_path).as_ref(), pid, pane) {
        let _ = fs::remove_file(claim_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> WindowIdentity {
        WindowIdentity {
            socket_path: "/tmp/tmux-501/default".into(),
            server_started_at: "1760000000".into(),
            session: "main".into(),
            window_id: "@3".into(),
            window_index: "2".into(),
        }
    }

    #[test]
    fn slot_keys_match_the_electron_hash() {
        // Literal outputs of electron/window-session.cjs `windowSessionKeys` for the same
        // identity, so both engines find the same file for the same pane position.
        let zero = window_session_keys(&identity(), 0);
        assert_eq!(zero.primary, "1cfa7448f58399f44f1bea79");
        assert_eq!(zero.legacy.as_deref(), Some("0720d19352fd15bc5ff22a0f"));
        let one = window_session_keys(&identity(), 1);
        assert_eq!(one.primary, "11b1b455e2b68bd6478333cb");
        assert_eq!(one.legacy, None);
        assert_eq!(zero.primary.len(), 24);
    }

    #[test]
    fn two_panes_in_one_window_get_different_slots() {
        let directory = tempdir();
        let first = claim_slot(&identity(), &directory, Some("%1"));
        let second = claim_slot(&identity(), &directory, Some("%2"));
        assert_eq!((first.slot, second.slot), (0, 1));
        assert_ne!(first.keys.primary, second.keys.primary);
        // Re-claiming for the same pane is idempotent rather than a slot leak.
        assert_eq!(claim_slot(&identity(), &directory, Some("%1")).slot, 0);

        release_slot(first.claim_path.as_deref().unwrap(), Some("%2"));
        assert!(
            first.claim_path.as_ref().unwrap().exists(),
            "a sibling must not release it"
        );
        release_slot(first.claim_path.as_deref().unwrap(), Some("%1"));
        assert!(!first.claim_path.as_ref().unwrap().exists());
        assert_eq!(claim_slot(&identity(), &directory, Some("%3")).slot, 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_dead_owner_frees_its_slot() {
        let directory = tempdir();
        let keys = window_session_keys(&identity(), 0);
        // pid i32::MAX does not exist, so kill(…, 0) answers ESRCH.
        fs::write(
            directory.join(format!("{}.claim", keys.primary)),
            format!("{{\"pid\":{},\"pane\":\"%9\"}}\n", i32::MAX),
        )
        .unwrap();
        assert_eq!(claim_slot(&identity(), &directory, Some("%1")).slot, 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn parses_only_usable_claims() {
        assert_eq!(parse_claim("{\"pid\":0}"), None);
        assert_eq!(parse_claim("not json"), None);
        assert_eq!(
            parse_claim("{\"pid\":12,\"pane\":\"\"}"),
            Some(Claim {
                pid: 12,
                pane: None
            })
        );
    }

    fn tempdir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("tweb-slot-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
