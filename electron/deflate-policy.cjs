"use strict";

// Whether whole frames may be sent to this terminal as `o=z`.
//
// WHY THIS EXISTS. Ghostty 1.3.1 aborts inside its Kitty graphics zlib inflater, and the abort
// takes the whole application down — every window, every tab, every pane, with no crash dialog.
// From the user's side the terminal simply vanishes mid-session.
//
// The evidence, from this machine's own `~/.local/state/ghostty/crash`:
//
//   - 13 crash reports, all Ghostty 1.3.1, all with the identical faulting symbol
//     `Io.Writer.unreachableRebase` — a Zig `std.Io.Writer` panic reached from
//     `compress.flate.Decompress.streamInner`, which is the inflater `o=z` feeds.
//   - The first of them is 2026-08-18T10:50Z. `o=z` shipped in #41 THAT DAY.
//   - The two crashes before that date are Ghostty 1.2.3 with a different signature, so this is
//     not a terminal that was crashing anyway.
//
// So the `o=z` comment in gfx-worker.cjs — that Ghostty 1.3.1 was verified to accept a valid
// deflate stream — held for the stream it was tested with and not for the 5MB ones a real page
// produces. Accepting a payload and surviving every payload are different claims.
//
// WHY A NAME RATHER THAN A PROBE. The sequence carries `q=2`, so the terminal cannot answer, and
// the failure mode is not a rejected frame that something could notice and fall back from — it is
// the terminal dying. There is nothing left to report the result to. A name is a weaker signal
// than a probe and it is the only one available before the damage is done.
//
// This is a Ghostty bug and the deflate path is not wrong; it is turned off for the terminal that
// cannot survive it, and stays on for kitty, where it was measured and where it pays.
const CRASHES_ON_DEFLATED_FRAMES = [/ghostty/i];

/**
 * @param {object} env
 * @param {string} [env.clientTermname] `#{client_termname}` from tmux — the ATTACHED client's
 *   real TERM. Inside tmux this is the only honest answer: tmux overwrites `TERM` and
 *   `TERM_PROGRAM` in the process environment with its own.
 * @param {string} [env.term] `$TERM`, for a pane that is not inside tmux.
 * @param {string} [env.termProgram] `$TERM_PROGRAM`, same.
 * @param {string} [env.override] `$TWEB_DEFLATE_FRAMES`: "0" forces off, "1" forces on.
 */
function deflateFramesAllowed({ clientTermname, term, termProgram, override } = {}) {
  if (override === "0") return false;
  // Forcing it on is how someone tests a fixed Ghostty without waiting for this list to catch up,
  // and how the measurements in gfx-worker.cjs get re-run on a terminal named here.
  if (override === "1") return true;
  const names = [clientTermname, term, termProgram].filter(Boolean).join(" ");
  // An unknown terminal keeps the deflate path: it is the measured default, and the one terminal
  // known to die on it is named. Guessing the other way would cost every other terminal the
  // dropped frames #41 removed.
  return !CRASHES_ON_DEFLATED_FRAMES.some((pattern) => pattern.test(names));
}

module.exports = { deflateFramesAllowed, CRASHES_ON_DEFLATED_FRAMES };
