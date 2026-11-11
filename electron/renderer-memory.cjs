"use strict";

// How much memory each tab's renderer holds, and what to do when one grows past a limit.
//
// Observed 2026-11-11: one tweb renderer reached 2007MB in `top`'s MEM column, 1984MB of it
// compressed, with the machine down to ~100MB free and swap full. Mostly compressed suggests pages
// written and then left untouched — a page that accumulated rather than one that was busy (an
// inference; the page was never identified). Nothing in tweb said which pane or page it was, and
// the pid was gone by the time anyone looked, so the first half of this module is attribution:
// `tweb diag` and `tweb tabs` name the bytes per tab.
//
// The number is the process's physical footprint (`proc_pid_rusage` ri_phys_footprint, read by the
// native addon): what `top` shows as MEM, resident plus compressed pages. Not RSS, and not
// Electron's `getAppMetrics()` workingSetSize — both leave compressed pages out. Measured on a
// renderer holding 600MB of typed arrays: right after allocation workingSetSize read 709MB; once
// macOS compressed the pages it read 98MB while `top` read 635M (CMPRS 617M). The renderer that
// took the machine down was 1984M compressed, so either of those would have reported it as small.
// Without the addon the engine falls back to workingSetSize. One read per process is cheap enough
// for the engine's 1s tick.
//
// The second half is the guard. A reload gives the memory back without a new process — measured,
// same pid: grown to 4104MB, after `reload()` 893MB, the page's own baseline. So a tab past the
// limit is reloaded, but only when nobody can lose anything by it: not the tab on screen, not one
// playing sound, not one the user typed into recently. Those get a warning instead, once.

/// Default limit, MB. Far above the pages measured here (the office view 66–148MB, a brief or a
/// data: page ~90MB) and below the 2GB that took the machine down.
const DEFAULT_LIMIT_MB = 1536;
/// A tab must stay over the limit this long before anything happens. One sample is a spike — a
/// page decoding a large image, a GC that has not run — not a leak.
const SUSTAIN_MS = 30_000;
/// Input this recent means someone is working in the tab — the person, or an agent driving it —
/// and reloading it would throw that away.
const QUIET_INPUT_MS = 5 * 60_000;
/// After a reload, the same tab is left alone this long. A page that is back over the limit within
/// minutes allocates on load, and reloading it in a loop would cost more than the memory.
const RELOAD_COOLDOWN_MS = 30 * 60_000;

const KB_PER_MB = 1024;

/**
 * Memory per renderer process, attributed to the tabs it serves.
 *
 * Tabs can share a renderer (same site, opener relationships), and a tab can use several (each
 * out-of-process iframe has its own). So the unit is the process: each entry carries every tab
 * that has a frame in it, and its bytes are never summed across tabs.
 *
 * @param {{pid: number, type?: string, memory?: {workingSetSize?: number}}[]} metrics
 *   `app.getAppMetrics()` shape, `workingSetSize` in KB (main.cjs puts the footprint there)
 * @param {{index: number, pids: number[]}[]} tabs each tab's main-frame pid first, then its
 *   out-of-process frames' pids
 * @returns {{pid: number, mb: number, tabs: number[], main: number[]}[]} sorted largest first;
 *   `main` lists the tabs whose main frame runs here
 */
function rendererUsage(metrics, tabs) {
  const byPid = new Map();
  for (const metric of metrics || []) {
    const kb = metric?.memory?.workingSetSize;
    if (!Number.isFinite(metric?.pid) || !Number.isFinite(kb)) continue;
    byPid.set(metric.pid, Math.round(kb / KB_PER_MB));
  }
  const usage = new Map();
  for (const tab of tabs || []) {
    (tab.pids || []).forEach((pid, position) => {
      if (!byPid.has(pid)) return;
      let entry = usage.get(pid);
      if (!entry) {
        entry = { pid, mb: byPid.get(pid), tabs: [], main: [] };
        usage.set(pid, entry);
      }
      if (!entry.tabs.includes(tab.index)) entry.tabs.push(tab.index);
      if (position === 0 && !entry.main.includes(tab.index)) entry.main.push(tab.index);
    });
  }
  return [...usage.values()].sort((a, b) => b.mb - a.mb);
}

/**
 * What to do about one tab, given its main renderer's size now.
 *
 * Pure so the policy can be tested without growing a real page: the caller keeps `state` per tab
 * and passes the clock in.
 *
 * @param {object} input
 * @param {number|null} input.mb the tab's main-frame renderer, MB; null when unknown (another engine)
 * @param {number} input.limitMb 0 turns the guard off
 * @param {boolean} input.onScreen the pane is visible and this is its active tab
 * @param {boolean} input.audible
 * @param {boolean} input.shared another tab's main frame runs in the same process — a reload would
 *   not give the memory back, because the other tab still holds it
 * @param {number|null} input.lastInputAt epoch-ms of the user's last key or click in this tab
 * @param {number} input.now
 * @param {{overSince?: number|null, warned?: boolean, reloadedAt?: number|null}} [state]
 * @returns {{action: "none"|"warn"|"reload", reason: string|null,
 *   state: {overSince: number|null, warned: boolean, reloadedAt: number|null}}}
 */
function memoryDecision({ mb, limitMb, onScreen, audible, shared, lastInputAt, now }, state = {}) {
  const prior = {
    overSince: state.overSince ?? null,
    warned: Boolean(state.warned),
    reloadedAt: state.reloadedAt ?? null,
  };
  if (!limitMb || !Number.isFinite(mb) || mb < limitMb) {
    // Back under: the next crossing is a new episode and gets its own warning.
    return { action: "none", reason: null, state: { ...prior, overSince: null, warned: false } };
  }
  const overSince = prior.overSince ?? now;
  const next = { ...prior, overSince };
  if (now - overSince < SUSTAIN_MS) return { action: "none", reason: null, state: next };

  const blocker = onScreen ? "on screen"
    : audible ? "playing sound"
      : shared ? "renderer shared with another tab"
        : Number.isFinite(lastInputAt) && now - lastInputAt < QUIET_INPUT_MS ? "used in the last 5 minutes"
          : prior.reloadedAt !== null && now - prior.reloadedAt < RELOAD_COOLDOWN_MS ? "reloaded less than 30 minutes ago"
            : null;
  if (blocker === null) {
    return {
      action: "reload",
      reason: null,
      state: { overSince: null, warned: false, reloadedAt: now },
    };
  }
  if (prior.warned) return { action: "none", reason: blocker, state: next };
  return { action: "warn", reason: blocker, state: { ...next, warned: true } };
}

module.exports = {
  rendererUsage,
  memoryDecision,
  DEFAULT_LIMIT_MB,
  SUSTAIN_MS,
  QUIET_INPUT_MS,
  RELOAD_COOLDOWN_MS,
};
