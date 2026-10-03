"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { BINDING_NAME, bridgePrelude, preloadScript } = require("./preload-bridge.cjs");

// The bridge alone, in a fresh context standing in for the isolated world: a binding that records
// what it is called with, and `__twebRequire` handed back so the test can drive the shim.
function bridgeContext() {
  const posted = [];
  const context = { posted, console };
  context.globalThis = context;
  context[BINDING_NAME] = (payload) => posted.push(JSON.parse(payload));
  vm.createContext(context);
  vm.runInContext(`${bridgePrelude()}\nglobalThis.__require = __twebRequire;`, context);
  return context;
}

test("the preload is wrapped unchanged, with require answering electron", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "preload.cjs"), "utf8");
  const script = preloadScript();
  assert.ok(script.includes(source), "the preload body must be embedded byte for byte");
  assert.match(script, /\(function \(require\) \{/);
  // Parses as a script — a syntax slip in the wrapper would take every shortcut down.
  assert.doesNotThrow(() => new vm.Script(script));
});

test("the binding is removed from the world's global once captured", () => {
  const context = bridgeContext();
  assert.strictEqual(context[BINDING_NAME], undefined);
});

test("ipcRenderer.send posts the channel and its arguments", () => {
  const context = bridgeContext();
  const { ipcRenderer } = context.__require("electron");
  ipcRenderer.send("tweb-shortcut", { action: "caret", value: null });
  assert.deepStrictEqual(context.posted, [{ kind: "ipc", channel: "tweb-shortcut", args: [{ action: "caret", value: null }] }]);
});

test("__twebReceive delivers to on() listeners and once() fires a single time", () => {
  const context = bridgeContext();
  const { ipcRenderer } = context.__require("electron");
  const seen = [];
  ipcRenderer.on("tweb-tabs", (_event, model) => seen.push(["on", model.count]));
  ipcRenderer.once("tweb-tabs", (_event, model) => seen.push(["once", model.count]));
  context.__twebReceive("tweb-tabs", [{ count: 1 }]);
  context.__twebReceive("tweb-tabs", [{ count: 2 }]);
  assert.deepStrictEqual(seen, [["on", 1], ["once", 1], ["on", 2]]);
});

test("webFrame.executeJavaScript round-trips through the engine", async () => {
  const context = bridgeContext();
  const { webFrame } = context.__require("electron");
  const pending = webFrame.executeJavaScript("1 + 1");
  const request = context.posted.at(-1);
  assert.strictEqual(request.kind, "main-eval");
  assert.strictEqual(request.code, "1 + 1");
  context.__twebReceive("\u0000eval", [request.id, null, 2]);
  assert.strictEqual(await pending, 2);
});

test("an unknown module still fails loudly, as Electron's sandboxed require does", () => {
  const context = bridgeContext();
  assert.throws(() => context.__require("./command-line.cjs"), /module not found/);
});
