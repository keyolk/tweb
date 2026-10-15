// What a whole frame costs to get onto the CPU: the default offscreen path (`paint` hands a
// NativeImage, read with `toBitmap()`) against `offscreen.useSharedTexture` (`paint` hands an
// IOSurface, read with the shm addon's `readIOSurface`). macOS only.
//
// The question is whether the shared-texture path — what zenbu-labs/terminal-browser uses on macOS —
// is worth the rework it would need here: with it, `paint`'s image is empty, so the frame cache,
// patch crops and repaints would all have to work from raw pixels instead. Worth it only if it is
// measurably cheaper in main-thread time per frame, or in GPU/browser process CPU, at the same rate.
//
//   E=~/.cache/tweb/electron-43.2.0/dist/Electron.app/Contents/MacOS/Electron
//   ADDON=<path to tweb-frame.node> MODE=bitmap  $E bench/shared-texture.cjs
//   ADDON=<path to tweb-frame.node> MODE=texture $E bench/shared-texture.cjs
//
// BW/BH (DIP, default 1440x900) and BD (scale factor, default 2) set the frame size; SECONDS the
// measured window after a 3s warm-up. Prints one JSON line.

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const MODE = process.env.MODE || "bitmap";
const BW = Number(process.env.BW || 1440);
const BH = Number(process.env.BH || 900);
const BD = Number(process.env.BD || 2);
const SECONDS = Number(process.env.SECONDS || 10);
const PAGE = `file://${path.join(__dirname, "pages", process.env.BP || "fullpaint")}.html`;
const addon = process.env.ADDON ? require(process.env.ADDON) : null;

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(2));
}

app.whenReady().then(() => {
  const offscreen = MODE === "texture"
    ? { useSharedTexture: true, deviceScaleFactor: BD }
    : { deviceScaleFactor: BD };
  const win = new BrowserWindow({
    width: BW, height: BH, show: false,
    webPreferences: { offscreen, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(30);
  let measuring = false;
  const costs = [];
  let paints = 0;
  let size = null;
  let nonZero = null;
  win.webContents.on("paint", (event, dirty, image) => {
    const started = process.hrtime.bigint();
    let pixels;
    if (MODE === "texture") {
      const texture = event.texture;
      try {
        const read = addon.readIOSurface(texture.textureInfo.handle.ioSurface);
        pixels = read.pixels;
        size = { width: read.width, height: read.height };
      } finally {
        texture.release();
      }
    } else {
      pixels = image.toBitmap();
      size = image.getSize();
    }
    const cost = Number(process.hrtime.bigint() - started) / 1e6;
    if (!measuring) return;
    paints += 1;
    costs.push(cost);
    if (nonZero === null) nonZero = pixels.some((byte, index) => index % 4 !== 3 && byte !== 0);
  });
  win.loadURL(PAGE);
  setTimeout(() => {
    measuring = true;
    const before = app.getAppMetrics();
    const startedAt = Date.now();
    setTimeout(() => {
      const after = app.getAppMetrics();
      const seconds = (Date.now() - startedAt) / 1000;
      // percentCPUUsage is since the previous getAppMetrics call, so `after` covers the window.
      const cpu = {};
      for (const metric of after) cpu[metric.type] = (cpu[metric.type] || 0) + metric.cpu.percentCPUUsage;
      void before;
      console.log(JSON.stringify({
        mode: MODE, size, seconds: Number(seconds.toFixed(1)), paints,
        fps: Number((paints / seconds).toFixed(1)),
        mainMs: { p50: percentile(costs, 0.5), p90: percentile(costs, 0.9), p99: percentile(costs, 0.99) },
        cpuPercent: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, Number(v.toFixed(1))])),
        pixelsNonZero: nonZero,
      }));
      app.quit();
    }, SECONDS * 1000);
  }, 3000);
});
