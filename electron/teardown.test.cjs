"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { paneFrameFileList, runTeardownStep, runTeardown } = require("./teardown.cjs");
const { FRAME_FILE_PATTERN } = require("./orphan-watch.cjs");
const { IMAGE_ID_STRIDE } = require("./pane-registry.cjs");

// The enumeration existed only inside `before-quit` and `process.on("exit")`, which no test and no
// measurement reaches — an engine under test is killed by its frontend or by `kill -9`. A dead
// identifier there was invisible to a green suite by construction, and stayed invisible while 316
// Electron tests passed. These are the assertions that would have caught it.

test("every live pane's files are named, both formats and both staging names", () => {
  const names = paneFrameFileList([{ imageId: 100 }], 4242);
  assert.deepEqual(names.sort(), [
    "tweb-frame-4242-100.png",
    "tweb-frame-4242-100.png.tmp",
    "tweb-frame-4242-100.rgba",
    "tweb-frame-4242-100.rgba.tmp",
  ]);
});

// The correctness point beyond the crash: the shape this replaced held one process-wide pair, so a
// host serving N panes could only ever have deleted one pane's file however many existed.
test("N panes get N panes' files, not the first pane's", () => {
  const records = [100, 100 + IMAGE_ID_STRIDE, 100 + 2 * IMAGE_ID_STRIDE]
    .map((imageId) => ({ imageId }));
  const names = paneFrameFileList(records, 7);
  assert.equal(names.length, records.length * 4);
  for (const record of records) {
    assert.ok(names.includes(`tweb-frame-7-${record.imageId}.rgba`),
      `missing pane ${record.imageId}`);
  }
});

// The default path passes the sole pane, which is attached to the registry there, alongside the
// registry's list — so the same pane arrives twice and must not be named twice.
test("the same pane named twice is collected once", () => {
  const sole = { imageId: 512 };
  const names = paneFrameFileList([sole, sole, { imageId: 512 }], 9);
  assert.equal(names.length, 4);
});

test("an unidentifiable pane contributes nothing, and does not stop the rest", () => {
  // `Number(null)` is 0 and `Number(undefined)` is NaN; neither is a file any pane owns.
  const names = paneFrameFileList(
    [null, undefined, {}, { imageId: null }, { imageId: 0 }, { imageId: -1 },
      { imageId: "x" }, { imageId: 1.5 }, { imageId: 300 }],
    11);
  assert.deepEqual(names.filter((name) => name.endsWith(".rgba")), ["tweb-frame-11-300.rgba"]);
  assert.deepEqual(paneFrameFileList([], 11), []);
  assert.deepEqual(paneFrameFileList(null, 11), []);
});

// The pid stays in the name because the startup sweep is what collects a killed engine's files, and
// it identifies them by pid. Two mechanisms, one naming rule: a change to either side that broke
// the match would stop the sweep silently.
test("the names this engine deletes are the ones a later engine can sweep", () => {
  for (const name of paneFrameFileList([{ imageId: 98466 }], 12345)) {
    const match = FRAME_FILE_PATTERN.exec(name);
    assert.ok(match, `sweep would not recognise ${name}`);
    assert.equal(Number(match[1]), 12345);
  }
});

// The second half, and the one that matters beyond this bug. A throw out of `before-quit` is
// contained by nothing: Electron may cancel the quit — an orphaned engine was seen logging "owner is
// gone, quitting" and then running at ppid=1, image still placed on the terminal — and where the
// quit survives, every step after the throwing one is skipped in silence. Measured: 532 bytes of
// teardown became 413, with no image deletes and no log line.
test("a throwing step is logged and does not stop the steps after it", () => {
  const done = [];
  const logged = [];
  const failed = runTeardown([
    ["frame files", () => done.push("frame files")],
    ["image delete", () => { throw new ReferenceError("frameFilePath is not defined"); }],
    ["cursor restore", () => done.push("cursor restore")],
    ["pane title", () => done.push("pane title")],
  ], (message) => logged.push(message));

  assert.equal(failed, 1);
  // Every step after the failure ran: they are independent effects on different surfaces, and it
  // was skipping them that stranded the page.
  assert.deepEqual(done, ["frame files", "cursor restore", "pane title"]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /teardown step "image delete" failed/);
  // Never swallowed: the message and the stack both reach the log, because a step that silently did
  // nothing is invisible from inside the process.
  assert.match(logged[0], /frameFilePath is not defined/);
  assert.match(logged[0], /teardown\.test\.cjs/);
});

test("every step failing still returns rather than throwing", () => {
  const logged = [];
  const failed = runTeardown([
    ["a", () => { throw new Error("a"); }],
    ["b", () => { throw new Error("b"); }],
  ], (message) => logged.push(message));
  assert.equal(failed, 2);
  assert.equal(logged.length, 2);
});

test("a single step reports whether it completed", () => {
  const logged = [];
  assert.equal(runTeardownStep("ok", () => {}, (m) => logged.push(m)), true);
  assert.equal(runTeardownStep("bad", () => { throw new Error("x"); }, (m) => logged.push(m)),
    false);
  assert.equal(logged.length, 1);
});

// A thrown non-Error has no stack; the log line must still name the step rather than crash the
// handler that exists to keep the process from being stranded.
test("a step that throws a non-Error is still logged", () => {
  const logged = [];
  assert.equal(runTeardownStep("odd", () => { throw "just a string"; }, (m) => logged.push(m)),
    false);
  assert.match(logged[0], /teardown step "odd" failed: just a string/);
  assert.equal(runTeardownStep("nullish", () => { throw null; }, (m) => logged.push(m)), false);
  assert.match(logged[1], /teardown step "nullish" failed/);
});

test("no steps is not a failure", () => {
  assert.equal(runTeardown([]), 0);
  assert.equal(runTeardown(null), 0);
});
