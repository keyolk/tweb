"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PaneRegistry, createPaneRecord, applyViewport, applyVisibility, applyFrameTier,
  applySurface, applyAudio, audioOwnerAmong, paneImageIds, paneFrameFileNames,
  collidingImageRange, PATCH_ID_COUNT, IMAGE_ID_STRIDE,
} = require("./pane-registry.cjs");

const VP = (cols, rows, width, height) => ({ cols, rows, width, height });

function record(overrides = {}) {
  return createPaneRecord({
    tmuxServer: "/tmp/sock,111", paneId: "%3", generation: 1, imageId: 4242, ...overrides,
  });
}

test("a pane record starts uncollapsed, because collapsing a visible pane would blank it", () => {
  const pane = record();
  assert.deepEqual(pane.surface, { collapsed: false, logical: null });
  assert.deepEqual(pane.audio, { audible: false, claiming: false });
  assert.deepEqual(pane.frames, { whole: 0, patches: 0 });
  assert.equal(pane.visible, true);
});

test("an image id is required and never invented, because the namespace is terminal-wide", () => {
  // A host that allocated its own range would eventually overwrite the image of a per-pane
  // engine running beside it.
  assert.throws(() => record({ imageId: undefined }), TypeError);
  assert.throws(() => record({ imageId: 0 }), TypeError);
  assert.throws(() => record({ imageId: -1 }), TypeError);
  assert.throws(() => record({ imageId: 1.5 }), TypeError);
});

test("an unchanged viewport reports nothing, so no resize is provoked", () => {
  const pane = record();
  assert.notEqual(applyViewport(pane, VP(80, 24, 800, 480), { left: 0, top: 0 }), null);
  assert.equal(applyViewport(pane, VP(80, 24, 800, 480), { left: 0, top: 0 }), null);
});

test("a move and a resize are reported separately, because they need different repairs", () => {
  const pane = record();
  applyViewport(pane, VP(80, 24, 800, 480), { left: 0, top: 0 });
  const moved = applyViewport(pane, VP(80, 24, 800, 480), { left: 40, top: 0 });
  assert.equal(moved.originChanged, true);
  assert.equal(moved.sizeChanged, false);
  const resized = applyViewport(pane, VP(100, 24, 1000, 480), { left: 40, top: 0 });
  assert.equal(resized.sizeChanged, true);
  assert.equal(resized.originChanged, false);
});

test("only a shrink is flagged, because growing corrects itself with the next placement", () => {
  const pane = record();
  applyViewport(pane, VP(80, 24, 800, 480));
  assert.equal(applyViewport(pane, VP(60, 24, 600, 480)).shrank, true);
  assert.equal(applyViewport(pane, VP(90, 24, 900, 480)).shrank, false);
  // Rows alone are enough: the rows given up stay covered, usually hiding the pane below.
  assert.equal(applyViewport(pane, VP(90, 12, 900, 240)).shrank, true);
});

test("visibility reports only real transitions", () => {
  const pane = record();
  assert.equal(applyVisibility(pane, true), null);
  assert.deepEqual(applyVisibility(pane, false), { previous: true, visible: false });
  assert.equal(applyVisibility(pane, false), null);
  assert.deepEqual(applyVisibility(pane, 1), { previous: false, visible: true });
});

test("re-applying the current frame tier is suppressed, since setFrameRate provokes a paint", () => {
  // The playback tier is decided by counting paints over a window; a redundant call would feed
  // the detector paints it caused itself.
  const pane = record();
  assert.deepEqual(applyFrameTier(pane, 30), { previous: null, rate: 30 });
  assert.equal(applyFrameTier(pane, 30), null);
  assert.deepEqual(applyFrameTier(pane, 4), { previous: 30, rate: 4 });
  assert.equal(applyFrameTier(pane, NaN), null);
});

test("the surface remembers the size to restore to, not what a collapsed pane measures", () => {
  // A collapsed pane measures height 1. Restoring to that is how the agent API read
  // innerHeight=1 on 13 of 30 calls.
  const pane = record();
  const collapsed = applySurface(pane, { collapsed: true, logical: { width: 400, height: 240 } });
  assert.equal(collapsed.collapseChanged, true);
  assert.deepEqual(pane.surface, { collapsed: true, logical: { width: 400, height: 240 } });
  assert.equal(applySurface(pane, { collapsed: true }), null);
  const restored = applySurface(pane, { collapsed: false });
  assert.equal(restored.collapseChanged, true);
  assert.deepEqual(pane.surface.logical, { width: 400, height: 240 });
});

