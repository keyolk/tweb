"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { waitFor } = require("./agent-wait.cjs");

// A page whose state the test advances: `appearsAfter` probes in, the selector starts to match and
// the URL changes — the shape of a React SPA that renders after its first document load.
function fakePage({ appearsAfter = Infinity, throwInfoFor = 0 } = {}) {
  let probes = 0;
  const ready = () => probes >= appearsAfter;
  return {
    probes: () => probes,
    info: async () => {
      probes += 1;
      // A navigation in flight: the old document is gone and the new one has no preload yet.
      if (probes <= throwInfoFor) throw new Error("page did not answer info within 10000ms");
      return { url: ready() ? "https://app.test/expenses/1" : "https://app.test/reports/1", readyState: "complete" };
    },
    query: async (selector) => {
      if (!ready()) throw new Error(`no element matches ${JSON.stringify(selector)}`);
      return { node: { ref: "q0", selector } };
    },
    hasText: async () => ready(),
  };
}

// What the CLI actually sends: clap leaves an omitted `--ms` as None, serde writes it as null.
// The MCP server omits absent fields instead, which is why only the CLI ever hit this.
const cli = (params) => ({ selector: null, text: null, url: null, load: false, ms: null, timeout: 10000, ...params });

test("a selector that never appears times out instead of succeeding", async () => {
  const page = fakePage();
  await assert.rejects(
    waitFor(cli({ selector: "[data-nuiexp=vendor-name]", timeout: 300 }), page),
    /timed out after 300ms waiting for selector \[data-nuiexp=vendor-name\]/,
  );
  assert.ok(page.probes() > 1, "the page has to be polled, not checked once");
});

test("a URL that never matches times out instead of succeeding", async () => {
  await assert.rejects(
    waitFor(cli({ url: "/expenses/", timeout: 300 }), fakePage()),
    /timed out after 300ms waiting for url containing \/expenses\//,
  );
});

test("a selector rendered after load is waited for", async () => {
  const page = fakePage({ appearsAfter: 4 });
  const result = await waitFor(cli({ selector: "[data-nuiexp=vendor-name]", timeout: 5000 }), page);
  assert.equal(result.node.selector, "[data-nuiexp=vendor-name]");
  assert.ok(page.probes() >= 4);
});

test("a pushState URL change is waited for", async () => {
  const result = await waitFor(cli({ url: "/expenses/", timeout: 5000 }), fakePage({ appearsAfter: 3 }));
  assert.equal(result.url, "https://app.test/expenses/1");
});

test("a page between documents is polled again rather than failing the wait", async () => {
  const result = await waitFor(cli({ selector: "#row", timeout: 5000 }), fakePage({ appearsAfter: 3, throwInfoFor: 2 }));
  assert.equal(result.node.selector, "#row");
});

// Measured on SAP Concur in a narrow pane: nine `[data-nuiexp=vendor-name]` rows rendered at
// y=536 in a 320px viewport, and the wait ran out its 30s reporting "is not visible". Rendered
// below the fold is rendered — the caller scrolls or clicks next, and both work on such a row.
test("a selector waits for the element to render, not to scroll into view", async () => {
  const asked = [];
  const page = {
    info: async () => ({ url: "https://app.test/", readyState: "complete" }),
    query: async (selector, options) => {
      asked.push(options);
      if (!options?.rendered) throw new Error(`${JSON.stringify(selector)} is not visible`);
      return { node: { ref: "q0", selector, rect: { y: 536 } } };
    },
    hasText: async () => false,
  };
  const result = await waitFor(cli({ selector: "[data-nuiexp=vendor-name]", timeout: 300 }), page);
  assert.equal(result.node.rect.y, 536);
  assert.deepEqual(asked[0], { rendered: true });
});

test("--ms still waits a fixed time", async () => {
  const started = Date.now();
  assert.deepEqual(await waitFor(cli({ ms: 120 }), fakePage()), { waited: 120 });
  assert.ok(Date.now() - started >= 100);
});

test("a wait with no condition is refused rather than reported as met", async () => {
  await assert.rejects(waitFor(cli({}), fakePage()), /nothing to wait for/);
});
