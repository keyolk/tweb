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
    // Which of the pane's two whole-frame ids is the one placed, and which one the frame at the
    // worker is being transmitted under. See `paneImageIds` for why there are two.
    shownBase: ids.base,
    inFlightBase: null,
    // The pixel size and cell box of the image held under `shownBase`, while the terminal holds it
    // placed. A frame of the same size can then replace its pixels in place (`a=f`), under the
    // same id. Cleared wherever the image or its placement goes. See `takeWholeFrameBase`.
    shownFrameKey: null,
    inFlightFrameKey: null,
    inFlightEdit: false,
    // Patches a whole frame already contains, kept on screen until that frame is placed. A patch
    // sent while the frame is in flight is newer than the frame and stays. Each entry is
    // `{ id, seq }`: `seq` names the transfer whose frame contains the patch, and only a frame
    // from that transfer or a later one may retire it (see `takePatchesToRetire`).
    retireOnPlace: [],
    transferSeq: 0,
    // Where each patch still on screen sits, in cells — so a patch can be placed again under a new
    // base when the base it was a child of is deleted (see `survivingPatches`).
    patchPlaces: new Map(),
    // Placeholder panes: which cells the pane's grid holds. `cellsKey` names the base id and the
    // block size the cells were last written for, and `patchCells` where each live patch's own
    // cells sit. See `wholeFrameCells`.
    cellsKey: null,
    cellsWrittenAt: 0,
    patchCells: new Map(),

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
    // Whole frames that went out through shared memory (`t=s`), and which ring slot the next one
    // takes. Per pane because the object names are: two panes sharing a slot counter would hand
    // each other's names to the terminal. See shm-frames.cjs.
    shmWholeFrames: 0,
    shmSlot: 0,
    shmPatches: 0,
    shmPatchSlot: 0,
    // Whether this pane's marker file is in userData yet — what lets a later engine find its
    // objects if this one is killed before it can unlink them.
    shmMarked: false,
    // How much of the byte budget this pane has earned above the default, found by trying
    // rather than guessed: raised while nothing is dropping, cut back the moment something
    // does. See `playbackHeadroom` in frame-rate-policy.cjs.
    playbackHeadroom: 1,
    // Frames dropped to backpressure as of the last judgement, so the next one can tell
    // whether anything was dropped SINCE rather than ever.
    droppedAtLastSettle: 0,
    // Frames (whole and patches) sent as of the last judgement. A window that sent none is no
    // evidence the far end has room, so the headroom holds rather than climbs.
    sentAtLastSettle: 0,
    // What this pane's graphics have cost on the wire, in escape-sequence bytes before any tmux
    // wrapping. For a local terminal reading frame files these are small and only diagnostic;
    // for a remote one they ARE the link load, and `wireBytesPerWhole` — a moving average of the
    // whole frames just sent — is what the remote rate cap divides the budget by.
    wholeWireBytes: 0,
    patchWireBytes: 0,
    wireBytesPerWhole: null,

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
  const count = context.imageIds.patchIds.length;
  // An id still waiting to be retired with an in-flight whole frame is skipped. Its pixels are on
  // screen until that frame lands, and as a placeholder its cells still name it: reissuing it would
  // draw the new patch into the old patch's cells too. Null when every id is waiting, and the
  // caller sends the damage as a whole frame instead.
  for (let tried = 0; tried < count; tried += 1) {
    const id = context.imageIds.patchBase + context.nextPatchSlot;
    context.nextPatchSlot = (context.nextPatchSlot + 1) % count;
    if (!context.retireOnPlace.some((entry) => entry.id === id)) return id;
  }
  return null;
}

/**
 * The id the next whole frame is transmitted under, and whether it replaces the pixels of the image
 * already placed there (`edit`) rather than transmitting a new one.
 *
 * Decided at dispatch, not when the frame was queued. The queue is one deep and a queued frame
 * waits behind the one in flight, so only at dispatch is it known which id that one left placed.
 *
 * `editable` is for a frame that arrives in many chunks (inline over SSH). A new transmit under the
 * id on screen drops that image at its first chunk, which is why such panes alternate two ids. But
 * alternating renames every placeholder cell, and those cells were 84% of a remote pane's link.
 * `a=f` on the root frame keeps the image and its placement while the chunks arrive (measured on
 * Ghostty 1.4: no blank frame, cells untouched). It cannot grow the image ("EINVAL: frame
 * dimensions exceed image") and a smaller frame would leave the old pixels around it, so only a
 * frame of exactly the placed size and cell box is an edit. Anything else alternates as before.
 */
