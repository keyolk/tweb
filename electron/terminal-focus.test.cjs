"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  appBundlePath, findTerminalApp, parseProcessTable, parseTtyPids, preferredClientTty,
} = require("./terminal-focus.cjs");

// The real ancestry measured on this machine, from a tmux client's tty up to the terminal.
// The shape that matters: the terminal is FOUR levels up, not the tty's own process and not
// its parent, because this terminal inserts a login shell and a wrapper of its own.
const REAL_TABLE = parseProcessTable(`
92763 92707 /bin/zsh
92707 92701 zsh (kiro-cli-term)
92701 92675 /usr/bin/login
92675     1 /Applications/Ghostty.app/Contents/MacOS/ghostty
`);

test("the terminal is found however deep the shells go", () => {
  const found = findTerminalApp(REAL_TABLE, 92763);
  assert.deepEqual(found, { pid: 92675, bundle: "/Applications/Ghostty.app" });
});

test("a bundle path is cut at the .app, not at the binary", () => {
  assert.equal(appBundlePath("/Applications/Ghostty.app/Contents/MacOS/ghostty"),
    "/Applications/Ghostty.app");
  assert.equal(appBundlePath("/Applications/iTerm.app"), "/Applications/iTerm.app");
  // A plain binary is not a bundle. Terminals that ship as one still work — the walk simply
  // keeps going up — but this must not report the shell itself as the app.
  assert.equal(appBundlePath("/bin/zsh"), null);
  assert.equal(appBundlePath("/usr/bin/login"), null);
  assert.equal(appBundlePath(""), null);
  assert.equal(appBundlePath(undefined), null);
});

test("an ancestry with no app yields nothing rather than a guess", () => {
  // A tmux running under a plain tty with no GUI terminal above it — an ssh session, or a
  // linux console. Focusing "the terminal app" is meaningless there and must not resolve to
  // whatever process happens to sit at the top.
  const table = parseProcessTable("500 400 /bin/bash\n400 1 /usr/sbin/sshd");
  assert.equal(findTerminalApp(table, 500), null);
});

test("a cycle in the table cannot hang the walk", () => {
  // The table comes from `ps` and should never contain one, but a hung focus command is a
  // frozen pane and the bound costs nothing.
  const table = new Map([[10, { ppid: 11, command: "a" }], [11, { ppid: 10, command: "b" }]]);
  assert.equal(findTerminalApp(table, 10), null);
});

test("a missing pid resolves to nothing", () => {
  assert.equal(findTerminalApp(REAL_TABLE, 99999), null);
  assert.equal(findTerminalApp(REAL_TABLE, 1), null);
  assert.equal(findTerminalApp(new Map(), 500), null);
});

test("the process table parses ps output with paths that contain spaces", () => {
  const table = parseProcessTable("  501   1 /Applications/My Terminal.app/Contents/MacOS/term\n");
  assert.deepEqual(table.get(501), { ppid: 1, command: "/Applications/My Terminal.app/Contents/MacOS/term" });
  assert.deepEqual(findTerminalApp(table, 501), { pid: 501, bundle: "/Applications/My Terminal.app" });
});

test("tty pids ignore the header and blank lines", () => {
  assert.deepEqual(parseTtyPids("\n 92763\n92857\n\n"), [92763, 92857]);
  assert.deepEqual(parseTtyPids(""), []);
  assert.deepEqual(parseTtyPids(undefined), []);
});

test("the most recently active client wins", () => {
  // Several terminals can show the same pane. Focusing any but the last one used moves the
  // user to a window they were not looking at.
  const listing = "/dev/ttys001\t100\n/dev/ttys003\t900\n/dev/ttys002\t500";
  assert.equal(preferredClientTty(listing), "/dev/ttys003");
});

test("a tie keeps tmux's own order rather than picking differently each call", () => {
  assert.equal(preferredClientTty("/dev/ttys001\t100\n/dev/ttys002\t100"), "/dev/ttys001");
  // Unparseable activity is not a reason to drop a client — it is still a place to focus.
  assert.equal(preferredClientTty("/dev/ttys001\t-"), "/dev/ttys001");
  assert.equal(preferredClientTty(""), null);
  assert.equal(preferredClientTty(undefined), null);
});
