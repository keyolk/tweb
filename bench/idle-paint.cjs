#!/usr/bin/env node
"use strict";

// Does `setFrameRate` provoke a paint even when the rate does not change?
//
// frame-rate-policy.cjs already says it does ("the decision perturbs what it
// measures"), but that comment is about a rate *change*. The reconciler in
// main.cjs re-issues the same rate once a second, and whether that also paints
// is the difference between an idle pane costing nothing and an idle pane
// writing a 20MB frame file every second.
//
// Three arms, each over the same settled static page:
//   control    touch nothing
//   resettle   setFrameRate(sameValue) once a second
//   painting   startPainting() once a second
//
// Run: E=<electron> $E bench/idle-paint.cjs

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const WIDTH = Number(process.env.BW || 1440);
const HEIGHT = Number(process.env.BH || 900);
const RATE = Number(process.env.BR || 4);
const WINDOW_S = Number(process.env.BS || 8);
const PAGE = process.env.BP || path.join(__dirname, "pages", "mixed.html");

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

async function settle(contents, ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function countPaints(contents, seconds, tick) {
  return new Promise((resolve) => {
    let paints = 0;
    const onPaint = () => { paints += 1; };
    contents.on("paint", onPaint);
    const timer = tick ? setInterval(tick, 1000) : null;
    setTimeout(() => {
      if (timer) clearInterval(timer);
      contents.off("paint", onPaint);
      resolve(paints);
    }, seconds * 1000);
  });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH, height: HEIGHT, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  const contents = win.webContents;
  contents.setFrameRate(RATE);
  await contents.loadFile(PAGE);
  // Chromium keeps painting for a while after load; wait it out so the arms
  // measure a genuinely static page rather than the tail of a page load.
  await settle(contents, 4000);

  const control = await countPaints(contents, WINDOW_S, null);
  const resettle = await countPaints(contents, WINDOW_S, () => contents.setFrameRate(RATE));
  const painting = await countPaints(contents, WINDOW_S, () => contents.startPainting());

  console.log(JSON.stringify({
    frame: contents.getOSProcessId ? `${WIDTH}x${HEIGHT}` : null,
    rate: RATE,
    window_s: WINDOW_S,
    paints: { control, resettle_same_rate: resettle, start_painting: painting },
    paints_per_s: {
      control: +(control / WINDOW_S).toFixed(2),
      resettle_same_rate: +(resettle / WINDOW_S).toFixed(2),
      start_painting: +(painting / WINDOW_S).toFixed(2),
    },
  }, null, 2));
  app.exit(0);
});
