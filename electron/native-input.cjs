"use strict";

// The real pointer and the real scroll gesture, for panes the terminal can only describe in cells.
//
// tmux does not know SGR-pixel mouse mode (1016), so inside it a pane hears the pointer snapped to
// its cell grid: a drag arrives as a staircase and a hover sits on cell corners. A trackpad reaches
// it as wheel notches, with no precise deltas and no momentum. `tweb-native-input`
// (crates/tweb-native-input) reads both from macOS and prints them; this file decides whether what
// it saw belongs to one of this engine's panes, and how to place it there.
//
// Where a pane is on screen is not something tmux or the terminal can say in points — the window's
// title bar, the terminal's padding and tmux's status line all sit between the window's bounds and
// cell 0,0. It is MEASURED instead, from the pane's own cell reports: each one says the pointer was
// inside cell (C, R) at the moment the helper last saw it at (x, y), which pins the grid origin to
// one cell-wide interval. Intersecting those intervals narrows it to a point as the pointer crosses
// cell edges. The estimate is kept relative to the terminal window's bounds, so moving the window
// costs nothing; it is keyed by the cell size, so a font change starts over.
//
// tb (zenbu-labs/terminal-browser) solves the same problem by correlating native positions with
// the pane's own reports and, failing that, pairing a native scroll gesture with the next wheel
// tick. Pixel positions are what make its correlation work and tmux has none, so tb falls back to
// pairing there. tweb has what tb lacks — the pane's cell size and its offset in the tmux grid —
// so the cell reports themselves locate the pane exactly, and pairing is kept only for the wheel:
// a terminal wheel report that arrives while a precise native gesture is landing in the pane is the
// same gesture, and is dropped rather than scrolled twice.
//
// Every decision here falls back to the terminal: no helper, an unknown window, an uncalibrated
// grid, a pointer the native stream places elsewhere — each leaves the cell report as it was.

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const readline = require("node:readline");

// How long one `arm` keeps the helper reporting, and how often it is renewed. Renewed from the
// pane's own mouse reports, so an engine nobody is pointing at gets no lines at all.
const ARM_SECONDS = 10;
const ARM_RENEW_MS = 2000;
// Native samples kept, and how far back a report looks for the samples it was made from. The
// helper's path (window server -> pipe) is shorter than the terminal's (terminal -> tmux -> pane
// -> engine), so the sample behind a report has normally arrived already; 50ms covers the skew.
const SAMPLE_KEEP_MS = 500;
const REPORT_WINDOW_MS = 50;
// A sample older than this is not "where the pointer is now".
const FRESH_MS = 100;
// Interval endpoints that miss each other by less than this still agree (sub-point jitter between
// the two streams). Three disagreements in a row mean the grid really moved.
const AGREE_PT = 1;
const CONFLICTS_TO_RESET = 3;
// The wheel. A terminal report within DROP_MS of a precise native event in the same pane is that
// gesture; one with nothing native yet waits HOLD_MS for it; FLUSHES_TO_SILENCE waits that found
// nothing mean the helper is not hearing this wheel, and waiting stops for SILENCE_MS.
const DROP_MS = 300;
const HOLD_MS = 60;
const FLUSHES_TO_SILENCE = 3;
const SILENCE_MS = 30_000;
// AppKit's modifier bit for Control. A Ctrl-wheel is the zoom gesture, which the terminal report
// already carries; it is never scrolled natively.
const NS_CONTROL = 1 << 18;

/// Where the helper binary is: an explicit `TWEB_NATIVE_INPUT`, then a build in this checkout,
/// then beside an installed `tweb`, then PATH — the same search as the WebKit host.
function findNativeHelper(env = process.env, appDir = path.join(__dirname)) {
  const name = "tweb-native-input";
  const candidates = [
    env.TWEB_NATIVE_INPUT,
    path.join(appDir, "..", "target", "release", name),
    path.join(appDir, "..", "target", "debug", name),
    path.join(appDir, "..", "..", "..", "bin", name),
    ...String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name)),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* next */ }
  }
  return null;
}

