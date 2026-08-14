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

module.exports = { isOrphaned, INIT_PID };
