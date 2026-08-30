"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  abandonedClaimFiles,
  claimIsReleasable,
  claimWindowSessionSlot,
  isRestorableUrl,
  normalizeWindowSession,
  parseSlotClaim,
  slotClaimIsStale,
  windowSessionForSave,
  windowSessionKeys,
  MAX_SESSION_SLOTS,
} = require("./window-session.cjs");

const tmuxIdentity = {
  socketPath: "/private/tmp/tmux-502/default",
  serverStartedAt: "100",
  session: "work",
  windowId: "@7",
  windowIndex: "3",
};

test("the primary session key survives a tmux server restart", () => {
  const before = windowSessionKeys(tmuxIdentity);
  const after = windowSessionKeys({
    ...tmuxIdentity,
    serverStartedAt: "200",
    windowId: "@1",
  });
  assert.equal(before.primary, after.primary);
  assert.notEqual(before.legacy, after.legacy);
});

test("session names and window slots keep independent state", () => {
  const original = windowSessionKeys(tmuxIdentity).primary;
  assert.notEqual(original, windowSessionKeys({ ...tmuxIdentity, session: "other" }).primary);
  assert.notEqual(original, windowSessionKeys({ ...tmuxIdentity, windowIndex: "4" }).primary);
});

// The owner has real sessions on disk written by the pre-slot key. Slot 0 hashing to
// anything else abandons them silently, so the literal is the guarantee — if a change
// to the key derivation moves it, this fails rather than the user's tabs disappearing.
test("slot 0 reproduces the pre-slot key byte for byte", () => {
  assert.equal(windowSessionKeys(tmuxIdentity, 0).primary, "67cccc8a58f215f2dbe0ec1f");
  assert.equal(windowSessionKeys(tmuxIdentity).primary, "67cccc8a58f215f2dbe0ec1f");
  assert.equal(windowSessionKeys(tmuxIdentity, 0).legacy, "0133914bdcf31e0937fdebc5");
});

test("two panes in one window get different session files", () => {
  const zero = windowSessionKeys(tmuxIdentity, 0).primary;
  const one = windowSessionKeys(tmuxIdentity, 1).primary;
  const two = windowSessionKeys(tmuxIdentity, 2).primary;
  assert.notEqual(zero, one);
  assert.notEqual(one, two);
});

// Offering the pre-slot file to a second pane would hand it a copy of the first pane's
// tabs — the collision this change removes, wearing a different hat.
test("only the window's first pane may inherit the pre-slot session", () => {
  assert.equal(windowSessionKeys(tmuxIdentity, 1).legacy, null);
  assert.equal(windowSessionKeys(tmuxIdentity, 7).legacy, null);
});

test("a nonsense slot yields no keys at all", () => {
  assert.equal(windowSessionKeys(tmuxIdentity, -1), null);
  assert.equal(windowSessionKeys(tmuxIdentity, 1.5), null);
  assert.equal(windowSessionKeys(tmuxIdentity, "x"), null);
});

// === slot claims ====================================================================

function fakeIo({ files = new Map(), livePids = new Set() } = {}) {
  return {
    files,
    readClaim: (path) => (files.has(path) ? files.get(path) : null),
    createClaim: (path, text) => {
      if (files.has(path)) return false;
      files.set(path, text);
      return true;
    },
    removeClaim: (path) => { files.delete(path); },
    isAlive: (pid) => livePids.has(pid),
  };
}

test("the first pane in a window takes slot 0, so existing sessions stay reachable", () => {
  const io = fakeIo();
  const result = claimWindowSessionSlot({
    identity: tmuxIdentity, directory: "/d", pid: 100, paneId: "%1", io,
  });
  assert.equal(result.slot, 0);
  assert.equal(result.claimed, true);
  assert.equal(result.keys.primary, "67cccc8a58f215f2dbe0ec1f");
});

test("a second live pane in the same window is pushed to the next slot", () => {
  const io = fakeIo({ livePids: new Set([100]) });
  claimWindowSessionSlot({ identity: tmuxIdentity, directory: "/d", pid: 100, paneId: "%1", io });
  const second = claimWindowSessionSlot({
    identity: tmuxIdentity, directory: "/d", pid: 200, paneId: "%2", io,
  });
  assert.equal(second.slot, 1);
  assert.equal(second.claimed, true);
  assert.notEqual(second.keys.primary, "67cccc8a58f215f2dbe0ec1f");
});

