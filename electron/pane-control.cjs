"use strict";

// The stdin control protocol, parsed.
//
// The frontend has always pushed viewport, visibility and raw input over this channel as bare
// lines: `RESIZE 80 24 800 480`, `VIS 01`, `INPUT 1b5b41`. One Electron hosting N panes needs the
// same lines to say *which* pane they are for, and the constraint that shapes the answer is
// shippability: the current one-Electron-per-pane path must keep working with a frontend that
// knows nothing about any of this.
//
// So the address is a prefix, and it is optional. An unaddressed line is for "the implicit sole
// pane" — exactly what today's frontend means by it, and exactly what a host with one attached
// pane resolves it to. A frontend that never learns the prefix keeps working unchanged.
//
//   RESIZE <cols> <rows> <width> <height> [<left> <top>]
//   VIS <hex>
//   INPUT <hex>
//   @%3 RESIZE 80 24 800 480 20 0
//   @%3 ATTACH <server> <gen> <imageId> <rate> <adaptive> <restore> <cols> <rows> <w> <h> <left> <top> <tty> <url>
//   @%3 DETACH
//
// ATTACH carries the image id rather than letting the host allocate one. Kitty image ids are a
// terminal-wide namespace shared with every per-pane engine still running beside a host, and those
// derive theirs from their pid. A host inventing its own range would eventually overwrite one of
// their images. The caller already holds a collision-free scheme, so it supplies the id.
//
// Every field before the url is a fixed number of whitespace splits, and the url is taken verbatim
// after them — a url cannot contain a raw newline, and this is what lets one carry spaces. So no
// field may ever be empty: an empty one shifts the count and the tty would be read as the url.
// Absent values are spelled with sentinels instead:
//
//   server       `-` outside tmux
//   cols/rows/width/height   `0 0 0 0` when the frontend has not measured the pane yet
//   left/top     `-1 -1` when the origin is unknown, which means LEAVE THE ANCHOR WHERE IT IS.
//                Not the same as `0 0`, which would re-anchor the pane at the window's top-left.
//   tty          `-` when unknown. Diagnostics only: frames leave as addressed events, because
//                an engine writing a pane's pty directly would be a second writer PROCESS on it
//                and `createPaneWriter` serialises within one process only.

// Kept byte-identical to what main.cjs matched before this module existed, so an unaddressed line
// parses exactly as it always did.
const RESIZE = /^RESIZE\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+)\s+(\d+))?$/;
const VIS = /^VIS\s+([0-9a-f]*)$/i;
const INPUT = /^INPUT\s+([0-9a-f]*)$/i;
const ADDRESS = /^@(%[\w-]+)\s+(.*)$/;
const DETACH = /^DETACH$/;
// Fourteen fields, the last taken verbatim. `-?\d+` on the origin because `-1 -1` is its
// "unknown" sentinel, and the tty is any non-space run so a path is not split on.
const ATTACH = new RegExp(
  "^ATTACH\\s+(\\S+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+([01])\\s+([01])"
  + "\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(-?\\d+)\\s+(-?\\d+)\\s+(\\S+)"
  + "(?:\\s+(.*))?$"
);

/**
 * Splits an optional `@%N ` address off the front of a line.
 *
 * @returns {{paneId: string|null, rest: string}} a null pane id means the implicit sole pane
 */
function splitAddress(line) {
  const match = ADDRESS.exec(line);
  if (!match) return { paneId: null, rest: line };
  return { paneId: match[1], rest: match[2].trim() };
}

/**
 * Parses one control line.
 *
 * @returns {object|null} a command with a `kind`, or null for anything unrecognised
 */
