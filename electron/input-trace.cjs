"use strict";

// What a keypress did, with times, for `bench/feel.py`.
//
// `f` sometimes showing nothing, and keys sometimes feeling slow, are felt in seconds and lost in
// seconds: by the time anyone runs `tweb diag`, the round that drew nothing is gone. The engine
// log does not keep the facts either — ordinary keys are not logged, and `frame sent` stops after
// twelve. So with `TWEB_INPUT_TRACE=<file>` the engine appends one JSON line per step a key passes
// through, and the harness replays keys and reads the steps back:
//
//   in     bytes arrived on the control channel        { hex }
//   round  `f` opened a hint round                     { id, asked, frames }
//   count  a frame answered with its target count      { id, count, main }
//   space  the round closed and labels were handed out { id, total }
//   end    the round ended                             { id, reason }
//   frame  a whole frame or a patch went to the terminal { kind, bytes }
//
// Off unless set, like TWEB_FRAME_PROBE: the steps that matter are a few milliseconds apart, and a
// trace that is always on would show up in its own numbers. Writes are synchronous so a line is on
// disk before the next key is read — the harness reads the file while the engine still runs.

const fs = require("node:fs");

function createInputTrace(target = process.env.TWEB_INPUT_TRACE, { now = () => performance.timeOrigin + performance.now() } = {}) {
  if (!target) return { enabled: false, mark() {} };
  let fd = null;
  try {
    fd = fs.openSync(target, "a");
  } catch (error) {
    console.error(`tweb: input trace disabled, cannot open ${target}: ${error.message}`);
    return { enabled: false, mark() {} };
  }
  return {
    enabled: true,
    mark(step, fields = {}) {
      try {
        fs.writeSync(fd, `${JSON.stringify({ t: Number(now().toFixed(3)), step, ...fields })}\n`);
      } catch {
        // A full disk must not take the pane down with it; the trace is a diagnostic.
      }
    },
  };
}

module.exports = { createInputTrace };
