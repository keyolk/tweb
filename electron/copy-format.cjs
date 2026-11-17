"use strict";

// What the `y` copy menu and `p`/`P` turn into clipboard text, and back.
//
// Main uses these for the page's own link (it knows the tab's real URL and title, which a
// subframe does not) and for the clipboard URL `p`/`P` open. The preload states the same
// `markdownLink` rule inline — a sandboxed preload cannot require this file — and a test keeps
// the two equal.

// `[title](url)`: brackets and backslashes in the title escaped, parentheses and whitespace in
// the URL percent-encoded, so the link survives any Markdown renderer.
function markdownLink(text, url) {
  const label = String(text || url || "").replace(/\s+/g, " ").trim().replace(/[[\]\\]/g, (c) => `\\${c}`);
  return `[${label}](${String(url || "").replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})`;
}

// The URL a clipboard holds, or null. Only text that is one address and nothing else counts:
// `p` with a sentence on the clipboard must not turn it into a search or a guessed host.
function clipboardUrl(text) {
  const value = String(text || "").trim();
  if (!value || /\s/.test(value) || value.length > 8192) return null;
  if (/^(https?|file):\/\/\S+$/i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/\S*)?$/i.test(value)) return `http://${value}`;
  // A bare host: labels joined by dots, ending in a letter TLD, optional port and path.
  if (/^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(value)) return `https://${value}`;
  return null;
}

module.exports = { markdownLink, clipboardUrl };
