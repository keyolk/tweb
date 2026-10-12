"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { CdpWebContents, isViewportFrame } = require("./web-contents.cjs");

// Just enough of an engine to construct contents and feed it Page events by hand.
function contents() {
  const engine = { connection: { send: async () => ({}) }, windowFor: () => null };
  const session = { id: "S", on() {}, send: async () => ({}) };
  const created = new CdpWebContents(engine, "MAIN", session);
  created.navigationHistory.refresh = async () => {};
  const navigations = [];
  created.on("did-start-navigation", (details) => navigations.push(details));
  return { created, navigations };
}

// The event order measured from Chrome over CDP for `history.pushState`:
//   frameStartedLoading → navigatedWithinDocument → frameStoppedLoading
// and for a real document load:
//   frameStartedNavigating → frameStartedLoading → frameNavigated → ... → frameStoppedLoading
// Reporting the first as a new document made main.cjs drop the main frame from its ready set,
// and with no new preload to re-register it, every agent request (`snapshot`, `query`, the probes
// `tweb wait` polls) went unanswered for good — measured on SAP Concur, a React SPA.
test("a pushState is not reported as a new document", () => {
  const { created, navigations } = contents();
  created.onFrameStartedLoading({ frameId: "MAIN" }, "S");
  created.onNavigatedWithinDocument({ frameId: "MAIN", url: "https://app.test/expenses/1" });
  created.onFrameStoppedLoading({ frameId: "MAIN" });
  assert.strictEqual(navigations.length, 1);
  assert.strictEqual(navigations[0].isSameDocument, true);
});

test("a real document load is still reported as one", () => {
  const { created, navigations } = contents();
  created.onFrameStartedNavigating({ frameId: "MAIN", url: "https://app.test/", navigationType: "differentDocument" }, "S");
  created.onFrameStartedLoading({ frameId: "MAIN" }, "S");
  assert.strictEqual(navigations.length, 1);
  assert.strictEqual(navigations[0].isSameDocument, false);
  assert.strictEqual(navigations[0].isMainFrame, true);
});

// Measured at dsf 1.6 on a 900x563 viewport: CSS-size frames until the first device-pixel capture,
// device-size frames after it, and window-size frames when the window is mis-sized.
test("a screencast frame of the viewport is accepted at CSS or device size", () => {
  const viewport = { width: 900, height: 563 };
  assert.ok(isViewportFrame({ width: 900, height: 563 }, viewport, 1.6));
  assert.ok(isViewportFrame({ width: 1440, height: 900 }, viewport, 1.6));
  assert.ok(!isViewportFrame({ width: 900, height: 476 }, viewport, 1.6));
  assert.ok(!isViewportFrame({ width: 761, height: 476 }, viewport, 1.6));
});

function paintingContents() {
  const { created } = contents();
  created.painting = true;
  created.capture.screencast = true;
  const captures = [];
  created.requestCapture = () => captures.push(Date.now());
  return { created, captures };
}

test("an invalidate with the screencast running waits for its frame before capturing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { created, captures } = paintingContents();
  created.invalidate();
  assert.strictEqual(captures.length, 0);
  // The page drew: a screencast frame bumped the generation inside the grace.
  created.capture.generation = (created.capture.generation || 0) + 1;
  t.mock.timers.tick(60);
  assert.strictEqual(captures.length, 0);
});

test("an invalidate with nothing new to draw still captures", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { created, captures } = paintingContents();
  created.invalidate();
  t.mock.timers.tick(60);
  assert.strictEqual(captures.length, 1);
  assert.strictEqual(created.capture.forceNext, true);
});

test("a stream of invalidates cannot put the capture off for good", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { created, captures } = paintingContents();
  for (let i = 0; i < 20; i++) {
    created.invalidate();
    t.mock.timers.tick(10);
  }
  assert.ok(captures.length >= 1, "captured at least once in 200ms of invalidates");
});

test("an invalidate without the screencast captures at once", () => {
  const { created, captures } = paintingContents();
  created.capture.screencast = false;
  created.invalidate();
  assert.strictEqual(captures.length, 1);
});

