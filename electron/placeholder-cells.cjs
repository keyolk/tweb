"use strict";

// Kitty Unicode placeholders: the page as text cells in the pane's own grid.
//
// WHY. The overlay placement (`a=T` at the pane origin) floats above tmux's grid, so tmux does not
// know it is there. Every window switch, popup, pane kill and resize has to be noticed by the engine
// and answered with a delete, and a missed or overtaken delete leaves the page drawn over another
// window. A placeholder is ordinary text: `U+10EEEE` cells whose colour names an image and whose
// combining marks name a row and column of it. tmux stores and redraws those cells like any other,
// so it hides the page on a window switch, covers it with a popup and drops it with the pane.
// Measured on tmux 3.8 + Ghostty 1.4 — FEASIBILITY.md 2.5.
//
// HOW. The image is transmitted with `a=t`, given a virtual placement with `a=p,U=1,c=,r=`, and the
// cells are printed into the pane. The terminal draws the image wherever such cells are.
//
// This file is the encoding only — no terminal, no state — so it is checked without one.

// The row/column diacritics, in order: index N names row (or column) N. From kitty's
// rowcolumn-diacritics.txt (https://sw.kovidgoyal.net/kitty/_downloads/f0a0de9ec8d9ff4456206db8e0814937/rowcolumn-diacritics.txt),
// combining class 230 marks from Unicode 6.0.0 without decompositions. Vendored rather than read
// from a kitty install, which the engine cannot assume.
const DIACRITICS = [
  0x0305, 0x030D, 0x030E, 0x0310, 0x0312, 0x033D, 0x033E, 0x033F, 0x0346, 0x034A,
  0x034B, 0x034C, 0x0350, 0x0351, 0x0352, 0x0357, 0x035B, 0x0363, 0x0364, 0x0365,
  0x0366, 0x0367, 0x0368, 0x0369, 0x036A, 0x036B, 0x036C, 0x036D, 0x036E, 0x036F,
  0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
  0x0598, 0x0599, 0x059C, 0x059D, 0x059E, 0x059F, 0x05A0, 0x05A1, 0x05A8, 0x05A9,
  0x05AB, 0x05AC, 0x05AF, 0x05C4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615,
  0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065A, 0x065B, 0x065D, 0x065E, 0x06D6,
  0x06D7, 0x06D8, 0x06D9, 0x06DA, 0x06DB, 0x06DC, 0x06DF, 0x06E0, 0x06E1, 0x06E2,
  0x06E4, 0x06E7, 0x06E8, 0x06EB, 0x06EC, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736,
  0x073A, 0x073D, 0x073F, 0x0740, 0x0741, 0x0743, 0x0745, 0x0747, 0x0749, 0x074A,
  0x07EB, 0x07EC, 0x07ED, 0x07EE, 0x07EF, 0x07F0, 0x07F1, 0x07F3, 0x0816, 0x0817,
  0x0818, 0x0819, 0x081B, 0x081C, 0x081D, 0x081E, 0x081F, 0x0820, 0x0821, 0x0822,
  0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082A, 0x082B, 0x082C, 0x082D, 0x0951,
  0x0953, 0x0954, 0x0F82, 0x0F83, 0x0F86, 0x0F87, 0x135D, 0x135E, 0x135F, 0x17DD,
  0x193A, 0x1A17, 0x1A75, 0x1A76, 0x1A77, 0x1A78, 0x1A79, 0x1A7A, 0x1A7B, 0x1A7C,
  0x1B6B, 0x1B6D, 0x1B6E, 0x1B6F, 0x1B70, 0x1B71, 0x1B72, 0x1B73, 0x1CD0, 0x1CD1,
  0x1CD2, 0x1CDA, 0x1CDB, 0x1CE0, 0x1DC0, 0x1DC1, 0x1DC3, 0x1DC4, 0x1DC5, 0x1DC6,
  0x1DC7, 0x1DC8, 0x1DC9, 0x1DCB, 0x1DCC, 0x1DD1, 0x1DD2, 0x1DD3, 0x1DD4, 0x1DD5,
  0x1DD6, 0x1DD7, 0x1DD8, 0x1DD9, 0x1DDA, 0x1DDB, 0x1DDC, 0x1DDD, 0x1DDE, 0x1DDF,
  0x1DE0, 0x1DE1, 0x1DE2, 0x1DE3, 0x1DE4, 0x1DE5, 0x1DE6, 0x1DFE, 0x20D0, 0x20D1,
  0x20D4, 0x20D5, 0x20D6, 0x20D7, 0x20DB, 0x20DC, 0x20E1, 0x20E7, 0x20E9, 0x20F0,
  0x2CEF, 0x2CF0, 0x2CF1, 0x2DE0, 0x2DE1, 0x2DE2, 0x2DE3, 0x2DE4, 0x2DE5, 0x2DE6,
  0x2DE7, 0x2DE8, 0x2DE9, 0x2DEA, 0x2DEB, 0x2DEC, 0x2DED, 0x2DEE, 0x2DEF, 0x2DF0,
  0x2DF1, 0x2DF2, 0x2DF3, 0x2DF4, 0x2DF5, 0x2DF6, 0x2DF7, 0x2DF8, 0x2DF9, 0x2DFA,
  0x2DFB, 0x2DFC, 0x2DFD, 0x2DFE, 0x2DFF, 0xA66F, 0xA67C, 0xA67D, 0xA6F0, 0xA6F1,
  0xA8E0, 0xA8E1, 0xA8E2, 0xA8E3, 0xA8E4, 0xA8E5, 0xA8E6, 0xA8E7, 0xA8E8, 0xA8E9,
  0xA8EA, 0xA8EB, 0xA8EC, 0xA8ED, 0xA8EE, 0xA8EF, 0xA8F0, 0xA8F1, 0xAAB0, 0xAAB2,
  0xAAB3, 0xAAB7, 0xAAB8, 0xAABE, 0xAABF, 0xAAC1, 0xFE20, 0xFE21, 0xFE22, 0xFE23,
  0xFE24, 0xFE25, 0xFE26, 0x10A0F, 0x10A38, 0x1D185, 0x1D186, 0x1D187, 0x1D188, 0x1D189,
  0x1D1AA, 0x1D1AB, 0x1D1AC, 0x1D1AD, 0x1D242, 0x1D243, 0x1D244,
];

