"use strict";

// Finding the OS application that is showing a tmux pane, so focus can be handed back to it.
//
// The hard half of moving focus between a floating window and the pane that spawned it. The
// other direction is one call — the window is this process's own. This direction crosses three
// boundaries and each one has to be resolved separately:
//
//   which tmux pane      already known: `vis().placement` carries session/window/pane
//   which terminal       `tmux list-clients` gives the client's tty
//   which OS application the tty's process ancestry ends at the terminal's binary
//
// Measured on this machine, the ancestry from a client tty:
//
//   92763 /bin/zsh
//   92707 zsh (kiro-cli-term)
//   92701 /usr/bin/login
//   92675 /Applications/Ghostty.app/Contents/MacOS/ghostty
//
// So the terminal is not the tty's own process, nor its parent — it is however many levels up
// the first `.app` bundle appears. Walking until one is found is what makes this work across
// terminals that insert their own shells (as this one does) and those that do not.
//
// Nothing here shells out. The caller supplies the process table and the walk is pure, because
// the alternative is a function that can only be tested by having the right terminal running.

/// The app bundle path from an executable path, or null when it is not inside one.
///
/// `/Applications/Ghostty.app/Contents/MacOS/ghostty` -> `/Applications/Ghostty.app`
function appBundlePath(executable) {
  const path = String(executable || "");
  const marker = path.indexOf(".app/");
  if (marker === -1) return path.endsWith(".app") ? path : null;
  return path.slice(0, marker + 4);
}

/// Walks a process's ancestry to the first `.app` bundle.
///
/// `processes` maps pid -> { ppid, command }. Returns `{ pid, bundle }` or null.
///
/// Bounded rather than looping until pid 1: a corrupt table with a cycle in it would otherwise
/// hang the caller, and no real ancestry is anywhere near this deep.
function findTerminalApp(processes, startPid, limit = 12) {
  let pid = Number(startPid);
  const seen = new Set();
  for (let step = 0; step < limit; step += 1) {
    if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) return null;
    seen.add(pid);
    const entry = processes.get(pid);
    if (!entry) return null;
    const bundle = appBundlePath(entry.command);
    if (bundle) return { pid, bundle };
    pid = Number(entry.ppid);
  }
  return null;
}

/// Parses `ps -Ao pid=,ppid=,comm=` into the map `findTerminalApp` takes.
///
/// `comm` rather than `args`: the executable path is what carries the bundle, and `args` would
/// bring a command line whose own text can contain `.app/` — a shell running an editor inside a
/// bundle would then be mistaken for the terminal.
function parseProcessTable(output) {
  const processes = new Map();
  for (const line of String(output || "").split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    processes.set(Number(match[1]), { ppid: Number(match[2]), command: match[3].trim() });
  }
  return processes;
}

/// The pids attached to a tty, from `ps -t <tty> -o pid=`.
function parseTtyPids(output) {
  return String(output || "")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 1);
}

/// Which client tty to focus when several are showing the pane.
///
/// `list-clients` output, one client per line, tab separated, with the tty first. The pane's own
/// `#{client_activity}` orders them: the most recently used client is the one the user was last
/// at, and focusing any other would move them to a window they are not looking at.
///
/// A tie keeps the first line, which is tmux's own order — arbitrary but stable, and better than
/// picking differently on each call for the same state.
function preferredClientTty(listing) {
  let best = null;
  for (const line of String(listing || "").split("\n")) {
    if (!line.trim()) continue;
    const [tty, activity] = line.split("\t");
    if (!tty) continue;
    const stamp = Number(activity);
    const score = Number.isFinite(stamp) ? stamp : 0;
    if (!best || score > best.score) best = { tty: tty.trim(), score };
  }
  return best ? best.tty : null;
}

module.exports = {
  appBundlePath,
  findTerminalApp,
  parseProcessTable,
  parseTtyPids,
  preferredClientTty,
};
