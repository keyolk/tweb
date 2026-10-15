"use strict";

// Transparent page backgrounds: `tweb open --transparent`, or `page.transparent` in config.toml.
//
// A page that paints no background of its own lets the terminal show through: its frame keeps an
// alpha channel, the frame is a Kitty image placed under the text (`z=-1`), and where it is clear
// the terminal's own background — colour, opacity, blur, wallpaper — is what the user sees.
//
// Three things have to agree for that to hold, and this module is where they are decided:
//
// - The offscreen window is created transparent with a fully clear background. Chromium's base
//   background is otherwise opaque white, so a page without `background` is still white.
// - The frame formats already keep alpha — `f=32` raw RGBA and PNG both carry it — so the whole
//   frame needs nothing.
// - Damage patches are OFF for a transparent tab. A patch is a second image placed OVER the base
//   one, and a clear pixel in a patch shows the base image beneath it, not the terminal: a caret
//   that moved would leave its old position drawn on the stale base. Over an opaque page that
//   cannot happen, because every patch pixel covers what is under it. So a transparent tab sends
//   whole frames only. The cost is the patch path's latency win on typing, which this mode gives
//   up knowingly.
//
// Electron engine only. The Chrome engine's screencast is JPEG, which has no alpha, and the
// WebKit host has no transparent path (its views draw their own background); there the setting
// is ignored, and the CLI refuses the explicit flag, rather than claim a mode it cannot deliver.

const CLEAR = "#00000000";

/**
 * Whether new tabs in this engine are transparent.
 *
 * @param {{flag?: boolean, setting?: boolean, backend?: string}} input the `--tweb-transparent`
 *   flag, the `page.transparent` setting, and the page backend kind
 * @returns {boolean}
 */
function transparentPages({ flag = false, setting = false, backend = "electron" } = {}) {
  if (backend !== "electron") return false;
  return Boolean(flag || setting);
}

/**
 * The BrowserWindow options that make a tab transparent, to spread into the usual ones.
 *
 * @param {boolean} enabled from `transparentPages`
 * @returns {{transparent?: boolean, backgroundColor?: string}}
 */
function transparentWindowOptions(enabled) {
  return enabled ? { transparent: true, backgroundColor: CLEAR } : {};
}

module.exports = { transparentPages, transparentWindowOptions, CLEAR };
