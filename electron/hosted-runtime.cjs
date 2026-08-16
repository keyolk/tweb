"use strict";

// Whether this engine is hosting panes for a supervisor, or serving the one pane that started it.
//
// The two runtimes differ in ways that are invisible until something breaks:
//
//   stdout      A per-pane engine's stdout IS its pane's terminal. A hosted engine's is the
//               supervisor's control pipe, so graphics written there are not a frame, they are a
//               corrupted protocol stream — and the pane stays blank with no error anywhere.
//   identity    A hosted engine's TMUX_PANE, if it has one at all, is the DAEMON's. Measured:
//               an agent socket claimed as `agent-%304.sock`, a name inside an unrelated pane's
//               namespace. Nothing per-pane may be derived from this process.
//   signals     A per-pane engine may signal its frontend to re-declare keyboard mode. A hosted
//               one would signal the supervisor, whose default action for SIGUSR1 is terminate —
//               measured killing the daemon and every other hosted pane with it.
//
// The discriminator is an explicit variable rather than an inference. `twebd` sets
// `TWEB_MULTIPANE=1` when it spawns an engine (`engine_host::start_process`), and inferring it
// instead — "no TWEB_URL", "stdout is not a tty" — would make a mis-detection silent and its
// consequence a blank pane. An engine started by hand for a test is a per-pane engine, which is
// the safe default because it is the path that works without a supervisor.

/**
 * Whether this process was started to host panes.
 *
 * @param {Record<string, string|undefined>} env the environment to read
 */
function isHostedRuntime(env = {}) {
  return env.TWEB_MULTIPANE === "1";
}

/**
 * The host protocol version this engine speaks, or null when it cannot host.
 *
 * Returned as a value rather than written out here so the ONE place that declares capability is
 * a call site the supervisor's handshake can be read against. Declaring it is the LAST wire in
 * the hosting work: an engine that says READY before it can genuinely paint a hosted pane makes
 * `twebd` stop refusing, which takes the frontend's fallback away and leaves a blank pane with
 * no diagnostic. Refusing is safe; a records-only accept is worse than no accept at all.
 *
 * Null until the page host behind it is real and measured.
 */
function hostProtocolVersion() {
  return null;
}

module.exports = { isHostedRuntime, hostProtocolVersion };
