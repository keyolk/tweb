"use strict";

// `tweb open --ssh <dest>`: a pane whose network is a remote host's.
//
// The pane frontend owns the ssh tunnel (crates/tweb-pane/src/ssh.rs) and hands this engine two
// variables: TWEB_PROXY_SERVER, the SOCKS rule for the tunnel's local port, and TWEB_REMOTE, the
// destination. What this engine does with them is decided here:
//
// - The proxy goes on the session, with loopback NOT bypassed. Chromium sends `localhost` and
//   127.0.0.1 direct by default, which would defeat the mode: the remote's dev server on its
//   loopback is the thing the user opened the pane to see. `<-loopback>` removes that implicit
//   bypass. SOCKS5 also resolves host names on the far side, so the remote's /etc/hosts and its
//   private DNS apply too.
// - The pane gets a profile of its own per destination, under the shared one's `remote/` folder,
//   instead of the shared profile DESIGN.md goal 6 gives every other pane. A shared cookie jar
//   would mix two networks under one name: `localhost:3000` here is the remote's app, and its
//   session cookie would be sent to the local `localhost:3000` from the next ordinary pane (and
//   the local one's to the remote). The window-session file has the same problem — a plain
//   `tweb open` in this window would restore remote URLs onto the local network. Separate per
//   destination, persistent across reconnects: the remote app's login survives closing the pane.
//   The cost is that the pane starts signed out of everything else and without the shared
//   profile's extensions; that is the trade the isolation buys.
// - WebRTC is limited to the proxy. Its UDP does not go through SOCKS, so a page could otherwise
//   learn the LOCAL machine's addresses from a pane that is meant to be on the remote network.

const path = require("node:path");

// Only ever the loopback SOCKS port the frontend opened. Anything else in the variable is not
// something this engine was handed by its frontend, and a proxy rule is not a place to guess.
const PROXY_RULE = /^socks5:\/\/127\.0\.0\.1:(\d{1,5})$/;

/**
 * The remote network this engine was started for, or null for an ordinary pane.
 *
 * @param {Record<string, string|undefined>} env the engine's environment
 * @returns {{proxyRules: string, destination: string, profileName: string}|null}
 * @throws when TWEB_REMOTE is set but the proxy rule is missing or malformed — a pane asked to be
 *   on the remote network must not quietly come up on the local one
 */
function remoteNetwork(env = {}) {
  const destination = env.TWEB_REMOTE;
  if (!destination) return null;
  const rules = String(env.TWEB_PROXY_SERVER || "");
  const match = PROXY_RULE.exec(rules);
  const port = match ? Number(match[1]) : 0;
  if (!match || port < 1 || port > 65535) {
    throw new Error(`TWEB_REMOTE=${destination} without a usable TWEB_PROXY_SERVER (${rules || "unset"})`);
  }
  return { proxyRules: rules, destination, profileName: profileName(destination) };
}

/**
 * A directory name for a destination: readable, and unable to climb out of `remote/`.
 *
 * @param {string} destination e.g. `me@box`, `coder.gavin-jeong.regular`
 * @returns {string}
 */
function profileName(destination) {
  const name = String(destination).replace(/[^A-Za-z0-9@._-]/g, "_").replace(/^\.+/, "_");
  return name || "_";
}

/**
 * Where a remote pane's profile lives: beside the shared one, never inside a path the shared
 * profile's own sweeps (caches, frame files) treat as theirs.
 *
 * @param {string} userData the shared profile directory
 * @param {{profileName: string}} remote from `remoteNetwork`
 * @returns {string}
 */
function remoteProfileDir(userData, remote) {
  return path.join(userData, "remote", remote.profileName);
}

/**
 * The `session.setProxy` argument.
 *
 * @param {{proxyRules: string}} remote from `remoteNetwork`
 */
function proxyConfig(remote) {
  return { proxyRules: remote.proxyRules, proxyBypassRules: "<-loopback>" };
}

module.exports = { remoteNetwork, profileName, remoteProfileDir, proxyConfig };
