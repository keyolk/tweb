"use strict";

// The most one tmux passthrough sequence may carry.
//
// tmux buffers an escape sequence until it ends and DISCARDS one that outgrows its input buffer
// — 1MB (`INPUT_BUF_LIMIT`; the `input-buffer-size` option from 3.5) — without a word to anyone.
// A frame file's path never came near that; an inline (`t=d`) whole frame does: measured over SSH
// to a Coder workspace, 2880x1764 PNG frames averaged 741KB of base64, and 4 of 31 never reached
// the terminal (20.7MB written, 15.8MB received, no error anywhere). Kitty already splits a
// payload into `m=1` commands, so the run is cut at command boundaries instead, into passthroughs
// well under the limit.
const TMUX_PASSTHROUGH_MAX = 256 * 1024;

/**
 * Groups complete graphics commands into runs that each fit one passthrough.
 *
 * Never splits a command: a passthrough that ended mid-command would hand tmux half an escape
 * sequence. A single command larger than the cap gets a run of its own — the gfx worker's chunks
 * are 3KB, so that only happens to a caller that did not chunk.
 *
 * @param {string[]} commands each a whole `ESC _ G ... ESC \` sequence
 * @param {number} [max] bytes per run
 * @returns {string[]} the runs, in order, concatenating back to the input
 */
function passthroughRuns(commands, max = TMUX_PASSTHROUGH_MAX) {
  const runs = [];
  let run = "";
  for (const command of commands) {
    if (run && run.length + command.length > max) {
      runs.push(run);
      run = "";
    }
    run += command;
  }
  if (run) runs.push(run);
  return runs;
}

module.exports = { passthroughRuns, TMUX_PASSTHROUGH_MAX };
