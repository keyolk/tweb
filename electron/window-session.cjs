"use strict";

const { createHash } = require("node:crypto");

// === Which saved session belongs to which pane ======================================
//
// The key used to be (socket, session name, window index) with no pane in it, so two
// browser panes split into ONE tmux window hashed to the same file and the last writer
// silently replaced the other's tabs. Measured, not theorised: recomputing the hash by
// hand reproduced the filenames on disk.
//
// Why the key is a per-window SLOT and not the pane id. The obvious fix — put `%7` in
// the key — trades this bug for a worse one. tmux hands a respawned pane a NEW id, so a
// pane-id key restores nothing after the very kill-and-respawn that session restore
// exists for; and tmux REUSES ids, so a later pane inherits a dead stranger's tabs (the
// reason twebd keys panes by `(server, pane id, generation)` instead). A generation
// would fix the inheritance and make the first problem permanent: a generation is
// monotonic, so no restart ever matches the saved key.
//
// A slot is the smallest thing that is stable across a respawn AND distinct between
// concurrent panes: each engine claims the lowest per-window slot no live engine holds.
// One pane in a window is always slot 0, a second concurrent pane is slot 1, and a pane
// that dies frees its slot for its own replacement.
//
// SLOT 0 HASHES EXACTLY AS THE OLD KEY DID. That is a deliberate compatibility
// guarantee, pinned by a byte-for-byte test: every session already on disk stays
// reachable by the first pane in its window, so nothing has to be migrated or
// abandoned. Only the second-and-later pane in a window gets a new file.

// Enough slots that a real tmux window never runs out, small enough that an absurd
// state cannot spin. Exhaustion degrades to slot 0 unclaimed — today's behaviour — and
// never to something worse.
const MAX_SESSION_SLOTS = 32;

