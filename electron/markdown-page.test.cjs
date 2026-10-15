"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  isMarkdownUrl, wantsRenderedMarkdown, createSlugger, renderMarkdownPage, handleFileRequest,
  CONTENT_SECURITY_POLICY,
} = require("./markdown-page.cjs");

const NAVIGATION = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const request = (url, accept) => ({ url, headers: new Headers(accept ? { accept } : {}) });

test("the vendored renderer is byte-for-byte the published marked 18.0.14", () => {
  // npm's marked-18.0.14.tgz, package/lib/marked.umd.js. Re-vendor and update this together.
  const file = fs.readFileSync(path.join(__dirname, "vendor", "marked.umd.cjs"));
  assert.equal(crypto.createHash("sha256").update(file).digest("hex"),
    "21568877a938d2c4e7d74e27f18e60da96bb73a68809610ca39216e1efebae62");
});

test("Markdown is recognised by extension, on file: only", () => {
  assert.equal(isMarkdownUrl("file:///Users/me/README.md"), true);
  assert.equal(isMarkdownUrl("file:///Users/me/Notes%20%231.MARKDOWN"), true);
  assert.equal(isMarkdownUrl("file:///Users/me/page.html"), false);
  assert.equal(isMarkdownUrl("https://example.com/README.md"), false);
  assert.equal(isMarkdownUrl("not a url"), false);
});

test("only a navigation is rendered; a script reading the file gets its source", () => {
  assert.equal(wantsRenderedMarkdown(request("file:///a/README.md", NAVIGATION)), true);
  assert.equal(wantsRenderedMarkdown(request("file:///a/README.md", "*/*")), false);
  assert.equal(wantsRenderedMarkdown(request("file:///a/README.md")), false);
  assert.equal(wantsRenderedMarkdown(request("file:///a/index.html", NAVIGATION)), false);
});

test("GFM renders: tables, task lists, strikethrough, autolinks, fenced code", () => {
  const html = renderMarkdownPage([
    "# Title", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "- [x] done", "",
    "~~old~~ https://example.com", "", "```js", "let a = 1 < 2;", "```",
  ].join("\n"), "x.md");
  assert.match(html, /<title>Title<\/title>/);
  assert.match(html, /<td>1<\/td>/);
  assert.match(html, /<input checked="" disabled="" type="checkbox">/);
  assert.match(html, /<del>old<\/del>/);
  assert.match(html, /<a href="https:\/\/example.com">/);
  assert.match(html, /<code class="language-js">let a = 1 &lt; 2;/);
});

test("relative links and images are left relative, to resolve against the file's own URL", () => {
  const html = renderMarkdownPage("[setup](./docs/setup.md) ![arch](images/arch.png)", "x.md");
  assert.match(html, /href="\.\/docs\/setup\.md"/);
  assert.match(html, /src="images\/arch\.png"/);
});

test("headings get GitHub's anchors, so #fragment links land", () => {
  const slug = createSlugger();
  assert.equal(slug("Getting Started!"), "getting-started");
  assert.equal(slug("Getting Started"), "getting-started-1");
  assert.equal(slug("한국어 제목"), "한국어-제목");
  assert.match(renderMarkdownPage("## Remote network (`--ssh`)", "x.md"), /<h2 id="remote-network---ssh">/);
});

test("a document without a heading is titled by its file name", () => {
  assert.match(renderMarkdownPage("just text", "notes.md"), /<title>notes\.md<\/title>/);
  assert.match(renderMarkdownPage("x", "<b>.md"), /<title>&lt;b&gt;\.md<\/title>/);
});

test("raw HTML is kept but the page can run nothing", () => {
  assert.match(renderMarkdownPage("<details><summary>s</summary>x</details>", "x.md"), /<details>/);
  for (const directive of ["script-src 'none'", "frame-src 'none'", "object-src 'none'", "default-src 'none'"]) {
    assert.ok(CONTENT_SECURITY_POLICY.includes(directive), directive);
  }
});

test("the handler renders navigations and passes everything else through", async () => {
  const passed = [];
  const io = {
    passThrough: async (req) => { passed.push(req.url); return new Response("raw"); },
    readFile: async (file) => {
      if (file === "/a/README.md") return Buffer.from("# Hello");
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
  const rendered = await handleFileRequest(request("file:///a/README.md", NAVIGATION), io);
  assert.equal(rendered.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(rendered.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  assert.match(await rendered.text(), /<h1 id="hello">Hello<\/h1>/);

  await handleFileRequest(request("file:///a/image.png", "image/*"), io);
  await handleFileRequest(request("file:///a/README.md", "*/*"), io);
  // A missing file gets Chromium's own error page rather than an empty document.
  await handleFileRequest(request("file:///a/missing.md", NAVIGATION), io);
  assert.deepEqual(passed, ["file:///a/image.png", "file:///a/README.md", "file:///a/missing.md"]);
});
