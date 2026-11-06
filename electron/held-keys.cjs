"use strict";

// Holds a key down across the terminal's autorepeat when no release event will come.
//
// Inside tmux the pane gets keys through modifyOtherKeys, which has no release events: every
// press, and every autorepeat of a held key, arrives as one "press" (kitty event kind 1). The
// engine used to answer each one with keyDown and keyUp in the same instant, so a page that reads
// "is this key down right now" every frame — a game, a canvas, a slider — saw the key up on every
// frame and barely moved. Measured on a canvas game: holding → gave keydown+keyup pairs 0 ms apart,
// the first repeat 166 ms later (InitialKeyRepeat 10 = 150 ms), then one every ~33 ms.
//
// So a press is held down and its keyUp waits. What the next press of the same key is depends on
// the gap, because the OS autorepeat has a known shape:
//   - inside the repeat cadence, or at/after the initial repeat delay: the key is still held, and
//     it goes out as an autorepeat keyDown with no keyUp before it;
//   - sooner than the initial delay: a person pressed it again (a double tap to dash, a mashed
//     attack button), so the page gets keyUp then a fresh keyDown, as from a real keyboard.
// The keyUp itself goes out once the next repeat is overdue. A real release (kind 3, when the
// terminal reports one) lets go at once.

const DEFAULT_INITIAL_MS = 225; // macOS default InitialKeyRepeat 15 x 15 ms
const DEFAULT_INTERVAL_MS = 30; // macOS KeyRepeat 2 x 15 ms
// Presses closer together than this are the repeat cadence however the OS is configured.
const CADENCE_MAX_MS = 60;

function createHeldKeys({ setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(),
  initialMs = DEFAULT_INITIAL_MS, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  // A first repeat lands at or a little after the configured delay; anything clearly sooner is a
  // second press. The windows wait past the next expected repeat with room for scheduling jitter.
  const doubleTapMaxMs = initialMs * 0.9;
  const firstMs = initialMs + 170;
  const repeatMs = Math.max(110, intervalMs * 3);
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
    /// `up()` sends the keyUp. Returns what was sent: "down", "repeat" or "again".
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
      if (entry.repeating || gap <= CADENCE_MAX_MS || gap >= doubleTapMaxMs) {
        entry.repeating = true;
        entry.up = up;
        down(true);
        schedule(id, entry, repeatMs);
        return "repeat";
      }
      // Pressed again before the OS could have repeated it: a real second press.
      entry.up();
      entry.up = up;
      down(false);
      schedule(id, entry, firstMs);
      return "again";
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

    windows: { firstMs, repeatMs, doubleTapMaxMs },
  };
}

module.exports = { createHeldKeys, DEFAULT_INITIAL_MS, DEFAULT_INTERVAL_MS, CADENCE_MAX_MS };
