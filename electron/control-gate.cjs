"use strict";

// Control lines that arrive before the app is ready, held until it is.
//
// The stdin handler is installed while main.cjs loads, long before `app.whenReady()`, and a
// RESIZE handled that early reaches `screen` through `renderScaleFactor`: "The 'screen' module
// can't be used before the app 'ready' event". Thrown from a stdin callback it is an uncaught
// exception, which Electron answers with a modal error dialog in the main process — the engine
// then sits there with no log line and no agent socket, measured from a frontend that wrote
// RESIZE right after spawning it. A person resizing the pane in tweb's first second hits the
// same path. So lines are queued, in order, and handed on once the gate opens.
//
// Lines, not chunks: a chunk can end mid-line, and the partial tail belongs to the next one.

function createControlGate(onLine) {
  let buffer = "";
  let open = false;
  const held = [];

  function deliver(line) {
    if (open) onLine(line);
    else held.push(line);
  }

  return {
    push(chunk) {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        deliver(line);
      }
    },
    open() {
      if (open) return;
      open = true;
      // Drained one at a time from the front: a line handled here may push more (it never
      // does today), and those must land after the ones already waiting.
      while (held.length) onLine(held.shift());
    },
    get heldCount() {
      return held.length;
    },
  };
}

module.exports = { createControlGate };