const PLACEHOLDER = String.fromCodePoint(0x10eeee);
const ESC = "\x1b";

// The id goes in the foreground colour, 24 bits of it; a larger id's top byte goes in a third
// diacritic. Every pane's ids are at or above 2^29 (crates/tweb-pane/src/image_id.rs), so the
// third mark is always present in practice — measured to draw on Ghostty 1.4.
function idColour(id) {
  return `${ESC}[38;2;${(id >> 16) & 0xff};${(id >> 8) & 0xff};${id & 0xff}m`;
}

function highByteMark(id) {
  const high = Math.floor(id / 0x1000000) & 0xff;
  return high === 0 ? "" : String.fromCodePoint(DIACRITICS[high]);
}

/** The most rows a placement can address: one per diacritic. Columns are not limited — see below. */
const MAX_ROWS = DIACRITICS.length;

/**
 * The text that draws image `id` into a `rows` x `cols` block whose top-left is pane cell
 * (`top`, `left`), 1-based. `rowOffset`/`colOffset` say which cell of the image the block starts
 * at, so a patch's own cells start at 0 whatever pane cell they sit on.
 *
 * Every cell carries its own row, column and id marks. The protocol lets a bare placeholder
 * continue from its left neighbour, which is a third of the bytes, but that neighbour is the one on
 * the TERMINAL's screen, not in tmux's grid: tmux redraws a row from the right edge of a popup, the
 * first cell it sends has a popup character to its left, and the rest of the row drew nothing —
 * measured on Ghostty 1.4, a black band across the page beside every popup. Columns past the 297
 * the table can name are the exception and do inherit, so a very wide pane keeps that defect at
 * its right end only.
 *
 * Autowrap is turned off around the block: a row that ends on the pane's last column must not
 * wrap the cursor onto the next line. The cursor and the attributes are saved and restored, so the
 * caret the engine parks on the page is not moved by drawing it.
 */