// The whole point of a slot rather than a pane id: a respawned pane has a new %id but
// must land back on the tabs its predecessor saved.
test("a respawned pane reclaims the dead pane's slot under a new pane id", () => {
  const io = fakeIo({ livePids: new Set([100]) });
  const first = claimWindowSessionSlot({
    identity: tmuxIdentity, directory: "/d", pid: 100, paneId: "%1", io,
  });
  io.isAlive = () => false;
  const respawned = claimWindowSessionSlot({
    identity: tmuxIdentity, directory: "/d", pid: 300, paneId: "%9", io,
  });
  assert.equal(respawned.slot, 0);
  assert.equal(respawned.keys.primary, first.keys.primary);
});

test("re-walking inside one process keeps the slot it already holds", () => {
  const io = fakeIo({ livePids: new Set([100]) });
  const first = claimWindowSessionSlot({
    identity: tmuxIdentity, directory: "/d", pid: 100, paneId: "%1", io,
  });
  const again = claimWindowSessionSlot({
    identity: tmuxIdentity, directory: "/d", pid: 100, paneId: "%1", io,
  });
  assert.equal(again.slot, first.slot);
});

// Two engines racing on the same stale slot both pass the exclusive create, because the
// loser unlinked the winner's fresh claim. The readback is the only thing that settles
// it, so a claim that is not ours by the time we look must not be trusted.
test("a slot stolen between create and readback is not treated as ours", () => {
  const io = fakeIo({ livePids: new Set([999]) });
  const zero = windowSessionKeys(tmuxIdentity, 0).primary;
  const stolen = `/d/${zero}.claim`;
  io.createClaim = (path, text) => {
    if (io.files.has(path)) return false;
    io.files.set(path, path === stolen ? JSON.stringify({ pane: "%9", pid: 999, at: 0 }) : text);
    return true;
  };
  const result = claimWindowSessionSlot({
    identity: tmuxIdentity, directory: "/d", pid: 100, paneId: "%1", io,
  });
  assert.equal(result.slot, 1);
  assert.equal(result.claimed, true);
});

// Degrading to the old shared key beats leaving a pane with no session at all: the
// floor is exactly today's behaviour, never something worse.
test("an exhausted window degrades to unclaimed slot 0", () => {
  const io = fakeIo();
  io.createClaim = () => false;
  io.readClaim = () => JSON.stringify({ pane: "%1", pid: 7, at: 0 });
  io.isAlive = () => true;
  const result = claimWindowSessionSlot({
    identity: tmuxIdentity, directory: "/d", pid: 100, paneId: "%1", io,
  });
  assert.equal(result.slot, 0);
  assert.equal(result.claimed, false);
  assert.equal(result.claimPath, null);
  assert.equal(result.keys.primary, "67cccc8a58f215f2dbe0ec1f");
});

test("the walk is bounded", () => {
  let probes = 0;
  const io = fakeIo();
  io.createClaim = () => { probes += 1; return false; };
  io.readClaim = () => JSON.stringify({ pane: "%1", pid: 7, at: 0 });
  io.isAlive = () => true;
  claimWindowSessionSlot({ identity: tmuxIdentity, directory: "/d", pid: 100, io });
  assert.equal(probes, MAX_SESSION_SLOTS);
});

test("no tmux identity means no slot to claim", () => {
  assert.equal(claimWindowSessionSlot({
    identity: { socketPath: "/s" }, directory: "/d", pid: 100, io: fakeIo(),
  }), null);
});

// EPERM means the process exists and belongs to somebody else. Reading that as dead
// would let a second pane take a LIVE pane's slot — the corrupting direction. The
// syscall itself lives in main.cjs's `processAlive`; what is pinned here is that the
// claim walk asks it and obeys the answer.
test("a slot whose owner we may not signal is still held", () => {
  const io = fakeIo();
  const zero = windowSessionKeys(tmuxIdentity, 0).primary;
  io.files.set(`/d/${zero}.claim`, JSON.stringify({ pane: "%1", pid: 42, at: 0 }));
  // What `processAlive` returns for an EPERM pid.
  io.isAlive = (pid) => pid === 42;
  const result = claimWindowSessionSlot({
    identity: tmuxIdentity, directory: "/d", pid: 100, paneId: "%2", io,
  });
  assert.equal(result.slot, 1);
});

