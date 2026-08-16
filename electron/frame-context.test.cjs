"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createFrameContext, nextPatchId, notePatch, takeLivePatchIds, generationIsCurrent,
  applyFrameViewport, queueGfxFrame, completeGfxFrame,
} = require("./frame-context.cjs");
const { createPaneRecord } = require("./pane-registry.cjs");

function context(imageId = 4242) {
  return createFrameContext(createPaneRecord({ paneId: "%3", generation: 1, imageId }));
}

const VP = (cols, rows, width, height) => ({ cols, rows, width, height });

test("a context takes its image ids from the pane, never from anything process-wide", () => {
  const frames = context(9000);
  assert.equal(frames.imageIds.base, 9000);
  assert.equal(frames.imageIds.patchBase, 9001);
  // A shared pool would have one pane's d=I free an image another pane was still placing.
  const other = context(30000);
  assert.equal(other.imageIds.base, 30000);
});

test("patch ids come from the pane's own range and cycle within it", () => {
  const frames = context(100);
  const issued = [];
  for (let i = 0; i < frames.imageIds.patchIds.length + 2; i += 1) issued.push(nextPatchId(frames));
  assert.deepEqual(issued.slice(0, 8), [101, 102, 103, 104, 105, 106, 107, 108]);
  // Wraps rather than growing without bound: a patch id only has to outlive its frame.
  assert.deepEqual(issued.slice(8), [101, 102]);
  assert.ok(issued.every((id) => frames.imageIds.patchIds.includes(id)));
});

test("live patches are handed over for deletion and the pool is emptied with them", () => {
  const frames = context();
  const first = nextPatchId(frames);
  notePatch(frames, first, { x: 0, y: 0, width: 10, height: 10 });
  notePatch(frames, first, { x: 0, y: 0, width: 20, height: 20 });
  // Recorded once however often the slot is reused, so the delete is not issued twice.
  assert.deepEqual(frames.livePatchIds, [first]);
  assert.deepEqual(frames.patchedDamage, { x: 0, y: 0, width: 20, height: 20 });

  assert.deepEqual(takeLivePatchIds(frames), [first]);
  assert.deepEqual(frames.livePatchIds, []);
  // The union goes with them: a whole frame contains everything the patches covered.
  assert.equal(frames.patchedDamage, null);
});

// A move looks like it should be cheaper than a resize — same picture, new place — but the
// generation bump is what cancels the frame in flight, and a frame in flight was rendered to be
// anchored where the pane no longer is. So both bump. This mirrors what `applyViewport` in
// main.cjs has always done; a version that bumped only on size would silently change the resize
// path on the shipping build.
test("both a resize and a move bump the generation, because both invalidate work in flight", () => {
  const frames = context();
  const first = applyFrameViewport(frames, VP(80, 24, 800, 480), { left: 0, top: 0 });
  assert.equal(first.sizeChanged, true);
  assert.equal(frames.generation, 1);

  const moved = applyFrameViewport(frames, VP(80, 24, 800, 480), { left: 40, top: 0 });
  assert.equal(moved.originChanged, true);
  assert.equal(moved.sizeChanged, false);
  assert.equal(frames.generation, 2);

  applyFrameViewport(frames, VP(100, 24, 1000, 480), { left: 40, top: 0 });
  assert.equal(frames.generation, 3);
  assert.deepEqual(frames.cells, { cols: 100, rows: 24 });
});

// A shrunk pane leaves the rows it gave up still covered, usually hiding whatever appeared
// there. Growing corrects itself with the next placement, so it is not reported.
test("only a shrink is flagged for the caller's delete", () => {
  const frames = context();
  applyFrameViewport(frames, VP(80, 24, 800, 480));
  assert.equal(applyFrameViewport(frames, VP(60, 24, 600, 480)).shrank, true);
  assert.equal(applyFrameViewport(frames, VP(90, 24, 900, 480)).shrank, false);
  assert.equal(applyFrameViewport(frames, VP(90, 12, 900, 240)).shrank, true);
});

test("an unchanged viewport reports nothing, so no resize is provoked", () => {
  const frames = context();
  applyFrameViewport(frames, VP(80, 24, 800, 480), { left: 0, top: 0 });
  assert.equal(applyFrameViewport(frames, VP(80, 24, 800, 480), { left: 0, top: 0 }), null);
  // An absent origin means "leave the anchor where it is", which is not the same as 0,0.
  assert.equal(applyFrameViewport(frames, VP(80, 24, 800, 480), undefined), null);
  assert.deepEqual(frames.origin, { left: 0, top: 0 });
});