/// One helper line, or null for anything this engine does not read.
function parseHelperLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch (_) {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const finite = (...keys) => keys.every((key) => Number.isFinite(value[key]));
  switch (value.ev) {
    case "ready":
      return { ev: "ready" };
    case "m":
      return finite("x", "y") ? { ev: "m", x: value.x, y: value.y, buttons: Number(value.b) || 0 } : null;
    case "s":
      if (!finite("x", "y", "dx", "dy")) return null;
      return {
        ev: "s",
        x: value.x,
        y: value.y,
        dx: value.dx,
        dy: value.dy,
        phase: Number(value.ph) || 0,
        momentum: Number(value.mo) || 0,
        precise: value.pr === true,
        modifiers: Number(value.mods) || 0,
      };
    case "w":
      if (value.id === null || value.id === undefined) return { ev: "w", window: null };
      if (!finite("x", "y", "w", "h", "scale")) return null;
      return {
        ev: "w",
        window: { id: value.id, pid: value.pid, x: value.x, y: value.y, width: value.w, height: value.h, scale: value.scale },
      };
    default:
      return null;
  }
}

/// A pane's cell grid in screen points, from what the engine already knows about it.
///
/// Inside tmux a report is a pane-relative cell and the pane starts `origin` cells into the client's
/// grid. Outside tmux the pane is the whole terminal and a report is a device pixel of it, which is
/// a grid too — of one-pixel cells — so the same estimate locates it.
function paneGeometry({ viewport, origin, inTmux }, scale) {
  if (!viewport || !(scale > 0)) return null;
  const { cols, rows, width, height } = viewport;
  if (!(cols > 0 && rows > 0 && width > 0 && height > 0)) return null;
  if (!inTmux) {
    return { inTmux: false, cellW: 1 / scale, cellH: 1 / scale, left: 0, top: 0, cols: width, rows: height };
  }
  if (!origin || !Number.isFinite(origin.left) || !Number.isFinite(origin.top)) return null;
  return {
    inTmux: true,
    cellW: width / cols / scale,
    cellH: height / rows / scale,
    left: origin.left,
    top: origin.top,
    cols,
    rows,
  };
}

/// Where cell 0 starts on one axis: somewhere in (lo, hi], narrowed by every report.
class AxisEstimate {
  constructor() {
    this.lo = -Infinity;
    this.hi = Infinity;
    this.conflicts = 0;
  }

  offer(lo, hi) {
    const nextLo = Math.max(this.lo, lo);
    const nextHi = Math.min(this.hi, hi);
    if (nextLo <= nextHi + AGREE_PT) {
      if (nextLo > nextHi) {
        const middle = (nextLo + nextHi) / 2;
        this.lo = middle;
        this.hi = middle;
      } else {
        this.lo = nextLo;
        this.hi = nextHi;
      }
      this.conflicts = 0;
      return true;
    }
    // A report the estimate cannot hold. Once is skew between the streams; three in a row is the
    // grid having moved (a window resized under a balanced padding, a status line toggled), and the
    // estimate starts again from the report.
    this.conflicts += 1;
    if (this.conflicts >= CONFLICTS_TO_RESET) {
      this.lo = lo;
      this.hi = hi;
      this.conflicts = 0;
    }
    return false;
  }

  width() { return this.hi - this.lo; }
  value() { return (this.lo + this.hi) / 2; }
}

/// The grid origin of one terminal window, relative to the window's top-left, in points.
class GridEstimate {
  constructor() {
    this.x = new AxisEstimate();
    this.y = new AxisEstimate();
    this.reports = 0;
  }

  /// One report: the pointer was in client-grid cell (col, row) while the helper saw it somewhere
  /// in `xs`/`ys` (window-relative min/max over the samples the report could have been made from).
  offer(col, row, xs, ys, cellW, cellH) {
    this.reports += 1;
    const okX = this.x.offer(xs.min - (col + 1) * cellW, xs.max - col * cellW);
    const okY = this.y.offer(ys.min - (row + 1) * cellH, ys.max - row * cellH);
    return okX && okY;
  }

  /// Good enough to place a pointer: known to within half a cell (and never asked to be finer than
  /// a point, which a one-pixel grid outside tmux would otherwise demand).
  usable(cellW, cellH) {
    return this.x.width() <= Math.max(1, cellW / 2) && this.y.width() <= Math.max(1, cellH / 2);
  }

  origin() { return { x: this.x.value(), y: this.y.value() }; }
}

