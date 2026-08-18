"use strict";

// The per-pane state that used to be per-process.
//
// One Electron per pane meant every one of these lived in a module-level variable, and "which
// pane is this for" never had to be asked. One Electron hosting N panes has to ask it on every
// message, so the state is named, keyed, and kept here — deliberately with no Electron import,
// so the decisions stay testable without a browser.
//
// The seven things a pane owns:
//   viewport     cells and pixels, plus the tmux origin the image is anchored at
//   visibility   whether a client is actually looking at this pane
//   frame tier   which of the three adaptive rates it is currently on
//   surface      whether the window is collapsed to width x 1, and the size to restore to
//   agent socket the automation endpoint bound for this pane
//   audio        whether it is making sound and whether it holds the claim
//   history      where its navigation records go
//
// Mutators return what changed rather than doing the work, for the same reason the rest of this
// codebase's policy modules are pure: the caller does the effects, the test does the decision.
// A mutator that returns null means "nothing changed" — that null is what suppresses a
// re-resize, a redundant claim write or a frame-rate call that would itself provoke a paint.

const { paneKey } = require("./pane-identity.cjs");

// How many damage-patch ids a pane owns beside its base image.
//
// A small fixed pool, cycled: a patch id only has to outlive the frame it patches, and the
// terminal took 64 in a row without complaint. It lives here rather than beside the frame path
// because it is a property of the *id layout* — how much room one pane occupies in a namespace
// shared with every other pane — and the allocator on the other side of the attach has to agree
// with it exactly.
const PATCH_ID_COUNT = 8;

// The distance between two panes' bases, if their ranges are not to overlap.
//
// The Kitty image id namespace is TERMINAL-WIDE. It is shared not only between the panes of one
// host but with every per-pane engine still running beside it, and an overlap does not fail
// loudly — one pane's whole frame simply appears in another pane, or a patch id frees an image
// a different pane is still placing. Anything that hands out bases must space them by at least
// this much.
const IMAGE_ID_STRIDE = PATCH_ID_COUNT + 1;

/**
 * The image ids a pane owns, derived from its record and from nothing else.
 *
 * Never from the engine's process identity: one process hosting N panes has one pid and N panes,
 * so a pid-derived id would give every pane the same one. The base arrives over the attach from
 * the caller that already has a collision-free scheme.
 */
function paneImageIds(record) {
  const base = Number(record.imageId);
  const patchBase = base + 1;
  return {
    base,
    patchBase,
    patchIds: Array.from({ length: PATCH_ID_COUNT }, (_, slot) => patchBase + slot),
    // Exclusive, so `last + 1` is the first id another pane may legally start at.
    end: base + IMAGE_ID_STRIDE,
  };
}

/**
 * The frame file names one pane owns: both formats, and the staging name of each.
 *
 * Names rather than paths, so the rule stays testable without a userData directory — the caller
 * joins them. The shape is a contract with `orphan-watch.cjs`'s FRAME_FILE_PATTERN, which is how
 * a *killed* engine's files stay collectable at the next startup; this function is what a *live*
 * engine uses to drop its own, either when a pane detaches or on the way out.
 *
 * Per pane rather than per process because one engine can serve N. Two module-level constants
 * were right when a process was a pane, and became a ReferenceError the moment the paths went
 * per-pane — thrown from an exit handler, so it took the whole cleanup down with it and every
 * clean exit leaked its frames until the next sweep.
 *
 * @param {number} pid the engine that wrote them
 * @param {number} imageId the pane's base image id
 * @returns {string[]} file names, empty when either id is unusable
 */
function paneFrameFileNames(pid, imageId) {
  const owner = Number(pid);
  const base = Number(imageId);
  // Positive, not merely an integer: `Number(null)` is 0, which would name a real file that no
  // pane owns — and `createPaneRecord` refuses an id of 0 for the same reason.
  if (!Number.isSafeInteger(owner) || owner <= 0) return [];
  if (!Number.isSafeInteger(base) || base <= 0) return [];
  return ["rgba", "png"].flatMap((extension) => {
    const name = `tweb-frame-${owner}-${base}.${extension}`;
    return [name, `${name}.tmp`];
  });
}

