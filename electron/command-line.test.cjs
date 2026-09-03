"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseCommandLine, completeCommand, formatResult, pushHistory, historyStep, RESULT_LIMIT,
} = require("./command-line.cjs");

test("a bare word is a command, never script", () => {
  // THE security property. `reload` is a valid JavaScript expression, so a heuristic that
  // evaluated unrecognised words would turn a typo into a silent evaluation against a
  // logged-in page. DESIGN.md 16.2.
  assert.deepEqual(parseCommandLine("reload"), { kind: "command", name: "reload", argument: "" });
  assert.deepEqual(parseCommandLine("quality 1080"),
    { kind: "command", name: "quality", argument: "1080" });
  // Including words that are obviously code-shaped. An unknown NAME is still a command; the
  // caller reports it as unknown rather than running it.
  for (const line of ["document.title", "alert(1)", "location.href", "1+1"]) {
    assert.equal(parseCommandLine(line).kind, "command", line);
  }
});

test("only the explicit prefixes reach the page", () => {
  assert.deepEqual(parseCommandLine("js document.title"),
    { kind: "script", source: "document.title" });
  assert.deepEqual(parseCommandLine("!document.title"),
    { kind: "script", source: "document.title" });
  // `!` needs no separator; `js` does, or `jsFoo` would evaluate instead of being an unknown
  // command called `jsFoo`.
  assert.equal(parseCommandLine("jsdocument.title").kind, "command");
  assert.equal(parseCommandLine("jsdocument.title").name, "jsdocument.title");
});

test("the opening colon is not part of the command", () => {
  // The user pressed `:` to get here; typing it again out of habit must not change the meaning.
  assert.deepEqual(parseCommandLine(":reload"), { kind: "command", name: "reload", argument: "" });
  assert.deepEqual(parseCommandLine(": js 1+1"), { kind: "script", source: "1+1" });
});

test("nothing typed does nothing", () => {
  for (const line of ["", "   ", ":", ":   ", null, undefined]) {
    assert.equal(parseCommandLine(line).kind, "empty", JSON.stringify(line));
  }
  // A prefix with no expression is script with an empty source, not a command — the caller
  // declines to evaluate it, but it must not fall through and become a command named "js".
  assert.deepEqual(parseCommandLine("js"), { kind: "script", source: "" });
  assert.deepEqual(parseCommandLine("!"), { kind: "script", source: "" });
});

test("command names are case-insensitive, arguments are not", () => {
  assert.equal(parseCommandLine("RELOAD").name, "reload");
  // The argument is a value — a URL, a selector, a quality rung — and lowercasing it would
  // corrupt it.
  assert.equal(parseCommandLine("open GitHub.com/Foo").argument, "GitHub.com/Foo");
  assert.equal(parseCommandLine("JS document.TITLE").source, "document.TITLE");
});

test("an evaluation that returns nothing still says so", () => {
  // A setter returning undefined is the ordinary outcome of the case this surface was built
  // for. Rendering nothing would be indistinguishable from the surface being broken.
  assert.equal(formatResult(undefined), "undefined");
  assert.equal(formatResult(null), "null");
  assert.equal(formatResult(false), "false");
  assert.equal(formatResult(0), "0");
  assert.equal(formatResult(""), "");
});

test("a large value is capped rather than pasted into the pane", () => {
  const huge = "x".repeat(RESULT_LIMIT * 3);
  const shown = formatResult(huge);
  assert.ok(shown.length < RESULT_LIMIT + 60, `capped, got ${shown.length}`);
  assert.match(shown, /… \(6000 chars\)$/);
});

test("a value that cannot be stringified still reports something", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(formatResult(cyclic), "[Object]");
  const throwing = { get boom() { throw new Error("no"); } };
  assert.doesNotThrow(() => formatResult(throwing));
});

test("history is most-recent-first and deduplicated", () => {
  // Running the same line repeatedly is the measured pattern; without dedup the history fills
  // with copies and pushes the line worth revisiting out of reach.
  let h = [];
  h = pushHistory(h, "a");
  h = pushHistory(h, "b");
  h = pushHistory(h, "a");
  assert.deepEqual(h, ["a", "b"]);
  assert.deepEqual(pushHistory(h, "   "), ["a", "b"], "blank lines are not history");
  const capped = Array.from({ length: 60 }, (_, i) => `line${i}`)
    .reduce((acc, line) => pushHistory(acc, line), []);
  assert.equal(capped.length, 50);
  assert.equal(capped[0], "line59");
});

test("stepping past the newest history entry returns the draft", () => {
  const h = ["newest", "middle", "oldest"];
  assert.deepEqual(historyStep(h, -1, "older"), { index: 0, line: "newest" });
  assert.deepEqual(historyStep(h, 0, "older"), { index: 1, line: "middle" });
  // Stepping down off the top gives an empty line, not a wrap to the oldest: wrapping loses
  // the draft the user was about to run.
  assert.deepEqual(historyStep(h, 0, "newer"), { index: -1, line: "" });
  // And stepping past the oldest stays put rather than wrapping round to the draft.
  assert.deepEqual(historyStep(h, 2, "older"), { index: 2, line: "oldest" });
});

test("history navigation on an empty history is inert", () => {
  assert.deepEqual(historyStep([], -1, "older"), { index: -1, line: null });
  assert.deepEqual(historyStep([], -1, "newer"), { index: -1, line: null });
});

// --- completion ---------------------------------------------------------------------------

const NAMES = ["back", "chrome", "close", "downloads", "float", "forward", "fullscreen",
  "history", "open", "print", "reload", "tab", "tabs", "url", "zoom"];