test("an unreadable claim is as good as none", () => {
  assert.equal(parseSlotClaim(null), null);
  assert.equal(parseSlotClaim("not json"), null);
  assert.equal(parseSlotClaim("{}"), null);
  assert.equal(parseSlotClaim(JSON.stringify({ pid: 0 })), null);
  assert.deepEqual(parseSlotClaim(JSON.stringify({ pane: "%3", pid: 9, at: 5 })), {
    pane: "%3", pid: 9, at: 5,
  });
});

// No TTL: a browser pane sits untouched for days, so tenure says nothing about
// liveness. Only the owning process existing does.
test("a claim goes stale by its owner dying, never by age", () => {
  const claim = { pane: "%1", pid: 9, at: 0 };
  assert.equal(slotClaimIsStale(claim, () => true), false);
  assert.equal(slotClaimIsStale(claim, () => false), true);
  assert.equal(slotClaimIsStale(null, () => true), true);
});

// Release is the one path that deletes a file a live pane might be using, so it is pinned to the
// claim's owner: the pid AND the pane. One process used to mean one pane, so the pid was the whole
// answer; a host has N panes and one pid, and pid alone would let one pane release another's slot
// out from under it — the live pane would then be saving into a slot anything could take.
test("release only ever removes our own claim", () => {
  const ours = JSON.stringify({ pane: "%1", pid: 100, at: 0 });
  assert.equal(claimIsReleasable(ours, 100, "%1"), true);
  // Another process: never ours, whatever pane it names.
  assert.equal(claimIsReleasable(JSON.stringify({ pane: "%1", pid: 200, at: 0 }), 100, "%1"), false);
  // Same process, ANOTHER PANE — the host case. Not ours to release.
  assert.equal(claimIsReleasable(ours, 100, "%2"), false);
  assert.equal(claimIsReleasable(null, 100, "%1"), false);
  assert.equal(claimIsReleasable("garbage", 100, "%1"), false);
  // A claim written before panes were recorded matches on pid alone, so an upgrade does not
  // strand a live claim its owner can no longer release.
  assert.equal(claimIsReleasable(JSON.stringify({ pid: 100, at: 0 }), 100, "%1"), true);
});

test("internal blank and placeholder URLs are not restorable", () => {
  assert.equal(isRestorableUrl("about:blank"), false);
  assert.equal(isRestorableUrl("data:text/html,loading"), false);
  assert.equal(isRestorableUrl("https://example.com/path"), true);
});

test("restore drops an internal active tab and selects the next surviving page", () => {
  assert.deepEqual(normalizeWindowSession({
    version: 1,
    activeIndex: 1,
    tabs: [
      { url: "https://one.example", zoom: 0.1 },
      { url: "about:blank", zoom: 0.8 },
      { url: "https://two.example", zoom: 3 },
    ],
  }, 0.8), {
    activeIndex: 1,
    tabs: [
      { url: "https://one.example", zoom: 0.5 },
      { url: "https://two.example", zoom: 2 },
    ],
  });
});

test("restore falls back to the last page when an internal active tab was last", () => {
  assert.deepEqual(normalizeWindowSession({
    version: 1,
    activeIndex: 2,
    tabs: [
      { url: "https://one.example", zoom: 0.8 },
      { url: "https://two.example", zoom: 0.8 },
      { url: "about:blank", zoom: 0.8 },
    ],
  }, 0.8), {
    activeIndex: 1,
    tabs: [
      { url: "https://one.example", zoom: 0.8 },
      { url: "https://two.example", zoom: 0.8 },
    ],
  });
});

test("blank-only state does not replace the last useful session", () => {
  assert.equal(windowSessionForSave([
    { url: "about:blank", zoom: 0.8 },
    { url: "data:text/html,loading", zoom: 0.8 },
  ], 0, 0.8), null);
});

test("save omits internal tabs and remaps the active index", () => {
  assert.deepEqual(windowSessionForSave([
    { url: "about:blank", zoom: 0.8 },
    { url: "https://example.com", zoom: 1.25 },
  ], 0, 0.8), {
    version: 1,
    activeIndex: 0,
    tabs: [{ url: "https://example.com", zoom: 1.25 }],
  });
});


