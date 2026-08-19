"use strict";

// The frame pipeline's state, per pane.
//
// One Electron per pane meant all of this was module-level and "which pane is this frame for"
// never had to be asked. It is asked on every message once one process serves N, and the answers
// are not interchangeable: two panes have different viewport generations, different image ids,
// different patch pools and different notions of what the terminal is currently holding. Sharing
// any one of them across panes is not a small error — it is one pane's frame drawn into another
// pane's rectangle, or a patch id freeing an image a different pane is still placing.
//
// Kept here, away from Electron, so the decisions stay testable without a browser. What lives in
// this module is state and the small rules over it; the effects (encoding, writing, resizing) stay
// with the caller that owns a window.

const { paneImageIds } = require("./pane-registry.cjs");

/**
 * The frame-pipeline state one pane owns.
 *
 * `record` is the identity this state hangs off, and the image ids come from it rather than from
 * anything process-wide — see `paneImageIds`.
 */
function createFrameContext(record, { frameRate = 30 } = {}) {
  const ids = paneImageIds(record);
  return {
    record,
    imageIds: ids,

    // What the pane currently looks like. `generation` is bumped by every viewport change and is
    // what makes a frame that arrives after a resize droppable: it describes a pane that no
    // longer exists at that size, and placing it would have the terminal scale a stale image
    // into the new cell box.
    viewport: null,
    generation: 0,
    origin: null,
    cells: { cols: 80, rows: 24 },

    // Whether the terminal is holding this pane's base image, which is what lets a resize
    // re-place it without resending the pixels. Cleared wherever the data is freed — a claim
    // that outlived the data had the pane re-placing an image the terminal had dropped.
    imageTransferred: false,
    pendingImageDelete: false,

    // The damage patches live over the base frame. A small pool, cycled: a patch id only has to
    // outlive the frame it patches.
    nextPatchSlot: 0,
    livePatchIds: [],
    // Everything patched since the last whole frame. A later, narrower patch would otherwise
    // leave an earlier, wider one showing around it — a deleted character stays on screen until
    // something forces a whole frame.
    patchedDamage: null,

    // The single-frame queue in front of the pane's rate limit.
    pendingFrame: null,
    pendingFrameTimer: null,
    lastFrameSentAt: 0,

    // The graphics worker is shared between panes — it is one thread doing one CPU-bound job —
    // so each pane keeps its own view of what it has in flight there.
    gfxBusy: false,
    activeGfxGeneration: null,
    pendingGfxFrame: null,
    droppedGfxFrames: 0,
    // Whole frames the worker deflated for THIS pane. Beside `droppedGfxFrames` because it is
    // read the same way — against the pane's own `whole` — and belongs to the pane for the same
    // reason: as a module-level counter it summed every pane's compressions and reported the sum
    // to each of them.
    compressedWholeFrames: 0,

    frameRate,
    framesSentCount: 0,
  };
}

/**
 * The next patch id, advancing the pool.
 *
 * Ids come from the pane's own range. A pool shared between panes would have one pane's `d=I`
 * free an image another pane was still placing.
 */
function nextPatchId(context) {
  const id = context.imageIds.patchBase + context.nextPatchSlot;
  context.nextPatchSlot = (context.nextPatchSlot + 1) % context.imageIds.patchIds.length;
  return id;
}

/** Records a patch as live, so the next whole frame knows what to delete. */
function notePatch(context, id, damage) {
  if (!context.livePatchIds.includes(id)) context.livePatchIds.push(id);
  context.patchedDamage = damage;
}

/**
 * The patch ids to delete, and the pool emptied.
 *
 * Returned rather than deleted here because the write is the caller's: this module knows which
 * ids are live, and only the caller knows which tty they go to.
 */
function takeLivePatchIds(context) {
  const ids = context.livePatchIds;
  context.livePatchIds = [];
  context.patchedDamage = null;
  return ids;
}