/**
 * The already-registered pane whose image ids a candidate base would tread on, if any.
 *
 * Checked rather than assumed because the consequence of an overlap is invisible: no error, just
 * one pane's image appearing in another pane's rectangle. A caller that finds a collision should
 * refuse the attach — a pane that never appears is a better failure than two panes corrupting
 * each other, and the frontend still has its own engine to fall back to.
 */
function collidingImageRange(records, candidateImageId) {
  const candidate = paneImageIds({ imageId: candidateImageId });
  return records.find((record) => {
    const owned = paneImageIds(record);
    return candidate.base < owned.end && owned.base < candidate.end;
  }) || null;
}

function sameViewport(left, right) {
  if (!left || !right) return false;
  return left.cols === right.cols && left.rows === right.rows
    && left.width === right.width && left.height === right.height;
}

function sameOrigin(left, right) {
  return (left?.left ?? null) === (right?.left ?? null)
    && (left?.top ?? null) === (right?.top ?? null);
}

/**
 * Creates the record for one pane.
 *
 * `imageId` is required and never invented here. Kitty image ids are a terminal-wide namespace
 * shared with every other process drawing into the same terminal — including the per-pane engines
 * that keep running beside a host — so a host that allocated its own range would eventually
 * overwrite a legacy engine's image. The caller that already has a collision-free scheme supplies
 * it.
 */
function createPaneRecord({
  tmuxServer = null,
  paneId,
  generation,
  tty = null,
  imageId,
  viewport = null,
  origin = null,
  visible = true,
  frameTier = null,
  agentSocketPath = null,
  historyPath = null,
}) {
  const id = Number(imageId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(`a pane record needs a positive image id, got ${imageId}`);
  }
  return {
    key: paneKey(tmuxServer, paneId, generation),
    tmuxServer,
    paneId: String(paneId),
    generation: Number(generation),
    tty,
    imageId: id,
    viewport,
    origin,
    visible: Boolean(visible),
    frameTier,
    // A pane starts uncollapsed: collapsing is what the surface policy decides once it knows
    // whether anyone is looking, and assuming collapsed here would blank a visible pane.
    surface: { collapsed: false, logical: null },
    agentSocketPath,
    audio: { audible: false, claiming: false },
    historyPath,
    // Whole/patch counters are per-pane because `tweb diag` reports them per-pane, and a shared
    // counter would attribute one pane's frames to another.
    frames: { whole: 0, patches: 0 },
    // Where this pane lives right now, who is looking at it, and how we know.
    //
    // Per-pane because panes in one engine sit in DIFFERENT tmux windows watched by DIFFERENT
    // clients. Held once per process, the last pane to push its listing overwrote every other
    // pane's — measured with three panes: %11, pushed as window @2, reported @1. A pane holding
    // another pane's placement addresses its frames by the wrong window and deletes its image
    // from a tty that is still showing it.
    //
    // `source` and `pushedAt` follow because the poll fallback is armed per pane: a frontend that
    // pushes for one pane says nothing about another whose frontend is older or absent.
    visibility: {
      placement: null,
      clientTtys: new Set(),
      source: "startup",
      pushedAt: null,
      checkRunning: false,
      pollTimer: null,
      fallbackTimer: null,
    },
  };
}

/**
 * The viewport change, or null when the geometry is unchanged.
 *
 * Origin is reported separately from size because they have different consequences: a moved pane
 * strands a placement at the old anchor and needs a delete, while a resize needs the surface
 * re-planned. A caller that only checked "something changed" would do both every time.
 */