function placeholderBlock(id, { rows, cols, top = 1, left = 1, rowOffset = 0, colOffset = 0 }) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`placeholder: bad image id ${id}`);
  if (rows <= 0 || cols <= 0) return "";
  if (rowOffset + rows > MAX_ROWS) throw new Error(`placeholder: ${rowOffset + rows} rows > ${MAX_ROWS}`);
  if (colOffset >= DIACRITICS.length) throw new Error(`placeholder: column offset ${colOffset}`);
  const high = highByteMark(id);
  const named = Math.min(cols, DIACRITICS.length - colOffset);
  // The columns are the same on every row, so they are built once.
  let columns = "";
  for (let x = 0; x < named; x += 1) {
    columns += `\u0000${String.fromCodePoint(DIACRITICS[colOffset + x])}${high}`;
  }
  const rest = PLACEHOLDER.repeat(cols - named);
  let out = `${ESC}7${ESC}[?7l${idColour(id)}`;
  for (let y = 0; y < rows; y += 1) {
    const rowCells = columns.split("\u0000").join(`${PLACEHOLDER}${String.fromCodePoint(DIACRITICS[rowOffset + y])}`);
    out += `${ESC}[${top + y};${left}H${rowCells}${rest}`;
  }
  return `${out}${ESC}[39m${ESC}[?7h${ESC}8`;
}

/** The virtual placement the cells refer to: `c`/`r` cells, scaled into them by the terminal. */
function virtualPlacement(id, { rows, cols }) {
  return `a=p,U=1,i=${id},c=${cols},r=${rows},q=2`;
}

module.exports = {
  DIACRITICS, PLACEHOLDER, MAX_ROWS, placeholderBlock, virtualPlacement, idColour, highByteMark,
};

// Whether a pane draws through placeholders. Decided like relative patches (relative-placement.cjs)
// and for the same reason: every graphics command carries `q=2`, so a terminal that cannot draw a
// placeholder says nothing and the pane is simply blank. Only a terminal it was measured on.
//
// Only inside tmux. Outside it there is no window to switch, no popup and no other pane, so the
// overlay has nothing to get wrong, and placeholders would only cost the cell text.
const { parseVersion } = require("./relative-placement.cjs");

const MIN_GHOSTTY = [1, 4, 0];

function atLeast(version, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

/**
 * @param {object} env
 * @param {boolean} env.inTmux whether the pane's bytes go through tmux
 * @param {string} [env.clientTermtype] tmux `#{client_termtype}`, the outer terminal's XTVERSION
 * @param {boolean} [env.remote] the terminal is on another machine (`$TWEB_REMOTE_TERMINAL`)
 * @param {string} [env.override] `$TWEB_PLACEHOLDERS`: "0" forces off, "1" forces on
 * @returns {{ allowed: boolean, reason: string }}
 */
function placeholdersDecision({ inTmux, clientTermtype, remote = false, override } = {}) {
  if (override === "0") return { allowed: false, reason: "TWEB_PLACEHOLDERS=0" };
  if (!inTmux) return { allowed: false, reason: "not in tmux" };
  if (override === "1") return { allowed: true, reason: "TWEB_PLACEHOLDERS=1" };
  // Over SSH a remote frame is chunked inline, so it alternates between two ids, and each flip
  // renames every cell: the cells were 103KB of a 123KB frame, 84% of the link, and the remote
  // tmux server spent 30.6% CPU parsing them (tmux 3.6, 200x50 pane, 30fps page, against 20KB and
  // 0.4% with the overlay; measured 2026-11-12). Until a whole frame can be replaced under one id
  // without a blank (FEASIBILITY.md 2.5), a remote pane keeps the overlay.
  if (remote) return { allowed: false, reason: "remote terminal" };
  const name = clientTermtype || "";
  if (!/ghostty/i.test(name)) return { allowed: false, reason: `not ghostty (${name || "unknown"})` };
  const version = parseVersion(name);
  if (!version) return { allowed: false, reason: "ghostty version unknown" };
  const shown = version.join(".");
  return atLeast(version, MIN_GHOSTTY)
    ? { allowed: true, reason: `ghostty ${shown}` }
    : { allowed: false, reason: `ghostty ${shown} < ${MIN_GHOSTTY.join(".")}` };
}

module.exports.placeholdersDecision = placeholdersDecision;
