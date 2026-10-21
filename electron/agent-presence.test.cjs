"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DRIVING_MS, applyLink, classify, createPresence, nextChange, noteAgentCall, noteUserInput, presenceModel,
} = require("./agent-presence.cjs");

test("status, audio-sync and link are bookkeeping; reads look; the rest drives", () => {
  assert.equal(classify("status"), "passive");
  assert.equal(classify("audio-sync"), "passive");
  assert.equal(classify("link"), "passive");
  assert.equal(classify("snapshot"), "read");
  assert.equal(classify("act", { action: "text" }), "read");
  assert.equal(classify("act", { action: "click" }), "drive");
  assert.equal(classify("navigate"), "drive");
  assert.equal(classify("eval"), "drive");
});

test("a page-changing call drives the pane for a while, then the badge runs out", () => {
  const p = createPresence();
  assert.equal(noteAgentCall(p, "status", {}, 1000), false);
  assert.equal(noteAgentCall(p, "snapshot", {}, 1000), false);
  assert.equal(presenceModel(p, 1000).driving, null);
  assert.equal(presenceModel(p, 1000).lastAgent.method, "snapshot");
  assert.equal(noteAgentCall(p, "act", { action: "click" }, 2000), true);
  assert.deepEqual(presenceModel(p, 2500).driving, { method: "click", at: 2000 });
  assert.equal(nextChange(p, 2500), 2000 + DRIVING_MS);
  assert.equal(presenceModel(p, 2000 + DRIVING_MS).driving, null);
  assert.equal(nextChange(p, 2000 + DRIVING_MS), null);
});

test("a link lives for its ttl, renews in place, and clears", () => {
  const p = createPresence();
  assert.throws(() => applyLink(p, {}, 0), /owner/);
  const first = applyLink(p, { owner: "cc-mods %42", ttl: 10 }, 1000);
  assert.equal(first.fresh, true);
  assert.deepEqual(presenceModel(p, 5000).link, { owner: "cc-mods %42", since: 1000, expiresAt: 11000 });
  const again = applyLink(p, { owner: "cc-mods %42", ttl: 10 }, 9000);
  assert.equal(again.fresh, false);
  assert.equal(presenceModel(p, 15000).link.since, 1000);
  assert.equal(nextChange(p, 15000), 19000);
  assert.equal(presenceModel(p, 19000).link, null);
  applyLink(p, { owner: "x" }, 20000);
  applyLink(p, { clear: true }, 20001);
  assert.equal(presenceModel(p, 20002).link, null);
});

test("input from the person while an agent drives is a conflict, said once per drive", () => {
  const p = createPresence();
  assert.equal(noteUserInput(p, 100), false);
  noteAgentCall(p, "type", {}, 1000);
  assert.equal(noteUserInput(p, 1500), true);
  assert.equal(noteUserInput(p, 1600), false);
  assert.equal(presenceModel(p, 1700).conflictAt, 1500);
  noteAgentCall(p, "press", {}, 2000);
  assert.equal(noteUserInput(p, 2100), true);
  assert.equal(noteUserInput(p, 2000 + DRIVING_MS + 1), false);
});
