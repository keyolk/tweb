"use strict";

// What `sendInputEvent` calls one agent `press` should turn into.
//
// The agent path (`tweb press Enter --mod shift`) and the real key path — a keystroke
// arriving over the PTY, `dispatchNativeKey` in main.cjs — reach the same page through the
// same Chromium API, and they disagreed on three points. All three were measured against
// the real path on a live pane, typing into an `<input>` and reading `.value` back:
//
//   press i --mod shift    field kept "h"     tmux send-keys h I x -> "hIx"
//   press ArrowLeft        keydown key=""     tmux send-keys Left  -> key="ArrowLeft"
//   press Space            field kept "ab"    tmux send-keys Space -> "ab "
//
// Each is silent: the keydown fires, `press` returns ok, and only the page's state shows
// that nothing happened. The rules below are `dispatchNativeKey`'s, restated for the agent
// path so the two cannot drift again.

// `sendInputEvent`'s keyCode takes Electron Accelerator names, not `KeyboardEvent.key`
// names. The two schemes agree on Enter/Tab/Escape/Home/F5 and disagree on the arrows,
// which Chromium then drops silently — the same defect #13 fixed for the real key path.
// A letter is deliberately absent: "KeyK" reaches the page as key="" keyCode=0 while "k"
// arrives correctly, so only these four are translated.
const ACCELERATOR_KEYS = new Map([
  ["ArrowUp", "Up"], ["ArrowDown", "Down"], ["ArrowLeft", "Left"], ["ArrowRight", "Right"],
]);

// Named keys that insert a character. Chromium fires the keydown for "Space" but inserts
// nothing without a matching char event, and no caller should have to know that pressing
// the space bar is spelled " " here while every other key is spelled by name.
const CHAR_FOR_NAMED_KEY = new Map([["Space", " "]]);

// Which modifiers suppress text insertion. Control and Meta make the keystroke a shortcut
// rather than typing; Shift and Alt still produce a character. Sending a char event under
// Control would type a literal letter into the field the shortcut was aimed at.
const NON_TEXT_MODIFIERS = new Set(["control", "meta"]);

/// The character a key press inserts, or null when it inserts nothing.
///
/// Shift is applied here because the char event carries the literal text: Chromium already
/// reports `key="I"` on the keydown for `i`+shift, but the char it inserts is whatever this
/// returns, so without the uppercasing the field kept the previous character.
///
/// Only case is derived. A shifted symbol (`shift+1` -> `!`) depends on the keyboard
/// layout, which is not knowable here — callers pass the shifted character directly
/// (`press !`), which already works because a single printable character needs no mapping.
function insertedText(key, modifiers = []) {
  if (modifiers.some((modifier) => NON_TEXT_MODIFIERS.has(modifier))) return null;
  const named = CHAR_FOR_NAMED_KEY.get(key);
  if (named !== undefined) return named;
  if ([...key].length !== 1) return null;
  return modifiers.includes("shift") ? key.toUpperCase() : key;
}

/// The `sendInputEvent` payloads for one agent `press`, in order.
///
/// Returned as data rather than sent directly so the rules above are testable without a
/// live Chromium: the caller is a `for` loop over this array.
function pressEvents(key, modifiers = []) {
  const name = String(key ?? "");
  if (!name) return [];
  const mods = [...modifiers];
  const keyCode = ACCELERATOR_KEYS.get(name) || name;
  const events = [{ type: "keyDown", keyCode, modifiers: mods }];
  const text = insertedText(name, mods);
  // The char event carries the modifiers too, so a page reading `shiftKey` off the
  // keypress sees the same state the keydown reported.
  if (text !== null) events.push({ type: "char", keyCode: text, modifiers: mods });
  events.push({ type: "keyUp", keyCode, modifiers: mods });
  return events;
}

module.exports = { pressEvents, insertedText, ACCELERATOR_KEYS };
