"use strict";

// User settings: `config.toml` in tweb's config directory, layered under the environment.
//
// The precedence is environment > file > default. Every setting that had an environment variable
// keeps it, and it keeps winning, so nothing that set one before this file existed changes
// behaviour. The schema is shared with the CLI (`tweb config`), which validates writes against the
// same list — see settings-schema.json.
//
// Only a subset of TOML is read: tables, dotted keys, strings, numbers and booleans. That is all a
// settings file needs, and `tweb config set` writes nothing else. Anything outside it is reported
// as a warning and skipped, never fatal: a typo in a preferences file must not stop the browser.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const schema = require("./settings-schema.json").settings;
const byKey = new Map(schema.map((entry) => [entry.key, entry]));

function configDir(env = process.env) {
  if (env.TWEB_CONFIG_DIR) return env.TWEB_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(base, "tweb");
}

function configPath(env = process.env) {
  return path.join(configDir(env), "config.toml");
}

// --- the TOML subset ---

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (quote) {
      if (character === "\\" && quote === '"') i += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseValue(raw) {
  const text = raw.trim();
  if (text === "true") return { value: true };
  if (text === "false") return { value: false };
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      // A TOML basic string is a JSON string for every escape a settings file uses.
      return { value: JSON.parse(text) };
    } catch {
      return { error: `bad string ${text}` };
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return { value: text.slice(1, -1) };
  if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(text)) return { value: Number(text.replace(/_/g, "")) };
  return { error: `unsupported value ${text}` };
}

function parseToml(text) {
  const values = {};
  const warnings = [];
  let table = "";
  String(text || "").split(/\r?\n/).forEach((original, index) => {
    const line = stripComment(original).trim();
    if (!line) return;
    const header = line.match(/^\[\s*([A-Za-z0-9_.-]+)\s*\]$/);
    if (header) {
      table = header[1];
      return;
    }
    const pair = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!pair) {
      warnings.push(`line ${index + 1}: not a setting: ${original.trim()}`);
      return;
    }
    const parsed = parseValue(pair[2]);
    if (parsed.error) {
      warnings.push(`line ${index + 1}: ${parsed.error}`);
      return;
    }
    values[table ? `${table}.${pair[1]}` : pair[1]] = parsed.value;
  });
  return { values, warnings };
}

// --- one value, from whichever layer has it ---

function expandHome(value, env) {
  if (value === "~") return env.HOME || os.homedir();
  if (value.startsWith("~/")) return path.join(env.HOME || os.homedir(), value.slice(2));
  return value;
}

/** A value from the file or the environment, checked against the schema. `undefined` = unusable. */
function coerce(entry, value, fromEnv, env) {
  switch (entry.type) {
    case "bool":
      if (typeof value === "boolean") return value;
      // The environment variables were always "anything but 0 is on".
      if (fromEnv) return value !== "0" && value !== "false";
      return undefined;
    case "int":
    case "float": {
      const number = typeof value === "number" ? value : Number.parseFloat(String(value));
      if (!Number.isFinite(number)) return undefined;
      const whole = entry.type === "int" ? Math.round(number) : number;
      // Clamped, not rejected: that is what the environment variables already did.
      return Math.min(entry.max ?? Infinity, Math.max(entry.min ?? -Infinity, whole));
    }
    case "path":
      return typeof value === "string" ? expandHome(value, env) : undefined;
    default:
      return undefined;
  }
}

function resolve(fileValues, env = process.env) {
  const values = {};
  const sources = {};
  const warnings = [];
  for (const key of Object.keys(fileValues)) {
    if (!byKey.has(key)) warnings.push(`unknown setting ${key}`);
  }
  for (const entry of schema) {
    let value;
    let source = "default";
    if (entry.env && env[entry.env] !== undefined && env[entry.env] !== "") {
      value = coerce(entry, env[entry.env], true, env);
      if (value !== undefined) source = "env";
    }
    if (source === "default" && Object.hasOwn(fileValues, entry.key)) {
      value = coerce(entry, fileValues[entry.key], false, env);
      if (value === undefined) warnings.push(`${entry.key}: expected ${entry.type}`);
      else source = "file";
    }
    values[entry.key] = source === "default" ? entry.default : value;
    sources[entry.key] = source;
  }
  return { values, sources, warnings };
}

function load(env = process.env) {
  let text = "";
  try {
    text = fs.readFileSync(configPath(env), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") return { ...resolve({}, env), warnings: [`${configPath(env)}: ${error.message}`] };
  }
  const parsed = parseToml(text);
  const resolved = resolve(parsed.values, env);
  return { ...resolved, warnings: [...parsed.warnings, ...resolved.warnings] };
}

// --- the live copy the engine reads ---

let current = load();
const listeners = new Set();
let watcher = null;
let reloadTimer = null;

function get(key) {
  if (!byKey.has(key)) throw new Error(`unknown setting ${key}`);
  return current.values[key];
}

function snapshot() {
  return current;
}

function reload() {
  const previous = current.values;
  current = load();
  const changed = schema.map((entry) => entry.key).filter((key) => previous[key] !== current.values[key]);
  if (changed.length) for (const listener of listeners) listener(changed, current);
  return changed;
}

/**
 * Re-read the file whenever it changes, so a `live` setting takes effect in a running pane.
 *
 * The directory is watched, not the file: an editor that saves by writing a new file and renaming
 * it over the old one (vim, most of them) replaces the inode, and a watch on the file would go
 * quiet after the first save. The directory may not exist yet; then there is nothing to watch
 * until `tweb config set` creates it, and the next engine start picks it up.
 */
function watch(onChange) {
  listeners.add(onChange);
  if (watcher) return;
  try {
    watcher = fs.watch(configDir(), (_event, file) => {
      if (file && file !== "config.toml") return;
      clearTimeout(reloadTimer);
      // Saves arrive as several events; one reload after they settle.
      reloadTimer = setTimeout(reload, 150);
    });
    watcher.unref?.();
  } catch {
    watcher = null;
  }
}

module.exports = {
  schema, configDir, configPath, parseToml, resolve, load, get, snapshot, reload, watch,
};
