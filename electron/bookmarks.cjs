"use strict";

// Bookmarks: tweb's own (bookmarks.jsonl in the profile) and the user's main Chrome bookmarks, read
// only. The pure half — parsing, folding the file into a set, merging the two sources, filtering —
// lives here so it is testable without an Electron window. main.cjs owns the file and the IPC.
//
// WHY a second source at all. `b` is Vimium's "search bookmarks", and a key that searches an empty
// list on day one is a key nobody learns. The user's Chrome bookmarks are already there; reading
// them makes `b` useful immediately. They are never written: tweb is not a Chrome bookmark manager,
// and a second writer on that file would race Chrome's own (it rewrites the whole file).
//
// WHY one line per change (append-only), like history.jsonl. Every pane shares the file and adds
// from its own process; appending is what keeps two panes from clobbering each other. A delete is a
// tombstone line, and the file is folded newest-wins on read.

/// The newest state of every tweb bookmark, from the file's lines (oldest first).
///
/// A line is `{url, name, at}` to add or rename, or `{url, deleted: true, at}` to remove. A URL's
/// last line decides, so a rename is just another add and a re-add after a delete comes back. Torn
/// or foreign lines are skipped rather than failing the whole list.
function foldBookmarkLines(lines) {
  const byUrl = new Map();
  for (const raw of lines || []) {
    const line = String(raw || "").trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const url = typeof entry?.url === "string" ? entry.url.trim() : "";
    if (!url) continue;
    // Re-inserted so the Map's order is "most recently touched last".
    byUrl.delete(url);
    if (entry.deleted) continue;
    byUrl.set(url, {
      url,
      name: String(entry.name || url),
      at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
      source: "tweb",
    });
  }
  // Newest first: what was bookmarked last is the likeliest to be wanted next.
  return [...byUrl.values()].reverse();
}

/// The line that records adding (or renaming) a bookmark.
function bookmarkLine(url, name, at = Date.now()) {
  const target = String(url || "").trim();
  if (!target) throw new Error("bookmark needs a URL");
  return `${JSON.stringify({ url: target, name: String(name || "").trim() || target, at })}\n`;
}

/// The line that records removing one.
function tombstoneLine(url, at = Date.now()) {
  return `${JSON.stringify({ url: String(url || "").trim(), deleted: true, at })}\n`;
}

/// Chrome's `Bookmarks` JSON as a flat list of `{url, name, folder, source: "chrome"}`.
///
/// The file is `{roots: {bookmark_bar, other, synced}}`, each a folder node with `children` that are
/// either `{type: "url", url, name}` or more folders. Only http(s)/file URLs are kept: a
/// `javascript:` bookmarklet would run in whatever page `b` opened it from. Returns null when the
/// text is not that shape, so the caller can say the file was unreadable instead of showing nothing.
function parseChromeBookmarks(text) {
  let data;
  try {
    data = JSON.parse(String(text || ""));
  } catch (_) {
    return null;
  }
  const roots = data && typeof data === "object" ? data.roots : null;
  if (!roots || typeof roots !== "object") return null;
  const out = [];
  const walk = (node, folder) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "url") {
      const url = typeof node.url === "string" ? node.url : "";
      if (/^(?:https?|file):/i.test(url)) out.push({ url, name: String(node.name || url), folder, source: "chrome" });
      return;
    }
    const here = node.name ? (folder ? `${folder}/${node.name}` : String(node.name)) : folder;
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child, here);
  };
  for (const key of ["bookmark_bar", "other", "synced"]) walk(roots[key], "");
  return out;
}

/// tweb's bookmarks and Chrome's as one list: tweb's first (they are this browser's own, and the
/// only ones `x` can delete), one row per URL with tweb's winning a collision.
function mergeBookmarks(tweb, chrome) {
  const seen = new Set();
  const out = [];
  for (const entry of [...(tweb || []), ...(chrome || [])]) {
    if (!entry?.url || seen.has(entry.url)) continue;
    seen.add(entry.url);
    out.push(entry);
  }
  return out;
}

/// The rows matching a typed query: every word must appear in the name, URL or folder, any order,
/// case-insensitive. Order is kept — the list is already in its priority order — so filtering never
/// reshuffles what the user was scanning.
function filterBookmarks(entries, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...(entries || [])];
  return (entries || []).filter((entry) => {
    const haystack = `${entry.name || ""} ${entry.url || ""} ${entry.folder || ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

module.exports = {
  foldBookmarkLines, bookmarkLine, tombstoneLine, parseChromeBookmarks, mergeBookmarks, filterBookmarks,
};
