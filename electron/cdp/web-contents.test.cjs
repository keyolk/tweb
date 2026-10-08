"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { CdpWebContents } = require("./web-contents.cjs");

// Just enough of an engine to construct contents and feed it Page events by hand.
function contents() {
  const engine = { connection: { send: async () => ({}) }, windowFor: () => null };
  const session = { id: "S", on() {}, send: async () => ({}) };
  const created = new CdpWebContents(engine, "MAIN", session);
  created.navigationHistory.refresh = async () => {};
  const navigations = [];
  created.on("did-start-navigation", (details) => navigations.push(details));
  return { created, navigations };
}

// The event order measured from Chrome over CDP for `history.pushState`:
//   frameStartedLoading → navigatedWithinDocument → frameStoppedLoading
// and for a real document load:
//   frameStartedNavigating → frameStartedLoading → frameNavigated → ... → frameStoppedLoading
// Reporting the first as a new document made main.cjs drop the main frame from its ready set,
// and with no new preload to re-register it, every agent request (`snapshot`, `query`, the probes
// `tweb wait` polls) went unanswered for good — measured on SAP Concur, a React SPA.
test("a pushState is not reported as a new document", () => {
  const { created, navigations } = contents();
  created.onFrameStartedLoading({ frameId: "MAIN" }, "S");
  created.onNavigatedWithinDocument({ frameId: "MAIN", url: "https://app.test/expenses/1" });
  created.onFrameStoppedLoading({ frameId: "MAIN" });
  assert.strictEqual(navigations.length, 1);
  assert.strictEqual(navigations[0].isSameDocument, true);
});

test("a real document load is still reported as one", () => {
  const { created, navigations } = contents();
  created.onFrameStartedNavigating({ frameId: "MAIN", url: "https://app.test/", navigationType: "differentDocument" }, "S");
  created.onFrameStartedLoading({ frameId: "MAIN" }, "S");
  assert.strictEqual(navigations.length, 1);
  assert.strictEqual(navigations[0].isSameDocument, false);
  assert.strictEqual(navigations[0].isMainFrame, true);
});
