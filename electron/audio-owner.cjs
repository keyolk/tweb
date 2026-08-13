"use strict";

// Which pane is allowed to make noise.
//
// Panes are separate Electron processes, so nothing in Chromium can arbitrate between
// them: two panes playing at once are simply two audio clients, and both are audible.
// Ownership is therefore expressed as a claim file in the shared runtime directory —
// `{pane, pid, at}` — and every instance mutes itself whenever a live foreign claim
// exists. Muting, never pausing: a pane that loses the claim keeps its video running
// and its position, so taking audio back is a keypress rather than a re-seek.
//
// A file is the truth rather than a socket broadcast because the failure that matters
// is `kill -9`: a killed owner sends no release, and the operator note already records
// that its socket file outlives it. So a claim must be judged, not trusted — by the
// owner's pid still existing *and* by the claim having been refreshed recently. Socket
// nudges still exist, but only to make the mute immediate; correctness never depends on
// one arriving, because every instance re-reads the file on a timer regardless.

// A claim not refreshed within this is treated as abandoned. Generous next to the
// heartbeat because the cost of being wrong is asymmetric: too eager and a busy owner
// is talked over, too patient and the pane is briefly silent after a crash.
const CLAIM_TTL_MS = 6000;

// How often the owner rewrites its claim, and how often everyone re-reads it.
const HEARTBEAT_MS = 2000;

// `isCurrentlyAudible()` flaps — buffering, a quiet passage, one of several media
// elements pausing. Releasing on the first silent tick would hand ownership back and
// forth mid-track, so silence has to persist.
const RELEASE_SILENCE_MS = 3000;

/**
 * A claim from the file's contents, or null for anything unusable.
 *
 * Corruption is expected rather than exceptional: the file is rewritten by whichever
 * instance owns audio, and a reader can arrive mid-rename on a filesystem that does not
 * make one. "Unreadable" and "nobody owns audio" deserve the same answer.
 */
function parseClaim(text) {
  let value;
  try {
    value = JSON.parse(String(text));
  } catch (_) {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const pid = Number(value.pid);
  const at = Number(value.at);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isFinite(at) || at <= 0) return null;
  const pane = typeof value.pane === "string" && value.pane ? value.pane : null;
  return { pane, pid, at };
}

/**
 * Whether a claim is too old to obey.
 *
 * Clock skew is not a concern (one host, one clock), but a claim stamped in the future
 * is still refused a free pass: `at > now` would otherwise make a corrupt timestamp an
 * immortal claim that silences every other pane forever.
 */
function claimExpired(claim, now, ttlMs = CLAIM_TTL_MS) {
  if (!claim) return true;
  const age = now - claim.at;
  return age > ttlMs || age < -ttlMs;
}

/**
 * What this instance should do about its own audio.
 *
 * `ownerAlive` is supplied by the caller because liveness is a syscall, not arithmetic —
 * `process.kill(pid, 0)`. Both tests have to pass: a pid can be recycled by an unrelated
 * process, and a hung owner can hold a live pid while its claim goes stale.
 *
 * @returns {{muted: boolean, owner: string|null, mine: boolean, stale: boolean}}
 */
function audioDecision({ claim, selfPid, now, ownerAlive = false, ttlMs = CLAIM_TTL_MS }) {
  const stale = claimExpired(claim, now, ttlMs) || !ownerAlive;
  if (!claim || stale) return { muted: false, owner: null, mine: false, stale: Boolean(claim) };
  const mine = claim.pid === selfPid;
  return { muted: !mine, owner: claim.pane, mine, stale: false };
}

/**
 * Whether the owner should give its claim up.
 *
 * `silentSince` is null while audio is playing, so an owner that is still making noise
 * never releases no matter how long it has held the claim — ownership expires by the
 * process dying, not by tenure.
 */
function shouldReleaseClaim({ silentSince, now, silenceMs = RELEASE_SILENCE_MS }) {
  if (silentSince === null || silentSince === undefined) return false;
  return now - silentSince >= silenceMs;
}

/**
 * Whether the owner's heartbeat is still allowed to rewrite the file.
 *
 * Without this a heartbeat would stamp over a reclaim: pane B presses `m` and writes its
 * own claim, then A's next heartbeat blindly overwrites it and both panes think they own
 * audio. Refreshing only a claim that is still ours makes the reclaim stick, and the
 * loser learns it lost on its next poll.
 */
function heartbeatOwns(claim, selfPid) {
  return Boolean(claim) && claim.pid === selfPid;
}

module.exports = {
  parseClaim,
  claimExpired,
  audioDecision,
  shouldReleaseClaim,
  heartbeatOwns,
  CLAIM_TTL_MS,
  HEARTBEAT_MS,
  RELEASE_SILENCE_MS,
};
