"use strict";

// Holds a key down across the terminal's autorepeat when no release event will come.
//
// Inside tmux the pane gets keys through modifyOtherKeys, which has no release events: every
// press, and every autorepeat of a held key, arrives as one "press" (kitty event kind 1). The
// engine used to answer each one with keyDown and keyUp in the same instant, so a page that reads
// "is this key down right now" every frame — a game, a canvas, a slider — saw the key up on every
// frame and barely moved. Measured on a canvas game: holding → gave keydown+keyup pairs 0 ms apart,
// the first repeat 166 ms later, then one every ~33 ms.
//
// Instead the keyUp waits: long enough after a first press to cover the initial repeat delay, and
// long enough after a repeat to cover the repeat interval. Another press of the same key before
// then is the autorepeat and only refreshes the timer, so the page sees one key held down. A real
// release (kind 3, when the terminal does report releases) lets go at once.
//
// A tap now releases `firstMs` later instead of immediately. A page only notices that if it times
// how long a key was held, which is rare and was already broken by the zero-length press.

const FIRST_MS = 320;
const REPEAT_MS = 110;
// Presses closer together than this are the terminal's autorepeat cadence, not a person tapping.
const AUTOREPEAT_GAP_MS = 60;

function createHeldKeys({ setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(),
  firstMs = FIRST_MS, repeatMs = REPEAT_MS } = {}) {
  const held = new Map();

  function schedule(id, entry, ms) {
    clearTimer(entry.timer);
    entry.timer = setTimer(() => {
      if (held.get(id) !== entry) return;
      held.delete(id);
      entry.up();
    }, ms);
  }

  return {
    /// A press with no release to follow. `down(autoRepeat)` sends the keyDown (and any text);
    /// `up()` sends the keyUp. Returns what was sent: "down", "repeat" or "redown".
    press(id, down, up) {
      const at = now();
      const entry = held.get(id);
      if (!entry) {
        const fresh = { at, up, timer: null, repeating: false };
        held.set(id, fresh);
        down(false);
        schedule(id, fresh, firstMs);
        return "down";
      }
      const gap = at - entry.at;
      entry.at = at;
      entry.up = up;
      if (entry.repeating || gap <= AUTOREPEAT_GAP_MS) {
        entry.repeating = true;
        down(true);
        schedule(id, entry, repeatMs);
        return "repeat";
      }
      // A second press inside the first window: either the first autorepeat (~150-500 ms) or a
      // quick double tap. Without a release event the two look the same, so it goes out as a new
      // keyDown with no keyUp between: a page tracking held state keeps the key down, and one
      // counting presses (double-tap to dash) still sees a second press.
      down(false);
      schedule(id, entry, repeatMs);
      entry.repeating = true;
      return "redown";
    },

    /// A real release. Sends the keyUp now if the key was being held; false when it was not.
    release(id, up) {
      const entry = held.get(id);
      if (!entry) return false;
      clearTimer(entry.timer);
      held.delete(id);
      (up || entry.up)();
      return true;
    },

    /// Lets go of every held key (focus moved, mode changed, the page went away).
    releaseAll() {
      for (const [id, entry] of held) {
        clearTimer(entry.timer);
        held.delete(id);
        entry.up();
      }
    },

    isHeld(id) {
      return held.has(id);
    },
  };
}

module.exports = { createHeldKeys, FIRST_MS, REPEAT_MS, AUTOREPEAT_GAP_MS };