// --- screencast frames are damaged like captures ---
//
// A caret blinking in a focused field changes a few pixels twice a second. The screencast frame it
// produces used to be painted as the WHOLE pane at half resolution, then sharpened by the settle
// capture 150ms later: the entire pane flickered for as long as the field had focus. Measured on
// claude.ai with the prompt focused: 36 whole frames in 6s, against 8 with it blurred.

// A fake decoded frame: a byte buffer standing in for the bitmap, keyed by the base64 data.
function fakeImages(pictures) {
  return {
    createFromBuffer(buffer) {
      const entry = pictures.get(buffer.toString("base64"));
      const pixels = entry.pixels || entry;
      const size = entry.size || { width: 4, height: 2 };
      const image = {
        getSize: () => size,
        toBitmap: () => Buffer.from(pixels),
        resize: (to) => ({ ...image, getSize: () => ({ width: to.width, height: to.height }) }),
        crop: () => image,
      };
      return image;
    },
  };
}

function screencastContents(pictures) {
  const { setNativeImage } = require("./web-contents.cjs");
  setNativeImage(fakeImages(pictures));
  const { created } = contents();
  created.painting = true;
  created.frameRate = 1000;
  created.viewport = { width: 4, height: 2 };
  created.deviceScaleFactor = 2;
  created.frameSize = { width: 4, height: 2 };
  created.scheduleSettle = () => {};
  const paints = [];
  created.on("paint", (_event, dirty) => paints.push(dirty));
  return { created, paints };
}

function picture(changedPixel) {
  const pixels = Buffer.alloc(4 * 2 * 4);
  if (changedPixel !== undefined) pixels.writeUInt32LE(0xffffffff, changedPixel * 4);
  return pixels;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a screencast frame paints only the box that changed since the last one", async () => {
  const pictures = new Map([["QQ==", picture()], ["Qg==", picture(5)]]);
  const { created, paints } = screencastContents(pictures);
  created.presentScreencastFrame("QQ==");
  await settle();
  created.presentScreencastFrame("Qg==");
  await settle();
  // The first frame has nothing to compare with; the settle capture draws it.
  assert.strictEqual(paints.length, 1);
  // Pixel 5 is column 1 of row 1: a caret, not the pane.
  assert.deepStrictEqual(paints[0], { x: 1, y: 1, width: 1, height: 1 });
});

// Measured at zoom 0.8 (dsf 1.6): Chrome sends CSS-size screencast frames too. On namu.wiki they
// are the top-left corner of the device picture; on YouTube after a pane resize, the page scaled
// down. Neither may be drawn — the corner zooms the pane, the scaled page flickers it between
// sharp frames, and a classifier between the two (#143) misjudged corners as the page.
const W = 40, H = 40, w = 20, h = 20;

// A page whose right half is white: as the device picture, and scaled down to CSS size. #143's
// classifier read the small one as the page scaled, which is what drew it.
function halves(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) pixels.fill(255, (y * width + width / 2) * 4, (y * width + width) * 4);
  return pixels;
}

function cssContents() {
  const page = { pixels: halves(w, h), size: { width: w, height: h } };
  const changed = { pixels: Buffer.from(halves(w, h)).fill(128, 0, 4), size: { width: w, height: h } };
  const { created, paints } = screencastContents(new Map([["QQ==", page], ["Qg==", changed]]));
  created.viewport = { width: w, height: h };
  created.frameSize = { width: W, height: H };
  created.lastBitmap = { pixels: halves(W, H), width: W, height: H };
  const captures = [];
  created.requestCapture = () => captures.push(Date.now());
  return { created, paints, captures };
}

test("a CSS-size screencast frame is never drawn, whatever it shows", async () => {
  const { created, paints } = cssContents();
  for (const data of ["QQ==", "Qg==", "QQ==", "Qg=="]) {
    created.presentScreencastFrame(data);
    await settle();
  }
  assert.deepStrictEqual(paints, []);
});

// Measured on namu.wiki: `j` reached the pane in ~20ms when the next frame was device-size and
// ~200ms when it was CSS-size and the change waited for the settle capture.
test("a CSS-size screencast frame asks for a capture at once", async () => {
  const { created, captures } = cssContents();
  created.presentScreencastFrame("QQ==");
  await settle();
  assert.strictEqual(captures.length, 1);
});

