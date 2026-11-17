"use strict";
// Whole frames through POSIX shared memory (`t=s`) instead of a frame file (`t=f`).
//
// WHY. DETAIL.md 8.5: at 2880x1800/30fps the frame-file write is the only thing dropping whole
// frames — p99 at 164% of the frame budget, and removing it took `droppedByBackpressure` from ~244
// to 0. `o=z` bought that back on kitty, but it kills Ghostty (deflate-policy.cjs), so on Ghostty
// every whole frame still went through the disk. `t=s` has no disk in it. Measured with the addon
// in an Electron 43 worker: a 2880x1800 frame swapped and written into a fresh object in 3.36ms,
// against the shipped JS swap (2.9ms) plus the write (p50 9.8ms, p99 54ms).
//
// The native half is `crates/tweb-frame-native`, shipped as `native/tweb-frame.node`. Node has no
// `shm_open` or `mmap`, which is what kept this medium out until now (DETAIL.md 8.4).
//
// WHO GETS IT. Only a terminal that is on this machine and is known to read and unlink the object:
//
//   - Ghostty: DETAIL.md 8.2 probed `a=T,f=32,t=s` on a real tty — answered OK, and the object
//     was gone afterwards, which only a terminal that consumed it can do. Also verified through
//     tmux passthrough.
//   - kitty: the protocol's reference implementation of `t=s`.
//
// An unknown terminal keeps the file medium. The failure on the other side is not a refused frame
// but a leak: a terminal that ignores `t=s` never unlinks, and the object stays in the kernel until
// reboot. The ring below bounds that, but a bounded leak of 4 x 20MB is still not a default to
// hand a terminal nobody has looked at.
//
// A remote terminal (SSH) cannot open this machine's shared memory at all — nor its files, which is
// the remote-transport work's to decide; here it only means "not shm".

const CONSUMES_SHM = [/ghostty/i, /kitty/i];

// Each pane cycles through this many object names. The terminal unlinks what it reads, so in the
// normal case nothing exists between frames; the ring only matters when frames are NOT consumed —
// a pane hidden between hand-off and draw, passthrough turned off — and then it is what stops
// one object per frame from accumulating. Before a name is reused it is unlinked, which drops a
// frame the terminal had not opened yet; 4 slots is ~130ms of frames at 30fps, far longer than a
// terminal takes to read one.
const SHM_RING = 4;

// Patches get their own, longer ring. They bypass the pacer and arrive as fast as the page paints —
// a drag on a whiteboard is one per paint — so a 4-deep ring could be reused while the terminal is
// still behind on reading through tmux. 16 is ~270ms at 60 patches a second, and an unconsumed patch
// is a few hundred KB, not a whole frame, so the bound stays small.
const SHM_PATCH_RING = 16;

// macOS rejects a shared-memory name longer than PSHMNAMLEN (31 bytes). `/twb.<pid>.<id>.<slot>`
// stays well under it for any pid and image id this engine produces.
function shmFrameName(pid, imageId, slot) {
  return `/twb.${pid}.${imageId}.${slot}`;
}

// Keyed on the pane's base image id like whole frames, not on the patch's own id: the patch ids
// cycle through a pool, and one per-pane name space is what the marker below can enumerate.
function shmPatchName(pid, imageId, slot) {
  return `/twb.${pid}.${imageId}.p${slot}`;
}

// Every object name a pane may have created, for the exit path and the dead-engine sweep.
function paneShmNames(pid, imageId) {
  const names = [];
  for (let slot = 0; slot < SHM_RING; slot += 1) names.push(shmFrameName(pid, imageId, slot));
  for (let slot = 0; slot < SHM_PATCH_RING; slot += 1) names.push(shmPatchName(pid, imageId, slot));
  return names;
}

/**
 * @param {object} env
 * @param {boolean} env.addonLoaded whether `native/tweb-frame.node` loaded
 * @param {string} [env.clientTermname] tmux `#{client_termname}`; inside tmux the only honest name
 * @param {string} [env.term] `$TERM` outside tmux
 * @param {string} [env.termProgram] `$TERM_PROGRAM` outside tmux
 * @param {boolean} [env.remote] the terminal is on another machine (SSH)
 * @param {string} [env.override] `$TWEB_SHM_FRAMES`: "0" forces off, "1" forces on
 * @returns {{ allowed: boolean, reason: string }}
 */