/// A pane's share of the native state. Kept on the pane's input state, so N panes in one host each
/// have their own latch and wheel bookkeeping.
function createPaneNative() {
  return {
    // The terminal window this pane's reports were last seen through.
    windowId: null,
    // Whether the pointer has been reported in this pane since it last left the pane's rect.
    latched: false,
    // The button the terminal says is held, and the modifiers of the last report.
    held: null,
    modifiers: [],
    lastSent: null,
    // The previous report's client-grid cell and when it came, for the dwell bound in `report`.
    lastReport: null,
    wheel: {
      preciseAt: -Infinity,
      coarseAt: -Infinity,
      pending: [],
      timer: null,
      flushes: 0,
      silentUntil: -Infinity,
      delivered: 0,
      dropped: 0,
      flushed: 0,
    },
    reports: { native: 0, cell: 0 },
  };
}

class NativeInput extends EventEmitter {
  constructor({
    env = process.env,
    platform = process.platform,
    spawn = childProcess.spawn,
    findHelper = findNativeHelper,
    now = () => performance.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = () => {},
  } = {}) {
    super();
    this.env = env;
    this.platform = platform;
    this.spawnProcess = spawn;
    this.findHelper = findHelper;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;
    this.child = null;
    // "idle" until first armed, then "running"; "absent" with no binary, "dead" once it exited.
    this.status = platform === "darwin" ? "idle" : "unsupported";
    this.armedAt = -Infinity;
    this.window = null;
    this.samples = [];
    this.estimates = new Map();
  }

  /// Ask for the native stream, starting the helper the first time. Cheap enough to call on every
  /// mouse report: the line is written once per ARM_RENEW_MS.
  arm() {
    if (this.status === "unsupported" || this.status === "absent" || this.status === "dead") return false;
    if (!this.child && !this.start()) return false;
    const now = this.now();
    if (now - this.armedAt < ARM_RENEW_MS) return true;
    this.armedAt = now;
    try {
      this.child.stdin.write(`arm ${ARM_SECONDS}\n`);
    } catch (error) {
      this.log(`native input: arm failed: ${error.message}`);
    }
    return true;
  }

