"use strict";

// What the person sees on the active tab while an agent works it: a frame round the page while it
// drives, a mark on the element it acts on, and a quieter badge while it only reads.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
const between = (from, to) => preload.slice(preload.indexOf(from), preload.indexOf(to));

test("the badge names a read as well as a drive, and the frame follows driving only", () => {
  const badge = between("function renderAgentBadge() {", "let agentFrame = null;");
  assert.match(badge, /reading \? `◔ AGENT \$\{reading\.method\}`/);
  assert.match(badge, /agentBadge\.style\.display = driving \|\| reading \|\| link \? "" : "none";/);
  assert.match(badge, /renderAgentFrame\(Boolean\(driving\)\);/);
});

test("the frame is drawn once, takes no pointer events, and goes when driving stops", () => {
  const frame = between("function renderAgentFrame(on) {", "function updateTabState(model)");
  assert.match(frame, /if \(!topFrame\) return;/);
  assert.match(frame, /"pointer-events:none"/);
  assert.match(frame, /if \(agentFrame\?\.isConnected\) return;/);
  assert.match(frame, /agentFrame\.remove\(\);/);
});

test("a page-changing act marks its element; a read act does not", () => {
  const act = between("const MARKED_AGENT_ACTIONS", "case \"click\":\n      case \"hover\":");
  for (const action of ["click", "hover", "fill", "focus", "select", "check", "uncheck", "scrollto"]) {
    assert.match(act, new RegExp(`"${action}"`));
  }
  for (const action of ["text", "html", "attr", "describe"]) {
    assert.doesNotMatch(act.split("\n")[2] || "", new RegExp(`"${action}"`));
  }
  assert.match(act, /try \{ showAgentMark\(item, action\); \} catch \(_\)/);
  const mark = between("function showAgentMark(item, verb) {", "function showHintFeedback(item) {");
  assert.match(mark, /label\.textContent = `AGENT \$\{verb\}`;/);
  assert.match(mark, /pointer-events:none/);
});
