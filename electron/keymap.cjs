"use strict";

// `keys.map` in config.toml: the person's own normal-mode keys.
//
//   [keys]
//   map = ["n=j", "e=k", "-x", "Q=x"]
//
// "NEW=OLD" makes NEW do what OLD does in normal mode (the single keys `?` lists); OLD keeps
// working. "-KEY" leaves KEY to the page: tweb no longer takes it. A later entry for the same key
// wins, so a list can be appended to without editing what is above it.
//
// Parsed here, in the main process, because the preload is sandboxed and cannot require a local
// module (preload.cjs, top). The preload gets the result as [key, target-or-null] pairs over
// `tweb-keymap` and applies it where it looks a key up.
//
// Single keys only. Chords (`gg`, `zi`) and Ctrl/Alt/Cmd keys belong to other dispatch paths, and
// a remap that half-worked there would be worse than one that is refused with a reason.

/**
 * @param {unknown} entries the `keys.map` list
 * @returns {{ pairs: [string, string | null][], warnings: string[] }}
 */
function parseKeymap(entries) {
  const pairs = new Map();
  const warnings = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = String(raw ?? "").trim();
    if (!entry) continue;
    if (entry.startsWith("-") && entry.length > 1 && !entry.includes("=")) {
      const key = entry.slice(1);
      if (!singleKey(key)) {
        warnings.push(`keys.map: "${entry}": only a single key can be unbound`);
        continue;
      }
      pairs.set(key, null);
      continue;
    }
    // Split at the first "=" after the first character, so "==j" binds "=" to j.
    const at = entry.indexOf("=", 1);
    if (at < 0) {
      warnings.push(`keys.map: "${entry}": expected NEW=OLD or -KEY`);
      continue;
    }
    const key = entry.slice(0, at);
    const target = entry.slice(at + 1);
    if (!singleKey(key) || !singleKey(target)) {
      warnings.push(`keys.map: "${entry}": both sides must be single keys`);
      continue;
    }
    if (key === target) continue;
    pairs.set(key, target);
  }
  return { pairs: [...pairs], warnings };
}

// One character as `KeyboardEvent.key` reports it for a printable key. `Escape`, `Enter` and the
// like stay with tweb: they end modes, and a person who rebinds Escape away has no way back.
function singleKey(key) {
  return typeof key === "string" && [...key].length === 1 && key.trim() === key;
}

module.exports = { parseKeymap };
