"use strict";

// How a pane is named, on both sides of the boundary.
//
// twebd keys a pane on (tmux server identity, pane id, generation) and the engine has to agree
// with it exactly, or the two disagree about which pane a message is for at precisely the moment
// it matters — a reused id. The parts, and why each is load-bearing:
//
//   tmux server  `$TMUX` is `socket-path,server-pid,session-index`; the socket path and the
//                server pid together name the server. The session index is positional and moves
//                when sessions come and go, so it is dropped. Without the server in the key, a
//                second tmux server reissuing `%0` collides with the first.
//   pane id      what a user names a pane by, and the only part that is human-facing.
//   generation   tmux reuses pane ids. Two panes that were never alive at the same time share an
//                id, and the generation is the only thing that separates them. It is assigned by
//                twebd, never invented here, so both sides count the same sequence.

/**
 * The tmux server identity out of a `$TMUX` value.
 *
 * Mirrors `twebd::tmux::server_identity_from`, including its rejections — an empty socket path
 * is not an identity, and a missing server pid means the value was not a `$TMUX` at all.
 *
 * @returns {string|null} `socket-path,server-pid`, or null when there is no usable identity
 */
function serverIdentityFrom(tmux) {
  if (typeof tmux !== "string") return null;
  const parts = tmux.split(",");
  if (parts.length < 2) return null;
  const socket = parts[0].trim();
  const serverPid = parts[1].trim();
  if (!socket || !serverPid) return null;
  return `${socket},${serverPid}`;
}

/**
 * The key a pane is registered under.
 *
 * The generation is deliberately part of the string rather than a field beside it: a stale
 * message from a dead pane then cannot be delivered to its successor by a lookup that happened
 * to forget to compare generations. Getting it wrong becomes a miss, not a mis-delivery.
 *
 * @param {string|null} tmuxServer identity from `serverIdentityFrom`, or null outside tmux
 * @param {string} paneId a tmux pane id such as `%3`
 * @param {number} generation the registration generation from the supervisor
 */
function paneKey(tmuxServer, paneId, generation) {
  const pane = String(paneId || "").trim();
  if (!pane) throw new TypeError("paneKey needs a pane id");
  const generationNumber = Number(generation);
  if (!Number.isSafeInteger(generationNumber) || generationNumber < 0) {
    throw new TypeError(`paneKey needs a non-negative integer generation, got ${generation}`);
  }
  // A bare terminal has no tmux server, and its single pane still needs a key. "local" is not a
  // socket path, so it cannot be confused with one.
  return `${tmuxServer || "local"}/${pane}/${generationNumber}`;
}

/** Splits a key back into its parts, for logging and diagnostics. */
function parsePaneKey(key) {
  const text = String(key || "");
  const lastSlash = text.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const secondLastSlash = text.lastIndexOf("/", lastSlash - 1);
  if (secondLastSlash < 0) return null;
  const generation = Number(text.slice(lastSlash + 1));
  if (!Number.isSafeInteger(generation) || generation < 0) return null;
  const paneId = text.slice(secondLastSlash + 1, lastSlash);
  if (!paneId) return null;
  const tmuxServer = text.slice(0, secondLastSlash);
  return { tmuxServer: tmuxServer === "local" ? null : tmuxServer, paneId, generation };
}

/**
 * Whether an incoming message is for the registration that is current.
 *
 * The same rule as `twebd::page_registry::generation_is_current`: a pane whose frontend died and
 * was replaced has a live registration under the same id, and the old one's messages must be
 * dropped rather than applied to its successor.
 */
function generationIsCurrent(currentGeneration, incomingGeneration) {
  if (currentGeneration === undefined || currentGeneration === null) return false;
  return Number(currentGeneration) === Number(incomingGeneration);
}

module.exports = { serverIdentityFrom, paneKey, parsePaneKey, generationIsCurrent };
