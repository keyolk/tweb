"use strict";

// What a pane shows when it has nothing to show: a window with no saved tabs, a bare `tweb open`.
//
// It used to say "No previous page to restore — press t". zenbu-labs/terminal-browser's start page
// lists what a developer in a terminal most likely came to open instead: the servers listening on
// this machine and the pages they were just on. The same two lists, plus the keys that open
// anything else. The ports also feed the omnibox, so `o` then `3000` opens a dev server without
// typing `localhost:`.

// macOS hands out 49152–65535 as ephemeral ports. What listens there is a tool's private callback
// (an OAuth redirect, an IDE helper) far more often than a server anyone means to open, and on the
// measured machine they outnumbered the real ones three to one.
const EPHEMERAL_FROM = 49152;

// Desktop apps that listen on localhost for their own reasons. Opening them shows nothing useful.
const NOISE = [
  "rapportd", "ControlCe", "Discord", "Spotify", "Dropbox", "figma_age", "Figma", "Raycast",
  "Electron", "tweb", "twebd", "Google", "Chrome", "com.docke", "launchd", "sharingd", "identitys",
  "Code", "Cursor", "zoom.us", "Slack", "1Password", "OneDrive", "mDNSRespo", "adb", "Okta", "OrbStack",
];

/**
 * The listening TCP ports in `lsof -nP -iTCP -sTCP:LISTEN` output, one per port, lowest first.
 * Only ports reachable at 127.0.0.1: a server bound to another interface alone cannot be opened as
 * localhost.
 */
function parseListeningPorts(output, { max = 12 } = {}) {
  const seen = new Map();
  for (const line of String(output || "").split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const command = parts[0].replace(/\\x20/g, " ");
    const name = parts[parts.length - 2] === "(LISTEN)" ? parts[parts.length - 3] : parts[parts.length - 2];
    const match = /^(.*):(\d+)$/.exec(name || "");
    if (!match) continue;
    const host = match[1];
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1024 || port >= EPHEMERAL_FROM || seen.has(port)) continue;
    if (!["*", "127.0.0.1", "localhost", "[::1]", "[::]", "0.0.0.0"].includes(host)) continue;
    if (NOISE.some((noise) => command.startsWith(noise))) continue;
    seen.set(port, { port, command, url: `http://localhost:${port}/` });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port).slice(0, max);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The start page as HTML. `ports` from `parseListeningPorts`, `recent` history entries
 * `{ url, title }` newest first, `restoring` true when a saved session was expected and missing.
 */
function renderStartPage({ ports = [], recent = [], restoring = false } = {}) {
  const row = (url, title, detail) => `<li><a href="${escapeHtml(url)}">${escapeHtml(title)}</a><span>${escapeHtml(detail)}</span></li>`;
  const section = (title, rows) => rows.length ? `<section><h2>${escapeHtml(title)}</h2><ul>${rows.join("")}</ul></section>` : "";
  const servers = ports.map((entry) => row(entry.url, `localhost:${entry.port}`, entry.command));
  const pages = recent
    .filter((entry) => /^https?:|^file:/.test(String(entry?.url || "")))
    .slice(0, 8)
    .map((entry) => row(entry.url, entry.title || hostOf(entry.url), hostOf(entry.url)));
  const note = restoring ? `<p class="note">No previous page to restore in this window.</p>` : "";
  const empty = servers.length || pages.length ? "" : `<p class="note">Nothing listening on localhost, and no history yet.</p>`;
  return `<!doctype html><meta charset="utf-8"><title>TWeb</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;background:#161616;color:#bdc1c6;font:14px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:720px;margin:0 auto;padding:48px 24px}h1{margin:0 0 4px;color:#e8eaed;font-size:20px;font-weight:600}
h2{margin:28px 0 8px;color:#8ab4f8;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
ul{list-style:none;margin:0;padding:0}li{display:flex;gap:12px;align-items:baseline;padding:5px 0;border-bottom:1px solid #ffffff10}
a{color:#e8eaed;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}a:hover{color:#fdd663}
li span{margin-left:auto;color:#6f747c;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
.note{color:#9aa0a6}.keys{margin-top:32px;color:#9aa0a6;font-size:13px}
kbd{padding:1px 6px;border:1px solid #5f6368;border-radius:4px;color:#fdd663;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
</style><main><h1>TWeb</h1>${note}${empty}${section("Listening on this machine", servers)}${section("Recent", pages)}
<p class="keys"><kbd>o</kbd> open or search · <kbd>gh tweb</kbd> keyword search · <kbd>f</kbd> follow a link · <kbd>?</kbd> all keys</p></main>`;
}

/** As a URL a tab can load. */
function startPageUrl(model) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(renderStartPage(model))}`;
}

/** Whether `url` is a start page: it is re-rendered when its data arrives, and never saved. */
function isStartPage(url) {
  return typeof url === "string" && url.startsWith("data:text/html;charset=utf-8,") && url.includes(encodeURIComponent("<title>TWeb</title>"));
}

module.exports = { EPHEMERAL_FROM, isStartPage, parseListeningPorts, renderStartPage, startPageUrl };