test("the settle capture redraws a soft box even when the page is back where it was", async () => {
  const pictures = new Map([["QQ==", picture()], ["Qg==", picture(5)]]);
  const { created, paints } = screencastContents(pictures);
  // The pane was sharp with the caret off; a screencast frame drew it on.
  created.lastBitmap = { pixels: picture(), width: 4, height: 2 };
  created.capture.lastCast = picture();
  created.presentScreencastFrame("Qg==");
  await settle();
  // The caret is off again by the time the capture runs: identical to `lastBitmap`.
  created.session.send = async () => ({ data: "QQ==" });
  await created.captureFrame();
  assert.deepStrictEqual(paints.at(-1), { x: 1, y: 1, width: 1, height: 1 });
  assert.strictEqual(created.capture.soft, null);
});

// Measured on a 1440x1800 pane playing a video: the screencast came at CSS size only, a frame
// every ~33ms, and each one bumped the generation a capture is checked against. Every capture
// took longer than that, so every one after the first was dropped as stale: 0 frames in 8s.
test("a capture is kept when only CSS-size screencast frames arrived while it ran", async () => {
  const { created, paints } = cssContents();
  created.lastBitmap = null;
  created.frameSize = { width: w, height: h };
  let answer;
  created.session.send = (method) => (method === "Page.captureScreenshot"
    ? new Promise((resolve) => { answer = resolve; })
    : Promise.resolve({}));
  created.viewport = { width: w / 2, height: h / 2 };
  const shot = created.captureFrame();
  await settle();
  // The video moved on twice while the capture ran; neither frame was drawn.
  created.onScreencastFrame({ sessionId: 1, data: "QQ==" });
  created.onScreencastFrame({ sessionId: 2, data: "Qg==" });
  await settle();
  answer({ data: "QQ==" });
  await shot;
  assert.strictEqual(paints.length, 1);
});

test("a capture is still dropped when a screencast frame was drawn while it ran", async () => {
  const pictures = new Map([["QQ==", picture()], ["Qg==", picture(5)]]);
  const { created, paints } = screencastContents(pictures);
  created.lastBitmap = { pixels: picture(), width: 4, height: 2 };
  created.capture.lastCast = picture();
  let answer;
  created.session.send = (method) => (method === "Page.captureScreenshot"
    ? new Promise((resolve) => { answer = resolve; })
    : Promise.resolve({}));
  const shot = created.captureFrame();
  created.onScreencastFrame({ sessionId: 1, data: "Qg==" });
  await settle();
  assert.strictEqual(paints.length, 1);
  answer({ data: "QQ==" });
  await shot;
  // The older capture would have put the caret back off over the newer frame.
  assert.strictEqual(paints.length, 1);
});

// Measured on a pane resized while a video played: an override sent with a capture in flight was
// undone when that capture finished (5 in 5), and every capture after it came out at the old size.
test("a viewport change made during a capture is applied again once the capture is done", async () => {
  const { created } = contents();
  created.initialized = true;
  created.painting = true;
  created.frameRate = 1000;
  created.fitWindowToViewport = async () => {};
  created.invalidate = () => {};
  const overrides = [];
  let answer;
  created.session.send = (method, params) => {
    if (method === "Emulation.setDeviceMetricsOverride") overrides.push(`${params.width}x${params.height}`);
    if (method === "Page.captureScreenshot") return new Promise((resolve) => { answer = resolve; });
    return Promise.resolve({});
  };
  created.captureFrame = () => created.session.send("Page.captureScreenshot");
  created.capture.dirty = true;
  created.pumpCapture();
  assert.strictEqual(created.capture.inFlight, 1);
  created.setViewport(750, 945, 1.6);
  await settle();
  assert.deepStrictEqual(overrides, ["750x945"]);
  answer({});
  await settle();
  assert.deepStrictEqual(overrides, ["750x945", "750x945"]);
  // With nothing in flight the next change is sent once.
  created.setViewport(600, 800, 1.6);
  await settle();
  assert.deepStrictEqual(overrides, ["750x945", "750x945", "600x800"]);
});

