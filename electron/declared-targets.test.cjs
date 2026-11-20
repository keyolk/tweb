"use strict";

// A surface that draws its own click targets — a graph on a <canvas> — declares them, and each one
// becomes a hint. Reported on the briefs index's Graph tab: its nodes are drawn on one canvas, so
// `f` offered one badge for the whole canvas, which clicked its centre, and no node at all.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));

// `declaredTargets` run against a fake element: the page's answer is whatever `answer` writes when
// the event arrives, as a page's handler would.
function load({ box, viewport = { width: 1000, height: 800 } }) {
  const body = slice("const DECLARED_TARGETS_MAX", "  // Every declared target in the roots");
  const factory = new Function("visibleRect", "ownerView", "innerWidth", "innerHeight",
    `${body}; return declaredTargets;`);
  return factory(() => box, () => ({ CustomEvent: class { constructor(type, init) { this.type = type; this.bubbles = init.bubbles; } } }),
    viewport.width, viewport.height);
}

function element(answer, initial = null) {
  const attributes = new Map(initial === null ? [] : [["data-tweb-targets", initial]]);
  const dispatched = [];
  return {
    dispatched,
    dispatchEvent(event) {
      dispatched.push(event);
      if (answer) attributes.set("data-tweb-targets", JSON.stringify(answer()));
      return true;
    },
    getAttribute: (name) => attributes.get(name) ?? null,
  };
}

const box = { left: 100, top: 50, right: 700, bottom: 450, width: 600, height: 400 };

test("the page is asked at the round and its boxes become targets in viewport coordinates", () => {
  const declaredTargets = load({ box });
  const canvas = element(() => [
    { x: 10, y: 20, w: 30, h: 30, label: "node a" },
    { x: 500, y: 300, w: 20, h: 20, label: "node b", action: "dblclick" },
  ]);
  const targets = declaredTargets(canvas);
  assert.equal(canvas.dispatched.length, 1);
  assert.equal(canvas.dispatched[0].type, "tweb:targets");
  assert.equal(canvas.dispatched[0].bubbles, true);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0].nativePoint, { x: 125, y: 85 });
  assert.equal(targets[0].rect.left, 110);
  assert.equal(targets[0].rect.top, 70);
  assert.equal(targets[0].label, "node a");
  assert.equal(targets[0].declared, true);
  assert.equal(targets[0].doubleClick, false);
  assert.equal(targets[1].doubleClick, true);
  assert.equal(targets[1].element, canvas);
});

test("a static attribute works without a listener", () => {
  const declaredTargets = load({ box });
  const targets = declaredTargets(element(null, JSON.stringify([{ x: 0, y: 0, w: 10, h: 10 }])));
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].nativePoint, { x: 105, y: 55 });
});

test("an element that never answers declares nothing, so it keeps its own hint", () => {
  const declaredTargets = load({ box });
  assert.equal(declaredTargets(element(null)), null);
  assert.equal(declaredTargets(element(null, "not json")), null);
  assert.equal(declaredTargets(element(null, "{\"x\":1}")), null);
});

test("boxes off the element, off the viewport or malformed are dropped", () => {
  const declaredTargets = load({ box: { left: 0, top: 600, right: 600, bottom: 1000, width: 600, height: 400 },
    viewport: { width: 1000, height: 800 } });
  const targets = declaredTargets(element(() => [
    { x: 10, y: 10, w: 20, h: 20 },        // on screen
    { x: 10, y: 300, w: 20, h: 20 },       // inside the element, below the viewport
    { x: -100, y: 10, w: 20, h: 20 },      // left of the element
    { x: 10, y: 10, w: 0, h: 20 },         // no area
    { x: "a", y: 10, w: 20, h: 20 },       // not a number
    null,
  ]));
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].nativePoint, { x: 20, y: 620 });
});

test("a hidden element declares an empty set, and a huge list is capped", () => {
  assert.deepEqual(load({ box: null })(element(() => [{ x: 0, y: 0, w: 5, h: 5 }])), []);
  const many = Array.from({ length: 1000 }, (_, i) => ({ x: i % 500, y: 5, w: 4, h: 4 }));
  assert.equal(load({ box })(element(() => many)).length, 300);
});

test("the round replaces the element's own hint with what it declared, and clicks their centres", () => {
  const targets = slice("function interactiveTargets()", "function resourceUrl(value, element)");
  assert.match(targets, /declaredTargetsByElement\(roots\)/);
  assert.match(targets, /targets\.filter\(\(item\) => !declared\.has\(item\.element\)\)/);
  assert.match(targets, /\.filter\(reachableAt\)/, "a declared box under an overlay is not offered");
  const click = slice("function hintClickPoint(item)", "const REACH_RATIOS");
  assert.match(click, /\(item\.mediaControl \|\| item\.declared\) && item\.nativePoint/);
  assert.match(source, /item\.doubleClick \? \{ \.\.\.hintClickPoint\(item\), count: 2 \}/);
  // An agent sees the declared target as a button with the page's label.
  assert.match(slice("function agentRole(element, item)", "function agentName"), /item\?\.declared\) return "button"/);
  assert.match(slice("function agentName(element, item)", "function agentValue"), /item\?\.declared && item\.label\) return item\.label/);
});

test("a native click with count 2 is a double click", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const handler = main.slice(main.indexOf('case "native-click":'), main.indexOf('case "native-drag":'));
  assert.match(handler, /const count = value\.count === 2 \? 2 : 1;/);
  assert.match(handler, /for \(let clickCount = 1; clickCount <= count; clickCount \+= 1\)/);
});
