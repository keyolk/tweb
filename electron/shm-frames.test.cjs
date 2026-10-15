"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shmFramesDecision, shmFrameName, shmMarkerName, abandonedShmFrames, SHM_RING,
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
  assert.equal(swept[0].objects.length, SHM_RING);
  assert.equal(swept[0].objects[0], shmFrameName(10, 3, 0));
});
