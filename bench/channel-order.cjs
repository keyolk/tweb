// Is the BGRA->RGBA swap right on a frame Chromium actually produced?
//
// gfx-worker.test.cjs proves `swapU32` agrees with `swapBytewise`, but agreement is not
// correctness: both would be wrong together if the bitmap Chromium hands over were not the
// byte order the loop assumes. So this renders a page of known colours, runs the real
// `rawCommands`, and reads the colours back out of the file it produced.
//
//     electron/node_modules/.bin/electron bench/channel-order.cjs
//     VERBOSE=1 ... bench/channel-order.cjs      # dumps the frame's colour histogram
//
// Judged by whether each expected colour is PRESENT, not by which colour is most common: the
// bands carry 34px white text, and in two of them the text outnumbers the background —
// measured rgb(255,255,255)x2831 against rgb(255,128,0)x2069. Ranking by frequency there
// measures the font weight, not the channel order. The `r/b-swapped` column is the actual
// verdict: for a band whose R and B differ, a swap moves every pixel to the twin colour, so
// `present>0, swapped=0` is the signature of a correct swap and the reverse of a broken one.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const url = require("node:url");
const fs = require("node:fs");
const os = require("node:os");
const { rawCommands } = require("../electron/gfx-worker.cjs");

const W = 400, H = 360, DSF = 1;
const HTML = url.pathToFileURL(
  process.env.PAGE || path.join(__dirname, "pages", "channels.html")).href;

