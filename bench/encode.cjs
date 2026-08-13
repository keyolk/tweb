// 1) What it costs to crop to the dirty area and encode that.
// 2) The total cost of the raw RGBA (kitty f=32,t=s) path.
const { app, BrowserWindow } = require("electron");
const path = require("node:path"); const url = require("node:url");
const { performance } = require("node:perf_hooks");
const fs = require("node:fs"); const os = require("node:os");
const HTML = url.pathToFileURL(path.join(__dirname, "pages", process.env.BP || "mixed.html".replace(".html",""))).href;
const P = process.env.BP || "mixed";
const SRC = url.pathToFileURL(path.join(__dirname, "pages", `${P}.html`)).href;
const DIR = path.join(os.tmpdir(), "twebbench"); fs.mkdirSync(DIR, { recursive: true });
// The shipping main.cjs does not set this switch. NOGPU=1 is for comparison only.
if (process.env.NOGPU) app.commandLine.appendSwitch("disable-gpu-compositing");
const bench = (fn, it = 10) => { const t = performance.now(); let o; for (let i=0;i<it;i++) o = fn(i); return { ms:(performance.now()-t)/it, out:o }; };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false,
    webPreferences: { offscreen: { deviceScaleFactor: 2 } } });
  win.webContents.setFrameRate(60);
  let latest = null;
  win.webContents.on("paint", (_e, _d, image) => { latest = image; });
  await win.loadURL(SRC);
  await new Promise(r => setTimeout(r, 2500));
  win.webContents.invalidate();
  await new Promise(r => setTimeout(r, 800));
  const image = latest; const s = image.getSize();
  const raw = image.getBitmap();
  const rgba = Buffer.alloc(raw.length);

  console.log(`\n== ${P} ${s.width}x${s.height} (${(raw.length/1e6).toFixed(1)}MB raw)`);

  // whole frame
  const full = bench(() => image.toPNG(), 3);
  console.log(` whole toPNG            ${full.ms.toFixed(1).padStart(6)}ms  ${(full.out.length/1024).toFixed(0)}KB`);

  // dirty crop (DIP coordinates)
  for (const [w,h] of [[64,32],[400,200],[1440,120]]) {
    const c = bench(() => image.crop({ x: 100, y: 100, width: w, height: h }));
    const cropped = c.out;
    const e = bench(() => cropped.toPNG());
    console.log(` crop ${String(w+"x"+h).padEnd(9)} + toPNG ${(c.ms+e.ms).toFixed(2).padStart(6)}ms  ${(e.out.length/1024).toFixed(1)}KB   (crop ${c.ms.toFixed(2)} + enc ${e.ms.toFixed(2)})`);
  }

  // raw RGBA path: getBitmap -> swap -> shm/file write (no PNG)
  const swap = bench(() => { for (let i=0;i<raw.length;i+=4){rgba[i]=raw[i+2];rgba[i+1]=raw[i+1];rgba[i+2]=raw[i];rgba[i+3]=raw[i+3];} }, 3);
  const write = bench((i) => { const p=path.join(DIR,`raw${i%2}.bin`); fs.writeFileSync(p, rgba); }, 5);
  console.log(` raw whole: getBitmap+swap(JS) ${swap.ms.toFixed(1)}ms + write ${write.ms.toFixed(1)}ms = ${(swap.ms+write.ms).toFixed(1)}ms  ${(rgba.length/1024/1024).toFixed(1)}MB`);

  // raw tile path: one tile only (256x256 @2x = 512x512 px)
  const tilePx = 512, bpp = 4, stride = s.width * bpp;
  const tileBuf = Buffer.alloc(tilePx * tilePx * bpp);
  const tile = bench(() => {
    let o = 0;
    for (let y = 0; y < tilePx; y++) {
      const off = (y + 200) * stride + 200 * bpp;
      for (let x = 0; x < tilePx; x++) {
        const i = off + x*4;
        tileBuf[o++] = raw[i+2]; tileBuf[o++] = raw[i+1]; tileBuf[o++] = raw[i]; tileBuf[o++] = raw[i+3];
      }
    }
  }, 20);
  const tileWrite = bench((i) => fs.writeFileSync(path.join(DIR,`t${i%2}.bin`), tileBuf), 10);
  console.log(` raw tile 512x512: swap ${tile.ms.toFixed(2)}ms + write ${tileWrite.ms.toFixed(2)}ms = ${(tile.ms+tileWrite.ms).toFixed(2)}ms  ${(tileBuf.length/1024).toFixed(0)}KB`);
  app.quit();
});
