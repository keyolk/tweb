"use strict";

// Leaving a hole in the page where a tmux floating pane sits over it.
//
// The page is a Kitty graphics placement, and the terminal composites placements above the cell
// grid. A tmux 3.8 floating pane is cells, so one opened over a tweb pane is drawn UNDER the page
// and cannot be seen. The frontend works out which of this pane's cells a float covers
// (crates/tweb-pane/src/occlusion.rs) and sends them as `OCC <col>,<row>,<cols>,<rows> ...`. The
// engine makes those pixels of every whole frame fully transparent, so the terminal shows the cells
// beneath — the floating pane — through them.
//
// WHY TRANSPARENT PIXELS AND NOT SOURCE-RECT PLACEMENTS. Kitty can show part of an image, so the
// uncovered L-shape could be several placements of one image. But damage patches are placed
// relative to THE base placement, and one placement split into several has no single parent; every
// patch would need splitting too. A transparent pixel is already proven on this path: a transparent
// tab's clear pixels show what is underneath (see `transparentTabs`), so the terminal side needs
// nothing new. The patch side stays simple: a patch that touches a covered cell is declined and the
// damage goes out as a whole frame, which is masked.
//
// Coordinates are cells from the pane's top-left. They are turned into frame pixels against the
// frame's own size, not the pane's, for the same reason patch-geometry.cjs does: the terminal
// scales the frame into the pane's cell box, so a cell is `width / cols` FRAME pixels wide.

const RECT = /^(\d+),(\d+),(\d+),(\d+)$/;

/**
 * The rects of an `OCC` line's body (everything after `OCC`). Null when any rect is malformed:
 * a half-understood line must not punch a hole in the wrong place.
 *
 * @returns {Array<{col:number,row:number,cols:number,rows:number}>|null}
 */
function parseOcclusionRects(body) {
  const tokens = String(body ?? "").trim().split(/\s+/).filter(Boolean);
  const rects = [];
  for (const token of tokens) {
    const match = RECT.exec(token);
    if (!match) return null;
    const rect = { col: Number(match[1]), row: Number(match[2]), cols: Number(match[3]), rows: Number(match[4]) };
    if (rect.cols > 0 && rect.rows > 0) rects.push(rect);
  }
  return rects;
}

function sameRects(a, b) {
  const left = a || [];
  const right = b || [];
  if (left.length !== right.length) return false;
  return left.every((rect, i) => rect.col === right[i].col && rect.row === right[i].row
    && rect.cols === right[i].cols && rect.rows === right[i].rows);
}

/**
 * Cell rects to frame-pixel rects, rounded OUTWARD so a float's edge cell is never left half
 * covered by the page.
 */
function pixelRects(rects, cells, size) {
  if (!rects?.length || !cells?.cols || !cells?.rows || !size?.width || !size?.height) return [];
  const cellWidth = size.width / cells.cols;
  const cellHeight = size.height / cells.rows;
  const out = [];
  for (const rect of rects) {
    const x = Math.max(0, Math.floor(rect.col * cellWidth));
    const y = Math.max(0, Math.floor(rect.row * cellHeight));
    const right = Math.min(size.width, Math.ceil((rect.col + rect.cols) * cellWidth));
    const bottom = Math.min(size.height, Math.ceil((rect.row + rect.rows) * cellHeight));
    if (right > x && bottom > y) out.push({ x, y, width: right - x, height: bottom - y });
  }
  return out;
}

/**
 * Zeroes the covered pixels of a 4-byte-per-pixel bitmap in place. All four bytes, not only
 * alpha, so the result is transparent whether the terminal reads it premultiplied or not, and
 * whichever of BGRA/RGBA it is in.
 *
 * @returns {number} pixels cleared
 */
function maskBitmap(bitmap, size, rects) {
  const stride = size.width * 4;
  if (!bitmap || bitmap.length < stride * size.height) return 0;
  let cleared = 0;
  for (const rect of rects) {
    for (let row = rect.y; row < rect.y + rect.height; row += 1) {
      const start = row * stride + rect.x * 4;
      bitmap.fill(0, start, start + rect.width * 4);
    }
    cleared += rect.width * rect.height;
  }
  return cleared;
}

/** Whether a patch placed at `place` (cells) touches any covered cell. */
function placeIsCovered(place, rects) {
  if (!place || !rects?.length) return false;
  return rects.some((rect) => place.col < rect.col + rect.cols && rect.col < place.col + place.cols
    && place.row < rect.row + rect.rows && rect.row < place.row + place.rows);
}

module.exports = { parseOcclusionRects, sameRects, pixelRects, maskBitmap, placeIsCovered };
