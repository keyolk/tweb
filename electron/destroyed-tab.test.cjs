"use strict";

// A pane kept a destroyed tab as its active one, and every mouse report on it threw "Object has been
// destroyed" in dispatchMouse — each throw a modal "Uncaught Exception" dialog from the hosted
// engine. The pane now drops destroyed tabs itself, and an uncaught exception is logged, not shown.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
const between = (from, to) => main.slice(main.indexOf(from), main.indexOf(to));

function load(windows) {
  const body = between("function reconcileDestroyedTabs() {", "function activateTab(index) {");
  const calls = { activated: [], sent: 0, logged: [] };
  const fn = new Function("currentWindows", "activateTab", "sendTabState", "console", `${body}; return reconcileDestroyedTabs;`)(
    () => windows,
    (index) => {
      calls.activated.push({ index, winBefore: windows.win });
      windows.activeTabIndex = index;
      windows.win = windows.tabs[index];
    },
    () => { calls.sent += 1; },
    { error: (line) => calls.logged.push(line) },
  );
  return { reconcile: fn, calls };
}

const tab = (name, destroyed = false) => ({ name, isDestroyed: () => destroyed });

test("nothing destroyed: nothing changes", () => {
  const a = tab("a"), b = tab("b");
  const windows = { tabs: [a, b], win: b, activeTabIndex: 1 };
  const { reconcile, calls } = load(windows);
  assert.equal(reconcile(), false);
  assert.deepEqual(windows.tabs, [a, b]);
  assert.equal(windows.win, b);
  assert.equal(calls.activated.length, 0);
});

test("a destroyed active tab is dropped and its neighbour activated, with win cleared first", () => {
  const a = tab("a"), b = tab("b", true), c = tab("c");
  const windows = { tabs: [a, b, c], win: b, activeTabIndex: 1, previousTab: b };
  const { reconcile, calls } = load(windows);
  assert.equal(reconcile(), true);
  assert.deepEqual(windows.tabs.map((t) => t.name), ["a", "c"]);
  assert.equal(windows.win, c);
  assert.equal(calls.activated[0].winBefore, null, "activateTab must not see the destroyed tab as the one it leaves");
  assert.equal(windows.previousTab, null);
  assert.match(calls.logged[0], /dropped 1 destroyed tab\(s\), the active one among them/);
});

test("a destroyed background tab is dropped and the active index follows the active tab", () => {
  const a = tab("a", true), b = tab("b"), c = tab("c");
  const windows = { tabs: [a, b, c], win: c, activeTabIndex: 2 };
  const { reconcile, calls } = load(windows);
  assert.equal(reconcile(), true);
  assert.equal(windows.win, c);
  assert.equal(windows.activeTabIndex, 1);
  assert.equal(calls.activated.length, 0);
  assert.equal(calls.sent, 1);
});

test("a destroyed win that is not in the list at all is let go", () => {
  const a = tab("a");
  const windows = { tabs: [a], win: tab("ghost", true), activeTabIndex: 0 };
  const { reconcile } = load(windows);
  assert.equal(reconcile(), true);
  assert.equal(windows.win, a);
});

test("all destroyed: the pane holds no tab", () => {
  const windows = { tabs: [tab("a", true)], win: null, activeTabIndex: 0 };
  windows.win = windows.tabs[0];
  const { reconcile } = load(windows);
  assert.equal(reconcile(), true);
  assert.equal(windows.win, null);
  assert.equal(windows.activeTabIndex, -1);
});

test("input reconciles first, and a close the named pane does not hold reconciles every pane", () => {
  const input = between('if (command.kind === "input") {', "consumeRawInput();\n  }\n}");
  assert.match(input, /^if \(command\.kind === "input"\) \{\n    reconcileDestroyedTabs\(\);/);
  const closed = between('tab.on("closed", bindPane', "const wasActive = tab === currentWindows().win;");
  assert.match(closed, /if \(closedIndex < 0\) \{[\s\S]*forEachPane\(\(\) => reconcileDestroyedTabs\(\)\);/);
  assert.match(main, /function dispatchMouse\(cb, rawX, rawY, release\) \{\n  if \(!currentWindows\(\)\.win \|\| currentWindows\(\)\.win\.isDestroyed\(\)\) return;/);
});

test("an uncaught exception is logged with its pane and counted, not shown as a dialog", () => {
  assert.match(main, /process\.on\("uncaughtException", \(error\) => noteUncaught\("exception", error\)\);/);
  assert.match(main, /process\.on\("unhandledRejection", \(reason\) => noteUncaught\("rejection", reason\)\);/);
  const note = between("function noteUncaught(kind, error) {", 'process.on("uncaughtException"');
  assert.match(note, /uncaughtErrors \+= 1/);
  assert.match(note, /console\.error\(`tweb: uncaught/);
  assert.match(main, /engine: \{ uncaught: uncaughtErrors, lastUncaught \}/);
});

// The root cause of the destroyed active tab: closing the active tab ran `activateTab` from the
// tab's own `closed` handler, and `activateTab` asked the closed tab — still in `win`, destroyed —
// whether it keeps its size. The throw stopped the handler half way and left the pane on the dead
// tab with an index past the end of its list. Reproduced with `tweb tab close` on the active tab:
// one tab left, active index 1, every later call "no active tab".
test("activating a tab never asks a destroyed tab anything, and a closed active tab is let go first", () => {
  const activate = between("function activateTab(index) {", "currentWindows().activeTabIndex = normalized;");
  assert.match(activate, /const leaving = current && !current\.isDestroyed\(\) \? current : null;/);
  assert.doesNotMatch(activate, /const leaving = currentWindows\(\)\.win;/);
  const closed = between('tab.on("closed", bindPane', "scheduleWindowSessionSave();\n  }));");
  assert.match(closed, /if \(wasActive\) \{\n\s+\/\/[^\n]*\n\s+currentWindows\(\)\.win = null;\n\s+activateTab\(/);
});

test("an agent call drops a dead tab before it looks for the active one", () => {
  const dispatch = between("async function dispatchAgentCommand(method, params) {", 'case "snapshot":');
  assert.match(dispatch, /reconcileDestroyedTabs\(\);\n  switch \(method\) \{/);
});
