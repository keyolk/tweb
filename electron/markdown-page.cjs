"use strict";

// Local Markdown, rendered: opening `README.md` (a path or a file:// URL) shows the document, not
// its source.
//
// The engine answers `file:` itself (`protocol.handle("file")` in main.cjs) and hands every request
// here. A Markdown document requested as a page comes back as HTML; everything else goes on to
// Chromium's own file loader untouched. Doing it at the scheme rather than by redirecting to a
// generated page is what keeps the document's URL the file's own URL, and that is the part that
// matters: `./docs/setup.md` and `images/arch.png` resolve against it exactly as they do on disk,
// the omnibox and history show the path, and reload re-reads the file.
//
// The renderer is marked, vendored as its published UMD build (vendor/marked.umd.cjs, v18.0.14,
// MIT). The app has no bundler and is embedded into the binary file by file, so the choice was a
// dependency that is ONE self-contained file: marked is 46KB with no dependencies of its own and
// does GFM (tables, task lists, strikethrough, autolinks). micromark, the stricter CommonMark
// implementation, is ESM-only and arrives as dozens of packages, which would need a bundling step
// this repository does not have. A hand-written renderer was the third option and the worst: list
// nesting, lazy continuation and tables are where small renderers are wrong, and README files use
// all three. `vendor/marked.umd.cjs` is checked against its sha256 in the test, so it cannot drift
// from the published file unnoticed.
//
// Raw HTML in the document is kept — READMEs use `<img width>`, `<details>`, `<br>` — and made
// inert by the page's CSP instead: no script of any kind, no frames, no plugins, no fetches. A
// Markdown file from a cloned repository is untrusted, and with `script-src 'none'` inline
// handlers and `javascript:` links do not run either. tweb's own preload is unaffected by page CSP,
// so hints, the agent socket and the shortcuts work on the rendered page as on any other.

const path = require("node:path");
const { Marked } = require("./vendor/marked.umd.cjs");

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);

// Images and media may come from disk or the web, styles only from the page itself. Nothing else.
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "img-src file: data: https: http:",
  "media-src file: https: http:",
  "style-src 'unsafe-inline'",
  "font-src file: data:",
  "script-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Whether a file: URL names a Markdown document.
 *
 * @param {string} url the request URL
 * @returns {boolean}
 */
function isMarkdownUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return false;
    return MARKDOWN_EXTENSIONS.has(path.extname(decodeURIComponent(parsed.pathname)).toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Whether the request wants the document rendered: a navigation, not a script reading the file.
 *
 * A local HTML page that `fetch()`es a `.md` to render it its own way must still get the source,
 * so the request has to say it is loading a document. Chromium marks a navigation with an Accept
 * header that leads with `text/html`; `fetch()` and XHR send `*\/*` unless told otherwise.
 *
 * @param {{url: string, headers?: {get(name: string): string|null}}} request
 * @returns {boolean}
 */
function wantsRenderedMarkdown(request) {
  if (!isMarkdownUrl(request.url)) return false;
  const accept = request.headers?.get?.("accept") || "";
  return /^\s*text\/html\b/i.test(accept);
}

/**
 * GitHub's heading anchors, so `[Install](#install)` and links from other documents land.
 * Lowercase, punctuation dropped, spaces to hyphens, a repeated slug numbered `-1`, `-2`, ….
 */
function createSlugger() {
  const seen = new Map();
  return (text) => {
    const base = String(text)
      .toLowerCase()
      .trim()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * The document as an HTML page.
 *
 * @param {string} source the Markdown text
 * @param {string} fileName shown as the title when the document has no heading
 * @returns {string}
 */
function renderMarkdownPage(source, fileName) {
  const slug = createSlugger();
  let title = null;
  const marked = new Marked({ gfm: true }, {
    renderer: {
      heading(token) {
        const text = this.parser.parseInline(token.tokens);
        if (title === null) title = token.text;
        return `<h${token.depth} id="${escapeHtml(slug(token.text))}">${text}</h${token.depth}>\n`;
      },
    },
  });
  const body = marked.parse(String(source));
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHtml(title || fileName)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --code: #f6f8fa; --link: #0969da; --bg: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --code: #151b23; --link: #4493f8; --bg: #0d1117; }
  }
  html { background: var(--bg); color: var(--fg); }
  body { margin: 0 auto; max-width: 880px; padding: 32px 40px 64px; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; overflow-wrap: break-word; }
  h1, h2, h3, h4, h5, h6 { margin: 1.5em 0 0.6em; line-height: 1.25; font-weight: 600; }
  h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); margin-top: 0; }
  h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
  p, ul, ol, pre, table, blockquote, details { margin: 0 0 1em; }
  a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
  code, pre { font: 0.875em/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { background: var(--code); padding: 0.2em 0.4em; border-radius: 6px; }
  pre { background: var(--code); padding: 16px; border-radius: 6px; overflow: auto; }
  pre code { background: none; padding: 0; font-size: 1em; }
  blockquote { color: var(--muted); border-left: 0.25em solid var(--line); margin-left: 0; padding: 0 1em; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 1.5em 0; }
  table { border-collapse: collapse; display: block; overflow: auto; }
  th, td { border: 1px solid var(--line); padding: 6px 13px; } th { font-weight: 600; }
  img { max-width: 100%; }
  li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.2em; }
</style></head>
<body>
${body}</body></html>`;
}

/**
 * Answers one file: request.
 *
 * @param {Request} request what Chromium asked for
 * @param {{passThrough: (request: Request) => Promise<Response>, readFile: (file: string) => Promise<Buffer>}} io
 *   `passThrough` is Chromium's own loader (net.fetch with custom handlers bypassed); injected,
 *   with `readFile`, so this runs in a test without Electron
 * @returns {Promise<Response>}
 */
async function handleFileRequest(request, io) {
  if (!wantsRenderedMarkdown(request)) return io.passThrough(request);
  let file;
  try {
    file = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return io.passThrough(request);
  }
  let source;
  try {
    source = await io.readFile(file);
  } catch {
    // Missing, a directory, unreadable: Chromium's loader produces the error page it always has.
    return io.passThrough(request);
  }
  return new Response(renderMarkdownPage(source.toString("utf8"), path.basename(file)), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CONTENT_SECURITY_POLICY,
    },
  });
}

module.exports = {
  isMarkdownUrl,
  wantsRenderedMarkdown,
  createSlugger,
  renderMarkdownPage,
  handleFileRequest,
  CONTENT_SECURITY_POLICY,
};
