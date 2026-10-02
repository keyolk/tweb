"use strict";

// Keeping the browser profile from growing into the thing that hangs the engine.
//
// WHAT HAPPENED. A pane came up, logged two storage errors, and stopped:
//
//   ERROR:storage/browser/quota/quota_database.cc: Could not open the quota database, resetting.
//   ERROR:storage/browser/file_system/sandbox_origin_database.cc: SandboxOriginDatabase failed
//
// and then nothing. No frame was ever sent, so the pane was a black rectangle. Measured on the
// hung process: 0% CPU, its open-file count fixed at 129, and SIGTERM did not end it — it took
// SIGKILL. A stack sample showed the main thread parked in a normal event loop, so this was not
// a deadlock: initialization simply never finished. The profile was 1.9GB (Cache 988MB, Service
// Worker 495MB) and `QuotaManager` was missing from it entirely.
//
// WHY IT GETS THERE. Chromium writes these databases continuously, and a process killed mid-write
// can leave one behind that it will not reopen. This engine gets killed that way more than a
// desktop browser does: a pane is torn down with its terminal, an engine is replaced on restart,
// and debugging it means killing it repeatedly.
//
// WHAT THIS DOES ABOUT IT. Two things, both cheap and neither destructive:
//
//   - A size check at startup. Caches are regenerable and unbounded; cookies and local storage
//     are neither. When the regenerable half is oversized, it is cleared and the profile keeps
//     every login.
//   - Recognising the errors themselves, so a pane that hits one says so instead of hanging
//     silently. Being told "clear the cache" beats discovering it hours later.
//
// Deliberately NOT here: deleting the databases that were reported broken. Chromium recreates
// those itself ("resetting" in the message is it doing exactly that), and a tool that deletes a
// user's storage on a log line it half-understands is worse than the hang.

const path = require("node:path");

/** Regenerable. Everything in here is a cache: losing it costs a re-download, nothing more. */
const DISPOSABLE = [
  "Cache",
  "Code Cache",
  "Service Worker",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
];

/**
 * Never touched. Losing any of these logs the user out or drops data a page is keeping for them,
 * which is not a cost a cache sweep may impose.
 */
const PRESERVED = ["Cookies", "Local Storage", "Session Storage", "IndexedDB", "Preferences"];

// 1.5GB. The profile that hung was 1.9GB and a healthy one here is ~120MB, so this sits between
// the two while leaving ordinary heavy use — a week of video calls fills a few hundred MB —
// well alone. It is a backstop against unbounded growth, not a tidiness policy.
const DISPOSABLE_LIMIT_BYTES = 1_500_000_000;

/**
 * Which cache directories to clear, given their measured sizes.
 *
 * All or nothing: a profile over the limit gets every cache cleared rather than the largest one,
 * because they regrow together and clearing one at a time would just run again tomorrow.
 *
 * @param {Record<string, number>} sizes Directory name to bytes; absent means absent.
 * @param {number} [limit]
 * @returns {{ clear: string[], total: number }}
 */
function cachesToClear(sizes, limit = DISPOSABLE_LIMIT_BYTES) {
  const present = DISPOSABLE.filter((name) => (sizes[name] || 0) > 0);
  const total = present.reduce((sum, name) => sum + sizes[name], 0);
  return { clear: total > limit ? present : [], total };
}

/** Paths for the caches named, under `userData`. Never anything outside it. */
function cachePaths(userDataDir, names) {
  return names.map((name) => path.join(userDataDir, name));
}

// The two errors that preceded the hang. Matched on the source file rather than the sentence,
// which is what stays put across Chromium versions.
const STORAGE_FAILURE_PATTERNS = [
  /quota_database\.cc/,
  /sandbox_origin_database\.cc/,
  /Could not open the quota database/,
];

/**
 * Whether a line from the engine's stderr reports the storage failure that precedes a hang.
 *
 * Reporting it is the whole point: the failure is otherwise invisible, because the pane does not
 * crash — it stops, and a stopped pane looks exactly like a slow one.
 */
function isStorageFailure(line) {
  const text = String(line || "");
  return STORAGE_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

module.exports = {
  cachesToClear,
  cachePaths,
  isStorageFailure,
  DISPOSABLE,
  PRESERVED,
  DISPOSABLE_LIMIT_BYTES,
};
