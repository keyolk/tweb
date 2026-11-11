"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createFrameContext, nextPatchId, notePatch, takeLivePatchIds, generationIsCurrent,
  applyFrameViewport, queueGfxFrame, completeGfxFrame,
  takeWholeFrameBase, settleWholeFrameBase, retirePatchesOnPlace, takePatchesToRetire,
  notePatchCells, wholeFrameCells, noteCellsWritten, forgetCells, PLACEHOLDER_CELLS_REFRESH_MS,
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
  assert.deepEqual(issued.slice(0, 7), [101, 102, 103, 104, 105, 106, 107]);
  // Wraps rather than growing without bound: a patch id only has to outlive its frame.
  assert.deepEqual(issued.slice(7), [101, 102]);
  // 108 is the second whole-frame base, never a patch.
  assert.ok(!issued.includes(108));
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

// A whole frame is in the worker when the pane's window is switched away. The hide has already
// deleted the image from the client, so placing this frame would draw the page over the window the
// client switched to, and nothing would delete it again.
test("a completion that arrives after the pane was hidden is dropped, and so is the frame behind it", () => {
  const frames = context();
  applyFrameViewport(frames, VP(80, 24, 800, 480));
  queueGfxFrame(frames, { generation: 1, tag: "a" });
  frames.imageTransferred = true;
  queueGfxFrame(frames, { generation: 1, tag: "b" });

  const settled = completeGfxFrame(frames, { visible: false });
  assert.equal(settled.stale, true, "the finished frame must be freed, not placed");
  assert.equal(settled.next, null, "the queued frame must not go to the worker either");
  assert.equal(frames.imageTransferred, false, "the reveal must send a whole frame, not a patch");
  assert.equal(frames.gfxBusy, false, "the worker must be free for the reveal's frame");
  assert.equal(frames.pendingGfxFrame, null);
});

