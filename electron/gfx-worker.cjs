// The whole-frame writer, off the main thread.
//
// What is expensive about a whole frame is producing the bytes: the BGRA->RGBA pass over up to
// 20MB of pixels, and writing that file. What is *cheap* is the escape sequence that tells the
// terminal about it — for the file transport it is the base64 of a pathname, a few dozen bytes.
//
// So this thread does the expensive half and hands the sequence back. It deliberately does not
// write to a terminal itself. Two reasons, and the first one is a bug that exists without it:
// writing here means a second writer on a pane that the main thread is also writing caret and
// patch sequences to, which is the tear `frame-writer.cjs` was built to remove — measured at
// roughly one frame in 750. And a hosted engine's stdout is the supervisor's control pipe, so a
// frame written to it is not a frame at all, it is a corrupted protocol stream.

const { mkdirSync, renameSync, unlinkSync, writeFileSync } = require("node:fs");
const { deflateSync } = require("node:zlib");
const path = require("node:path");
const { parentPort } = require("node:worker_threads");
const os = require("node:os");

const CHUNK = 3072;
const LITTLE_ENDIAN = os.endianness() === "LE";
const frameFiles = new Set();

// The payload cap on one Kitty escape. Anything larger arrives as a run of `m=1` continuations.
function directCommands(message, png) {
  const payload = png.toString("base64");
  const commands = [];
  let first = true;
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    const chunk = payload.slice(offset, offset + CHUNK);
    const more = offset + CHUNK < payload.length;
    commands.push({
      header: first ? `${message.header},t=d,q=2${more ? ",m=1" : ""}` : `${more ? "m=1," : ""}q=2`,
      payload: chunk,
    });
    first = false;
  }
  return commands;
}

// The file is renamed into place rather than written in place: the terminal may read it at any
// moment, and a half-written file is a sheared frame.
function writeFrameFile(filePath, bytes) {
  const stagingPath = `${filePath}.tmp`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(stagingPath, bytes);
  renameSync(stagingPath, filePath);
  frameFiles.add(filePath);
  return Buffer.from(filePath).toString("base64");
}

function fileCommands(message, png) {
  return [{ header: `${message.header},t=f,q=2`, payload: writeFrameFile(message.filePath, png) }];
}

// One byte at a time. Kept as the fallback for the cases `swapU32` cannot take, and as the
// definition of correct that `swapU32` is checked against.
function swapBytewise(bgra, rgba) {
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = bgra[i + 3];
  }
}

// One 32-bit read/write per pixel instead of four 8-bit ones. Measured on a 2880x1800 frame:
// 6.58ms bytewise against 2.90ms here, reproduced across two runs by `bench/convert-bench.cjs`.
//
// Little-endian only: the mask positions below name B/G/R/A by their LE bit offsets, and on a
// big-endian host they would name the wrong channels — silently, since the result is still a
// plausible image. Guarded at the call site rather than made portable, because every platform
// this engine runs on is little-endian and an untested branch is worse than an absent one.
function swapU32(src32, dst32) {
  for (let i = 0; i < src32.length; i += 1) {
    const p = src32[i];
    dst32[i] = (p & 0xff00ff00) | ((p & 0x00ff0000) >>> 16) | ((p & 0x000000ff) << 16);
  }
}

// Deflate, when it is cheaper than the write it saves.
//
// The frame write is the only thing that drops frames — DETAIL.md 8.5 measured its p99 at 164%
// of the 33.3ms a 30fps cap allows, and a probe that skipped the write took
// `droppedByBackpressure` from ~244 to 0. `o=z` is the protocol's own answer: the terminal
// inflates the payload, so the bytes that reach the disk are the compressed ones. Ghostty 1.3.1
// really decompresses it, and `bench/gfx-deflate.py` proves that rather than assuming it — a
// deliberately corrupt stream is answered `EINVAL: decompression failed`, which is the evidence
// that a plain OK on a valid stream means something.
//
// It is emphatically NOT a free win, which is why this is a decision and not a default:
//
//     text-like frame     20.7MB -> 0.9MB   deflate ~21ms   worth it
//     photo-like frame    20.7MB -> 10.0MB  deflate ~109ms  three times the whole budget
//
// Compressing a photo costs more than writing it. So the choice has to be made per frame, and
// it has to be made without paying the very cost it is trying to avoid.
const SAMPLE_BYTES = 512 * 1024;