test("a changed logical size is reported even while the collapse state holds", () => {
  const pane = record();
  applySurface(pane, { collapsed: true, logical: { width: 400, height: 240 } });
  const changed = applySurface(pane, { collapsed: true, logical: { width: 400, height: 600 } });
  assert.equal(changed.collapseChanged, false);
  assert.deepEqual(changed.logical, { width: 400, height: 600 });
});

test("audio reports only what changed, so no redundant claim is written", () => {
  const pane = record();
  assert.equal(applyAudio(pane, {}), null);
  assert.deepEqual(applyAudio(pane, { audible: true }).audible, true);
  assert.equal(applyAudio(pane, { audible: true }), null);
  assert.deepEqual(applyAudio(pane, { claiming: true }), {
    previous: { audible: true, claiming: false }, audible: true, claiming: true,
  });
});

test("a registry keys panes so two servers' %0 are different panes", () => {
  const registry = new PaneRegistry();
  const a = createPaneRecord({ tmuxServer: "/tmp/a,1", paneId: "%0", generation: 1, imageId: 1 });
  const b = createPaneRecord({ tmuxServer: "/tmp/b,2", paneId: "%0", generation: 2, imageId: 2 });
  registry.attach(a);
  const { superseded } = registry.attach(b);
  // Same pane id on different servers is two live panes, not a supersession — collapsing them
  // would take one server's live registration away.
  assert.equal(superseded, null);
  assert.equal(registry.size, 2);
  assert.equal(registry.current("%0", "/tmp/a,1"), a);
  assert.equal(registry.current("%0", "/tmp/b,2"), b);
});

test("reattaching a reused pane id supersedes, and hands back the old record for teardown", () => {
  // The teardown that a separate process simply never did — its image stayed on the terminal.
  const registry = new PaneRegistry();
  const first = record({ generation: 1, imageId: 100 });
  registry.attach(first);
  const { superseded } = registry.attach(record({ generation: 2, imageId: 200 }));
  assert.equal(superseded, first);
  assert.equal(registry.size, 1);
  assert.equal(registry.get(first.key), null);
  assert.equal(registry.current("%3", "/tmp/sock,111").imageId, 200);
});

test("a stale generation's detach is a miss, not a takedown of the live successor", () => {
  // In-process form of the bug that made the agent socket need bind-staging-then-rename.
  const registry = new PaneRegistry();
  const first = record({ generation: 1, imageId: 100 });
  registry.attach(first);
  const second = record({ generation: 2, imageId: 200 });
  registry.attach(second);
  assert.equal(registry.detach(first.key), null);
  assert.equal(registry.current("%3", "/tmp/sock,111"), second);
  assert.equal(registry.detach(second.key), second);
  assert.equal(registry.size, 0);
  assert.equal(registry.current("%3", "/tmp/sock,111"), null);
});

test("listing is ordered by generation, so diagnostics do not depend on Map order", () => {
  const registry = new PaneRegistry();
  registry.attach(createPaneRecord({ paneId: "%9", generation: 3, imageId: 3 }));
  registry.attach(createPaneRecord({ paneId: "%1", generation: 1, imageId: 1 }));
  registry.attach(createPaneRecord({ paneId: "%5", generation: 2, imageId: 2 }));
  assert.deepEqual(registry.list().map((pane) => pane.paneId), ["%1", "%5", "%9"]);
});

test("audio has a single owner and the incumbent keeps it while it is still audible", () => {
  const quiet = record({ paneId: "%1", generation: 1, imageId: 1 });
  const loud = record({ paneId: "%2", generation: 2, imageId: 2 });
  const louder = record({ paneId: "%3", generation: 3, imageId: 3 });
  applyAudio(loud, { audible: true });
  applyAudio(louder, { audible: true });
  assert.equal(audioOwnerAmong([quiet, loud, louder]), loud.key);
  // The incumbent is not stolen from just because another pane started making sound.
  assert.equal(audioOwnerAmong([quiet, loud, louder], louder.key), louder.key);
  // Once it falls silent the claim moves to the oldest remaining audible pane.
  applyAudio(louder, { audible: false });
  assert.equal(audioOwnerAmong([quiet, loud, louder], louder.key), loud.key);
});

test("silence has no owner at all, rather than a stale one", () => {
  const pane = record();
  assert.equal(audioOwnerAmong([pane]), null);
  assert.equal(audioOwnerAmong([], "some-key"), null);
  assert.equal(audioOwnerAmong([pane], pane.key), null);
});

