"use strict";

const { openSync, closeSync, unlinkSync, statSync } = require("node:fs");

// A mutex for history.jsonl, held by appenders and rewriters alike.
//
// The file is append-per-visit and rewritten in place by compaction and by the history
// page's delete. A rewrite is read → write temp → rename, and `appendFileSync` resolves the
// path to an inode of its own. An append that resolves the old inode after the rename lands
// in a file nothing will ever read again — the line is simply lost. Both rewrite sites
// already re-read immediately before the rename to carry across whatever arrived, which
// narrows the window but cannot close it: measured on a 900-line file, write plus rename
// spans 0.38-0.68ms during which an append is still invisible.
//
// Carrying arrivals across is the wrong shape for the last window because it is a check,
// and the loss happens after the check. A mutex both sides take is the shape that closes
// it. It costs the append path one create-and-unlink per *visit*, not per frame or per
// keystroke, which is why the hot path can afford to be correct here.

// Long enough to cover a rewrite of a large file on a busy disk (measured: 0.68ms for 900
// lines), short enough that a caller never visibly stalls.
const LOCK_TIMEOUT_MS = 250;
// A holder that died with the lock file in place must not wedge history until the next
// launch. Any lock older than this is assumed abandoned — far above the milliseconds a real
// hold takes, so breaking one in flight is not a case that arises.
const LOCK_STALE_MS = 5_000;

/**
 * Whether a lock file should be treated as abandoned.
 *
 * Pure, so the stale rule is testable without killing a process mid-hold.
 *
 * @param {number} lockMtimeMs mtime of the existing lock file
 * @param {number} now epoch-ms
 * @param {number} [staleMs]
 * @returns {boolean}
 */
function lockIsStale(lockMtimeMs, now, staleMs = LOCK_STALE_MS) {
  if (!Number.isFinite(lockMtimeMs)) return true;
  return now - lockMtimeMs >= staleMs;
}

// Blocking, because every caller is on a synchronous path (`appendFileSync`, `renameSync`)
// and yielding to the event loop mid-hold would let this process's own next append run
// inside its own rewrite.
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * Runs `body` while holding the history lock.
 *
 * The lock is advisory and best effort: if it cannot be acquired within the timeout the body
 * runs anyway. Losing a history line is a smaller harm than refusing to record history at
 * all, and an unacquirable lock means the pre-existing narrow race, not a new failure.
 *
 * @param {string} lockPath
 * @param {() => T} body
 * @returns {T}
 * @template T
 */
function withHistoryLock(lockPath, body) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;
  for (;;) {
    try {
      // "wx" is O_CREAT|O_EXCL: the create either wins or throws, with no window between
      // testing for the file and making it.
      fd = openSync(lockPath, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") break; // An unwritable directory is the caller's problem.
      try {
        if (lockIsStale(statSync(lockPath).mtimeMs, Date.now())) unlinkSync(lockPath);
      } catch (staleError) {
        void staleError; // Another process broke the same stale lock; retry either way.
      }
      if (Date.now() >= deadline) break;
      sleepSync(1);
    }
  }
  try {
    return body();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
        unlinkSync(lockPath);
      } catch (error) {
        void error; // A lock we cannot release goes stale on its own.
      }
    }
  }
}

module.exports = { withHistoryLock, lockIsStale, LOCK_TIMEOUT_MS, LOCK_STALE_MS };
