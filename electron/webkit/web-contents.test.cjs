"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { WebKitWebContents, isAbortedNavigation, setNativeImage } = require("./web-contents.cjs");
const { RecordReader, findHelper, HEADER_LEN, KIND_PAINT } = require("./helper.cjs");
const { TWEB_BRIDGE, safariApplicationName } = require("./engine.cjs");
const { BINDING_NAME } = require("../cdp/preload-bridge.cjs");

// Just enough of an engine to construct contents and see the commands they send the host.
function contents() {
  const sent = [];
  const delivered = [];
  const engine = {
    helper: { send: (command) => sent.push(command), request: async () => null },
    ipcMain: { deliver: (channel, event, args) => delivered.push({ channel, event, args }) },
    windowFor: () => null,
  };
  const created = new WebKitWebContents(engine, 7);
  return { created, sent, delivered };
}

function message(fields, body) {
  return { view: 7, name: "twebIpc", main: false, fid: 11, url: "https://frame.test/", ...fields, body: JSON.stringify(body) };
}

// Pretend NativeImage: records what it was made from.
setNativeImage({
  createFromBitmap: (pixels, size) => ({ pixels: Buffer.from(pixels), ...size, resize: (to) => ({ resized: to }) }),
  createEmpty: () => ({ isEmpty: () => true }),
});

function record(view, width, height, rect, payload) {
  const header = Buffer.alloc(HEADER_LEN);
  [0x52465754, KIND_PAINT, view, width, height, rect.x, rect.y, rect.width, rect.height, 0]
    .forEach((word, index) => header.writeUInt32LE(word, index * 4));
  header.writeBigUInt64LE(0n, 40);
  header.writeBigUInt64LE(BigInt(payload.length), 48);
  return Buffer.concat([header, payload]);
}

