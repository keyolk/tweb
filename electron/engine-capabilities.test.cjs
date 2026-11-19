"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { CAPABILITIES, capability, declareCapabilities } = require("./engine-capabilities.cjs");

// Electron's own webContents declares nothing, so every capability reads as the Electron baseline.
test("an engine that declares nothing reads as Electron", () => {
  for (const [name, type] of Object.entries(CAPABILITIES)) {
    assert.equal(capability({}, name), type === "boolean" ? false : null, name);
    assert.equal(capability(null, name), type === "boolean" ? false : null, name);
  }
});

test("a declared capability reads back as declared", () => {
  const contents = { capabilities: declareCapabilities({ hitTestsFrames: true, inspectorName: "DevTools" }) };
  assert.equal(capability(contents, "hitTestsFrames"), true);
  assert.equal(capability(contents, "inspectorName"), "DevTools");
  assert.equal(capability(contents, "keepsSizeInStandby"), false);
});

// A misspelt name would otherwise read as "off" and quietly take the Electron path.
test("an unknown name is refused when read and when declared", () => {
  assert.throws(() => capability({}, "hitTestFrames"), /unknown engine capability: hitTestFrames/);
  assert.throws(() => declareCapabilities({ hitTestFrames: true }), /unknown engine capability/);
  assert.throws(() => declareCapabilities({ hitTestsFrames: "yes" }), /must be a boolean/);
});

// Each engine's contents constructs its declaration through `declareCapabilities`, so loading the
// module would throw on a bad name; this reads the source because constructing either needs a
// live engine. What each engine claims is pinned here so a change to it is a visible decision.
test("the Chrome and WebKit contents declare what they depart from Electron in", () => {
  const declared = (file) => {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    const block = source.match(/this\.capabilities = declareCapabilities\(\{([^]*?)\n\s*\}\);/);
    assert.ok(block, `${file} declares its capabilities`);
    return [...block[1].matchAll(/^\s*(\w+): /gm)].map((match) => match[1]).sort();
  };
  const chrome = declared("cdp/web-contents.cjs");
  const webkit = declared("webkit/web-contents.cjs");
  for (const name of [...chrome, ...webkit]) assert.ok(CAPABILITIES[name], `${name} is listed`);
  assert.deepEqual(chrome, Object.keys(CAPABILITIES).sort());
  assert.deepEqual(webkit, ["focusedFrameIsMainOnly", "hitTestsFrames", "inspectorName"]);
});

// The convention this module exists for: main.cjs asks a capability, not an engine's name. A fix
// written behind `tabEngine(tab) === "chrome"` is how Electron's frame routing ended up on Chrome
// (#278). The functions below compare names because choosing an engine is their job, or because
// they hold a whole per-engine implementation; anything else should declare a capability.
test("main.cjs compares engine names only where an engine is chosen", () => {
  const ALLOWED = new Map([
    // --ssh panes stay on Electron: the remote host has no Chrome or WebKit to drive.
    ["switchTabEngine", "remote"],
    ["dispatchAgentCommand", "remote"],
    ["serveLocalMarkdown", "remote"],
    // One implementation per engine: Electron's session API, CDP storage calls, none on WebKit.
    ["clearBrowsingData", "per-engine implementation"],
  ]);
  const lines = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8").split("\n");
  const offenders = [];
  let owner = null;
  lines.forEach((line, index) => {
    const start = line.match(/^(?:async )?function (\w+)/);
    if (start) owner = start[1];
    if (/[!=]==\s*"(?:electron|chrome|webkit)"/.test(line) && !ALLOWED.has(owner)) {
      offenders.push(`main.cjs:${index + 1} (${owner}): ${line.trim()}`);
    }
  });
  assert.deepEqual(offenders, [], "declare a capability in engine-capabilities.cjs instead");
});
