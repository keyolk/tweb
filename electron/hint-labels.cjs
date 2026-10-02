"use strict";

// Hint labels, shared out between the frames that draw them.
//
// WHY THIS EXISTS. `f` collects its targets inside ONE frame — the badges are positioned in
// that frame's own coordinates, and a cross-origin frame's contents are unreachable from the
// parent by construction. So a page with an embedded app used to hint the frame itself as a
// single target: pick it, then press `f` again to hint what is inside. Two steps for one
// intention, and the first step shows a badge over a panel rather than over its buttons.
//
// Every frame can draw its own badges at the same time instead. What stops that is the labels:
// two frames each numbering from zero both produce "a", and a keystroke would be ambiguous. So
// the labels are shared out — each frame is told where its block starts, and numbers from
// there. One keystroke then names exactly one target, in exactly one frame.
//
// The engine is the only party that can do the sharing: it alone sees every frame. It asks each
// frame how many targets it has, adds them up in a fixed order, and hands each frame its offset.

/** The alphabet labels are built from. Home row first, so the common cases are easiest to type. */
const HINT_ALPHABET = "asdfghjklqwertyuiopzxcvbnm";

/**
 * The label for one index, in a space of `total` labels.
 *
 * Width is chosen for the whole space rather than per block, so every label in a round is the
 * same length — otherwise "a" and "ab" would both be live and the first keystroke ambiguous.
 *
 * @param {number} index position in the shared space
 * @param {number} total how many labels the space holds
 * @returns {string}
 */
function hintLabel(index, total) {
  let width = 1;
  while (HINT_ALPHABET.length ** width < Math.max(1, total)) width += 1;
  let value = index;
  let label = "";
  for (let position = 0; position < width; position += 1) {
    label = HINT_ALPHABET[value % HINT_ALPHABET.length] + label;
    value = Math.floor(value / HINT_ALPHABET.length);
  }
  return label.padStart(width, HINT_ALPHABET[0]);
}

/**
 * Where each frame's block of labels begins.
 *
 * @param {{key: string, count: number}[]} frames in the order they should be numbered
 * @returns {{total: number, offsets: Record<string, number>}}
 */
function shareLabels(frames) {
  const offsets = {};
  let total = 0;
  for (const frame of frames) {
    const count = Number.isFinite(frame?.count) ? Math.max(0, Math.trunc(frame.count)) : 0;
    offsets[frame.key] = total;
    total += count;
  }
  return { total, offsets };
}

module.exports = { HINT_ALPHABET, hintLabel, shareLabels };
