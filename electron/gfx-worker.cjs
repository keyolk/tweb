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
  return [{
    header: `${message.header},f=32,s=${message.width},v=${message.height},t=f,q=2`,
    payload: writeFrameFile(message.filePath, rgba),
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
  directCommands, fileCommands, rawCommands, frameCommands, swapBytewise, swapU32, CHUNK,
};
