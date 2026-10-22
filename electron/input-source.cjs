"use strict";

// Keeping a pane's input source on ABC while its keys are commands, and on the person's own while
// they type. See crates/tweb-cli/src/ime.rs for the switch itself and why it exists.
//
// Two halves, because focus and typing are seen in different places:
//
//   tmux pane-focus hooks   focus moving into a tweb pane (not typing) -> `tweb __ime normal`
//                           focus leaving one                           -> `tweb __ime restore`
//   the engine              a field taking or giving up the keys while its pane has focus
//
// The hooks are tmux's own, so they run before the next key is read; the engine would only learn
// of a focus change at its next tick, after the IME already swallowed the first key. They read the
// pane option `@tweb_text`, which the engine keeps: 1 while the pane's keys are text.

/** Whether the pane's keys are text for the page (or an overlay field), not commands. */
function keysAreText(state) {
  return Boolean(state.bypass || !state.vimium || state.insertMode || state.textMode);
}

// The preload modes that take typed text: a focused field, and tweb's own input overlays.
const TEXT_MODES = new Set(["insert", "omnibox", "search", "command-line", "command"]);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * The tmux commands that install (or, disabled, remove) the focus hooks. Index 72, beside edit
 * mode's 71, so neither replaces the other or a person's own hooks.
 */
function focusHookCommands(tweb, enabled = true) {
  if (!enabled) {
    return [["set-hook", "-gu", "pane-focus-in[72]"], ["set-hook", "-gu", "pane-focus-out[72]"]];
  }
  const run = (action) => `run-shell -b "${shellQuote(tweb)} __ime ${action} >/dev/null 2>&1"`;
  return [
    ["set-hook", "-g", "pane-focus-in[72]",
      `if-shell -F "#{&&:#{==:#{@tweb_browser},1},#{!=:#{@tweb_text},1}}" '${run("normal")}'`],
    ["set-hook", "-g", "pane-focus-out[72]",
      `if-shell -F "#{==:#{@tweb_browser},1}" '${run("restore")}'`],
  ];
}

module.exports = { TEXT_MODES, focusHookCommands, keysAreText };
