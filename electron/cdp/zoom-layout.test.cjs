"use strict";

// A zoomed Chrome tab keeps the emulated device scale at the browser's own, and reaches the pane's
// pixel size through the capture's `clip.scale` instead. With the two scales apart, Chrome read
// mouse coordinates at one or the other from one event to the next: zoomed out twice, a press
// landed on a button and its release at 1/1.44 of the point, and the click never happened.

const { test } = require("node:test");
const assert = require("node:assert");
const { zoomLayout } = require("./engine.cjs");
const { CdpWebContents, setNativeImage } = require("./web-contents.cjs");

const ZOOMS = [0.5, 0.5556, 0.6667, 0.8, 1, 1.152, 1.44, 2];

test("the emulated scale is the browser's at every zoom", () => {
  for (const browserScale of [1, 1.6, 2]) {
    for (const zoom of ZOOMS) {
      const layout = zoomLayout({ contentSize: { width: 640, height: 400 }, scaleFactor: 2, zoom, browserScale });
      assert.strictEqual(layout.deviceScaleFactor, browserScale, `zoom ${zoom} under ${browserScale}`);
    }
  }
});

test("the CSS viewport is the content size over the zoom, and the capture comes out at the pane's size", () => {
  for (const zoom of ZOOMS) {
    const layout = zoomLayout({ contentSize: { width: 640, height: 400 }, scaleFactor: 2, zoom, browserScale: 1.6 });
    assert.deepStrictEqual(layout.viewport, { width: Math.ceil(640 / zoom), height: Math.ceil(400 / zoom) });
    assert.deepStrictEqual(layout.frameSize, { width: 1280, height: 800 });
    const captured = layout.viewport.width * layout.deviceScaleFactor * layout.captureScale;
    // Rounded up into the viewport, so at most one CSS pixel long at the zoom's scale.
    assert.ok(captured >= 1280 && captured - 1280 <= 2 * zoom + 1e-9, `zoom ${zoom}: ${captured}`);
  }
});

test("at the default zoom no clip scale is needed", () => {
  const layout = zoomLayout({ contentSize: { width: 640, height: 400 }, scaleFactor: 2, zoom: 0.8, browserScale: 1.6 });
  assert.ok(Math.abs(layout.captureScale - 1) < 1e-9);
});

function contents(send = async () => ({})) {
  const engine = { connection: { send: async () => ({}) }, windowFor: () => null };
  const session = { id: "S", on() {}, send };
  return new CdpWebContents(engine, "MAIN", session);
}

test("a capture at scale 1 has no clip; a zoomed one clips the visible viewport where the page is scrolled", async () => {
  const sent = [];
  const created = contents(async (method, params) => {
    sent.push(method);
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 4500 } };
    return {};
  });
  created.viewport = { width: 1152, height: 720 };
  assert.deepStrictEqual(await created.captureClip(), {});
  assert.deepStrictEqual(sent, [], "scale 1 costs no round trip");
  created.captureScale = 0.6944;
  // Measured: a clip at 0,0 on a page scrolled 4500px down came back blank.
  assert.deepStrictEqual(await created.captureClip(), {
    clip: { x: 0, y: 4500, width: 1152, height: 720, scale: 0.6944 },
  });
});

test("an asked-for region is captured at the tab's scale; device emulation keeps Chrome's own", async () => {
  const created = contents();
  created.captureScale = 1.44;
  const rect = { x: 10, y: 20, width: 30, height: 40 };
  assert.deepStrictEqual(await created.captureClip(rect), { clip: { ...rect, scale: 1.44 } });
  created.deviceEmulation = { deviceScaleFactor: 3 };
  assert.deepStrictEqual(await created.captureClip(), {});
  assert.deepStrictEqual(await created.captureClip(rect), { clip: { ...rect, scale: 1 } });
});

// The screencast of a zoomed tab is the viewport at the emulated scale: the capture's picture
// before its clip scale. It is scaled to the pane rather than left to a capture per scroll step.
function zoomedContents() {
  const size = { width: 1844, height: 1152 };
  const pixels = (n) => { const b = Buffer.alloc(1280 * 800 * 4); b.writeUInt32LE(0xffffffff, n * 4); return b; };
  const pictures = new Map([["QQ==", 1], ["Qg==", 2]]);
  setNativeImage({
    createFromBuffer(buffer) {
      const n = pictures.get(buffer.toString("base64"));
      return {
        getSize: () => size,
        toBitmap: () => Buffer.alloc(size.width * size.height * 4),
        resize: (to) => ({ getSize: () => ({ width: to.width, height: to.height }), toBitmap: () => pixels(n) }),
      };
    },
    createFromBitmap(bitmap, to) {
      return { getSize: () => ({ width: to.width, height: to.height }), toBitmap: () => Buffer.from(bitmap) };
    },
  });
  const created = contents();
  created.painting = true;
  created.frameRate = 1000;
  created.scheduleSettle = () => {};
  created.engine.browserScale = 1.6;
  created.deviceScaleFactor = 1.6;
  created.viewport = { width: 1152, height: 720 };
  created.frameSize = { width: 1280, height: 800 };
  created.captureScale = 0.6944;
  const paints = [];
  const captures = [];
  created.on("paint", (_event, dirty) => paints.push(dirty));
  created.requestCapture = () => captures.push(Date.now());
  created.capture.lastCast = Buffer.alloc(1280 * 800 * 4);
  return { created, paints, captures };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a zoomed tab's screencast frame is scaled to the pane and drawn", async () => {
  const { created, paints, captures } = zoomedContents();
  created.onScreencastFrame({ sessionId: 1, data: "QQ==" });
  await settle();
  assert.strictEqual(paints.length, 1);
  assert.strictEqual(captures.length, 0);
});

test("a zoomed tab's screencast frame sent while a capture ran only asks for a capture", async () => {
  const { created, paints, captures } = zoomedContents();
  created.capture.inFlight = 1;
  created.onScreencastFrame({ sessionId: 1, data: "Qg==" });
  await settle();
  assert.deepStrictEqual(paints, []);
  assert.strictEqual(captures.length, 1);
});
