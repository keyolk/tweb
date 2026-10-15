"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  agentFromArgs, chooseAgentPane, deliverToAgent, inspectMessage, parsePaneList, sanitize,
} = require("./agent-handoff.cjs");

test("an agent is named by its executable, a package path, or the script a runtime runs", () => {
  assert.equal(agentFromArgs("claude --dangerously-skip-permissions --model default"), "claude");
  assert.equal(agentFromArgs("/opt/homebrew/bin/codex"), "codex");
  assert.equal(agentFromArgs("FOO=1 gemini"), "gemini");
  assert.equal(agentFromArgs("env -i aider --model x"), "aider");
  assert.equal(agentFromArgs("cursor-agent"), "cursor-agent");
  assert.equal(agentFromArgs("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"), "claude");
  assert.equal(agentFromArgs("node /opt/homebrew/bin/opencode"), "opencode");
  assert.equal(agentFromArgs("python3 /usr/local/bin/aider"), "aider");
});

test("a shell, an editor or a wrapper that merely mentions an agent is not one", () => {
  // Claude Code's own Bash tool: the snapshot path contains `.claude`, the command is a shell.
  assert.equal(agentFromArgs("/bin/zsh -c source /Users/x/.claude/shell-snapshots/s.sh && claude"), null);
  assert.equal(agentFromArgs("vim claude.md"), null);
  assert.equal(agentFromArgs("ccproxy claude --intercept=mitm"), null);
  assert.equal(agentFromArgs("node -e require('claude')"), null);
  assert.equal(agentFromArgs("fish"), null);
  assert.equal(agentFromArgs(""), null);
  // Names that are someone else's program in tb's longer list.
  assert.equal(agentFromArgs("agent"), null);
  assert.equal(agentFromArgs("pi"), null);
});

test("the pane list keeps only real pane ids and reads the flags", () => {
  const panes = parsePaneList("%1\t/dev/ttys001\tfish\t0\t0\n%2\t/dev/ttys002\tclaude\t1\t1\ngarbage\n");
  assert.deepEqual(panes.map((pane) => pane.id), ["%1", "%2"]);
  assert.equal(panes[1].last, true);
  assert.equal(panes[1].bracketedPaste, true);
  assert.equal(panes[0].bracketedPaste, false);
});

test("the last-used agent pane wins, the browser pane never does, and no agent is no target", () => {
  const panes = [
    { id: "%1", agent: "codex", last: false },
    { id: "%2", agent: null, last: true },
    { id: "%3", agent: "claude", last: true },
    { id: "%9", agent: "claude", last: false },
  ];
  assert.equal(chooseAgentPane(panes, "%9").id, "%3");
  assert.equal(chooseAgentPane(panes.map((pane) => ({ ...pane, last: false })), "%9").id, "%1");
  assert.equal(chooseAgentPane([{ id: "%2", agent: null }], "%9"), null);
  assert.equal(chooseAgentPane([{ id: "%9", agent: "claude" }], "%9"), null);
});

