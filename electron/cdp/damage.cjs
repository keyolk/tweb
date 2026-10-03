"use strict";

// The damage rectangle Chrome does not report, recovered by comparing two frames.
//
// Electron's offscreen `paint` hands main.cjs a dirty rect, and the frame pipeline is built on
// it: a blinking caret or a typed letter goes out as a patch a thousandth the size of the frame.
// CDP has no damage information at all — `captureScreenshot` is the whole viewport, every time.
// Without this every caret blink on a Retina pane is a 20.7MB frame (measured: a focused input
// on a static page sent six whole frames in three seconds).
//
// Rows are compared with `Buffer.compare` (a memcmp), then only the differing rows are scanned
// for their left and right edge. Measured at 2880x1800: 0.46ms for identical frames, 0.70ms
// for a 21px change — noise next to the PNG decode it follows.

/**
 * The bounding box of every pixel that differs between two RGBA/BGRA bitmaps of the same size,
 * or null when they are identical. Coordinates are in pixels of the bitmap — device pixels, the
 * same unit Electron's `paint` dirty rect is in (see patch-geometry.cjs).
 */
function dirtyRect(previous, next, width, height) {
  if (!previous || !next || previous.length !== next.length) return { x: 0, y: 0, width, height };
  const stride = width * 4;
  if (previous.length < stride * height) return { x: 0, y: 0, width, height };
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    const offset = y * stride;
    if (previous.compare(next, offset, offset + stride, offset, offset + stride) !== 0) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return null;
  let left = width;
  let right = -1;
  for (let y = top; y <= bottom; y += 1) {
    const offset = y * stride;
    if (previous.compare(next, offset, offset + stride, offset, offset + stride) === 0) continue;
    let l = 0;
    while (l < width && previous.readUInt32LE(offset + l * 4) === next.readUInt32LE(offset + l * 4)) l += 1;
    let r = width - 1;
    while (r > l && previous.readUInt32LE(offset + r * 4) === next.readUInt32LE(offset + r * 4)) r -= 1;
    if (l < left) left = l;
    if (r > right) right = r;
  }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

module.exports = { dirtyRect };
