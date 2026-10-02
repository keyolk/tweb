"use strict";

// Damage geometry for the patch frame path.
//
// Three coordinate systems meet here, and the whole point of this module is that they only
// have to be reconciled once:
//
//   - A `paint` dirty rect and `NativeImage.crop` are both in the frame's own pixels. The
//     frame is rendered at the device scale factor, so these are device pixels, not DIP —
//     measured directly: a 637x189 DIP window at 2x reports a 1274x378 frame and a
//     whole-frame dirty rect of exactly those dimensions.
//   - A Kitty placement is anchored to whole terminal cells.
//   - The terminal scales the image into the cell box it is given (`C=1,c=,r=`), so the
//     mapping between the two is the frame's own size over the pane's cell grid — not the
//     pane's pixel size, which can differ from the frame's by a rounding step.
//
// The crop rect and the placement rect have to come out of the *same* rounding. A half-cell
// disagreement between them shifts the patch on screen by up to a cell, which reads as a
// smear that only appears while typing. So both come from one function.

// How much of the pane a patch may cover before the whole-frame path takes over.
//
// This was 0.2, on the reasoning that damage is bimodal — a caret is ~0.03% of the pane, a
// scroll is 100% — so nothing real would land near the threshold. That holds for a page of
// text. It does NOT hold for a page with two live regions far apart: Chromium reports ONE
// damage rect per paint, so a video tile on the left and a panel on the right arrive as the
// box that contains both. Measured on a Google Meet call with the add-on panel open, 258 of
// 331 paints reported exactly `123,102 2631x1480` — 75.1% of the pane, which is neither
// region but the span between them. Every one of those fell back to a whole frame, which is
// why that call ran at `whole: 287, patches: 6` while YouTube on the same pane managed 25.
//
// A whole frame is raw pixels; a patch is PNG. So the comparison that decides this is bytes,
// not area, and at that size the two are nothing alike — measured on the same call:
//
//     whole frame         20.7 MB   (2880x1800x4, uncompressed)
//     75.1% patch          2.8 MB   (PNG, 346x88 cells)      14% of a whole frame
//
// 86% fewer bytes for the same picture. At the 8fps playback floor that is 166 MB/s against
// 22 MB/s, against a 60 MB/s budget — the old limit was spending nearly three times the
// budget to avoid a patch that costs a third of it.
//
// AND YET IT IS 0.2, because bytes are not the only cost. `toPNG()` is SYNCHRONOUS and runs on
// the main thread, and the encode scales with the area it is given. Raising the limit to 0.85
// and measuring the encode directly:
//
//                        encode p50   encode p90   paint gap p90   paint gap max
//     limit 0.85             15ms        422ms          239ms          8453ms
//     limit 0.2              23ms         24ms          150ms          2477ms
//
// A 422ms encode is 422ms during which no other frame can go out, so the pane stalls for longer
// than the bytes it saved would ever have taken to send. The user reported it as a severe frame
// drop, which is exactly what those numbers are.
//
// So the band stays closed until a patch that large can be encoded OFF the main thread. The
// byte argument above is still correct and still worth acting on — it is the encoder, not the
// comparison, that has to change first. The override is left in place so the measurement can be
// repeated: `TWEB_PATCH_AREA_LIMIT=0.85`.
const PATCH_AREA_LIMIT = Number.parseFloat(process.env.TWEB_PATCH_AREA_LIMIT || "") || 0.2;

// Damage this small still costs a whole placement command, so it is not worth a patch of
// its own; it is also what a sub-pixel caret artifact looks like.
const MIN_PATCH_CELLS = 1;

/**
 * Maps a dirty rect onto the cell grid, rounding outward so the patch always covers at
 * least the damage.
 *
 * @param {{x: number, y: number, width: number, height: number}} dirty damage, in frame pixels
 * @param {{cols: number, rows: number}} cells the pane's cell grid
 * @param {{width: number, height: number}} frameSize the frame, in pixels
 * @returns {{
 *   crop: {x: number, y: number, width: number, height: number},
 *   place: {col: number, row: number, cols: number, rows: number},
 * } | null} null when the damage should go down the whole-frame path instead
 */
