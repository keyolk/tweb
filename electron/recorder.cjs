"use strict";

// A recording of what happened in a pane, for handing to a coding agent: "here is what I did and
// what the page did back". DESIGN.md goal 10; the delivery is agent-handoff.cjs.
//
// Not a video. A video is the wrong artifact for an agent — it cannot be read without a decoder,
// and most of its frames are the same picture. This keeps a bounded set of keyframes (on a
// navigation, after a click, and on a timer only while the page is actually changing) and an
// interaction log, and writes them as a timeline an agent reads with its ordinary file tools.
//
// What decides lives here, apart from Electron: what an event may contain (the privacy rules),
// when a keyframe is taken, the bounds, and the timeline text. main.cjs owns the capture and the
// files.

const MAX_EVENTS = 1000;
const MAX_KEYFRAMES = 60;
const DEFAULT_INTERVAL_MS = 5000;
const MIN_INTERVAL_MS = 1000;
const TEXT_LIMIT = 80;
const VALUE_LIMIT = 80;
const URL_LIMIT = 300;

// A field whose value is never recorded. The preload applies the same rule before anything leaves
// the page (it cannot require this file — see the sandbox note in preload.cjs); this copy is the
// second line, for anything that reaches the engine some other way.
const SENSITIVE_NAME = /pass|pwd|secret|token|otp|cvc|cvv|card|ssn|security.?code/i;
const SENSITIVE_AUTOCOMPLETE = /current-password|new-password|one-time-code|cc-/i;

function sensitiveField(field) {
  if (!field) return true;
  if (String(field.type || "").toLowerCase() === "password") return true;
  if (SENSITIVE_AUTOCOMPLETE.test(String(field.autocomplete || ""))) return true;
  return SENSITIVE_NAME.test(`${field.name || ""} ${field.id || ""}`);
}

function oneLine(text, limit) {
  const value = String(text ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/// A page-reported event, reduced to what a timeline may hold. Unknown kinds are dropped: the page
/// side is a renderer, and only the shapes listed here are recorded.
function cleanPageEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (event.kind === "click") {
    return {
      kind: "click",
      selector: oneLine(event.selector, 200),
      text: oneLine(event.text, TEXT_LIMIT),
      url: oneLine(event.url, URL_LIMIT),
    };
  }
  if (event.kind === "field") {
    const field = event.field || {};
    const entry = {
      kind: "field",
      selector: oneLine(event.selector, 200),
      type: oneLine(field.type, 20),
      url: oneLine(event.url, URL_LIMIT),
    };
    if (sensitiveField(field)) entry.redacted = true;
    else if (typeof field.checked === "boolean") entry.checked = field.checked;
    else entry.value = oneLine(field.value, VALUE_LIMIT);
    return entry;
  }
  return null;
}

class Recording {
  constructor({ directory, pane = null, startedAt = Date.now(), intervalMs = DEFAULT_INTERVAL_MS,
    maxEvents = MAX_EVENTS, maxKeyframes = MAX_KEYFRAMES } = {}) {
    this.directory = directory;
    this.pane = pane;
    this.startedAt = startedAt;
    this.intervalMs = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || DEFAULT_INTERVAL_MS);
    this.maxEvents = maxEvents;
    this.maxKeyframes = maxKeyframes;
    this.events = [];
    this.droppedEvents = 0;
    this.keyframes = 0;
    this.skippedKeyframes = 0;
    this.lastKeyframeAt = 0;
    // Set by a paint; a timer keyframe is only worth taking if something was drawn since the last.
    this.dirty = false;
    this.endedAt = null;
  }

  /// Appends an event and returns it, or null once the log is full (the drop is counted).
  record(kind, detail = {}, at = Date.now()) {
    if (this.events.length >= this.maxEvents) {
      this.droppedEvents += 1;
      return null;
    }
    const entry = { at, kind, ...detail };
    this.events.push(entry);
    return entry;
  }

  /// The file name the next keyframe goes to, or null once the cap is reached. Reserving the
  /// name up front keeps the numbering in event order even when captures finish out of order.
  reserveKeyframe(reason, at = Date.now()) {
    if (this.keyframes >= this.maxKeyframes) {
      this.skippedKeyframes += 1;
      return null;
    }
    const name = `${String(this.keyframes).padStart(3, "0")}-${String(reason).replace(/[^a-z0-9-]/gi, "")}.jpg`;
    this.keyframes += 1;
    this.lastKeyframeAt = at;
    this.dirty = false;
    return name;
  }

  /// Whether the timer should take a keyframe now: the page changed, and the last one is old.
  periodicDue(now = Date.now()) {
    return this.dirty && now - this.lastKeyframeAt >= this.intervalMs;
  }

  counts() {
    const count = (kind) => this.events.filter((event) => event.kind === kind).length;
    return {
      navigations: count("navigate"),
      clicks: count("click"),
      fields: count("field"),
      consoleErrors: count("console-error"),
      failedRequests: count("network-failure"),
      keyframes: this.events.filter((event) => event.keyframe).length,
    };
  }

  /// The two lines pasted into the agent pane.
  summary(timelinePath) {
    const c = this.counts();
    const seconds = ((this.endedAt ?? Date.now()) - this.startedAt) / 1000;
    const first = this.events.find((event) => event.url)?.url || "";
    return `tweb recording: ${timelinePath}\n`
      + `${seconds.toFixed(1)}s from ${first}: ${c.navigations} navigations, ${c.clicks} clicks, `
      + `${c.fields} field changes, ${c.consoleErrors} console errors, ${c.failedRequests} failed requests, `
      + `${c.keyframes} keyframes.\n`;
  }
}