// The Kitty image id namespace is terminal-wide: shared between the panes of one host AND with
// every per-pane engine still running beside it. An id that came from the engine's own pid would
// be identical for all N panes it serves, so ids are derived from the record and nothing else.
test("a pane's image ids all come from its record", () => {
  const pane = record({ imageId: 4242 });
  const ids = paneImageIds(pane);
  assert.equal(ids.base, 4242);
  assert.equal(ids.patchBase, 4243);
  assert.equal(ids.patchIds.length, PATCH_ID_COUNT);
  assert.deepEqual(ids.patchIds, [4243, 4244, 4245, 4246, 4247, 4248, 4249, 4250]);
  // Exclusive: the first id another pane may legally start at.
  assert.equal(ids.end, 4242 + IMAGE_ID_STRIDE);
  assert.equal(ids.end, 4251);
});

// The consequence of an overlap is invisible — no error, just one pane's whole frame appearing
// in another pane's rectangle, or a patch id freeing an image a different pane is still placing.
// An addressed control line carries `@%N` and no tmux server, so the registry has to answer by id
// alone — and must refuse to answer at all when two panes share one. Both halves matter: the first
// is what makes a hosted pane reachable, the second is what stops one pane's keystrokes reaching
// another pane that happens to have the same id on a different tmux server.
test("a pane id resolves on any server, and an ambiguous one resolves to nothing", () => {
  const registry = new PaneRegistry();
  const pane = createPaneRecord({ tmuxServer: "server-a", paneId: "%3", generation: 1, imageId: 1 });
  registry.attach(pane);
  assert.equal(registry.currentById("%3"), pane);
  assert.equal(registry.currentById("%9"), null);
  assert.deepEqual(registry.allById("%3"), [pane]);

  const twin = createPaneRecord({ tmuxServer: "server-b", paneId: "%3", generation: 2, imageId: 100 });
  registry.attach(twin);
  assert.equal(registry.currentById("%3"), null, "two panes share the id, so there is no answer");
  assert.equal(registry.allById("%3").length, 2, "and both are visible to the attach refusal");
});

test("a base that treads on a live pane's range is found before it is used", () => {
  const first = record({ paneId: "%1", generation: 1, imageId: 100 });
  const panes = [first];
  // Anywhere inside 100..108 collides, including the patch slots at the far end.
  for (const candidate of [100, 101, 104, 108]) {
    assert.equal(collidingImageRange(panes, candidate), first, `${candidate} must collide`);
  }
  // A base just below overlaps too: its own patch slots reach up into the first pane's base.
  for (const candidate of [92, 99]) {
    assert.equal(collidingImageRange(panes, candidate), first, `${candidate} must collide`);
  }
  // One stride away in either direction is the first base that does not.
  assert.equal(collidingImageRange(panes, 109), null);
  assert.equal(collidingImageRange(panes, 91), null);
  assert.equal(collidingImageRange([], 100), null);
});

test("a pane's frame files cover both formats and their staging names", () => {
  // The old cleanup named four paths from two module-level constants. That was right when a
  // process was a pane; the four are now derived from the pane's own id.
  assert.deepEqual(paneFrameFileNames(12345, 98466), [
    "tweb-frame-12345-98466.rgba",
    "tweb-frame-12345-98466.rgba.tmp",
    "tweb-frame-12345-98466.png",
    "tweb-frame-12345-98466.png.tmp",
  ]);
});

test("two panes in one engine own disjoint frame files", () => {
  // Otherwise one pane's detach deletes a frame the other is still writing.
  const a = new Set(paneFrameFileNames(7, 100));
  const b = paneFrameFileNames(7, 100 + IMAGE_ID_STRIDE);
  assert.equal(b.some((name) => a.has(name)), false);
});

test("an unusable id yields nothing rather than a wildcard", () => {
  // `Number(null)` is 0, so an integer check alone lets a null id name `tweb-frame-7-0.rgba` —
  // a real file that no pane owns. `createPaneRecord` refuses 0 for the same reason.
  for (const bad of [undefined, null, NaN, "x", Infinity, 0, -1, 1.5]) {
    assert.deepEqual(paneFrameFileNames(7, bad), [], `imageId ${String(bad)}`);
    assert.deepEqual(paneFrameFileNames(bad, 100), [], `pid ${String(bad)}`);
  }
});

test("the names a live engine deletes are the ones a dead engine's sweep collects", () => {
  // Two mechanisms, one naming rule: `cleanupFrameFiles` on the way out, and
  // `abandonedFrameFiles` at the next startup for an engine that never got there. A change to
  // either side that broke the match would stop the sweep silently.
  const { FRAME_FILE_PATTERN } = require("./orphan-watch.cjs");
  for (const name of paneFrameFileNames(12345, 98466)) {
    assert.ok(FRAME_FILE_PATTERN.test(name), `${name} must stay collectable`);
  }
});