function applyViewport(record, viewport, origin) {
  const nextOrigin = origin === undefined ? record.origin : origin;
  const sizeChanged = !sameViewport(record.viewport, viewport);
  const originChanged = !sameOrigin(record.origin, nextOrigin);
  if (!sizeChanged && !originChanged) return null;
  const previous = record.viewport;
  record.viewport = viewport;
  record.origin = nextOrigin;
  // A pane that shrank leaves the rows it gave up still covered, usually hiding whatever pane
  // just appeared there. Growing corrects itself with the next placement, so it is not reported.
  const shrank = Boolean(previous && viewport
    && (viewport.cols < previous.cols || viewport.rows < previous.rows));
  return { sizeChanged, originChanged, shrank, previous };
}

/** The visibility change, or null when it already held that value. */
function applyVisibility(record, visible) {
  const next = Boolean(visible);
  if (record.visible === next) return null;
  const previous = record.visible;
  record.visible = next;
  return { previous, visible: next };
}

/**
 * The frame-tier change, or null when the pane is already on that tier.
 *
 * Suppressing the no-op matters more than it looks: `setFrameRate` provokes a paint of its own,
 * and the playback tier is decided by counting paints over a window. Re-applying the current
 * tier would feed the detector paints it caused itself.
 */
function applyFrameTier(record, rate) {
  const next = Number(rate);
  if (!Number.isFinite(next)) return null;
  if (record.frameTier === next) return null;
  const previous = record.frameTier;
  record.frameTier = next;
  return { previous, rate: next };
}

/**
 * The surface change, or null when the surface is already in that state.
 *
 * `logical` is carried alongside `collapsed` because restoring needs a size, and the size a pane
 * should restore to is the last one it was actually asked for — not whatever the pane happens to
 * measure at the moment the agent asks, which for a collapsed pane is height 1.
 */
function applySurface(record, { collapsed, logical }) {
  const nextCollapsed = Boolean(collapsed);
  const nextLogical = logical === undefined ? record.surface.logical : logical;
  const collapseChanged = record.surface.collapsed !== nextCollapsed;
  const logicalChanged = record.surface.logical?.width !== nextLogical?.width
    || record.surface.logical?.height !== nextLogical?.height;
  if (!collapseChanged && !logicalChanged) return null;
  const previous = { ...record.surface };
  record.surface = { collapsed: nextCollapsed, logical: nextLogical };
  return { previous, collapsed: nextCollapsed, logical: nextLogical, collapseChanged };
}

/** The audio change, or null when nothing about this pane's sound changed. */
function applyAudio(record, { audible, claiming }) {
  const nextAudible = audible === undefined ? record.audio.audible : Boolean(audible);
  const nextClaiming = claiming === undefined ? record.audio.claiming : Boolean(claiming);
  if (record.audio.audible === nextAudible && record.audio.claiming === nextClaiming) return null;
  const previous = { ...record.audio };
  record.audio = { audible: nextAudible, claiming: nextClaiming };
  return { previous, audible: nextAudible, claiming: nextClaiming };
}

/**
 * The registry of live panes.
 *
 * Two indexes, because two different questions are asked of it. Messages arrive addressed by pane
 * id — a frontend writing `@%3 RESIZE ...` knows the id and not the generation — so the address
 * index answers "which registration is `%3` on right now". The key index is what everything else
 * uses, and it is what makes a stale generation a lookup miss instead of a mis-delivery.
 *
 * The address index is keyed on server *and* pane id, not the id alone. Two tmux servers both
 * hand out `%0`, and collapsing them would make one server's pane supersede the other's live one.
 */
class PaneRegistry {
  constructor() {
    this.byKey = new Map();
    this.byAddress = new Map();
  }

  static address(tmuxServer, paneId) {
    return `${tmuxServer || "local"}/${String(paneId)}`;
  }

  /**
   * Registers a pane, superseding any earlier registration of the same pane on the same server.
   *
   * Supersession is the reattach case: a pane whose frontend was SIGKILLed and replaced. The old
   * record is returned so the caller can run its teardown — deleting its image, closing its
   * writer — which is exactly the work that was skipped when engines were separate processes and
   * the old one simply lingered.
   */
  attach(record) {
    const address = PaneRegistry.address(record.tmuxServer, record.paneId);
    const superseded = this.byAddress.get(address) || null;
    if (superseded) this.byKey.delete(superseded.key);
    this.byKey.set(record.key, record);
    this.byAddress.set(address, record);
    return { record, superseded };
  }

