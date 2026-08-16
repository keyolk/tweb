"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isOrphaned, watchedPid, abandonedFrameFiles, INIT_PID } = require("./orphan-watch.cjs");

test("reparenting to init means the frontend is gone", () => {
  assert.equal(isOrphaned(4242, INIT_PID), true);
});

test("a live parent is not an orphan, whatever its pid", () => {
  // Chromium reparents the engine while starting, so the current parent is routinely not
  // the pid that launched it. Only init specifically means orphaned.
  assert.equal(isOrphaned(4242, 4242), false);
  assert.equal(isOrphaned(4242, 9999), false);
});

test("no frontend pid means nothing to watch", () => {
  // Started by hand or by a test: exiting on a guess would kill a legitimate run.
  assert.equal(isOrphaned(undefined, INIT_PID), false);
  assert.equal(isOrphaned("", INIT_PID), false);
  assert.equal(isOrphaned(0, INIT_PID), false);
  assert.equal(isOrphaned(INIT_PID, INIT_PID), false);
  assert.equal(isOrphaned("not-a-pid", INIT_PID), false);
});

// A hosted engine's owner is the supervisor, not a frontend. Reading only TWEB_FRONTEND_PID
// would leave it with no watchdog at all — still painting N panes with nothing left to stop it.
test("a hosted engine watches its supervisor", () => {
  assert.equal(watchedPid({ TWEB_SUPERVISOR_PID: "4242" }), 4242);
  assert.equal(isOrphaned(watchedPid({ TWEB_SUPERVISOR_PID: "4242" }), INIT_PID), true);
});

test("a per-pane engine watches its frontend", () => {
  assert.equal(watchedPid({ TWEB_FRONTEND_PID: "77" }), 77);
});

// twebd sets both to its own pid today, so either answer is the same process. The order is
// what happens if a supervisor ever hands over a frontend's pid: the frontend is the more
// specific owner of that pane's pty and is the right thing to watch.
test("the frontend wins when both are present", () => {
  assert.equal(watchedPid({ TWEB_FRONTEND_PID: "77", TWEB_SUPERVISOR_PID: "4242" }), 77);
});

test("an unusable pid falls through to the next candidate, then to no owner", () => {
  assert.equal(watchedPid({ TWEB_FRONTEND_PID: "", TWEB_SUPERVISOR_PID: "4242" }), 4242);
  assert.equal(watchedPid({ TWEB_FRONTEND_PID: "0", TWEB_SUPERVISOR_PID: "4242" }), 4242);
  assert.equal(watchedPid({ TWEB_FRONTEND_PID: "not-a-pid", TWEB_SUPERVISOR_PID: "4242" }), 4242);
  // init is nobody's supervisor: watching it would make every engine an orphan forever.
  assert.equal(watchedPid({ TWEB_SUPERVISOR_PID: String(INIT_PID) }), null);
  assert.equal(watchedPid({}), null);
  assert.equal(watchedPid(), null);
});

// The files a SIGKILLed engine leaves behind. Observed in a real userData directory:
// four of them, 1-2.5MB each, the oldest five hours old and never collected by anything.
const DEAD = 12136;
const LIVE = 44245;
const alive = (pid) => pid === LIVE;

test("a frame file whose engine is gone is collectable", () => {
  assert.deepEqual(
    abandonedFrameFiles(["tweb-frame-12136-12088.rgba"], 999, alive),
    ["tweb-frame-12136-12088.rgba"]
  );
  assert.deepEqual(
    abandonedFrameFiles([`tweb-frame-${DEAD}-1.png`], 999, alive),
    [`tweb-frame-${DEAD}-1.png`]
  );
  // A staging file is orphaned by exactly the same death.
  assert.deepEqual(
    abandonedFrameFiles([`tweb-frame-${DEAD}-1.rgba.tmp`], 999, alive),
    [`tweb-frame-${DEAD}-1.rgba.tmp`]
  );
});

test("a live sibling's frame file is never touched", () => {
  // Deleting it mid-write costs that engine a frame; leaving a dead one costs megabytes
  // until the next launch. The asymmetry is why an unjudgeable pid is left alone too.
  assert.deepEqual(abandonedFrameFiles([`tweb-frame-${LIVE}-44207.rgba`], 999, alive), []);
});

test("our own files are excluded by pid, so the exit path still owns them", () => {
  assert.deepEqual(
    abandonedFrameFiles([`tweb-frame-${DEAD}-1.rgba`], DEAD, () => false),
    []
  );
});

test("nothing but a frame file is ever considered", () => {
  const names = [
    "history.jsonl", "Cookies", "window-sessions", "Preferences",
    "tweb-frame-.rgba", "tweb-frame-abc-1.rgba", "tweb-frame-1-2.jpg",
    "not-tweb-frame-1-2.rgba", "tweb-frame-1-2.rgba.bak",
  ];
  assert.deepEqual(abandonedFrameFiles(names, 999, () => false), []);
});

test("a missing or empty listing is not an error", () => {
  for (const names of [null, undefined, []]) {
    assert.deepEqual(abandonedFrameFiles(names, 999, () => false), []);
  }
});

test("a mixed directory yields only the dead", () => {
  const names = [
    `tweb-frame-${DEAD}-12088.rgba`,
    `tweb-frame-${LIVE}-44207.rgba`,
    "tweb-frame-999-1.png",
    "history.jsonl",
  ];
  assert.deepEqual(abandonedFrameFiles(names, 999, alive), [`tweb-frame-${DEAD}-12088.rgba`]);
});
