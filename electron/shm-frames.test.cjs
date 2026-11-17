"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shmFramesDecision, paneShmMedium, shmFrameName, shmPatchName, paneShmNames, shmMarkerName, abandonedShmFrames,
  SHM_RING, SHM_PATCH_RING,
} = require("./shm-frames.cjs");

test("shm frames need the addon before anything else", () => {
  assert.equal(shmFramesDecision({ addonLoaded: false, override: "1" }).allowed, false);
});

test("a known consumer gets shm, read from tmux's client name", () => {
  assert.equal(shmFramesDecision({ addonLoaded: true, clientTermname: "xterm-ghostty" }).allowed, true);
  assert.equal(shmFramesDecision({ addonLoaded: true, term: "xterm-kitty" }).allowed, true);
});

test("an unknown terminal keeps the file medium, since it would never unlink", () => {
  const decision = shmFramesDecision({ addonLoaded: true, clientTermname: "xterm-256color" });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /not known/);
});

test("a remote terminal cannot open this machine's shared memory", () => {
  assert.equal(shmFramesDecision({ addonLoaded: true, term: "xterm-ghostty", remote: true }).allowed, false);
});

test("the override wins in both directions", () => {
  assert.equal(shmFramesDecision({ addonLoaded: true, term: "xterm-ghostty", override: "0" }).allowed, false);
  assert.equal(shmFramesDecision({ addonLoaded: true, term: "dumb", override: "1" }).allowed, true);
});

test("object names fit macOS's 31-byte limit for any realistic pid and image id", () => {
  const name = shmFrameName(4194304, 2147483647, SHM_RING - 1);
  assert.ok(name.length <= 31, `${name} is ${name.length} bytes`);
  assert.ok(name.startsWith("/") && !name.slice(1).includes("/"));
});

test("a dead engine's marker names every ring slot it may have left", () => {
  const names = [shmMarkerName(10, 3), shmMarkerName(11, 4), shmMarkerName(12, 5), "tweb-frame-10-3.rgba"];
  const swept = abandonedShmFrames(names, 12, (pid) => pid === 11);
  assert.deepEqual(swept.map((entry) => entry.marker), ["tweb-shm-10-3"]);
  assert.equal(swept[0].objects.length, SHM_RING + SHM_PATCH_RING);
  assert.equal(swept[0].objects[0], shmFrameName(10, 3, 0));
});

test("patch object names also fit the limit, and never collide with whole-frame names", () => {
  const patch = shmPatchName(4194304, 2147483647, SHM_PATCH_RING - 1);
  assert.ok(patch.length <= 31, `${patch} is ${patch.length} bytes`);
  const names = paneShmNames(7, 9);
  assert.equal(new Set(names).size, names.length);
});

// A placeholder pane used to take the file medium unconditionally. With one tmux client showing
// it there is one reader, and the file medium only cost: a Retina YouTube pane sent 0 of 6053
// whole frames through shm and dropped a quarter of its video frames.
test("a placeholder pane takes shm while exactly one client shows it", () => {
  const one = paneShmMedium({ shmEnabled: true, placeholders: true, clientCount: 1 });
  assert.equal(one.shm, true);
  assert.match(one.reason, /one client/);
});

test("a second client puts a placeholder pane back on the file medium", () => {
  const two = paneShmMedium({ shmEnabled: true, placeholders: true, clientCount: 2 });
  assert.equal(two.shm, false);
  assert.match(two.reason, /2 clients/);
});

test("a placeholder pane nobody shows, or whose clients are unknown, keeps the file", () => {
  assert.equal(paneShmMedium({ shmEnabled: true, placeholders: true, clientCount: 0 }).shm, false);
  assert.equal(paneShmMedium({ shmEnabled: true, placeholders: true }).shm, false);
});

test("the overlay keeps shm whatever the client count, and nothing gets shm when it is off", () => {
  assert.equal(paneShmMedium({ shmEnabled: true, placeholders: false, clientCount: 3 }).shm, true);
  assert.equal(paneShmMedium({ shmEnabled: false, placeholders: false, clientCount: 1 }).shm, false);
  assert.equal(paneShmMedium({ shmEnabled: false, placeholders: true, clientCount: 1 }).shm, false);
});

// Whole frames and patches go through the same per-pane gate, which reads the pane's own client
// set; diag reports that per-pane answer instead of the engine-wide one.
test("main gates shm per pane on its own client set and reports that medium", () => {
  const main = require("node:fs").readFileSync(require("node:path").join(__dirname, "main.cjs"), "utf8");
  const gate = main.slice(main.indexOf("function paneShmMediumFor"), main.indexOf("function nextShmFrameName"));
  assert.match(gate, /clientCount: record\?\.visibility\?\.clientTtys\?\.size/);
  assert.match(gate, /placeholders: usesPlaceholders\(record\)/);
  assert.match(gate, /return paneShmMediumFor\(frames\)\.shm/);
  assert.match(main, /if \(shmUsableFor\(frames\) && sendShmPatch\(/, "patches use the same gate");
  assert.match(main, /wholeMedium: paneShmMediumFor\(currentFrames\(\)\)\.shm \? "shm" : frameTransport/);
  assert.match(main, /wholeMediumReason: paneShmMediumFor\(currentFrames\(\)\)\.reason/);
});
