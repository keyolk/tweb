"use strict";

// The terminal's answer to Chrome's file picker.
//
// Chrome opens a native chooser. A tmux pane cannot: the window is offscreen and
// `show: false`, so Chromium's own chooser has nowhere to draw — measured, the request
// simply dies and the page's "Choose File" button does nothing at all.
//
// What replaces it is a path prompt, and that is not a consolation prize. A terminal user
// already knows where the file is — they got there with ls, fd or fzf — so typing a path
// with completion is fewer keystrokes than navigating a Finder dialog. What genuinely
// cannot be reproduced is DRAG AND DROP from Finder onto the page; nothing here pretends
// otherwise.
//
// Everything here is pure: the engine reads the directory and sets the files on the input,
// this module decides what a typed string means and which entries may be offered.

const path = require("node:path");

/**
 * Split what the user typed into the directory to list and the prefix to match in it.
 *
 * A trailing slash means "inside this directory", so the prefix is empty and everything in
 * it is offered. Without one, the last segment is a partial name being completed —
 * `/tmp/pro` lists /tmp and matches entries starting with "pro".
 */
function completionScope(input, home) {
  const raw = String(input || "");
  const expanded = expandHome(raw, home);
  if (expanded === "" || expanded === ".") return { directory: ".", prefix: "" };
  if (expanded.endsWith("/")) return { directory: expanded, prefix: "" };
  const directory = path.dirname(expanded);
  return { directory: directory === "" ? "." : directory, prefix: path.basename(expanded) };
}

// `~` is what a shell user types, and a browser that made them spell out /Users/name would
// be the one imposing friction. Bare `~` and `~/...` only: `~other` is another user's home,
// which needs a passwd lookup this has no business doing.
function expandHome(input, home) {
  const raw = String(input || "");
  if (!home) return raw;
  if (raw === "~") return String(home);
  if (raw.startsWith("~/")) return path.join(String(home), raw.slice(2));
  return raw;
}

/**
 * Whether a file satisfies the input's `accept` attribute.
 *
 * Chrome's chooser greys out non-matching files rather than hiding them, and the attribute
 * is advisory — a page can still receive anything a determined user picks. So this filters
 * what is OFFERED, and the engine does not refuse a path the user typed in full: a user who
 * spells out a name has said what they mean more clearly than the attribute has.
 *
 * Directories always pass, because a directory is how you reach the file.
 */
function acceptsFile(name, accept, isDirectory = false) {
  if (isDirectory) return true;
  const patterns = String(accept || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (patterns.length === 0) return true;
  const lower = String(name || "").toLowerCase();
  const extension = path.extname(lower);
  return patterns.some((pattern) => {
    if (pattern.startsWith(".")) return extension === pattern;
    // MIME forms. Only the wildcard families are decidable from a filename; a bare
    // "text/csv" would need the file's type, which the chooser does not have, so it is
    // matched by extension where the mapping is unambiguous and otherwise let through
    // rather than hiding a file the user asked for.
    if (pattern === "*/*") return true;
    if (pattern.endsWith("/*")) return MIME_FAMILY_EXTENSIONS[pattern.slice(0, -2)]?.includes(extension) ?? true;
    return MIME_EXTENSIONS[pattern] ? MIME_EXTENSIONS[pattern].includes(extension) : true;
  });
}

// Deliberately short: only families where guessing from the extension is safe. Anything
// absent is let through rather than hidden, because hiding the file the user came for is
// the worse failure.
const MIME_FAMILY_EXTENSIONS = {
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif", ".heic", ".ico", ".tif", ".tiff"],
  video: [".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".mpg", ".mpeg"],
  audio: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"],
  text: [".txt", ".md", ".csv", ".tsv", ".log", ".json", ".xml", ".html", ".htm", ".css", ".js"],
};

const MIME_EXTENSIONS = {
  "application/pdf": [".pdf"],
  "text/csv": [".csv"],
  "text/plain": [".txt", ".text", ".log"],
  "application/json": [".json"],
  "application/zip": [".zip"],
};

/**
 * The entries to offer, filtered and ordered.
 *
 * Directories come first because they are how you get somewhere else, and a chooser whose
 * first suggestion is a dead-end file makes the common "go deeper" move the slow one.
 * Dotfiles are hidden until the prefix starts with a dot, which is the shell convention
 * the user already has in their fingers.
 */
function completionEntries(entries, { prefix = "", accept = "", limit = 50 } = {}) {
  const wanted = String(prefix || "");
  const showHidden = wanted.startsWith(".");
  const matched = (Array.isArray(entries) ? entries : []).filter((entry) => {
    const name = String(entry?.name || "");
    if (!name) return false;
    if (!showHidden && name.startsWith(".")) return false;
    if (wanted && !name.toLowerCase().startsWith(wanted.toLowerCase())) return false;
    return acceptsFile(name, accept, Boolean(entry.directory));
  });
  matched.sort((left, right) => {
    if (Boolean(left.directory) !== Boolean(right.directory)) return left.directory ? -1 : 1;
    return String(left.name).localeCompare(String(right.name));
  });
  const kept = matched.slice(0, Math.max(0, limit));
  return {
    entries: kept,
    total: matched.length,
    // Said rather than silently dropped: a truncated list that looks complete is how a
    // user concludes a file is not there.
    truncated: Math.max(0, matched.length - kept.length),
  };
}

/**
 * The longest prefix every candidate shares, which is what Tab fills in.
 *
 * Completing to the common prefix rather than to the first match is the shell's behaviour
 * and the reason Tab is worth pressing: it never guesses wrong, it just stops where the
 * choice is genuinely still open.
 */
function commonPrefix(names) {
  const list = (Array.isArray(names) ? names : []).map(String).filter(Boolean);
  if (list.length === 0) return "";
  let prefix = list[0];
  for (const name of list.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < name.length && prefix[index] === name[index]) index += 1;
    prefix = prefix.slice(0, index);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * The text the input becomes when Tab is pressed.
 *
 * A single directory match gains a trailing slash, so a second Tab lists its contents
 * without the user reaching for `/` — the same rhythm as a shell.
 */
function completedInput(input, candidates, home) {
  const { directory, prefix } = completionScope(input, home);
  const names = candidates.map((entry) => String(entry.name));
  const shared = commonPrefix(names);
  if (!shared || shared.length < prefix.length) return String(input || "");
  const only = candidates.length === 1 ? candidates[0] : null;
  const completed = only && only.directory ? `${shared}/` : shared;
  const base = directory === "." && !String(input || "").startsWith("./") ? "" : directory;
  const joined = base ? path.join(base, completed) : completed;
  // path.join eats the trailing slash that says "this is a directory, go on".
  return completed.endsWith("/") && !joined.endsWith("/") ? `${joined}/` : joined;
}

/**
 * The paths to hand the page, or an error explaining why none.
 *
 * A single-file input given several paths takes the first rather than failing: the user
 * asked for those files and the page can only hold one, so silently succeeding with the
 * first is friendlier than an error about a rule they cannot see. Nothing is invented —
 * every path returned is one the user typed.
 */
function chosenPaths(paths, { multiple = false } = {}) {
  const list = (Array.isArray(paths) ? paths : [paths])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  if (list.length === 0) return { paths: [], error: "no file chosen" };
  return { paths: multiple ? list : list.slice(0, 1), error: "" };
}

module.exports = {
  completionScope,
  expandHome,
  acceptsFile,
  completionEntries,
  commonPrefix,
  completedInput,
  chosenPaths,
};