function takeWholeFrameBase(context, { alternate = true, editable = false, size = null } = {}) {
  const [first, second] = context.imageIds.bases;
  const key = size && size.width && size.height
    ? `${size.width}x${size.height}:${context.cells.cols}x${context.cells.rows}`
    : null;
  context.inFlightFrameKey = key;
  context.inFlightEdit = false;
  if (editable && key !== null && context.imageTransferred && !context.pendingImageDelete
    && context.shownFrameKey === `${context.shownBase}:${key}`) {
    context.inFlightEdit = true;
    context.inFlightBase = context.shownBase;
    return context.shownBase;
  }
  // Two ids are for a frame that arrives in many chunks (inline over SSH), where the terminal
  // drops the old image at the first chunk. A local frame is one `t=f` command and has no such
  // gap, so it is sent under the id on screen — which keeps a placeholder pane's cells naming
  // the right image without rewriting them.
  if (!alternate) {
    context.inFlightBase = context.shownBase;
    return context.shownBase;
  }
  const target = context.shownBase === first ? second : first;
  context.inFlightBase = target;
  return target;
}

/**
 * Settles which base is on screen once a whole frame completes. Returns the id to delete — the
 * one the new frame replaced — or null when nothing was placed.
 */
function settleWholeFrameBase(context, { placed }) {
  const target = context.inFlightBase;
  const key = context.inFlightFrameKey;
  context.inFlightBase = null;
  context.inFlightFrameKey = null;
  context.inFlightEdit = false;
  if (!placed || target === null) {
    // A frame sent under the id on screen and then dropped may have left that image half
    // replaced, or freed; the next frame transmits a whole new one.
    if (target !== null && target === context.shownBase) context.shownFrameKey = null;
    return null;
  }
  const previous = context.shownBase;
  context.shownBase = target;
  context.shownFrameKey = key === null ? null : `${target}:${key}`;
  return previous === target ? null : previous;
}

// How long a placeholder pane may go without its cells being rewritten whole. The cells are
// pane text, and anything else that writes text there (a clear, a stray write) erases part of the
// page until they are written again. Before, every whole frame rewrote them; that was 135-270KB
// per frame through tmux, which pegged the tmux server and lagged every pane. One full write per
// interval keeps the self-healing at a bounded cost.
const PLACEHOLDER_CELLS_REFRESH_MS = 2000;

/** Records where a placeholder patch's own cells were written. */
function notePatchCells(context, id, place) {
  context.patchCells.set(id, { row: place.row, col: place.col, rows: place.rows, cols: place.cols });
}

/**
 * Which cells a placed whole frame has to write in a placeholder pane.
 *
 * `full` when the grid does not already name this base at this size (first frame, a resize, a
 * flip to the other base) or the refresh interval has passed. Otherwise only the blocks of the
 * patches being retired, which still name their patch ids: written back with the base's cells,
 * the page shows through where the patch was.
 */
function wholeFrameCells(context, { now, retired = [] }) {
  const { rows, cols } = context.cells;
  const key = `${context.shownBase}:${rows}x${cols}`;
  const rects = retired.map((id) => context.patchCells.get(id)).filter(Boolean);
  for (const id of retired) context.patchCells.delete(id);
  if (context.cellsKey !== key || now - context.cellsWrittenAt >= PLACEHOLDER_CELLS_REFRESH_MS) {
    noteCellsWritten(context, now);
    return { full: true, rects: [] };
  }
  return { full: false, rects };
}

/** Records that the grid now holds the base's cells at the current size, all of them. */
function noteCellsWritten(context, now) {
  context.cellsKey = `${context.shownBase}:${context.cells.rows}x${context.cells.cols}`;
  context.cellsWrittenAt = now;
  context.patchCells.clear();
}

