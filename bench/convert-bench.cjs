// What a BGRA->RGBA channel swap actually costs in the gfx worker, and what share of the
// worker's per-frame time it is. DETAIL.md 8.3 measured the worker at 12.5-24.3ms for a whole
// raw frame and attributed it to "a BGRA->RGBA pass plus a 20MB write" without splitting the
// two. The split is what decides whether moving the swap to Rust is worth a Node<->Rust bridge:
// the ceiling on that move is the swap's share, not the whole 9ms.
//
// Frame size matches 8.1/8.3 exactly: a 1440x900 pane at deviceScaleFactor 2.
const { writeFileSync, renameSync, unlinkSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const WIDTH = 2880;
const HEIGHT = 1800;
const BYTES = WIDTH * HEIGHT * 4;
const ITERATIONS = 30;
const WARMUP = 5;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function stats(name, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    name,
    n: samples.length,
    min: sorted[0],
    p50: median(samples),
    p90: sorted[Math.floor(sorted.length * 0.9)],
    max: sorted[sorted.length - 1],
  };
}

function timed(fn) {
  const samples = [];
  for (let i = 0; i < WARMUP + ITERATIONS; i += 1) {
    const start = process.hrtime.bigint();
    fn();
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    if (i >= WARMUP) samples.push(elapsed);
  }
  return samples;
}

// The exact loop that ships in electron/gfx-worker.cjs writeRawFrame().
function swapBytewise(bgra, rgba) {
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = bgra[i + 3];
  }
}

// One 32-bit read/write per pixel instead of four 8-bit ones. Same result, and it is the
// cheapest alternative to a native module: if this is close to the native ceiling, a bridge
// buys nothing that ten lines of JS does not.
function swapU32(src32, dst32) {
  for (let i = 0; i < src32.length; i += 1) {
    const p = src32[i];
    dst32[i] = (p & 0xff00ff00) | ((p & 0x00ff0000) >>> 16) | ((p & 0x000000ff) << 16);
  }
}

const bgra = Buffer.allocUnsafe(BYTES);
for (let i = 0; i < BYTES; i += 4) {
  bgra[i] = i & 0xff;
  bgra[i + 1] = (i >>> 8) & 0xff;
  bgra[i + 2] = (i >>> 16) & 0xff;
  bgra[i + 3] = 255;
}
const rgba = Buffer.allocUnsafe(BYTES);

const src32 = new Uint32Array(bgra.buffer, bgra.byteOffset, BYTES / 4);
const dst32 = new Uint32Array(rgba.buffer, rgba.byteOffset, BYTES / 4);

// Correctness before speed: an unverified fast path is not a measurement of anything.
swapBytewise(bgra, rgba);
const expected = Buffer.from(rgba);
rgba.fill(0);
swapU32(src32, dst32);
if (!expected.equals(rgba)) throw new Error("swapU32 disagrees with the shipping bytewise loop");

const benchDir = path.join(os.tmpdir(), "tweb-convert-bench");
mkdirSync(benchDir, { recursive: true });
const framePath = path.join(benchDir, "frame.rgba");

// The write is the other half of the worker's time, and it is the half a Rust swap cannot
// touch. gfx-worker.cjs stages to .tmp and renames, so measure that, not a bare write.
function writeFrame() {
  const staging = `${framePath}.tmp`;
  writeFileSync(staging, rgba);
  renameSync(staging, framePath);
}

const results = [
  stats("swap bytewise (ships today)", timed(() => swapBytewise(bgra, rgba))),
  stats("swap u32 (JS, no bridge)", timed(() => swapU32(src32, dst32))),
  stats("alloc 20.7MB buffer", timed(() => Buffer.allocUnsafe(BYTES))),
  stats("write 20.7MB + rename", timed(writeFrame)),
  stats("swap bytewise + write (whole worker pass)", timed(() => { swapBytewise(bgra, rgba); writeFrame(); })),
  stats("swap u32 + write (whole worker pass)", timed(() => { swapU32(src32, dst32); writeFrame(); })),
];

try { unlinkSync(framePath); } catch {}
try { unlinkSync(`${framePath}.tmp`); } catch {}

console.log(JSON.stringify({
  frame: { width: WIDTH, height: HEIGHT, bytes: BYTES, mb: +(BYTES / 1e6).toFixed(1) },
  node: process.version,
  iterations: ITERATIONS,
  unit: "ms",
  results,
}, null, 2));
