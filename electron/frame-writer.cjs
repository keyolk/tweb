"use strict";

// One serialising writer per pane tty.
//
// Two concurrent writers to a single pane tore roughly one frame in 750 under realistic
// contention — realistic meaning a caret sequence after every frame, which is what the engine
// actually does. A torn frame is not a dropped frame: the terminal reads a Kitty escape whose
// payload is spliced with someone else's bytes and leaves a corrupted placement on screen.
//
// The tear does not go away by moving into one process. A single Electron hosting N panes has
// exactly the same hazard the moment two panes share a tty, or the moment a frame write and a
// caret write to the same pane interleave across an await. So egress is funnelled here: every
// byte destined for a pane's terminal — graphics, caret parking, the image delete on exit —
// goes through that pane's writer, and the writer never lets a second write start while one is
// in flight.
//
// The sink is injected because where the bytes actually go is a separate decision from how they
// are serialised: `fdSink` writes to a descriptor (inherited stdout today, a pane tty opened by
// name under a shared runtime), while `channelSink` hands them to the frontend to put on its own
// pty. Swapping one for the other is a call-site change and nothing else.

const { writeSync } = require("node:fs");

/**
 * Pushes a whole buffer through a write syscall that is allowed to accept only part of it.
 *
 * A pty under back-pressure does exactly that, and stopping at the first short write would
 * truncate a Kitty escape mid-payload — the same corruption as a tear, arrived at differently.
 * The syscall is a parameter so this stays decidable without a live descriptor.
 *
 * @param {(fd: number, buffer: Buffer, offset: number, length: number) => number} write
 */
function writeFully(write, fd, bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "binary");
  let offset = 0;
  while (offset < buffer.length) {
    const written = write(fd, buffer, offset, buffer.length - offset);
    // A zero-length write with no error would spin forever. Treat it as the descriptor refusing
    // the rest and let the caller's error path decide.
    if (!(written > 0)) throw new Error(`short write on fd ${fd}: ${offset}/${buffer.length}`);
    offset += written;
  }
  return buffer.length;
}

/**
 * A synchronous sink over a file descriptor.
 *
 * Synchronous on purpose, and this is the load-bearing property rather than an optimisation:
 * `process.on("exit")` writes the Kitty delete that removes this pane's image from the terminal,
 * and an exit handler cannot await anything. A queue that deferred to the next tick would drop
 * that delete and strand the image. Being synchronous also keeps the shipping path byte-identical
 * in timing to the `writeSync(1, ...)` calls it replaces.
 */
function fdSink(fd) {
  return (bytes) => { writeFully(writeSync, fd, bytes); };
}

/**
 * A sink that hands bytes to someone else's pty.
 *
 * `send` may return a promise; the queue below is what guarantees the next chunk does not start
 * until it settles, which is the whole reason this can be asynchronous where `fdSink` cannot.
 */
function channelSink(send) {
  return (bytes) => send(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "binary"));
}

/**
 * Creates the single writer for one pane tty.
 *
 * @param {{sink: (bytes: Buffer) => void|Promise<void>, onError?: (error: Error) => void}} options
 * @returns {{write: Function, flush: Function, close: Function, pending: Function, closed: Function}}
 */
function createPaneWriter({ sink, onError = () => {} }) {
  if (typeof sink !== "function") throw new TypeError("createPaneWriter needs a sink function");
  const queue = [];
  let draining = false;
  let closed = false;
  let idleWaiters = [];

  function settleIdle() {
    if (draining || queue.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // Bytes are handed to the sink one chunk at a time, never concatenated across chunks. A Kitty
  // escape is only atomic if it reaches the terminal as the contiguous run its author wrote, and
  // merging two callers' chunks to save a syscall would be the tear this module exists to prevent.
  function drain() {
    if (draining) return;
    draining = true;
    for (;;) {
      const chunk = queue.shift();
      if (chunk === undefined) break;
      let result;
      try {
        result = sink(chunk);
      } catch (error) {
        onError(error);
        continue;
      }
      if (result && typeof result.then === "function") {
        // An asynchronous sink parks the loop here. `draining` stays true, so a `write` arriving
        // meanwhile only enqueues — it can never overtake the chunk in flight.
        result.then(
          () => {
            draining = false;
            drain();
          },
          (error) => {
            onError(error);
            draining = false;
            drain();
          }
        );
        return;
      }
    }
    draining = false;
    settleIdle();
  }

  return {
    /**
     * Enqueues one contiguous run of bytes and drains as far as the sink allows.
     *
     * With a synchronous sink and an empty queue this writes inline, so a caller that relies on
     * the bytes having left before it returns — the exit handler — still gets that.
     */
    write(bytes) {
      if (closed) return false;
      if (bytes === undefined || bytes === null) return false;
      const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "binary");
      if (chunk.length === 0) return false;
      queue.push(chunk);
      drain();
      return true;
    },

    /** Resolves once everything queued so far has reached the sink. */
    flush() {
      if (!draining && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },

    /**
     * Stops accepting writes. Anything already queued still drains, because the queued bytes are
     * usually the pane's own image delete and dropping them would strand the placement.
     */
    close() {
      closed = true;
      return this.flush();
    },

    pending() {
      return queue.length + (draining ? 1 : 0);
    },

    closed() {
      return closed;
    },
  };
}

module.exports = { createPaneWriter, fdSink, channelSink, writeFully };
