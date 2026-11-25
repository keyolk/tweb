"use strict";

// Collects the engine's main-thread garbage once paints have handed it enough pixels.
//
// Every offscreen `paint` hands this thread a NativeImage holding the whole frame — 14MB at
// 2520x1400 — and that memory is native: V8 sees only the small wrapper object, so nothing it
// allocates looks like pressure and a scavenge comes when the JS heap fills, which on this thread
// is seconds of frames later. NativeImage has no release of its own, so collecting is the only
// way to drop a frame that has been sent or superseded.
//
// A minor GC is what is needed: the images die young (one paint later, at most one timer
// later), so a scavenge finds them. It is triggered by bytes rather than a timer, so a still page
// — which paints nothing — pays nothing.
//
// Measured on animated-counter.html at 2520x1400 in a bare PTY over shm (main-process RSS every
// 5s for 60s; browser-tree CPU over 40s; two runs each, alternating with main):
//
//     no collection     430MB - 2.97GB   CPU 15.8-16.9%
//     every 320MB       184MB - 512MB    CPU 15.7-15.9%
//     every 160MB       165MB - 205MB    CPU 20.6-21.2%
//     every 64MB        168MB - 254MB    CPU 20.0-21.3%
//
// The CPU step between 320MB and 160MB is real and repeated, though not proportional to the
// number of scavenges; 320MB is the smallest budget measured that costs nothing.
const PAINT_GC_BYTES = 320 * 1024 * 1024;

/**
 * @param {(() => void) | null} collect runs a minor GC; null when none could be had
 * @param {number} budget bytes of painted pixels between collections
 * @returns {(bytes: number) => boolean} records a paint; true when it ran a collection
 */
function createPaintCollector(collect, budget = PAINT_GC_BYTES) {
  let pending = 0;
  return (bytes) => {
    if (!collect || !(bytes > 0)) return false;
    pending += bytes;
    if (pending < budget) return false;
    pending = 0;
    try {
      collect();
    } catch {
      return false;
    }
    return true;
  };
}

// `--expose-gc` set at run time, then the `gc` it defines read from a fresh context: the main
// process is started by Electron, not by a command line this code controls. Without it
// (`TWEB_PAINT_GC=0`, or a V8 that refuses the flag) frames are freed by V8's own schedule, as
// before.
function minorCollector(env = process.env) {
  if (env.TWEB_PAINT_GC === "0") return null;
  try {
    require("node:v8").setFlagsFromString("--expose-gc");
    const gc = require("node:vm").runInNewContext("gc");
    if (typeof gc !== "function") return null;
    return () => gc({ type: "minor", execution: "sync" });
  } catch {
    return null;
  }
}

module.exports = { createPaintCollector, minorCollector, PAINT_GC_BYTES };
