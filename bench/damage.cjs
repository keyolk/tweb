// How small the dirty rect actually gets while scrolling/typing — the ceiling on any tile strategy.
const { app, BrowserWindow } = require("electron");
const path = require("node:path"); const url = require("node:url");
const W = 1440, H = 900, DSF = 2;
const profile = process.env.BP || "mixed";
const HTML = url.pathToFileURL(path.join(__dirname, "pages", `${profile}.html`)).href;
// The shipping main.cjs does not set this switch. NOGPU=1 is for comparison only.
if (process.env.NOGPU) app.commandLine.appendSwitch("disable-gpu-compositing");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false,
    webPreferences: { offscreen: { deviceScaleFactor: DSF } } });
  win.webContents.setFrameRate(60);
  const samples = [];
  let recording = null;
  win.webContents.on("paint", (_e, dirty, image) => {
    const s = image.getSize();
    if (recording) samples.push({ phase: recording, area: (dirty.width*dirty.height)/(s.width*s.height/(DSF*DSF)), d: `${dirty.width}x${dirty.height}` });
  });
  await win.loadURL(HTML);
  await new Promise(r => setTimeout(r, 2000));

  const run = async (phase, fn, ms) => {
    samples.length = 0; recording = phase;
    await fn();
    await new Promise(r => setTimeout(r, ms));
    recording = null;
    const areas = samples.map(s => s.area).sort((a,b)=>a-b);
    if (!areas.length) { console.log(`${phase.padEnd(10)} no frames`); return; }
    const p = (q) => areas[Math.min(areas.length-1, Math.floor(areas.length*q))];
    console.log(`${phase.padEnd(10)} frames=${String(areas.length).padStart(3)} dirty area p50=${(p(.5)*100).toFixed(0)}% p90=${(p(.9)*100).toFixed(0)}% max=${(areas.at(-1)*100).toFixed(0)}%  e.g. ${samples.slice(0,3).map(s=>s.d).join(", ")}`);
  };

  await run("scroll", async () => {
    for (let i = 0; i < 20; i++) {
      win.webContents.sendInputEvent({ type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: -60, canScroll: true });
      await new Promise(r => setTimeout(r, 40));
    }
  }, 300);

  await run("caret", async () => {
    await win.webContents.executeJavaScript(`
      const inp = document.createElement('input'); inp.style.cssText='position:fixed;top:10px;left:10px;width:300px';
      document.body.appendChild(inp); inp.focus(); inp.value=''; true`);
    for (const ch of "hello world typing") {
      win.webContents.sendInputEvent({ type: "char", keyCode: ch });
      await new Promise(r => setTimeout(r, 60));
    }
  }, 300);

  await run("hover", async () => {
    for (let i = 0; i < 15; i++) {
      win.webContents.sendInputEvent({ type: "mouseMove", x: 100 + i*20, y: 300 });
      await new Promise(r => setTimeout(r, 40));
    }
  }, 300);

  app.quit();
});
