"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPaneWriter, fdSink, channelSink, writeFully } = require("./frame-writer.cjs");

function recordingSink() {
  const writes = [];
  const sink = (bytes) => { writes.push(bytes.toString("binary")); };
  return { sink, writes };
}

test("a synchronous sink writes inline, so the exit path still gets its bytes out", () => {
  // The load-bearing property: process.on("exit") cannot await, and the Kitty delete it writes
  // is what removes this pane's image from the terminal.
  const { sink, writes } = recordingSink();
  const writer = createPaneWriter({ sink });
  writer.write("delete");
  assert.deepEqual(writes, ["delete"]);
  assert.equal(writer.pending(), 0);
});

test("an asynchronous sink never has two writes in flight at once", async () => {
  // This is the ~1-in-750 tear, reproduced as an ordering assertion: two writers to one pane
  // spliced a Kitty payload with someone else's bytes.
  const order = [];
  let releaseFirst;
  const sink = (bytes) => {
    const text = bytes.toString("binary");
    order.push(`start:${text}`);
    return new Promise((resolve) => {
      const finish = () => { order.push(`end:${text}`); resolve(); };
      if (text === "a") releaseFirst = finish; else finish();
    });
  };
  const writer = createPaneWriter({ sink });
  writer.write("a");
  writer.write("b");
  // "b" must not have started while "a" is still in flight.
  assert.deepEqual(order, ["start:a"]);
  releaseFirst();
  await writer.flush();
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b"]);
});

test("chunks are never merged, because a Kitty escape is only atomic if it stays contiguous", () => {
  const { sink, writes } = recordingSink();
  const writer = createPaneWriter({ sink });
  writer.write("\x1b_Ga=T;AAAA\x1b\\");
  writer.write("\x1b[1;1H");
  assert.deepEqual(writes, ["\x1b_Ga=T;AAAA\x1b\\", "\x1b[1;1H"]);
});

test("a write arriving mid-flight queues behind, it does not overtake", async () => {
  const order = [];
  let release;
  const sink = (bytes) => {
    const text = bytes.toString("binary");
    order.push(text);
    if (text !== "first") return undefined;
    return new Promise((resolve) => { release = resolve; });
  };
  const writer = createPaneWriter({ sink });
  writer.write("first");
  writer.write("second");
  writer.write("third");
  assert.deepEqual(order, ["first"]);
  assert.equal(writer.pending(), 3);
  release();
  await writer.flush();
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.equal(writer.pending(), 0);
});

test("a failing sink reports and keeps going, so one bad frame does not wedge the pane", () => {
  const failures = [];
  const written = [];
  const sink = (bytes) => {
    if (bytes.toString("binary") === "bad") throw new Error("EPIPE");
    written.push(bytes.toString("binary"));
  };
  const writer = createPaneWriter({ sink, onError: (error) => failures.push(error.message) });
  writer.write("good");
  writer.write("bad");
  writer.write("after");
  assert.deepEqual(written, ["good", "after"]);
  assert.deepEqual(failures, ["EPIPE"]);
});

test("an async sink that rejects does not stall the queue either", async () => {
  const failures = [];
  const written = [];
  const sink = (bytes) => {
    const text = bytes.toString("binary");
    if (text === "bad") return Promise.reject(new Error("ECONNRESET"));
    return Promise.resolve().then(() => { written.push(text); });
  };
  const writer = createPaneWriter({ sink, onError: (error) => failures.push(error.message) });
  writer.write("bad");
  writer.write("after");
  await writer.flush();
  assert.deepEqual(written, ["after"]);
  assert.deepEqual(failures, ["ECONNRESET"]);
});

test("close still drains, because the queued bytes are usually the pane's own image delete", async () => {
  const written = [];
  let release;
  const sink = (bytes) => {
    const text = bytes.toString("binary");
    if (text === "frame") return new Promise((resolve) => { release = resolve; });
    written.push(text);
    return undefined;
  };
  const writer = createPaneWriter({ sink });
  writer.write("frame");
  writer.write("\x1b_Ga=d,d=I,i=1\x1b\\");
  const closed = writer.close();
  release();
  await closed;
  assert.deepEqual(written, ["\x1b_Ga=d,d=I,i=1\x1b\\"]);
  assert.equal(writer.closed(), true);
});

test("writes after close are refused rather than silently queued forever", () => {
  const { sink, writes } = recordingSink();
  const writer = createPaneWriter({ sink });
  void writer.close();
  assert.equal(writer.write("late"), false);
  assert.deepEqual(writes, []);
});

test("empty and absent payloads are no-ops, not syscalls", () => {
  const { sink, writes } = recordingSink();
  const writer = createPaneWriter({ sink });
  for (const value of ["", null, undefined, Buffer.alloc(0)]) {
    assert.equal(writer.write(value), false);
  }
  assert.deepEqual(writes, []);
});

test("flush on an idle writer resolves without waiting for anything", async () => {
  const { sink } = recordingSink();
  const writer = createPaneWriter({ sink });
  await writer.flush();
});

test("a writer without a sink is a programming error, caught at construction", () => {
  assert.throws(() => createPaneWriter({}), TypeError);
  assert.throws(() => createPaneWriter({ sink: "not a function" }), TypeError);
});

test("a whole buffer is pushed through however many short writes the kernel takes", () => {
  const chunks = [];
  // A pty under back-pressure accepts a prefix. Dropping the remainder would truncate a Kitty
  // escape, which is the same corruption as a tear.
  let call = 0;
  const write = (fd, buffer, offset, length) => {
    call += 1;
    const accepted = call === 1 ? 2 : length;
    chunks.push(buffer.subarray(offset, offset + accepted).toString("binary"));
    return accepted;
  };
  assert.equal(writeFully(write, 7, "abcdef"), 6);
  assert.deepEqual(chunks, ["ab", "cdef"]);
});

test("a descriptor that accepts nothing raises rather than spinning forever", () => {
  assert.throws(() => writeFully(() => 0, 7, "abc"), /short write on fd 7: 0\/3/);
});

test("fdSink is that loop bound to writeSync, and it reaches a real descriptor", () => {
  // Proves the wiring, not the loop: /dev/null is the cheapest descriptor that accepts bytes.
  const fs = require("node:fs");
  const fd = fs.openSync("/dev/null", "w");
  try {
    fdSink(fd)("\x1b_Ga=d,d=I,i=1\x1b\\");
  } finally {
    fs.closeSync(fd);
  }
});

test("channelSink hands whole buffers to the frontend and its promise gates the queue", async () => {
  const sent = [];
  const writer = createPaneWriter({
    sink: channelSink((bytes) => {
      sent.push(bytes.toString("binary"));
      return Promise.resolve();
    }),
  });
  writer.write("frame-one");
  writer.write("frame-two");
  await writer.flush();
  assert.deepEqual(sent, ["frame-one", "frame-two"]);
});
