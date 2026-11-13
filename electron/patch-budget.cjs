"use strict";

// How many encoded bytes the immediate patch path may write, decided per patch.
//
// WHY A BUDGET AND NOT A CAP. The immediate path writes synchronously on the main thread, unpaced,
// so a stream of large patches can fill the tty and block the engine in `write()` — a Google Meet
// whiteboard did, with 360-430KB patches back to back (page-input.test.cjs). A flat 64KB cap
// stopped that, and also sent every larger single patch to the whole-frame path. Inside tmux that
// path is a 2880x1800 frame, 20MB of pixels, for what changed in a corner: the command palette (`c`)
// encodes to ~135KB at that size, so opening it and moving through it went out as whole frames,
// and on the Chrome engine, where one key paints two or three times (screencast, then the settle
// capture), most of its keys did (measured with bench/feel.py --tmux).
//
// What blocked the thread was the RATE, not one patch. So one patch of up to SINGLE_MAX goes, as
// long as the patches written in the last WINDOW_MS stay under WINDOW_MAX: a menu opening or a
// selection moving is a patch now and then, a whiteboard stroke is a stream and still goes paced.

const BASE_MAX = 64 * 1024;
const SINGLE_MAX = 256 * 1024;
const WINDOW_MS = 250;
const WINDOW_MAX = 512 * 1024;

function createPatchBudget({ now = () => Date.now() } = {}) {
  const sent = [];
  function prune(at) {
    while (sent.length && at - sent[0].at >= WINDOW_MS) sent.shift();
  }
  return {
    /** Whether a patch of `bytes` may go out now. A caret-sized patch always may. */
    allows(bytes) {
      if (bytes <= BASE_MAX) return true;
      if (bytes > SINGLE_MAX) return false;
      const at = now();
      prune(at);
      const recent = sent.reduce((total, entry) => total + entry.bytes, 0);
      return recent + bytes <= WINDOW_MAX;
    },
    /** Records a patch that was written. */
    note(bytes) {
      const at = now();
      prune(at);
      sent.push({ at, bytes });
    },
  };
}

module.exports = { createPatchBudget, BASE_MAX, SINGLE_MAX, WINDOW_MS, WINDOW_MAX };
