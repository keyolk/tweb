"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { visibleTmuxClientTtys, parseVisibilityPush } = require("./tmux-visibility.cjs");

const identity = { session: "work", windowId: "@3", paneId: "%7" };

function visible(...lines) {
  return [...visibleTmuxClientTtys(lines.join("\n"), identity)];
}

test("an unzoomed client shows every pane in its current window", () => {
  assert.deepEqual(visible("/dev/ttys001\twork\t@3\t0\t%9"), ["/dev/ttys001"]);
});

test("a client zoomed into the browser pane still shows it", () => {
  assert.deepEqual(visible("/dev/ttys001\twork\t@3\t1\t%7"), ["/dev/ttys001"]);
});

test("a client zoomed into another pane hides the browser pane", () => {
  assert.deepEqual(visible("/dev/ttys001\twork\t@3\t1\t%9"), []);
});

test("visibility is tracked independently for each attached client", () => {
  assert.deepEqual(visible(
    "/dev/ttys001\twork\t@3\t1\t%9",
    "/dev/ttys002\twork\t@3\t0\t%9",
    "/dev/ttys003\twork\t@4\t0\t%7",
    "/dev/ttys004\tother\t@3\t0\t%7",
  ), ["/dev/ttys002"]);
});

// break-pane gives the pane a new window id and join-pane can change its session
// too, while the pane id stays the same. Matching against where the pane started
// then misses every client, the pane looks hidden, and painting stops — it froze
// after being moved. The caller has to pass the pane's live placement.
test("a moved pane is visible once matched against its current window", () => {
  const moved = { session: "work", windowId: "@11", paneId: "%7" };
  const clients = "/dev/ttys001\twork\t@11\t0\t%7";
  assert.deepEqual([...visibleTmuxClientTtys(clients, identity)], [],
    "the startup window no longer matches, which is the bug being guarded");
  assert.deepEqual([...visibleTmuxClientTtys(clients, moved)], ["/dev/ttys001"]);
});

test("a pane joined into another session is visible under that session", () => {
  const joined = { session: "other", windowId: "@2", paneId: "%7" };
  const clients = "/dev/ttys001\tother\t@2\t0\t%7";
  assert.deepEqual([...visibleTmuxClientTtys(clients, joined)], ["/dev/ttys001"]);
});

// --- the frontend's visibility push ---

const encode = (payload) => Buffer.from(payload, "utf8").toString("hex");

test("a push carries the placement, the raw client lines and the key tables", () => {
  const push = parseVisibilityPush(encode(
    "work\t@3\t%7\n"
    + "/dev/ttys001\twork\t@3\t0\t%7\troot\n"
    + "/dev/ttys002\twork\t@3\t1\t%9\ttweb-pass"
  ));
  assert.deepEqual(push.placement, { session: "work", windowId: "@3", paneId: "%7" });
  assert.deepEqual(push.states.get("/dev/ttys002"), {
    session: "work", windowId: "@3", zoomed: "1", paneId: "%9", keyTable: "tweb-pass",
  });
  // The client half feeds visibleTmuxClientTtys unchanged: it reads five fields and the
  // sixth (client_key_table) rides along for the passthrough reconcile.
  assert.deepEqual([...visibleTmuxClientTtys(push.clients, push.placement)], ["/dev/ttys001"]);
});

test("a client with no key table is treated as being on the root table", () => {
  const push = parseVisibilityPush(encode("work\t@3\t%7\n/dev/ttys001\twork\t@3\t0\t%7"));
  assert.equal(push.states.get("/dev/ttys001").keyTable, "root");
});

test("a push with no clients is a pane nobody is looking at", () => {
  const push = parseVisibilityPush(encode("work\t@3\t%7"));
  assert.equal(push.states.size, 0);
  assert.deepEqual([...visibleTmuxClientTtys(push.clients, push.placement)], []);
});

// The engine must not act on half a payload: an incomplete placement would be applied as
// "no client can see this pane", which stops painting.
test("a push without a resolved placement is refused", () => {
  assert.equal(parseVisibilityPush(encode("work\t@3")), null);
  assert.equal(parseVisibilityPush(encode("")), null);
});

test("a malformed hex payload is refused rather than half-decoded", () => {
  assert.equal(parseVisibilityPush("abc"), null);
  assert.equal(parseVisibilityPush("zz"), null);
  assert.equal(parseVisibilityPush(undefined), null);
});

// break-pane moves the pane to @11 while it keeps %7. The frontend re-resolves placement
// through `-t %7` every tick, so the push arrives already carrying the new window and the
// engine matches clients against it — the same survival the engine's own poll provided.
test("a pushed placement follows a pane moved to another window", () => {
  const push = parseVisibilityPush(encode("work\t@11\t%7\n/dev/ttys001\twork\t@11\t0\t%7\troot"));
  assert.deepEqual(push.placement, { session: "work", windowId: "@11", paneId: "%7" });
  assert.deepEqual([...visibleTmuxClientTtys(push.clients, push.placement)], ["/dev/ttys001"]);
});

test("a pushed placement follows a pane joined into another session", () => {
  const push = parseVisibilityPush(encode("other\t@2\t%7\n/dev/ttys001\tother\t@2\t0\t%7\troot"));
  assert.deepEqual([...visibleTmuxClientTtys(push.clients, push.placement)], ["/dev/ttys001"]);
});
