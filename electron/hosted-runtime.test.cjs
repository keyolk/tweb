"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { isHostedRuntime, hostProtocolVersion } = require("./hosted-runtime.cjs");

test("the supervisor's variable is what says this engine hosts panes", () => {
  // `twebd::engine_host::start_process` sets exactly this.
  assert.equal(isHostedRuntime({ TWEB_MULTIPANE: "1" }), true);
});

// Inferring it would make a mis-detection silent, and its consequence is a pane that stays
// blank: a hosted engine that believed it was per-pane would paint into the control pipe.
test("nothing else is read as hosting", () => {
  assert.equal(isHostedRuntime({}), false);
  assert.equal(isHostedRuntime(), false);
  assert.equal(isHostedRuntime({ TWEB_MULTIPANE: "0" }), false);
  assert.equal(isHostedRuntime({ TWEB_MULTIPANE: "" }), false);
  assert.equal(isHostedRuntime({ TWEB_MULTIPANE: "true" }), false);
  // The supervisor also passes these, and neither means "host panes" on its own — a per-pane
  // engine started by a frontend has TWEB_FRONTEND_PID too.
  assert.equal(isHostedRuntime({ TWEB_SUPERVISOR_PID: "4242" }), false);
  assert.equal(isHostedRuntime({ TWEB_FRONTEND_PID: "4242" }), false);
});

// THE GATE, now open. An engine that declares a host protocol makes `twebd` stop refusing the
// attach, which takes the frontend's fallback away — so this stayed null while a hosted pane could
// not genuinely render, a state observed during #28 with `make check` green.
//
// What replaced "it must be null" is not "it must be 2" for its own sake: the number is only
// meaningful if the daemon accepts it, and the daemon accepts exactly `PROTOCOL_VERSION`. That
// agreement is asserted against the Rust source in `preload-regression.test.cjs`, because only
// string equality links the two languages. Here the invariant is narrower and still worth pinning:
// a version at all, and a whole positive one, since `parse_event` parses it as an integer and a
// float or a string would come back as `None` — an engine the daemon silently never sees as ready.
test("the engine declares a whole, positive host protocol version", () => {
  const version = hostProtocolVersion();
  assert.notEqual(version, null, "the host protocol is declared now that N panes render");
  assert.equal(typeof version, "number");
  assert.ok(Number.isInteger(version) && version > 0,
    `the daemon parses this as an integer, got ${version}`);
});

// The declaration is one line on stdout that the supervisor's handshake waits for, and it must be
// written from ONE place: an engine that declares itself twice, or from a module that runs before
// the host is ready to receive an attach, races the daemon's first ATTACH into a refusal.
test("exactly one place declares READY, and it carries the version", () => {
  const writers = [];
  for (const name of fs.readdirSync(__dirname)) {
    if (!name.endsWith(".cjs") || name.endsWith(".test.cjs")) continue;
    const source = fs.readFileSync(path.join(__dirname, name), "utf8");
    for (const match of source.matchAll(/["'`]READY [^"'`]*["'`]/g)) {
      writers.push({ name, text: match[0] });
    }
  }
  assert.equal(writers.length, 1,
    `exactly one declaration expected, found ${JSON.stringify(writers)}`);
  assert.equal(writers[0].name, "main.cjs");
  // Interpolated rather than hardcoded, so the version cannot drift from the one function that
  // answers for it.
  assert.match(writers[0].text, /READY \$\{protocol\}/);
  // The daemon reads this with `lines()`, so a declaration without a newline hangs its handshake
  // until some later line flushes it — a ten-second stall instead of an attach.
  assert.match(writers[0].text, /\\n/);
});
