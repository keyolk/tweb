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
      const pixels = pictures.get(buffer.toString("base64"));
      const image = {
        getSize: () => ({ width: 4, height: 2 }),
        toBitmap: () => Buffer.from(pixels),
        resize: () => image,
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
  created.deviceScaleFactor = 1;
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
  assert.deepStrictEqual(paints[0], { x: 0, y: 0, width: 4, height: 2 });
  // Pixel 5 is column 1 of row 1: a caret, not the pane.
  assert.deepStrictEqual(paints[1], { x: 1, y: 1, width: 1, height: 1 });
});

test("the settle capture redraws a soft box even when the page is back where it was", async () => {
  const pictures = new Map([["QQ==", picture()], ["Qg==", picture(5)]]);
  const { created, paints } = screencastContents(pictures);
  // The pane was sharp with the caret off; a screencast frame drew it on.
  created.lastBitmap = { pixels: picture(), width: 4, height: 2 };
  created.capture.lastCast = { pixels: picture(), width: 4, height: 2 };
  created.presentScreencastFrame("Qg==");
  await settle();
  // The caret is off again by the time the capture runs: identical to `lastBitmap`.
  created.session.send = async () => ({ data: "QQ==" });
  await created.captureFrame();
  assert.deepStrictEqual(paints.at(-1), { x: 1, y: 1, width: 1, height: 1 });
  assert.strictEqual(created.capture.soft, null);
});
