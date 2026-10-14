"use strict";

// The tweb-webkit process, and the wire to it (crates/tweb-engine/webkit/src/protocol.rs).
//
//   stdin   one JSON command per line
//   stdout  one JSON event per line
//   fd 3    binary records: frames, capture replies, PDFs
//
// Pixels have a channel of their own so a 20MB frame is never base64 and never JSON.

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const HEADER_LEN = 56;
const MAGIC = 0x52465754;
const KIND_PAINT = 1;
const KIND_CAPTURE = 2;
const KIND_BYTES = 3;

/// The header of a binary record, or null if `buffer` does not start with one.
function parseHeader(buffer) {
  if (buffer.length < HEADER_LEN) return null;
  if (buffer.readUInt32LE(0) !== MAGIC) throw new Error("tweb-webkit: frame channel out of sync");
  return {
    kind: buffer.readUInt32LE(4),
    view: buffer.readUInt32LE(8),
    width: buffer.readUInt32LE(12),
    height: buffer.readUInt32LE(16),
    rect: {
      x: buffer.readUInt32LE(20),
      y: buffer.readUInt32LE(24),
      width: buffer.readUInt32LE(28),
      height: buffer.readUInt32LE(32),
    },
    req: Number(buffer.readBigUInt64LE(40)),
    length: Number(buffer.readBigUInt64LE(48)),
  };
}

/// Reassembles records from the fd 3 stream. Chunks are kept as a list and joined once per
/// record: concatenating per chunk would copy a 20MB frame dozens of times.
class RecordReader {
  constructor(onRecord) {
    this.onRecord = onRecord;
    this.chunks = [];
    this.buffered = 0;
    this.header = null;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    for (;;) {
      if (!this.header) {
        if (this.buffered < HEADER_LEN) return;
        const head = this.take(HEADER_LEN);
        this.header = parseHeader(head);
      }
      if (this.buffered < this.header.length) return;
      const payload = this.take(this.header.length);
      const header = this.header;
      this.header = null;
      this.onRecord(header, payload);
    }
  }

  take(count) {
    if (count === 0) return Buffer.alloc(0);
    const joined = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    const out = joined.subarray(0, count);
    const rest = joined.subarray(count);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }
}

/// Where the host binary is: an explicit `TWEB_WEBKIT`, then beside the `tweb` that started
/// this engine, then a build in this checkout, then PATH.
function findHelper(env = process.env, appDir = path.join(__dirname, "..")) {
  const candidates = [
    env.TWEB_WEBKIT,
    path.join(appDir, "..", "target", "release", "tweb-webkit"),
    path.join(appDir, "..", "target", "debug", "tweb-webkit"),
    // `make install`: <prefix>/libexec/tweb/electron is the app, <prefix>/bin the binaries.
    path.join(appDir, "..", "..", "..", "bin", "tweb-webkit"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* next */ }
  }
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, "tweb-webkit");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* next */ }
  }
  return null;
}

class WebKitHelper extends EventEmitter {
  constructor(child) {
    super();
    this.setMaxListeners(0);
    this.child = child;
    this.nextReq = 1;
    this.pending = new Map();
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this.once("ready", resolve);
      this.once("exit", () => reject(new Error("tweb-webkit exited before it was ready")));
    });
    this.ready.catch(() => {});
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    const reader = new RecordReader((header, payload) => this.onRecord(header, payload));
    child.stdio[3].on("data", (chunk) => {
      try {
        reader.push(chunk);
      } catch (error) {
        console.error(error.message);
        this.child.kill();
      }
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error("tweb-webkit exited"));
      this.pending.clear();
      this.emit("exit", code, signal);
    });
  }

  static spawn({ binary, env = process.env } = {}) {
    const helper = binary || findHelper(env);
    if (!helper) {
      throw new Error("tweb-webkit not found; build it (cargo build -p tweb-engine-webkit) or set TWEB_WEBKIT");
    }
    const child = spawn(helper, [], { stdio: ["pipe", "pipe", "inherit", "pipe"], env });
    return new WebKitHelper(child);
  }

  send(command) {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /// A command answered by a `result` event or a binary record carrying the same `req`.
  request(command) {
    if (this.closed) return Promise.reject(new Error("tweb-webkit is not running"));
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      this.pending.set(req, { resolve, reject });
      this.send({ ...command, req });
    });
  }

  onLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (event.ev === "result") {
      const pending = this.pending.get(event.req);
      if (!pending) return;
      this.pending.delete(event.req);
      if (event.ok) pending.resolve(event.value);
      else pending.reject(new Error(event.error || "evaluation failed"));
      return;
    }
    this.emit(event.ev, event);
  }

  onRecord(header, payload) {
    if (header.kind === KIND_PAINT) {
      this.emit("paint", header, payload);
      return;
    }
    const pending = this.pending.get(header.req);
    if (!pending) return;
    this.pending.delete(header.req);
    if (header.kind === KIND_CAPTURE) pending.resolve({ width: header.width, height: header.height, pixels: payload });
    else if (header.kind === KIND_BYTES) pending.resolve(payload);
  }

  stop() {
    if (this.closed) return;
    this.send({ op: "quit" });
    this.child.stdin.end();
  }
}

module.exports = { WebKitHelper, RecordReader, findHelper, parseHeader, HEADER_LEN, KIND_PAINT };