test("a frame from an older generation is not current, whatever else is true of it", () => {
  const frames = context();
  applyFrameViewport(frames, VP(80, 24, 800, 480));
  assert.equal(generationIsCurrent(frames, 1), true);
  applyFrameViewport(frames, VP(60, 24, 600, 480));
  assert.equal(generationIsCurrent(frames, 1), false);
  assert.equal(generationIsCurrent(frames, 2), true);
});

// The queue is one frame deep PER PANE. A deeper one spends memory to show frames the pane has
// already moved past; one shared between panes would let a busy pane starve a quiet one.
test("the worker queue is one frame deep and drops the superseded one", () => {
  const frames = context();
  applyFrameViewport(frames, VP(80, 24, 800, 480));
  const first = { generation: 1, tag: "a" };
  assert.equal(queueGfxFrame(frames, first), first, "an idle worker takes the frame straight away");
  assert.equal(frames.gfxBusy, true);

  assert.equal(queueGfxFrame(frames, { generation: 1, tag: "b" }), null);
  assert.equal(queueGfxFrame(frames, { generation: 1, tag: "c" }), null);
  assert.equal(frames.pendingGfxFrame.tag, "c");
  assert.equal(frames.droppedGfxFrames, 1);
});

test("a frame for a generation the pane has already left is never queued", () => {
  const frames = context();
  applyFrameViewport(frames, VP(80, 24, 800, 480));
  applyFrameViewport(frames, VP(60, 24, 600, 480));
  assert.equal(queueGfxFrame(frames, { generation: 1 }), null);
  assert.equal(frames.gfxBusy, false);
  assert.equal(frames.pendingGfxFrame, null);
});

// THE FIX bench/GATES.md names. The worker finished a frame the pane has outgrown, so its data is
// freed — and the claim that the terminal holds the base image must go with it. Leaving it set had
// `replacePlacement` re-placing an image the terminal had already dropped. Self-closing only while
// one process owns one pane's generations, which is exactly what stops being true here.
test("a stale completion clears the claim that the terminal holds the image", () => {
  const frames = context();
  applyFrameViewport(frames, VP(80, 24, 800, 480));
  queueGfxFrame(frames, { generation: 1 });
  frames.imageTransferred = true;

  applyFrameViewport(frames, VP(60, 24, 600, 480));
  const settled = completeGfxFrame(frames);
  assert.equal(settled.stale, true);
  assert.equal(frames.imageTransferred, false, "the data was freed, so the claim must go too");
  assert.equal(settled.next, null);
});

test("a current completion keeps the claim and dispatches what was waiting", () => {
  const frames = context();
  applyFrameViewport(frames, VP(80, 24, 800, 480));
  queueGfxFrame(frames, { generation: 1, tag: "a" });
  frames.imageTransferred = true;
  queueGfxFrame(frames, { generation: 1, tag: "b" });

  const settled = completeGfxFrame(frames);
  assert.equal(settled.stale, false);
  assert.equal(frames.imageTransferred, true);
  assert.equal(settled.next.tag, "b");
  // The worker is busy again with the frame just handed over, not left idle to be re-dispatched.
  assert.equal(frames.gfxBusy, true);
  assert.equal(frames.activeGfxGeneration, 1);
  assert.equal(frames.pendingGfxFrame, null);
});

test("a queued frame the pane has outgrown is dropped rather than dispatched", () => {
  const frames = context();
  applyFrameViewport(frames, VP(80, 24, 800, 480));
  queueGfxFrame(frames, { generation: 1, tag: "a" });
  queueGfxFrame(frames, { generation: 1, tag: "b" });
  applyFrameViewport(frames, VP(60, 24, 600, 480));

  const settled = completeGfxFrame(frames);
  assert.equal(settled.next, null);
  assert.equal(frames.gfxBusy, false, "the worker must be free for the next current frame");
});

// Two panes in one runtime keep entirely separate pipelines. Sharing any of it is one pane's
// frame drawn into the other pane's rectangle.
test("two panes' pipelines do not touch", () => {
  const left = context(1000);
  const right = context(2000);
  applyFrameViewport(left, VP(80, 24, 800, 480));
  applyFrameViewport(left, VP(60, 24, 600, 480));
  applyFrameViewport(right, VP(100, 30, 1000, 600));

  assert.equal(left.generation, 2);
  assert.equal(right.generation, 1);
  assert.equal(nextPatchId(left), 1001);
  assert.equal(nextPatchId(right), 2001);
  queueGfxFrame(left, { generation: 2 });
  assert.equal(right.gfxBusy, false, "one pane's worker hand-off must not busy another's");
});