// 페이지의 밴드 순서와 기대 RGB. 채널이 뒤집히면 RED/BLUE 가 서로 자리를 바꾼다.
const BANDS = [
  ["RED", 255, 0, 0], ["BLUE", 0, 0, 255], ["GREEN", 0, 255, 0],
  ["ORANGE", 255, 128, 0], ["AZURE", 0, 128, 255], ["WHITE", 255, 255, 255],
  ["BLACK", 0, 0, 0], ["MAGENTA", 255, 0, 255], ["CYAN", 0, 255, 255],
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false,
    webPreferences: { offscreen: { deviceScaleFactor: DSF } } });
  win.webContents.on("did-fail-load", (_e, code, desc, u) =>
    console.log());
  await win.loadURL(HTML);
  console.log("url:", win.webContents.getURL());
  console.log("body:", await win.webContents.executeJavaScript(
    "document.body ? document.body.children.length + ' children, first bg=' + "
    + "(document.body.firstElementChild ? getComputedStyle(document.body.firstElementChild).backgroundColor : 'none') : 'no body'"));
  await new Promise(r => setTimeout(r, 1500));

  // capturePage 대신 paint 이벤트: main.cjs 가 실제로 프레임을 얻는 그 경로다.
  // 첫 paint 는 페이지가 칠해지기 전의 빈 프레임일 수 있다 (측정: 전 밴드 250,250,250).
  // 마지막 paint 를 쓴다: 일정 시간 새 프레임이 없으면 화면이 안정된 것이다.
  // 내용이 있는 프레임만 받는다. 빈 프레임은 전 픽셀이 같은 값이므로 그것으로 거른다 —
  // 앞선 시도들은 균일한 250,250,250 을 잡아 스왑이 아니라 하네스를 측정하고 있었다.
  win.webContents.setFrameRate(60);
  const image = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("no non-blank frame in 20s")), 20000);
    win.webContents.on("paint", (_e, _dirty, img) => {
      const b = img.toBitmap();
      let varied = false;
      for (let i = 4; i < b.length; i += 4004) {
        if (b[i] !== b[0] || b[i + 1] !== b[1] || b[i + 2] !== b[2]) { varied = true; break; }
      }
      if (varied) { clearTimeout(deadline); resolve(img); }
    });
    // 스크롤 한 번이 whole-frame paint 를 강제한다 (damage.cjs 가 측정한 그 성질).
    setInterval(() => win.webContents.sendInputEvent({
      type: "mouseWheel", x: 10, y: 10, deltaX: 0, deltaY: -1, canScroll: true }), 100);
  });
  const size = image.getSize();
  const bgra = image.toBitmap();          // main.cjs 가 워커에 넘기는 것과 같은 형식
  const filePath = path.join(os.tmpdir(), `tweb-channel-order-${process.pid}.rgba`);

  // 실제 출하 경로를 그대로 통과시킨다.
  rawCommands({ header: "a=T,i=1", filePath, width: size.width, height: size.height }, bgra);
  const out = fs.readFileSync(filePath);

  console.log(`frame ${size.width}x${size.height}, ${out.length} bytes`);
  const counts = new Map();
  for (let o = 0; o < out.length; o += 4) {
    const k = out[o] + "," + out[o + 1] + "," + out[o + 2];
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (process.env.VERBOSE) console.log("top colours in the produced RGBA:");
  if (process.env.VERBOSE) [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .forEach(([k, n]) => console.log("   rgb(" + k + ") x" + n));
  if (process.env.VERBOSE) {
    console.log("middle column, every 40 rows:");
    for (let y = 10; y < size.height; y += 40) {
      const o = (y * size.width + (size.width >> 1)) * 4;
      console.log("   y=" + y + " rgb(" + out[o] + "," + out[o + 1] + "," + out[o + 2] + ")");
    }
  }
  let bad = 0;
  BANDS.forEach(([name, r, g, b], i) => {
    // 각 밴드 중앙에서 표본을 뜬다. 텍스트를 피하려고 오른쪽 가장자리 근처를 본다.
    const y = Math.floor(size.height * (i + 0.5) / BANDS.length);
    // 한 점이 아니라 그 행의 최빈색. 밴드 위에는 흰 글자가 얹혀 있어 어느 한 좌표를
    // 고르든 글자를 맞출 수 있다 — 최빈색은 배경이고, 그것이 채널을 판정할 대상이다.
    const tally = new Map();
    // 밴드 높이의 중앙 40% 안에서만, 그리고 여러 행에 걸쳐 센다. 한 행만 보면 글자
    // 획이 그 행을 지배할 수 있고, 실제로 ORANGE/BLACK 이 그렇게 흰색으로 읽혔다.
    const band = size.height / BANDS.length;
    const y0 = Math.floor(y - band * 0.2);
    const y1 = Math.ceil(y + band * 0.2);
    for (let yy = y0; yy < y1; yy += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const q = (yy * size.width + x) * 4;
        const k = out[q] + "," + out[q + 1] + "," + out[q + 2];
        tally.set(k, (tally.get(k) || 0) + 1);
      }
    }
    // 판정 기준은 최빈색이 아니라 "기대 색이 이 구간에 실재하는가" 다. 밴드 위에는 34px
    // 흰 글자가 얹혀 있어 ORANGE/BLACK 구간에서는 글자가 배경보다 픽셀을 더 많이 차지한다 —
    // 측정된 값 그대로 rgb(255,255,255)x2831 대 rgb(255,128,0)x2069. 최빈색으로 재면
    // 스왑이 아니라 글꼴 굵기를 재게 된다.
    //
    // 채널 오류라면 기대 색은 아예 나타나지 않고 R/B 가 교환된 색이 그 자리를 차지하므로,
    // 존재 여부만으로 충분히 판별된다.
    const pixelsAt = (rr, gg, bb) => tally.get(rr + "," + gg + "," + bb) || 0;
    const hit = pixelsAt(r, g, b);
    const swapped = pixelsAt(b, g, r);          // R/B 를 뒤바꾼, 이 테스트가 잡으려는 결함
    const near = hit > 500 && hit >= swapped;
    const got = hit > 0 ? [r, g, b] : [...tally].sort((a, c) => c[1] - a[1])[0][0].split(",").map(Number);
    if (!near) {
      bad++;
      // 추측으로 하네스를 고치지 않는다: 그 밴드 구간에 실제로 무엇이 있는지 센다.
      const top = [...tally].sort((a, c) => c[1] - a[1]).slice(0, 4)
        .map(([k, n]) => "rgb(" + k + ")x" + n).join("  ");
      console.log("      rows " + y0 + ".." + y1 + " -> " + top);
    }
    console.log(`  ${name.padEnd(8)} expect rgb(${r},${g},${b}) present=${hit}px `
      + `r/b-swapped=${swapped}px ${near ? "OK" : "MISMATCH"}`);
  });
  console.log(bad === 0 ? "\nPASS - channel order correct on a real rendered frame"
                        : `\nFAIL - ${bad} band(s) wrong`);
  fs.rmSync(filePath, { force: true });
  process.exit(bad === 0 ? 0 : 1);
});
