"use strict";

// Handing something the user picked in the browser to the coding agent next to it.
//
// DESIGN.md goal 10: what the browser creates or observes goes to the agents in the same tmux
// window. `tweb inspect-element` already let an agent PULL the pick, but only an agent that thought
// to ask; this is the PUSH half. The pick is typed into the agent pane's input as a bracketed paste
// and nothing else — no Enter — so the user writes the instruction that goes with it.
//
// Everything that decides lives here, apart from Electron, so it can be tested without a pane: which
// process is an agent, which pane gets the paste, what the message says, and what bytes it may
// contain. The tmux and ps calls are injected (`run`), so a test can answer them from a table.

// The agents a paste is aimed at. Deliberately short: each name here is a process that will have
// text typed into it, so a name that also belongs to an ordinary program (tb's list has `agent`,
// `pi`, `amp`, `goose`) would type into whatever that is. Values are the executable names each one
// is started as.
const AGENTS = {
  claude: ["claude", "claude-code"],
  codex: ["codex", "codex-cli"],
  gemini: ["gemini", "gemini-cli"],
  "cursor-agent": ["cursor-agent"],
  opencode: ["opencode", "opencode-ai"],
  aider: ["aider", "aider-chat"],
};

// An agent installed as a package runs as `node <path>`; the path is the only thing that names it.
const PACKAGE_PATHS = [
  ["node_modules/@anthropic-ai/claude-code", "claude"],
  [".local/share/claude/versions", "claude"],
  ["node_modules/@openai/codex", "codex"],
  ["node_modules/@google/gemini-cli", "gemini"],
  ["node_modules/opencode-ai", "opencode"],
  ["cursor-agent/versions", "cursor-agent"],
];

// Launchers whose first positional argument is the program actually being run.
const SCRIPT_RUNNERS = new Set(["node", "nodejs", "bun", "deno", "tsx"]);
const SUFFIX = /\.(js|mjs|cjs|ts|py|exe)$/;