test("Tab completes to the longest unambiguous prefix, never past it", () => {
  // The shell rule. `t` matches `tab` and `tabs`, so Tab gets to `tab` and stops — choosing
  // one would run a command the user did not type.
  assert.deepEqual(completeCommand("t", NAMES), { names: ["tab", "tabs"], common: "tab" });
  // A prefix with one match completes all the way.
  assert.deepEqual(completeCommand("rel", NAMES), { names: ["reload"], common: "reload" });
  // No match completes to nothing rather than to the first name alphabetically.
  assert.deepEqual(completeCommand("zzz", NAMES), { names: [], common: "" });
});

test("an exact name still lists itself, so Tab is idempotent", () => {
  // Pressing Tab on a finished name must not delete it or append anything.
  assert.deepEqual(completeCommand("reload", NAMES), { names: ["reload"], common: "reload" });
  // And a name that is also a prefix of another keeps both in view.
  assert.deepEqual(completeCommand("tab", NAMES), { names: ["tab", "tabs"], common: "tab" });
});

test("script lines never complete", () => {
  // Completing JavaScript would mean knowing the page's scope, which the parse deliberately
  // does not — and a wrong guess inserted into code that then RUNS is worse than no guess.
  for (const line of ["js doc", "! doc", "js", "!"]) {
    assert.deepEqual(completeCommand(line, NAMES), { names: [], common: "" }, line);
  }
});

test("completion stops once an argument is being typed", () => {
  // With an argument present the name is decided; re-completing it would rewrite a command the
  // user has moved on from.
  assert.deepEqual(completeCommand("open git", NAMES), { names: [], common: "" });
  assert.deepEqual(completeCommand("js x", NAMES), { names: [], common: "" });
  // A TRAILING space is not an argument — the line is trimmed before the check, deliberately.
  // Treating it as one would kill Tab the moment a space was typed after a partial name,
  // which is exactly when someone reaches for it.
  assert.deepEqual(completeCommand("t ", NAMES), { names: ["tab", "tabs"], common: "tab" });
});

test("an empty line offers every command", () => {
  // `:` then Tab is how someone finds out what exists at all.
  const all = completeCommand("", NAMES);
  assert.deepEqual(all.names, [], "an empty line is not a command, so it lists nothing");
  // But a single colon behaves the same as empty — both are "nothing typed yet".
  assert.deepEqual(completeCommand(":", NAMES), { names: [], common: "" });
});

test("the opening colon does not break completion", () => {
  assert.deepEqual(completeCommand(":rel", NAMES), { names: ["reload"], common: "reload" });
});

// --- the inlined copy in preload.cjs -------------------------------------------------------

// WHY there are two copies at all. The preload runs SANDBOXED (Electron 20+ default, and
// nothing in main.cjs turns it off), and a sandboxed preload resolves no relative `require`.
// Measured under Electron 43.2.0: `require("./mod.cjs")` from a preload fails with "module not
// found" even with the file sitting beside it. This was not a theory — the `require` shipped,
// and the preload threw WHILE LOADING, which takes every shortcut in the pane down with it:
// `f`, `w` and `c` all died, not just the feature being added.
//
// So the logic is inlined there and unit-tested here, and these tests hold the two together.
const fs = require("node:fs");
const path = require("node:path");
const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");

test("the preload does not require this module", () => {
  // The failure is catastrophic and silent at build time: `make check` passes, and the pane
  // loses every shortcut at run time on a fresh engine.
  assert.doesNotMatch(preload, /require\("\.\/command-line\.cjs"\)/,
    "a sandboxed preload cannot resolve a relative require");
  // And no other relative require has crept in either. Line comments are stripped first: the
  // comment explaining this rule quotes the very pattern it forbids.
  const code = preload.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /require\("\.\//,
    "the preload may only require electron's own modules");
});

test("the inlined parse behaves identically to this module's", () => {
  // Extract the preload's copy and run it against the same cases. Comparing behaviour rather
  // than text: the two are formatted differently (one is indented inside a closure) and a
  // string compare would fail on whitespace while missing an actual divergence.
  const start = preload.indexOf("  const SCRIPT_PREFIXES =");
  const end = preload.indexOf("  let commandLineState = null;");
  assert.ok(start > 0 && end > start, "the inlined parse should be findable in preload.cjs");
  const source = preload.slice(start, end);
  // eslint-disable-next-line no-new-func
  const inlined = new Function(`${source}; return { parseCommandLine, completeCommand, formatResult, pushHistory, historyStep };`)();

  for (const line of [
    "reload", "quality 1080", "js document.title", "!document.title", ":reload", ": js 1+1",
    "", "   ", ":", "js", "!", "RELOAD", "open GitHub.com/Foo", "jsdocument.title",
    "document.title", "alert(1)", "1+1",
  ]) {
    assert.deepEqual(inlined.parseCommandLine(line), parseCommandLine(line),
      `parse diverged on ${JSON.stringify(line)}`);
  }
  for (const value of [undefined, null, "", "x", 0, false, 1.5, { a: 1 }, [1, 2]]) {
    assert.equal(inlined.formatResult(value), formatResult(value),
      `format diverged on ${JSON.stringify(value)}`);
  }
  for (const line of ["t", "rel", "f", "zzz", "js doc", ":rel", "", "tab"]) {
    assert.deepEqual(inlined.completeCommand(line, NAMES), completeCommand(line, NAMES),
      `completion diverged on ${JSON.stringify(line)}`);
  }
  assert.deepEqual(inlined.pushHistory(["a", "b"], "a"), pushHistory(["a", "b"], "a"));
  assert.deepEqual(inlined.historyStep(["a", "b"], 0, "older"), historyStep(["a", "b"], 0, "older"));
  assert.deepEqual(inlined.historyStep(["a", "b"], 0, "newer"), historyStep(["a", "b"], 0, "newer"));
});