test("a completion with no visibility given keeps the old behaviour", () => {
  const frames = context();
  applyFrameViewport(frames, VP(80, 24, 800, 480));
  queueGfxFrame(frames, { generation: 1 });
  assert.equal(completeGfxFrame(frames).stale, false);
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

// Retransmitting a whole frame under the id on screen blanks the image from the first chunk to the
// last (FEASIBILITY.md 2.5). Frames alternate between two ids so the old one stays until the new
// one is placed.
test("whole frames alternate between the pane's two bases, and the replaced one is freed", () => {
  const frames = context(100);
  assert.equal(frames.shownBase, 100);
  assert.equal(takeWholeFrameBase(frames), 108);
  assert.equal(settleWholeFrameBase(frames, { placed: true }), 100);
  assert.equal(frames.shownBase, 108);
  assert.equal(takeWholeFrameBase(frames), 100);
  assert.equal(settleWholeFrameBase(frames, { placed: true }), 108);
  assert.equal(frames.shownBase, 100);
});

test("a frame that was not placed leaves the shown base on screen", () => {
  const frames = context(100);
  takeWholeFrameBase(frames);
  assert.equal(settleWholeFrameBase(frames, { placed: false }), null);
  assert.equal(frames.shownBase, 100);
  assert.equal(frames.inFlightBase, null);
  // The next frame goes to the free base again, not onto the one on screen.
  assert.equal(takeWholeFrameBase(frames), 108);
});

test("a whole frame retires the patches it contains, not the ones sent while it was in flight", () => {
  const frames = context(100);
  const older = nextPatchId(frames);
  notePatch(frames, older, { x: 0, y: 0, width: 10, height: 10 });
  retirePatchesOnPlace(frames);
  // Still on screen until the frame lands, but no longer what the next patch must cover.
  assert.deepEqual(frames.livePatchIds, []);
  assert.equal(frames.patchedDamage, null);
  const newer = nextPatchId(frames);
  notePatch(frames, newer, { x: 5, y: 5, width: 4, height: 4 });
  assert.deepEqual(takePatchesToRetire(frames), [older]);
  assert.deepEqual(frames.livePatchIds, [newer]);
  assert.deepEqual(frames.retireOnPlace, []);
});

test("no patch id is reissued while it waits to be retired", () => {
  const frames = context(100);
  const ids = [];
  for (let i = 0; i < frames.imageIds.patchIds.length; i += 1) {
    const id = nextPatchId(frames);
    ids.push(id);
    notePatch(frames, id, { x: 0, y: 0, width: 1, height: 1 });
  }
  retirePatchesOnPlace(frames);
  // Every id now waits on the frame in flight. None is reissued: as a placeholder its cells still
  // name it, and a new patch under that id would draw into them too. The caller sends a whole frame.
  assert.equal(nextPatchId(frames), null);
  assert.deepEqual(takePatchesToRetire(frames).sort(), ids.sort());
  // Once retired they are free again.
  assert.notEqual(nextPatchId(frames), null);
});

test("a patch id waiting on the frame in flight is skipped, not reissued", () => {
  const frames = context(100);
  const first = nextPatchId(frames);
  notePatch(frames, first, { x: 0, y: 0, width: 1, height: 1 });
  retirePatchesOnPlace(frames);
  const issued = [];
  for (let i = 0; i < frames.imageIds.patchIds.length; i += 1) issued.push(nextPatchId(frames));
  assert.ok(!issued.includes(first));
});

// A local frame is one `t=f` command, so it has no chunked gap to hide. Alternating there renamed
// every placeholder cell and rewrote the pane's text with every whole frame.
test("a pane that does not alternate keeps sending under the base on screen", () => {
  const frames = context(100);
  assert.equal(takeWholeFrameBase(frames, { alternate: false }), 100);
  assert.equal(settleWholeFrameBase(frames, { placed: true }), null, "nothing to free");
  assert.equal(frames.shownBase, 100);
});

// The pane's grid already names the base at this size, so a whole frame writes no cells — the
// 135-270KB per frame that pegged the tmux server.
test("placeholder cells are written whole only when the grid does not already hold them", () => {
  const frames = context(100);
  frames.cells = { cols: 200, rows: 50 };
  assert.deepEqual(wholeFrameCells(frames, { now: 1000 }), { full: true, rects: [] });
  assert.deepEqual(wholeFrameCells(frames, { now: 1100 }), { full: false, rects: [] });
  frames.cells = { cols: 200, rows: 40 };
  assert.equal(wholeFrameCells(frames, { now: 1200 }).full, true, "a resize rewrites them");
  takeWholeFrameBase(frames);
  settleWholeFrameBase(frames, { placed: true });
  assert.equal(wholeFrameCells(frames, { now: 1300 }).full, true, "a flip to the other base does");
  forgetCells(frames);
  assert.equal(wholeFrameCells(frames, { now: 1400 }).full, true, "a freed image does");
});

// A retired patch's cells still name the patch id; the page shows through only once they are
// written back with the base's cells. Patches that stay are left alone.
test("a whole frame rewrites just the blocks of the patches it retires", () => {
  const frames = context(100);
  frames.cells = { cols: 200, rows: 50 };
  noteCellsWritten(frames, 1000);
  notePatchCells(frames, 101, { row: 3, col: 4, rows: 2, cols: 5 });
  notePatchCells(frames, 102, { row: 9, col: 9, rows: 1, cols: 1 });
  assert.deepEqual(wholeFrameCells(frames, { now: 1100, retired: [101] }),
    { full: false, rects: [{ row: 3, col: 4, rows: 2, cols: 5 }] });
  assert.deepEqual(wholeFrameCells(frames, { now: 1200, retired: [101] }), { full: false, rects: [] });
  assert.equal(frames.patchCells.has(102), true);
});

// The cells are pane text, and anything else writing there erases part of the page. A periodic
// full write bounds how long that can last, at one block per interval rather than per frame.
test("placeholder cells are rewritten whole once the refresh interval has passed", () => {
  const frames = context(100);
  noteCellsWritten(frames, 1000);
  assert.equal(wholeFrameCells(frames, { now: 1000 + PLACEHOLDER_CELLS_REFRESH_MS - 1 }).full, false);
  assert.equal(wholeFrameCells(frames, { now: 1000 + PLACEHOLDER_CELLS_REFRESH_MS }).full, true);
});