function patchGeometry(dirty, cells, frameSize) {
  if (!dirty || !cells || !frameSize) return null;
  if (!(cells.cols > 0 && cells.rows > 0)) return null;
  if (!(frameSize.width > 0 && frameSize.height > 0)) return null;
  if (!(dirty.width > 0 && dirty.height > 0)) return null;

  const cellWidth = frameSize.width / cells.cols;
  const cellHeight = frameSize.height / cells.rows;
  if (!(cellWidth > 0 && cellHeight > 0)) return null;

  // Round outward: a patch that covers slightly more than the damage is correct, one that
  // covers slightly less leaves a stale sliver behind.
  const col0 = Math.max(0, Math.floor(dirty.x / cellWidth));
  const row0 = Math.max(0, Math.floor(dirty.y / cellHeight));
  const col1 = Math.min(cells.cols, Math.ceil((dirty.x + dirty.width) / cellWidth));
  const row1 = Math.min(cells.rows, Math.ceil((dirty.y + dirty.height) / cellHeight));

  const cols = col1 - col0;
  const rows = row1 - row0;
  if (cols < MIN_PATCH_CELLS || rows < MIN_PATCH_CELLS) return null;
  if (cols >= cells.cols && rows >= cells.rows) return null;
  if ((cols * rows) / (cells.cols * cells.rows) > PATCH_AREA_LIMIT) return null;

  // The crop is cut on the same cell boundary the placement is anchored to, so the pixels
  // and the cells they are placed into describe the same region.
  const cropX = Math.round(col0 * cellWidth);
  const cropY = Math.round(row0 * cellHeight);
  const cropWidth = Math.round(col1 * cellWidth) - cropX;
  const cropHeight = Math.round(row1 * cellHeight) - cropY;
  if (cropWidth <= 0 || cropHeight <= 0) return null;

  return {
    crop: { x: cropX, y: cropY, width: cropWidth, height: cropHeight },
    // Cells are 0-based here; `patchCursorMove` turns them into terminal motion.
    place: { col: col0, row: row0, cols, rows },
  };
}

/**
 * Grows a damage rect to cover everything patched since the last whole frame.
 *
 * Patches accumulate: each one covers the region under it, but nothing restores what an
 * earlier, larger patch painted outside the current one. Typing lays down a wide patch,
 * backspacing lays down a narrower one, and the character that was deleted survives in the
 * strip the new patch does not reach — visible as text that will not go away.
 *
 * Carrying the union forward fixes that at its source: every patch repaints the full extent
 * of the damage since the base frame, so a shrinking sequence still covers its own history.
 * The whole-frame path resets it, because that frame is correct everywhere.
 *
 * @param {{x: number, y: number, width: number, height: number}} dirty this frame's damage
 * @param {{x: number, y: number, width: number, height: number} | null} previous accumulated damage
 * @returns {{x: number, y: number, width: number, height: number}} the union of the two
 */
function unionDamage(dirty, previous) {
  if (!previous) return { ...dirty };
  const left = Math.min(dirty.x, previous.x);
  const top = Math.min(dirty.y, previous.y);
  const right = Math.max(dirty.x + dirty.width, previous.x + previous.width);
  const bottom = Math.max(dirty.y + dirty.height, previous.y + previous.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Terminal motion that puts the cursor on a patch's cell.
 *
 * Placement follows the cursor, so a patch has to move it to its own cell before the
 * graphics command and leave it where it was found afterwards.
 *
 * The move is absolute, computed against the pane's origin on screen. Relative motion looks
 * like the natural fit — the tmux passthrough wrapper has already parked the cursor at that
 * origin — but `CUD` stops at the last row of the *terminal*, not of the pane. A pane low on
 * a tall screen therefore has patches pile up along the bottom edge, drawn over whatever
 * pane happens to be there. An absolute address cannot walk off the end that way, and it is
 * clamped here as well so a patch can never be addressed outside its own pane.
 *
 * The cursor is restored by moving it back rather than with DECSC/DECRC: the passthrough
 * wrapper already holds the terminal's single save slot.
 *
 * @param {{col: number, row: number}} place patch position, in cells from the pane origin
 * @param {{left: number, top: number} | null} origin the pane's own position on screen
 * @param {{cols: number, rows: number}} cells the pane's cell grid, for clamping
 * @returns {{prefix: string, suffix: string}} motion to emit before and after the graphics
 */
function patchCursorMove(place, origin, cells, esc = "\x1b") {
  const left = Math.max(0, Math.trunc(origin?.left ?? 0));
  const top = Math.max(0, Math.trunc(origin?.top ?? 0));
  const maxCol = Math.max(0, (cells?.cols ?? 1) - 1);
  const maxRow = Math.max(0, (cells?.rows ?? 1) - 1);
  const col = Math.min(maxCol, Math.max(0, Math.trunc(place?.col ?? 0)));
  const row = Math.min(maxRow, Math.max(0, Math.trunc(place?.row ?? 0)));
  return {
    // Terminal addressing is 1-based.
    prefix: `${esc}[${top + row + 1};${left + col + 1}H`,
    // Back to the pane origin, which is where the wrapper left the cursor.
    suffix: `${esc}[${top + 1};${left + 1}H`,
  };
}

module.exports = { patchGeometry, patchCursorMove, unionDamage, PATCH_AREA_LIMIT, MIN_PATCH_CELLS };