function stem(token) {
  const name = String(token).replace(/^["']+|["']+$/g, "").replace(/\/+$/, "").split("/").pop() || "";
  return name.toLowerCase().replace(SUFFIX, "").replace(/^-/, "");
}

function agentFromName(name) {
  for (const [agent, names] of Object.entries(AGENTS)) {
    if (names.includes(name)) return agent;
  }
  return null;
}

function agentFromPackagePath(token) {
  const normalized = String(token).toLowerCase();
  for (const [needle, agent] of PACKAGE_PATHS) {
    if (normalized.includes(`/${needle}/`) || normalized.endsWith(`/${needle}`)) return agent;
  }
  return null;
}

/// The agent a command line runs, or null.
///
/// A shell running `-c` is never an agent even when the string mentions one: Claude Code's own Bash
/// tool runs `zsh -c 'source ~/.claude/shell-snapshots/...'`, and reading that as Claude would aim
/// the paste at a subshell.
function agentFromArgs(args) {
  const argv = String(args || "").trim().split(/\s+/).filter(Boolean);
  let start = 0;
  while (start < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[start])) start += 1;
  const launcher = argv[start];
  if (!launcher) return null;
  const name = stem(launcher);
  const direct = agentFromName(name) || agentFromPackagePath(launcher);
  if (direct) return direct;
  const rest = argv.slice(start + 1);
  if (name === "env") return agentFromArgs(rest.filter((arg) => !arg.startsWith("-")).join(" "));
  if (SCRIPT_RUNNERS.has(name) || /^python(\d+(\.\d+)*)?$/.test(name)) {
    if (rest.some((arg) => ["-e", "--eval", "-p", "--print", "-c", "-m"].includes(arg))) return null;
    const script = rest.find((arg) => !arg.startsWith("-"));
    return script ? agentFromName(stem(script)) || agentFromPackagePath(script) : null;
  }
  return null;
}

/// Panes as `paneListFormat` prints them.
const PANE_LIST_FORMAT = "#{pane_id}\t#{pane_tty}\t#{pane_current_command}\t#{pane_last}\t#{bracket_paste_flag}";

function parsePaneList(text) {
  return String(text || "").split("\n").filter(Boolean).map((line) => {
    const [id, tty, command, last, bracketed] = line.split("\t");
    return { id, tty, command: command || "", last: last === "1", bracketedPaste: bracketed === "1" };
  }).filter((pane) => /^%\d+$/.test(pane.id || ""));
}

/// The agent pane a paste goes to, chosen from `panes` (each with `agent` filled in).
///
/// The pane the user was in last wins — with two agents in the window, the one they just left to
/// look at the page is the one they are talking to. Otherwise the first in tmux's order. A window
/// with no agent is an answer too, and the caller says so rather than typing into a shell.
function chooseAgentPane(panes, selfPane) {
  const agents = panes.filter((pane) => pane.id !== selfPane && pane.agent);
  if (agents.length === 0) return null;
  return agents.find((pane) => pane.last) || agents[0];
}

// Everything that could act as a terminal control in the receiving pane: ESC above all, since
// `ESC [201~` inside the text would end the bracketed paste early and turn the rest of a page's
// text into keystrokes. Newlines stay; a tab becomes spaces because tmux renders it as `\t`.
function sanitize(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

function clip(text, limit) {
  const value = String(text ?? "");
  return value.length <= limit ? value : `${value.slice(0, limit)}… (${value.length} chars)`;
}

const TEXT_LIMIT = 500;
const HTML_LIMIT = 2000;

/// The message for one picked element. Labelled lines rather than JSON: it lands in a chat input
/// that a person reads before sending.
function inspectMessage(payload, screenshotPath) {
  const rect = payload.rect || {};
  const text = String(payload.text || "").replace(/\s+/g, " ").trim();
  const lines = [
    "Element picked in tweb:",
    `URL: ${payload.url || ""}`,
    `Selector: ${payload.selector || ""}`,
    `Box: ${rect.width}x${rect.height} at ${rect.left},${rect.top} (CSS px, viewport)`,
  ];
  if (text) lines.push(`Text: ${clip(text, TEXT_LIMIT)}`);
  if (screenshotPath) lines.push(`Screenshot: ${screenshotPath}`);
  lines.push("HTML:", clip(String(payload.html || "").trim(), HTML_LIMIT));
  return `${sanitize(lines.join("\n"))}\n`;
}

/// The agent pane in `selfPane`'s window that a paste may go to.
///
/// `run(command, args, input)` runs a program and resolves to its stdout (rejecting on failure). It
/// is asynchronous because this runs on the engine's main thread, which also moves every frame.
/// Resolves to `{ ok: true, pane, agent }` or `{ ok: false, reason }` and never rejects, since every
/// caller turns the answer into a toast or a CLI line. Asked BEFORE anything is prepared, so a
/// window with no agent costs no screenshot.
async function findAgentPane({ selfPane, run }) {
  if (!selfPane) return { ok: false, reason: "this pane is not in tmux" };
  let panes;
  try {
    panes = parsePaneList(await run("tmux", ["list-panes", "-t", selfPane, "-F", PANE_LIST_FORMAT]));
  } catch (error) {
    return { ok: false, reason: `tmux list-panes failed: ${error.message}` };
  }
  for (const pane of panes) {
    if (pane.id === selfPane) continue;
    pane.agent = agentFromArgs(pane.command);
    if (pane.agent || !pane.tty) continue;
    // `pane_current_command` is only the foreground process's name, and agents are often a
    // child of something else in the pane (a proxy, a wrapper script) or run under a runtime.
    try {
      const listing = await run("ps", ["-ww", "-t", pane.tty.replace(/^\/dev\//, ""), "-o", "args="]);
      pane.agent = listing.split("\n").map(agentFromArgs).find(Boolean) || null;
    } catch (error) {
      void error;
    }
  }
  const target = chooseAgentPane(panes, selfPane);
  if (!target) return { ok: false, reason: "no coding agent pane in this tmux window" };
  // Without bracketed paste every newline is Enter, and the first line would be sent half-written.
  // An agent asks for it whenever its input is waiting; one that has not is busy or not at a prompt.
  if (!target.bracketedPaste) {
    return { ok: false, reason: `${target.agent} in ${target.id} is not accepting a paste right now` };
  }
  return { ok: true, pane: target.id, agent: target.agent };
}

/// Pastes `text` into `target` (a `findAgentPane` answer) as one bracketed paste, then focuses it.
/// Never a key: no Enter, so the user writes the instruction that goes with it.
async function pasteToAgent({ target, text, run }) {
  const buffer = `tweb-handoff-${process.pid}-${Date.now()}`;
  try {
    await run("tmux", ["load-buffer", "-b", buffer, "-"], text);
    await run("tmux", ["paste-buffer", "-p", "-d", "-b", buffer, "-t", target.pane]);
  } catch (error) {
    return { ok: false, reason: `tmux paste failed: ${error.message}` };
  }
  try {
    await run("tmux", ["select-pane", "-t", target.pane]);
  } catch (error) {
    void error;
  }
  return target;
}

/// Both steps, for a caller with nothing to prepare in between.
async function deliverToAgent({ selfPane, text, run }) {
  const target = await findAgentPane({ selfPane, run });
  return target.ok ? pasteToAgent({ target, text, run }) : target;
}

module.exports = {
  AGENTS,
  PANE_LIST_FORMAT,
  agentFromArgs,
  chooseAgentPane,
  deliverToAgent,
  findAgentPane,
  pasteToAgent,
  inspectMessage,
  parsePaneList,
  sanitize,
};