function cell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function describe(event) {
  switch (event.kind) {
    case "start": return ["start", event.url];
    case "stop": return ["stop", event.url];
    case "navigate": return [event.inPage ? "navigate (in page)" : "navigate", event.url];
    case "click": return ["click", `\`${event.selector}\`${event.text ? ` "${event.text}"` : ""}`];
    case "field": {
      const value = event.redacted ? "(value not recorded)"
        : typeof event.checked === "boolean" ? (event.checked ? "checked" : "unchecked")
          : JSON.stringify(event.value ?? "");
      return ["field change", `\`${event.selector}\`${event.type ? ` [${event.type}]` : ""} → ${value}`];
    }
    case "console-error": return ["console error", `${event.message}${event.source ? ` (${event.source}:${event.line ?? "?"})` : ""}`];
    case "network-failure": return ["request failed", `${event.method || "GET"} ${event.url} → ${event.status ?? event.error}`];
    case "change": return ["page changed", ""];
    default: return [event.kind, ""];
  }
}

/// The timeline an agent reads: a header saying what was and was not captured, then one table row
/// per event with the keyframe's absolute path.
function timelineMarkdown(recording, joinPath) {
  const ended = recording.endedAt ?? Date.now();
  const start = new Date(recording.startedAt).toISOString();
  const c = recording.counts();
  const lines = [
    "# tweb recording",
    "",
    `- Started ${start}, ${((ended - recording.startedAt) / 1000).toFixed(1)}s${recording.pane ? `, pane ${recording.pane}` : ""}`,
    `- ${recording.events.length} events (${c.navigations} navigations, ${c.clicks} clicks, ${c.fields} field changes, `
      + `${c.consoleErrors} console errors, ${c.failedRequests} failed requests), ${c.keyframes} keyframes`,
    "- Captured: navigations, clicks (selector and text), committed field changes, console errors,"
      + " failed or >=400 requests, and keyframes on navigation, after clicks, and every"
      + ` ${recording.intervalMs / 1000}s while the page changes.`,
    "- Not captured: password, card, one-time-code and token-like field values (shown as \"value not"
      + " recorded\"), keystrokes, request bodies, cookies.",
  ];
  if (recording.droppedEvents) lines.push(`- ${recording.droppedEvents} events dropped after the ${recording.maxEvents}-event cap`);
  if (recording.skippedKeyframes) lines.push(`- ${recording.skippedKeyframes} keyframes skipped after the ${recording.maxKeyframes}-keyframe cap`);
  lines.push("", "| t | action | detail | keyframe |", "|---|---|---|---|");
  for (const event of recording.events) {
    const [action, detail] = describe(event);
    const offset = `+${((event.at - recording.startedAt) / 1000).toFixed(1)}s`;
    const frame = event.keyframe ? joinPath(recording.directory, event.keyframe) : "";
    lines.push(`| ${offset} | ${cell(action)} | ${cell(detail)} | ${cell(frame)} |`);
  }
  return `${lines.join("\n")}\n`;
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  MAX_EVENTS,
  MAX_KEYFRAMES,
  Recording,
  cleanPageEvent,
  oneLine,
  sensitiveField,
  timelineMarkdown,
};
