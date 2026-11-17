"use strict";

// `y` opens a copy menu instead of copying at once, and the second key names what to copy.
// These run the real copy-menu code out of preload.cjs against fakes: the rows each context
// produces (and what `yy` resolves to), that `y` alone copies nothing, that each combo sends the
// right thing, that a password never reaches a preview or the clipboard, and that a key the menu
// does not own goes on to the page.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { markdownLink, clipboardUrl } = require("./copy-format.cjs");

const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");

function slice(from, to) {
  const start = preload.indexOf(from);
  const end = preload.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} is gone`);
  return preload.slice(start, end);
}

const menuSource = slice("  // --- copy menu (`y`) ---", "  // Enter on a `v` pick clicks it");

function fakeNode(tag = "div") {
  return {
    localName: tag,
    style: {},
    children: [],
    textContent: "",
    append(...nodes) { this.children.push(...nodes); },
    attachShadow() { return fakeNode("#shadow"); },
    remove() { this.removed = true; },
  };
}

// counts: how many targets each picking row would label.
function harness({ visual = null, selection = "", active = null, counts = {} } = {}) {
  const sent = [];
  const flashes = [];
  const modes = [];
  const picks = [];
  const env = { visual, selection, active, counts, sent, flashes, modes, picks, appended: [] };
  const api = new Function("env", `
    let visualState = env.visual;
    let copyMenuState = null;
    let indicatorMode = "normal";
    let indicatorDetail = "";
    const location = { href: "https://example.com/a(1)" };
    const document = {
      title: "Example [docs]",
      createElement: (tag) => (${fakeNode.toString()})(tag),
      documentElement: { append: (node) => env.appended.push(node) },
    };
    const window = { getSelection: () => ({ toString: () => env.selection }) };
    const isTag = (element, ...names) => names.includes(element?.localName);
    const visualSelection = () => ({ toString: () => env.visual?.selectedText || "" });
    const activeElement = () => env.active;
    const isEditable = (element) => Boolean(element?.editable);
    const imageSource = (image) => image?.src || "";
    const collectRoots = () => [];
    const uniqueVisibleTargets = () => [];
    const send = (...args) => env.sent.push(args);
    const flash = (message) => env.flashes.push(message);
    const setMode = (mode, detail) => { indicatorMode = mode; indicatorDetail = detail; env.modes.push([mode, detail]); };
    const paintNow = () => {};
    const cancelVisual = () => { visualState = null; env.visual = null; };
    const startPicker = (targets, mode, onPick) => env.picks.push({ targets, mode, onPick });
    ${menuSource}
    // The DOM-reading half, replaced by the counts this test asks for.
    copyPickTargets = (kind) => Array.from({ length: env.counts[kind] || 0 }, (_, i) => ({
      element: { isConnected: true, href: "https://example.com/l" + i, innerText: "x\\ny", textContent: "x\\ny" },
      image: { localName: "img", naturalWidth: 10, naturalHeight: 20 },
      imageURL: "https://example.com/i" + i + ".png",
      rect: { top: i, left: 0 },
    }));
    return {
      rows: () => copyMenuRows(copyMenuContext()),
      open: () => startCopyMenu(),
      key: (key) => {
        const event = { prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
        return { handled: handleCopyMenuKey(event, key), prevented: event.prevented };
      },
      isOpen: () => Boolean(copyMenuState),
      visual: () => visualState,
      paste: (newTab) => pasteOrOpen(newTab),
      markdownLink,
    };
  `)(env);
  return { ...api, env };
}

const row = (rows, key) => rows.find((candidate) => candidate.key === key);

test("with nothing picked or selected, yy is the page URL and the label rows count their targets", () => {
  const h = harness({ counts: { image: 7, link: 52 } });
  const rows = h.rows();
  assert.deepEqual(rows.map((r) => r.key), ["y", "t", "u", "l", "i", "s", "c", "f"]);
  assert.equal(row(rows, "y").resolves, "u");
  assert.match(row(rows, "y").preview, /^= yu · https:\/\/example\.com\/a\(1\) · page$/);
  assert.deepEqual(row(rows, "t"), { key: "t", kind: "text", available: false, reason: "no selection" });
  assert.deepEqual(row(rows, "u").action, { type: "page-url" });
  assert.deepEqual(row(rows, "l").action, { type: "page-markdown" });
  assert.match(row(rows, "l").preview, /^\[Example \\\[docs\\\]\]\(https:\/\/example\.com\/a%281%29\) · page$/);
  assert.equal(row(rows, "i").preview, "pick with labels · 7 images");
  assert.deepEqual(row(rows, "i").action, { type: "pick", target: "image" });
  assert.equal(row(rows, "c").available, false);
  assert.equal(row(rows, "c").reason, "no code blocks");
  assert.equal(row(rows, "f").preview, "pick with labels · 52 links");
});

test("with text selected, yy and yt are that text, previewed and counted", () => {
  const h = harness({ selection: "The quick brown fox" });
  const rows = h.rows();
  assert.equal(row(rows, "y").resolves, "t");
  assert.equal(row(rows, "t").preview, '"The quick brown fox" · 19 chars');
  assert.deepEqual(row(rows, "t").action, { type: "text", text: "The quick brown fox", flash: "text 19 chars" });
});

test("on a v pick, yy is the image, the link address, or the text — and the text in a caret", () => {
  const image = { localName: "img", naturalWidth: 800, naturalHeight: 600, src: "https://cdn.test/a.png" };
  const picked = harness({ visual: { kind: "image", element: image, image, imageURL: image.src } }).rows();
  assert.equal(row(picked, "y").resolves, "i");
  assert.equal(row(picked, "i").preview, "800×600 · the picked image");
  assert.deepEqual(row(picked, "s").action, { type: "text", text: "https://cdn.test/a.png", flash: "image URL" });
  assert.deepEqual(row(picked, "u").action, { type: "text", text: "https://cdn.test/a.png", flash: "URL" });

  const link = { href: "https://a.test/x", innerText: "Read more" };
  const element = { localName: "a", innerText: "Read more", getAttribute: () => null };
  const onLink = harness({ visual: { kind: "link", element, link } }).rows();
  assert.equal(row(onLink, "y").resolves, "u");
  assert.deepEqual(row(onLink, "u").action, { type: "text", text: "https://a.test/x", flash: "URL" });
  assert.deepEqual(row(onLink, "l").action, { type: "text", text: "[Read more](https://a.test/x)", flash: "markdown link" });

  const caret = harness({ visual: { kind: "link", caret: true, element, link } }).rows();
  assert.equal(row(caret, "y").resolves, "t", "a caret is a text cursor");

  const pre = { localName: "pre", innerText: "a\nb\nc\n" };
  const code = { localName: "code", innerText: "a\nb\nc\n", getAttribute: () => null, closest: (s) => (s === "pre" ? pre : null) };
  const inCode = harness({ visual: { kind: "text", element: code } }).rows();
  assert.equal(row(inCode, "c").preview, "a · 3 lines");
  assert.equal(row(inCode, "c").action.flash, "code 3 lines");
});

test("a password field is never previewed or copied", () => {
  const field = { localName: "input", type: "password", value: "hunter2", getAttribute: () => null };
  const h = harness({ visual: { kind: "editable", element: field } });
  const rows = h.rows();
  assert.equal(row(rows, "t").available, false);
  assert.equal(row(rows, "t").reason, "password field");
  assert.equal(row(rows, "y").available, false);
  assert.ok(!JSON.stringify(rows).includes("hunter2"), "the value must not appear in any row");
  h.open();
  h.key("y");
  h.open();
  h.key("t");
  assert.ok(!JSON.stringify(h.env.sent).includes("hunter2"));

  const otp = { localName: "input", type: "text", value: "123456", getAttribute: (name) => (name === "autocomplete" ? "one-time-code" : null) };
  assert.equal(row(harness({ visual: { kind: "editable", element: otp } }).rows(), "t").available, false);
  // A secret field focused in normal mode: its selection is not offered either.
  assert.equal(row(harness({ selection: "hunter2", active: field }).rows(), "t").available, false);
});

test("y alone copies nothing; the second key copies", () => {
  const h = harness({ selection: "hello" });
  h.open();
  assert.ok(h.isOpen());
  assert.deepEqual(h.env.sent, [], "y opens a menu and copies nothing");
  assert.deepEqual(h.env.modes.at(-1), ["normal", "y…"]);
  assert.deepEqual(h.key("t"), { handled: true, prevented: true });
  assert.deepEqual(h.env.sent, [["copy-text", "hello"]]);
  assert.deepEqual(h.env.flashes, ["text 5 chars"]);
  assert.equal(h.isOpen(), false);

  for (const [key, expected] of [["u", [["copy-url"]]], ["l", [["copy-page-markdown"]]], ["y", [["copy-text", "hello"]]]]) {
    const each = harness({ selection: key === "y" ? "hello" : "" });
    each.open();
    each.key(key);
    assert.deepEqual(each.env.sent, expected, `y${key}`);
  }
});

test("the label rows start a copy picker, and each pick copies its own thing", () => {
  for (const [key, target, expected] of [
    ["i", "image", (sent) => assert.equal(sent[0][0], "copy-image")],
    ["s", "image-src", (sent) => assert.deepEqual(sent, [["copy-text", "https://example.com/i0.png"]])],
    ["c", "code", (sent) => assert.deepEqual(sent, [["copy-text", "x\ny"]])],
    ["f", "link", (sent) => assert.deepEqual(sent, [["copy-text", "https://example.com/l0"]])],
  ]) {
    const h = harness({ counts: { image: 2, "image-src": 2, code: 1, link: 3 } });
    h.open();
    h.key(key);
    assert.equal(h.env.picks.length, 1, `y${key} starts a picker`);
    assert.equal(h.env.picks[0].mode, "copy");
    assert.ok(h.env.picks[0].targets.length > 0, target);
    h.env.picks[0].onPick(h.env.picks[0].targets[0]);
    expected(h.env.sent);
  }
});

test("a picked image is copied with its URL so main can fetch the original", () => {
  const image = {
    localName: "img", naturalWidth: 8, naturalHeight: 6, src: "https://cdn.test/a.png",
    getBoundingClientRect: () => ({ left: 10.4, top: 20.6, width: 30.2, height: 40 }),
  };
  const h = harness({ visual: { kind: "image", element: image, image, imageURL: image.src } });
  h.open();
  h.key("y");
  assert.deepEqual(h.env.sent, [["copy-image", { x: 10, y: 20, width: 31, height: 40, src: "https://cdn.test/a.png" }]]);
  assert.equal(h.visual(), null, "the pick ends once copied");
});

test("Esc closes only the menu, an unavailable row says why, and other keys go on to the page", () => {
  const visual = { kind: "text", element: { localName: "p", innerText: "para", getAttribute: () => null } };
  const h = harness({ visual });
  h.open();
  assert.deepEqual(h.key("Escape"), { handled: true, prevented: true });
  assert.equal(h.isOpen(), false);
  assert.ok(h.visual(), "Esc in the menu keeps the v pick");
  assert.deepEqual(h.env.sent, []);

  const empty = harness();
  empty.open();
  empty.key("c");
  assert.deepEqual(empty.env.sent, []);
  assert.deepEqual(empty.env.flashes, ["no code blocks"]);

  const page = harness();
  page.open();
  // Modifiers alone keep it open: Shift is half of `Y`-style keys.
  assert.equal(page.key("Shift").handled, true);
  assert.ok(page.isOpen());
  // `j` is not a menu key: the menu closes and `j` scrolls as usual.
  assert.deepEqual(page.key("j"), { handled: false, prevented: false });
  assert.equal(page.isOpen(), false);
  assert.deepEqual(page.env.sent, []);
  // With the menu closed the handler claims nothing at all.
  for (const key of ["j", "k", "t", "Escape"]) assert.equal(page.key(key).handled, false, key);
});

test("p pastes into a focused field and otherwise opens the clipboard URL; P always opens it", () => {
  const field = { editable: true, focus() { this.focused = true; }, getAttribute: () => null };
  const h = harness({ active: field });
  h.paste(false);
  assert.deepEqual(h.env.sent, [["paste"]]);
  assert.ok(field.focused);
  const none = harness();
  none.paste(false);
  none.paste(true);
  assert.deepEqual(none.env.sent, [["open-clipboard-url", { newTab: false }], ["open-clipboard-url", { newTab: true }]]);
});

test("the preload and main write the same markdown link", () => {
  const h = harness();
  for (const [text, url] of [["Example [docs]", "https://example.com/a(1)"], ["", "https://x.test/"],
    ["a\\b  c", "https://x.test/a b"]]) {
    assert.equal(h.markdownLink(text, url), markdownLink(text, url));
  }
  assert.equal(markdownLink("A [b]", "https://x.test/(c)"), "[A \\[b\\]](https://x.test/%28c%29)");
});

test("only a lone address on the clipboard counts as a URL", () => {
  assert.equal(clipboardUrl(" https://a.test/x?y=1 "), "https://a.test/x?y=1");
  assert.equal(clipboardUrl("github.com/keyolk/tweb"), "https://github.com/keyolk/tweb");
  assert.equal(clipboardUrl("localhost:5173/x"), "http://localhost:5173/x");
  assert.equal(clipboardUrl("file:///tmp/a.html"), "file:///tmp/a.html");
  for (const text of ["", "hello world", "see https://a.test", "not-a-url", "javascript:alert(1)", "a.b"]) {
    assert.equal(clipboardUrl(text), null, text);
  }
});

test("the help lists every copy combo and binds only y, p and P", () => {
  const start = preload.indexOf("  const shortcutHelpSections = [");
  const end = preload.indexOf("  const normalKeyActions");
  const sections = new Function(`${preload.slice(start, end)}\nreturn shortcutHelpSections;`)();
  const copy = sections.find(([title]) => title === "Copy and paste");
  assert.ok(copy, "a Copy and paste section");
  const keys = copy[1].map(([key]) => key);
  for (const key of ["y", "yy", "yt", "yu", "yl", "yi", "ys", "yc", "yf", "p · P"]) {
    assert.ok(keys.includes(key), `help row for ${key}`);
  }
  const bound = copy[1].flatMap(([, , bindings]) => Object.keys(bindings || {}));
  assert.deepEqual(bound.sort(), ["P", "p", "y"]);
  assert.ok(!preload.includes('["y", "copy the page URL"'), "y no longer copies the URL at once");
  // Every menu row the help names exists in the menu.
  const menuKeys = new Function(`${menuSource.slice(menuSource.indexOf("  const COPY_MENU_KINDS"), menuSource.indexOf("  // Rows in the order"))}\nreturn COPY_MENU_KINDS;`)();
  for (const key of Object.keys(menuKeys)) assert.ok(keys.includes(`y${key}`), `y${key} is in the help`);
});

test("the copy menu takes its second key before every other handler, and is a transient mode", () => {
  const normal = preload.slice(preload.indexOf("function handleNormalKey(event)"));
  const menu = normal.indexOf("if (handleCopyMenuKey(event, key)) return;");
  assert.ok(menu > 0 && menu < normal.indexOf("if (handleVisualKey(event, key)) return;"));
  assert.ok(menu < normal.indexOf('if (key === "Escape" && hasTransientMode()'), "Esc closes the menu, not the v pick");
  assert.match(preload, /return Boolean\(copyMenuState \|\| pickerState/);
  assert.match(preload, /function cancelTransient\(restoreMode = true\) \{\n {4}cancelCopyMenu\(false\);/);
  const visual = preload.slice(preload.indexOf("function handleVisualKey(event, key)"), preload.indexOf("function cssSelector(element)"));
  assert.match(visual, /else if \(key === "y"\) startCopyMenu\(\);/);
  assert.match(visual, /else if \(key === "Y"\) copyVisualText\(\);/);
});

test("main copies the original image through the tab's session, else what is shown", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /case "copy-image":\s+void copyImageToClipboard\(tab, contents, value\);/);
  const copy = main.slice(main.indexOf("async function fetchOriginalImage"), main.indexOf("function tabListModel()"));
  assert.match(copy, /contents\?\.session/);
  assert.match(copy, /session\.fetch\(src\)/);
  assert.match(copy, /nativeImage\.createFromBuffer\(buffer\)/);
  assert.match(copy, /contents\.capturePage\(rect\)/, "the pixels shown are the fallback");
  assert.match(main, /case "copy-page-markdown":\s+clipboard\.writeText\(markdownLink\(/);
  assert.match(main, /case "open-clipboard-url": \{\s+const text = clipboard\.readText\(\);\s+const url = clipboardUrl\(text\);/);
});

// The rows preview page text, so the panel must hide the page under it: a translucent
// background let YouTube's titles show through the previews.
test("the copy menu panel is opaque", () => {
  const preload = require("node:fs").readFileSync(require("node:path").join(__dirname, "preload.cjs"), "utf8");
  const at = preload.indexOf('host.id = "__tweb_copy_menu__";');
  const block = preload.slice(at, at + 1500);
  const bg = block.match(/"background:(#[0-9a-fA-F]+)"/);
  assert.ok(bg, "panel background");
  assert.ok(bg[1].length === 7 || bg[1].length === 4, `opaque colour, got ${bg[1]}`);
});
