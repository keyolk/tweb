"use strict";

// The exit path, and why it needs its own module.
//
// `before-quit` is the only place the engine takes its image off the terminal, restores the cursor
// shape and the pane title, and drops its frame files. A throw out of that listener is contained by
// nothing: Electron may cancel the quit outright, leaving the process running with its window up,
// its image still placed and its frame file on disk — observed as an orphaned engine that logged
// "owner is gone, quitting" and then lived on at ppid=1 over somebody's live pane. Where the quit
// does survive the throw, every step after the throwing one is skipped instead, silently. Both were
// measured; on this Electron build the second is what reproduces, and it is no better: one dead
// identifier in the frame-file enumeration cut the teardown from 532 bytes to 413, so the image
// deletes and the cursor-shape restore never ran and nothing said why.
//
// So no single step may be trusted with the whole teardown. Each one runs guarded and the failure
// is logged rather than swallowed: the cost of a step that silently did nothing is a stranded page
// on somebody's terminal, which is invisible from inside the process.
//
// Kept out of `main.cjs` because that file cannot be required from a test — it pulls in `electron`.
// The two things worth testing here are pure: which files a set of panes owns, and that one
// throwing step cannot stop the rest.

const { paneFrameFileNames } = require("./pane-registry.cjs");

/**
 * The frame file names a set of panes owns, deduplicated by image id.
 *
 * Every live pane, not one process-wide pair. A host serves N panes and each has its own frame
 * file; enumerating only one of them leaves N-1 files behind at up to 20MB each, and did — the
 * shape this replaced could not have deleted more than one no matter how many panes existed.
 *
 * Records are taken as a plain list so the caller decides what "live" means: the registry's panes,
 * plus the sole pane, which is attached to the registry on the default path and not on the hosted
 * one. Passing both is correct and cheap — the id set means naming a pane twice costs nothing, while
 * forgetting it leaks.
 *
 * @param {Array<{imageId?: number}|null|undefined>} records the panes to collect for
 * @param {number} pid the engine that wrote the files — the pid stays in the name because that is
 *   what `orphan-watch.cjs` collects a dead engine's leftovers by
 * @returns {string[]} file names to remove, empty when nothing is identifiable
 */
function paneFrameFileList(records, pid) {
  const ids = new Set();
  for (const record of records || []) {
    const id = Number(record?.imageId);
    // Positive rather than merely an integer: `Number(null)` is 0, an id no pane owns.
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids].flatMap((id) => paneFrameFileNames(pid, id));
}

/**
 * Runs one teardown step so that its failure cannot become the process's failure.
 *
 * Logged, never swallowed. A step that quietly did nothing means an image left drawn on a real
 * terminal or a title never restored, and nothing inside the process can observe either.
 *
 * @param {string} label what this step does, for the log line
 * @param {() => void} step the work
 * @param {(message: string) => void} [log] where the failure goes
 * @returns {boolean} true when the step completed
 */
function runTeardownStep(label, step, log = console.error) {
  try {
    step();
    return true;
  } catch (error) {
    // The stack, not just the message: a dead identifier reads as `x is not defined` with no
    // indication of which of a dozen steps named it. The stack is what turned this class of
    // failure from "the engine does not exit" into one line and one call site.
    log(`tweb: teardown step "${label}" failed: ${error && error.stack ? error.stack : error}`);
    return false;
  }
}

/**
 * Runs every teardown step, guarded, in order.
 *
 * Every step is attempted even after one fails, because they are independent effects on different
 * surfaces — the terminal's image, the cursor shape, the pane title, the frame files on disk — and
 * skipping the rest because the first threw is what left all of them undone.
 *
 * @param {Array<[string, () => void]>} steps label/work pairs
 * @param {(message: string) => void} [log] where failures go
 * @returns {number} how many steps failed
 */
function runTeardown(steps, log = console.error) {
  let failed = 0;
  for (const [label, step] of steps || []) {
    if (!runTeardownStep(label, step, log)) failed += 1;
  }
  return failed;
}

module.exports = { paneFrameFileList, runTeardownStep, runTeardown };
