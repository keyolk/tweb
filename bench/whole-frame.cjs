// The whole-frame path: what the main thread pays to get a frame out the door.
//
// The shipping path encoded PNG synchronously on the main thread. The raw path hands the
// bitmap to the worker instead, which swaps BGRA->RGBA and writes the file. Only the
// main-thread column matters for input latency — the worker's time is absorbed by the
// one-deep queue, which drops superseded frames anyway.
const { app, BrowserWindow } = require("electron");
const { performance } = require("node:perf_hooks");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), url = require("node:url");

const W = Number(process.env.BW || 1440), H = Number(process.env.BH || 900);
const DSF = Number(process.env.BD || 2);
const P = process.env.BP || "mixed";
const SRC = url.pathToFileURL(path.join(__dirname, "pages", `${P}.html`)).href;
const DIR = path.join(os.tmpdir(), "tweb-whole-frame"); fs.mkdirSync(DIR, { recursive: true });
// The shipping main.cjs does not set this switch. NOGPU=1 is for comparison only.
if (process.env.NOGPU) app.commandLine.appendSwitch("disable-gpu-compositing");

const bench = (fn, it = 5) => { const t = performance.now(); let o; for (let i=0;i<it;i++) o = fn(i); return { ms:(performance.now()-t)/it, out:o }; };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false,
    webPreferences: { offscreen: { deviceScaleFactor: DSF } } });
  win.webContents.setFrameRate(60);
  let latest = null;
  win.webContents.on("paint", (_e, _d, img) => { latest = img; });
  await win.loadURL(SRC);
  // Compositing needs a few more frames even after load finishes. Wait, then measure the last frame.
  await new Promise(r => setTimeout(r, 2500));
  win.webContents.invalidate();
  await new Promise(r => setTimeout(r, 800));
  const image = latest;
  if (!image || image.isEmpty()) { console.log("no frame"); app.quit(); return; }
  const s = image.getSize();

  // PNG path: encode on the main thread, then the worker writes it.
  const png = bench(() => image.toPNG(), 3);
  const pngWrite = bench((i) => {
    const p = path.join(DIR, `f${i%2}.png`);
    fs.writeFileSync(p + ".tmp", png.out); fs.renameSync(p + ".tmp", p);
  });

  // Raw path: an owned copy for the worker, which swaps and writes.
  const bitmap = bench(() => image.toBitmap(), 10);
  const bgra = bitmap.out;
  const rgba = Buffer.allocUnsafe(bgra.length);
  const swap = bench(() => {
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i] = bgra[i+2]; rgba[i+1] = bgra[i+1]; rgba[i+2] = bgra[i]; rgba[i+3] = bgra[i+3];
    }
  }, 3);
  const rawWrite = bench((i) => {
    const p = path.join(DIR, `f${i%2}.rgba`);
    fs.writeFileSync(p + ".tmp", rgba); fs.renameSync(p + ".tmp", p);
  }, 3);

  console.log(`${P.padEnd(6)} ${s.width}x${s.height} ${(bgra.length/1e6).toFixed(1)}MB raw`);
  console.log(`  png  main ${png.ms.toFixed(1).padStart(6)}ms | worker ${pngWrite.ms.toFixed(1).padStart(5)}ms | ${(png.out.length/1024).toFixed(0)}KB on the wire`);
  console.log(`  raw  main ${bitmap.ms.toFixed(1).padStart(6)}ms | worker ${(swap.ms+rawWrite.ms).toFixed(1).padStart(5)}ms (swap ${swap.ms.toFixed(1)} + write ${rawWrite.ms.toFixed(1)}) | ${(rgba.length/1024).toFixed(0)}KB`);
  app.quit();
});
