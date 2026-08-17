"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PDF_EXTENSION_PREFIX,
  COLLAPSED_VIEWPORT_LIMIT,
  pdfKeyAction,
  pdfViewportScript,
  findPdfFrame,
} = require("./pdf-frame.cjs");

const VIMIUM = { vimium: true };
const PASSTHROUGH = { vimium: false };

test("the navigation keys move the viewport in both shortcut modes", () => {
  for (const state of [VIMIUM, PASSTHROUGH]) {
    assert.deepEqual(pdfKeyAction("ArrowDown", [], state).action,
      { kind: "by", dx: 0, dy: 40, unit: "px" });
    assert.deepEqual(pdfKeyAction("PageDown", [], state).action,
      { kind: "by", dx: 0, dy: 1, unit: "viewport" });
    assert.deepEqual(pdfKeyAction("End", [], state).action, { kind: "to", where: "end" });
    assert.deepEqual(pdfKeyAction("Home", [], state).action, { kind: "to", where: "start" });
  }
});

test("space pages down, shift-space pages up, under either spelling", () => {
  for (const key of [" ", "Space"]) {
    assert.deepEqual(pdfKeyAction(key, [], VIMIUM).action,
      { kind: "by", dx: 0, dy: 1, unit: "viewport" });
    assert.deepEqual(pdfKeyAction(key, ["shift"], VIMIUM).action,
      { kind: "by", dx: 0, dy: -1, unit: "viewport" });
  }
});

test("vim motions only act in browser-shortcut mode, matching what Chrome does with j", () => {
  assert.deepEqual(pdfKeyAction("j", [], VIMIUM).action, { kind: "by", dx: 0, dy: 90, unit: "px" });
  assert.deepEqual(pdfKeyAction("k", [], VIMIUM).action, { kind: "by", dx: 0, dy: -90, unit: "px" });
  assert.deepEqual(pdfKeyAction("d", [], VIMIUM).action, { kind: "by", dx: 0, dy: 0.5, unit: "viewport" });
  assert.deepEqual(pdfKeyAction("G", [], VIMIUM).action, { kind: "to", where: "end" });
  assert.equal(pdfKeyAction("j", [], PASSTHROUGH).action, null);
  assert.equal(pdfKeyAction("G", [], PASSTHROUGH).action, null);
});

test("gg is two keystrokes and only the pair jumps to the start", () => {
  const first = pdfKeyAction("g", [], VIMIUM);
  assert.equal(first.action, null);
  assert.equal(first.pendingG, true);
  const second = pdfKeyAction("g", [], { vimium: true, pendingG: true });
  assert.deepEqual(second.action, { kind: "to", where: "start" });
  assert.equal(second.pendingG, false);
});

test("a pending g does not survive an unrelated key", () => {
  assert.equal(pdfKeyAction("j", [], { vimium: true, pendingG: true }).pendingG, false);
  assert.equal(pdfKeyAction("q", [], { vimium: true, pendingG: true }).pendingG, false);
});

test("n and p step whole pages, which is what a five-page document needs", () => {
  assert.deepEqual(pdfKeyAction("n", [], VIMIUM).action, { kind: "page", delta: 1 });
  assert.deepEqual(pdfKeyAction("p", [], VIMIUM).action, { kind: "page", delta: -1 });
});

test("a modified key belongs to TWeb or the page, never to the viewer", () => {
  // Ctrl-PageDown cycles tabs and Cmd-ArrowDown is the page's own shortcut. Claiming
  // either here would take a working key away to scroll a PDF.
  assert.equal(pdfKeyAction("PageDown", ["control"], VIMIUM).action, null);
  assert.equal(pdfKeyAction("ArrowDown", ["meta"], VIMIUM).action, null);
  assert.equal(pdfKeyAction("j", ["alt"], VIMIUM).action, null);
});

test("keys the viewer has no motion for are left alone", () => {
  assert.equal(pdfKeyAction("f", [], VIMIUM).action, null);
  assert.equal(pdfKeyAction("Enter", [], VIMIUM).action, null);
  assert.equal(pdfKeyAction("", [], VIMIUM).action, null);
});

test("a viewport step is a multiple of the visible height, a px step is not", () => {
  const viewport = pdfViewportScript({ kind: "by", dx: 0, dy: 1, unit: "viewport" }, 570);
  assert.match(viewport, /vp\.size\.height/);
  const pixels = pdfViewportScript({ kind: "by", dx: 0, dy: 90, unit: "px" }, 570);
  assert.doesNotMatch(pixels, /vp\.size\.height/);
  assert.match(pixels, /p\.y \+ \(90\)/);
});

