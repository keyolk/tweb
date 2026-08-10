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

module.exports = { visibleTmuxClientTtys };