function sessionKey(parts) {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

/**
 * The session file keys for a pane holding `slot` in its tmux window.
 *
 * @param {object} identity startup tmux identity
 * @param {number} slot per-window slot; 0 reproduces the pre-slot key byte for byte
 */
function windowSessionKeys(identity, slot = 0) {
  if (!identity?.socketPath || !identity?.session || identity?.windowIndex === undefined) return null;
  const slotNumber = Number(slot);
  if (!Number.isSafeInteger(slotNumber) || slotNumber < 0) return null;
  const parts = [
    "v2",
    identity.socketPath,
    identity.session,
    String(identity.windowIndex),
  ];
  // Appended rather than always present, so slot 0 keeps hashing the old four parts.
  if (slotNumber > 0) parts.push(`slot${slotNumber}`);
  const primary = sessionKey(parts);
  // The pre-v2 key had no slot concept at all, so only the window's first pane may
  // inherit from it. Offering it to slot 1 would hand a second pane a copy of the
  // first pane's tabs — the collision this change removes, in a new costume.
  const legacy = slotNumber === 0 && identity.serverStartedAt && identity.windowId
    ? sessionKey([identity.socketPath, identity.serverStartedAt, identity.windowId])
    : null;
  return { primary, legacy: legacy === primary ? null : legacy };
}

/** Where a slot's claim file lives, beside the session file it guards. */
function slotClaimPath(directory, key) {
  return `${directory}/${key}.claim`;
}

/**
 * A slot claim from the file's contents, or null for anything unusable.
 *
 * An unreadable claim and an absent one deserve the same answer: a reader can arrive
 * mid-write, and a claim nobody can parse cannot be obeyed.
 */
function parseSlotClaim(text) {
  if (text === null || text === undefined) return null;
  let value;
  try {
    value = JSON.parse(String(text));
  } catch (_) {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const pid = Number(value.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const pane = typeof value.pane === "string" && value.pane ? value.pane : null;
  const at = Number.isFinite(Number(value.at)) ? Number(value.at) : 0;
  return { pane, pid, at };
}

/**
 * Whether a claim may be taken over.
 *
 * `isAlive` is injected because liveness is a syscall, not arithmetic. Its contract is
 * the one `main.cjs`'s `processAlive` already implements: EPERM means the process exists
 * and merely belongs to someone else, so only ESRCH counts as gone. Reading EPERM as
 * dead would let a second pane take a LIVE pane's slot, which is the corrupting
 * direction and exactly the bug being fixed.
 *
 * There is no TTL. A browser pane can sit untouched for days, so tenure says nothing
 * about liveness; only the owning process existing does. The residual risk is pid
 * reuse — a dead owner's pid recycled by an unrelated live process makes a free slot
 * look held — and the cost of being wrong that way is a pane starting one slot higher,
 * never two live panes sharing one file.
 */
function slotClaimIsStale(claim, isAlive) {
  if (!claim) return true;
  return !isAlive(claim.pid);
}

function claimOwnedBy(claim, pid) {
  return Boolean(claim) && claim.pid === pid;
}

/**
 * Claims the lowest per-window session slot no live engine holds.
 *
 * All filesystem access is injected so the walk is testable without a disk:
 *   io.readClaim(path)          -> string|null  (null for absent/unreadable)
 *   io.createClaim(path, text)  -> boolean      (exclusive create; false if it exists)
 *   io.removeClaim(path)        -> void
 *   io.isAlive(pid)             -> boolean
 *
 * The create is exclusive and its result is read back before the slot is trusted: two
 * engines racing on the same STALE slot can both pass the create (one unlinks, the other
 * unlinks the winner's fresh file), and the readback is what settles it. If that readback
 * still loses — two engines starting in the same window in the same instant on a slot
 * that just went stale — both land on the same file, which is precisely today's
 * behaviour. The floor is the status quo; there is no state this makes worse.
 *
 * @returns {{slot: number, claimed: boolean, keys: object, claimPath: string|null}|null}
 */
function claimWindowSessionSlot({
  identity,
  directory,
  pid,
  paneId = null,
  now = 0,
  io,
  maxSlots = MAX_SESSION_SLOTS,
}) {
  const zeroKeys = windowSessionKeys(identity, 0);
  if (!zeroKeys) return null;
  const mine = `${JSON.stringify({ pane: paneId, pid, at: now })}\n`;

  for (let slot = 0; slot < maxSlots; slot += 1) {
    const keys = slot === 0 ? zeroKeys : windowSessionKeys(identity, slot);
    const claimPath = slotClaimPath(directory, keys.primary);
    if (takeSlot(claimPath, mine, pid, io)) {
      return { slot, claimed: true, keys, claimPath };
    }
  }

  // Every slot held by something that looks alive. Degrading to an unclaimed slot 0
  // restores the old collision for this pane rather than leaving it with no session at
  // all — the same trade the claim-write failure path takes.
  return { slot: 0, claimed: false, keys: zeroKeys, claimPath: null };
}

function takeSlot(claimPath, mine, pid, io) {
  if (io.createClaim(claimPath, mine)) {
    return claimOwnedBy(parseSlotClaim(io.readClaim(claimPath)), pid);
  }
  const existing = parseSlotClaim(io.readClaim(claimPath));
  // Re-running the walk inside one process must be idempotent, not a slot leak.
  if (claimOwnedBy(existing, pid)) return true;
  if (!slotClaimIsStale(existing, io.isAlive)) return false;
  io.removeClaim(claimPath);
  if (!io.createClaim(claimPath, mine)) return false;
  return claimOwnedBy(parseSlotClaim(io.readClaim(claimPath)), pid);
}

/** Whether an exiting process may delete a claim file — only ever its own. */
function claimIsReleasable(text, pid) {
  return claimOwnedBy(parseSlotClaim(text), pid);
}

function isRestorableUrl(url) {
  return typeof url === "string"
    && url.length > 0
    && url.length <= 2_000_000
    && !/^(?:about|data):/i.test(url);
}

function clampedZoom(zoom, fallback) {
  return Number.isFinite(zoom) ? Math.min(2, Math.max(0.5, zoom)) : fallback;
}

function activeRestoredIndex(entries, activeIndex) {
  if (entries.length === 0) return 0;
  const requested = Number.isInteger(activeIndex) ? Math.max(0, activeIndex) : 0;
  const next = entries.findIndex((entry) => entry.sourceIndex >= requested);
  return next >= 0 ? next : entries.length - 1;
}

function normalizeWindowSession(parsed, defaultZoomFactor) {
  if (parsed?.version !== 1 || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return null;
  const entries = parsed.tabs.slice(0, 50).flatMap((entry, sourceIndex) => {
    if (!entry || !isRestorableUrl(entry.url)) return [];
    return [{ url: entry.url, zoom: clampedZoom(entry.zoom, defaultZoomFactor), sourceIndex }];
  });
  if (entries.length === 0) return null;
  return {
    tabs: entries.map(({ url, zoom }) => ({ url, zoom })),
    activeIndex: activeRestoredIndex(entries, parsed.activeIndex),
  };
}

function windowSessionForSave(tabs, activeIndex, defaultZoomFactor) {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  const entries = tabs.slice(0, 50).flatMap((entry, sourceIndex) => {
    if (!entry || !isRestorableUrl(entry.url)) return [];
    return [{ url: entry.url, zoom: clampedZoom(entry.zoom, defaultZoomFactor), sourceIndex }];
  });
  if (entries.length === 0) return null;
  return {
    version: 1,
    activeIndex: activeRestoredIndex(entries, activeIndex),
    tabs: entries.map(({ url, zoom }) => ({ url, zoom })),
  };
}

module.exports = {
  claimIsReleasable,
  claimWindowSessionSlot,
  isRestorableUrl,
  normalizeWindowSession,
  parseSlotClaim,
  slotClaimIsStale,
  slotClaimPath,
  windowSessionForSave,
  windowSessionKeys,
  MAX_SESSION_SLOTS,
};
