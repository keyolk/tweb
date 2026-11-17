"use strict";

// The repair for a main frame whose preload is alive but unregistered, run for real against
// stub tabs. Observed on a YouTube pane: `shortcut frames=1 ready=1` (the one ready frame a
// hidden iframe), the mouse worked and every shortcut was dropped until a full reload, because
// the repair waited for a load that a streaming page never finishes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

function load() {
  const start = main.indexOf("const RECOVERY_PING_MS =");
  const end = main.indexOf("// Telling the pane that a page is on its way.");
  assert.ok(start > 0 && end > start, "repair block found in main.cjs");
  const timers = [];
  const ready = new Map();
  const scope = {
    setTimeout: (fn) => timers.push(fn),
    debugLogging: false,
    console: { error() {} },
    readyFrameKeys: (tab) => {
      if (!ready.has(tab)) ready.set(tab, new Set());
      return ready.get(tab);
    },
    frameKey: (frame) => frame.key,
  };
  const body = `${main.slice(start, end)}
return { repairShortcutDelivery, reregisterMainFrame: typeof reregisterMainFrame === "function" ? reregisterMainFrame : null };`;
  const api = new Function(...Object.keys(scope), body)(...Object.values(scope));
  return { ...api, timers, ready: scope.readyFrameKeys };
}

function stubTab({ loading }) {
  const sent = [];
  let reloads = 0;
  const frame = { key: "1:main", isDestroyed: () => false, detached: false, send: (channel) => sent.push(channel) };
  const tab = {
    isDestroyed: () => false,
    webContents: { mainFrame: frame, isLoading: () => loading, reload: () => { reloads += 1; } },
  };
  return { tab, sent, reloads: () => reloads };
}

test("a dropped key pings the main frame even while the page is still loading", () => {
  const { repairShortcutDelivery, timers } = load();
  const { tab, sent, reloads } = stubTab({ loading: true });
  repairShortcutDelivery(tab);
  assert.deepEqual(sent, ["tweb-are-you-there"]);
  // Unanswered and still loading: no reload, which would cancel the load.
  for (const fn of timers) fn();
  assert.equal(reloads(), 0);
});

test("an answered ping does not reload; silence on a loaded page does", () => {
  const { repairShortcutDelivery, timers, ready } = load();
  const answered = stubTab({ loading: false });
  repairShortcutDelivery(answered.tab);
  ready(answered.tab).add("1:main");
  timers.splice(0).forEach((fn) => fn());
  assert.equal(answered.reloads(), 0);

  const silent = stubTab({ loading: false });
  repairShortcutDelivery(silent.tab);
  timers.splice(0).forEach((fn) => fn());
  assert.equal(silent.reloads(), 1);
});

test("the end of a load re-registers an unregistered main frame and leaves a registered one alone", () => {
  const { reregisterMainFrame, ready } = load();
  assert.ok(reregisterMainFrame, "reregisterMainFrame exists");
  const lost = stubTab({ loading: false });
  reregisterMainFrame(lost.tab);
  assert.deepEqual(lost.sent, ["tweb-are-you-there"]);

  const fine = stubTab({ loading: false });
  ready(fine.tab).add("1:main");
  reregisterMainFrame(fine.tab);
  assert.deepEqual(fine.sent, []);
  assert.match(main, /onContents\("did-stop-loading", \(\) => reregisterMainFrame\(tab\)\);/);
});
