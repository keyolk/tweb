// Whether an offscreen window keeps the frame rate it was given once the page takes input.
//
// zenbu-labs/terminal-browser ships a patched Electron (`osr-vsync-display.patch`) whose stated
// reason is that, with no display bound, viz drives the offscreen compositor from a 60Hz timer and
// "any page input then makes the frame interval decider clamp begin frames to 60 and the throttled
// interval permanently overwrites the requested frame rate". tweb asks for 4-30fps, never above 60,
// so the question for tweb is the other direction: after input, does the paint rate stay at what
// `setFrameRate` asked for, or drift?
//
//   $E bench/frame-rate-after-input.cjs        # $E = any Electron binary, stock or patched
//
// Prints paints/s for the window before input, during a burst of synthetic mouse moves, and after
// it, for each requested rate in RATES (default 30,60).

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const PAGE = `file://${path.join(__dirname, "pages", "fullpaint.html")}`;
const RATES = (process.env.RATES || "30,60").split(",").map(Number);
const WINDOW_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One window for every rate: loading the page into a second, freshly created offscreen window failed
// with ERR_FAILED on Electron 44, and a fresh window per rate would also measure start-up.
async function measure(win, counter, rate) {
  win.webContents.setFrameRate(rate);
  await sleep(2000);
  const rateOver = async (during) => {
    counter.paints = 0;
    const started = Date.now();
    await during();
    return Number((counter.paints / ((Date.now() - started) / 1000)).toFixed(1));
  };
  const before = await rateOver(() => sleep(WINDOW_MS));
  const input = await rateOver(async () => {
    const end = Date.now() + WINDOW_MS;
    let x = 0;
    while (Date.now() < end) {
      x = (x + 7) % 700;
      win.webContents.sendInputEvent({ type: "mouseMove", x, y: 200 });
      await sleep(8);
    }
  });
  const after = await rateOver(() => sleep(WINDOW_MS));
  return { requested: rate, before, duringInput: input, after };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 800, height: 500, show: false,
    webPreferences: { offscreen: { deviceScaleFactor: 1 }, backgroundThrottling: false },
  });
  const counter = { paints: 0 };
  win.webContents.on("paint", () => { counter.paints += 1; });
  await win.loadURL(PAGE);
  const results = [];
  for (const rate of RATES) results.push(await measure(win, counter, rate));
  console.log(JSON.stringify({ electron: process.versions.electron, results }));
  app.quit();
});
