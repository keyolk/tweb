"use strict";

// Who else is at this pane: an agent driving the page over the agent socket, and a controller
// linked to it (a Claude Code plugin in the next tmux pane, say). DESIGN.md goal 4 — a human and
// an agent share one page — needs both to be visible where the human is looking, or the two
// type into the same field at once.
//
// Pure: the clock is passed in, and main.cjs keeps one presence per pane, sends `presenceModel`
// to the page's indicator and re-sends it when `nextChange` says the picture will change.

// How long after an agent's last page-changing call the pane still reads as driven. A flow is
// snapshot → click → snapshot → fill with model think time between calls; shorter than that gap
// and the badge would blink off mid-flow.
const DRIVING_MS = 8000;

// A link nobody renews is gone after its ttl; a controller that crashed leaves no badge behind.
const DEFAULT_LINK_TTL_S = 30;
const MAX_LINK_TTL_S = 600;

// Calls that are bookkeeping, not an agent at the page: `tweb panes` and the Chrome-login check
// poll `status` on every pane, audio peers call `audio-sync`, and `link` is the controller's own
// heartbeat. Counting them would light every pane up whenever anything lists panes.
const PASSIVE_METHODS = new Set(["status", "audio-sync", "link"]);

// Calls that only read the page. They still say an agent is looking (a flow starts with a
// snapshot), but they do not change what the person sees, so they do not raise "driving".
const READ_METHODS = new Set([
  "snapshot", "info", "query", "diag", "extensions", "engine-log", "screenshot", "full-screenshot",
  "pdf", "wait", "tabs", "console", "errors", "network", "devtools", "inspect-element",
  "record-status", "capture",
]);

const READ_ACTIONS = new Set(["text", "html"]);

function classify(method, params) {
  if (PASSIVE_METHODS.has(method)) return "passive";
  if (READ_METHODS.has(method)) return "read";
  if (method === "act" && READ_ACTIONS.has(String(params?.action ?? ""))) return "read";
  return "drive";
}

// What the badge names: `act click` reads as `click`.
function verbOf(method, params) {
  return method === "act" && params?.action ? String(params.action) : method;
}

function createPresence() {
  return { drive: null, read: null, link: null, conflictAt: 0 };
}

// One agent call. Returns true when the indicator must be re-sent: every drive restarts the
// window and may change the verb shown.
function noteAgentCall(presence, method, params, now) {
  const kind = classify(method, params);
  if (kind === "passive") return false;
  const step = { method: verbOf(method, params), at: now };
  if (kind === "read") {
    presence.read = step;
    return false;
  }
  presence.drive = step;
  return true;
}

function isDriving(presence, now) {
  return Boolean(presence.drive && now - presence.drive.at < DRIVING_MS);
}

// `link` RPC: `{owner, ttl}` renews, `{clear: true}` drops it. The owner is free text the caller
// names itself by ("cc-mods %42"); the socket cannot tell callers apart, so it has to say.
function applyLink(presence, params, now) {
  if (params?.clear) {
    presence.link = null;
    return { ok: true, linked: false };
  }
  const owner = String(params?.owner ?? "").trim().slice(0, 48);
  if (!owner) throw new Error("link needs an owner (who is linking, e.g. \"cc-mods %42\")");
  const ttlS = Math.min(MAX_LINK_TTL_S, Math.max(1, Number(params?.ttl) || DEFAULT_LINK_TTL_S));
  const fresh = !presence.link || presence.link.owner !== owner || now >= presence.link.expiresAt;
  presence.link = { owner, at: now, ttlS, expiresAt: now + ttlS * 1000, since: fresh ? now : presence.link.since };
  return { ok: true, linked: true, owner, expiresAt: presence.link.expiresAt, fresh };
}

function liveLink(presence, now) {
  return presence.link && now < presence.link.expiresAt ? presence.link : null;
}

// The person pressed a key or a button. While an agent is driving that is a race: both act on one
// page. Returns true once per drive, so the warning is said once rather than on every key.
function noteUserInput(presence, now) {
  if (!isDriving(presence, now)) return false;
  if (presence.conflictAt >= presence.drive.at) return false;
  presence.conflictAt = now;
  return true;
}

// What the indicator and `status` show.
function presenceModel(presence, now) {
  const link = liveLink(presence, now);
  const driving = isDriving(presence, now);
  return {
    driving: driving ? { method: presence.drive.method, at: presence.drive.at } : null,
    lastAgent: presence.drive || presence.read
      ? [presence.drive, presence.read].filter(Boolean).sort((a, b) => b.at - a.at)[0]
      : null,
    link: link ? { owner: link.owner, since: link.since, expiresAt: link.expiresAt } : null,
    conflictAt: presence.conflictAt || null,
  };
}

// When the model will next change by time alone (driving runs out, the link expires), or null.
function nextChange(presence, now) {
  const times = [];
  if (isDriving(presence, now)) times.push(presence.drive.at + DRIVING_MS);
  const link = liveLink(presence, now);
  if (link) times.push(link.expiresAt);
  return times.length ? Math.min(...times) : null;
}

module.exports = {
  DRIVING_MS,
  DEFAULT_LINK_TTL_S,
  applyLink,
  classify,
  createPresence,
  isDriving,
  nextChange,
  noteAgentCall,
  noteUserInput,
  presenceModel,
};