test("records are reassembled across chunk boundaries and several per chunk", () => {
  const seen = [];
  const reader = new RecordReader((header, payload) => seen.push([header.view, header.rect, [...payload]]));
  const one = record(1, 2, 1, { x: 0, y: 0, width: 2, height: 1 }, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  const two = record(2, 1, 1, { x: 0, y: 0, width: 1, height: 1 }, Buffer.from([9, 9, 9, 9]));
  const stream = Buffer.concat([one, two]);
  // Split mid-header and mid-payload, then deliver the rest in one piece.
  reader.push(stream.subarray(0, 10));
  reader.push(stream.subarray(10, HEADER_LEN + 3));
  reader.push(stream.subarray(HEADER_LEN + 3));
  assert.deepStrictEqual(seen.map(([view]) => view), [1, 2]);
  assert.deepStrictEqual(seen[0][2], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepStrictEqual(seen[1][1], { x: 0, y: 0, width: 1, height: 1 });
});

// A link to a file the page cannot show downloaded the file and then put an error page in the tab:
// WebKit fails the navigation it turned into a download, and that failure was shown.
test("a navigation turned into a download is an abort, not a failure", () => {
  assert.strictEqual(isAbortedNavigation({ code: 102, domain: "WebKitErrorDomain" }), true);
  assert.strictEqual(isAbortedNavigation({ code: -999, domain: "NSURLErrorDomain" }), true);
  assert.strictEqual(isAbortedNavigation({ code: 102, domain: "NSURLErrorDomain" }), false);
  assert.strictEqual(isAbortedNavigation({ code: -1003, domain: "NSURLErrorDomain" }), false);

  const { created } = contents();
  const failures = [];
  created.on("did-fail-load", (_event, code) => failures.push(code));
  created.onNavigation({ phase: "fail", code: 102, domain: "WebKitErrorDomain", url: "https://x.test/file.bin" });
  created.onNavigation({ phase: "fail", code: -1003, domain: "NSURLErrorDomain", url: "https://nowhere.test/" });
  assert.deepStrictEqual(failures, [-3, -2]);
});

test("a subframe's new document reads as its navigation, and pagehide removes it", () => {
  const { created, delivered } = contents();
  const navigations = [];
  const createdFrames = [];
  created.on("did-start-navigation", (details) => navigations.push(details));
  created.on("frame-created", (_event, details) => createdFrames.push(details.frame));

  const ipc = (doc) => message({}, { doc, name: "ipc", payload: JSON.stringify({ kind: "ipc", channel: "tweb-preload-ready", args: [{}] }) });
  created.onMessage(ipc("d1"));
  assert.strictEqual(createdFrames.length, 1);
  assert.strictEqual(navigations.length, 0, "a frame's first document is not a navigation");
  assert.deepStrictEqual(created.mainFrame.framesInSubtree, createdFrames);
  assert.strictEqual(delivered[0].channel, "tweb-preload-ready");
  assert.strictEqual(delivered[0].event.senderFrame, createdFrames[0]);

  created.onMessage(ipc("d2"));
  assert.strictEqual(navigations.length, 1);
  assert.strictEqual(navigations[0].isMainFrame, false);
  assert.strictEqual(navigations[0].frame, createdFrames[0]);

  // A stale document's pagehide must not remove the frame its successor now lives in.
  created.onMessage(message({}, { doc: "d1", name: "gone" }));
  assert.strictEqual(created.childFrames().length, 1);
  created.onMessage(message({}, { doc: "d2", name: "gone" }));
  assert.strictEqual(created.childFrames().length, 0);
});

test("a main-frame commit drops the old document's frames", () => {
  const { created } = contents();
  created.onMessage(message({ fid: 1 }, { doc: "a", name: "title", payload: "" }));
  created.onMessage(message({ fid: 2 }, { doc: "b", name: "title", payload: "" }));
  assert.strictEqual(created.childFrames().length, 2);
  created.onNavigation({ phase: "start", url: "https://next.test/" });
  created.onNavigation({ phase: "commit", url: "https://next.test/" });
  assert.strictEqual(created.childFrames().length, 0);
  assert.strictEqual(created.getURL(), "https://next.test/");
});

// WebKit's navigation delegate is silent for pushState and hash changes; the url poll is what
// sees them, and main.cjs needs them as in-page navigations, not new documents.
test("a url change with no navigation in flight is an in-page navigation", () => {
  const { created } = contents();
  const inPage = [];
  const starts = [];
  created.on("did-navigate-in-page", (_event, url, isMainFrame) => inPage.push([url, isMainFrame]));
  created.on("did-start-navigation", () => starts.push(1));
  created.onNavigation({ phase: "start", url: "https://app.test/" });
  created.onNavigation({ phase: "commit", url: "https://app.test/" });
  created.onNavigation({ phase: "finish", url: "https://app.test/" });
  created.onState({ url: "https://app.test/route", title: "App", loading: false, back: true, forward: false });
  assert.deepStrictEqual(inPage, [["https://app.test/route", true]]);
  assert.strictEqual(starts.length, 1);
  assert.strictEqual(created.navigationHistory.canGoBack(), true);
});

test("a dirty box is patched into the kept frame, and a whole one is adopted", () => {
  const { created } = contents();
  const paints = [];
  created.on("paint", (_event, dirty, image) => paints.push({ dirty, image }));
  const whole = Buffer.alloc(2 * 2 * 4, 1);
  created.onPaint({ width: 2, height: 2, rect: { x: 0, y: 0, width: 2, height: 2 } }, whole);
  created.onPaint({ width: 2, height: 2, rect: { x: 1, y: 1, width: 1, height: 1 } }, Buffer.from([7, 7, 7, 7]));
  assert.deepStrictEqual(paints[1].dirty, { x: 1, y: 1, width: 1, height: 1 });
  const pixels = [...paints[1].image.pixels];
  assert.deepStrictEqual(pixels.slice(12, 16), [7, 7, 7, 7], "the bottom-right pixel is the patch");
  assert.deepStrictEqual(pixels.slice(0, 12), Array(12).fill(1), "the rest is the previous frame");
});

// A forced frame the host found unchanged carries an empty box; Electron's invalidate always
// yields a paint, so it is reported as the whole frame.
test("an unchanged forced frame is painted whole", () => {
  const { created } = contents();
  const paints = [];
  created.on("paint", (_event, dirty) => paints.push(dirty));
  created.onPaint({ width: 2, height: 1, rect: { x: 0, y: 0, width: 2, height: 1 } }, Buffer.alloc(8));
  created.onPaint({ width: 2, height: 1, rect: { x: 0, y: 0, width: 0, height: 0 } }, Buffer.alloc(0));
  assert.deepStrictEqual(paints[1], { x: 0, y: 0, width: 2, height: 1 });
});

test("a keyDown and its char go to the host as one key carrying its text", async () => {
  const { created, sent } = contents();
  created.sendInputEvent({ type: "keyDown", keyCode: "a", modifiers: [] });
  created.sendInputEvent({ type: "char", keyCode: "a", modifiers: [] });
  created.sendInputEvent({ type: "keyUp", keyCode: "a", modifiers: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(sent.map(({ op, kind, key, code, text }) => ({ op, kind, key, code, text })), [
    { op: "key", kind: "down", key: "a", code: "KeyA", text: "a" },
    { op: "key", kind: "up", key: "a", code: "KeyA", text: "" },
  ]);
  // A lone char is an IME commit: inserted as text, not typed as a key.
  sent.length = 0;
  created.sendInputEvent({ type: "char", keyCode: "한", modifiers: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(sent, [{ op: "text", text: "한", view: 7 }]);
});

test("mouse events keep Electron's coordinates, buttons and wheel sign", () => {
  const { created, sent } = contents();
  created.sendInputEvent({ type: "mouseDown", x: 10, y: 20, button: "right", clickCount: 2, modifiers: ["shift"] });
  created.sendInputEvent({ type: "mouseWheel", x: 5, y: 6, deltaX: 0, deltaY: 100 });
  created.sendInputEvent({ type: "contextMenu", x: 1, y: 1 });
  assert.deepStrictEqual(sent.map(({ kind, x, y, button, clicks, modifiers, dy }) => ({ kind, x, y, button, clicks, modifiers, dy })), [
    { kind: "down", x: 10, y: 20, button: 2, clicks: 2, modifiers: 8, dy: 0 },
    { kind: "wheel", x: 5, y: 6, button: 0, clicks: 1, modifiers: 0, dy: 100 },
  ]);
});

test("the debugger cannot attach, so main.cjs takes its fallbacks", async () => {
  const { created } = contents();
  assert.throws(() => created.debugger.attach("1.3"));
  assert.strictEqual(created.debugger.isAttached(), false);
  await assert.rejects(created.debugger.sendCommand("Runtime.evaluate"));
});

// The preload's channel is the binding the shared bridge captures; a page restored from the
// back-forward cache asks to be registered again (after Back, `tweb snapshot` answered nothing).
test("the bridge defines the shared binding and re-registers a restored page", () => {
  assert.ok(TWEB_BRIDGE.includes(`globalThis[${JSON.stringify(BINDING_NAME)}]`));
  assert.match(TWEB_BRIDGE, /addEventListener\("pageshow"[\s\S]*event\.persisted[\s\S]*"tweb-are-you-there"/);
  assert.match(TWEB_BRIDGE, /addEventListener\("pagehide", \(\) => post\("gone"/);
});

test("the host is found from TWEB_WEBKIT first", () => {
  assert.strictEqual(findHelper({ TWEB_WEBKIT: process.execPath, PATH: "" }, "/nonexistent/app"), process.execPath);
  assert.strictEqual(findHelper({ PATH: "" }, "/nonexistent/app"), null);
});

test("the application name is Safari's, or nothing", () => {
  const name = safariApplicationName();
  assert.ok(name === null || /^Version\/[\d.]+ Safari\/605\.1\.15$/.test(name), name);
});