function parseControlLine(rawLine) {
  const line = String(rawLine ?? "").trim();
  if (!line) return null;
  const { paneId, rest } = splitAddress(line);

  const resize = RESIZE.exec(rest);
  if (resize) {
    // The origin is optional because a frontend that has not measured the pane's placement yet
    // sends the size alone. Undefined means "leave the anchor where it is", which is not the
    // same as an origin of 0,0 — that would re-anchor a pane at the top-left of the window.
    const origin = resize[5] !== undefined && resize[6] !== undefined
      ? { left: Number(resize[5]), top: Number(resize[6]) }
      : undefined;
    return {
      kind: "resize",
      paneId,
      viewport: {
        cols: Number(resize[1]),
        rows: Number(resize[2]),
        width: Number(resize[3]),
        height: Number(resize[4]),
      },
      origin,
    };
  }

  const visibility = VIS.exec(rest);
  if (visibility) return { kind: "visibility", paneId, hex: visibility[1] };

  const input = INPUT.exec(rest);
  // An odd-length payload is half a byte. It was silently ignored before this module and stays
  // ignored, because the alternative is decoding a byte the frontend never sent.
  if (input && input[1].length % 2 === 0) return { kind: "input", paneId, hex: input[1] };

  const attach = ATTACH.exec(rest);
  if (attach) {
    const cols = Number(attach[7]);
    const rows = Number(attach[8]);
    const width = Number(attach[9]);
    const height = Number(attach[10]);
    const left = Number(attach[11]);
    const top = Number(attach[12]);
    return {
      kind: "attach",
      // An unaddressed ATTACH is meaningless: the whole point is to name a pane that does not
      // exist in the registry yet, so there is no implicit pane for it to mean.
      paneId,
      tmuxServer: attach[1] === "-" ? null : attach[1],
      generation: Number(attach[2]),
      imageId: Number(attach[3]),
      frameRate: Number(attach[4]),
      adaptive: attach[5] === "1",
      restoreSession: attach[6] === "1",
      // Null rather than a zeroed viewport: a pane the frontend has not measured yet must fall
      // through to the engine's own sizing, and a 0x0 window is not a smaller pane, it is one
      // that can never paint.
      viewport: cols > 0 && rows > 0 && width > 0 && height > 0
        ? { cols, rows, width, height }
        : null,
      // Undefined means "leave the anchor where it is", matching RESIZE's absent origin. It is
      // deliberately not 0,0, which would anchor the pane at the window's top-left — i.e. draw
      // it over its neighbours.
      origin: left >= 0 && top >= 0 ? { left, top } : undefined,
      tty: attach[13] === "-" ? null : attach[13],
      url: attach[14] ? attach[14].trim() : null,
    };
  }

  if (DETACH.test(rest)) return { kind: "detach", paneId };

  return null;
}

/**
 * Which pane a parsed command is for.
 *
 * The single-pane case is not a degenerate multi-pane case, it is the shipping path: with one
 * registration, an unaddressed line resolves to it. With several, an unaddressed line has no
 * defensible answer and is dropped rather than guessed — applying pane #1's resize to whichever
 * pane happened to be first in the map is worse than doing nothing.
 */
function resolveTarget(command, registry, tmuxServer = null) {
  if (!command) return null;
  if (command.paneId) {
    // By pane id alone, because that is what the wire carries: `engine_wire::control_line` writes
    // `@%N <body>` and no server identity. Narrowing by `tmuxServer` here looked right and was not
    // — the only server identity a hosted engine has is the DAEMON's `$TMUX`, which is unset when
    // the daemon was started outside tmux and belongs to another server when it was not. Measured
    // end to end against a real `twebd`: every VIS, RESIZE and INPUT for a hosted pane was dropped
    // in silence, `twebd status` said `hosted 3`, and all three panes sat blank.
    //
    // `tmuxServer` is still honoured when it names a registration, which keeps the per-pane engine
    // path — where the process's own `$TMUX` IS the pane's — resolving exactly as before.
    const byServer = registry.current(command.paneId, tmuxServer);
    if (byServer) return byServer;
    return registry.currentById(command.paneId);
  }
  const panes = registry.list();
  return panes.length === 1 ? panes[0] : null;
}

/**
 * Formats an outbound line for the frontend, with the same optional-address rule.
 *
 * Symmetry is the point: a host that addresses everything it sends lets the frontend route by
 * pane, while an unaddressed line stays readable by a frontend that has never heard of addressing.
 */
function formatOutbound(kind, paneId, payload = "") {
  const body = payload === "" || payload === null || payload === undefined
    ? kind
    : `${kind} ${payload}`;
  return paneId ? `@${paneId} ${body}\n` : `${body}\n`;
}

/**
 * The event that asks a pane's own frontend to re-declare tracked keyboard mode.
 *
 * Chromium's native DevTools resets the terminal's modified-key mode, and the process that can
 * re-declare it is the one holding that pane's pty. A per-pane engine signals it directly. A host
 * cannot: the pid it has is the supervisor's, which owns no pty — and SIGUSR1's default action is
 * *terminate*, measured killing the daemon and every pane it served. So the request is addressed
 * and travels over that pane's connection.
 *
 * Always addressed, never bare: the case this exists for is precisely one where several panes
 * share a process, so "the implicit sole pane" has no meaning here.
 */
function keyboardRestoreEvent(paneId) {
  const pane = String(paneId || "").trim();
  if (!pane) throw new TypeError("a keyboard restore names the pane whose frontend must act");
  return formatOutbound("KEYBOARD", pane, "restore");
}

module.exports = { parseControlLine, splitAddress, resolveTarget, formatOutbound, keyboardRestoreEvent };
