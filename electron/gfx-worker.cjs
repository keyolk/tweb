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

const CHUNK = 3072;
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

// Raw pixels, no PNG container. `f=32` is independent of the transfer medium, so the same
// file transport carries them — and the encode the main thread used to pay for disappears:
// measured 101ms for a photo, against ~2ms to hand the bitmap over.
//
// Chromium's bitmap is BGRA on macOS and the protocol wants RGBA, so the channels are
// swapped here rather than on the main thread. This is the one CPU pass over the frame, and
// at ~10ms for 20MB it is the obvious candidate for SIMD in the native crate later.
function rawCommands(message, bgra) {
  const rgba = Buffer.allocUnsafe(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = bgra[i + 3];
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

module.exports = { directCommands, fileCommands, rawCommands, frameCommands, CHUNK };
