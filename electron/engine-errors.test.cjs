"use strict";

// An exception the engine catches (#288) is counted per kind, shown once in its pane as a badge that
// leaves the mode alone, and listed in `tweb status`. A bug firing on every mouse report is one
// badge with a count, not a dialog per move and not a flicker.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
const between = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to));

function load() {
  const body = between(main, "let uncaughtErrors = 0;", 'process.on("uncaughtException"');
  const sent = [];
  let now = 1000;
  const scope = { store: null };
  const api = new Function("paneScope", "console", "Date", "withPaneScope", "forEachPane", "currentWindows", "sendToMainTabFrame",
    `${body}; return { noteUncaught, engineErrorSummary, uncaughtKind };`)(
    { getStore: () => scope.store },
    { error: () => {} },
    { now: () => now },
    (record, fn) => fn(record),
    (fn) => { fn("p1"); fn("p2"); },
    () => ({ win: { isDestroyed: () => false } }),
    (_tab, channel, payload) => sent.push({ channel, ...payload }),
  );
  return { ...api, sent, scope, tick: (ms) => { now += ms; } };
}

function thrown(message, frame) {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at ${frame} (main.cjs:1:1)\n    at other (main.cjs:2:2)`;
  return error;
}

test("one kind is counted once per throw and announced the first time, then at most once a second", () => {
  const engine = load();
  engine.scope.store = { paneId: "%5" };
  const error = thrown("Object has been destroyed", "keepsSizeInStandby");
  engine.noteUncaught("exception", error);
  engine.noteUncaught("exception", error);
  engine.noteUncaught("exception", error);
  assert.equal(engine.sent.length, 1);
  assert.equal(engine.sent[0].first, true);
  assert.equal(engine.sent[0].channel, "tweb-engine-error");
  engine.tick(1500);
  engine.noteUncaught("exception", error);
  assert.equal(engine.sent.length, 2);
  assert.equal(engine.sent[1].first, false);
  assert.equal(engine.sent[1].count, 4);
  const summary = engine.engineErrorSummary();
  assert.equal(summary.count, 4);
  assert.equal(summary.last, "exception in %5: Object has been destroyed");
  assert.deepEqual(summary.kinds.map((kind) => kind.count), [4]);
});

test("a different frame is a different kind; with no pane in scope every pane is told", () => {
  const engine = load();
  engine.noteUncaught("exception", thrown("boom", "a"));
  engine.noteUncaught("rejection", thrown("boom", "b"));
  assert.equal(engine.engineErrorSummary().kinds.length, 2);
  // Two panes per announcement, two kinds.
  assert.equal(engine.sent.length, 4);
  assert.ok(engine.sent.every((report) => report.first));
  assert.notEqual(engine.uncaughtKind(thrown("boom", "a")), engine.uncaughtKind(thrown("boom", "b")));
});

test("announcing can never throw out of the handler", () => {
  const body = between(main, "function noteUncaught(kind, error) {", "/// What `tweb status` says");
  assert.match(body, /try \{ announceUncaught\(entry, record\); \} catch \(_\)/);
});

test("the badge leaves the mode alone, shows a new kind for a while, and only counts a repeat already up", () => {
  const handler = between(preload, 'ipcRenderer.on("tweb-engine-error"', 'ipcRenderer.on("tweb-flash"');
  assert.doesNotMatch(handler, /setMode|flash\(/);
  assert.match(handler, /if \(!report\.first && engineError\?\.key !== report\.key\) return;/);
  assert.match(handler, /setTimeout\(\(\) => \{\n\s+engineErrorTimer = null;\n\s+engineError = null;/);
  assert.match(preload, /errorBadge\.style\.display = engineError \? "" : "none";/);
});

test("tweb status carries the summary", () => {
  const status = between(main, 'case "status":', 'case "audio-sync":');
  assert.match(status, /engineErrors: engineErrorSummary\(\)/);
});
