"use strict";

// The `:` command line — what a typed line means, separated from the overlay that collects it.
//
// DESIGN.md 16 has the reasoning; this is the part that decides. It is a module rather than a
// closure inside preload.cjs because the parse is the security boundary: the difference between
// a named command and arbitrary JavaScript in a logged-in page is one branch here, and a branch
// that decides that should be testable without an Electron window.

// The prefixes that reach the page. Everything else is a named command.
//
// A prefix rather than a heuristic, and the reason is concrete: `reload` is a valid JavaScript
// expression — it reads an identifier — so any rule that evaluates unrecognised words would turn
// a typo into a silent evaluation against the current document. DESIGN.md 16.2.
const SCRIPT_PREFIXES = ["js", "!"];

// How much of a returned value to show. A command line is not an object inspector, and a large
// DOM serialised into a pane is a hang rather than a result (DESIGN.md 16.4).
const RESULT_LIMIT = 2000;

/// What a submitted line means.
///
/// Returns one of:
///   { kind: "empty" }                        nothing to do
///   { kind: "script", source }               evaluate in the page
///   { kind: "command", name, argument }      a named tweb command
///
/// The line is NOT validated against the command table here — an unknown name is still a
/// `command`, and the caller reports it as unknown. Keeping the parse ignorant of the table is
/// what lets the table grow without this function's behaviour changing.
function parseCommandLine(input) {
  const line = String(input == null ? "" : input).trim();
  if (!line) return { kind: "empty" };
  // A leading colon is accepted and ignored: the user typed `:` to open the line, and typing it
  // again out of habit should not become part of the command.
  const body = line.startsWith(":") ? line.slice(1).trim() : line;
  if (!body) return { kind: "empty" };
  // `!` needs no separator — `:!foo` reads naturally — while `js` does, or `jsFoo` would be
  // script rather than an unknown command named `jsFoo`.
  if (body.startsWith("!")) return { kind: "script", source: body.slice(1).trim() };
  const separator = body.search(/\s/);
  const head = (separator === -1 ? body : body.slice(0, separator)).toLowerCase();
  const rest = separator === -1 ? "" : body.slice(separator + 1).trim();
  if (SCRIPT_PREFIXES.includes(head)) return { kind: "script", source: rest };
  return { kind: "command", name: head, argument: rest };
}

/// A value returned by an evaluation, as a line of text.
///
/// `undefined` is rendered rather than blanked: a `:js` that returns nothing is the ordinary
/// outcome of a setter, and showing nothing at all is indistinguishable from the surface being
/// broken. That distinction is why DESIGN.md 16.4 has a result at all.
function formatResult(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return truncate(JSON.stringify(value) ?? String(value));
  } catch (error) {
    // Cyclic objects and anything with a throwing getter land here. The constructor name is more
    // use than "[object Object]" when the point is to see what came back.
    void error;
    const name = value?.constructor?.name;
    return truncate(name ? `[${name}]` : String(value));
  }
}

function truncate(text) {
  const string = String(text);
  return string.length <= RESULT_LIMIT ? string : `${string.slice(0, RESULT_LIMIT)}… (${string.length} chars)`;
}

/// The history a submitted line produces, most recent first.
///
/// Deduplicated: running the same line repeatedly is the measured pattern (read a value, adjust,
/// run again), and it would otherwise fill the history with copies of itself and push the line
/// the user actually wants to revisit out of reach.
function pushHistory(history, line, limit = 50) {
  const value = String(line == null ? "" : line).trim();
  if (!value) return history.slice(0, limit);
  return [value, ...history.filter((entry) => entry !== value)].slice(0, limit);
}

/// Where an Up/Down step lands.
///
/// `index` is -1 for "not in the history yet" — the line the user is typing. Stepping down from
/// the most recent entry returns there rather than wrapping to the oldest: wrapping loses the
/// draft, and a draft is what the user was about to run.
function historyStep(history, index, direction) {
  if (!history.length) return { index: -1, line: null };
  const next = index + (direction === "older" ? 1 : -1);
  if (next < 0) return { index: -1, line: "" };
  if (next >= history.length) return { index: history.length - 1, line: history[history.length - 1] };
  return { index: next, line: history[next] };
}

module.exports = {
  parseCommandLine,
  formatResult,
  pushHistory,
  historyStep,
  SCRIPT_PREFIXES,
  RESULT_LIMIT,
};
