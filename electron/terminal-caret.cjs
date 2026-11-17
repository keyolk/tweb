"use strict";

// The bytes that park the pane's terminal cursor on a focused field's caret, and take it off.
//
// WHY THE CURSOR IS PARKED. IME composition is drawn by the terminal emulator at the terminal
// cursor, and the IME candidate window is placed from the same position. The page's caret is
// pixels in an image; the terminal knows nothing of it. So the cursor is moved onto the cell
// where the next character goes, and a Korean syllable composes there instead of in the corner.
//
// WHY IT IS PARKED HIDDEN. It used to be shown as a steady bar (DECSCUSR 6) and the page's own
// caret was made transparent, so there would be one caret rather than two. That bar was the
// terminal's cursor colour, a full cell high whatever the font, snapped to the nearest cell edge,
// and it moved a frame after the text did — it read as a foreign blue bar sitting near the text,
// not as the field's caret. Showing it also made it visible wherever the cursor went in between:
// every graphics write inside tmux moves the cursor to the pane origin and back (DECSC/CUP/DECRC
// in the passthrough), and tmux then sends it to the screen's top-left (`tty_invalidate`) before
// putting it back on the pane cursor. While the cursor was visible, a render that caught any of
// those positions showed it wandering over the page.
//
// Nothing needs it visible. Read in the sources of the versions this runs against:
//   - Ghostty 1.4.0 `src/renderer/cursor.zig` `style()`: "If we are in preedit, then we always
//     show the block cursor ... even if the cursor is explicitly not visible". Preedit is drawn
//     at the cursor whether or not DECTCEM is set.
//   - Ghostty 1.4.0 `src/Surface.zig` `imePoint()`: the candidate window is placed from the
//     cursor's x/y, with no visibility check.
//   - tmux 3.8 `server-client.c` `server_client_reset_state()`: the outer cursor is moved to the
//     active pane's cursor (`tty_cursor(tty, cx, cy)`) before the mode is applied, so a hidden
//     pane cursor still positions the terminal's.
// So the cursor is moved and kept hidden; the page draws its own caret, at the right pixel, in
// the field's own colour; and the only time the terminal draws anything there is while a
// composition is actually in progress — which is exactly when it should.

const ESC = "\x1b";
const CSI = (body) => `${ESC}[${body}`;

const HIDE = CSI("?25l");
// The shape tweb used to borrow (a bar), handed back. Still sent on unpark so a pane that ran an
// older engine does not leave its shell with a bar cursor.
const SHAPE_RESET = CSI("0 q");

/** Moves the hidden cursor to `row`/`col` (1-based). Re-hides it: cheap, and nothing can undo it. */
function parkSequence(row, col) {
  return `${CSI(`${row};${col}H`)}${HIDE}`;
}

/** Hides the cursor with nothing to follow, and gives the shell its default shape back. */
function unparkSequence() {
  return `${HIDE}${SHAPE_RESET}`;
}

module.exports = { parkSequence, unparkSequence, HIDE, SHAPE_RESET };
