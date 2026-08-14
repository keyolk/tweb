"use strict";

// Whether the engine should still be running.
//
// The engine is a child of the Rust pane frontend, but only by convention: nothing in the
// OS ties their lifetimes together. A frontend that exits cleanly sends SIGTERM, and one
// that is killed cannot — so `kill -9`, a crash, or a lost terminal leaves the engine alive
// with no parent, still painting into a pane that has moved on. Observed in the wild: an
// orphan kept drawing a stale page over two other panes for four hours.
//
// macOS has no PR_SET_PDEATHSIG, so the engine watches instead. Reparenting to init is the
// signal — it is what actually happens to an orphan, it needs no cooperation from the
// parent, and it cannot be faked by a busy process the way an unanswered ping can.

// A parent that has gone means the pane this engine draws for is gone too.
const INIT_PID = 1;

/**
 * Decides whether the engine has been orphaned.
 *
 * @param {number} frontendPid the pid handed over as TWEB_FRONTEND_PID
 * @param {number} parentPid `process.ppid` right now
 * @returns {boolean} true when the frontend is gone and the engine should exit
 */
function isOrphaned(frontendPid, parentPid) {
  const frontend = Number(frontendPid);
  // No frontend pid: the engine was started by hand or by a test. Nothing to watch, and
  // exiting on a guess would kill a legitimately parentless run.
  if (!Number.isSafeInteger(frontend) || frontend <= INIT_PID) return false;
  // Chromium reparents the engine during startup, so `ppid` is not a stable identity — but
  // landing on init specifically is unambiguous, because nothing else adopts a live child.
  return Number(parentPid) === INIT_PID;
}

// A whole frame is written to a file named after the pid that wrote it, and that file is
// removed on exit. An engine that never gets to run its exit path — SIGKILL, a panic, the
// same orphaning this module exists to catch — leaves its last frame behind, and nothing
// else looks for it. Measured in a real userData directory: four abandoned files, 1-2.5MB
// each, the oldest five hours old. The pid in the name is what makes them collectable.
const FRAME_FILE_PATTERN = /^tweb-frame-(\d+)-\d+\.(?:png|rgba)(?:\.tmp)?$/;

/**
 * Picks the frame files left behind by engines that are no longer running.
 *
 * `isAlive` is injected rather than called here so the decision stays testable without
 * spawning processes. Our own files are excluded by pid, not by name, so the in-flight
 * `.tmp` of a live sibling is safe too.
 *
 * @param {string[]} names directory entries to consider
 * @param {number} selfPid this engine's pid, never swept
 * @param {(pid: number) => boolean} isAlive whether a pid still exists
 * @returns {string[]} the names safe to delete
 */
function abandonedFrameFiles(names, selfPid, isAlive) {
  const collectable = [];
  for (const name of names || []) {
    const match = FRAME_FILE_PATTERN.exec(String(name));
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid === Number(selfPid)) continue;
    // A pid we cannot judge is left alone: deleting a live engine's frame file mid-write
    // costs it a frame, while leaving a dead one costs a few megabytes until next launch.
    if (isAlive(pid)) continue;
    collectable.push(name);
  }
  return collectable;
}

module.exports = { isOrphaned, abandonedFrameFiles, FRAME_FILE_PATTERN, INIT_PID };