test("a collapsed offscreen surface falls back to the pane's own height", () => {
  // Measured: on a pane at window.visible=false the viewer reported a viewport one pixel
  // tall, so PageDown moved the document by 1px. A key that works only while somebody is
  // watching the pane is the failure mode this guard exists for.
  const script = pdfViewportScript({ kind: "by", dx: 0, dy: 1, unit: "viewport" }, 570);
  assert.match(script, new RegExp(`vp\\.size\\.height > ${COLLAPSED_VIEWPORT_LIMIT}`));
  assert.match(script, /: 570\)/);
});

test("the fallback height is rounded and never negative", () => {
  assert.match(pdfViewportScript({ kind: "by", dx: 0, dy: 1, unit: "viewport" }, 570.6), /: 571\)/);
  assert.match(pdfViewportScript({ kind: "by", dx: 0, dy: 1, unit: "viewport" }, -5), /: 0\)/);
  assert.match(pdfViewportScript({ kind: "by", dx: 0, dy: 1, unit: "viewport" }), /: 0\)/);
});

test("every generated script answers rather than throwing when the viewer is not there", () => {
  for (const action of [
    { kind: "by", dx: 0, dy: 90, unit: "px" },
    { kind: "to", where: "end" },
    { kind: "to", where: "start" },
    { kind: "page", delta: 1 },
  ]) {
    const script = pdfViewportScript(action, 570);
    assert.match(script, /if \(!vp \|\| typeof vp\.setPosition !== 'function'\) return \{ ok: false/);
    assert.match(script, /return \{ ok: true/);
  }
});

test("end scrolls to the document height, which the viewer clamps onto the last page", () => {
  assert.match(pdfViewportScript({ kind: "to", where: "end" }, 570), /vp\.contentSize\.height/);
  assert.match(pdfViewportScript({ kind: "to", where: "start" }, 570), /\{ x: 0, y: 0 \}/);
});

test("page steps call the viewer's own paging, not a pixel guess", () => {
  assert.match(pdfViewportScript({ kind: "page", delta: 1 }, 570), /vp\.goToNextPage\(\)/);
  assert.match(pdfViewportScript({ kind: "page", delta: -1 }, 570), /vp\.goToPreviousPage\(\)/);
});

test("no action produces no script", () => {
  assert.equal(pdfViewportScript(null, 570), null);
  assert.equal(pdfViewportScript({ kind: "nonsense" }, 570), null);
});

function fakeFrame(url, parent, extra = {}) {
  return { url, parent, detached: false, isDestroyed: () => false, ...extra };
}

test("the viewer is found when it is the top document's own child", () => {
  const main = { framesInSubtree: [] };
  const viewer = fakeFrame(`${PDF_EXTENSION_PREFIX}index.html`, main);
  main.framesInSubtree = [main, viewer];
  assert.equal(findPdfFrame(main), viewer);
});

test("a PDF embedded inside a page keeps its keys, because the page still owns them", () => {
  const main = { framesInSubtree: [] };
  const embed = fakeFrame("https://example.com/embed", main);
  const viewer = fakeFrame(`${PDF_EXTENSION_PREFIX}index.html`, embed);
  main.framesInSubtree = [main, embed, viewer];
  assert.equal(findPdfFrame(main), null);
});

test("a destroyed or detached viewer frame is not returned", () => {
  const main = { framesInSubtree: [] };
  const dead = fakeFrame(`${PDF_EXTENSION_PREFIX}index.html`, main, { isDestroyed: () => true });
  main.framesInSubtree = [main, dead];
  assert.equal(findPdfFrame(main), null);
  const detached = fakeFrame(`${PDF_EXTENSION_PREFIX}index.html`, main, { detached: true });
  main.framesInSubtree = [main, detached];
  assert.equal(findPdfFrame(main), null);
});

test("an ordinary page has no viewer, and a missing frame is not an error", () => {
  const main = { framesInSubtree: [] };
  main.framesInSubtree = [main, fakeFrame("https://example.com/a", main)];
  assert.equal(findPdfFrame(main), null);
  assert.equal(findPdfFrame(null), null);
});

test("a frame whose properties throw is skipped rather than taking the tab down", () => {
  const main = { framesInSubtree: [] };
  const hostile = {
    get url() { throw new Error("frame gone"); },
    detached: false,
    isDestroyed: () => false,
  };
  const viewer = fakeFrame(`${PDF_EXTENSION_PREFIX}index.html`, main);
  main.framesInSubtree = [main, hostile, viewer];
  assert.equal(findPdfFrame(main), viewer);
});
