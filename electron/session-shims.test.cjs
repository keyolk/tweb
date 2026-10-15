"use strict";

// The Chrome and WebKit engines stand in for Electron's `session.defaultSession.webRequest`.
// main.cjs calls it once at startup, so a method missing from a shim is not a missing feature
// but a TypeError that ends the engine's startup: measured when the recorder began calling
// `onErrorOccurred` — the Chrome engine pane opened no page and its agent socket refused every
// connection.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { CdpEngine } = require("./cdp/engine.cjs");
const { WebKitEngine } = require("./webkit/engine.cjs");

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
const calledOnWebRequest = [...new Set(
  [...main.matchAll(/webRequest\.(on[A-Z]\w*)/g)].map((match) => match[1]),
)];

const engines = {
  chrome: () => new CdpEngine({ userDataDir: "/nonexistent", nativeImage: null, clipboard: null }),
  webkit: () => new WebKitEngine({ nativeImage: null, clipboard: null }),
};

test("every webRequest method main.cjs calls exists on both page engines' sessions", () => {
  assert.ok(calledOnWebRequest.includes("onErrorOccurred"), calledOnWebRequest.join(","));
  for (const [name, make] of Object.entries(engines)) {
    const { webRequest } = make().session();
    for (const method of calledOnWebRequest) {
      assert.equal(typeof webRequest[method], "function", `${name} session lacks webRequest.${method}`);
    }
  }
});

test("Chrome request events name their tab, and a failure reaches onErrorOccurred", () => {
  const engine = engines.chrome();
  const { webRequest } = engine.session();
  const seen = { before: [], completed: [], errors: [] };
  webRequest.onBeforeRequest((details) => seen.before.push(details));
  webRequest.onCompleted((details) => seen.completed.push(details));
  webRequest.onErrorOccurred((details) => seen.errors.push(details));
  const contents = { id: "TARGET-1" };
  engine.onRequest(contents, { requestId: "r1", request: { url: "https://a.test/x.json", method: "POST" }, type: "Fetch" });
  engine.onResponse(contents, { requestId: "r1", response: { status: 404, url: "https://a.test/x.json" } });
  engine.onRequestFailed(contents, { requestId: "r2", errorText: "net::ERR_NAME_NOT_RESOLVED" });
  assert.equal(seen.before[0].webContentsId, "TARGET-1");
  assert.equal(seen.before[0].method, "POST");
  assert.deepEqual(
    { id: seen.completed[0].id, statusCode: seen.completed[0].statusCode, url: seen.completed[0].url,
      webContentsId: seen.completed[0].webContentsId },
    { id: "r1", statusCode: 404, url: "https://a.test/x.json", webContentsId: "TARGET-1" },
  );
  // The network log still sees the failure as a completion with no status, as before.
  assert.equal(seen.completed[1].statusCode, 0);
  assert.deepEqual(seen.errors, [{ id: "r2", webContentsId: "TARGET-1", error: "net::ERR_NAME_NOT_RESOLVED" }]);
});

test("the WebKit session says it sees no requests, rather than reporting none", () => {
  assert.equal(engines.webkit().session().webRequest.observesRequests, false);
  assert.notEqual(engines.chrome().session().webRequest.observesRequests, false);
  // The recorder lists that limit from this flag (main.cjs `recordingLimits`).
  assert.match(main, /webRequest\?\.observesRequests === false/);
});
