"use strict";

// Electron `sendInputEvent` payloads, restated as CDP `Input.*` calls.
//
// main.cjs speaks Electron's input dialect everywhere — `keyCode` as an Accelerator name, a
// separate `char` event for text, modifiers as lowercase strings with `leftbuttondown` riding
// along for a held button. Rewriting every call site for the Chrome engine would fork the key
// path, and the key path is where this project has paid most for drift (see agent-key.cjs). So
// the dialect stays and this file translates it, one Electron event to one CDP call.
//
// The one structural difference: Electron's keyDown + char pair becomes CDP's keyDown carrying
// `text`. CDP has a `char` type too, but a keyDown without `text` followed by a char inserts the
// text twice in some editors and zero times in others; carrying the text on the keyDown is what
// Chrome's own DevTools input does, and it is the shape that fires `beforeinput`/`input`.
// So `toCdpInput` returns null for a `char`, and the caller folds its text into the preceding
// keyDown through `KeySequencer`.

const MODIFIER_BITS = { alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, shift: 8 };

function modifierMask(modifiers = []) {
  let mask = 0;
  for (const modifier of modifiers) mask |= MODIFIER_BITS[String(modifier).toLowerCase()] || 0;
  return mask;
}

// Accelerator name (what main.cjs sends) -> [KeyboardEvent.key, KeyboardEvent.code, keyCode].
const NAMED_KEYS = new Map([
  ["Up", ["ArrowUp", "ArrowUp", 38]], ["Down", ["ArrowDown", "ArrowDown", 40]],
  ["Left", ["ArrowLeft", "ArrowLeft", 37]], ["Right", ["ArrowRight", "ArrowRight", 39]],
  ["ArrowUp", ["ArrowUp", "ArrowUp", 38]], ["ArrowDown", ["ArrowDown", "ArrowDown", 40]],
  ["ArrowLeft", ["ArrowLeft", "ArrowLeft", 37]], ["ArrowRight", ["ArrowRight", "ArrowRight", 39]],
  ["Enter", ["Enter", "Enter", 13]], ["Return", ["Enter", "Enter", 13]],
  ["Tab", ["Tab", "Tab", 9]], ["Escape", ["Escape", "Escape", 27]], ["Esc", ["Escape", "Escape", 27]],
  ["Backspace", ["Backspace", "Backspace", 8]], ["Delete", ["Delete", "Delete", 46]],
  ["Insert", ["Insert", "Insert", 45]], ["Home", ["Home", "Home", 36]], ["End", ["End", "End", 35]],
  ["PageUp", ["PageUp", "PageUp", 33]], ["PageDown", ["PageDown", "PageDown", 34]],
  ["Space", [" ", "Space", 32]], [" ", [" ", "Space", 32]],
  ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, [`F${i + 1}`, `F${i + 1}`, 112 + i]]),
]);

// The text a named key inserts on its own. Enter is "\r" because that is what Chrome's
// keyboard sends; a textarea turns it into a newline and a form submits on it.
const NAMED_TEXT = new Map([["Enter", "\r"], ["Tab", ""], [" ", " "]]);

const SHIFTED_DIGITS = ")!@#$%^&*(";
const PUNCTUATION_CODES = new Map([
  ["-", ["Minus", 189]], ["_", ["Minus", 189]], ["=", ["Equal", 187]], ["+", ["Equal", 187]],
  ["[", ["BracketLeft", 219]], ["{", ["BracketLeft", 219]], ["]", ["BracketRight", 221]],
  ["}", ["BracketRight", 221]], ["\\", ["Backslash", 220]], ["|", ["Backslash", 220]],
  [";", ["Semicolon", 186]], [":", ["Semicolon", 186]], ["'", ["Quote", 222]], ["\"", ["Quote", 222]],
  [",", ["Comma", 188]], ["<", ["Comma", 188]], [".", ["Period", 190]], [">", ["Period", 190]],
  ["/", ["Slash", 191]], ["?", ["Slash", 191]], ["`", ["Backquote", 192]], ["~", ["Backquote", 192]],
]);

/// KeyboardEvent `key`, `code` and legacy `keyCode` for an Accelerator-or-character name.
function keyIdentity(name) {
  const value = String(name ?? "");
  const named = NAMED_KEYS.get(value);
  if (named) return { key: named[0], code: named[1], keyCode: named[2] };
  if ([...value].length === 1) {
    const char = value;
    if (/[a-z]/i.test(char)) {
      const upper = char.toUpperCase();
      return { key: char, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
    }
    if (/[0-9]/.test(char)) return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0) };
    const shiftedDigit = SHIFTED_DIGITS.indexOf(char);
    if (shiftedDigit >= 0) return { key: char, code: `Digit${shiftedDigit}`, keyCode: 48 + shiftedDigit };
    const punctuation = PUNCTUATION_CODES.get(char);
    if (punctuation) return { key: char, code: punctuation[0], keyCode: punctuation[1] };
    // Hangul, kana, emoji: no physical key. keyCode 229 is what an IME-composed key reports.
    return { key: char, code: "", keyCode: 0 };
  }
  return { key: value, code: value, keyCode: 0 };
}