// === Sweeping claims left by engines that are gone ==================================
//
// The reclaim in `takeSlot` only runs for a slot some pane asks for again, and tmux does not
// reuse pane ids — so a claim whose window is gone is reclaimed by nobody. Fifteen such claims
// spanning ten days were measured in a real userData directory, every one naming a dead pid.

const DEAD_PID = 999_000_001;
const LIVE_PID = 999_000_002;
const SELF_PID = 999_000_003;
const aliveOnly = (pid) => pid === LIVE_PID;
const key = (n) => String(n).repeat(24).slice(0, 24);
const claimText = (pid, pane) => JSON.stringify({ pane, pid, at: 1 });

function sweep(files, isAlive = aliveOnly, selfPid = SELF_PID) {
  const names = Object.keys(files);
  return abandonedClaimFiles(names, (name) => parseSlotClaim(files[name]), isAlive, selfPid);
}

test("a claim naming a dead pid is swept", () => {
  const name = `${key(1)}.claim`;
  assert.deepEqual(sweep({ [name]: claimText(DEAD_PID, "%304") }), [name]);
});

// The corrupting direction. Deleting a live pane's claim hands its session to a second pane,
// which is the failure the whole slot mechanism exists to prevent.
test("a claim naming a live pid is left alone", () => {
  const name = `${key(2)}.claim`;
  assert.deepEqual(sweep({ [name]: claimText(LIVE_PID, "%305") }), []);
});

// A host holds N panes on one pid. Sweeping our own claim would delete a sibling pane's slot
// out from under it while this process is still saving into it.
test("our own claim is never swept, dead-looking or not", () => {
  const name = `${key(3)}.claim`;
  assert.deepEqual(sweep({ [name]: claimText(SELF_PID, "%306") }, () => false), []);
});

// A reader can arrive mid-write. An unparseable claim costs a few hundred bytes until the next
// launch; deleting one that turns out to be live costs a pane its session.
test("an unparseable or unreadable claim is left alone", () => {
  const files = {
    [`${key(4)}.claim`]: "{ truncated",
    [`${key(5)}.claim`]: "",
    [`${key(6)}.claim`]: JSON.stringify({ pane: "%307", at: 1 }),
  };
  assert.deepEqual(sweep(files, () => false), []);
});

// Session files, temp files and the frame files the other sweeper owns all live here too.
test("only claim files are considered", () => {
  const files = {
    [`${key(7)}.json`]: claimText(DEAD_PID, "%308"),
    [`${key(8)}.json.${DEAD_PID}.tmp`]: claimText(DEAD_PID, "%309"),
    [`tweb-frame-${DEAD_PID}-1.rgba`]: claimText(DEAD_PID, "%310"),
    "not-a-key.claim": claimText(DEAD_PID, "%311"),
  };
  assert.deepEqual(sweep(files, () => false), []);
});

test("a directory of mixed claims sweeps exactly the dead ones", () => {
  const dead1 = `${key(1)}.claim`;
  const dead2 = `${key(2)}.claim`;
  const files = {
    [dead1]: claimText(DEAD_PID, "%304"),
    [`${key(3)}.claim`]: claimText(LIVE_PID, "%305"),
    [dead2]: claimText(DEAD_PID, "%306"),
    [`${key(4)}.claim`]: claimText(SELF_PID, "%307"),
    [`${key(5)}.json`]: "{}",
  };
  assert.deepEqual(sweep(files).sort(), [dead1, dead2].sort());
});

test("sweeping tolerates a missing or empty directory listing", () => {
  assert.deepEqual(abandonedClaimFiles([], () => null, aliveOnly, SELF_PID), []);
  assert.deepEqual(abandonedClaimFiles(null, () => null, aliveOnly, SELF_PID), []);
});

// The wiring, not the function. Both sweepers are pure and both were correct in isolation; what
// actually failed in the field was that only one of them was ever called. A sweeper nothing
// invokes is the same as no sweeper, and that is invisible to a unit test of the function.
test("startup calls the claim sweeper beside the frame sweeper", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /sweepAbandonedFrameFiles\(\);\n\s*sweepAbandonedClaimFiles\(\);/);
  assert.match(main, /function sweepAbandonedClaimFiles\(\)/);
  assert.match(main, /abandonedClaimFiles\(names, parse, processAlive, process\.pid\)/);
});
