"use strict";

// Everything `f` labels is a `v` target too. `v` collected content only (links, images, text
// blocks, fields), so buttons, tabs, click-handler rows and the items a canvas declares had no `v`
// label while `f` labelled them: on the briefs index `f` found 119 targets and 110 were missing
// from `v`, the Graph tab's canvas nodes among them. Reported 2026-11-24: "v로 선택가능한건 f로
// 보이는 태깅을 포함해야" — a canvas item could be clicked through `f` but not pointed at through `v`.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));

// visualClass, targetCell and visualTargets, run against fakes for what they call.
function load({ content = [], interactive = [], areas = [] }) {
  const body = slice("  // What a `v` pick of element is", "  // Comment panels, sidebars and chat logs");
  const factory = new Function(
    "collectRoots", "uniqueVisibleTargets", "interactiveTargets", "scrollableTargets",
    "insideEditorButNotBlock", "isEditable", "isMediaElement", "imageSource",
    `${body}; return visualTargets;`);
  const roots = [{ querySelectorAll: () => content.map((item) => item.element) }];
  return factory(
    () => roots,
    (elements, classify) => content.filter((item) => elements.includes(item.element))
      .map((item) => ({ element: item.element, rect: item.rect, ...classify(item.element) })),
    () => interactive,
    () => areas,
    () => false,
    (element) => Boolean(element.editable),
    (element) => element.localName === "video" || element.localName === "audio",
    () => "",
  );
}

function element(localName, { text = "", link = null, editable = false } = {}) {
  return {
    localName, innerText: text, editable,
    closest: (selector) => (selector === "a[href]" ? link : null),
    matches: (selector) => selector.split(",").includes(localName),
    querySelector: () => null,
  };
}

const rect = (left, top, width = 40, height = 20) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });

test("a button, a tab and a canvas item that f labels are v targets, coloured as controls", () => {
  const button = element("button", { text: "Tags" });
  const tab = element("div", { text: "Graph" });
  const canvas = element("canvas");
  const node = { element: canvas, rect: rect(300, 300, 12, 12), nativePoint: { x: 306, y: 306 }, declared: true };
  const visualTargets = load({
    content: [{ element: canvas, rect: rect(100, 200, 600, 400) }],
    interactive: [{ element: button, rect: rect(10, 10) }, { element: tab, rect: rect(60, 10) }, node],
  });
  const targets = visualTargets();
  const byElement = (wanted) => targets.filter((item) => item.element === wanted);
  assert.deepEqual(byElement(button).map((item) => item.kind), ["control"]);
  assert.deepEqual(byElement(tab).map((item) => item.kind), ["control"]);
  // The declared node keeps its own point, which is where the pointer goes and where Enter clicks.
  const picked = targets.find((item) => item.declared);
  assert.equal(picked.kind, "control");
  assert.deepEqual(picked.nativePoint, { x: 306, y: 306 });
  // The canvas as a whole is still the image it was: a node inside it does not replace it.
  assert.ok(targets.some((item) => item.element === canvas && !item.declared && item.kind === "image"));
});

test("an element in both lists is one target, classified the way v knows it", () => {
  const anchor = element("a", { text: "Docs" });
  anchor.closest = () => anchor;
  const field = element("input", { editable: true });
  const visualTargets = load({
    content: [{ element: anchor, rect: rect(10, 10) }, { element: field, rect: rect(10, 50) }],
    interactive: [{ element: anchor, rect: rect(10, 10) }, { element: field, rect: rect(10, 50) }],
  });
  const targets = visualTargets();
  assert.deepEqual(targets.map((item) => [item.element.localName, item.kind]), [["a", "link"], ["input", "editable"]]);
});

test("a text block sharing a control's corner gives the cell to the control", () => {
  const item = element("li", { text: "Archived 86" });
  const button = element("button", { text: "Archived 86" });
  const visualTargets = load({
    content: [{ element: item, rect: rect(10, 10, 200, 20) }],
    interactive: [{ element: button, rect: rect(11, 10, 120, 20) }],
  });
  assert.deepEqual(visualTargets().map((target) => target.element.localName), ["button"]);
});

test("a video stays one media target; its per-button targets from f are controls", () => {
  const video = element("video");
  const visualTargets = load({
    content: [{ element: video, rect: rect(0, 0, 640, 360) }],
    interactive: [
      { element: video, rect: rect(312, 172, 16, 16), nativePoint: { x: 320, y: 180 } },
      { element: video, rect: rect(18, 312, 16, 16), mediaControl: "play" },
    ],
  });
  const targets = visualTargets();
  assert.deepEqual(targets.map((item) => [item.kind, item.mediaControl || null]), [["media", null], ["control", "play"]]);
});

test("a control pick points the mouse at it; other picks do not", () => {
  const enter = slice("function enterVisual(item) {", "function startVisual()");
  assert.match(enter, /if \(item\.kind === "control"\) send\("native-hover", hintClickPoint\(item\)\);/);
  assert.match(source, /control: \{ fill: "#c58af9", border: "#7b1fa2" \},/);
  assert.match(source, /\["media", "media"\], \["control", "control"\]\];/);
});
