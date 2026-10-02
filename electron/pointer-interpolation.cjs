"use strict";

// Filling in the gap tmux leaves between two pointer positions.
//
// WHY THIS EXISTS. A pane asks for pixel-resolution mouse reporting (`\033[?1016h`) and inside
// tmux never gets it. tmux 3.5a does not know that mode at all — `input.c` handles 1000, 1001,
// 1002, 1003, 1004, 1005, 1006, 1047 and 1049, and the string "1016" appears nowhere in
// `tty-keys.c`, `input.c`, `tty.c` or `screen.c`. The request is swallowed rather than passed to
// the outer terminal, so every coordinate arrives snapped to the CELL grid.
//
// A cell is about 5 CSS px across and 11 to 19 CSS px down (360x100 cells over a 1800x1125 page
// gives 5.0 x 11.2; 240x60 gives 7.5 x 18.8). Horizontally that is fine. VERTICALLY the pointer
// cannot move until it has travelled more than a cell, so a diagonal drag arrives as a staircase
// and anything drawing from it — a whiteboard, a canvas, a freehand tool — draws a staircase too.
// That is the reported "선이 끊긴다": not lost events, but samples too far apart.
//
// WHAT IS AND IS NOT INVENTED. Motion reporting itself is not throttled — 1003 is on, so a report
// arrives for every movement the terminal notices, and only the coordinate is quantised. Two
// consecutive reports therefore bound a path the pointer really did travel, and the points put
// between them are on that path by straight-line approximation. No speed, no acceleration and no
// curve fitting: a fast curve still has its corners cut, and that is deliberate — those would be
// positions the pointer never held.
//
// Nothing is interpolated outside tmux, where the coordinates are already pixels.

/**
 * Points to send between `from` and `to`, exclusive of both.
 *
 * @param {{x: number, y: number}|null} from The previous position, or null when there is none —
 *   the first motion of a drag has nothing to interpolate from.
 * @param {{x: number, y: number}} to The position just reported.
 * @param {{x: number, y: number}} cell The size of one terminal cell, in the same units as the
 *   points. A step smaller than this is not worth filling: the gap is already sub-cell.
 * @param {number} [limit] Most points to insert for one gap. A pointer that jumps the width of
 *   the page — re-entering the pane, or a report lost while another window had focus — must not
 *   turn into a hundred events.
 * @returns {{x: number, y: number}[]}
 */
function interpolatePoints(from, to, cell, limit = 8) {
  if (!from) return [];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // How many cells this jump spans, on the axis where it spans the most. A move within one cell
  // needs nothing, and a move of exactly one cell is already as smooth as the grid allows.
  const spanX = cell.x > 0 ? Math.abs(dx) / cell.x : 0;
  const spanY = cell.y > 0 ? Math.abs(dy) / cell.y : 0;
  const steps = Math.min(limit + 1, Math.floor(Math.max(spanX, spanY)));
  if (steps < 2) return [];
  const points = [];
  for (let i = 1; i < steps; i += 1) {
    points.push({
      x: Math.round(from.x + (dx * i) / steps),
      y: Math.round(from.y + (dy * i) / steps),
    });
  }
  return points;
}

module.exports = { interpolatePoints };
