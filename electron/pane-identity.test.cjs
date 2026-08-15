"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  serverIdentityFrom, paneKey, parsePaneKey, generationIsCurrent,
} = require("./pane-identity.cjs");

test("the server identity keeps the socket and the server pid", () => {
  // Same value twebd::tmux::server_identity_from produces, because the two sides must key
  // a pane identically or they disagree about which pane a message is for.
  assert.equal(serverIdentityFrom("/tmp/tmux-501/default,12345,0"), "/tmp/tmux-501/default,12345");
});

test("the session index is dropped, because it moves when sessions come and go", () => {
  assert.equal(
    serverIdentityFrom("/tmp/tmux-501/default,12345,0"),
    serverIdentityFrom("/tmp/tmux-501/default,12345,4")
  );
});

test("a restarted server on the same socket is a different identity", () => {
  assert.notEqual(
    serverIdentityFrom("/tmp/tmux-501/default,111,0"),
    serverIdentityFrom("/tmp/tmux-501/default,222,0")
  );
});

test("a value that is not a $TMUX yields no identity", () => {
  for (const value of [null, undefined, "", "   ", ",123,0", "/tmp/sock", 42]) {
    assert.equal(serverIdentityFrom(value), null);
  }
});

test("two tmux servers reissuing the same pane id do not collide", () => {
  const left = paneKey(serverIdentityFrom("/tmp/a,111,0"), "%0", 1);
  const right = paneKey(serverIdentityFrom("/tmp/b,222,0"), "%0", 1);
  assert.notEqual(left, right);
});

test("a reused pane id is separated by its generation", () => {
  // The whole reason a generation exists: two panes that were never alive at once share an id.
  const server = serverIdentityFrom("/tmp/tmux-501/default,12345,0");
  assert.notEqual(paneKey(server, "%3", 1), paneKey(server, "%3", 2));
});

test("a bare terminal still gets a key, and it cannot be read as a socket path", () => {
  assert.equal(paneKey(null, "%0", 0), "local/%0/0");
});

test("a key without a pane id or a usable generation is a programming error", () => {
  assert.throws(() => paneKey("srv", "", 1), TypeError);
  assert.throws(() => paneKey("srv", null, 1), TypeError);
  assert.throws(() => paneKey("srv", "%1", -1), TypeError);
  assert.throws(() => paneKey("srv", "%1", 1.5), TypeError);
  assert.throws(() => paneKey("srv", "%1", "nope"), TypeError);
});

test("a key round-trips through its parts, socket paths with commas included", () => {
  const server = serverIdentityFrom("/tmp/tmux-501/default,12345,0");
  assert.deepEqual(parsePaneKey(paneKey(server, "%42", 7)), {
    tmuxServer: server, paneId: "%42", generation: 7,
  });
  assert.deepEqual(parsePaneKey(paneKey(null, "%0", 0)), {
    tmuxServer: null, paneId: "%0", generation: 0,
  });
});

test("an unparseable key is null rather than a half-filled record", () => {
  for (const value of [null, undefined, "", "nokeyhere", "srv/%1", "srv/%1/notanumber", "srv//3"]) {
    assert.equal(parsePaneKey(value), null);
  }
});

test("a stale generation is not current, and neither is an absent registration", () => {
  assert.equal(generationIsCurrent(5, 5), true);
  assert.equal(generationIsCurrent(5, 4), false);
  assert.equal(generationIsCurrent(undefined, 5), false);
  assert.equal(generationIsCurrent(null, 5), false);
});
