"use strict";

function visibleTmuxClientTtys(stdout, identity) {
  const visible = new Set();
  if (!identity?.session || !identity?.windowId || !identity?.paneId) return visible;

  for (const line of stdout.trim().split("\n")) {
    const [tty, session, windowId, zoomed, activePane] = line.split("\t");
    if (!tty || session !== identity.session || windowId !== identity.windowId) continue;
    // A zoomed window still has the same window id, but only its active pane is on
    // screen. Treat every other pane as hidden for this client.
    if (zoomed === "1" && activePane !== identity.paneId) continue;
    visible.add(tty);
  }
  return visible;
}

// What a new client set means for the image already on the terminals.
//
// `evicted` are the clients that stopped showing the pane. The engine writes the delete straight
// to each one's tty, which is immediate but bypasses tmux. Frames the pane wrote just before the
// switch can still be queued on the way through tmux (the pane pty, and under twebd the frontend
// as well). They reach the client after that direct delete, and with `allow-passthrough=all` tmux
// still forwards them, because the client's session holds the pane's window. The page was then
// left drawn over the window the client switched to, with nothing left to delete it.
//
// `deleteInBand` asks for a second delete through the pane's own output. That path is ordered
// behind every frame already written, so it lands after the last one. Only when NO client shows
// the pane any more: tmux forwards the in-band delete to every client of the session, so it would
// blank the pane for a client that is still watching it.
function hideTransition(previousTtys, nextTtys) {
  const evicted = [...previousTtys].filter((tty) => !nextTtys.has(tty));
  return { evicted, deleteInBand: evicted.length > 0 && nextTtys.size === 0 };
}

module.exports = { visibleTmuxClientTtys, parseVisibilityPush, hideTransition };

// --- the frontend's visibility push ---
//
// DESIGN.md 5.2 makes `tweb __pane` the owner of the pane visibility lifecycle, so it
// probes tmux on its tick and hex-encodes the raw result onto the control channel. The
// engine parses it here and keeps deciding for itself what the clients mean — the zoom
// rule above is the tested one and is not reimplemented on the Rust side.
//
// Payload: a placement line (`session`, `window_id`, `pane_id`), then one line per client
// in the field order `visibleTmuxClientTtys` already reads, with `client_key_table`
// appended. The extra field is why the engine can also reconcile its passthrough tables
// from the push instead of running `list-clients` itself; `visibleTmuxClientTtys`
// destructures the first five and ignores it.
//
// The placement line is what preserves survival across `break-pane`/`join-pane`: the
// frontend re-resolves it through `-t <pane id>` on every tick, so a pane that keeps its
// id but changes window arrives here with its new window, exactly as the engine's own
// re-resolving poll used to produce.
function parseVisibilityPush(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const lines = Buffer.from(hex, "hex").toString("utf8").split("\n");
  const [session, windowId, paneId] = (lines[0] || "").split("\t");
  if (!session || !windowId || !paneId) return null;

  const states = new Map();
  for (const line of lines.slice(1)) {
    const [tty, clientSession, clientWindowId, zoomed, activePane, keyTable] = line.split("\t");
    if (!tty) continue;
    states.set(tty, {
      session: clientSession,
      windowId: clientWindowId,
      zoomed,
      paneId: activePane,
      keyTable: keyTable || "root",
    });
  }
  return {
    placement: { session, windowId, paneId },
    clients: lines.slice(1).join("\n"),
    states,
  };
}
