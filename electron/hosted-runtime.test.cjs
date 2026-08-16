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

// THE GATE. An engine that declares a host protocol makes `twebd` stop refusing the attach,
// which takes the frontend's fallback away. Declaring it before a hosted pane genuinely renders
// produces a blank pane with no diagnostic — the one unacceptable outcome, and the state
// actually observed during #28 while `make check` was green.
test("no host protocol is declared until there is a page host behind it", () => {
  assert.equal(hostProtocolVersion(), null);
});

// The declaration is a single line on stdout that the supervisor's handshake waits for. As long
// as nothing writes it, the gate cannot be opened by accident from somewhere else in the engine.
test("nothing in the engine writes a READY line", () => {
  for (const name of fs.readdirSync(__dirname)) {
    if (!name.endsWith(".cjs") || name.endsWith(".test.cjs")) continue;
    const source = fs.readFileSync(path.join(__dirname, name), "utf8");
    assert.doesNotMatch(source, /["'`]READY /,
      `${name} must not declare a host protocol while hostProtocolVersion() is null`);
  }
});
