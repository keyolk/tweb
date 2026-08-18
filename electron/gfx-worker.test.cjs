"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const {
  directCommands, fileCommands, rawCommands, frameCommands, swapBytewise, swapU32,
  maybeDeflate, CHUNK,
} = require("./gfx-worker.cjs");

function temporaryFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tweb-gfx-test-")), name);
}

function message(overrides = {}) {
  return { header: "a=T,i=42,C=1,c=80,r=24", transport: "file", ...overrides };
}

// The whole point of the split: the worker returns sequences, it does not write them. A worker
// that wrote to stdout would be a second writer on a pane the main thread also writes caret and
// patch sequences to — the tear frame-writer.cjs exists to remove — and on a hosted engine that
// stdout is the supervisor's control pipe rather than any terminal at all.
test("a file frame yields one command carrying the path, and writes the file", () => {
  const filePath = temporaryFile("frame.rgba");
  const pixels = Buffer.from([1, 2, 3, 4]);
  const commands = fileCommands(message({ filePath }), pixels);

  assert.equal(commands.length, 1);
  assert.equal(commands[0].header, "a=T,i=42,C=1,c=80,r=24,t=f,q=2");
  assert.equal(Buffer.from(commands[0].payload, "base64").toString(), filePath);
  assert.deepEqual(fs.readFileSync(filePath), pixels);
  // Renamed into place: a terminal that reads the path mid-write would see a sheared frame.
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

test("a raw frame swaps BGRA to RGBA and declares its own dimensions", () => {
  const filePath = temporaryFile("frame.rgba");
  // Chromium hands over BGRA on macOS; the protocol wants RGBA. Alpha is untouched.
  const bgra = Buffer.from([0x10, 0x20, 0x30, 0x40]);
  const commands = rawCommands(message({ filePath, width: 2, height: 1 }), bgra);

  assert.equal(commands[0].header, "a=T,i=42,C=1,c=80,r=24,f=32,s=2,v=1,t=f,q=2");
  // A raw file carries no dimensions of its own, so s=/v= above are the only thing that says
  // how to read it — which is why they are asserted alongside the pixels.
  assert.deepEqual(fs.readFileSync(filePath), Buffer.from([0x30, 0x20, 0x10, 0x40]));
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

// The u32 swap is an optimisation, so what has to be true of it is that it is indistinguishable
// from the loop it replaces — 6.58ms against 2.90ms on a 2880x1800 frame is only worth having if
// the bytes agree. A channel-order error here is not a crash, it is a plausible image with red
// and blue exchanged, which is exactly the kind of defect a test catches and an eye does not.
test("the u32 swap agrees with the bytewise loop on every byte", () => {
  // Every byte value in every channel position, so no mask can be wrong and still pass.
  const bgra = Buffer.allocUnsafe(256 * 4);
  for (let i = 0; i < bgra.length; i += 1) bgra[i] = (i * 7 + (i >>> 2)) & 0xff;

  const expected = Buffer.allocUnsafe(bgra.length);
  swapBytewise(bgra, expected);

  const actual = Buffer.alloc(bgra.length);
  const aligned = (buffer) => {
    // A pooled buffer lands at an arbitrary offset; these views need both ends 4-byte aligned.
    assert.equal(buffer.byteOffset & 3, 0, "test fixture must be 4-byte aligned");
    return new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.length >>> 2);
  };
  swapU32(aligned(bgra), aligned(actual));

  assert.deepEqual(actual, expected);
});

// The guard, not the fast path. `Buffer.allocUnsafe` under 4KB comes out of a shared pool at an
// offset nobody chose, so a misaligned frame is a real input — and a Uint32Array view over one
// throws RangeError, which would lose the frame outright rather than merely render it slowly.
test("a raw frame at a misaligned offset still swaps correctly", () => {
  const filePath = temporaryFile("frame.rgba");
  const backing = Buffer.alloc(4 + 8);
  const bgra = backing.subarray(1, 9);
  bgra.set([0x10, 0x20, 0x30, 0x40, 0x11, 0x22, 0x33, 0x44]);
  assert.notEqual(bgra.byteOffset & 3, 0, "fixture must actually be misaligned");

  rawCommands(message({ filePath, width: 2, height: 1 }), bgra);

  assert.deepEqual(
    fs.readFileSync(filePath),
    Buffer.from([0x30, 0x20, 0x10, 0x40, 0x33, 0x22, 0x11, 0x44]),
  );
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

// A whole frame's worth, through the aligned path, so the shipping size is covered by something
// other than the four-byte fixtures above.
test("a full-size raw frame swaps every pixel", () => {
  const filePath = temporaryFile("frame.rgba");
  const width = 64;
  const height = 32;
  const bgra = Buffer.alloc(width * height * 4);
  for (let i = 0; i < bgra.length; i += 1) bgra[i] = (i * 31) & 0xff;
  const expected = Buffer.allocUnsafe(bgra.length);
  swapBytewise(bgra, expected);

  rawCommands(message({ filePath, width, height }), bgra);

  assert.deepEqual(fs.readFileSync(filePath), expected);
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

// Frames whose content compresses well enough to be worth it.
//
// The write is the only thing that drops frames (DETAIL.md 8.5), and `o=z` is what removes most
// of it — but only for content that actually compresses. These two cases are the decision.
function textLikeFrame(bytes) {
  const buffer = Buffer.allocUnsafe(bytes);
  for (let i = 0; i < bytes; i += 4) {
    const ink = ((i >> 4) ^ (i >> 11)) & 1 && (i % 389) < 60;
    buffer[i] = ink ? 32 : 250;
    buffer[i + 1] = ink ? 32 : 250;
    buffer[i + 2] = ink ? 32 : 250;
    buffer[i + 3] = 255;
  }
  return buffer;
}

function photoLikeFrame(bytes) {
  const buffer = Buffer.allocUnsafe(bytes);
  let seed = 12345;
  for (let i = 0; i < bytes; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const value = (seed >>> 16) & 0xff;
    buffer[i] = value;
    buffer[i + 1] = (value + ((seed >>> 8) & 7)) & 0xff;
    buffer[i + 2] = (value + (seed & 7)) & 0xff;
    buffer[i + 3] = 255;
  }
  return buffer;
}

test("compressible pixels are deflated, and inflate back to the original bytes", () => {
  const pixels = textLikeFrame(4 * 1024 * 1024);
  const result = maybeDeflate(pixels);

  assert.equal(result.compressed, true);
  assert.ok(result.payload.length < pixels.length / 4, "a text frame must compress several fold");
  // The terminal inflates this, so anything but a byte-exact roundtrip is a corrupted frame —
  // and it would be corrupted invisibly, since the escape sequence is identical either way.
  assert.deepEqual(zlib.inflateSync(result.payload), pixels);
});

// The case that makes this a decision rather than a default. Photo pixels compress ~2x and cost
// ~109ms on a whole frame — three times the 33.3ms a 30fps cap allows, against a write of ~10ms.
// Compressing them is strictly worse than not, so the sample must catch it.
test("incompressible pixels are left alone", () => {
  const pixels = photoLikeFrame(4 * 1024 * 1024);
  const result = maybeDeflate(pixels);

  assert.equal(result.compressed, false);
  assert.equal(result.payload, pixels, "the original buffer must pass through, not a copy");
});

// The escape hatch, and the reason it is not hedging. `o=z` is verified on both Ghostty and
// kitty, but the sequence carries q=2 — a terminal that dislikes it cannot say so, and
// `noteRawFrameFailure` never fires because the worker succeeded. A user on some terminal
// neither probe covered would see a corrupt image with nothing in any log, and needs a way out
// that is not editing the source.
test("TWEB_DEFLATE_FRAMES=0 turns compression off", () => {
  const previous = process.env.TWEB_DEFLATE_FRAMES;
  // The flag is read at module load, so this asserts against a fresh instance rather than the
  // one already required above.
  process.env.TWEB_DEFLATE_FRAMES = "0";
  delete require.cache[require.resolve("./gfx-worker.cjs")];
  const disabled = require("./gfx-worker.cjs");
  try {
    const pixels = textLikeFrame(4 * 1024 * 1024);
    assert.equal(disabled.maybeDeflate(pixels).compressed, false);
    assert.doesNotMatch(
      disabled.rawCommands(
        message({ filePath: temporaryFile("off.rgba"), width: 1024, height: 1024 }),
        pixels,
      )[0].header,
      /o=z/,
    );
  } finally {
    if (previous === undefined) delete process.env.TWEB_DEFLATE_FRAMES;
    else process.env.TWEB_DEFLATE_FRAMES = previous;
    delete require.cache[require.resolve("./gfx-worker.cjs")];
  }
});

test("a raw frame declares o=z only when it actually compressed the payload", () => {
  const compressible = temporaryFile("text.rgba");
  const commands = rawCommands(
    message({ filePath: compressible, width: 1024, height: 768 }),
    textLikeFrame(1024 * 768 * 4),
  );
  assert.match(commands[0].header, /,o=z,/, "a deflated payload must be declared o=z");
  // What lands on disk is the compressed payload; a header that lied about it would be decoded
  // as raw pixels and drawn as noise.
  assert.ok(fs.readFileSync(compressible).length < 1024 * 768 * 4);
  fs.rmSync(path.dirname(compressible), { recursive: true, force: true });

  const incompressible = temporaryFile("photo.rgba");
  const raw = rawCommands(
    message({ filePath: incompressible, width: 1024, height: 768 }),
    photoLikeFrame(1024 * 768 * 4),
  );
  assert.doesNotMatch(raw[0].header, /o=z/, "an uncompressed payload must not claim o=z");
  assert.equal(fs.readFileSync(incompressible).length, 1024 * 768 * 4);
  fs.rmSync(path.dirname(incompressible), { recursive: true, force: true });
});

// Small frames skip sampling entirely — a patch is already far below the write cost that makes
// compression worth considering, and sampling one would cost more than it could save. The floor
// is two sample-widths, so the sample is a fraction of the frame rather than most of it.
test("a frame too small to sample is transmitted uncompressed", () => {
  const pixels = textLikeFrame(64 * 1024);
  const result = maybeDeflate(pixels);

  assert.equal(result.compressed, false);
  assert.equal(result.payload, pixels);
});

test("a direct frame is chunked with m=1 continuations", () => {
  // Two chunks' worth, so the first is a continuation and the last is not.
  const png = Buffer.alloc(CHUNK * 2);
  const commands = directCommands(message(), png);

  assert.ok(commands.length > 1, "a payload past the cap must continue");
  assert.match(commands[0].header, /^a=T,i=42,C=1,c=80,r=24,t=d,q=2,m=1$/);
  for (const command of commands.slice(1, -1)) assert.equal(command.header, "m=1,q=2");
  assert.equal(commands.at(-1).header, "q=2");
  // Every chunk fits the cap, and together they are the whole payload.
  const payload = png.toString("base64");
  assert.ok(commands.every((command) => command.payload.length <= CHUNK));
  assert.equal(commands.map((command) => command.payload).join(""), payload);
});

test("a frame that fits in one escape carries no continuation marker", () => {
  const commands = directCommands(message(), Buffer.from("small"));
  assert.equal(commands.length, 1);
  assert.equal(commands[0].header, "a=T,i=42,C=1,c=80,r=24,t=d,q=2");
});

test("an unwritable file falls back to the direct transport", () => {
  // A full disk or an unwritable userData must not freeze the pane on its last frame.
  const commands = frameCommands(message({
    filePath: "/dev/null/not-a-directory/frame.png",
    format: "png",
    buffer: Buffer.from("payload").buffer,
    byteOffset: 0,
    byteLength: 7,
  }));
  assert.ok(commands[0].header.includes("t=d"), "the fallback is the direct transport");
});

// Raw has nowhere to degrade to inside the worker — 20MB does not fit an escape sequence, and
// this thread holds pixels rather than an encoder. It must surface so the main thread can count
// the failure and give raw up for the session.
test("a raw frame that cannot be written throws rather than degrading", () => {
  const bgra = Buffer.alloc(4);
  assert.throws(() => frameCommands({
    header: "a=T,i=42",
    format: "raw",
    filePath: "/dev/null/not-a-directory/frame.rgba",
    width: 1,
    height: 1,
    buffer: bgra.buffer,
    byteOffset: 0,
    byteLength: 4,
  }));
});
