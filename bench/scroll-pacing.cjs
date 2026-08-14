#!/usr/bin/env node
"use strict";

// What frame rate does an offscreen BrowserWindow actually deliver under a
// continuous scroll, and where does it go?
//
// The gate (DESIGN.md 7.7) asks for "sustainable frame pacing at a 60Hz display
// during a 1080p continuous scroll". The harness measured ~2 frames/s reaching
// the terminal at a configured 30fps, which could be any of three things: the
// page not scrolling, Chromium not painting, or the pipeline dropping. This
// separates them by counting at each stage of one process:
//
//   paints          the `paint` event, i.e. what Chromium hands over
//   distinct_y      how far the page actually scrolled
//   bitmap_ms       what toBitmap costs per frame on the main thread
//
// No terminal and no worker: those are measured elsewhere (DETAIL.md 8.3), and
// leaving them out is what makes this a clean read of the producer.
//
// Run: <electron> bench/scroll-pacing.cjs

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const WIDTH = Number(process.env.BW || 1440);
const HEIGHT = Number(process.env.BH || 900);
const DSF = Number(process.env.BD || 2);
const RATE = Number(process.env.BR || 30);
const SECONDS = Number(process.env.BS || 10);
const PAGE = process.env.BP || path.join(__dirname, "pages", "mixed.html");

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH, height: HEIGHT, show: false,
    webPreferences: {
      offscreen: true, backgroundThrottling: false, zoomFactor: 1,
    },
  });
  const contents = win.webContents;
  contents.setFrameRate(RATE);
  await contents.loadFile(PAGE);
  // A tall document, so a 10s scroll never reaches the bottom and stops.
  await contents.executeJavaScript(
    "document.body.style.minHeight='400000px'; window.scrollTo(0,0); 1", true);
  await new Promise((r) => setTimeout(r, 3000));

  const paintTimes = [];
  const bitmapMs = [];
  let sizeSeen = null;
  const onPaint = (_e, _dirty, image) => {
    paintTimes.push(Date.now());
    sizeSeen = image.getSize();
    const t = process.hrtime.bigint();
    image.toBitmap();
    bitmapMs.push(Number(process.hrtime.bigint() - t) / 1e6);
  };
  contents.on("paint", onPaint);

  const started = Date.now();
  const wheel = setInterval(() => {
    contents.sendInputEvent({
      type: "mouseWheel", x: WIDTH / 2, y: HEIGHT / 2,
      deltaX: 0, deltaY: -100, wheelTicksX: 0, wheelTicksY: -1,
      accelerationRatioX: 0.5, accelerationRatioY: 0.5,
      hasPreciseScrollingDeltas: false, canScroll: true, modifiers: [],
    });
  }, 1000 / 60);

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(wheel);
  contents.off("paint", onPaint);
  const elapsed = (Date.now() - started) / 1000;
  const scrollY = await contents.executeJavaScript("window.scrollY", true);

  const gaps = paintTimes.slice(1).map((t, i) => t - paintTimes[i]).sort((a, b) => a - b);
  const pct = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1,
    Math.floor(gaps.length * p))] : null);
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : null;
  };

  console.log(JSON.stringify({
    configured_rate: RATE, seconds: +elapsed.toFixed(2),
    device_scale_factor: DSF, frame_size: sizeSeen,
    paints: paintTimes.length,
    paints_per_s: +(paintTimes.length / elapsed).toFixed(2),
    paint_gap_ms: { p50: pct(0.5), p90: pct(0.9), max: gaps.at(-1) },
    to_bitmap_ms: { p50: med(bitmapMs), max: bitmapMs.length ? +Math.max(...bitmapMs).toFixed(2) : null },
    scroll_y: scrollY,
  }, null, 2));
  app.exit(0);
});
