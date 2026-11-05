"use strict";

// What a site may use — camera, microphone, notifications, the clipboard — decided by the user.
//
// Electron answers every permission request with "yes" unless the app installs a handler, and TWeb
// installed none. Measured on a plain localhost page in an Electron tab: `getUserMedia({audio})`
// opened the microphone, `Notification.requestPermission()` resolved "granted", and
// `navigator.permissions` reported camera, microphone, clipboard-read and midi as granted — for
// every page, without a word to the user. The Chrome engine is the opposite: headless Chrome denies
// all of them without a prompt, so a call site could not get the microphone even when the user
// wanted it to.
//
// So each request is one of three things:
//   allow  — needed for a page to work and harmless (fullscreen, writing the clipboard, DRM)
//   deny   — nothing in a terminal can serve it (screen capture has no picker), or the OS would
//            not grant it to this app anyway (location)
//   ask    — the user decides, once or for the site, in a prompt over the page
//
// Decisions are per origin and per kind, in `site-permissions.json` beside the profile. The file is
// the user's; a decision is never written without one of their keys behind it.

const fs = require("node:fs");
const path = require("node:path");

const ALWAYS_ALLOW = new Set([
  "fullscreen",
  "pointerLock",
  "keyboardLock",
  "clipboard-sanitized-write",
  "mediaKeySystem",
  "speaker-selection",
  // Third-party cookie access an embedded sign-in asks for; refusing it breaks SSO iframes, and
  // Chrome grants it without a prompt to a site the user has already interacted with.
  "storage-access",
  "top-level-storage-access",
  // Opening a link in another app (mailto:, zoommtg:) went through untouched before; prompting for
  // it is a different change from this one.
  "openExternal",
]);

const ALWAYS_DENY = new Set([
  "display-capture",
  "geolocation",
  "window-management",
  "idle-detection",
]);

// What the prompt and `:permit` call each kind. `media` is split by device, since a site that wants
// the microphone should not get the camera with it.
const LABELS = {
  camera: "camera",
  microphone: "microphone",
  notifications: "notifications",
  "clipboard-read": "read the clipboard",
  midi: "MIDI devices",
  midiSysex: "MIDI devices (system exclusive)",
};

const ASKABLE = new Set(Object.keys(LABELS));

/** The kinds a request asks for: `media` becomes camera and/or microphone. */
function requestKinds(permission, details = {}) {
  if (permission !== "media") return [permission];
  const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  const kinds = [];
  if (types.includes("video")) kinds.push("camera");
  if (types.includes("audio")) kinds.push("microphone");
  // A check (`navigator.permissions.query`) names one type; an empty list is "media at all".
  if (!kinds.length && details.mediaType === "video") kinds.push("camera");
  if (!kinds.length && details.mediaType === "audio") kinds.push("microphone");
  return kinds.length ? kinds : ["camera", "microphone"];
}

/** The origin a decision is keyed by, or null for a page that has none (data:, about:). */
function originOf(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol === "file:") return "file://";
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * What to do with a request, before any prompt: "allow", "deny" or "ask". `stored` is the origin's
 * remembered decisions, `{ kind: true|false }`.
 */
function decide(kinds, stored = {}) {
  if (kinds.length === 0) return "deny";
  if (kinds.every((kind) => ALWAYS_ALLOW.has(kind))) return "allow";
  if (kinds.some((kind) => ALWAYS_DENY.has(kind) || (!ASKABLE.has(kind) && !ALWAYS_ALLOW.has(kind)))) return "deny";
  if (kinds.some((kind) => stored[kind] === false)) return "deny";
  if (kinds.every((kind) => ALWAYS_ALLOW.has(kind) || stored[kind] === true)) return "allow";
  return "ask";
}

/**
 * What a synchronous check (`navigator.permissions`, `Notification.permission`) answers. Electron's
 * check handler is a boolean, so "not decided yet" has to pick a side. For media it says yes: the
 * check does not open a device, the request that follows does, and that request is asked. For
 * notifications it says no, because `new Notification()` after a "granted" check shows one with no
 * request at all.
 */
function check(kinds, stored = {}) {
  const decision = decide(kinds, stored);
  if (decision !== "ask") return decision === "allow";
  return kinds.every((kind) => kind === "camera" || kind === "microphone");
}

function createStore(file, { read = fs.readFileSync, write = writeAtomic } = {}) {
  let cache = null;
  const load = () => {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(read(file, "utf8"));
      cache = parsed && typeof parsed === "object" && parsed.origins && typeof parsed.origins === "object"
        ? parsed.origins
        : {};
    } catch {
      cache = {};
    }
    return cache;
  };
  return {
    get(origin) {
      return origin ? { ...(load()[origin] || {}) } : {};
    },
    set(origin, kinds, allowed) {
      if (!origin) return;
      const origins = load();
      const entry = { ...(origins[origin] || {}) };
      for (const kind of kinds) if (ASKABLE.has(kind)) entry[kind] = Boolean(allowed);
      origins[origin] = entry;
      write(file, `${JSON.stringify({ version: 1, origins }, null, 1)}\n`);
    },
    forget(origin) {
      const origins = load();
      if (!origin || !origins[origin]) return false;
      delete origins[origin];
      write(file, `${JSON.stringify({ version: 1, origins }, null, 1)}\n`);
      return true;
    },
    all() {
      return { ...load() };
    },
  };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** `:permit mic` and the like: the kind a user typed, or null. */
function parseKind(text) {
  const value = String(text || "").trim().toLowerCase();
  const aliases = {
    mic: "microphone", microphone: "microphone", audio: "microphone",
    cam: "camera", camera: "camera", video: "camera",
    notifications: "notifications", notification: "notifications", notify: "notifications",
    clipboard: "clipboard-read", "clipboard-read": "clipboard-read",
    midi: "midi",
  };
  return aliases[value] || null;
}

// The Chrome engine is told through CDP `Browser.setPermission`, which takes the web's own
// PermissionDescriptor — `microphone`, not the `audioCapture` that `Browser.grantPermissions` uses
// (measured: "Invalid PermissionDescriptor name: audioCapture").
const CDP_DESCRIPTORS = {
  camera: { name: "camera" },
  microphone: { name: "microphone" },
  notifications: { name: "notifications" },
  "clipboard-read": { name: "clipboard-read" },
  midi: { name: "midi" },
  midiSysex: { name: "midi", sysex: true },
};

function describe(kinds) {
  return kinds.map((kind) => LABELS[kind] || kind).join(" and ");
}

module.exports = {
  ALWAYS_ALLOW, ALWAYS_DENY, ASKABLE, CDP_DESCRIPTORS, LABELS,
  check, createStore, decide, describe, originOf, parseKind, requestKinds,
};
