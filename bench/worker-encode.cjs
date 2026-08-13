const { app, BrowserWindow } = require("electron");
const { Worker } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const path = require("node:path"); const url = require("node:url");
const P = process.env.BP || "mixed";
const SRC = url.pathToFileURL(path.join(__dirname, "pages", `${P}.html`)).href;
// The shipping main.cjs does not set this switch. NOGPU=1 is for comparison only.
if (process.env.NOGPU) app.commandLine.appendSwitch("disable-gpu-compositing");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false,
    webPreferences: { offscreen: { deviceScaleFactor: 2 } } });
  win.webContents.setFrameRate(60);
  let latest = null;
  win.webContents.on("paint", (_e,_d,img) => { latest = img; });
  await win.loadURL(SRC);
  await new Promise(r => setTimeout(r, 2500));
  win.webContents.invalidate();
  await new Promise(r => setTimeout(r, 800));
  const image = latest, s = image.getSize();

  // Main-thread baseline.
  let t = performance.now(); for (let i=0;i<3;i++) image.toPNG(); const mainMs = (performance.now()-t)/3;

  const w = new Worker(path.join(__dirname, "enc-worker.cjs"));
  const send = (level) => new Promise((res) => {
    const t0 = performance.now();
    const bmp = image.getBitmap();
    const copy = new ArrayBuffer(bmp.length);
    Buffer.from(copy).set(bmp);             // Transferring to the worker needs a detachable copy.
    const grabMs = performance.now() - t0;
    w.once("message", (m) => res({ ...m, grabMs, wallMs: performance.now() - t0 }));
    w.postMessage({ id: 1, buf: copy, w: s.width, h: s.height, level }, [copy]);
  });
  for (const level of [1, 3, 6]) {
    const r1 = await send(level); const r2 = await send(level);
    console.log(`${P.padEnd(6)} ${s.width}x${s.height} | main toPNG ${mainMs.toFixed(1)}ms | worker level=${level}: main-thread ${r2.grabMs.toFixed(2)}ms, worker ${r2.ms.toFixed(1)}ms, total ${r2.wallMs.toFixed(1)}ms, ${(r2.bytes/1024).toFixed(0)}KB`);
  }
  await w.terminate(); app.quit();
});
