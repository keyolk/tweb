"use strict";

// Whether damage patches may be placed RELATIVE to the base frame's placement (`P=`,`Q=`,`H=`,`V=`)
// instead of at an absolute cell the cursor is walked to.
//
// WHAT IT BUYS. An absolute patch has to know where the pane sits on screen: `patchCursorMove`
// walks the cursor to the pane origin plus the patch's cell and back. Until the origin is known a
// tmux pane cannot patch at all and every keystroke costs a whole frame. A relative patch names
// the base placement as its parent and an offset in cells from its top-left, so the terminal does
// the addressing — no origin, no cursor walk, and the patch follows the base if it is re-placed.
//
// Measured on Ghostty 1.4.0 (bare tty, every case answered by the terminal):
//   - a child at `H=,V=` lands at that cell offset from the parent's top-left
//   - `a=p` re-placing the parent elsewhere moves the child with it
//   - `a=T` retransmitting the parent, or `d=i` dropping its placements, deletes the child —
//     the same lifetime `transferFrame` already gives patches by deleting them first
//   - at the parent's own z the child draws above it
//   - a missing parent is `ENOPARENT`
//
// WHY A VERSION GATE, AND WHY THE OLD PATH STAYS. Ghostty before 1.4 has no relative placements,
// and every patch carries `q=2`, so a terminal that rejects one cannot say so: the patch simply
// never appears and the page looks frozen until the next whole frame. There is no reply to fall
// back from, so the terminal has to be known to support it before the first patch goes out. Any
// terminal that is not — an older Ghostty, or one not identified at all — keeps the absolute path.
//
// Only Ghostty is named. kitty has had relative placements since 0.31, but tweb has not measured
// them there; it stays on the path it was measured on until someone does.
const MIN_GHOSTTY = [1, 4, 0];

// "ghostty 1.4.0", "1.4.0-dev+abc", "1.4" → [1, 4, 0]; anything else → null.
function parseVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text || "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

function atLeast(version, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

/**
 * @param {object} env
 * @param {string} [env.clientTermtype] tmux `#{client_termtype}` — the attached client's own
 *   XTVERSION answer, e.g. "ghostty 1.4.0". Inside tmux this is the only place the outer
 *   terminal's version is visible: `TERM_PROGRAM_VERSION` there is tmux's.
 * @param {string} [env.termProgram] `$TERM_PROGRAM`, for a pane that is not inside tmux.
 * @param {string} [env.termProgramVersion] `$TERM_PROGRAM_VERSION`, same.
 * @param {string} [env.override] `$TWEB_RELATIVE_PATCHES`: "0" forces off, "1" forces on.
 * @returns {{ allowed: boolean, reason: string }}
 */
function relativePatchesDecision({ clientTermtype, termProgram, termProgramVersion, override } = {}) {
  if (override === "0") return { allowed: false, reason: "TWEB_RELATIVE_PATCHES=0" };
  if (override === "1") return { allowed: true, reason: "TWEB_RELATIVE_PATCHES=1" };
  // The attached client's answer first: inside tmux the environment names tmux, not the terminal.
  const [name, version] = clientTermtype
    ? [clientTermtype, parseVersion(clientTermtype)]
    : [termProgram || "", parseVersion(termProgramVersion)];
  if (!/ghostty/i.test(name)) return { allowed: false, reason: `not ghostty (${name || "unknown"})` };
  if (!version) return { allowed: false, reason: "ghostty version unknown" };
  const shown = version.join(".");
  return atLeast(version, MIN_GHOSTTY)
    ? { allowed: true, reason: `ghostty ${shown}` }
    : { allowed: false, reason: `ghostty ${shown} < ${MIN_GHOSTTY.join(".")}` };
}

module.exports = { relativePatchesDecision, parseVersion };