// Deflate a sample of the frame and let its ratio stand in for the whole.
//
// Measured to predict well enough for a threshold decision: a text frame samples at ~27x and
// compresses at ~39x, a photo samples at ~2x and compresses at ~2.1x. The sample costs a few ms
// against the 12-107ms of the real thing, so a wrong guess is cheap and a right one is most of
// the saving.
//
// Sampled as a handful of CONTIGUOUS CHUNKS, not as scattered pixels. Taking one pixel every
// `stride` bytes looks more representative and is actively wrong: it discards exactly the local
// redundancy deflate lives on, and worse, its error depends on the stride. Measured on
// photo-like pixels, which really compress 2.08x:
//
//     4.2MB frame (stride 8)    sampled 14.25x     — would have compressed a photo
//     8.4MB frame (stride 16)   sampled 12.89x     — same
//     20.7MB frame (stride 36)  sampled  1.97x     — right, but only by luck of the stride
//
// Chunks preserve the runs deflate would find, so the sample compresses like the frame does.
// Several of them spread across the frame rather than one: any single region can be atypical —
// a page has a blank margin, a photo has a flat sky — and one unlucky window would answer for
// everything.
const SAMPLE_CHUNKS = 8;

function sampleRatio(rgba) {
  if (rgba.length <= SAMPLE_BYTES * 2) return null;
  const chunk = Math.floor(SAMPLE_BYTES / SAMPLE_CHUNKS) & ~3;
  const span = Math.floor(rgba.length / SAMPLE_CHUNKS);
  const parts = [];
  for (let i = 0; i < SAMPLE_CHUNKS; i += 1) {
    // Offset into the middle of each span, so the first chunk is not the frame's top edge —
    // which on a page is uniform background and compresses unlike anything else on screen.
    const start = Math.min(rgba.length - chunk, i * span + ((span - chunk) >> 1));
    parts.push(rgba.subarray(start, start + chunk));
  }
  const sample = Buffer.concat(parts);
  return sample.length / deflateSync(sample, { level: 1 }).length;
}

// Below this, compressing costs more than it saves.
//
// The write scales with the bytes written and deflate scales with the bytes read, so the trade is
// roughly "does the ratio beat the cost of one pass over the frame". At 4x a 20.7MB frame becomes
// 5.2MB — the write drops well under budget — while the deflate stays near the ~20ms that a
// compressible frame costs. Photo content lands at 2.1x and is correctly excluded; the two page
// profiles that produce scroll frames at all land at 8x and 23x and are correctly included.
const MIN_RATIO = 4;

// Level 1. Higher levels are not worth measuring twice: on real frames L2 and L3 changed the
// ratio by under 5% (23x vs 23x on text, 8x vs 9x on mixed) for the same or more time.
const DEFLATE_LEVEL = 1;

/**
 * The payload to transmit, and whether it is deflated.
 *
 * Returns the original buffer when compression would not pay, so the caller's fallback is the
 * shipping behaviour rather than a slower version of it.
 */
function maybeDeflate(rgba) {
  let ratio;
  try {
    ratio = sampleRatio(rgba);
  } catch {
    // A sampling failure must not cost the frame; the uncompressed path always works.
    return { payload: rgba, compressed: false };
  }
  if (ratio === null || ratio < MIN_RATIO) return { payload: rgba, compressed: false };
  try {
    return { payload: deflateSync(rgba, { level: DEFLATE_LEVEL }), compressed: true };
  } catch {
    return { payload: rgba, compressed: false };
  }
}