// Commands Chrome's own keyboard path runs for a platform shortcut. CDP input is synthetic
// and does NOT go through the browser's accelerator table, so Cmd-A on a CDP keyDown fires the
// keydown and selects nothing. `commands` is the documented hook for exactly this.
const MAC_EDIT_COMMANDS = new Map([
  ["a", ["selectAll"]], ["c", ["copy"]], ["x", ["cut"]], ["v", ["paste"]],
  ["z", ["undo"]], ["Z", ["redo"]],
  ["ArrowLeft", ["moveToBeginningOfLine"]], ["ArrowRight", ["moveToEndOfLine"]],
  ["ArrowUp", ["moveToBeginningOfDocument"]], ["ArrowDown", ["moveToEndOfDocument"]],
  ["Backspace", ["deleteToBeginningOfLine"]],
]);
const ALT_EDIT_COMMANDS = new Map([
  ["ArrowLeft", ["moveWordLeft"]], ["ArrowRight", ["moveWordRight"]],
  ["Backspace", ["deleteWordBackward"]],
]);

function editCommands(key, mask) {
  if (mask & 4) return MAC_EDIT_COMMANDS.get(mask & 8 && key === "z" ? "Z" : key) || undefined;
  if (mask & 1) return ALT_EDIT_COMMANDS.get(key) || undefined;
  return undefined;
}

const BUTTON_FLAGS = { left: 1, right: 2, middle: 4 };
const HELD_MODIFIERS = { leftbuttondown: 1, rightbuttondown: 2, middlebuttondown: 4 };

function heldButtons(modifiers = []) {
  let buttons = 0;
  for (const modifier of modifiers) buttons |= HELD_MODIFIERS[String(modifier).toLowerCase()] || 0;
  return buttons;
}

/// One Electron mouse event as `Input.dispatchMouseEvent` params, or null when the event has
/// no CDP equivalent (`contextMenu`, which Chrome raises on its own from a right mouseReleased).
function toCdpMouse(event) {
  const modifiers = modifierMask(event.modifiers);
  const base = { x: Number(event.x) || 0, y: Number(event.y) || 0, modifiers };
  switch (event.type) {
    case "mouseMove":
    case "mouseEnter":
    case "mouseLeave": {
      const buttons = heldButtons(event.modifiers);
      const button = buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none";
      return { type: "mouseMoved", ...base, button, buttons };
    }
    case "mouseDown":
    case "mouseUp": {
      const button = event.button || "left";
      // `buttons` is the state AFTER the event, which is what the page reads from it.
      const held = heldButtons(event.modifiers);
      const buttons = event.type === "mouseDown" ? held | BUTTON_FLAGS[button] : held & ~BUTTON_FLAGS[button];
      return {
        type: event.type === "mouseDown" ? "mousePressed" : "mouseReleased",
        ...base,
        button,
        buttons,
        clickCount: Math.max(1, Number(event.clickCount) || 1),
      };
    }
    case "mouseWheel": {
      // Electron's wheel deltas follow WebMouseWheelEvent (positive = toward the top), CDP's
      // follow the DOM `WheelEvent` (positive = toward the bottom). Opposite signs.
      return {
        type: "mouseWheel",
        ...base,
        deltaX: -(Number(event.deltaX) || 0),
        deltaY: -(Number(event.deltaY) || 0),
        pointerType: "mouse",
      };
    }
    default:
      return null;
  }
}

/// One Electron key event as `Input.dispatchKeyEvent` params. `text` is what a following
/// `char` event inserts; the caller passes it so it rides on the keyDown.
function toCdpKey(event, text) {
  const modifiers = modifierMask(event.modifiers);
  const identity = keyIdentity(event.keyCode);
  const params = {
    modifiers,
    key: identity.key,
    code: identity.code,
    windowsVirtualKeyCode: identity.keyCode,
    nativeVirtualKeyCode: identity.keyCode,
  };
  if (event.type === "keyUp") return { type: "keyUp", ...params };
  const insert = text ?? (NAMED_TEXT.has(identity.key) && !(modifiers & 6) ? NAMED_TEXT.get(identity.key) : undefined);
  const commands = editCommands(identity.key, modifiers);
  if (insert) return { type: "keyDown", ...params, text: insert, unmodifiedText: insert, commands };
  return { type: "rawKeyDown", ...params, commands };
}

/// Folds Electron's keyDown / char / keyUp triples into CDP calls.
///
/// A keyDown is held back until the next event, so a `char` right behind it can donate its
/// text; anything else flushes it as a raw key. main.cjs sends the keyDown and its char in
/// the same synchronous run, so the caller flushes on a microtask and nothing waits longer.
class KeySequencer {
  constructor(dispatch) {
    this.dispatch = dispatch;
    this.pendingDown = null;
  }

  push(event) {
    if (event.type === "char") {
      const text = String(event.keyCode ?? "");
      if (this.pendingDown) {
        const down = this.pendingDown;
        this.pendingDown = null;
        return this.dispatch(toCdpKey(down, text));
      }
      // A lone char (IME commit, `insertText`-like) types without a key.
      const identity = keyIdentity(text);
      return this.dispatch({
        type: "char", text, unmodifiedText: text, key: identity.key,
        modifiers: modifierMask(event.modifiers),
      });
    }
    const flushed = this.flush();
    if (event.type === "keyDown" || event.type === "rawKeyDown") {
      this.pendingDown = event;
      return flushed;
    }
    return this.dispatch(toCdpKey(event));
  }

  flush() {
    if (!this.pendingDown) return undefined;
    const down = this.pendingDown;
    this.pendingDown = null;
    return this.dispatch(toCdpKey(down));
  }
}

module.exports = {
  KeySequencer,
  keyIdentity,
  modifierMask,
  toCdpKey,
  toCdpMouse,
};