  start() {
    const binary = this.findHelper(this.env);
    if (!binary) {
      this.status = "absent";
      this.log("native input: tweb-native-input not found; pointer and wheel stay on the terminal's reports");
      return false;
    }
    let child;
    try {
      child = this.spawnProcess(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
    } catch (error) {
      this.status = "dead";
      this.log(`native input: could not start ${binary}: ${error.message}`);
      return false;
    }
    this.child = child;
    this.status = "running";
    child.stdin.on("error", () => {});
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.on("exit", (code, signal) => {
      this.child = null;
      this.status = "dead";
      this.window = null;
      this.samples = [];
      this.log(`native input: helper exited (${signal || code}); falling back to the terminal's reports`);
    });
    child.on("error", (error) => this.log(`native input: helper error: ${error.message}`));
    return true;
  }

  stop() {
    if (this.child) this.child.kill();
    this.child = null;
  }

  /// Whether native input can be acting at all right now.
  live() {
    return this.status === "running" && this.now() - this.armedAt < ARM_SECONDS * 1000;
  }

  onLine(line) {
    const event = parseHelperLine(line);
    if (!event) return;
    const now = this.now();
    if (event.ev === "w") {
      // A different window under the pointer: samples taken over the old one say nothing about
      // where this one's grid is.
      if (event.window?.id !== this.window?.id) this.samples = [];
      this.window = event.window;
      return;
    }
    if (event.ev === "m") {
      this.samples.push({ at: now, x: event.x, y: event.y, buttons: event.buttons });
      while (this.samples.length && now - this.samples[0].at > SAMPLE_KEEP_MS) this.samples.shift();
      this.emit("move", event);
      return;
    }
    if (event.ev === "s") {
      // A scroll carries the pointer too, and the pointer may not have moved since the last move.
      this.samples.push({ at: now, x: event.x, y: event.y, buttons: this.latestSample()?.buttons || 0 });
      this.emit("scroll", event);
    }
  }

  latestSample() {
    return this.samples.length ? this.samples[this.samples.length - 1] : null;
  }

  estimateFor(geometry, window = this.window) {
    if (!geometry || !window) return null;
    const key = `${window.id}|${geometry.inTmux ? "tmux" : "px"}|${geometry.cellW.toFixed(4)}|${geometry.cellH.toFixed(4)}`;
    let estimate = this.estimates.get(key);
    if (!estimate) {
      estimate = new GridEstimate();
      this.estimates.set(key, estimate);
    }
    return estimate;
  }

  /// A terminal mouse report for a pane, `col`/`row` zero-based in the pane (cells in tmux, device
  /// pixels outside it). Narrows the grid estimate and, when the native pointer agrees with the
  /// report, returns where in the pane it really is as fractions of the pane: `{ fx, fy }`.
  report(paneNative, geometry, col, row) {
    const now = this.now();
    if (!this.live() || !geometry || !this.window) {
      paneNative.reports.cell += 1;
      return null;
    }
    const window = this.window;
    const estimate = this.estimateFor(geometry, window);
    const gridCol = geometry.left + col;
    const gridRow = geometry.top + row;
    const offer = (samples, atCol, atRow) => {
      if (!samples.length) return;
      const xs = samples.map((sample) => sample.x - window.x);
      const ys = samples.map((sample) => sample.y - window.y);
      estimate.offer(
        atCol, atRow,
        { min: Math.min(...xs), max: Math.max(...xs) },
        { min: Math.min(...ys), max: Math.max(...ys) },
        geometry.cellW, geometry.cellH,
      );
    };
    // The cell this report names: the pointer entered it at one of the last few samples. That
    // bounds the grid from the side it entered by, tightly — the sample that crossed the edge is
    // right on it — and loosely from the other.
    offer(this.samples.filter((sample) => now - sample.at <= REPORT_WINDOW_MS), gridCol, gridRow);
    // The cell the LAST report named: the pointer stayed in it until it left for this one, so
    // every sample older than the skew was still inside it, the last of them just short of the
    // edge it left by. That is the other side's tight bound, which a pointer moving one way would
    // otherwise never produce.
    const previous = paneNative.lastReport;
    if (previous && previous.windowId === window.id && (previous.col !== gridCol || previous.row !== gridRow)) {
      offer(this.samples.filter((sample) => sample.at >= previous.at && now - sample.at > REPORT_WINDOW_MS),
        previous.col, previous.row);
    }
    paneNative.lastReport = { at: now, col: gridCol, row: gridRow, windowId: window.id };
    const latest = this.latestSample();
    if (!latest || now - latest.at > FRESH_MS || !estimate.usable(geometry.cellW, geometry.cellH)) {
      paneNative.reports.cell += 1;
      return null;
    }
    const origin = estimate.origin();
    const nativeCol = Math.floor((latest.x - window.x - origin.x) / geometry.cellW);
    const nativeRow = Math.floor((latest.y - window.y - origin.y) / geometry.cellH);
    // The native pointer has to be where the terminal says, give or take the cell it is crossing
    // into. Anywhere else, the report came from some other pointer path than the one being
    // watched — another client's window, a stale window probe — and the cell report stands.
    if (Math.abs(nativeCol - gridCol) > 1 || Math.abs(nativeRow - gridRow) > 1) {
      paneNative.reports.cell += 1;
      return null;
    }
    paneNative.windowId = window.id;
    paneNative.latched = true;
    paneNative.reports.native += 1;
    return this.fractions(geometry, origin, latest.x - window.x, latest.y - window.y);
  }

  fractions(geometry, origin, x, y) {
    const localX = x - origin.x - geometry.left * geometry.cellW;
    const localY = y - origin.y - geometry.top * geometry.cellH;
    const fx = localX / (geometry.cols * geometry.cellW);
    const fy = localY / (geometry.rows * geometry.cellH);
    return { fx, fy, inside: fx >= 0 && fx < 1 && fy >= 0 && fy < 1 };
  }

  /// Where a native point falls in a pane, or null when this pane is not known to be what the
  /// pointer is over: not reported through this window, not calibrated, or the helper idle.
  hit(paneNative, geometry, x, y) {
    if (!this.live() || !geometry || !this.window || paneNative.windowId !== this.window.id) return null;
    const estimate = this.estimateFor(geometry);
    if (!estimate.usable(geometry.cellW, geometry.cellH)) return null;
    return this.fractions(geometry, estimate.origin(), x - this.window.x, y - this.window.y);
  }

  /// A terminal wheel report for a pane: "drop" it (the native gesture already scrolled this),
  /// "hold" it briefly (a native gesture may be about to), or "pass" it on as before.
  wheelClaim(paneNative, geometry) {
    if (!this.live() || !this.window || paneNative.windowId !== this.window.id) return "pass";
    if (!this.estimateFor(geometry)?.usable(geometry.cellW, geometry.cellH)) return "pass";
    const now = this.now();
    if (now - paneNative.wheel.preciseAt <= DROP_MS) return "drop";
    // A mouse wheel turning: its native event usually lands first, and it says the terminal's
    // notches are the scroll — so they go now instead of waiting to be sure.
    if (now - paneNative.wheel.coarseAt <= DROP_MS) return "pass";
    if (now < paneNative.wheel.silentUntil) return "pass";
    return "hold";
  }

  /// Keeps a held report, to be run if no native gesture turns up for it.
  hold(paneNative, deliver) {
    const wheel = paneNative.wheel;
    wheel.pending.push(deliver);
    if (wheel.timer) return;
    wheel.timer = this.setTimer(() => {
      wheel.timer = null;
      const pending = wheel.pending.splice(0);
      wheel.flushed += pending.length;
      wheel.flushes += 1;
      if (wheel.flushes >= FLUSHES_TO_SILENCE) {
        wheel.flushes = 0;
        wheel.silentUntil = this.now() + SILENCE_MS;
        this.log("native input: terminal wheel reports with no native gesture; not waiting for one for 30s");
      }
      for (const run of pending) run();
    }, HOLD_MS);
    wheel.timer?.unref?.();
  }

  /// A native scroll event landed in this pane. Precise: the held reports were the same gesture.
  /// Not precise (a mouse wheel): the terminal's reports are the right ones, and go now.
  noteNativeScroll(paneNative, precise) {
    const wheel = paneNative.wheel;
    if (wheel.timer) {
      this.clearTimer(wheel.timer);
      wheel.timer = null;
    }
    const pending = wheel.pending.splice(0);
    if (precise) {
      wheel.preciseAt = this.now();
      wheel.flushes = 0;
      wheel.dropped += pending.length;
      return;
    }
    wheel.coarseAt = this.now();
    wheel.flushed += pending.length;
    for (const run of pending) run();
  }

  /// Whether a native scroll event is for this engine to deliver natively at all.
  static scrollsNatively(event) {
    return event.precise && (event.modifiers & NS_CONTROL) === 0;
  }

  diag(paneNative, geometry) {
    const estimate = geometry && this.window ? this.estimateFor(geometry) : null;
    return {
      helper: this.status,
      armed: this.live(),
      window: this.window ? { id: this.window.id, pid: this.window.pid, scale: this.window.scale } : null,
      paneWindow: paneNative.windowId,
      latched: paneNative.latched,
      grid: estimate ? {
        usable: estimate.usable(geometry.cellW, geometry.cellH),
        widthPt: [estimate.x.width(), estimate.y.width()].map((w) => (Number.isFinite(w) ? Math.round(w * 100) / 100 : null)),
        reports: estimate.reports,
      } : null,
      reports: { ...paneNative.reports },
      wheel: {
        delivered: paneNative.wheel.delivered,
        dropped: paneNative.wheel.dropped,
        flushed: paneNative.wheel.flushed,
        silent: this.now() < paneNative.wheel.silentUntil,
      },
    };
  }
}

/// AppKit's `NSEventPhase` masks, as the helper passes them on.
const NS_PHASE = { began: 1, stationary: 2, changed: 4, ended: 8, cancelled: 16, mayBegin: 32 };

module.exports = {
  NativeInput,
  GridEstimate,
  AxisEstimate,
  createPaneNative,
  findNativeHelper,
  paneGeometry,
  parseHelperLine,
  NS_PHASE,
  NS_CONTROL,
  constants: { ARM_SECONDS, ARM_RENEW_MS, REPORT_WINDOW_MS, FRESH_MS, DROP_MS, HOLD_MS, FLUSHES_TO_SILENCE, SILENCE_MS },
};