/**
 * Whether a frame produced for `generation` still describes the pane.
 *
 * The single question behind every drop in the pipeline. A frame from an older generation was
 * rendered at a size the pane no longer has, and the terminal would scale it into the new cell
 * box rather than reject it — so it looks like a rendering bug rather than a stale frame.
 */
function generationIsCurrent(context, generation) {
  return generation === context.generation;
}

/**
 * Applies a viewport, returning what changed, or null when nothing did.
 *
 * The generation is bumped by EITHER a size or an origin change, which is what the pane has
 * always done. A move looks like it should be cheaper than a resize — same picture, new place —
 * but it is not: the generation bump is what cancels the frame in flight, the frame queued at the
 * worker and the cached tab frames, and a frame in flight was rendered to be anchored where the
 * pane no longer is. A move also strands the old placement, which is why the caller pairs it with
 * a delete. Only an origin the caller does not know (undefined) leaves everything alone.
 */
function applyFrameViewport(context, viewport, origin) {
  const nextOrigin = origin === undefined ? context.origin : origin;
  const previous = context.viewport;
  const sizeChanged = !previous
    || previous.cols !== viewport.cols || previous.rows !== viewport.rows
    || previous.width !== viewport.width || previous.height !== viewport.height;
  const originChanged = (context.origin?.left ?? null) !== (nextOrigin?.left ?? null)
    || (context.origin?.top ?? null) !== (nextOrigin?.top ?? null);
  if (!sizeChanged && !originChanged) return null;
  context.viewport = viewport;
  context.origin = nextOrigin;
  context.cells = { cols: viewport.cols, rows: viewport.rows };
  context.generation += 1;
  // A moved pane leaves a placement at the old anchor, and a shrunk one leaves the rows it gave
  // up still covered — usually hiding the pane that just appeared there. Neither is repaired by
  // re-placing; growing is, so it is not reported.
  const shrank = Boolean(previous
    && (viewport.cols < previous.cols || viewport.rows < previous.rows));
  return { sizeChanged, originChanged, shrank, generation: context.generation, previous };
}

/**
 * Whether a frame may be dispatched to the shared graphics worker now, or must queue behind one.
 *
 * The queue is one frame deep per pane on purpose: a deeper one would spend memory to show
 * frames the pane has already moved past. What it must NOT be is one queue shared between panes,
 * which would let a busy pane starve a quiet one of its first frame.
 */
function queueGfxFrame(context, frame) {
  if (!generationIsCurrent(context, frame.generation)) return null;
  if (!context.gfxBusy) {
    context.gfxBusy = true;
    context.activeGfxGeneration = frame.generation;
    return frame;
  }
  if (context.pendingGfxFrame) context.droppedGfxFrames += 1;
  context.pendingGfxFrame = frame;
  return null;
}

/**
 * Settles a completed worker hand-off: what to do about the output, and what to dispatch next.
 *
 * `stale` is the case that has to be handled rather than ignored. The worker finished a frame the
 * pane has already outgrown; its data must be freed, and — this is the part that was missing —
 * `imageTransferred` must go with it. Leaving the claim set had `replacePlacement` re-placing an
 * image the terminal no longer held, which `bench/GATES.md` records as self-closing *only while
 * one process owns one pane's generations*.
 */
function completeGfxFrame(context) {
  const stale = context.activeGfxGeneration !== null
    && !generationIsCurrent(context, context.activeGfxGeneration);
  context.gfxBusy = false;
  context.activeGfxGeneration = null;
  if (stale) context.imageTransferred = false;
  const queued = context.pendingGfxFrame;
  context.pendingGfxFrame = null;
  const next = queued && generationIsCurrent(context, queued.generation) ? queued : null;
  if (next) {
    context.gfxBusy = true;
    context.activeGfxGeneration = next.generation;
  }
  return { stale, next };
}

module.exports = {
  createFrameContext,
  nextPatchId,
  notePatch,
  takeLivePatchIds,
  generationIsCurrent,
  applyFrameViewport,
  queueGfxFrame,
  completeGfxFrame,
};
