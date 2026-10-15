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

// macOS rejects a shared-memory name longer than PSHMNAMLEN (31 bytes). `/twb.<pid>.<id>.<slot>`
// stays well under it for any pid and image id this engine produces.
function shmFrameName(pid, imageId, slot) {
  return `/twb.${pid}.${imageId}.${slot}`;
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
    const imageId = Number(match[2]);
    const objects = [];
    for (let slot = 0; slot < SHM_RING; slot += 1) objects.push(shmFrameName(pid, imageId, slot));
    abandoned.push({ marker: name, objects });
  }
  return abandoned;
}

module.exports = {
  shmFramesDecision, shmFrameName, shmMarkerName, abandonedShmFrames,
  SHM_RING, SHM_MARKER_PATTERN, CONSUMES_SHM,
};