test("nothing that could end a bracketed paste or act as a key survives", () => {
  const hostile = "a\x1b[201~rm -rf ~\rb\x07c\x9bd\te";
  const clean = sanitize(hostile);
  assert.doesNotMatch(clean, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  assert.equal(clean, "a[201~rm -rf ~\nbcd  e");
});

test("the inspect message names the page, the element and the screenshot, trimmed", () => {
  const message = inspectMessage({
    url: "https://example.com/", selector: "main > h1", tag: "h1",
    text: "  Example\n Domain ", html: `<h1>${"x".repeat(3000)}</h1>`,
    rect: { width: 200, height: 40, left: 10, top: 20 },
  }, "/tmp/shot.png");
  assert.match(message, /^Element picked in tweb:\n/);
  assert.match(message, /\nURL: https:\/\/example\.com\/\n/);
  assert.match(message, /\nSelector: main > h1\n/);
  assert.match(message, /\nBox: 200x40 at 10,20 /);
  assert.match(message, /\nText: Example Domain\n/);
  assert.match(message, /\nScreenshot: \/tmp\/shot\.png\n/);
  assert.match(message, /… \(3009 chars\)\n$/);
  // Ends in a newline and nothing that submits: the user adds the instruction.
  assert.ok(message.length < 2600);
});

function fakeTmux(table) {
  const calls = [];
  const run = async (command, args, input) => {
    calls.push({ command, args, input });
    const key = `${command} ${args[0]}`;
    if (key in table) {
      const answer = table[key];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(args) : answer;
    }
    return "";
  };
  return { calls, run };
}

test("delivery pastes into the agent pane as bracketed paste, never presses Enter, then focuses it", async () => {
  const { calls, run } = fakeTmux({
    "tmux list-panes": "%1\t/dev/ttys001\tfish\t0\t0\n%2\t/dev/ttys002\tccproxy\t1\t1\n%3\t/dev/ttys003\ttweb\t0\t0\n",
    "ps -ww": (args) => (args[2] === "ttys002" ? "ccproxy claude --x\nclaude --x\n" : "fish\n"),
  });
  const result = await deliverToAgent({ selfPane: "%3", text: "hello\n", run });
  assert.deepEqual(result, { ok: true, pane: "%2", agent: "claude" });
  const load = calls.find((call) => call.args[0] === "load-buffer");
  assert.equal(load.input, "hello\n");
  const paste = calls.find((call) => call.args[0] === "paste-buffer");
  assert.ok(paste.args.includes("-p"), "bracketed paste");
  assert.equal(paste.args[paste.args.indexOf("-t") + 1], "%2");
  assert.ok(!calls.some((call) => call.args[0] === "send-keys"), "no keys are sent, Enter least of all");
  assert.deepEqual(calls.at(-1).args, ["select-pane", "-t", "%2"]);
  // The browser pane's own tty is never scanned.
  assert.ok(!calls.some((call) => call.command === "ps" && call.args[2] === "ttys003"));
});

test("no agent, or an agent not at its prompt, is reported and nothing is typed", async () => {
  const shellOnly = fakeTmux({ "tmux list-panes": "%1\t/dev/ttys001\tfish\t1\t1\n%3\t/dev/ttys003\ttweb\t0\t0\n", "ps -ww": "fish\n" });
  const none = await deliverToAgent({ selfPane: "%3", text: "x", run: shellOnly.run });
  assert.equal(none.ok, false);
  assert.match(none.reason, /no coding agent pane/);
  assert.ok(!shellOnly.calls.some((call) => call.args[0] === "paste-buffer"));

  const busy = fakeTmux({ "tmux list-panes": "%2\t/dev/ttys002\tclaude\t1\t0\n" });
  const refused = await deliverToAgent({ selfPane: "%3", text: "x", run: busy.run });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /not accepting a paste/);
  assert.ok(!busy.calls.some((call) => call.args[0] === "paste-buffer"));

  assert.match((await deliverToAgent({ selfPane: null, text: "x", run: busy.run })).reason, /not in tmux/);
});

// The same element, as each page engine presents it at zoom 0.8 on a 2x pane 700 points wide.
// Electron: the window is 700 DIPs, the capture 1400px, and the page 875 CSS px wide. Chrome: the
// CSS viewport is 875 at device scale 1.6, so the capture is also 1400px. The crop is the same.
test("the element crop comes from the capture's width over the CSS viewport, on every engine", () => {
  const { elementCrop } = require("./agent-handoff.cjs");
  const rect = { left: 100, top: 120, width: 300, height: 120 };
  assert.deepEqual(elementCrop(rect, { width: 1400, height: 980 }, 875), { x: 160, y: 192, width: 480, height: 192 });
  // No zoom on a 1x pane: CSS pixels are capture pixels.
  assert.deepEqual(elementCrop(rect, { width: 700, height: 490 }, 700), { x: 100, y: 120, width: 300, height: 120 });
  // Partly off screen is clamped; wholly off screen is nothing.
  assert.deepEqual(elementCrop({ left: -50, top: 400, width: 200, height: 200 }, { width: 700, height: 490 }, 700),
    { x: 0, y: 400, width: 150, height: 90 });
  assert.equal(elementCrop({ left: 0, top: 600, width: 10, height: 10 }, { width: 700, height: 490 }, 700), null);
  assert.equal(elementCrop(rect, { width: 700, height: 490 }, 0), null);
  assert.equal(elementCrop(rect, null, 700), null);
});