/** Forgets the written cells, so the next whole frame writes them all. */
function forgetCells(context) {
  context.cellsKey = null;
  context.shownFrameKey = null;
  context.patchCells.clear();
}

/**
 * Moves the live patches to the retire list: a whole frame that contains them was just queued.
 * The damage union goes with them, so a patch sent during the transfer covers only new damage.
 */
function retirePatchesOnPlace(context) {
  context.transferSeq += 1;
  const seq = context.transferSeq;
  for (const id of takeLivePatchIds(context)) {
    if (!context.retireOnPlace.some((entry) => entry.id === id)) context.retireOnPlace.push({ id, seq });
  }
  return seq;
}

/**
 * The patch ids to delete now that the frame of transfer `seq` is placed: the ones that frame
 * contains. An id the pool has since reissued to a newer patch is still live, and is left alone.
 *
 * Only up to `seq`. With a frame in flight and the next one queued behind it, the queued frame's
 * transfer has already moved the patches sent in between onto this list — patches NEWER than the
 * frame in flight. Retiring them when that older frame landed bared its stale pixels where they
 * had been, until the queued frame was placed or, if it never was, until something else changed:
 * the command palette showed two highlighted rows.
 */
function takePatchesToRetire(context, seq = Infinity) {
  const ids = [];
  const kept = [];
  for (const entry of context.retireOnPlace) {
    if (entry.seq > seq) kept.push(entry);
    else if (!context.livePatchIds.includes(entry.id)) ids.push(entry.id);
  }
  context.retireOnPlace = kept;
  for (const id of ids) context.patchPlaces.delete(id);
  return ids;
}

/**
 * The patches still on screen after a frame is placed, oldest first, with where each sits.
 *
 * A relative patch is a child of the base it was placed over, and deleting that base deletes the
 * child (relative-placement.cjs). A patch sent while a frame was in flight was placed over the OLD
 * base; when the frame lands and the old base is deleted, the patch went with it — and the frame,
 * older than the patch, showed through until the next change. These are placed again under the new
 * base, in order, before the old one is deleted.
 */
function survivingPatches(context) {
  const ids = [...context.retireOnPlace.map((entry) => entry.id), ...context.livePatchIds];
  return [...new Set(ids)]
    .map((id) => ({ id, place: context.patchPlaces.get(id) }))
    .filter((patch) => patch.place);
}

/** Records a patch as live, so the next whole frame knows what to delete. */
function notePatch(context, id, damage, place = null) {
  if (!context.livePatchIds.includes(id)) context.livePatchIds.push(id);
  // Reissued ids move to the end: the order is the order they were drawn in.
  else context.livePatchIds = [...context.livePatchIds.filter((live) => live !== id), id];
  if (place) context.patchPlaces.set(id, place);
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
 *
 * `visible` is the pane's visibility when the completion arrives. A frame handed to the worker
 * while the pane was on screen can finish after the pane's window was switched away. The hide
 * has already deleted the image from the client, and placing this frame then would put it back
 * over the window the client switched to. Nothing deletes it again, because that client is no
 * longer in the pane's client set. So a hidden completion is stale too, and the frame queued
 * behind it is not dispatched: the reveal repaints from a fresh frame.
 */
function completeGfxFrame(context, { visible = true } = {}) {
  const stale = !visible || (context.activeGfxGeneration !== null
    && !generationIsCurrent(context, context.activeGfxGeneration));
  context.gfxBusy = false;
  context.activeGfxGeneration = null;
  if (stale) {
    context.imageTransferred = false;
    context.shownFrameKey = null;
  }
  const queued = context.pendingGfxFrame;
  context.pendingGfxFrame = null;
  const next = visible && queued && generationIsCurrent(context, queued.generation) ? queued : null;
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
  takeWholeFrameBase,
  settleWholeFrameBase,
  retirePatchesOnPlace,
  takePatchesToRetire,
  survivingPatches,
  notePatchCells,
  wholeFrameCells,
  noteCellsWritten,
  forgetCells,
  PLACEHOLDER_CELLS_REFRESH_MS,
};
