"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { CdpEngine, isForeignTab } = require("./engine.cjs");
const { handOffToUserChrome } = require("./connection.cjs");

const page = (fields) => ({ type: "page", targetId: "T", url: "https://example.com/", attached: false, ...fields });

test("an unattached http(s) page with no opener is a tab opened from outside tweb", () => {
  assert.strictEqual(isForeignTab(page({})), true);
  assert.strictEqual(isForeignTab(page({ url: "HTTP://example.com/" })), true);
});

test("tweb's own tabs, popups and Chrome's internal pages are not foreign", () => {
  // Every pane's tab is attached before it leaves about:blank, including another pane's.
  assert.strictEqual(isForeignTab(page({ attached: true })), false);
  assert.strictEqual(isForeignTab(page({ url: "about:blank" })), false);
  // window.open / target=_blank: handled by the popup path.
  assert.strictEqual(isForeignTab(page({ openerId: "O" })), false);
  assert.strictEqual(isForeignTab(page({ url: "chrome://newtab/" })), false);
  assert.strictEqual(isForeignTab(page({ url: "chrome-extension://abc/bg.html" })), false);
  assert.strictEqual(isForeignTab(page({ type: "service_worker" })), false);
  // A target reported without the field is not treated as unattached.
  assert.strictEqual(isForeignTab({ type: "page", targetId: "T", url: "https://example.com/" }), false);
});

test("the hand-off runs the installed Chrome on its default profile, detached, ignoring TWEB_CHROME", () => {
  const calls = [];
  const fakeChild = { on() {}, unref() { calls.push("unref"); } };
  const spawnFn = (binary, args, options) => { calls.push({ binary, args, options }); return fakeChild; };
  const prev = process.env.TWEB_CHROME;
  process.env.TWEB_CHROME = "/opt/chrome-for-testing";
  try {
    const ok = handOffToUserChrome("https://example.com/x", {
      exists: (candidate) => candidate.includes("Google Chrome.app"), spawnFn,
    });
    assert.strictEqual(ok, true);
  } finally {
    if (prev === undefined) delete process.env.TWEB_CHROME; else process.env.TWEB_CHROME = prev;
  }
  assert.match(calls[0].binary, /Google Chrome\.app/);
  // No --user-data-dir: that is what makes Chrome's singleton pass the url on.
  assert.deepStrictEqual(calls[0].args, ["https://example.com/x"]);
  assert.strictEqual(calls[0].options.detached, true);
  assert.strictEqual(calls[0].options.stdio, "ignore");
  assert.strictEqual(calls[1], "unref");
  assert.strictEqual(handOffToUserChrome("https://example.com/", { exists: () => false, spawnFn }), false);
});

// Two panes, two engines, one Chrome: both see the tab, Chrome lets one close succeed.
test("a foreign tab seen by every pane is handed on once and closed", async () => {
  const closed = new Set();
  const chrome = {
    async send(method, params) {
      assert.strictEqual(method, "Target.closeTarget");
      if (closed.has(params.targetId)) throw new Error("No target with given id found");
      closed.add(params.targetId);
      return { success: true };
    },
  };
  const handed = [];
  const engines = [0, 1].map(() => {
    const engine = new CdpEngine({ userDataDir: "/tmp/x" });
    engine.connection = chrome;
    engine.handOff = (url) => { handed.push(url); return true; };
    return engine;
  });
  const info = page({ targetId: "F1", url: "https://sendbird.okta.com/app/x" });
  await Promise.all([
    engines[0].forwardForeignTab(info),
    engines[1].forwardForeignTab(info),
    // The same engine hearing it again (targetCreated, then targetInfoChanged).
    engines[0].forwardForeignTab(info),
  ]);
  assert.deepStrictEqual(handed, ["https://sendbird.okta.com/app/x"]);
  assert.deepStrictEqual([...closed], ["F1"]);
});

test("targetCreated and targetInfoChanged route a foreign tab to the hand-off, and leave popups alone", async () => {
  const engine = new CdpEngine({ userDataDir: "/tmp/x" });
  const sent = [];
  engine.connection = { async send(method, params) { sent.push([method, params.targetId]); return { success: true }; } };
  const handed = [];
  engine.handOff = (url) => { handed.push(url); return true; };
  engine.onTargetCreated(page({ targetId: "A", url: "" }));
  engine.onTargetInfoChanged(page({ targetId: "A", url: "https://example.com/a" }));
  engine.onTargetCreated(page({ targetId: "B", url: "https://example.com/b" }));
  // Another pane's tab after it navigated: attached, so never closed.
  engine.onTargetInfoChanged(page({ targetId: "C", url: "https://example.com/c", attached: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(handed, ["https://example.com/a", "https://example.com/b"]);
  assert.deepStrictEqual(sent, [["Target.closeTarget", "A"], ["Target.closeTarget", "B"]]);
});
