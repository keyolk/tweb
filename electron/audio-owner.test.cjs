"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseClaim,
  claimExpired,
  audioDecision,
  shouldReleaseClaim,
  heartbeatOwns,
  CLAIM_TTL_MS,
  HEARTBEAT_MS,
  RELEASE_SILENCE_MS,
} = require("./audio-owner.cjs");

test("a well-formed claim parses, and everything else is nobody", () => {
  assert.deepEqual(parseClaim('{"pane":"%12","pid":4242,"at":1000}'),
    { pane: "%12", pid: 4242, at: 1000 });
  // A pane outside tmux has no id, but its pid still owns audio.
  assert.deepEqual(parseClaim('{"pane":null,"pid":7,"at":5}'), { pane: null, pid: 7, at: 5 });

  for (const bad of ["", "{", "null", "[]", "3", '{"pid":0,"at":1}', '{"pid":-1,"at":1}',
    '{"pid":4242}', '{"at":1000}', '{"pid":"x","at":1}', '{"pid":4242,"at":0}']) {
    assert.equal(parseClaim(bad), null, `expected ${JSON.stringify(bad)} to parse as nobody`);
  }
});

test("a claim expires by age, and a future timestamp is not immortal", () => {
  const claim = { pane: "%1", pid: 1, at: 10_000 };
  assert.equal(claimExpired(claim, 10_000), false);
  assert.equal(claimExpired(claim, 10_000 + CLAIM_TTL_MS), false);
  assert.equal(claimExpired(claim, 10_001 + CLAIM_TTL_MS), true);
  // A corrupt stamp far in the future must not silence every other pane forever.
  assert.equal(claimExpired(claim, 10_000 - CLAIM_TTL_MS - 1), true);
  assert.equal(claimExpired(null, 10_000), true);
});

// The whole point of the feature: exactly one instance is audible.
test("a live foreign claim mutes us; our own claim does not", () => {
  const now = 10_000;
  const foreign = { pane: "%12", pid: 111, at: now };
  assert.deepEqual(audioDecision({ claim: foreign, selfPid: 222, now, ownerAlive: true }),
    { muted: true, owner: "%12", mine: false, stale: false });

  const ours = { pane: "%9", pid: 222, at: now };
  assert.deepEqual(audioDecision({ claim: ours, selfPid: 222, now, ownerAlive: true }),
    { muted: false, owner: "%9", mine: true, stale: false });
});

// The hard requirement: a killed owner must not leave the survivors muted.
test("a dead or stale owner never keeps anyone muted", () => {
  const now = 10_000;
  const claim = { pane: "%12", pid: 111, at: now };

  // kill -9: the file is still fresh, but the pid is gone.
  const killed = audioDecision({ claim, selfPid: 222, now, ownerAlive: false });
  assert.equal(killed.muted, false);
  assert.equal(killed.stale, true);

  // Hung or suspended: the pid lives, but the claim stopped being refreshed.
  const hung = audioDecision({ claim, selfPid: 222, now: now + CLAIM_TTL_MS + 1, ownerAlive: true });
  assert.equal(hung.muted, false);
  assert.equal(hung.stale, true);

  // Nobody has ever claimed: unmuted, and nothing to report as stale.
  assert.deepEqual(audioDecision({ claim: null, selfPid: 222, now, ownerAlive: false }),
    { muted: false, owner: null, mine: false, stale: false });
});

// A survivor that stays muted because it happens to hold the dead owner's pid number
// would be the same bug wearing a disguise.
test("our own claim still frees us when we are somehow judged dead", () => {
  const now = 10_000;
  const ours = { pane: "%9", pid: 222, at: now };
  assert.equal(audioDecision({ claim: ours, selfPid: 222, now, ownerAlive: false }).muted, false);
});

test("the owner releases only after silence persists", () => {
  const now = 10_000;
  // Still audible: tenure alone never expires a claim.
  assert.equal(shouldReleaseClaim({ silentSince: null, now }), false);
  // A buffering gap or one of several media elements pausing must not hand ownership over.
  assert.equal(shouldReleaseClaim({ silentSince: now - 500, now }), false);
  assert.equal(shouldReleaseClaim({ silentSince: now - RELEASE_SILENCE_MS + 1, now }), false);
  assert.equal(shouldReleaseClaim({ silentSince: now - RELEASE_SILENCE_MS, now }), true);
});

// Without this the heartbeat would stamp over a reclaim and both panes would play.
test("the heartbeat refreshes only a claim that is still ours", () => {
  assert.equal(heartbeatOwns({ pane: "%9", pid: 222, at: 1 }, 222), true);
  assert.equal(heartbeatOwns({ pane: "%12", pid: 111, at: 1 }, 222), false);
  assert.equal(heartbeatOwns(null, 222), false);
});

// The heartbeat has to fit inside the TTL several times over, or an owner that is
// perfectly healthy gets declared stale between two of its own refreshes.
test("the heartbeat runs often enough to keep a live claim fresh", () => {
  assert.ok(HEARTBEAT_MS * 2 < CLAIM_TTL_MS,
    `${HEARTBEAT_MS}ms heartbeat cannot keep a ${CLAIM_TTL_MS}ms claim alive`);
});
