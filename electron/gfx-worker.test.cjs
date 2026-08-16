"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { directCommands, fileCommands, rawCommands, frameCommands, CHUNK } =
  require("./gfx-worker.cjs");

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
