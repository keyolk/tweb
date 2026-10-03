"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const settings = require("./settings.cjs");

test("the TOML subset reads tables, dotted keys, strings, numbers and booleans", () => {
  const { values, warnings } = settings.parseToml([
    "# a comment",
    "scroll.invert = true",
    "[zoom]",
    "default = 1.25   # trailing comment",
    "[downloads]",
    'dir = "~/Down # not a comment"',
    "[ime]",
    "slot_cells = 1_0",
  ].join("\n"));
  assert.deepEqual(values, {
    "scroll.invert": true,
    "zoom.default": 1.25,
    "downloads.dir": "~/Down # not a comment",
    "ime.slot_cells": 10,
  });
  assert.deepEqual(warnings, []);
});

test("anything outside the subset is a warning, never a failure", () => {
  const { values, warnings } = settings.parseToml("garbage\nscroll.invert = [1]\nscroll.distance = 50");
  assert.deepEqual(values, { "scroll.distance": 50 });
  assert.equal(warnings.length, 2);
});

test("environment beats file beats default, and each value says where it came from", () => {
  const { values, sources } = settings.resolve(
    { "frame_rate.max": 45, "zoom.default": 1.5 },
    { TWEB_FRAME_RATE: "20", HOME: "/h" },
  );
  assert.equal(values["frame_rate.max"], 20);
  assert.equal(sources["frame_rate.max"], "env");
  assert.equal(values["zoom.default"], 1.5);
  assert.equal(sources["zoom.default"], "file");
  assert.equal(values["scroll.invert"], false);
  assert.equal(sources["scroll.invert"], "default");
});

test("the old environment variables keep their old meaning", () => {
  const env = { TWEB_ADAPTIVE_FRAME_RATE: "0", TWEB_DEFAULT_ZOOM: "9", TWEB_IME_SLOT_CELLS: "x", HOME: "/h" };
  const { values, sources } = settings.resolve({}, env);
  // "0" was off and anything else on.
  assert.equal(values["frame_rate.adaptive"], false);
  // Out of range was clamped, not ignored.
  assert.equal(values["zoom.default"], 2);
  // Unparseable was ignored.
  assert.equal(values["ime.slot_cells"], 3);
  assert.equal(sources["ime.slot_cells"], "default");
});

test("a wrong type or an unknown key in the file is reported and ignored", () => {
  const { values, warnings } = settings.resolve({ "scroll.invert": "yes", "scroll.nope": 1 }, { HOME: "/h" });
  assert.equal(values["scroll.invert"], false);
  assert.ok(warnings.some((w) => w.includes("scroll.nope")));
  assert.ok(warnings.some((w) => w.includes("scroll.invert")));
});

test("a path setting expands ~", () => {
  const { values } = settings.resolve({ "downloads.dir": "~/dl" }, { HOME: "/h" });
  assert.equal(values["downloads.dir"], path.join("/h", "dl"));
});

test("the file is found where tweb doctor writes its config", () => {
  assert.equal(settings.configPath({ TWEB_CONFIG_DIR: "/c" }), path.join("/c", "config.toml"));
  assert.equal(settings.configPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" }), path.join("/x", "tweb", "config.toml"));
  assert.equal(settings.configPath({ HOME: "/h" }), path.join("/h", ".config", "tweb", "config.toml"));
});

test("load reads the file through the same layers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tweb-settings-"));
  try {
    fs.writeFileSync(path.join(dir, "config.toml"), "[scroll]\ninvert = true\ndistance = 40\n");
    const loaded = settings.load({ TWEB_CONFIG_DIR: dir, HOME: "/h" });
    assert.equal(loaded.values["scroll.invert"], true);
    assert.equal(loaded.values["scroll.distance"], 40);
    // No file at all is the ordinary case, not an error.
    const empty = settings.load({ TWEB_CONFIG_DIR: path.join(dir, "absent"), HOME: "/h" });
    assert.deepEqual(empty.warnings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every schema entry is complete and its default has its type", () => {
  for (const entry of settings.schema) {
    assert.match(entry.key, /^[a-z_]+\.[a-z_]+$/, entry.key);
    assert.ok(["live", "new-tab", "engine", "pane"].includes(entry.applies), entry.key);
    assert.ok(entry.description, entry.key);
    const typeOk = {
      bool: typeof entry.default === "boolean",
      int: Number.isInteger(entry.default),
      float: typeof entry.default === "number",
      path: typeof entry.default === "string",
    }[entry.type];
    assert.ok(typeOk, `${entry.key} default does not match ${entry.type}`);
  }
});

test("the engine reads each setting where it is used, so a live change needs no restart", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const wheel = main.slice(main.indexOf("function dispatchMouse("), main.indexOf("const button = buttonCode === 0"));
  assert.match(wheel, /settings\.get\("scroll\.invert"\)/);
  assert.match(wheel, /settings\.get\("scroll\.distance"\)/);
  assert.match(main, /columns: settings\.get\("ime\.slot_cells"\)/);
  assert.match(main, /function defaultZoomFactor\(\) \{\s*return settings\.get\("zoom\.default"\);/);
  assert.match(main, /settings\.watch\(/);
  // No setting is still read straight from its environment variable behind the file's back.
  for (const name of ["TWEB_DOWNLOAD_DIR", "TWEB_DEFAULT_ZOOM", "TWEB_IME_SLOT_CELLS", "TWEB_ADAPTIVE_FRAME_RATE"]) {
    assert.ok(!main.includes(`process.env.${name}`), name);
  }
});
