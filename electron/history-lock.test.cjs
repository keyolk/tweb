"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const os = require("node:os");
const path = require("node:path");
const { mkdtempSync, existsSync, writeFileSync, utimesSync } = require("node:fs");
const {
  withHistoryLock,
  lockIsStale,
  LOCK_STALE_MS,
} = require("./history-lock.cjs");

const NOW = 1_700_000_000_000;

function tempLock() {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "tweb-histlock-")), "history.lock");
}

test("a fresh lock is held, not broken", () => {
  assert.equal(lockIsStale(NOW, NOW), false);
  assert.equal(lockIsStale(NOW - 1, NOW), false);
  assert.equal(lockIsStale(NOW - LOCK_STALE_MS + 1, NOW), false);
});

test("a lock left by a dead holder is broken rather than wedging history", () => {
  assert.equal(lockIsStale(NOW - LOCK_STALE_MS, NOW), true);
  assert.equal(lockIsStale(NOW - LOCK_STALE_MS * 10, NOW), true);
});

test("an unreadable mtime is treated as abandoned", () => {
  // Refusing to record history forever is the worse failure.
  for (const mtime of [NaN, undefined, null, Infinity]) {
    assert.equal(lockIsStale(mtime, NOW), true);
  }
});

test("the lock file exists during the body and is gone after", () => {
  const lockPath = tempLock();
  let seen = null;
  const result = withHistoryLock(lockPath, () => {
    seen = existsSync(lockPath);
    return "done";
  });
  assert.equal(seen, true);
  assert.equal(result, "done");
  assert.equal(existsSync(lockPath), false);
});

test("a throwing body still releases the lock", () => {
  // Otherwise one failed compaction wedges every later append for LOCK_STALE_MS.
  const lockPath = tempLock();
  assert.throws(() => withHistoryLock(lockPath, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(lockPath), false);
});

test("a stale lock is broken and the body still runs", () => {
  const lockPath = tempLock();
  writeFileSync(lockPath, "");
  const old = (Date.now() - LOCK_STALE_MS * 2) / 1000;
  utimesSync(lockPath, old, old);
  let ran = false;
  withHistoryLock(lockPath, () => { ran = true; });
  assert.equal(ran, true);
  assert.equal(existsSync(lockPath), false);
});

test("a live lock held by someone else does not block the body forever", () => {
  // Advisory and best effort: an unacquirable lock leaves the pre-existing narrow race,
  // which is a smaller harm than refusing to record history at all.
  const lockPath = tempLock();
  writeFileSync(lockPath, "");
  const started = Date.now();
  let ran = false;
  withHistoryLock(lockPath, () => { ran = true; });
  assert.equal(ran, true);
  assert.ok(Date.now() - started < 2000, "should give up well inside the test timeout");
  // Somebody else's lock is left alone — we never acquired it, so we must not release it.
  assert.equal(existsSync(lockPath), true);
});

test("locks nest across sequential calls without leaking state", () => {
  const lockPath = tempLock();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(withHistoryLock(lockPath, () => i), i);
    assert.equal(existsSync(lockPath), false);
  }
});