// --- the user agent ---
//
// Measured on dogdrip.net: nginx answered 403 to `HeadlessChrome/155.0.0.0` and 200 to the same
// string with `Chrome/`, so the Chrome engine could not open a site the Electron engine could.

test("the browser user agent drops the headless marker and keeps the version", () => {
  const { browserUserAgent } = require("./engine.cjs");
  const headless = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36";
  assert.strictEqual(
    browserUserAgent(headless),
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  );
  assert.strictEqual(browserUserAgent(""), null);
});

test("every session is given the browser user agent before its page runs", async () => {
  const { created } = contents();
  created.engine.userAgent = "UA Chrome/155";
  created.engine.downloadDirectory = () => "/tmp";
  const sent = [];
  const session = { id: "C", on() {}, send: async (method, params) => { sent.push([method, params]); return {}; } };
  await created.prepareSession(session, false);
  assert.deepStrictEqual(sent.find(([method]) => method === "Emulation.setUserAgentOverride"),
    ["Emulation.setUserAgentOverride", { userAgent: "UA Chrome/155" }]);
});

// Chrome on macOS rubber-bands the top-level page at either end of a wheel scroll, and the
// screencast drew each bounce: ±7 device px every frame, the whole pane shaking while the wheel
// came. The fix is the root's `overscroll-behavior` — on the top frame only, since a frame's root
// set to none would stop a wheel at the frame's end from scrolling the page.
test("every new document stops the top-level page bouncing, and only the top-level one", async () => {
  const sources = [];
  const engine = { connection: { send: async () => ({}) }, windowFor: () => null, debug: false, downloadDirectory: () => "/tmp" };
  const session = {
    id: "S", on() {},
    send: async (method, params) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") sources.push(params);
      return {};
    },
  };
  const created = new CdpWebContents(engine, "MAIN", session);
  await created.prepareSession(session, true);
  const script = sources.find((entry) => /overscroll-behavior/.test(entry.source));
  assert.ok(script, "no script sets overscroll-behavior");
  // Isolated world: the page cannot see or undo the script itself, only its effect.
  assert.ok(script.worldName && script.runImmediately);

  const vm = require("node:vm");
  function run(top) {
    const set = [];
    const window = {};
    window.top = top ? window : {};
    const document = { documentElement: { style: { setProperty: (...args) => set.push(args) } } };
    vm.runInNewContext(script.source, { window, document, MutationObserver: class { observe() {} } });
    return set;
  }
  assert.deepStrictEqual(run(true), [["overscroll-behavior", "none", "important"]]);
  assert.deepStrictEqual(run(false), []);
});

// The order Chrome sends on a reload of a page with one iframe, measured over CDP:
//   frameNavigated(main) → frameAttached(new iframe) → frameNavigated(new iframe)
// with no frameDetached for the old iframe. Keeping the old one meant every `f` round asked a
// frame that would never answer, one more per reload.
test("a reload leaves only the new document's frames", () => {
  const { created } = contents();
  const load = (iframe) => {
    created.onFrameNavigated({ id: "MAIN", url: "http://page.test/" }, "S");
    created.onFrameAttached({ frameId: iframe, parentFrameId: "MAIN" }, "S");
    created.onFrameNavigated({ id: iframe, parentId: "MAIN", url: "about:srcdoc" }, "S");
  };
  load("IFRAME-1");
  load("IFRAME-2");
  load("IFRAME-3");
  assert.deepStrictEqual(created.mainFrame.framesInSubtree.map((frame) => frame.frameId), ["IFRAME-3"]);
});

test("a subframe navigating drops its own children, not its siblings", () => {
  const { created } = contents();
  created.onFrameNavigated({ id: "MAIN", url: "http://page.test/" }, "S");
  created.onFrameAttached({ frameId: "A", parentFrameId: "MAIN" }, "S");
  created.onFrameAttached({ frameId: "B", parentFrameId: "MAIN" }, "S");
  created.onFrameAttached({ frameId: "A1", parentFrameId: "A" }, "S");
  created.onFrameNavigated({ id: "A", parentId: "MAIN", url: "http://ad.test/" }, "S");
  assert.deepStrictEqual(created.mainFrame.framesInSubtree.map((frame) => frame.frameId).sort(), ["A", "B"]);
});