  get(key) {
    return this.byKey.get(key) || null;
  }

  /**
   * The registration a pane id is currently on, whatever its generation.
   *
   * `tmuxServer` narrows the lookup when the caller knows which server it means. A hosted engine
   * does NOT: the addressed control lines it receives carry `@%N` and nothing else, and its own
   * `$TMUX` is the daemon's — so passing that would look the pane up under the wrong server and
   * find nothing. Measured end to end: with `twebd` started outside tmux, every VIS, RESIZE and
   * INPUT for a hosted pane was dropped in silence, and the pane sat blank while the daemon
   * reported it hosted. See `currentById`.
   */
  current(paneId, tmuxServer = null) {
    return this.byAddress.get(PaneRegistry.address(tmuxServer, paneId)) || null;
  }

  /**
   * The registration for a pane id on ANY server, or null when the answer is not unique.
   *
   * This is what an addressed control line resolves through, because that is what the wire says:
   * the daemon addresses `@%N` and carries no server. Null on ambiguity rather than a guess —
   * delivering one pane's keystrokes to another pane that happens to share an id is the failure
   * this whole registry exists to prevent, and `handleAttach` refuses the second such pane so the
   * ambiguity does not arise in the first place.
   */
  currentById(paneId) {
    const wanted = String(paneId);
    let found = null;
    for (const record of this.byKey.values()) {
      if (record.paneId !== wanted) continue;
      if (found) return null;
      found = record;
    }
    return found;
  }

  /** Every registration for a pane id, regardless of server. Used to refuse an ambiguous attach. */
  allById(paneId) {
    const wanted = String(paneId);
    return [...this.byKey.values()].filter((record) => record.paneId === wanted);
  }

  /**
   * Removes a registration, but only if it is still the current one.
   *
   * A detach carrying a stale generation is a message from a pane that has already been replaced.
   * Honouring it would take the live successor's registration away — the in-process form of the
   * exact bug that made the agent socket need bind-staging-then-rename.
   */
  detach(key) {
    const record = this.byKey.get(key);
    if (!record) return null;
    this.byKey.delete(key);
    const address = PaneRegistry.address(record.tmuxServer, record.paneId);
    if (this.byAddress.get(address) === record) this.byAddress.delete(address);
    return record;
  }

  list() {
    return [...this.byKey.values()].sort((left, right) => left.generation - right.generation);
  }

  get size() {
    return this.byKey.size;
  }
}

/**
 * Which pane, if any, should hold the audio claim.
 *
 * Inside one runtime this replaces the claim file entirely: panes that share memory do not need
 * to publish their state to a file and poll it. The rule is the one the file encoded — a single
 * owner, the first audible pane keeps it — and the tie-break is generation so the answer does not
 * depend on Map iteration order.
 *
 * The file does not disappear from the system, only from between these panes: a host still
 * publishes one claim on behalf of whichever pane wins here, because per-pane engines running
 * beside it share nothing else.
 */
function audioOwnerAmong(records, currentOwnerKey = null) {
  const audible = records.filter((record) => record.audio.audible);
  if (audible.length === 0) return null;
  const held = audible.find((record) => record.key === currentOwnerKey);
  if (held) return held.key;
  return audible.sort((left, right) => left.generation - right.generation)[0].key;
}

module.exports = {
  PaneRegistry,
  createPaneRecord,
  applyViewport,
  applyVisibility,
  applyFrameTier,
  applySurface,
  applyAudio,
  audioOwnerAmong,
  paneImageIds,
  paneFrameFileNames,
  collidingImageRange,
  PATCH_ID_COUNT,
  IMAGE_ID_STRIDE,
};
