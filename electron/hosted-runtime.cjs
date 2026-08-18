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
 * Returned as a value rather than written out here so the ONE place that declares capability is a
 * call site the supervisor's handshake can be read against. This was the LAST wire in the hosting
 * work, and it stayed null while the host could not genuinely paint: an engine that says READY too
 * early makes `twebd` stop refusing, which takes the frontend's fallback away and leaves a blank
 * pane with no diagnostic. That state was observed during #28 with `make check` green.
 *
 * It is 2 now because the host serves N panes and the measurement says so rather than this comment:
 * `bench/host-multipane.py` runs five panes in one engine and gates on each rendering its own image
 * id, no crossed frames, no pane resolved by falling back to the first, its own tmux placement and
 * client set, input parsed per pane, modes isolated, and a detached pane's windows torn down while
 * the others keep running — every gate verified to fail when the state it guards is shared again.
 *
 * The number must equal `PROTOCOL_VERSION` in `crates/twebd/src/protocol.rs`, and only string
 * equality links them, so a test in `preload-regression.test.cjs` reads that file and compares.
 * The daemon refuses any other value (`engine_host::spawn_engine`), and refusal means the pane
 * spawns its own engine and works — so a mismatch degrades rather than blanking a pane.
 */
function hostProtocolVersion() {
  return 2;
}

module.exports = { isHostedRuntime, hostProtocolVersion };