function shmFramesDecision({ addonLoaded, clientTermname, term, termProgram, remote, override } = {}) {
  if (!addonLoaded) return { allowed: false, reason: "no native addon" };
  if (override === "0") return { allowed: false, reason: "TWEB_SHM_FRAMES=0" };
  if (override === "1") return { allowed: true, reason: "TWEB_SHM_FRAMES=1" };
  if (remote) return { allowed: false, reason: "terminal is remote" };
  const names = [clientTermname, term, termProgram].filter(Boolean).join(" ");
  const known = CONSUMES_SHM.find((pattern) => pattern.test(names));
  if (!known) return { allowed: false, reason: `terminal not known to consume t=s: ${names || "unknown"}` };
  return { allowed: true, reason: `terminal consumes t=s: ${names}` };
}

// A pane that has sent shm frames leaves a zero-byte marker in userData named like a frame file.
// Shared-memory objects cannot be listed, so a SIGKILLed engine's unconsumed objects would be
// unfindable; the marker is what makes them collectable, by the same dead-pid rule frame files use
// (orphan-watch.cjs).
const SHM_MARKER_PATTERN = /^tweb-shm-(\d+)-(\d+)$/;

function shmMarkerName(pid, imageId) {
  return `tweb-shm-${pid}-${imageId}`;
}

/**
 * The objects and markers a dead engine left behind.
 *
 * @param {string[]} names userData entries
 * @param {number} selfPid never swept
 * @param {(pid: number) => boolean} isAlive
 * @returns {{ marker: string, objects: string[] }[]}
 */
function abandonedShmFrames(names, selfPid, isAlive) {
  const abandoned = [];
  for (const name of names || []) {
    const match = SHM_MARKER_PATTERN.exec(String(name));
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid === Number(selfPid) || isAlive(pid)) continue;
    abandoned.push({ marker: name, objects: paneShmNames(pid, Number(match[2])) });
  }
  return abandoned;
}

// Which medium one pane's frames take right now, given that shm is allowed for this engine at all.
//
// Shared memory has one reader: the terminal that reads an object unlinks it. Under the overlay a
// second tmux client only missed a patch and kept the base underneath; under placeholders there is
// nothing underneath, so a second client showed blank boxes (measured: a quarter of captures, both
// clients). That is why placeholder panes used to take the file medium unconditionally.
//
// But the hazard needs a second client, and tmux forwards passthrough only to the clients that are
// showing the pane — the same set the visibility push reports. With exactly one of them, one reader
// is all there is, and the file medium only costs: on a Retina placeholder pane every whole frame
// was a 6.9MB raw file write and read, and a playing YouTube video dropped a quarter of its frames
// (observed 2026-11-18, 77 of 314 over 10s, with 15 frames dropped to backpressure). So a
// placeholder pane takes shm while one client shows it, and goes back to the file the moment a
// second appears. Zero clients (hidden, or not known yet) keeps the file: nothing is drawn then, and
// "unknown" must not be the case that gambles.
function paneShmMedium({ shmEnabled, placeholders, clientCount } = {}) {
  if (!shmEnabled) return { shm: false, reason: "shm is off for this engine" };
  if (!placeholders) return { shm: true, reason: "overlay pane" };
  const count = Number(clientCount);
  if (count === 1) return { shm: true, reason: "placeholder pane with one client" };
  if (Number.isFinite(count) && count > 1) {
    return { shm: false, reason: `placeholder pane with ${count} clients (shm has one reader)` };
  }
  return { shm: false, reason: "placeholder pane with no client showing it" };
}

module.exports = {
  shmFramesDecision, paneShmMedium, shmFrameName, shmPatchName, paneShmNames, shmMarkerName, abandonedShmFrames,
  SHM_RING, SHM_PATCH_RING, SHM_MARKER_PATTERN, CONSUMES_SHM,
};