// Raw pixels, no PNG container. `f=32` is independent of the transfer medium, so the same
// file transport carries them — and the encode the main thread used to pay for disappears:
// measured 101ms for a photo, against ~2ms to hand the bitmap over.
//
// Chromium's bitmap is BGRA on macOS and the protocol wants RGBA, so the channels are swapped
// here rather than on the main thread. This is the one CPU pass over the frame.
//
// It is NOT a candidate for a native module, which an earlier comment here claimed. The pass is
// memory-bandwidth bound: a bare memcpy of the same 20MB costs 0.347ms and the scalar loop
// 0.431ms, so the whole headroom a SIMD rewrite could win is under 0.1ms — and that measurement
// is why `tweb-native` was deleted rather than finished. See DETAIL.md 8.4.
function rawCommands(message, bgra) {
  const rgba = Buffer.allocUnsafe(bgra.length);
  // A Uint32Array view needs both ends 4-byte aligned; `Buffer.allocUnsafe` under 4KB comes out
  // of a shared pool at an arbitrary offset, so this is a real case and not a formality. A
  // misaligned view throws RangeError, which would kill the frame rather than slow it down.
  const alignable = (bgra.byteOffset & 3) === 0
    && (rgba.byteOffset & 3) === 0
    && (bgra.length & 3) === 0;
  if (alignable && LITTLE_ENDIAN) {
    swapU32(
      new Uint32Array(bgra.buffer, bgra.byteOffset, bgra.length >>> 2),
      new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >>> 2),
    );
  } else {
    swapBytewise(bgra, rgba);
  }
  // `o=z` tells the terminal the payload is deflated; it inflates before decoding, so `f=32`
  // and the file medium are unchanged either way.
  const { payload, compressed } = maybeDeflate(rgba);
  const options = compressed ? ",o=z" : "";
  return [{
    header: `${message.header},f=32${options},s=${message.width},v=${message.height},t=f,q=2`,
    payload: writeFrameFile(message.filePath, payload),
  }];
}

function frameCommands(message) {
  const pixels = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  if (message.format === "raw") {
    // Raw needs a file: there is no escape-sequence fallback for 20MB of pixels, and the caller
    // only sends raw where it knows the terminal takes it. A failure propagates so the main
    // thread can count it and give raw up — see `noteRawFrameFailure`.
    return rawCommands(message, pixels);
  }
  if (message.transport === "file") {
    try {
      return fileCommands(message, pixels);
    } catch {
      // Direct transfer is slower but keeps rendering if the frame file cannot be written.
    }
  }
  return directCommands(message, pixels);
}

// The frame files this thread wrote, removed on exit. They are named after the engine pid, so
// an engine that never reaches this path leaves them collectable — see `abandonedFrameFiles`.
function cleanup() {
  for (const filePath of frameFiles) {
    try { unlinkSync(filePath); } catch {}
    try { unlinkSync(`${filePath}.tmp`); } catch {}
  }
}

process.on("exit", cleanup);
// Guarded so the command builders above can be required and tested without a worker host.
// Without it, requiring this file on the main thread throws on a null `parentPort`.
if (parentPort) {
  parentPort.on("message", (message) => {
    // The pane is echoed back on every reply, including the failure one. The main thread routes
    // the completion by it, and a reply that dropped it would strand that pane believing the
    // worker is still busy — it would never dispatch again and would freeze on its last frame.
    const paneKey = message?.paneKey ?? null;
    try {
      const commands = message.type === "frame" ? frameCommands(message) : [];
      parentPort.postMessage({ type: "ready", paneKey, commands });
    } catch (error) {
      parentPort.postMessage({ type: "error", paneKey, message: error.message, commands: [] });
    }
  });
}

module.exports = {
  directCommands, fileCommands, rawCommands, frameCommands, swapBytewise, swapU32,
  maybeDeflate, sampleRatio, CHUNK, MIN_RATIO,
};
