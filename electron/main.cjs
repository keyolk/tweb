// tweb-electron/main.cjs — Electron offscreen browser → Kitty graphics.
//
// Follows the cliweb approach exactly:
// - tmux passthrough: double-escaped ESC + pane origin anchor
// - a=T transfer&display, C=1, f=100 PNG, local file transport
// - frame files avoid flooding the terminal with bytes; direct transfer is the fallback
// - alternate screen and raw mode are handled by tweb-pane (Rust)

const { app, BrowserWindow, clipboard, ipcMain, nativeImage, screen, session } = require("electron");
const {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} = require("node:fs");
const { execFile, execFileSync } = require("node:child_process");
const { Worker } = require("node:worker_threads");
const net = require("node:net");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { MouseClickState } = require("./mouse-click-state.cjs");
const { PasteState, PASTE_START } = require("./paste-state.cjs");
const { startAgentServer, runtimeDir } = require("./agent-server.cjs");
const { buildBrowserContextMenu } = require("./context-menu.cjs");
const { visibleTmuxClientTtys, parseVisibilityPush } = require("./tmux-visibility.cjs");
const { normalizeUrl } = require("./url-normalization.cjs");
const { patchGeometry, patchCursorMove, unionDamage } = require("./patch-geometry.cjs");
const {
  frameRateTiers,
  playbackWindowMs,
  settledFrameRate,
} = require("./frame-rate-policy.cjs");
const { isOrphaned, watchedPid, abandonedFrameFiles } = require("./orphan-watch.cjs");
const {
  surfacePlan, surfaceResizeNeeded, paintingTransition, agentNeedsGeometry, restoredLayoutScript,
} = require("./surface-policy.cjs");
const { pressEvents } = require("./agent-key.cjs");
const { recoveryDecision } = require("./renderer-recovery.cjs");
const { withHistoryLock } = require("./history-lock.cjs");
const {
  parseClaim,
  claimExpired,
  audioDecision,
  shouldReleaseClaim,
  heartbeatOwns,
  HEARTBEAT_MS: AUDIO_HEARTBEAT_MS,
} = require("./audio-owner.cjs");
const {
  isRestorableUrl,
  normalizeWindowSession,
  windowSessionForSave,
  windowSessionKeys,
} = require("./window-session.cjs");
const {
  parseHistoryLines,
  historyDays,
  removeEntries,
  appendedSince,
  compactLines,
} = require("./history-view.cjs");
const { createPaneWriter, fdSink, channelSink } = require("./frame-writer.cjs");
const { serverIdentityFrom, paneKey } = require("./pane-identity.cjs");
const {
  PaneRegistry, createPaneRecord, applyVisibility: recordVisibility,
  applyFrameTier: recordFrameTier, applySurface: recordSurface, applyAudio: recordAudio,
  audioOwnerAmong, paneImageIds, paneFrameFileNames, collidingImageRange, PATCH_ID_COUNT,
} = require("./pane-registry.cjs");
const {
  parseControlLine, resolveTarget, formatOutbound, keyboardRestoreEvent,
} = require("./pane-control.cjs");
const { isHostedRuntime, hostProtocolVersion } = require("./hosted-runtime.cjs");
const {
  createFrameContext, nextPatchId: takeNextPatchId, notePatch, takeLivePatchIds,
  applyFrameViewport, queueGfxFrame: enqueueGfxFrame, completeGfxFrame,
} = require("./frame-context.cjs");
const {
  createPaneWindows, surfaceHeld, holdSurface, releaseSurface,
  applyFrameRate: applyPaneFrameRate, isThrottled,
} = require("./pane-windows.cjs");

if (process.env.TWEB_USER_DATA_DIR) {
  app.setPath("userData", process.env.TWEB_USER_DATA_DIR);
}
if (process.env.TWEB_DOWNLOAD_DIR) {
  mkdirSync(process.env.TWEB_DOWNLOAD_DIR, { recursive: true });
  app.setPath("downloads", process.env.TWEB_DOWNLOAD_DIR);
}
if (process.platform === "darwin") {
  app.setActivationPolicy("prohibited");
}
// Whether a supervisor started this process to host panes. Read once: it cannot change over a
// process's life, and re-reading it invites two call sites to disagree about which runtime they
// are in — which is exactly how a hosted pane ends up drawing into a control pipe.
const hostedRuntime = isHostedRuntime(process.env);

// The tmux pane this PROCESS was started in, or null when it has none it may act on.
//
// A per-pane engine's own pane is the pane it serves, so everything tmux-related — the origin
// query, the visibility poll, the passthrough key tables, the pane title — is addressed to it.
// A hosted engine's `TMUX_PANE` is the DAEMON's. Acting on it would query the daemon pane's
// origin, poll the daemon pane's visibility and rewrite the daemon pane's title, all on behalf of
// panes that are somewhere else entirely — measured in the same class of defect as the agent
// socket claimed as `agent-%304.sock`. So a host has no pane of its own, and every one of those
// call sites falls through to its "not in tmux" branch, which already exists and is already
// correct. A hosted pane's geometry and visibility arrive over its own connection instead.
const ownTmuxPane = hostedRuntime ? null : (process.env.TMUX_PANE || null);
let quitting = false;
// Independent toggles: bypass (P) and vimium turn on and off separately.
//   Ctrl-;  → bypass toggle (whether Cmd-K/A/... go to the page)
//   Ctrl-:  → vimium toggle (f/j/k/... normal-mode keys)
// Their combination makes the mode indicator:
//   vimium on  + bypass off = N (normal)
//   vimium off + bypass on  = P (passthrough)
//   vimium on  + bypass on  = N-vim (both)
//   vimium off + bypass off = D (web only)
let vimiumShortcutsEnabled = true;
let cmdBypassEnabled = false;
// Pane visibility lives in the registry record, not in a variable beside it. It is the gate on
// frame send, frame rate, and the surface plan — and on a terminal with tmux
// `allow-passthrough=all`, which forwards a hidden pane's passthrough to whatever window the
// client is actually viewing, it is the only thing between a hidden pane and drawing over the
// user's visible one. A second copy of it is therefore the one piece of state that must not exist.
let visibilityCheckRunning = false;
let visibleClientTtys = new Set();
const passthroughClientTables = new Map();
let tmuxIdentity = null;
// Where this pane lives *right now*. `tmuxIdentity` is the startup identity and
// stays pinned because the window-session save path is derived from it, but a
// pane moves: `break-pane` gives it a new window id and `join-pane` can change
// its session too. Matching clients against the startup window then fails for
// every client, the pane looks hidden, and painting stops — the pane freezes
// after being moved. Visibility therefore tracks the live placement instead.
let tmuxPlacement = null;
let originalPaneTitle = null;
const tabFrames = new Map();
const tabZoomFactors = new Map();
const tabSessionUrls = new Map();
// Recovery attempts per tab, so a page that crashes its renderer on every load stops being
// reloaded instead of looping forever. See renderer-recovery.cjs.
const tabRendererRecoveries = new Map();
const navigationHistory = [];
let navigationSerial = 0;
const restoreWindowSession = process.env.TWEB_RESTORE_SESSION === "1";
let windowSessionPath = null;
let legacyWindowSessionPath = null;
let windowSessionSaveTimer = null;
let hiddenWindowWatchdog = null;
let orphanWatchdog = null;
let agentServer = null;
// Mirrors the preload's insert mode so key dispatch knows to go native.
let pageInsertMode = false;
// Set while a close came from the tab list, so the list can be redrawn once the
// tab has actually left `soleWindows.tabs`.
let refreshTabListAfterClose = false;
// Electron logs an ipcNative error when frame.send races preload setup or navigation.
// A frame opts in only after its preload has installed all IPC listeners.
const readyFrameKeysByTab = new WeakMap();
// Context-menu URLs come from Chromium's hit test, not renderer input. Keep them
// here so a compromised page can only choose among the actions we displayed.
const contextMenuStateByTab = new WeakMap();
function commandLineValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function commandLineUrl() {
  const optionsWithValues = new Set(["--tweb-frame-rate", "--tweb-adaptive-frame-rate"]);
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === ".") continue;
    if (optionsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("--")) return argument;
  }
  return undefined;
}

const configuredFrameRate = Number.parseInt(
  commandLineValue("--tweb-frame-rate") || process.env.TWEB_FRAME_RATE || "",
  10
);
const maxActiveFrameRate = Number.isFinite(configuredFrameRate)
  ? Math.min(60, Math.max(1, configuredFrameRate))
  : 30;
const configuredAdaptiveFrameRate = commandLineValue("--tweb-adaptive-frame-rate");
const adaptiveFrameRate = configuredAdaptiveFrameRate !== undefined
  ? configuredAdaptiveFrameRate !== "0"
  : process.env.TWEB_ADAPTIVE_FRAME_RATE !== "0";
const idleFrameRate = adaptiveFrameRate ? Math.min(maxActiveFrameRate, 4) : maxActiveFrameRate;
// See frame-rate-policy.cjs for why playback is its own tier and how it is detected.
const frameRates = frameRateTiers(maxActiveFrameRate, adaptiveFrameRate);
const playbackFrameRate = frameRates.playback;
const playbackWindow = playbackWindowMs(idleFrameRate);
// The window/tab and frame-rate state for this pane. Like the frame context, the shipping path
// has exactly one and runs through it — the ceiling is per-pane because a host serves panes
// launched with different `--tweb-frame-rate` settings, and because the adaptive tiers are decided
// by counting THAT pane's paints.
const soleWindows = createPaneWindows({
  maxFrameRate: maxActiveFrameRate,
  adaptive: adaptiveFrameRate,
});
const configuredDefaultZoom = Number.parseFloat(process.env.TWEB_DEFAULT_ZOOM || "");
const defaultZoomFactor = Number.isFinite(configuredDefaultZoom)
  ? Math.min(2, Math.max(0.5, configuredDefaultZoom))
  : 0.8;
const configuredDeviceScaleFactor = Number.parseFloat(process.env.TWEB_DEVICE_SCALE_FACTOR || "");
// A Kitty placement with z >= 0 covers the terminal's own text — including the
// cell the terminal paints IME preedit into, and the cursor we park on the web
// caret for it. So a composing Korean syllable was drawn behind the page and never
// seen. Below the text the page still shows through: the cells tmux fills a pane
// with carry the default background, which the terminal leaves see-through.
// Measured in Ghostty; `TWEB_IMAGE_Z=0` restores the old layering if some terminal
// paints those cells opaque.
const configuredImageZ = Number.parseInt(process.env.TWEB_IMAGE_Z || "", 10);
const imageZ = Number.isSafeInteger(configuredImageZ) ? configuredImageZ : -1;
// stderr belongs to the pane, so the `resize generation=` / `frame generation=`
// lines an agent needs were only reachable by running a separate harness with the
// output redirected. Keep the last of them addressable over the socket instead.
const engineLog = [];
// The diagnostic lines used to be gated on TWEB_DEBUG, which meant `engine-log`
// was empty exactly when someone was debugging a pane they had not launched with
// it. Now that engine stderr goes to a file rather than over the page, they can
// always be recorded; TWEB_DEBUG only decides whether stderr is inherited.
const debugLogging = true;
const writeError = console.error.bind(console);
console.error = (...args) => {
  const line = args.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
  engineLog.push({ at: Date.now(), line });
  if (engineLog.length > 400) engineLog.shift();
  writeError(...args);
};

const configuredImageId = Number.parseInt(process.env.TWEB_IMAGE_ID || "", 10);
const configuredPaneImageId = Number.isSafeInteger(configuredImageId) && configuredImageId > 0
  ? configuredImageId
  : 1;

// --- per-pane runtime registry ---
//
// One Electron per pane meant every piece of pane state was a module-level variable and "which
// pane is this for" never had to be asked. The registry names that state and keys it by pane
// identity, so one runtime can hold several.
//
// The default path registers exactly one pane and runs through the registry and the writer like
// any other, rather than keeping a second code path beside them. That is deliberate: a seam only
// used by a flag is a seam nothing proves, and this one carries every frame the shipping build
// draws.
const paneRegistry = new PaneRegistry();
// The tmux server this process sits on. It is the SERVER, not a pane — an engine and the daemon
// that started it are on the same server, so this is one of the few things a hosted engine can
// still read from its own environment. Which pane, and whether that pane is in tmux at all, comes
// from each ATTACH; see `paneIsInTmux`.
const tmuxServerIdentity = serverIdentityFrom(process.env.TMUX);
// The generation is assigned by the supervisor once one exists. Until then a pane is generation
// 0 — a real value, not a placeholder, because this process *is* the only registration of this
// pane and nothing can supersede it from outside.
const SOLE_PANE_GENERATION = 0;
// A hosted engine has no pane of its own, and the identity it *would* derive one from is the
// supervisor's — measured as an agent socket claimed inside an unrelated pane's namespace. So
// this identity is only ever the per-pane runtime's. A host registers each pane from its ATTACH.
const solePaneId = ownTmuxPane || `pid-${process.pid}`;
const solePane = createPaneRecord({
  tmuxServer: tmuxServerIdentity,
  paneId: solePaneId,
  generation: SOLE_PANE_GENERATION,
  imageId: configuredPaneImageId,
});
// A host registers nothing of its own: its panes arrive by ATTACH, each with the identity and
// image id its frontend allocated. Registering this process's derived identity first would make
// the first real attach look like a supersession of a pane that never existed — and would put a
// record in the registry that nothing is drawing for.
if (!hostedRuntime) paneRegistry.attach(solePane);

// There is deliberately no module-level image id. One process serving N panes has one pid and N
// image ids, so a constant here would put every pane's frame under the same id — and the Kitty id
// namespace is terminal-wide, so that is a collision not only between our own panes but with every
// per-pane engine drawing beside us. Every id comes from a frame context's `imageIds`, which comes
// from that pane's record. See `paneImageIds`.

// The frame pipeline's state for this pane. The shipping path has exactly one, and runs through
// it like any other — a seam only a flag exercises is a seam nothing proves, and this one carries
// every frame the default build draws.
const frameContexts = new Map();
const soleFrames = createFrameContext(solePane);
frameContexts.set(solePane.key, soleFrames);

/**
 * The frame context a worker completion belongs to.
 *
 * Keyed rather than assumed. A completion applied to the wrong pane frees that pane's base image
 * and dispatches its queue against another pane's generation, which shows up as one pane's frame
 * appearing in another pane's rectangle rather than as an error.
 */
function frameContextFor(paneKey) {
  if (!paneKey) return null;
  return frameContexts.get(paneKey) || null;
}

// Every byte bound for this pane's terminal goes through one writer: graphics, the caret
// sequences that park on the web caret, and the image delete on exit. Two writers to one pane tore
// roughly one frame in 750 under realistic contention — realistic meaning a caret sequence after
// every frame, which is exactly what this file does — and moving into one process does not repair
// that, it only changes which two writers are racing.
//
// The sink is synchronous because `process.on("exit")` writes the delete that removes this pane's
// image, and an exit handler cannot await. Stdout is inherited from the frontend that owns the
// pty; a host that opens a pane tty by name instead must pass O_NOCTTY, or the first pane's
// hangup takes down the runtime serving all the others.
// The ONE place anything is written to the supervisor's control channel.
//
// A hosted engine's stdout is a protocol stream, not a terminal, and it is shared by every pane
// the engine serves. So it is funnelled through a single synchronous write: two writers on it
// would interleave two panes' lines, and an interleaved line is not a corrupt frame for one pane,
// it is an unparseable line for both.
//
// Synchronous for the same reason `fdSink` is: the exit path writes each pane's image delete and
// an exit handler cannot await.
function writeProtocolLine(line) {
  if (!hostedRuntime) return;
  try {
    writeSync(1, line);
  } catch (error) {
    // stdout closing means the supervisor is gone. The orphan watchdog is what reaps this
    // process; complaining once per frame here would fill the log while it does.
    if (debugLogging && !protocolChannelBroken) {
      protocolChannelBroken = true;
      console.error(`tweb: control channel write failed: ${error.message}`);
    }
  }
}
let protocolChannelBroken = false;

const paneWriters = new Map();
// A hosted pane's automation endpoint, one per pane rather than one per process.
const paneAgentServers = new Map();
// Whether Electron is far enough along to make a window. An ATTACH that arrived before
// `app.whenReady()` would fail inside BrowserWindow rather than anywhere legible.
let hostReady = false;

/**
 * The descriptor a pane's bytes go to, or null when it has no terminal yet.
 *
 * Falling back to stdout is right for a per-pane engine, whose stdout IS its pane's terminal.
 * It is never right for a hosted one, whose stdout is the supervisor's control pipe: bytes
 * written there are not a frame but a corrupted protocol stream, and the pane they were meant
 * for stays blank. So a hosted pane with no tty of its own writes nowhere rather than somewhere
 * wrong — measured, this is what stops even the exit-path image delete from reaching the pipe.
 */
function paneOutputFd(record) {
  if (record.tty !== null && record.tty !== undefined) return record.tty;
  return hostedRuntime ? null : 1;
}

// One addressed line on the supervisor's stdout, carrying a pane's bytes to the frontend that
// owns its pty.
//
// The frontend does the writing, and that is the load-bearing part rather than an implementation
// detail: an engine that opened the pane's tty itself would be a second writer PROCESS on it,
// racing the frontend's own caret, alternate-screen and keyboard writes — and `createPaneWriter`
// serialises within one process only, so there would be nothing to serialise them.
//
// Hex rather than raw bytes because this channel is line-delimited and a frame is arbitrary
// binary. It costs a doubling of a payload that is measured at ~110 bytes a frame on the file
// transport, where the pixels travel as a pathname.
function hostedFrameSink(record) {
  return channelSink((bytes) => {
    writeProtocolLine(formatOutbound("FRAME", record.paneId, bytes.toString("hex")));
  });
}

function writerFor(record) {
  let writer = paneWriters.get(record.key);
  if (!writer) {
    const fd = paneOutputFd(record);
    // A hosted pane with no tty of its own goes out over the control channel. A hosted pane with
    // nowhere at all to write — neither tty nor host channel — writes nowhere rather than to fd 1,
    // which under hosting is the control pipe: bytes there are a corrupted protocol stream, not a
    // frame, and the pane they were meant for stays blank.
    let sink;
    if (fd !== null) sink = fdSink(fd);
    else if (hostedRuntime) sink = hostedFrameSink(record);
    else sink = () => {};
    writer = createPaneWriter({
      sink,
      onError: (error) => {
        if (debugLogging) console.error(`tweb: pane write failed ${record.paneId}: ${error.message}`);
      },
    });
    paneWriters.set(record.key, writer);
  }
  return writer;
}

// The shipping path has exactly one pane, so this is the writer everything in this file uses.
// A host resolves the record first and calls `writerFor` with it.
// The pane every un-parameterised write goes to.
//
// A per-pane engine has exactly one and it is `currentPane()`. A host has exactly one *attached*, and
// it is that pane's writer these bytes belong on — writing them to `currentPane()` instead would
// address them `@pid-<pid>`, a pane name the supervisor has never heard of, and the frontend
// would drop every one. Measured: the harness saw `@pid-53793 FRAME ...` instead of `@%3 FRAME`.
//
// A second attached pane is refused (see `handleAttach`), which is what keeps this answer
// unambiguous. It is the piece that has to become a parameter before a host serves two.
function currentPane() {
  return hostedRuntime ? (paneRegistry.list()[0] || solePane) : solePane;
}

// The frame context those bytes belong to, by the same rule and for the same reason. The two are
// resolved together so a write and the generation it was rendered for can never disagree about
// which pane they are for.
function currentFrames() {
  return frameContexts.get(currentPane().key) || soleFrames;
}

function paneWrite(text) {
  writerFor(currentPane()).write(text);
}

const frameTransport = process.env.TWEB_FRAME_TRANSPORT === "direct" ? "direct" : "file";

// Where a pane's whole frames are staged for the terminal to read.
//
// Keyed on the pane's image id, not only on the pid. The pid alone is one path for every pane a
// host serves, so N panes would overwrite each other's pixels in one file while each told the
// terminal to read it — the same defect class as a shared image id, arrived at through the
// filesystem. The image id is unique per pane by construction, and the pid stays in the name
// because that is what `abandonedFrameFiles` collects a dead engine's leftovers by.
//
// Raw frames go to their own path so a stale PNG can never be read as pixels, or the other
// way round — the terminal is told the format out of band, not by extension. Unlike a PNG,
// a raw file carries no dimensions of its own: the `s=`/`v=` in the escape sequence supply
// them. A resize can therefore shear one frame, if the terminal reads the file after the
// next frame has already overwritten it at a new size. The window is a single frame and the
// one after it corrects the pane, so this is left alone.
function frameFilePathFor(frames, format) {
  const extension = format === "raw" ? "rgba" : "png";
  return path.join(app.getPath("userData"),
    `tweb-frame-${process.pid}-${frames.imageIds.base}.${extension}`);
}

// Whole frames can travel as raw pixels rather than PNG. The encode is what the main thread
// was paying for — 28ms on an ordinary page, 101ms on a photo, against ~2ms to hand the
// bitmap to the worker — and `f=32` costs the terminal nothing to decode.
//
// It needs the file medium: 20MB does not go through an escape sequence, and the direct
// transport is the fallback for when a frame file cannot be written. So raw is off whenever
// frames are not going through files, and it switches itself off if writing raw keeps
// failing — see `noteRawFrameFailure`.
let rawFramesEnabled = frameTransport === "file"
  && process.env.TWEB_RAW_FRAMES !== "0";
let loggedFrameGeneration = -1;
const gfxWorker = new Worker(path.join(__dirname, "gfx-worker.cjs"));
gfxWorker.unref();

const ESC = "\x1b";
const CSI = (s) => `${ESC}[${s}`;

// --- tmux passthrough (the cliweb escapeCodes.ts approach) ---


// Where this pane sits on screen, resolved from the engine's OWN tmux pane.
//
// Right for a per-pane engine and wrong for every pane a host serves: a hosted engine's
// `TMUX_PANE` is the DAEMON's, so this would anchor every pane at the daemon pane's origin —
// each one drawing over whatever is actually there. A hosted pane's origin arrives in its ATTACH
// and in the RESIZE lines after it, which is the only place that knows it.
function getTmuxPaneOrigin() {
  if (!ownTmuxPane) return;
  const configured = String(process.env.TWEB_PANE_ORIGIN || "").split(/[ ,]+/).map(Number);
  if (configured.length === 2 && configured.every(Number.isFinite)) {
    currentFrames().origin = { left: configured[0], top: configured[1] };
    return;
  }
  try {
    const out = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", ownTmuxPane, "#{pane_left}\t#{pane_top}"],
      { encoding: "utf8", timeout: 1000 }
    ).trim();
    const parts = out.split("\t").map(Number);
    if (parts.length >= 2) {
      currentFrames().origin = { left: parts[0], top: parts[1] };
    }
  } catch (e) {}
}

// cliweb wrapTmuxPassthrough: escape each ESC by doubling it.
function wrapTmuxPassthrough(sequence) {
  const escaped = sequence.split(ESC).join(ESC + ESC);
  return `${ESC}Ptmux;${escaped}${ESC}\\`;
}

// cliweb anchorTmuxGraphics: move the cursor to the pane origin, emit the graphics, restore it.
function anchorTmuxGraphics(sequence) {
  if (!currentFrames().origin) return wrapTmuxPassthrough(sequence);
  const row = currentFrames().origin.top + 1;
  const col = currentFrames().origin.left + 1;
  return wrapTmuxPassthrough(`${ESC}7${ESC}[${row};${col}H${sequence}${ESC}8`);
}

// Whether a pane's bytes have to travel through tmux's passthrough wrapper.
//
// Asked of the PANE, not of the process. A per-pane engine's `$TMUX` describes the only pane it
// serves, so reading the environment was right — but a hosted engine's describes the daemon, and
// one answer for N panes is wrong in both directions: a bare-terminal pane's frames would be
// wrapped in a passthrough its terminal prints literally, and a tmux pane's would go out unwrapped
// and unanchored, landing wherever the cursor happens to be. The record's `tmuxServer` comes from
// the pane's own ATTACH.
function paneIsInTmux(record = currentPane()) {
  return record.tmuxServer !== null && record.tmuxServer !== undefined;
}

function graphicsPassthrough(sequence, record = currentPane()) {
  if (!paneIsInTmux(record)) return sequence;
  return anchorTmuxGraphics(sequence);
}

function rawKittyDelete(record = currentPane()) {
  // The base image plus every damage patch slot. A client that stopped showing this pane
  // keeps whatever was placed on it, so leaving the patches would strand them there.
  const ids = paneImageIds(record);
  let raw = `${ESC}_Ga=d,d=I,i=${ids.base},q=2${ESC}\\`;
  for (const id of ids.patchIds) {
    raw += `${ESC}_Ga=d,d=I,i=${id},q=2${ESC}\\`;
  }
  return raw;
}

function deleteImageFromClientTty(tty) {
  let fd;
  try {
    fd = openSync(tty, "w");
    writeSync(fd, rawKittyDelete());
  } catch (error) {
    if (debugLogging) console.error(`tweb: client tty delete failed ${tty}: ${error.message}`);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (e) {}
    }
  }
}

const passthroughTable = "tweb-pass";
const passthroughMouseKeys = [
  "MouseDown1Pane", "MouseDown2Pane", "MouseDown3Pane",
  "MouseUp1Pane", "MouseUp2Pane", "MouseUp3Pane",
  "MouseDrag1Pane", "MouseDrag2Pane", "MouseDrag3Pane",
  "MouseDragEnd1Pane", "MouseDragEnd2Pane", "MouseDragEnd3Pane",
  "WheelUpPane", "WheelDownPane",
];

function tmuxRootBinding(key) {
  try {
    return execFileSync(
      "tmux",
      ["list-keys", "-T", "root", key],
      { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch (error) {
    return "";
  }
}

function ensureTmuxRootBinding(key, args, isManaged, replaceManaged = false) {
  const current = tmuxRootBinding(key);
  if (current && (!replaceManaged || !isManaged(current))) {
    if (!isManaged(current) && debugLogging) {
      console.error(`tweb: preserving custom root ${key} binding`);
    }
    return;
  }
  try {
    execFileSync("tmux", ["bind-key", "-T", "root", key, ...args], { timeout: 1000, stdio: "ignore" });
  } catch (error) {}
}

function configureTmuxRootBindings() {
  const privateKey = (key, digits, replaceManaged = false) => {
    const hex = digits.split("").map((digit) => digit.charCodeAt(0).toString(16));
    ensureTmuxRootBinding(
      key,
      ["send-keys", "-H", "1b", "5b", ...hex, "7e"],
      (binding) => binding.includes(`send-keys -H 1b 5b ${hex.join(" ")} 7e`),
      replaceManaged,
    );
  };

  // User110 is Ghostty's private sequence for Ctrl-;. TWeb's earlier binding also switched the
  // client table, but the engine is now the only side that switches tables and restores them.
  const toggle = tmuxRootBinding("User110");
  const legacyToggle = toggle.includes("@tweb_browser") && toggle.includes("35 30 30 31");
  if (legacyToggle) {
    try {
      execFileSync("tmux", ["unbind-key", "-T", "root", "User110"], { timeout: 1000, stdio: "ignore" });
    } catch (error) {}
  }
  privateKey("User110", "5001");
  privateKey("User111", "5009");
  privateKey("User113", "5002");
  privateKey("User114", "5003");
  privateKey("User115", "5004");
  privateKey("User116", "5007");
  // Ctrl-; → 5001 (bypass toggle). Ctrl-/ → 5014 (vimium toggle).
  privateKey("C-\\;", "5001");
  privateKey("C-/", "5014");
  ensureTmuxRootBinding(
    "User112",
    ["detach-client"],
    (binding) => binding.includes("detach-client"),
  );
}

function ensureTmuxPassthroughTable() {
  if (!ownTmuxPane) return;
  configureTmuxRootBindings();
  const zoomUserKeys = [
    [113, "User113", 5002],
    [114, "User114", 5003],
    [115, "User115", 5004],
    [116, "User116", 5007],
  ];
  const commands = [
    ...zoomUserKeys.map(([index, _key, code]) => ["set-option", "-s", `user-keys[${index}]`, `\x1b[${code}~`]),
    ["set-option", "-s", "user-keys[110]", "\x1b[5001~"],
    ["set-option", "-s", "user-keys[111]", "\x1b[5009~"],
    ["set-option", "-s", "user-keys[112]", "\x1b[5010~"],
    ["set-option", "-s", "user-keys[117]", "\x1b[5014~"],
    [
      "bind-key", "-T", passthroughTable, "User110",
      "send-keys", "-H", "1b", "5b", "35", "30", "30", "31", "7e",
      "\\;", "switch-client", "-T", passthroughTable,
    ],
    [
      "bind-key", "-T", passthroughTable, "C-\\;",
      "send-keys", "-H", "1b", "5b", "35", "30", "30", "31", "7e",
      "\\;", "switch-client", "-T", "root",
    ],
    [
      "bind-key", "-T", passthroughTable, "C-/",
      "send-keys", "-H", "1b", "5b", "35", "30", "31", "34", "7e",
      "\\;", "switch-client", "-T", passthroughTable,
    ],
  ];
  for (const [_index, key, code] of zoomUserKeys) {
    const codeHex = [...String(code)].map((digit) => digit.charCodeAt(0).toString(16));
    commands.push([
      "bind-key", "-T", passthroughTable, key,
      "send-keys", "-H", "1b", "5b", ...codeHex, "7e",
      "\\;", "switch-client", "-T", passthroughTable,
    ]);
  }
  commands.push(["bind-key", "-T", passthroughTable, "User112", "detach-client"]);
  for (const [key, ...digits] of [
    ["User100", "35", "30", "30", "35"],
    ["User101", "35", "30", "30", "36"],
    ["User111", "35", "30", "30", "39"],
    ["User117", "35", "30", "31", "34"],
  ]) {
    commands.push([
      "bind-key", "-T", passthroughTable, key,
      "send-keys", "-H", "1b", "5b", ...digits, "7e",
      "\\;", "switch-client", "-T", passthroughTable,
    ]);
  }
  commands.push(["bind-key", "-T", passthroughTable, "Any", "send-keys", "\\;", "switch-client", "-T", passthroughTable]);
  for (const key of passthroughMouseKeys) {
    commands.push(["bind-key", "-T", passthroughTable, key, "send-keys", "-M", "\\;", "switch-client", "-T", passthroughTable]);
  }

  for (const args of commands) {
    try {
      execFileSync("tmux", args, { timeout: 1000, stdio: "ignore" });
    } catch (error) {
      if (debugLogging) {
        console.error(`tweb: passthrough command failed: ${error.message}`);
      }
    }
  }
}

function listTmuxClientStates() {
  if (!ownTmuxPane) return new Map();
  try {
    const output = execFileSync(
      "tmux",
      ["list-clients", "-F", "#{client_tty}\t#{client_session}\t#{window_id}\t#{pane_id}\t#{client_key_table}"],
      { encoding: "utf8", timeout: 1000 }
    );
    const states = new Map();
    for (const line of output.trim().split("\n")) {
      const [tty, session, windowId, paneId, keyTable] = line.split("\t");
      if (tty) states.set(tty, { session, windowId, paneId, keyTable: keyTable || "root" });
    }
    return states;
  } catch (error) {
    return new Map();
  }
}

function switchTmuxClientTable(tty, table) {
  try {
    execFileSync(
      "tmux",
      ["switch-client", "-c", tty, "-T", table],
      { timeout: 1000, stdio: "ignore" }
    );
    return true;
  } catch (error) {
    if (debugLogging) console.error(`tweb: client table switch failed ${tty}: ${error.message}`);
    return false;
  }
}

// The passthrough table is armed only while vimium is off. Bypass (Cmd) does not
// depend on the tmux table — the engine delivers it natively regardless of mode —
// and with vimium on the normal-mode keys have to work, so the table stays off.
// That is what makes "bypass on + vimium on" give both vimium and Cmd.
function reconcileTmuxPassthrough(states = listTmuxClientStates()) {
  if (!ownTmuxPane) return;
  const paneId = ownTmuxPane;
  const passthroughArmed = !vimiumShortcutsEnabled;

  for (const [tty, originalTable] of [...passthroughClientTables]) {
    const state = states.get(tty);
    if (!passthroughArmed || !state || state.paneId !== paneId) {
      if (state) switchTmuxClientTable(tty, originalTable);
      passthroughClientTables.delete(tty);
      if (debugLogging) {
        console.error(`tweb: passthrough client restore ${tty} ${state?.paneId || "detached"} -> ${originalTable}`);
      }
    }
  }

  if (!passthroughArmed) return;
  for (const [tty, state] of states) {
    if (state.paneId !== paneId || passthroughClientTables.has(tty)) continue;
    const originalTable = state.keyTable === passthroughTable ? "root" : state.keyTable;
    if (switchTmuxClientTable(tty, passthroughTable)) {
      passthroughClientTables.set(tty, originalTable || "root");
      if (debugLogging) {
        console.error(`tweb: passthrough client arm ${tty} ${state.paneId} from ${originalTable || "root"}`);
      }
    }
  }
}

function restoreTmuxPassthroughClients() {
  for (const [tty, originalTable] of [...passthroughClientTables]) {
    switchTmuxClientTable(tty, originalTable);
    passthroughClientTables.delete(tty);
  }
}

function initializeTmuxVisibility() {
  if (!ownTmuxPane) return;
  ensureTmuxPassthroughTable();
  try {
    const output = execFileSync(
      "tmux",
      [
        "display-message",
        "-p",
        "-t",
        ownTmuxPane,
        "#{socket_path}\t#{start_time}\t#{session_name}\t#{window_id}\t#{window_index}\t#{pane_title}",
      ],
      { encoding: "utf8", timeout: 1000 }
    ).trim();
    const [socketPath, serverStartedAt, session, windowId, windowIndex, ...titleParts] = output.split("\t");
    if (socketPath && serverStartedAt && session && windowId && windowIndex !== "") {
      tmuxIdentity = {
        socketPath,
        serverStartedAt,
        session,
        windowId,
        windowIndex,
        paneId: ownTmuxPane,
      };
      const keys = windowSessionKeys(tmuxIdentity);
      if (keys) {
        const directory = path.join(app.getPath("userData"), "window-sessions");
        windowSessionPath = path.join(directory, `${keys.primary}.json`);
        legacyWindowSessionPath = keys.legacy
          ? path.join(directory, `${keys.legacy}.json`)
          : null;
      }
      tmuxPlacement = { session, windowId, paneId: ownTmuxPane };
    }
    originalPaneTitle = titleParts.join("\t");

    if (tmuxPlacement) {
      const clients = execFileSync(
        "tmux",
        ["list-clients", "-F", "#{client_tty}\t#{client_session}\t#{window_id}\t#{window_zoomed_flag}\t#{pane_id}"],
        { encoding: "utf8", timeout: 1000 }
      );
      visibleClientTtys = visibleTmuxClientTtys(clients, tmuxPlacement);
      recordVisibility(currentPane(), visibleClientTtys.size > 0);
    }
  } catch (error) {
    if (debugLogging) console.error(`tweb: visibility init failed: ${error.message}`);
  }
  armVisibilityFallback();
}

// === Pane visibility ================================================================
//
// DESIGN.md 5.2 gives the pane visibility lifecycle to the `tweb __pane` frontend, and
// that is where it now lives: the frontend already owns $TMUX_PANE and already wakes on a
// tick for geometry, so it probes tmux once per tick and pushes the raw result over the
// control channel (see the VIS line in the control-channel parser). The engine spawns no
// tmux child for visibility at all — it only reacts.
//
// FALLBACK, when no push ever arrives. The engine is launched directly by tests and by
// hand, where there is no frontend to push. Two signals decide:
//   - no TWEB_FRONTEND_PID  -> no frontend exists, poll from startup.
//   - TWEB_FRONTEND_PID set -> wait one grace window for the first push, then poll anyway.
// The grace window matters beyond belt-and-braces: an installed `tweb` older than this
// main.cjs spawns an engine that would otherwise wait forever for a line that version
// never sends, and the pane would freeze at its startup visibility. The first push
// disarms the poll permanently; the frontend's death is already handled by the orphan
// watchdog, so there is no need to re-arm afterwards.
const VISIBILITY_PUSH_GRACE_MS = 2000;
const VISIBILITY_POLL_MS = 250;
let visibilityPollTimer = null;
let visibilityFallbackTimer = null;
let visibilitySource = "startup";
let lastVisibilityPushAt = null;

function armVisibilityFallback() {
  if (!ownTmuxPane) return;
  const delay = process.env.TWEB_FRONTEND_PID ? VISIBILITY_PUSH_GRACE_MS : 0;
  visibilityFallbackTimer = setTimeout(() => {
    visibilityFallbackTimer = null;
    if (visibilitySource === "push") return;
    visibilitySource = "poll";
    if (debugLogging) console.error("tweb: visibility falling back to polling tmux");
    scheduleVisibilityCheck();
  }, delay);
  visibilityFallbackTimer.unref();
}

function scheduleVisibilityCheck() {
  if (visibilityPollTimer) clearTimeout(visibilityPollTimer);
  visibilityPollTimer = setTimeout(() => {
    visibilityPollTimer = null;
    syncTmuxVisibility();
    scheduleVisibilityCheck();
  }, VISIBILITY_POLL_MS);
  visibilityPollTimer.unref();
}

// Applies a client listing to this pane. Shared by the push and the fallback poll so the
// two cannot drift — the tty bookkeeping below is the part that has to stay identical.
function applyClientListing(clients, placement) {
  tmuxPlacement = placement;
  const next = visibleTmuxClientTtys(clients, tmuxPlacement);
  const wasVisible = currentPane().visible;
  // A client that stopped showing this pane keeps the image placed on it, so the delete
  // goes to that tty directly.
  for (const tty of visibleClientTtys) {
    if (!next.has(tty)) deleteImageFromClientTty(tty);
  }
  const becameVisible = [...next].some((tty) => !visibleClientTtys.has(tty));
  visibleClientTtys = next;
  const changed = recordVisibility(currentPane(), next.size > 0);
  if (changed) {
    updatePaintingState();
    if (debugLogging) {
      console.error(`tweb: visibility ${changed.visible ? "visible" : "hidden"}`);
    }
  }
  if (becameVisible) repaintActiveTab();
}

// The frontend's push. It carries the client key tables too, so the passthrough
// reconcile runs off the same data instead of spawning its own `list-clients`.
function applyVisibilityPush(hex) {
  const push = parseVisibilityPush(hex);
  if (!push) return;
  if (visibilityFallbackTimer) {
    clearTimeout(visibilityFallbackTimer);
    visibilityFallbackTimer = null;
  }
  if (visibilityPollTimer) {
    clearTimeout(visibilityPollTimer);
    visibilityPollTimer = null;
  }
  visibilitySource = "push";
  lastVisibilityPushAt = Date.now();
  if (debugLogging
    && (push.placement.session !== tmuxPlacement?.session
      || push.placement.windowId !== tmuxPlacement?.windowId)) {
    console.error(
      `tweb: pane moved ${tmuxPlacement?.session}:${tmuxPlacement?.windowId}`
      + ` -> ${push.placement.session}:${push.placement.windowId}`
    );
  }
  applyClientListing(push.clients, push.placement);
  reconcileTmuxPassthrough(push.states);
}

function syncTmuxVisibility() {
  if (!tmuxPlacement || visibilityCheckRunning) return;
  visibilityCheckRunning = true;
  // Re-resolve where the pane is before matching clients. A pane that was moved
  // by break-pane/join-pane keeps its id but changes window (and possibly
  // session); matching against a stale window makes every client miss and the
  // pane look hidden, which stops painting until the process restarts.
  execFile(
    "tmux",
    ["display-message", "-p", "-t", tmuxPlacement.paneId, "#{session_name}\t#{window_id}"],
    { encoding: "utf8", timeout: 1000 },
    (placementError, placementOut) => {
      let placement = tmuxPlacement;
      if (!placementError) {
        const [session, windowId] = String(placementOut).trim().split("\t");
        if (session && windowId) placement = { ...tmuxPlacement, session, windowId };
      }
      // The flag is cleared in the inner callback. If spawning it throws, clear
      // it here instead — otherwise visibility polling stops for good.
      try {
        execFile(
          "tmux",
          ["list-clients", "-F", "#{client_tty}\t#{client_session}\t#{window_id}\t#{window_zoomed_flag}\t#{pane_id}"],
          { encoding: "utf8", timeout: 1000 },
          (error, stdout) => {
            visibilityCheckRunning = false;
            if (error) return;
            // A push can land while this poll is still in flight: clearing the timer
            // does not recall an execFile already running. Its answer predates the
            // push, so applying it would put the engine back on stale state that
            // nothing corrects until the next change.
            if (visibilitySource === "push") return;
            applyClientListing(stdout, placement);
            reconcileTmuxPassthrough();
          }
        );
      } catch (spawnError) {
        visibilityCheckRunning = false;
        if (debugLogging) console.error(`tweb: visibility poll failed: ${spawnError.message}`);
      }
    }
  );
}

// --- Kitty graphics ---

// Hands one frame to the shared graphics worker.
//
// The worker is one thread doing one CPU-bound job, so it is shared between panes — but each
// pane's view of what it has in flight there is its own, which is what `frame-context.cjs`
// keeps. The pane a completion belongs to travels with the message rather than being inferred,
// because inferring it is how one pane's frame ends up placed in another pane's rectangle.
function sendGfxFrameToWorker(frame, frames = currentFrames()) {
  const pixels = frame.png.byteOffset === 0 && frame.png.byteLength === frame.png.buffer.byteLength
    ? frame.png
    : Buffer.from(frame.png);
  try {
    gfxWorker.postMessage({
      type: "frame",
      paneKey: frames.record.key,
      buffer: pixels.buffer,
      byteOffset: pixels.byteOffset,
      byteLength: pixels.byteLength,
      header: frame.header,
      format: frame.format || "png",
      width: frame.width,
      height: frame.height,
      transport: frameTransport,
      filePath: frameFilePathFor(frames, frame.format),
    }, [pixels.buffer]);
  } catch (error) {
    // The hand-off never happened, so the pane must not be left believing the worker is busy —
    // it would never dispatch again and the pane would freeze on its last frame.
    frames.gfxBusy = false;
    frames.activeGfxGeneration = null;
    console.error(`tweb: graphics dispatch failed: ${error.message}`);
  }
}

// The escape sequences the worker produced, put on the pane's own tty by the pane's own
// writer. The worker no longer writes them itself: a second writer on one tty is the tear
// `frame-writer.cjs` exists to remove, and on a hosted engine stdout is the supervisor's
// control pipe rather than anybody's terminal.
//
// One write for the whole run, not one per command. The direct transport splits a payload
// into `m=1` continuation chunks that the terminal must read consecutively, and writing them
// separately would let a caret sequence land in the middle of one.
function writeGfxCommands(commands) {
  if (!commands || commands.length === 0) return;
  let raw = "";
  for (const command of commands) {
    raw += `${ESC}_G${command.header}`;
    if (command.payload && command.payload.length > 0) raw += `;${command.payload}`;
    raw += `${ESC}\\`;
  }
  try {
    paneWrite(graphicsPassthrough(raw));
  } catch (error) {
    void error;
  }
  // The graphics command leaves the cursor at the pane origin, and whole frames are
  // continuous — so without this the caret is dragged back to the corner several times a
  // second. `writeGfx` does the same for everything that does not come from the worker.
  reassertTerminalCaret();
}

function handleGfxWorkerReady(commands, frames = currentFrames()) {
  // The bookkeeping — was that frame stale, what runs next, and the `imageTransferred` reset
  // that goes with freeing a stale frame's data — is decided in `frame-context.cjs` and tested
  // there. What is left here is the writing, which is the part that needs a terminal.
  const settled = completeGfxFrame(frames);
  // A frame the viewport has already moved past is never placed: the terminal would scale a
  // stale-sized image into the new pane box. Its data is freed instead of drawn.
  if (settled.stale) {
    writeGfx(`a=d,d=I,i=${frames.imageIds.base},q=2`, "");
  } else {
    writeGfxCommands(commands);
  }
  // `writeGfxCommands` reasserts the caret itself; the stale branch above wrote a delete
  // through `writeGfx`, which does the same. So there is nothing left to do here.
  if (settled.next) sendGfxFrameToWorker(settled.next, frames);
}

// The PNG path degrades to `t=d` when a frame file cannot be written, but a raw frame has
// nowhere to degrade to inside the worker — 20MB does not fit an escape sequence, and the
// worker holds pixels, not an encoder. So a persistent failure (a full disk, an unwritable
// userData) would drop every whole frame and leave the pane frozen on its last one.
//
// Fall back here instead: after a couple of consecutive failures, give up raw for the rest
// of the session and repaint, which comes back through the PNG path and its own fallbacks.
const RAW_FRAME_FAILURE_LIMIT = 3;
let rawFrameFailures = 0;

function noteRawFrameFailure() {
  if (!rawFramesEnabled) return;
  rawFrameFailures += 1;
  if (rawFrameFailures < RAW_FRAME_FAILURE_LIMIT) return;
  rawFramesEnabled = false;
  console.error(`tweb: raw frames failed ${rawFrameFailures}x, falling back to PNG`);
  if (soleWindows.win && !soleWindows.win.isDestroyed() && currentPane().visible) soleWindows.win.webContents.invalidate();
}

gfxWorker.on("message", (message) => {
  if (message?.type === "error") {
    console.error(`tweb: graphics writer failed: ${message.message}`);
    noteRawFrameFailure();
  } else {
    rawFrameFailures = 0;
  }
  // The completion is routed to the pane whose frame it was, by the key that travelled with the
  // request. A completion applied to the wrong pane would free that pane's image and dispatch
  // its queue against another's generation.
  const frames = frameContextFor(message?.paneKey);
  if (!frames) {
    // Never silent. An unroutable completion means that pane is stuck believing the worker is
    // busy, so it will never dispatch again — a pane frozen on its last frame with no error is
    // exactly the failure this run exists to avoid.
    console.error(`tweb: graphics completion for an unknown pane: ${message?.paneKey}`);
    return;
  }
  handleGfxWorkerReady(message?.commands, frames);
});
gfxWorker.on("error", (error) => {
  // The worker is gone, so every pane's in-flight hand-off is gone with it. Leaving any of them
  // marked busy would freeze that pane on its last frame.
  for (const frames of frameContexts.values()) {
    frames.gfxBusy = false;
    frames.activeGfxGeneration = null;
    frames.pendingGfxFrame = null;
  }
  console.error(`tweb: graphics writer crashed: ${error.stack || error.message}`);
});

function queueGfxFrame(png, header, generation, format = "png", size = null, frames = currentFrames()) {
  const frame = { png, header, generation, format, width: size?.width, height: size?.height };
  // Whether it goes now or waits — and whether it is already too old to be worth either — is
  // decided in `frame-context.cjs`, which is where the one-deep queue's reasons are written down.
  const ready = enqueueGfxFrame(frames, frame);
  if (ready) sendGfxFrameToWorker(ready, frames);
}

function writeGfx(header, payload) {
  // ESC _ G <header> [; <payload>] ESC \
  let raw = `${ESC}_G${header}`;
  if (payload && payload.length > 0) {
    raw += `;${payload}`;
  }
  raw += `${ESC}\\`;
  // Wrap it in tmux passthrough.
  const wrapped = graphicsPassthrough(raw);
  try {
    paneWrite(wrapped);
  } catch (e) {}
  reassertTerminalCaret();
}

// The Kitty protocol caps one escape sequence's payload, so anything larger arrives as a
// run of `m=1` continuation chunks. The gfx worker does this for whole frames; a patch is
// written inline, so it needs its own.
//
// `prefix`/`suffix` walk the cursor to the patch's cell and back. They have to travel
// inside the same passthrough wrapper as the graphics command — the wrapper is what parks
// the cursor at the pane origin, and a separate write would start from wherever the cursor
// happens to be. Only the first chunk carries the prefix; the continuations follow at the
// same spot.
const GFX_CHUNK = 3072;

function writeGfxChunked(header, payload, prefix = "", suffix = "") {
  if (!payload || payload.length === 0) {
    writeGfx(header, "");
    return;
  }
  let raw = "";
  let first = true;
  for (let offset = 0; offset < payload.length; offset += GFX_CHUNK) {
    const chunk = payload.slice(offset, offset + GFX_CHUNK);
    const more = offset + GFX_CHUNK < payload.length;
    const chunkHeader = first
      ? `${header}${more ? ",m=1" : ""}`
      : `${more ? "m=1," : ""}q=2`;
    first = false;
    raw += `${ESC}_G${chunkHeader};${chunk}${ESC}\\`;
  }
  try {
    paneWrite(graphicsPassthrough(`${prefix}${raw}${suffix}`));
  } catch (e) {}
  reassertTerminalCaret();
}

// --- terminal setup ---
// Note: inside tmux, the alternate screen (1049h) and clear screen (2J) can affect other
// panes, so neither is used.
// Cell-based placement keeps the image confined to the pane's own area.

function terminalSetup() {
  // The image shows up in the pane on its own, but the cursor does not: the pane inherits
  // whatever the shell left behind, which is a visible block in the top-left corner. There
  // is nothing for it to mean until a caret is parked on one — and sitting in the corner it
  // reads as the caret having started there. Hide it until something parks it.
  caretHidden = true;
  try {
    paneWrite(`${CSI("?25l")}${CARET_SHAPE_RESET}`);
  } catch (error) {
    void error;
  }
}

// Chromium's native DevTools resets the terminal's modified-key mode, and the process that has
// to re-declare it is the one holding this pane's pty — its own frontend. A per-pane engine can
// ask directly, because `TWEB_FRONTEND_PID` is that frontend.
//
// A hosted engine MUST NOT. The pid it has is the supervisor's, which owns no pty and has
// nothing to re-declare, and SIGUSR1's default action is *terminate*: measured, the daemon died
// the moment a real engine started, taking every other hosted pane with it. The supervisor now
// ignores the signal (`engine_host::ignore_frontend_signals`), but ignoring is a guard against
// the hazard rather than a way to do the work — so the hosted path does not signal at all, and
// the request travels as an addressed event over that pane's connection instead.
function requestTrackedKeyboardModeRestore() {
  if (!paneIsInTmux()) return;
  if (hostedRuntime) {
    // The verb is the supervisor's to define, so this stays a no-op until it lands rather than
    // inventing one the daemon would drop. Signalling in the meantime is the one thing that is
    // definitely wrong.
    if (debugLogging) console.error("tweb: keyboard mode restore skipped (hosted)");
    return;
  }
  const frontendPid = Number.parseInt(process.env.TWEB_FRONTEND_PID || "", 10);
  if (!Number.isSafeInteger(frontendPid) || frontendPid <= 1) return;
  try {
    // Electron may be reparented while Chromium starts, so process.ppid is not
    // a stable frontend identity. Rust passes its PID explicitly.
    process.kill(frontendPid, "SIGUSR1");
    if (debugLogging) console.error(`tweb: keyboard mode restore requested ${frontendPid}`);
  } catch (error) {
    if (debugLogging) console.error(`tweb: keyboard mode restore request failed: ${error.message}`);
  }
}

function scheduleTrackedKeyboardModeRestore() {
  for (const delay of [0, 100, 500, 1000]) {
    setTimeout(requestTrackedKeyboardModeRestore, delay);
  }
}

function terminalCleanup(record = currentPane()) {
  try {
    // Delete the base image and any damage patches still placed over it. A patch left
    // behind would outlive the pane as a stale image in the terminal's cache.
    const ids = paneImageIds(record);
    writeGfx(`a=d,d=I,i=${ids.base}`, "");
    for (const id of ids.patchIds) {
      writeGfx(`a=d,d=I,i=${id}`, "");
    }
  } catch (e) {}
  // Caret parking leaves the cursor shape as a bar, so restore the terminal default.
  try {
    paneWrite(CSI("0 q"));
  } catch (e) {}
}

// --- frame transfer ---

function applyActiveFrameRate(rate, windows = soleWindows, record = currentPane()) {
  // Both mutators suppress a redundant call, and that matters beyond saving a syscall:
  // `setFrameRate` provokes a paint of its own, and the playback tier is decided by counting
  // paints over a window, so re-applying the current tier feeds the detector its own noise.
  const change = applyPaneFrameRate(windows, rate);
  if (!change) return;
  recordFrameTier(record, change.rate);
  if (windows.win && !windows.win.isDestroyed() && record.visible) {
    windows.win.webContents.setFrameRate(change.rate);
  }
  if (debugLogging) console.error(`tweb: frame rate ${change.rate}fps`);
}

function markInteractionActivity() {
  if (!adaptiveFrameRate) return;
  // Raising the rate only affects future paints, so coming out of the idle rate
  // would otherwise leave the last idle frame on screen for a whole interval —
  // a quarter second of "nothing happened" after a keypress.
  const wasIdle = isThrottled(soleWindows);
  applyActiveFrameRate(maxActiveFrameRate);
  if (wasIdle && soleWindows.win && !soleWindows.win.isDestroyed() && currentPane().visible) soleWindows.win.webContents.invalidate();
  if (soleWindows.frameIdleTimer) clearTimeout(soleWindows.frameIdleTimer);
  // The paints this interaction is about to cause say nothing about whether the page
  // paints on its own, which is the only thing the settle decides — so the count starts
  // fresh. It does not need a handicap beyond that: over a 700ms window, echoing a
  // keystroke is one or two paints while an animating page is dozens, and the threshold
  // sits between them.
  soleWindows.paintsSinceSettle = 0;
  soleWindows.frameIdleTimer = setTimeout(settleFrameRate, 700);
}

// Where the rate lands once the active window expires: the playback rate while the page is
// still painting by itself, the idle rate once it stops. Re-armed rather than left alone,
// so a video that ends drops the rest of the way and a static page that starts an animation
// picks up without needing a keystroke.
function settleFrameRate() {
  soleWindows.frameIdleTimer = null;
  // Dropping the rate while a page is still loading stops offscreen painting
  // almost entirely: measured on google.com, the page committed at 1.4s and the
  // next frame did not go out until 5.4s. Stay at the active rate until the load
  // settles — that is precisely when the screen is changing anyway.
  if (soleWindows.win && !soleWindows.win.isDestroyed() && soleWindows.win.webContents.isLoading()) {
    markInteractionActivity();
    return;
  }
  // Judge against the paints that arrived over the window just ended, then reset the
  // count. Reading a timestamp instead would count the paint that changing the rate
  // itself provokes, and a static page would hold the playback rate forever.
  const settled = settledFrameRate(soleWindows.paintsSinceSettle, frameRates);
  soleWindows.paintsSinceSettle = 0;
  applyActiveFrameRate(settled.rate);
  if (settled.painting) {
    soleWindows.frameIdleTimer = setTimeout(settleFrameRate, playbackWindow);
  }
}

// A page can start painting long after the last keystroke — a video begins, an animation
// runs — and at the idle rate nothing would raise it again. Arm the timer so the next
// settle sees the paints and moves up to the playback rate.
function notePaintActivity() {
  soleWindows.paintsSinceSettle += 1;
  if (!adaptiveFrameRate || soleWindows.frameIdleTimer) return;
  if (soleWindows.activeFrameRate >= playbackFrameRate) return;
  soleWindows.frameIdleTimer = setTimeout(settleFrameRate, playbackWindow);
}

// A placement the next frame will not fully cover has to be deleted, but the
// delete is paired with the replacement so the pane is never left bare: on its
// own it would bare the terminal for as long as the frame takes to arrive.
// The terminal holds the last image we transferred under `imageId`, which lets a
// resize re-place it without sending the pixels again.

// `d=i` drops the placements but keeps the image data, so it can be re-placed.
function deletePlacement(frames = currentFrames()) {
  frames.pendingImageDelete = false;
  writeGfx(`a=d,d=i,i=${frames.imageIds.base},q=2`, "");
}

// Chromium needs a moment to repaint at a new size, and tmux has already redrawn
// the pane underneath — so a resize would show the bare terminal until the frame
// lands. Re-placing the image the terminal already has covers the pane at once:
// it is a few dozen bytes, so unlike a frame it never waits behind the encoder.
// The accurate frame replaces it as soon as it arrives.
function replacePlacement(frames = currentFrames()) {
  if (!frames.imageTransferred) return;
  if (frames.pendingImageDelete) deletePlacement(frames);
  writeGfx(`a=p,i=${frames.imageIds.base},C=1,c=${frames.cells.cols},r=${frames.cells.rows}`
    + (imageZ === 0 ? "" : `,z=${imageZ}`) + ",q=2", "");
}

// --- damage patches ---
//
// Encoding a whole frame is what a frame costs: measured on this pane geometry, 23ms for a
// document, 28ms for an ordinary page, 101ms for a photo — all of it synchronous on this
// thread, so it stalls input for that long too. But the damage behind most of those frames
// is a caret: a 30x30 rect. Cropping to the damage first drops the encode to 0.02ms.
//
// A patch is a second image placed over the base frame. The terminal keeps both, and later
// placement wins within one z, so the patch covers the stale pixels underneath without
// touching the base — which stays valid, re-placeable on resize, and is what the next whole
// frame replaces. See DETAIL.md sections 8.1 and 8.2 for the measurements and the terminal
// probe behind this.
//
// Patches deliberately bypass the gfx worker. That queue is one frame deep, which is right
// for whole frames but would leave a 0.4KB patch waiting behind a 1.5MB one; a patch is
// small enough to write inline for the same reason `replacePlacement` does.
//
// The pool and the damage union it covers live on the pane's frame context — see
// `frame-context.cjs`. Whole/patch counts live on the pane record: `tweb diag` reports them per
// pane, and one runtime holding several must not attribute one pane's frames to another.

// `d=I` frees the image data as well as the placement. Unlike the base image a patch is
// never re-placed, so keeping its pixels around would only consume the terminal's image
// budget — and leaving them behind at exit is exactly the stale-image case DESIGN.md
// section 7.7 gates on.
function deletePatches(frames = currentFrames()) {
  for (const id of takeLivePatchIds(frames)) writeGfx(`a=d,d=I,i=${id},q=2`, "");
}

// Kitty places an image at the cursor. Patches address their cell against the pane's own
// origin on screen — see `patchCursorMove` for why that is absolute rather than relative.
function patchPlacementSequence(id, place, frames = currentFrames()) {
  const header = `a=T,f=100,i=${id},C=1,c=${place.cols},r=${place.rows}`
    + (imageZ === 0 ? "" : `,z=${imageZ}`) + ",q=2";
  return { header, ...patchCursorMove(place, frames.origin, frames.cells, ESC) };
}

// Returns true when the damage was sent as a patch, false when the caller should fall back
// to transferring the whole frame.
function sendPatch(image, dirty, generation, frames = currentFrames(), record = currentPane()) {
  if (!frames.viewport || generation !== frames.generation) return false;
  // Addressing a patch's cell needs to know where the pane sits on screen. Without tmux
  // there is no pane offset to resolve — the whole terminal is the pane — but the cursor is
  // then wherever the page last parked it, so the origin has to be known either way.
  if (paneIsInTmux(record) && !frames.origin) return false;
  // A patch only makes sense over an already-correct base frame. With nothing on screen
  // yet, or a base from an older generation, the whole frame is what is needed.
  if (!frames.imageTransferred || frames.pendingImageDelete) return false;
  // Cover everything patched since the last whole frame, not just this frame's damage.
  // Without this a narrower patch leaves the previous, wider one showing around it — a
  // deleted character stays on screen until something forces a whole frame.
  const damage = unionDamage(dirty, frames.patchedDamage);
  // The dirty rect and the crop are in the frame's own pixels, so the cell grid has to be
  // measured against the frame rather than the pane: the two can differ by a rounding step,
  // and the terminal is already scaling the frame into the pane's cell box.
  const size = image.getSize();
  const geometry = patchGeometry(damage, frames.cells, size);
  if (!geometry) return false;

  let png;
  try {
    png = image.crop(geometry.crop).toPNG();
  } catch (error) {
    console.error(`tweb: patch encode failed: ${error.message}`);
    return false;
  }
  if (!png || png.length === 0) return false;

  const id = takeNextPatchId(frames);
  const { header, prefix, suffix } = patchPlacementSequence(id, geometry.place, frames);
  // The id may still hold an older patch from a previous cycle through the pool.
  writeGfx(`a=d,d=I,i=${id},q=2`, "");
  writeGfxChunked(header, png.toString("base64"), prefix, suffix);
  notePatch(frames, id, damage);
  record.frames.patches += 1;
  const patchFramesSent = record.frames.patches;
  if (patchFramesSent <= 12) {
    console.error(`tweb: patch sent #${patchFramesSent} `
      + `cells=${geometry.place.cols}x${geometry.place.rows}`
      + `@${geometry.place.col},${geometry.place.row} bytes=${png.length}`);
  }
  return true;
}

function transferFrame(pixels, generation, format = "png", size = null) {
  if (currentFrames().pendingImageDelete) deletePlacement();
  // Any patch on screen describes damage this frame already contains, so it goes out with
  // the frame that supersedes it. Dropping them earlier would bare the stale pixels
  // underneath for as long as the encode takes.
  deletePatches();
  // c=/r= make the terminal scale the image into the pane's cell box, so a frame
  // whose pixel size no longer matches still covers exactly the pane. `f=` is left to the
  // worker, which knows whether it is writing a PNG or raw pixels.
  const header = `a=T,i=${currentFrames().imageIds.base},C=1,`
    + `c=${currentFrames().cells.cols},r=${currentFrames().cells.rows}`
    + (imageZ === 0 ? "" : `,z=${imageZ}`);
  queueGfxFrame(pixels, format === "raw" ? header : `${header},f=100`, generation, format, size);
  currentPane().frames.whole += 1;
  // Only the first few: enough to see when a page actually reached the pane, which
  // is what separates "the engine is behind" from "the site is slow", and quiet
  // after that.
  if (currentFrames().framesSentCount < 12) {
    console.error(`tweb: frame sent #${++currentFrames().framesSentCount} ${format}`);
  }
  currentFrames().lastFrameSentAt = Date.now();
}

function sendFrameNow(image, generation) {
  if (!currentPane().visible || generation !== currentFrames().generation || !image || image.isEmpty()) return;
  const viewport = currentFrames().viewport;
  const size = image.getSize();
  const expected = viewport && renderedFrameSize(viewport);
  if (!expected || size.width !== expected.width || size.height !== expected.height) return;
  try {
    // Raw pixels skip the encode entirely; the worker swaps the channels and writes the
    // file. `toBitmap` hands back an owned copy, which is what the worker needs anyway —
    // the view `getBitmap` returns belongs to the frame and cannot be transferred.
    if (rawFramesEnabled) {
      const bitmap = image.toBitmap();
      currentFrames().imageTransferred = true;
      transferFrame(bitmap, generation, "raw", size);
      return;
    }
    // Hand the base64 conversion and the terminal write off to a worker once the PNG exists.
    // Even under stdout backpressure, the Electron main thread and keyboard input keep going.
    const png = image.toPNG();
    currentFrames().imageTransferred = true;
    transferFrame(png, generation, "png", size);
  } catch (error) {
    console.error(`tweb: frame encode failed: ${error.message}`);
  }
}

function flushPendingFrame() {
  currentFrames().pendingFrameTimer = null;
  const frame = currentFrames().pendingFrame;
  currentFrames().pendingFrame = null;
  if (!frame || frame.tab !== soleWindows.win || frame.generation !== currentFrames().generation || !currentPane().visible) return;
  sendFrameNow(frame.image, frame.generation);
}

function queueFrame(tab, image, immediate = false, dirty = null) {
  const generation = currentFrames().generation;
  const viewport = currentFrames().viewport;
  const size = image?.getSize();
  const expected = viewport && renderedFrameSize(viewport);
  if (!expected || !size || size.width !== expected.width || size.height !== expected.height) {
    if (debugLogging) {
      console.error(`tweb: frame dropped got=${size?.width}x${size?.height}`
        + ` want=${expected?.width}x${expected?.height}`);
    }
    return;
  }
  // The frame cache always takes the whole image, patch or not: a visibility repaint
  // re-places a complete frame, and a crop would leave it with a fragment of the page.
  //
  // Only the active tab's frame is kept. A NativeImage of a 2880x1800 frame is 20.7MB
  // (DETAIL.md 8.1), so caching every tab put N x that in the main process for the life of
  // the window — against DESIGN.md 6.5, which gates on a hidden page's buffers converging
  // to zero. Nothing reads a background tab's frame: `repaintActiveTab` only ever asks for
  // `soleWindows.win`, and `activateTab` calls `invalidate()`, so a switched-to tab paints fresh either
  // way. Dropping the entry is what makes it converge.
  if (tab === soleWindows.win) tabFrames.set(tab, { image, generation });
  else tabFrames.delete(tab);
  if (tab !== soleWindows.win || !currentPane().visible) return;
  // Small damage goes out immediately as a patch instead of waiting for the frame
  // interval — the wait exists to pace whole-frame encodes, and a patch costs a
  // thousandth of one. A caret keeping up with the keyboard is the whole point.
  if (dirty && !currentFrames().pendingFrameTimer && sendPatch(image, dirty, generation)) {
    currentFrames().lastFrameSentAt = Date.now();
    return;
  }
  currentFrames().pendingFrame = { tab, image, generation };
  if (currentFrames().pendingFrameTimer) return;
  const elapsed = Date.now() - currentFrames().lastFrameSentAt;
  const delay = immediate ? 0 : Math.max(0, soleWindows.frameIntervalMs - elapsed);
  currentFrames().pendingFrameTimer = setTimeout(flushPendingFrame, delay);
}

function repaintActiveTab() {
  if (!currentPane().visible || !soleWindows.win || soleWindows.win.isDestroyed()) return;
  const frame = tabFrames.get(soleWindows.win);
  if (frame && frame.generation === currentFrames().generation && !frame.image.isEmpty()) {
    queueFrame(soleWindows.win, frame.image, true);
    if (debugLogging) console.error("tweb: visibility repaint");
    return;
  }
  soleWindows.win.webContents.invalidate();
}

// --- viewport size query ---

function parseViewport(value) {
  if (!value) return null;
  const parts = value.trim().split(/[ ,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part <= 0)) {
    return null;
  }
  const [cols, rows, width, height] = parts.map(Math.round);
  return { cols, rows, width, height };
}

function queryTmuxViewport() {
  if (!ownTmuxPane) return null;
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(
      "tmux",
      [
        "display-message",
        "-p",
        "-t",
        ownTmuxPane,
        "#{pane_width} #{pane_height} #{client_cell_width} #{client_cell_height}",
      ],
      { encoding: "utf8", timeout: 1000 }
    );
    const [cols, rows, cellWidth, cellHeight] = out.trim().split(/\s+/).map(Number);
    if (cols > 0 && rows > 0 && cellWidth > 0 && cellHeight > 0) {
      return {
        cols,
        rows,
        width: Math.round(cols * cellWidth),
        height: Math.round(rows * cellHeight),
      };
    }
  } catch (e) {}
  return null;
}

// Prefer tmux's pane cell count and Ghostty's client cell pixel size above everything else.
function queryViewportSize() {
  return parseViewport(process.env.TWEB_VIEWPORT)
    || queryTmuxViewport()
    || currentFrames().viewport
    || { cols: 80, rows: 24, width: 640, height: 384 };
}


// --- browser window ---

function errorPage(url, code, description) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    :root{color-scheme:light dark}body{font:16px system-ui;margin:3rem;line-height:1.5}
    code{overflow-wrap:anywhere}small{opacity:.7}
  </style><h1>Can't open this page</h1><p><code>${escapeHtml(url)}</code></p>
  <p>${escapeHtml(description)} <small>(${code})</small></p>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderScaleFactor() {
  if (Number.isFinite(configuredDeviceScaleFactor)) {
    return Math.min(3, Math.max(1, configuredDeviceScaleFactor));
  }
  return Math.min(3, Math.max(1, screen.getPrimaryDisplay().scaleFactor || 1));
}

function logicalContentSize(vp) {
  // The tmux/Ghostty viewport is in device pixels while BrowserWindow sizes are DIPs.
  // Divide the CSS size by the scale, but render the offscreen output at that same scale so the
  // final bitmap lands as close as possible to the pane's real pixel size.
  const scaleFactor = renderScaleFactor();
  return {
    width: Math.max(1, Math.round(vp.width / scaleFactor)),
    height: Math.max(1, Math.round(vp.height / scaleFactor)),
  };
}

function renderedFrameSize(vp) {
  const logical = logicalContentSize(vp);
  const scaleFactor = renderScaleFactor();
  return {
    width: Math.max(1, Math.round(logical.width * scaleFactor)),
    height: Math.max(1, Math.round(logical.height * scaleFactor)),
  };
}

function browserWindowOptions(vp = currentFrames().viewport || queryViewportSize()) {
  const logical = logicalContentSize(vp);
  return {
    width: logical.width,
    height: logical.height,
    useContentSize: true,
    x: -10_000,
    y: -10_000,
    show: false,
    opacity: 0,
    paintWhenInitiallyHidden: true,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: { deviceScaleFactor: renderScaleFactor() },
      // The window is hidden by design — that is how the pane keeps it off the
      // screen — and Chromium throttles a hidden window's timers and rendering as
      // if it were a background tab. The pane *is* the foreground here.
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
      devTools: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      contextIsolation: true,
    },
  };
}

function tabLabel(tab, index) {
  const title = tab.webContents.getTitle() || tab.webContents.getURL() || "New tab";
  return `${index + 1}/${soleWindows.tabs.length} ${title}`;
}

function writeWindowSessionState(state) {
  if (!windowSessionPath || !state) return;
  const temporaryPath = `${windowSessionPath}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(windowSessionPath), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, windowSessionPath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    if (debugLogging) console.error(`tweb: window session save failed: ${error.message}`);
  }
}

function readWindowSession() {
  if (!restoreWindowSession || !windowSessionPath) return null;
  for (const candidate of [windowSessionPath, legacyWindowSessionPath]) {
    if (!candidate) continue;
    try {
      const session = normalizeWindowSession(
        JSON.parse(readFileSync(candidate, "utf8")),
        defaultZoomFactor
      );
      if (!session) continue;
      if (candidate !== windowSessionPath) {
        writeWindowSessionState({ version: 1, ...session });
        if (debugLogging) console.error("tweb: migrated legacy window session");
      }
      return session;
    } catch (error) {
      if (error.code !== "ENOENT" && debugLogging) {
        console.error(`tweb: window session restore failed: ${error.message}`);
      }
    }
  }
  return null;
}

function writeWindowSession() {
  if (!windowSessionPath || soleWindows.tabs.length === 0) return;
  const state = windowSessionForSave(soleWindows.tabs.flatMap((tab) => {
    if (tab.isDestroyed()) return [];
    return [{
      url: tabSessionUrls.get(tab) || tab.webContents.getURL(),
      zoom: tabZoomFactors.get(tab) ?? defaultZoomFactor,
    }];
  }), soleWindows.activeTabIndex, defaultZoomFactor);
  // A bare startup used to replace the last useful session with about:blank
  // after 100 ms. Preserve the existing file until a real page commits.
  writeWindowSessionState(state);
}

function scheduleWindowSessionSave() {
  if (!windowSessionPath || quitting) return;
  if (windowSessionSaveTimer) clearTimeout(windowSessionSaveTimer);
  windowSessionSaveTimer = setTimeout(() => {
    windowSessionSaveTimer = null;
    writeWindowSession();
  }, 100);
  windowSessionSaveTimer.unref();
}

function updatePaneTitle() {
  if (!ownTmuxPane) return;
  // Tab state belongs to this pane's in-page badge. Putting it in tmux's pane
  // title makes one active pane look like the state of the whole window.
  execFile("tmux", ["select-pane", "-t", ownTmuxPane, "-T", "tweb"], () => {});
}

function restorePaneTitle() {
  if (!ownTmuxPane || originalPaneTitle === null) return;
  try {
    execFileSync(
      "tmux",
      ["select-pane", "-t", ownTmuxPane, "-T", originalPaneTitle],
      { timeout: 1000, stdio: "ignore" }
    );
  } catch (e) {}
}

// The single place a tab's offscreen window is reconciled against what the pane shows.
// Painting was already decided here; the surface size is decided here too, because the
// two answer the same question and splitting them is how they drift.
//
// Measured (Electron 43.2.0, 1440x900 @dsf2, gpu-process phys_footprint): a background
// window costs ~70MB of GPU surface and `stopPainting` gives back only ~7MB of it. The
// surface itself is what holds the memory, so a tab that cannot put a pixel on screen
// collapses its surface instead — see electron/surface-policy.cjs for why the collapsed
// size keeps the full width.
function updatePaintingState() {
  // A hidden pane keeps nothing to redraw with. The cached frame is a 20.7MB decoded
  // NativeImage (DETAIL.md 8.1) held in the main process, and DESIGN.md 6.5 gates on a
  // hidden page's buffers converging to zero — so it goes, and the reveal below repaints
  // instead of re-placing. `repaintActiveTab` already falls back to `invalidate()` when
  // the cache is empty, which is the same path a resize generation bump takes.
  if (!currentPane().visible) tabFrames.clear();
  const held = surfaceHeldForAgent();
  for (const tab of soleWindows.tabs) {
    if (tab.isDestroyed()) continue;
    const plan = surfacePlan(tab === soleWindows.win, currentPane().visible, logicalContentSize(currentViewport()), held);
    tab.webContents.setBackgroundThrottling(plan.backgroundThrottling);
    tab.webContents.setFrameRate(plan.painting ? soleWindows.activeFrameRate : 1);
    applySurfacePlan(tab, plan);
    // Read before write, like the resize above: `startPainting()` on a tab that is
    // already painting *provokes a paint*, and this reconciler runs every second, so
    // re-issuing it billed a static idle page one whole frame per second — 5.18MB of
    // raw pixels written to disk each time. See `paintingTransition` for the numbers.
    const transition = paintingTransition(plan.painting, readIsPainting(tab.webContents));
    if (transition === "start") tab.webContents.startPainting();
    else if (transition === "stop") tab.webContents.stopPainting();
  }
}

// `isPainting` is Electron 43 API, but the engine also runs against whatever the user
// has cached, so an older runtime must degrade to the unconditional call rather than
// throw inside the watchdog.
function readIsPainting(contents) {
  try {
    return typeof contents.isPainting === "function" ? contents.isPainting() : null;
  } catch (error) {
    void error;
    return null;
  }
}

function currentViewport() {
  return currentFrames().viewport || queryViewportSize();
}

// Resizing re-lays out the page, so the size is read before it is written. A tab whose
// surface grows back is repainted from scratch: the collapsed frames are a different size
// and `queueFrame` drops them, so nothing stale can survive the restore.
function applySurfacePlan(tab, plan) {
  const size = tab.getContentSize();
  const current = { width: size[0], height: size[1] };
  if (!surfaceResizeNeeded(plan, current)) return;
  // Recorded before the resize, and only for the tab that is this pane's active one: the
  // record's `logical` is the size a restore goes back to, and reading it off a collapsed
  // surface is how the agent API came back with innerHeight=1.
  if (tab === soleWindows.win) {
    recordSurface(currentPane(), { collapsed: plan.height <= 1, logical: { width: plan.width, height: plan.height } });
  }
  tab.setContentSize(plan.width, plan.height);
  // Chromium resets the zoom factor on a content resize, and a collapsed tab would come
  // back at 100% however the user had zoomed it.
  const zoomFactor = tabZoomFactors.get(tab) ?? defaultZoomFactor;
  if (tab.webContents.getZoomFactor() !== zoomFactor) tab.webContents.setZoomFactor(zoomFactor);
}

// === The agent's surface hold =======================================================
//
// #22 collapses a hidden pane's surface to width x 1 to give the GPU bytes back. That is
// right for the human — nobody is looking at the pane — and wrong for an agent, which
// drives a pane precisely because it does not need a human watching. At innerHeight=1 the
// page lays out with everything below the fold, so `snapshot` returned no refs and
// `screenshot` returned a two-pixel strip. Both *succeeded*, which is why it was invisible.
//
// A hold restores the surface for the length of one agent call. It is a refcount rather
// than a flag because calls overlap: `wait` polls for up to ten seconds while another
// command runs against the same pane. And it has a deadline, because a hold leaked by an
// exception would pin the surface open for the life of the process — undoing #22's gate
// for anyone who ever ran one agent command.
const AGENT_SURFACE_HOLD_TTL_MS = 30_000;

function surfaceHeldForAgent(windows = soleWindows) {
  const state = surfaceHeld(windows, Date.now());
  // The watchdog tick that notices the expiry is also the one that collapses the surface again,
  // so a leak costs bytes for a bounded window rather than forever. Reported once: the count is
  // dropped with the report, so the next tick does not repeat the complaint.
  if (state.expired) {
    console.error(`tweb: agent surface hold expired with ${state.outstanding} outstanding`);
  }
  return state.held;
}

// Restore was measured at about a millisecond in #22, but a page that is still loading can
// take longer to produce its first frame at the new size. Bounded so a page that never
// paints costs the call a beat rather than hanging it.
const SURFACE_RESTORE_TIMEOUT_MS = 1500;

// A restored surface is not a restored layout. The compositor delivers a correctly sized
// frame within a millisecond or two, and the renderer takes ~380ms longer to lay the page
// out at that size — measured on a hidden pane, 13 of 30 `eval innerHeight` calls answered
// 1 while `awaitRestoredFrame` had already accepted a full-height frame. Waiting for the
// layout as well is what makes the hold mean what it says.
//
// The page's own backstop cannot cover a renderer that is gone: the script never runs, so
// the promise never settles and the hold would sit open until its 30s TTL. Measured on a
// SIGKILLed renderer, that turned a screenshot that used to fail in 1.5s into one that
// failed in 62s. Hence the race here, in a process that is definitely alive.
function awaitRestoredLayout(contents) {
  return Promise.race([
    contents.executeJavaScript(restoredLayoutScript(SURFACE_RESTORE_TIMEOUT_MS), true)
      .catch(() => "unreachable"),
    new Promise((resolve) =>
      setTimeout(() => resolve("unreachable"), SURFACE_RESTORE_TIMEOUT_MS + 250)),
  ]);
}

// Waiting on layout is not enough: `capturePage` reads the compositor, and a window that
// has just been resized and told to start painting has no frame in it yet — measured, the
// first screenshots after a restore failed with UnknownVizError while `innerHeight`
// already reported the full height. So the wait is for a paint at the restored size.
//
// The paint hands over the rendered page as a NativeImage, which is what `capturePage`
// would have gone back to the compositor for. Keeping it is both cheaper and steadier:
// asking the compositor again during the restore kept failing intermittently (2 of 6 runs)
// even after the frame had arrived.
function awaitRestoredFrame(contents) {
  return new Promise((resolve) => {
    const expected = renderedFrameSize(currentViewport());
    let done = false;
    const finish = (image) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { contents.off("paint", onPaint); } catch (error) { void error; }
      resolve(image || null);
    };
    const onPaint = (_event, _dirty, image) => {
      const size = image.getSize();
      if (size.width === expected.width && size.height === expected.height) finish(image);
    };
    const timer = setTimeout(() => {
      if (debugLogging) console.error("tweb: surface restore produced no frame in time");
      finish(null);
    }, SURFACE_RESTORE_TIMEOUT_MS);
    contents.on("paint", onPaint);
    // A hidden pane sits at 1fps and has just had `startPainting` called on it, so left
    // alone the first frame could be a second away.
    try { contents.invalidate(); } catch (error) { void error; }
  });
}

/// Runs `body` with the active tab laid out at its real size, whatever the pane shows.
///
/// A visible pane already has its full surface, so this is a straight pass-through there
/// — the cost is paid only by the case that was broken. The hold is on THIS pane: one pane's
/// agent call must not restore another's surface, which would undo the collapse for every pane
/// at once rather than for the one being driven.
async function withAgentSurface(method, body, windows = soleWindows, record = currentPane()) {
  const tab = windows.win;
  if (record.visible || !agentNeedsGeometry(method) || !tab || tab.isDestroyed()) {
    return body();
  }
  holdSurface(windows, Date.now(), AGENT_SURFACE_HOLD_TTL_MS);
  const contents = tab.webContents;
  try {
    updatePaintingState();
    // Layout first, then the frame: the frame kept for `screenshot` has to come from the
    // page as the rest of the call will read it, not from the moment before it reflowed.
    await awaitRestoredLayout(contents);
    // The frame the hold restored, for a screenshot to use instead of re-asking the compositor.
    windows.agentSurfaceFrame = await awaitRestoredFrame(contents);
    return await body();
  } finally {
    // Collapse again immediately rather than waiting for the watchdog's next tick: the
    // gate #22 added is "a hidden page's surface bytes converge to 0", and converging a
    // second late is fine while converging only on the next visit is not.
    //
    // `releaseSurface` keeps the frame until the LAST hold closes, so an overlapping call —
    // `wait` polling for ten seconds while a screenshot runs — is not left holding null and
    // falling back to the capturePage that was unreliable here.
    if (releaseSurface(windows)) updatePaintingState();
  }
}


// === Audio ownership across panes ===================================================
//
// Every pane is its own Electron process, so only a shared file can arbitrate between
// them. See electron/audio-owner.cjs for why the claim is judged rather than trusted.

const audioClaimPath = path.join(runtimeDir(), "audio-owner.json");
// null while this instance is making noise; otherwise when the silence started.
let audioSilentSince = Date.now();
let audioMutedByOther = false;
let audioOwnerPane = null;
let audioTimer = null;

function readAudioClaim() {
  try {
    return parseClaim(readFileSync(audioClaimPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && debugLogging) {
      console.error(`tweb: audio claim read failed: ${error.message}`);
    }
    return null;
  }
}

// Signal 0 only checks that the pid exists, which is what separates "the owner crashed"
// from "the owner is quiet right now". Not being able to signal it (EPERM) still means
// something is there, so only ESRCH counts as gone.
function processAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function writeAudioClaim() {
  const claim = { pane: ownTmuxPane, pid: process.pid, at: Date.now() };
  const temporary = `${audioClaimPath}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(audioClaimPath), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(claim)}\n`, { mode: 0o600 });
    // Rename so a reader never sees a half-written claim and treats a live owner as gone.
    renameSync(temporary, audioClaimPath);
  } catch (error) {
    if (debugLogging) console.error(`tweb: audio claim write failed: ${error.message}`);
    try { unlinkSync(temporary); } catch (_) {}
  }
  return claim;
}

function clearAudioClaim() {
  const claim = readAudioClaim();
  // Only our own claim is ours to delete: another pane may have taken over between the
  // decision to release and this call.
  if (!heartbeatOwns(claim, process.pid)) return;
  try {
    unlinkSync(audioClaimPath);
  } catch (error) {
    if (error.code !== "ENOENT" && debugLogging) {
      console.error(`tweb: audio claim clear failed: ${error.message}`);
    }
  }
}

function anyTabAudible() {
  for (const tab of soleWindows.tabs) {
    if (tab.isDestroyed()) continue;
    // A muted tab reports itself as not audible, so the instance that gave audio up
    // would never notice it is still playing. Its own claim state answers instead.
    if (tab.webContents.audioMuted) continue;
    if (tab.webContents.isCurrentlyAudible()) return true;
  }
  return false;
}

// Mute, never pause: the page keeps playing and keeps its position, so taking audio
// back is one keypress rather than a re-seek.
function applyAudioMute(muted) {
  for (const tab of soleWindows.tabs) {
    if (!tab.isDestroyed()) tab.webContents.setAudioMuted(muted);
  }
}

function broadcastAudioState() {
  for (const tab of soleWindows.tabs) {
    sendToTabFrames(tab, "tweb-audio-state", { muted: audioMutedByOther, owner: audioOwnerPane });
  }
}

/**
 * Re-read the claim and settle this instance's audio against it.
 *
 * Runs on a timer in every instance whatever its state, not only while muted. The socket
 * nudge is best-effort, so a missed one would otherwise leave two panes playing forever;
 * with an unconditional poll, a missed nudge and a crashed owner recover the same way.
 */
function reconcileAudio({ claiming = false } = {}) {
  const now = Date.now();
  // A muted tab is not audible by definition, so this only ever reports the noise this
  // instance is actually allowed to make.
  const audible = anyTabAudible();
  // Recorded on the pane so a runtime holding several arbitrates in memory rather than through
  // the file. The file stays the boundary between *runtimes* — per-pane engines running beside a
  // host share nothing else — but panes inside one runtime do not need to publish to it and poll.
  recordAudio(currentPane(), { audible });
  if (audible) audioSilentSince = null;
  else if (audioSilentSince === null) audioSilentSince = now;

  let claim = readAudioClaim();
  const weHoldIt = heartbeatOwns(claim, process.pid);
  const vacant = !claim || claimExpired(claim, now) || !processAlive(claim.pid);

  if (claiming || (weHoldIt && audible) || (vacant && audible)) {
    // Refresh only a claim that is still ours, or take one nobody live holds. A blind
    // rewrite would stamp over another pane's reclaim and both panes would play. Two
    // panes starting together can still both write; last-write-wins and the loser learns
    // it lost on its next poll, which is the same path a missed nudge takes.
    claim = writeAudioClaim();
  } else if (weHoldIt && shouldReleaseClaim({ silentSince: audioSilentSince, now })) {
    clearAudioClaim();
    claim = null;
  }

  const decision = audioDecision({
    claim,
    selfPid: process.pid,
    now: Date.now(),
    ownerAlive: claim ? processAlive(claim.pid) : false,
  });
  if (decision.stale && claim && !decision.mine) {
    // Whoever notices first cleans up, so a crashed owner's file does not sit there
    // being re-judged by every instance on every tick.
    try { unlinkSync(audioClaimPath); } catch (_) {}
    console.error(`tweb: audio claim from pid ${claim.pid} was stale, cleared`);
  }

  const changed = decision.muted !== audioMutedByOther || decision.owner !== audioOwnerPane;
  const tookOver = decision.mine && !weHoldIt;
  audioMutedByOther = decision.muted;
  audioOwnerPane = decision.owner;
  applyAudioMute(decision.muted);
  if (changed) {
    broadcastAudioState();
    console.error(`tweb: audio ${decision.muted ? "muted" : "free"}`
      + ` (owner ${decision.owner || "none"})`);
  }
  // Only on the transition: a nudge every tick would be a poll by another name.
  if (tookOver) nudgeOtherPanes();
  return decision;
}

// Take the speakers for this pane, silencing whoever holds them.
function claimAudio() {
  audioSilentSince = null;
  return reconcileAudio({ claiming: true });
}

// Tell the other panes to re-read the claim now rather than on their next tick. Purely a
// latency optimisation — nothing is retried and no failure is reported, because the poll
// already covers every case this could miss.
function nudgeOtherPanes() {
  let entries;
  try {
    entries = readdirSync(runtimeDir());
  } catch (_) {
    return;
  }
  const ours = path.basename(agentServer?.path || "");
  for (const entry of entries) {
    if (!entry.startsWith("agent-") || !entry.endsWith(".sock") || entry === ours) continue;
    const socket = net.connect(path.join(runtimeDir(), entry), () => {
      socket.end(`${JSON.stringify({ id: 0, method: "audio-sync", params: {} })}\n`);
    });
    socket.setTimeout(500, () => socket.destroy());
    socket.on("error", () => socket.destroy());
  }
}

function startAudioCoordination() {
  reconcileAudio();
  audioTimer = setInterval(() => reconcileAudio(), AUDIO_HEARTBEAT_MS);
  audioTimer.unref();
}

function installPageEnhancements(tab = soleWindows.win) {
  if (!tab || tab.isDestroyed()) return;
  void tab.webContents.executeJavaScript(`(() => {
    document.getElementById('__tweb_status__')?.remove();
    let style = document.getElementById('__tweb_caret_style__');
    if (!style) {
      style = document.createElement('style');
      style.id = '__tweb_caret_style__';
      style.textContent = 'input,textarea,[contenteditable]:focus{caret-color:#00e5ff!important}';
      (document.head || document.documentElement).append(style);
    }

    if (!window.__twebCaretInstalled) {
      window.__twebCaretInstalled = true;
      const caret = document.createElement('div');
      caret.id = '__tweb_caret__';
      caret.style.cssText = 'display:none;position:fixed;z-index:2147483646;width:2px;pointer-events:none;background:#00e5ff;box-shadow:0 0 3px #001bff,0 0 1px #fff';
      document.documentElement.append(caret);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      const textInput = (element) => element instanceof HTMLInputElement && !['checkbox','radio','button','submit','reset','file','range','color'].includes(element.type);
      const updateCaret = () => {
        const element = document.activeElement;
        if (!element || (!textInput(element) && !(element instanceof HTMLTextAreaElement) && !element.isContentEditable)) {
          caret.style.display = 'none';
          return;
        }
        const box = element.getBoundingClientRect();
        const computed = getComputedStyle(element);
        let x = box.left + parseFloat(computed.paddingLeft || 0) + 1;
        let y = box.top + parseFloat(computed.paddingTop || 0) + 1;
        let height = Math.max(12, parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.25 || 16);
        if (textInput(element)) {
          context.font = computed.font;
          const before = element.value.slice(0, element.selectionStart ?? element.value.length);
          x += context.measureText(before).width - element.scrollLeft;
          y = box.top + Math.max(1, (box.height - height) / 2);
        } else if (element instanceof HTMLTextAreaElement) {
          const mirror = document.createElement('div');
          const properties = ['font','letterSpacing','lineHeight','padding','border','boxSizing','whiteSpace','wordBreak','overflowWrap','width'];
          mirror.style.cssText = 'position:fixed;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;top:' + box.top + 'px;left:' + box.left + 'px';
          for (const property of properties) mirror.style[property] = computed[property];
          mirror.textContent = element.value.slice(0, element.selectionStart ?? 0);
          const marker = document.createElement('span');
          marker.textContent = '\\u200b';
          mirror.append(marker);
          document.documentElement.append(mirror);
          const markerBox = marker.getBoundingClientRect();
          x = markerBox.left - element.scrollLeft;
          y = markerBox.top - element.scrollTop;
          mirror.remove();
        } else {
          const selection = getSelection();
          if (selection && selection.rangeCount) {
            const range = selection.getRangeAt(0).cloneRange();
            range.collapse(true);
            const rangeBox = range.getBoundingClientRect();
            if (rangeBox.left || rangeBox.top) {
              x = rangeBox.left;
              y = rangeBox.top;
              height = rangeBox.height || height;
            }
          }
        }
        caret.style.cssText += '';
        caret.style.display = 'block';
        caret.style.left = Math.max(0, x) + 'px';
        caret.style.top = Math.max(0, y) + 'px';
        caret.style.height = Math.min(box.height || height, height) + 'px';
      };
      for (const event of ['focusin','focusout','input','keyup','click','selectionchange']) {
        document.addEventListener(event, updateCaret, true);
      }
      document.addEventListener('scroll', updateCaret, true);
      window.addEventListener('resize', updateCaret);
      window.setInterval(updateCaret, 500);
      updateCaret();
    }
  })()`, true).catch((error) => {
    if (debugLogging) console.error(`tweb: page enhancements failed: ${error.message}`);
  });
}

function frameKey(frame) {
  return `${frame.processId}:${frame.frameToken}`;
}

function readyFrameKeys(tab) {
  let keys = readyFrameKeysByTab.get(tab);
  if (!keys) {
    keys = new Set();
    readyFrameKeysByTab.set(tab, keys);
  }
  return keys;
}

// Frames whose preload actually handles shortcuts. Cross-origin subframes load
// the preload but bail out of every handler, so keys sent there disappear.
const shortcutFrameKeysByTab = new WeakMap();

function shortcutFrameKeys(tab) {
  let keys = shortcutFrameKeysByTab.get(tab);
  if (!keys) {
    keys = new Set();
    shortcutFrameKeysByTab.set(tab, keys);
  }
  return keys;
}

function sendToTabFrames(tab, channel, ...args) {
  if (!tab || tab.isDestroyed()) return;
  const readyKeys = readyFrameKeys(tab);
  try {
    const mainFrame = tab.webContents.mainFrame;
    const frames = new Set([mainFrame, ...(mainFrame?.framesInSubtree || [])].filter(Boolean));
    const liveKeys = new Set();
    for (const frame of frames) {
      if (frame.isDestroyed() || frame.detached) continue;
      const key = frameKey(frame);
      liveKeys.add(key);
      if (readyKeys.has(key)) frame.send(channel, ...args);
    }
    // Both maps are keyed by frame, so both go stale the same way — but only the ready set
    // was ever pruned. A tab whose ad or embed iframes reload keeps one dead
    // "processId:frameToken" per navigation forever, and `diag` reports that count as
    // `shortcutFrames`, so the diagnostic reads high for a tab with one live frame.
    const shortcutKeys = shortcutFrameKeys(tab);
    for (const key of readyKeys) {
      if (!liveKeys.has(key)) readyKeys.delete(key);
    }
    for (const key of shortcutKeys) {
      if (!liveKeys.has(key)) shortcutKeys.delete(key);
    }
  } catch (error) {
    if (debugLogging) console.error(`tweb: frame broadcast failed: ${error.message}`);
  }
}

function sendToMainTabFrame(tab, channel, ...args) {
  if (!tab || tab.isDestroyed()) return;
  try {
    const frame = tab.webContents.mainFrame;
    if (frame && !frame.isDestroyed() && !frame.detached
      && readyFrameKeys(tab).has(frameKey(frame))) frame.send(channel, ...args);
  } catch (error) {
    if (debugLogging) console.error(`tweb: main frame send failed: ${error.message}`);
  }
}

function sendToFocusedTabFrame(tab, channel, ...args) {
  if (!tab || tab.isDestroyed()) return;
  try {
    const contents = tab.webContents;
    const focused = contents.focusedFrame;
    let frame = focused && !focused.isDestroyed() && !focused.detached
      ? focused
      : contents.mainFrame;
    // Clicking an ad or embed moves focus into a cross-origin subframe, whose
    // preload ignores every shortcut. Without this fall-back the keys would
    // simply stop working until focus happened to return to the main frame.
    if (frame && !shortcutFrameKeys(tab).has(frameKey(frame))) frame = contents.mainFrame;
    const deliverable = frame && readyFrameKeys(tab).has(frameKey(frame));
    if (debugLogging && !deliverable) {
      console.error(`tweb: dropped ${channel}; shortcut frames=${shortcutFrameKeys(tab).size}`
        + ` ready=${readyFrameKeys(tab).size}`);
    }
    if (deliverable) frame.send(channel, ...args);
  } catch (error) {
    if (debugLogging) console.error(`tweb: focused frame send failed: ${error.message}`);
  }
}

// The preload receives the two flags separately and drives the mode indicator and
// each gate independently.
function broadcastShortcutMode() {
  for (const tab of soleWindows.tabs) {
    sendToTabFrames(tab, "tweb-shortcuts-mode", { vimium: vimiumShortcutsEnabled, bypass: cmdBypassEnabled });
  }
}

// Applies the correct combination of the two flags and runs the follow-up work once.
function applyShortcutMode() {
  pageInsertMode = false;
  broadcastShortcutMode();
  // Once passthrough is armed (vimium off), focus so the page can receive keys.
  if (!vimiumShortcutsEnabled && soleWindows.win && !soleWindows.win.isDestroyed()) soleWindows.win.webContents.focus();
  // A Ghostty config reload or a pane restart can reset one side only, so reconcile
  // always runs even when the value already matches.
  reconcileTmuxPassthrough();
  updatePaneTitle();
  // The mode belongs to this pane, so it is reported by this pane's in-page indicator.
  // It used to also flash `tmux display-message`, which writes to the status line the
  // whole session shares — one pane's mode change interrupting every other pane.
  if (debugLogging) {
    console.error(`tweb: mode ${modeLabel()}`
      + ` (vimium=${vimiumShortcutsEnabled} bypass=${cmdBypassEnabled})`);
  }
}

function modeLabel() {
  const v = vimiumShortcutsEnabled;
  const b = cmdBypassEnabled;
  if (v && !b) return "bypass OFF";
  if (!v && b) return "web bypass ON";
  if (v && b) return "shortcuts and bypass ON";
  return "web only ON";
}

function setCmdBypassEnabled(enabled) {
  cmdBypassEnabled = enabled;
  applyShortcutMode();
}

function setVimiumShortcutsEnabled(enabled) {
  vimiumShortcutsEnabled = enabled;
  applyShortcutMode();
}

// 5001 (Ctrl-;) and the legacy forcing sequences toggle or set bypass only.
function setBrowserShortcutsEnabled(enabled) {
  setCmdBypassEnabled(enabled);
}

function toggleBrowserShortcuts() {
  setCmdBypassEnabled(!cmdBypassEnabled);
}

function activateTab(index) {
  if (soleWindows.tabs.length === 0) {
    soleWindows.win = null;
    soleWindows.activeTabIndex = -1;
    return;
  }
  const normalized = ((index % soleWindows.tabs.length) + soleWindows.tabs.length) % soleWindows.tabs.length;
  soleWindows.activeTabIndex = normalized;
  soleWindows.win = soleWindows.tabs[normalized];
  mouseClicks.reset();
  pageInsertMode = false;
  // The preload mirrors this flag and skips redundant IPC, so tell the tab we
  // just cleared it. Without this its focused input keeps thinking native
  // delivery is armed and its keys go back through the renderer, where they
  // arrive with keyCode 0.
  sendToTabFrames(soleWindows.win, "tweb-shortcuts-mode", { vimium: vimiumShortcutsEnabled, bypass: cmdBypassEnabled });
  // The other tab's caret says nothing about this one, and its preload only
  // reports on focus — which switching soleWindows.tabs does not fire.
  moveTerminalCaret(null);
  // Zoom is shared per origin in Chromium, so a sibling tab on the same host can
  // have moved it. Only the active tab is ever painted, so restoring this tab's
  // own factor on activation is what makes zoom look per-tab.
  const zoomFactor = tabZoomFactors.get(soleWindows.win) ?? defaultZoomFactor;
  if (!soleWindows.win.isDestroyed() && soleWindows.win.webContents.getZoomFactor() !== zoomFactor) {
    soleWindows.win.webContents.setZoomFactor(zoomFactor);
  }
  // Cell size in CSS pixels depends on the zoom just restored.
  broadcastCellMetrics();
  // Do not delete the current image first: the next frame reuses the same image
  // id and replaces it in place. Deleting would uncover the bare terminal until
  // the new tab paints, which reads as a flicker on every switch.
  updatePaintingState();
  soleWindows.win.webContents.invalidate();
  updatePaneTitle();
  sendTabState();
  scheduleWindowSessionSave();
  if (debugLogging) console.error(`tweb: tab active ${tabLabel(soleWindows.win, normalized)}`);
}

function cycleTab(direction) {
  if (soleWindows.tabs.length > 1) activateTab(soleWindows.activeTabIndex + direction);
}

function closeTab(index = soleWindows.activeTabIndex) {
  const tab = soleWindows.tabs[index];
  if (!tab || tab.isDestroyed()) return;
  const url = tab.webContents.getURL();
  if (isRestorableUrl(url)) {
    soleWindows.closedTabs.push(url);
    if (soleWindows.closedTabs.length > 25) soleWindows.closedTabs.shift();
  }
  if (soleWindows.tabs.length === 1) {
    app.quit();
    return;
  }
  tab.close();
}

function restoreClosedTab() {
  const url = soleWindows.closedTabs.pop();
  if (url) createTab(url, true);
}

function normalizeOmniboxInput(input) {
  const value = String(input || "").trim();
  if (!value) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|about:|data:|file:)/i.test(value)) return value;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(value)) return `http://${value}`;
  if (!/\s/.test(value) && (/^[^/]+\.[^/]+(?:\/|$)/.test(value) || /^[^/]+:\d+(?:\/|$)/.test(value))) {
    return `https://${value}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

// History is shared by every pane and survives restarts, so the omnibox offers
// what the user visited anywhere — not just what this process happened to see.
// Append-only keeps concurrent panes from clobbering each other's writes.
const historyLimit = 200;
let lastHistoryAppend = { url: "", title: "" };
// Compaction reads and rewrites the whole file, so it is not free — but it is cheap next to
// how often visits happen, and letting the file grow all session was the actual bug.
const COMPACT_EVERY_APPENDS = 50;
let appendsSinceCompaction = 0;

function historyPath() {
  return path.join(app.getPath("userData"), "history.jsonl");
}

// Every pane shares this file, so appends and rewrites take the same lock. See
// history-lock.cjs for why carrying arrivals across the rewrite is not enough on its own.
function historyLockPath() {
  return `${historyPath()}.lock`;
}

function recordNavigationHistory(url, title = "") {
  if (!isRestorableUrl(url) || url.startsWith("tweb-action:")) return;
  const existing = navigationHistory.findIndex((entry) => entry.url === url);
  if (existing >= 0) navigationHistory.splice(existing, 1);
  navigationHistory.unshift({ url, title: String(title || url), recency: ++navigationSerial });
  if (navigationHistory.length > historyLimit) navigationHistory.length = historyLimit;

  // Pages retitle themselves constantly (counters, players, SPA routes). Append
  // once per visit, plus once more when a real title replaces the placeholder.
  const entryTitle = String(title || url);
  const repeat = url === lastHistoryAppend.url;
  const titleArrived = repeat
    && entryTitle !== lastHistoryAppend.title
    && lastHistoryAppend.title === lastHistoryAppend.url;
  if (repeat && !titleArrived) return;
  lastHistoryAppend = { url, title: entryTitle };

  try {
    const line = `${JSON.stringify({ url, title: entryTitle, at: Date.now() })}\n`;
    mkdirSync(path.dirname(historyPath()), { recursive: true });
    // Under the lock, so an append cannot resolve the pre-rename inode of a concurrent
    // compaction or delete and vanish with it.
    withHistoryLock(historyLockPath(), () => {
      appendFileSync(historyPath(), line, { encoding: "utf8", mode: 0o600 });
    });
  } catch (error) {
    if (debugLogging) console.error(`tweb: history append failed: ${error.message}`);
  }
  appendsSinceCompaction += 1;
  // Compaction used to run only at startup, so a long-lived pane grew its history file for
  // as long as it stayed open and only ever shrank it on the next launch. Checking here
  // costs one counter until the threshold, and the check inside compactHistory is what
  // decides whether a rewrite is actually warranted.
  if (appendsSinceCompaction >= COMPACT_EVERY_APPENDS) {
    appendsSinceCompaction = 0;
    compactHistory();
  }
}

/// Most recent first, one entry per URL.
function readGlobalHistory(limit = historyLimit) {
  let lines;
  try {
    lines = readFileSync(historyPath(), "utf8").split("\n");
  } catch (error) {
    if (error.code !== "ENOENT" && debugLogging) {
      console.error(`tweb: history read failed: ${error.message}`);
    }
    // Fall back to what this process has seen.
    return navigationHistory.map((entry) => ({ url: entry.url, title: entry.title }));
  }
  const seen = new Map();
  for (let index = lines.length - 1; index >= 0 && seen.size < limit; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (isRestorableUrl(entry?.url) && !seen.has(entry.url)) {
        seen.set(entry.url, { url: entry.url, title: entry.title || entry.url });
      }
    } catch (_) {
      // A torn line from a concurrent append; skip it.
    }
  }
  return [...seen.values()];
}

/// Every line, timestamps intact — what the history page needs and readGlobalHistory drops.
function readHistoryEntries() {
  try {
    return parseHistoryLines(readFileSync(historyPath(), "utf8").split("\n"));
  } catch (error) {
    if (error.code !== "ENOENT" && debugLogging) {
      console.error(`tweb: history read failed: ${error.message}`);
    }
    return [];
  }
}

// The file is small enough (hundreds of lines) that re-reading it per keystroke costs
// nothing, and skipping a cache means a delete can never leave a stale view behind.
function historyPageModel(query = "") {
  const model = historyDays(readHistoryEntries(), { query: String(query || "") });
  return { ...model, query: String(query || "") };
}

// Deleting rewrites the file, which races every other pane's appendFileSync: a visit
// recorded between the read and the rename would be silently lost. compactHistory has the
// same shape but fires once at startup; this fires whenever the user presses a key, so the
// window is far easier to hit. Re-read just before the rename and carry across whatever
// arrived, and back out entirely if another pane rewrote the file underneath us.
function deleteHistoryEntries(targets, query = "") {
  const rows = (Array.isArray(targets) ? targets : []).filter(
    (target) => target?.url && Number.isFinite(Number(target.dayStart)),
  );
  if (rows.length === 0) return historyPageModel(query);
  try {
    withHistoryLock(historyLockPath(), () => {
      const before = readFileSync(historyPath(), "utf8");
      const { lines: kept, removed } = removeEntries(before.split("\n"), rows);
      if (removed === 0) return;
      const { diverged, lines: arrived } = appendedSince(before, readFileSync(historyPath(), "utf8"));
      if (diverged) {
        if (debugLogging) console.error("tweb: history delete skipped; the file was rewritten underneath");
        return;
      }
      // A concurrent append can land on a row being deleted, so it is filtered too —
      // otherwise the row would reappear the moment the model was rebuilt.
      const carried = removeEntries(arrived, rows).lines;
      const final = [...kept, ...carried];
      const temporary = `${historyPath()}.${process.pid}.tmp`;
      writeFileSync(temporary, final.length ? `${final.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, historyPath());
      // The in-process omnibox list mirrors the file; leaving it would offer a URL the
      // user just deleted for the rest of this session.
      for (const row of rows) {
        const stale = navigationHistory.findIndex((entry) => entry.url === row.url);
        if (stale >= 0) navigationHistory.splice(stale, 1);
      }
      if (rows.some((row) => row.url === lastHistoryAppend.url)) lastHistoryAppend = { url: "", title: "" };
    });
  } catch (error) {
    if (error.code !== "ENOENT" && debugLogging) {
      console.error(`tweb: history delete failed: ${error.message}`);
    }
  }
  return historyPageModel(query);
}

// Compaction used to keep "the last N lines", which is the wrong unit: the file is
// append-per-visit, so a user who revisits the same pages loses history fastest. Measured
// on a real file, 824 lines held 267 distinct URLs and a 600-line trim would have kept 182
// of them. `compactLines` keeps the newest visit per URL instead.
//
// The rewrite races every other pane's appendFileSync — anything landing between the read
// and the rename goes to the old inode and dies there. So the file is re-read immediately
// before the rename and any arrivals are carried across, and if another pane rewrote it in
// the meantime this backs out entirely rather than clobbering that pane's work. Same shape
// as `deleteHistoryEntries`, which faces the identical race on a much shorter fuse.
function compactHistory() {
  try {
    withHistoryLock(historyLockPath(), () => {
      const before = readFileSync(historyPath(), "utf8");
      const compacted = compactLines(before.split("\n"));
      if (!compacted) return;
      const arrived = appendedSince(before, readFileSync(historyPath(), "utf8"));
      if (arrived.diverged) return;
      const body = [...compacted, ...arrived.lines];
      const temporary = `${historyPath()}.${process.pid}.tmp`;
      writeFileSync(temporary, `${body.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, historyPath());
      if (debugLogging) {
        const was = before.split("\n").filter((line) => line.trim()).length;
        console.error(`tweb: history compacted ${was} -> ${body.length} lines`);
      }
    });
  } catch (error) {
    if (error.code !== "ENOENT" && debugLogging) {
      console.error(`tweb: history compaction failed: ${error.message}`);
    }
  }
}

function omniboxModel() {
  const history = readGlobalHistory();
  // Open soleWindows.tabs always outrank history entries.
  const base = history.length;
  const tabEntries = soleWindows.tabs.flatMap((candidate, index) => {
    if (candidate.isDestroyed()) return [];
    const url = tabSessionUrls.get(candidate) || candidate.webContents.getURL() || "about:blank";
    return [{
      kind: "tab",
      index,
      url,
      title: candidate.webContents.getTitle() || url,
      recency: base + soleWindows.tabs.length - index,
    }];
  });
  return {
    current: soleWindows.win && !soleWindows.win.isDestroyed() ? tabSessionUrls.get(soleWindows.win) || soleWindows.win.webContents.getURL() || "" : "",
    entries: [
      ...tabEntries,
      ...history.map((entry, index) => ({ ...entry, kind: "history", recency: base - index })),
    ],
  };
}

function tabListModel() {
  return {
    activeIndex: soleWindows.activeTabIndex,
    tabs: soleWindows.tabs.map((candidate, index) => ({
      index,
      title: candidate.webContents.getTitle() || "New tab",
      url: candidate.webContents.getURL() || "about:blank",
    })),
  };
}

function tabStateModel() {
  return {
    activeIndex: soleWindows.activeTabIndex,
    count: soleWindows.tabs.length,
    tabs: soleWindows.tabs.flatMap((candidate, index) => candidate.isDestroyed() ? [] : [{
      index,
      title: candidate.webContents.getTitle() || candidate.webContents.getURL() || "New tab",
    }]),
  };
}

function sendTabState(tab = soleWindows.win) {
  sendToMainTabFrame(tab, "tweb-tab-state", tabStateModel());
}

function handleNativeShortcut(tab, action, value, sourceFrame = null) {
  if (!vimiumShortcutsEnabled || tab !== soleWindows.win || tab.isDestroyed()) return;
  if (debugLogging) console.error(`tweb: native shortcut ${action}`);
  const contents = tab.webContents;
  switch (action) {
    case "history-back":
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      break;
    case "history-forward":
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      break;
    case "previous-tab": cycleTab(-1); break;
    case "next-tab": cycleTab(1); break;
    case "list-soleWindows.tabs":
      sendToTabFrames(tab, "tweb-soleWindows.tabs", tabListModel());
      break;
    case "omnibox-model":
      sendToFocusedTabFrame(tab, "tweb-omnibox", omniboxModel());
      break;
    // The page re-asks on every keystroke so the filter runs over the whole file rather
    // than over a slice the renderer happens to be holding.
    case "history-model":
      sendToFocusedTabFrame(tab, "tweb-history", historyPageModel(value?.query));
      break;
    case "history-delete":
      sendToFocusedTabFrame(tab, "tweb-history", deleteHistoryEntries(value?.rows, value?.query));
      break;
    case "activate-tab":
      if (Number.isInteger(value) && value >= 0 && value < soleWindows.tabs.length) activateTab(value);
      break;
    // The tab list closes a specific row; the bare shortcut closes the active tab.
    case "close-tab":
      // Closing from the list keeps it open, so it has to be redrawn — but only
      // then: sending the model unprompted would pop the list open.
      refreshTabListAfterClose = Number.isInteger(value);
      closeTab(Number.isInteger(value) ? value : soleWindows.activeTabIndex);
      break;
    case "restore-tab": restoreClosedTab(); break;
    case "reload": contents.reload(); break;
    case "zoom-in": setBrowserZoom("in"); break;
    case "zoom-out": setBrowserZoom("out"); break;
    case "zoom-reset": setBrowserZoom("reset"); break;
    case "find": {
      const query = String(value?.query || "");
      if (query) {
        contents.findInPage(query, {
          forward: value?.forward !== false,
          findNext: Boolean(value?.findNext),
        });
      }
      break;
    }
    case "stop-find":
      contents.stopFindInPage(["clearSelection", "keepSelection", "activateSelection"].includes(value) ? value : "clearSelection");
      break;
    case "copy-text":
      clipboard.writeText(String(value || ""));
      break;
    // The address the tab actually settled on, which the page cannot always see:
    // a subframe reports its own URL, and a cross-origin one cannot read the top.
    case "copy-url":
      clipboard.writeText(contents.getURL());
      break;
    case "copy-image":
      if ([value?.x, value?.y, value?.width, value?.height].every(Number.isFinite)) {
        const rect = {
          x: Math.max(0, Math.round(value.x)),
          y: Math.max(0, Math.round(value.y)),
          width: Math.max(1, Math.round(value.width)),
          height: Math.max(1, Math.round(value.height)),
        };
        // Let the renderer remove its visual outline before capturing the
        // rendered image region. This works for img, canvas, SVG and video in
        // offscreen Chromium, where copyImageAt may not update the pasteboard.
        setTimeout(() => {
          void contents.capturePage(rect).then((image) => {
            if (!image.isEmpty()) clipboard.writeImage(nativeImage.createFromBuffer(image.toPNG()));
          }).catch((error) => {
            if (debugLogging) console.error(`tweb: image copy failed: ${error.message}`);
          });
        }, 0);
      }
      break;
    case "download":
      downloadUrl(contents, value);
      break;
    case "paste":
      contents.paste();
      break;
    case "context-menu-command":
      runBrowserContextMenuCommand(tab, value);
      break;
    case "context-menu-dismiss":
      contextMenuStateByTab.delete(tab);
      break;
    case "caret": {
      // Every same-origin frame runs this preload. A frame that just lost focus can
      // report after the new focused frame and otherwise move the shared terminal
      // cursor back to stale coordinates (or hide it). Only the frame Chromium says
      // owns focus may control the one terminal cursor.
      const focused = contents.focusedFrame;
      if (sourceFrame && focused && frameKey(sourceFrame) !== frameKey(focused)) break;
      moveTerminalCaret(value);
      break;
    }
    case "insert-mode":
      pageInsertMode = Boolean(value);
      break;
    // Take the speakers back from whichever pane holds them. Only ever a deliberate
    // keypress: a page starting playback in a muted pane does not get to do this.
    case "reclaim-audio":
      claimAudio();
      break;
    // An overlay just went up. Painting is driven by Chromium's frame clock, so
    // without a nudge the hints would wait for the next tick to reach the pane.
    case "repaint":
      markInteractionActivity();
      contents.invalidate();
      break;
    // In shortcuts mode keys reach the page as synthetic events, which sites
    // that gate on isTrusted ignore. A page-level Escape has to be real.
    case "native-escape":
      dispatchNativeKey(contents, "Escape", "", [], 1);
      break;
    case "native-hover":
      if ([value?.x, value?.y].every(Number.isFinite)) {
        const { x, y } = pageToWindowPoint(contents, value);
        contents.sendInputEvent({ type: "mouseMove", x, y });
      }
      break;
    case "native-click":
      if ([value?.x, value?.y].every(Number.isFinite)) {
        const { x, y } = pageToWindowPoint(contents, value);
        contents.sendInputEvent({ type: "mouseMove", x, y });
        contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      }
      break;
    case "native-drag": {
      const from = value?.from;
      const to = value?.to;
      if (![from?.x, from?.y, to?.x, to?.y].every(Number.isFinite)) break;
      const start = pageToWindowPoint(contents, from);
      const end = pageToWindowPoint(contents, to);
      contents.sendInputEvent({ type: "mouseMove", ...start });
      contents.sendInputEvent({ type: "mouseDown", ...start, button: "left", clickCount: 1 });
      for (const ratio of [0.34, 0.67, 1]) {
        contents.sendInputEvent({
          type: "mouseMove",
          x: Math.round(start.x + (end.x - start.x) * ratio),
          y: Math.round(start.y + (end.y - start.y) * ratio),
          button: "left",
        });
      }
      contents.sendInputEvent({ type: "mouseUp", ...end, button: "left", clickCount: 1 });
      break;
    }
    case "frame-mode":
      sendToTabFrames(tab, "tweb-frame-mode", value);
      break;
    case "navigate": {
      const url = normalizeOmniboxInput(value);
      if (url) void contents.loadURL(url);
      break;
    }
    case "new-tab": {
      const url = normalizeOmniboxInput(value);
      if (url) createTab(url, true);
      break;
    }
  }
}

ipcMain.on("tweb-preload-ready", (event, info) => {
  const tab = BrowserWindow.fromWebContents(event.sender);
  const frame = event.senderFrame;
  if (!tab || !frame || frame.isDestroyed() || frame.detached) return;
  // A fresh document starts in normal mode, so the mirror has to follow.
  if (frame === tab.webContents.mainFrame) pageInsertMode = false;
  const key = frameKey(frame);
  if (info?.shortcutFrame) shortcutFrameKeys(tab).add(key);
  else shortcutFrameKeys(tab).delete(key);
  readyFrameKeys(tab).add(frameKey(frame));
  event.reply("tweb-shortcuts-mode", { vimium: vimiumShortcutsEnabled, bypass: cmdBypassEnabled });
  if (tab === soleWindows.win && frame === tab.webContents.mainFrame) {
    event.reply("tweb-cell-metrics", cellMetrics());
    event.reply("tweb-tab-state", tabStateModel());
  }
});

ipcMain.on("tweb-shortcut", (event, message) => {
  if (!message || typeof message.action !== "string") return;
  const tab = soleWindows.tabs.find((candidate) => !candidate.isDestroyed() && candidate.webContents.id === event.sender.id);
  if (!tab) return;
  handleNativeShortcut(tab, message.action, message.value, event.senderFrame);
});

// --- agent bridge ---

const agentPending = new Map();
let agentRequestSerial = 0;
// Console output is the first thing an agent debugging a frontend asks for, and
// it is gone by the time it thinks to ask, so keep a bounded rolling buffer.
const consoleLog = [];
const consoleLogLimit = 500;

function recordConsoleMessage(entry) {
  consoleLog.push({ ...entry, at: new Date().toISOString() });
  if (consoleLog.length > consoleLogLimit) consoleLog.splice(0, consoleLog.length - consoleLogLimit);
}

function watchConsole(contents) {
  contents.on("console-message", (...args) => {
    // Electron ≥ 36 passes a single event object; older builds pass positionals.
    const [first, level, message, line, sourceId] = args;
    const detail = typeof first === "object" && first !== null && "message" in first
      ? { level: first.level, message: first.message, line: first.lineNumber, source: first.sourceId }
      : { level, message, line, source: sourceId };
    const numericLevels = ["debug", "info", "warning", "error"];
    recordConsoleMessage({
      level: typeof detail.level === "number"
        ? numericLevels[detail.level] || "info"
        : String(detail.level ?? "info"),
      message: String(detail.message ?? ""),
      line: detail.line,
      source: detail.source,
      url: contents.getURL(),
    });
  });
}

ipcMain.on("tweb-agent-response", (_event, response) => {
  const settle = agentPending.get(response?.id);
  if (!settle) return;
  agentPending.delete(response.id);
  clearTimeout(settle.timer);
  if (response.error) settle.reject(new Error(response.error));
  else settle.resolve(response.result);
});

// Ask the active page's top frame to run an agent method.
function agentPageRequest(method, params, timeoutMs = 10000) {
  const tab = soleWindows.win;
  if (!tab || tab.isDestroyed()) throw new Error("no active tab");
  const id = ++agentRequestSerial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      agentPending.delete(id);
      reject(new Error(`page did not answer ${method} within ${timeoutMs}ms`));
    }, timeoutMs);
    agentPending.set(id, { resolve, reject, timer });
    sendToFocusedTabFrame(tab, "tweb-agent-request", { id, method, params });
  });
}

function agentDiagnostics() {
  const tab = soleWindows.win && !soleWindows.win.isDestroyed() ? soleWindows.win : null;
  const size = tab ? tab.getContentSize() : null;
  const frame = tab ? tabFrames.get(tab)?.image?.getSize() : null;
  return {
    pane: ownTmuxPane,
    pid: process.pid,
    engineApp: __dirname,
    pane_geometry: {
      cells: currentFrames().cells,
      pixels: currentFrames().viewport ? { width: currentFrames().viewport.width, height: currentFrames().viewport.height } : null,
      origin: currentFrames().origin,
      logical: currentFrames().viewport ? logicalContentSize(currentFrames().viewport) : null,
      scaleFactor: renderScaleFactor(),
    },
    window: {
      contentSize: size ? { width: size[0], height: size[1] } : null,
      zoomFactor: tab ? tab.webContents.getZoomFactor() : null,
      defaultZoomFactor,
      visible: tab ? tab.isVisible() : null,
    },
    frames: {
      generation: currentFrames().generation,
      lastSentMsAgo: currentFrames().lastFrameSentAt ? Date.now() - currentFrames().lastFrameSentAt : null,
      lastSize: frame ? { width: frame.width, height: frame.height } : null,
      // A frame whose size does not match the pane is dropped, which is what a
      // pane that stopped following a resize looks like.
      expected: currentFrames().viewport ? renderedFrameSize(currentFrames().viewport) : null,
      rate: soleWindows.activeFrameRate,
      adaptive: adaptiveFrameRate,
      // All three resolved rates, not just the one in force. The startup banner was the
      // only place they were stated together, and it wrote into tmux's shared status line.
      tiers: { idle: idleFrameRate, playback: playbackFrameRate, max: maxActiveFrameRate },
      // Which of the three adaptive rates is in force. `playback` means the page is
      // painting on its own — a video, an animation — which is what separates "the pane
      // is throttled" from "the page has nothing new to show".
      rateKind: !adaptiveFrameRate ? "fixed"
        : soleWindows.activeFrameRate >= maxActiveFrameRate ? "active"
          : soleWindows.activeFrameRate >= playbackFrameRate ? "playback" : "idle",
      droppedByBackpressure: currentFrames().droppedGfxFrames,
      imageId: currentFrames().imageIds.base,
      // How the damage split between the two paths. A pane that feels slow while typing
      // but shows `patches` climbing is slow somewhere other than the frame pipeline;
      // one stuck at 0 during typing means the damage never qualified for a patch.
      whole: currentPane().frames.whole,
      patches: currentPane().frames.patches,
      patchesPlaced: currentFrames().livePatchIds.length,
      // Whether whole frames go out as raw pixels or PNG. Raw skips an encode that cost the
      // main thread 28–101ms; PNG is the fallback when frames are not going through files.
      wholeFormat: rawFramesEnabled ? "raw" : "png",
    },
    input: {
      vimiumShortcuts: vimiumShortcutsEnabled,
      cmdBypass: cmdBypassEnabled,
      pageInsertMode,
      terminalVisible: currentPane().visible,
      // Whether visibility is coming from the frontend's push or the no-frontend
      // polling fallback, and how stale the last push is. A pane that reads hidden
      // while showing "poll" is a frontend that never pushed, not a tmux problem.
      visibilitySource,
      visibilityPushAgeMs: lastVisibilityPushAt === null ? null : Date.now() - lastVisibilityPushAt,
      visibleClientTtys: [...visibleClientTtys],
      tmuxPlacement,
      shortcutFrames: tab ? shortcutFrameKeys(tab).size : 0,
      // Where IME preedit will land. Comparing cell against point is the only way
      // to tell "caret parked on the wrong line" from "page never reported one".
      caret: { cell: caretCell, point: lastCaretPoint },
    },
    tabs: { active: soleWindows.activeTabIndex, count: soleWindows.tabs.length },
    // Which pane owns the speakers, and whether this one is making noise. `audible` is
    // read live rather than cached because Chromium is the only thing that knows, and
    // "muted but still playing" is exactly the state this feature has to produce.
    audio: {
      owner: audioOwnerPane,
      mutedByOther: audioMutedByOther,
      muted: tab ? tab.webContents.audioMuted : null,
      audible: tab ? tab.webContents.isCurrentlyAudible() : null,
      claimPath: audioClaimPath,
    },
  };
}

function agentContents() {
  if (!soleWindows.win || soleWindows.win.isDestroyed()) throw new Error("no active tab");
  return soleWindows.win.webContents;
}

function agentNativeClick(point) {
  const contents = agentContents();
  const { x, y } = pageToWindowPoint(contents, point);
  contents.sendInputEvent({ type: "mouseMove", x, y });
  contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
}

// The rules live in electron/agent-key.cjs, next to the cases that were measured against
// the real key path. This path had drifted from `dispatchNativeKey`: a shifted letter and
// Space typed nothing, and an arrow key reached the page as key="" because Chromium wants
// the Accelerator name.
function agentPressKey(key, modifiers = []) {
  const contents = agentContents();
  for (const event of pressEvents(key, modifiers)) contents.sendInputEvent(event);
}

async function agentWaitFor(params) {
  const deadline = Date.now() + (params.timeout ?? 10000);
  const interval = 100;
  for (;;) {
    if (params.ms !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, Number(params.ms)));
      return { waited: Number(params.ms) };
    }
    const info = await agentPageRequest("info", {});
    if (params.url && info.url.includes(params.url)) return info;
    if (params.load && info.readyState === "complete") return info;
    if (params.selector) {
      try {
        return await agentPageRequest("query", { selector: params.selector });
      } catch (_) {}
    }
    if (params.text) {
      const found = await agentContents().executeJavaScript(
        `document.body?.innerText?.includes(${JSON.stringify(params.text)}) || false`, true);
      if (found) return info;
    }
    if (Date.now() > deadline) {
      throw new Error(`wait timed out after ${params.timeout ?? 10000}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function agentTabList() {
  return {
    active: soleWindows.activeTabIndex,
    tabs: soleWindows.tabs.map((tab, index) => ({
      index,
      title: tab.isDestroyed() ? "" : tab.webContents.getTitle(),
      url: tab.isDestroyed() ? "" : tab.webContents.getURL(),
      active: index === soleWindows.activeTabIndex,
    })),
  };
}

async function agentScreenshot(params) {
  const contents = agentContents();
  // On a hidden pane the hold has already collected a frame at the restored size, and
  // going back to the compositor for a second copy of it is what failed intermittently.
  const image = soleWindows.agentSurfaceFrame || await contents.capturePage();
  if (!params.path) return { png: image.toPNG().toString("base64") };
  const target = path.resolve(params.path);
  writeFileSync(target, image.toPNG());
  return { path: target, size: image.getSize() };
}

// Every agent command goes through the surface hold, so a pane nobody is watching still
// answers with the page rather than with a one-pixel slice of it. The dispatch itself is
// unchanged; `withAgentSurface` is a pass-through for a visible pane.
function handleAgentCommand(method, params) {
  return withAgentSurface(method, () => dispatchAgentCommand(method, params));
}

async function dispatchAgentCommand(method, params) {
  switch (method) {
    // Page-side methods run inside the preload, next to the hint machinery.
    case "snapshot":
    case "info":
    case "query":
      return agentPageRequest(method, params);
    case "diag": {
      const engine = agentDiagnostics();
      // The shortcut runtime's own state is only reachable through the preload.
      // A page that cannot answer is worth reporting, not worth failing over.
      let page = null;
      try {
        page = await agentPageRequest("page-diag", {}, 3000);
      } catch (error) {
        page = { error: String(error?.message || error) };
      }
      return { ...engine, page };
    }
    case "engine-log": {
      const limit = Number.isInteger(params?.limit) ? Math.max(1, Math.min(400, params.limit)) : 60;
      return { lines: engineLog.slice(-limit) };
    }
    case "act": {
      const result = await agentPageRequest("act", params);
      if (result.click) {
        agentNativeClick(result.click);
        return { ok: true, clicked: result.click };
      }
      if (result.hover) {
        const contents = agentContents();
        contents.sendInputEvent({ type: "mouseMove", ...pageToWindowPoint(contents, result.hover) });
        return { ok: true, hovered: result.hover };
      }
      return { ok: true, ...result };
    }
    case "navigate": {
      const url = normalizeUrl(String(params.url || ""));
      await agentContents().loadURL(url);
      return { url: agentContents().getURL() };
    }
    case "back": {
      const history = agentContents().navigationHistory;
      if (!history.canGoBack()) throw new Error("no earlier entry in history");
      history.goBack();
      return { ok: true };
    }
    case "forward": {
      const history = agentContents().navigationHistory;
      if (!history.canGoForward()) throw new Error("no later entry in history");
      history.goForward();
      return { ok: true };
    }
    case "reload":
      agentContents().reload();
      return { ok: true };
    case "press":
      agentPressKey(String(params.key || ""), params.modifiers || []);
      return { ok: true };
    case "type":
      agentContents().insertText(String(params.text ?? ""));
      return { ok: true };
    case "eval":
      return { value: await agentContents().executeJavaScript(String(params.script || ""), true) };
    case "screenshot":
      return agentScreenshot(params);
    case "wait":
      return agentWaitFor(params);
    case "soleWindows.tabs":
      return agentTabList();
    case "tab":
      activateTab(Number(params.index));
      return agentTabList();
    case "tab-new":
      createTab(normalizeUrl(String(params.url || "about:blank")), true);
      return agentTabList();
    case "tab-close":
      closeTab(params.index === undefined ? soleWindows.activeTabIndex : Number(params.index));
      return agentTabList();
    case "console":
      return { messages: params.clear ? consoleLog.splice(0) : consoleLog.slice(-(params.limit || 100)) };
    case "errors":
      return { errors: consoleLog.filter((entry) => entry.level === "error").slice(-(params.limit || 50)) };
    case "status":
      return {
        pid: process.pid,
        pane: ownTmuxPane,
        tabs: agentTabList(),
      };
    // A peer says the claim changed. Nothing is returned and nothing is trusted — the
    // claim file is still the truth, this only saves waiting for the next poll.
    case "audio-sync":
      return { ok: true, ...reconcileAudio() };
    default:
      throw new Error(`unknown method ${JSON.stringify(method)}`);
  }
}

// IME composition is the terminal emulator's job, and it paints the pending
// syllable at the terminal cursor. That cursor sits wherever we last left it —
// the pane origin — so Korean input composes off in a corner instead of at the
// field. Park the cursor on the cell holding the web caret and show it only
// while a field is focused.
let caretCell = null;
let lastCaretPoint = null;
// A block cursor covers the cell it sits on, so the parked cursor hid the page's
// own caret and the character next to it. Ask for a steady bar (DECSCUSR 6): it
// draws on the cell's left edge, which is where a text caret belongs anyway.
const CARET_BAR = CSI("6 q");
const CARET_SHAPE_RESET = CSI("0 q");
// Where a fixed-width font puts its baseline inside the cell. The terminal paints
// preedit on that baseline, so the row has to be picked by baseline — matching
// cell *centres* floated a composing syllable a row above tall page text.
const CARET_BASELINE = 0.78;

let caretHidden = false;

function unparkTerminalCaret() {
  caretCell = null;
  lastCaretPoint = null;
  // Reported on every frame with no caret, so it writes only on the transition.
  if (caretHidden) return;
  caretHidden = true;
  try { paneWrite(`${CSI("?25l")}${CARET_SHAPE_RESET}`); } catch (error) { void error; }
}

// The page draws the IME composition surface on the cell grid, which only main can measure: the
// image fills the pane's cell box exactly, so a cell is the logical content size
// over the cell count — in CSS pixels once the zoom factor is divided out.
const configuredImeSlotCells = Number.parseInt(process.env.TWEB_IME_SLOT_CELLS || "", 10);
// A Korean preedit is one syllable, which is two cells wide; the third is slack.
// Longer preedits (Japanese, pinyin) want a wider surface — hence the override.
const imeSlotCells = Number.isSafeInteger(configuredImeSlotCells) && configuredImeSlotCells > 0
  ? configuredImeSlotCells
  : 3;

function cellMetrics() {
  if (!currentFrames().viewport || !soleWindows.win || soleWindows.win.isDestroyed()) return null;
  const logical = logicalContentSize(currentFrames().viewport);
  const zoom = soleWindows.win.webContents.getZoomFactor() || 1;
  return {
    width: logical.width / Math.max(1, currentFrames().cells.cols) / zoom,
    height: logical.height / Math.max(1, currentFrames().cells.rows) / zoom,
    columns: imeSlotCells,
  };
}

function broadcastCellMetrics(tab = soleWindows.win) {
  if (!tab || tab.isDestroyed() || tab !== soleWindows.win) return;
  sendToTabFrames(tab, "tweb-cell-metrics", cellMetrics());
}

// The page reports the caret in CSS pixels and dedupes on them, so a zoom step or
// a pane resize moves the cell under a caret that never "moved" — and the report
// that would correct it never comes. Recompute from the last one instead.
function reparkTerminalCaret() {
  if (lastCaretPoint) moveTerminalCaret(lastCaretPoint);
}

function moveTerminalCaret(point) {
  const vp = currentFrames().viewport;
  if (!point || !vp || !soleWindows.win || soleWindows.win.isDestroyed()) {
    // Unconditionally, not just when a caret was parked: a frame's cursor anchoring can
    // leave a visible cursor at the pane origin even when TWeb never put one there, and in
    // the corner that reads as a caret sitting in the wrong place.
    unparkTerminalCaret();
    return;
  }
  const logical = logicalContentSize(vp);
  const zoom = soleWindows.win.webContents.getZoomFactor() || 1;
  const cellWidth = logical.width / Math.max(1, currentFrames().cells.cols);
  const cellHeight = logical.height / Math.max(1, currentFrames().cells.rows);
  // Nearest cell edge, not the containing cell: a bar on the left edge is off by
  // at most half a cell that way instead of a whole one.
  const col = Math.min(currentFrames().cells.cols, Math.max(1, Math.round(point.x * zoom / cellWidth) + 1));
  const baseline = (point.y + (point.height || 0) * CARET_BASELINE) * zoom;
  const row = Math.min(currentFrames().cells.rows,
    Math.max(1, Math.round(baseline / cellHeight - CARET_BASELINE) + 1));
  lastCaretPoint = { x: point.x, y: point.y, height: point.height || 0 };
  if (caretCell && caretCell.row === row && caretCell.col === col) return;
  caretCell = { row, col };
  writeTerminalCaret(row, col);
}

function writeTerminalCaret(row, col) {
  caretHidden = false;
  try {
    paneWrite(`${CSI(`${row};${col}H`)}${CARET_BAR}${CSI("?25h")}`);
  } catch (error) {
    void error;
  }
}

// Every graphics write parks the cursor at the pane origin and restores it afterwards, but
// the restore is the terminal's single DECSC slot — which the caret's own placement does
// not own. In practice the cursor ends up back at the origin, so a caret parked on a word
// halfway down the page slides to the pane's top-left corner as soon as the next frame
// goes out. Frames are continuous, so it never stays where it was put.
//
// Rewriting the same position is a few bytes and idempotent, so the caret is simply
// re-asserted after anything that moves the cursor.
function reassertTerminalCaret() {
  if (!caretCell) return;
  writeTerminalCaret(caretCell.row, caretCell.col);
}

// The page reports CSS pixels but sendInputEvent takes unzoomed window
// coordinates, so every synthetic pointer event has to be scaled by the zoom
// factor. Without this a click lands off-target on any page that is not at 100%.
function pageToWindowPoint(contents, point) {
  const zoom = contents.getZoomFactor() || 1;
  return {
    x: Math.max(0, Math.round(point.x * zoom)),
    y: Math.max(0, Math.round(point.y * zoom)),
  };
}

function isDownloadableUrl(value) {
  try {
    return ["http:", "https:", "file:", "data:", "blob:"].includes(new URL(String(value)).protocol);
  } catch (_) {
    return false;
  }
}

function downloadUrl(contents, value) {
  if (!isDownloadableUrl(value)) return;
  try {
    contents.downloadURL(value);
  } catch (error) {
    if (debugLogging) console.error(`tweb: download failed: ${error.message}`);
  }
}

const pendingDownloadPaths = new Set();

function availableDownloadPath(filename) {
  const directory = app.getPath("downloads");
  mkdirSync(directory, { recursive: true });
  const safeName = path.basename(filename || "download") || "download";
  const extension = path.extname(safeName);
  const stem = safeName.slice(0, safeName.length - extension.length) || "download";
  for (let suffix = 0; ; suffix += 1) {
    const candidate = path.join(directory, suffix === 0 ? safeName : `${stem} (${suffix})${extension}`);
    if (!existsSync(candidate) && !pendingDownloadPaths.has(candidate)) return candidate;
  }
}

function configureDownloads() {
  session.defaultSession.on("will-download", (_event, item) => {
    const destination = availableDownloadPath(item.getFilename());
    pendingDownloadPaths.add(destination);
    item.setSavePath(destination);
    item.once("done", (_doneEvent, state) => {
      pendingDownloadPaths.delete(destination);
      if (debugLogging) console.error(`tweb: download ${state} ${destination}`);
    });
  });
}

function runBrowserContextMenuCommand(tab, action) {
  const state = contextMenuStateByTab.get(tab);
  contextMenuStateByTab.delete(tab);
  if (!state || tab !== soleWindows.win || tab.isDestroyed()) return;
  if (!state.actions.has(action)) return;
  const { params } = state;
  const contents = tab.webContents;
  switch (action) {
    case "undo": contents.undo(); break;
    case "redo": contents.redo(); break;
    case "cut": contents.cut(); break;
    case "copy": contents.copy(); break;
    case "paste": contents.paste(); break;
    case "paste-plain": contents.pasteAndMatchStyle(); break;
    case "select-all": contents.selectAll(); break;
    case "search-selection":
      createTab(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`, true);
      break;
    case "open-link": createTab(params.linkURL, true); break;
    case "open-link-here": void contents.loadURL(params.linkURL); break;
    case "save-link": downloadUrl(contents, params.linkURL); break;
    case "copy-link": clipboard.writeText(params.linkURL); break;
    case "open-image":
    case "open-media": createTab(params.srcURL, true); break;
    case "save-image":
    case "save-media": downloadUrl(contents, params.srcURL); break;
    case "copy-image":
      contents.copyImageAt(Math.round(params.x), Math.round(params.y));
      // copyImageAt is Chromium's native behavior, but some offscreen paths do not
      // update the pasteboard. Capture the rendered element as the same fallback
      // used by visual mode when the target belongs to the main document.
      sendToMainTabFrame(tab, "tweb-context-copy-image", { x: params.x, y: params.y });
      break;
    case "copy-image-url":
    case "copy-media-url": clipboard.writeText(params.srcURL); break;
    case "back":
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      break;
    case "forward":
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      break;
    case "reload": contents.reload(); break;
    case "inspect":
      sendToMainTabFrame(tab, "tweb-context-inspect", { x: params.x, y: params.y });
      break;
  }
}

function showBrowserContextMenu(tab, inputParams) {
  if (tab !== soleWindows.win || tab.isDestroyed()) return;
  const contents = tab.webContents;
  const params = {
    x: 0,
    y: 0,
    isEditable: false,
    selectionText: "",
    linkURL: "",
    srcURL: "",
    mediaType: "none",
    editFlags: {},
    ...inputParams,
  };
  const items = buildBrowserContextMenu(params, {
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  });
  contextMenuStateByTab.set(tab, {
    params,
    actions: new Set(items.filter((item) => item.enabled).map((item) => item.action)),
  });
  sendToMainTabFrame(tab, "tweb-context-menu", { x: params.x, y: params.y, items });
  if (debugLogging) console.error("tweb: context menu shown");
}

// Windows that have already had the setter-only invariants applied. A WeakSet so a closed
// window is not kept alive by the bookkeeping that hides it.
const hiddenWindowLatched = new WeakSet();

function keepWindowHidden(tab) {
  if (!tab || tab.isDestroyed()) return;
  const bounds = tab.getBounds();
  if (bounds.x !== -10_000 || bounds.y !== -10_000) {
    tab.setBounds({ ...bounds, x: -10_000, y: -10_000 });
  }
  if (tab.getOpacity() !== 0) tab.setOpacity(0);
  if (tab.isFocusable()) tab.setFocusable(false);
  // Every other line here reads before it writes, but these two have no getter — so the
  // watchdog was issuing them for every window, twenty times a second, forever. They are
  // set once at creation and nothing else changes them, so a latch is enough.
  if (!hiddenWindowLatched.has(tab)) {
    hiddenWindowLatched.add(tab);
    tab.setSkipTaskbar(true);
    tab.setIgnoreMouseEvents(true);
  }
  if (tab.isFocused()) tab.blur();
  if (tab.isVisible()) tab.hide();
}

function enforceHiddenWindows() {
  for (const window of BrowserWindow.getAllWindows()) keepWindowHidden(window);
  // Surfaces are reconciled on the same tick. A transition calls `updatePaintingState`
  // directly, but a pane that is *born* hidden has no transition to react to — measured:
  // an engine started in an unviewed tmux window reported terminalVisible=false and sent
  // zero frames, yet held a full-size surface indefinitely, which is the DESIGN.md 6.5
  // gate failing at the one moment it most obviously should not. The reconciler reads
  // each window's size before writing it, so a tick that has nothing to do costs nothing.
  updatePaintingState();
}

function configureTab(tab, initialZoomFactor = defaultZoomFactor) {
  const contents = tab.webContents;
  const keepHidden = () => keepWindowHidden(tab);
  keepHidden();
  tab.on("show", keepHidden);
  tab.on("focus", keepHidden);
  tab.on("move", keepHidden);
  contents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`tweb: preload failed ${preloadPath}: ${error.stack || error.message}`);
  });
  watchConsole(contents);
  tabZoomFactors.set(tab, initialZoomFactor);
  contents.setZoomFactor(initialZoomFactor);
  contents.setBackgroundThrottling(true);
  contents.setFrameRate(1);
  // A muted instance opening a tab must not leak audio through the new one.
  contents.setAudioMuted(audioMutedByOther);
  contents.on("paint", (_event, dirty, image) => {
    // A page painting on its own is what separates video from a static screen, and the
    // frame-rate policy reads it to decide whether to fall all the way to idle.
    if (tab === soleWindows.win) notePaintActivity();
    const size = image.getSize();
    const expected = currentFrames().viewport && renderedFrameSize(currentFrames().viewport);
    if (loggedFrameGeneration !== currentFrames().generation && !image.isEmpty()
      && size.width === expected?.width && size.height === expected?.height) {
      loggedFrameGeneration = currentFrames().generation;
      if (debugLogging) {
        const vp = currentFrames().viewport || queryViewportSize();
        console.error(
          `tweb: frame generation=${currentFrames().generation} ${size.width}x${size.height}, `
          + `pane ${vp.width}x${vp.height}, scale ${renderScaleFactor().toFixed(2)}`
        );
      }
    }
    // The dirty rect used to be discarded, so a blinking caret cost the same whole-frame
    // encode as a page load. It decides the patch path now.
    queueFrame(tab, image, false, dirty);
  });

  // Before Electron attaches our custom offscreen child, it can surface the macOS OffScreenView
  // placeholder as a native popup. Deny the original request and open the URL directly in a
  // separate TWeb tab, which keeps the native popup from ever being created.
  contents.setWindowOpenHandler((details) => {
    const target = details.url || "about:blank";
    setImmediate(() => createTab(target, true));
    return { action: "deny" };
  });

  contents.on("did-start-navigation", (details) => {
    if (details.isSameDocument || !details.frame) return;
    readyFrameKeys(tab).delete(frameKey(details.frame));
  });
  contents.on("context-menu", (_event, params) => {
    if (vimiumShortcutsEnabled) showBrowserContextMenu(tab, params);
  });
  contents.on("media-started-playing", () => {
    // Audibility is not known at the moment playback starts — a track whose output has
    // not opened yet reports silent — so the claim is left to the poll, which asks again
    // every tick. This only shortens the wait when the answer is already in.
    setTimeout(() => {
      if (contents.isDestroyed()) return;
      if (debugLogging) {
        console.error(`tweb: media playing audible=${contents.isCurrentlyAudible()} muted=${contents.audioMuted}`);
      }
      // reconcileAudio, not claimAudio: a page starting playback is not consent to take
      // the speakers from a pane that is already using them. Only `m` does that.
      reconcileAudio();
    }, 250);
  });
  contents.on("media-paused", () => {
    if (debugLogging) console.error("tweb: media paused");
    // The release itself is debounced in reconcileAudio; this only makes the pane
    // notice its own silence on the next tick rather than several ticks later.
    reconcileAudio();
  });
  contents.on("found-in-page", (_event, result) => {
    sendToTabFrames(tab, "tweb-find-result", result);
  });

  let showingLoadError = false;
  const recordNavigation = (url) => {
    if (showingLoadError || !isRestorableUrl(url)) return;
    tabSessionUrls.set(tab, url);
    recordNavigationHistory(url, contents.getTitle());
    scheduleWindowSessionSave();
  };
  contents.on("did-navigate", (_event, url) => recordNavigation(url));
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) recordNavigation(url);
  });

  let initialZoomApplied = false;
  contents.on("did-finish-load", () => {
    showingLoadError = false;
    const zoomFactor = tabZoomFactors.get(tab) ?? defaultZoomFactor;
    contents.setZoomFactor(zoomFactor);
    contents.invalidate();
    // Autofocused fields report their caret before this zoom lands.
    if (tab === soleWindows.win) {
      broadcastCellMetrics(tab);
      reparkTerminalCaret();
    }
    if (!initialZoomApplied) {
      initialZoomApplied = true;
      if (debugLogging) console.error(`tweb: default zoom ${zoomFactor.toFixed(3)}`);
    }
    installPageEnhancements(tab);
    sendToTabFrames(tab, "tweb-shortcuts-mode", { vimium: vimiumShortcutsEnabled, bypass: cmdBypassEnabled });
    if (debugLogging) {
      console.error(`tweb: loaded ${contents.getURL()} (${contents.getTitle()})`);
    }
  });
  tab.on("page-title-updated", (_event, title) => {
    const url = tabSessionUrls.get(tab) || contents.getURL();
    recordNavigationHistory(url, title);
    sendTabState();
    if (debugLogging) console.error(`tweb: title ${title}`);
  });
  contents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || showingLoadError) return;
    showingLoadError = true;
    console.error(`tweb: failed to load ${failedUrl}: ${description} (${code})`);
    void contents.loadURL(errorPage(failedUrl || contents.getURL(), code, description));
  });
  // A lost render process leaves an offscreen tab dead but silent: the bytes are released, the
  // engine keeps answering `tweb status` with a healthy pid, and the pane holds the last image
  // it was sent. Chromium restarts a *visible* window's renderer on its next paint; an
  // offscreen one has no such trigger, so nothing ever comes back without this.
  contents.on("render-process-gone", (_event, details) => {
    const reason = details?.reason;
    const decision = recoveryDecision(reason, tabRendererRecoveries.get(tab), Date.now());
    tabRendererRecoveries.set(tab, decision.recent);
    if (decision.action === "ignore") return;
    const url = tabSessionUrls.get(tab) || contents.getURL();
    if (decision.action === "report") {
      console.error(`tweb: renderer gone (${reason}), giving up on ${url}`);
      showingLoadError = true;
      void contents.loadURL(errorPage(url, reason, "This page keeps crashing"));
      return;
    }
    console.error(`tweb: renderer gone (${reason}), reloading ${url}`);
    // reload() on a webContents whose process died replays the current entry, which is the
    // page the user was on — reloadIgnoringCache would additionally refetch, turning a
    // recoverable crash into a network round trip the user did not ask for.
    contents.reload();
  });
}

function adoptTab(tab, url, activate = true, initialZoomFactor = defaultZoomFactor) {
  if (soleWindows.tabs.includes(tab)) return tab;
  configureTab(tab, initialZoomFactor);
  tabSessionUrls.set(tab, url || "about:blank");
  soleWindows.tabs.push(tab);
  const index = soleWindows.tabs.length - 1;

  tab.on("closed", () => {
    const closedIndex = soleWindows.tabs.indexOf(tab);
    if (closedIndex < 0) return;
    const wasActive = tab === soleWindows.win;
    tabFrames.delete(tab);
    tabZoomFactors.delete(tab);
    tabSessionUrls.delete(tab);
    tabRendererRecoveries.delete(tab);
    soleWindows.tabs.splice(closedIndex, 1);
    if (soleWindows.tabs.length === 0) {
      soleWindows.win = null;
      soleWindows.activeTabIndex = -1;
      if (!quitting) app.quit();
      return;
    }
    if (wasActive) activateTab(Math.min(closedIndex, soleWindows.tabs.length - 1));
    else {
      if (closedIndex < soleWindows.activeTabIndex) soleWindows.activeTabIndex -= 1;
      sendTabState();
    }
    if (refreshTabListAfterClose) {
      refreshTabListAfterClose = false;
      sendToTabFrames(soleWindows.win, "tweb-soleWindows.tabs", tabListModel());
    }
    scheduleWindowSessionSave();
  });

  if (activate) activateTab(index);
  else {
    // A tab opened in the background never becomes active, so nothing else would
    // reconcile it and it would keep a full-size surface for the life of the window.
    // Loading a page into an already-collapsed surface is safe: measured on a Wikipedia
    // article, a page loaded at width x 1 and then restored reported the same
    // scrollHeight and the same number of loaded images as one loaded at full size.
    updatePaintingState();
    sendTabState();
    scheduleWindowSessionSave();
  }
  if (debugLogging) console.error(`tweb: tab opened ${index + 1} ${url}`);
  return tab;
}

function createTab(
  url = "about:blank",
  activate = true,
  initialZoomFactor = defaultZoomFactor,
  showInitialPlaceholder = soleWindows.tabs.length === 0
) {
  const tab = adoptTab(
    new BrowserWindow(browserWindowOptions()),
    url,
    activate,
    initialZoomFactor
  );
  const load = () => {
    // did-fail-load owns user-visible failures. loadURL also rejects for a normal
    // client-side redirect with ERR_ABORTED, which must not replace the new page.
    void tab.loadURL(url).catch((error) => {
      if (debugLogging) console.error(`tweb: navigation superseded ${url}: ${error.message}`);
    });
  };
  // Chromium paints nothing until a page commits, and a real site takes seconds:
  // measured on google.com, the first frame arrived 5.5s in, and until then the
  // pane was simply black. A placeholder commits in about half of one second, and
  // paint holding keeps it up while the real page loads. Only the first tab needs
  // it — any later one has the previous page on screen to hold.
  // Local files commit immediately, and navigating away from the placeholder can
  // race Chromium's file load into a spurious ERR_FILE_NOT_FOUND error page.
  if (showInitialPlaceholder && isRestorableUrl(url) && !url.startsWith("file:")
    && !process.env.TWEB_NO_PLACEHOLDER) {
    tab.webContents.once("did-finish-load", load);
    void tab.loadURL(placeholderPage(url)).catch(load);
  } else {
    load();
  }
  return tab;
}

// Deliberately plain: it exists to put *something* on the pane within the first
// half second, not to be looked at.
function placeholderPage(target) {
  let host = target;
  try {
    host = new URL(target).host || target;
  } catch (error) {
    void error;
  }
  const escaped = String(host).replace(/[&<>]/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8"><title>${escaped}</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#161616;color:#9aa0a6;font:13px ui-monospace,SFMono-Regular,Menlo,monospace">
Opening ${escaped}…</body>`)}`;
}

function noWindowSessionPage() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8"><title>TWeb</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#161616;color:#9aa0a6;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;
flex-direction:column;gap:8px">
<div>No previous page to restore</div><div style="color:#6f747c">Press t to enter an address</div></body>`)}`;
}

function applyViewport(vp, origin = currentFrames().origin, frames = currentFrames(), record = currentPane()) {
  if (!vp) return;
  // What changed, and whether anything did, is decided in `frame-context.cjs` — including the
  // generation bump, which is the thing every drop below keys on.
  const change = applyFrameViewport(frames, vp, origin);
  if (!change) return;

  mouseClicks.reset();
  if (frames.pendingFrameTimer) {
    clearTimeout(frames.pendingFrameTimer);
    frames.pendingFrameTimer = null;
  }
  frames.pendingFrame = null;
  frames.pendingGfxFrame = null;
  tabFrames.clear();
  // A patch is positioned in cells of the pane it was cut for. Once the grid changes it
  // describes the wrong region, and unlike the base image it cannot be re-placed into the
  // new one — so it goes now rather than waiting for the next whole frame.
  deletePatches(frames);
  // A moved pane leaves a placement at the old anchor, and a shrunk one leaves
  // the rows it gave up still covered — usually hiding the pane that just
  // appeared there. Neither is fixed by replacement, so both need a delete;
  // growing is, so it gets none. The delete rides along with the next transfer.
  if (change.originChanged || change.shrank) frames.pendingImageDelete = true;
  // The record is what a host reads back; the context is what this file reads on every frame.
  record.viewport = vp;
  record.origin = frames.origin;
  const logical = logicalContentSize(vp);
  if (debugLogging) {
    const anchor = frames.origin ? `${frames.origin.left},${frames.origin.top}` : "none";
    console.error(
      `tweb: resize generation=${frames.generation} cells=${vp.cols}x${vp.rows} `
      + `pixels=${vp.width}x${vp.height} logical=${logical.width}x${logical.height} origin=${anchor}`
    );
  }
  if (change.sizeChanged) {
    // Through the same policy as everything else: resizing every tab to the new pane
    // size unconditionally would re-inflate the collapsed surface of every background
    // tab, and nothing would collapse them again until the next tab switch. A pane
    // resize is exactly when a hidden pane is most likely to be resized.
    for (const tab of soleWindows.tabs) {
      if (tab.isDestroyed()) continue;
      applySurfacePlan(tab, surfacePlan(tab === soleWindows.win, record.visible, logical, surfaceHeldForAgent()));
    }
  }
  soleWindows.win?.webContents.invalidate();
  if (record.visible) replacePlacement(frames);
  broadcastCellMetrics();
  reparkTerminalCaret();
}

function createWindow(url, frames = currentFrames()) {
  // A hosted pane's geometry came in its ATTACH; a per-pane engine measures its own terminal.
  // Querying the terminal under hosting would measure the DAEMON's, which has no pane.
  const vp = frames.viewport || queryViewportSize();
  frames.cells = { cols: vp.cols, rows: vp.rows };
  frames.viewport = vp;

  const session = readWindowSession();
  if (!session) {
    const initialUrl = restoreWindowSession && !isRestorableUrl(url)
      ? noWindowSessionPage()
      : url;
    return createTab(initialUrl, true);
  }

  for (const [index, tab] of session.tabs.entries()) {
    createTab(tab.url, false, tab.zoom, index === session.activeIndex);
  }
  activateTab(session.activeIndex);
  if (debugLogging) {
    console.error(`tweb: restored ${session.tabs.length} tabs for tmux window`);
  }
  return soleWindows.win;
}

// --- browser input ---

let rawInput = Buffer.alloc(0);
let rawInputFlushTimer = null;
const paste = new PasteState();
const utf8Decoder = new StringDecoder("utf8");
const mouseClicks = new MouseClickState();

function electronModifiers(mask) {
  const bits = Math.max(0, mask - 1);
  const modifiers = [];
  if (bits & 1) modifiers.push("shift");
  if (bits & 2) modifiers.push("alt");
  if (bits & 4) modifiers.push("control");
  if (bits & 8 || bits & 32) modifiers.push("meta");
  return modifiers;
}

function mouseModifiers(cb) {
  const modifiers = [];
  if (cb & 4) modifiers.push("shift");
  if (cb & 8) modifiers.push("alt");
  if (cb & 16) modifiers.push("control");
  return modifiers;
}

function logicalMousePoint(rawX, rawY) {
  const vp = currentFrames().viewport || queryViewportSize();
  const logical = logicalContentSize(vp);
  if (paneIsInTmux()) {
    // tmux delivers pane-relative cell coordinates even when 1016 was requested.
    return {
      x: Math.min(logical.width - 1, Math.max(0, Math.floor((rawX - 0.5) * logical.width / vp.cols))),
      y: Math.min(logical.height - 1, Math.max(0, Math.floor((rawY - 0.5) * logical.height / vp.rows))),
    };
  }
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  return {
    x: Math.max(0, Math.floor((rawX - 1) / scale)),
    y: Math.max(0, Math.floor((rawY - 1) / scale)),
  };
}

function setBrowserZoom(action) {
  if (!soleWindows.win) return;
  const contents = soleWindows.win.webContents;
  // Chromium keeps zoom per origin, so getZoomFactor() reports whatever another
  // tab on the same host last set. Step from this tab's own remembered value.
  const current = tabZoomFactors.get(soleWindows.win) ?? contents.getZoomFactor();
  const next = action === "reset"
    ? defaultZoomFactor
    : Math.min(2, Math.max(0.5, current * (action === "in" ? 1.2 : 1 / 1.2)));
  tabZoomFactors.set(soleWindows.win, next);
  contents.setZoomFactor(next);
  contents.invalidate();
  broadcastCellMetrics();
  reparkTerminalCaret();
  scheduleWindowSessionSave();
  if (debugLogging) console.error(`tweb: zoom ${next.toFixed(3)}`);
}

function hasZoomModifier(modifiers) {
  // Cmd +/- is consumed by Ghostty's font zoom first, so it is not used as a browser shortcut.
  return modifiers.includes("control") && !modifiers.includes("meta");
}

function dispatchMouse(cb, rawX, rawY, release) {
  if (!soleWindows.win) return;
  const contents = soleWindows.win.webContents;
  const { x, y } = logicalMousePoint(rawX, rawY);
  const modifiers = mouseModifiers(cb);
  const buttonCode = cb & 3;
  const motion = (cb & 32) !== 0;
  const wheel = (cb & 64) !== 0;

  if (wheel) {
    const direction = buttonCode === 0 ? 1 : buttonCode === 1 ? -1 : 0;
    if (vimiumShortcutsEnabled && direction !== 0 && hasZoomModifier(modifiers)) {
      setBrowserZoom(direction > 0 ? "in" : "out");
      return;
    }
    contents.sendInputEvent({
      type: "mouseWheel",
      x,
      y,
      deltaX: buttonCode === 2 ? -100 : buttonCode === 3 ? 100 : 0,
      deltaY: direction * 100,
      wheelTicksX: buttonCode === 2 ? -1 : buttonCode === 3 ? 1 : 0,
      wheelTicksY: direction,
      accelerationRatioX: 0.5,
      accelerationRatioY: 0.5,
      hasPreciseScrollingDeltas: false,
      canScroll: true,
      modifiers,
    });
    return;
  }

  const button = buttonCode === 0 ? "left" : buttonCode === 1 ? "middle" : buttonCode === 2 ? "right" : undefined;
  let type = "mouseMove";
  if (!motion && button) type = release ? "mouseUp" : "mouseDown";
  let clickCount = 0;
  if (type === "mouseDown") {
    clickCount = mouseClicks.press(button, x, y);
  } else if (type === "mouseUp") {
    clickCount = mouseClicks.release(button).count;
  } else {
    mouseClicks.move(button, x, y);
  }
  contents.sendInputEvent({
    type,
    x,
    y,
    button,
    modifiers,
    clickCount,
  });
  // Some offscreen Chromium paths do not raise contextmenu from a right mouseUp alone.
  if (type === "mouseUp" && button === "right") {
    contents.sendInputEvent({
      type: "contextMenu",
      x,
      y,
      button: "right",
      modifiers,
    });
    // The menu is built from the `context-menu` event instead: Chromium reports
    // what is under the pointer there (link, image, selection, editability).
    // Opening one here as well replaced that menu with a coordinates-only one,
    // losing every entry that depends on the target.
  }
  if (debugLogging && type !== "mouseMove") {
    console.error(`tweb: ${type} ${button} ${x},${y}`);
  }
}

const KITTY_KEYS = new Map([
  [27, "Escape"], [13, "Enter"], [9, "Tab"], [127, "Backspace"],
  [57344, "Escape"], [57345, "Enter"], [57346, "Tab"], [57347, "Backspace"],
  [57348, "Insert"], [57349, "Delete"], [57350, "ArrowLeft"], [57351, "ArrowRight"],
  [57352, "ArrowUp"], [57353, "ArrowDown"], [57354, "PageUp"], [57355, "PageDown"],
  [57356, "Home"], [57357, "End"],
]);

function keyName(codepoint) {
  if (KITTY_KEYS.has(codepoint)) return KITTY_KEYS.get(codepoint);
  if (codepoint >= 32 && codepoint <= 0x10ffff) {
    try { return String.fromCodePoint(codepoint); } catch (e) {}
  }
  return null;
}

// The name sent to the preload is the web-standard KeyboardEvent.key, but
// sendInputEvent's keyCode only accepts Electron Accelerator names. The arrow keys
// are named differently in the two schemes, so passing them straight through makes
// Chromium ignore them silently — why ArrowUp/Down did nothing in Slack's search box.
const ACCELERATOR_KEYS = new Map([
  ["ArrowUp", "Up"], ["ArrowDown", "Down"], ["ArrowLeft", "Left"], ["ArrowRight", "Right"],
]);
// A letter under Cmd must NOT be rewritten to its "KeyX" Accelerator name.
// Measured in offscreen Chromium: keyDown with "KeyK" reaches the page as
// key="" keyCode=0, while "k" arrives as key="k" keyCode=75. Only the arrow
// keys genuinely need translating.
function dispatchNativeKey(contents, key, text, modifiers, eventKind) {
  const keyCode = ACCELERATOR_KEYS.get(key) || key;
  const event = {
    keyCode,
    modifiers,
  };
  if (eventKind === 3) {
    contents.sendInputEvent({ ...event, type: "keyUp" });
    return;
  }
  // Cmd combinations go out as keyDown so Chromium runs its shortcut path.
  // rawKeyDown skips shortcut handling, leaving the page blind to the shortcut.
  //
  // keyDown gets the same resolved keyCode as keyUp. Passing the raw web name
  // here instead sent "ArrowDown", which Chromium does not recognise, so arrow
  // keys silently did nothing while a suggestion list was open.
  contents.sendInputEvent({ ...event, type: "keyDown" });
  if (text && !modifiers.includes("control") && !modifiers.includes("meta")) {
    contents.sendInputEvent({ type: "char", keyCode: text, modifiers });
  }
  if (eventKind === 1) contents.sendInputEvent({ ...event, type: "keyUp" });
}

function dispatchNamedKey(key, modifierMask = 1, eventKind = 1, textCodepoints = []) {
  if (!soleWindows.win || !key) return;
  const modifiers = electronModifiers(modifierMask);
  const pressed = eventKind !== 3;
  const control = modifiers.includes("control");
  const shift = modifiers.includes("shift");
  if (debugLogging && modifiers.length) {
    console.error(`tweb: key ${key} [${modifiers.join("+")}] kind=${eventKind}`);
  }

  // Where tmux does not strip the modifiers, standard CSI-u is supported too.
  // The release is consumed as well, so no orphan keyUp reaches the page.
  if (control && key === ";") {
    if (pressed) toggleBrowserShortcuts();
    return;
  }

  if (modifiers.includes("meta") && key.toLowerCase() === "a") {
    if (pressed) sendToTabFrames(soleWindows.win, "tweb-select-all");
    return;
  }

  // Editing commands are driven directly rather than dispatched as key events:
  // the renderer knows the selection and the focused field, so this works while
  // typing (mode E) where it matters most. Ghostty's own Cmd-C/V act on the
  // terminal selection instead, which is why these need a passthrough entry.
  if (modifiers.includes("meta") && ["c", "v", "x"].includes(key.toLowerCase())) {
    if (pressed) {
      const contents = soleWindows.win.webContents;
      if (key.toLowerCase() === "c") contents.copy();
      else if (key.toLowerCase() === "v") contents.paste();
      else contents.cut();
    }
    return;
  }

  // Ctrl-C quits the pane only in browser shortcut mode. In web passthrough mode it goes to
  // the page as an ordinary KeyboardEvent.
  if (vimiumShortcutsEnabled && key.toLowerCase() === "c" && control) {
    if (pressed) app.quit();
    return;
  }

  if (vimiumShortcutsEnabled) {
    const tabCycle = control && (key === "Tab" || key === "PageDown" || key === "PageUp");
    const tabClose = control && key.toLowerCase() === "w";
    const zoom = hasZoomModifier(modifiers) && ["+", "=", "-", "0"].includes(key);
    if (tabCycle || tabClose || zoom) {
      if (pressed) {
        if (key === "Tab") cycleTab(shift ? -1 : 1);
        else if (key === "PageDown") cycleTab(1);
        else if (key === "PageUp") cycleTab(-1);
        else if (tabClose) closeTab();
        else if (key === "+" || key === "=") setBrowserZoom("in");
        else if (key === "-") setBrowserZoom("out");
        else if (key === "0") setBrowserZoom("reset");
      }
      return;
    }
  }

  const text = eventKind !== 3
    ? textCodepoints.length > 0
      ? textCodepoints.map((value) => keyName(value) || "").join("")
      : key.length === 1 && !modifiers.includes("control") && !modifiers.includes("meta")
        ? key
        : ""
    : "";
  // Passthrough and insert mode both hand the page real keys. Anything routed
  // through the renderer arrives untrusted, and sites gate their shortcuts on
  // that. Escape still reaches TWeb: the preload's capture listener sees the
  // native key first and leaves insert mode.
  // Cmd combinations always go native: they exist only because the user wants
  // the web app's own shortcut, and those are exactly the handlers that check
  // isTrusted.
  if (!vimiumShortcutsEnabled || pageInsertMode || modifiers.includes("meta")) {
    dispatchNativeKey(soleWindows.win.webContents, key, text, modifiers, eventKind);
    return;
  }
  sendToFocusedTabFrame(soleWindows.win, "tweb-terminal-key", {
    key,
    code: "",
    event: eventKind === 3 ? "keyup" : "keydown",
    text,
    shiftKey: modifiers.includes("shift"),
    altKey: modifiers.includes("alt"),
    ctrlKey: control,
    metaKey: modifiers.includes("meta"),
    synthesizeKeyUp: eventKind === 1,
  });
}

function dispatchKey(codepoint, modifierMask = 1, eventKind = 1, textCodepoints = []) {
  const key = keyName(codepoint);
  if (key) dispatchNamedKey(key, modifierMask, eventKind, textCodepoints);
}

function dispatchControlByte(byte, extraModifierBits = 0) {
  if (byte === 0) {
    dispatchKey(32, 1 + 4 + extraModifierBits);
    return true;
  }
  if (byte >= 1 && byte <= 26) {
    dispatchKey(96 + byte, 1 + 4 + extraModifierBits);
    return true;
  }
  const controlKeys = new Map([
    [28, "\\".codePointAt(0)],
    [29, "]".codePointAt(0)],
    [30, "^".codePointAt(0)],
    [31, "_".codePointAt(0)],
  ]);
  if (controlKeys.has(byte)) {
    dispatchKey(controlKeys.get(byte), 1 + 4 + extraModifierBits);
    return true;
  }
  return false;
}

// Cmd-V. Pastes into the page the bracketed-paste body that Ghostty's
// paste_from_clipboard wrote to the PTY. When the content matches the clipboard it
// uses webContents.paste() — pages like Slack read the real paste event to handle
// formatting and attachments, which insertText cannot deliver. Terminals commonly
// turn \n into \r on paste, so both sides are normalized before comparing.
function dispatchPaste(text) {
  if (!soleWindows.win || !text) return;
  const contents = soleWindows.win.webContents;
  const normalize = (value) => value.replace(/\r\n?/g, "\n");
  const body = normalize(text);
  const fromClipboard = normalize(clipboard.readText()) === body;
  if (debugLogging) {
    console.error(`tweb: paste ${body.length} chars clipboard=${fromClipboard}`);
  }
  if (fromClipboard) {
    contents.paste();
    return;
  }
  // A different clipboard (a tmux buffer paste, say) means inserting the text as is.
  contents.insertText(body);
}

function dispatchText(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    if (byte === 10 || byte === 13) {
      dispatchNamedKey("Enter");
      offset += byte === 13 && buffer[offset + 1] === 10 ? 2 : 1;
      continue;
    }
    if (byte < 0x20 && byte !== 9) {
      if (!dispatchControlByte(byte)) dispatchKey(byte);
      offset += 1;
      continue;
    }
    const text = utf8Decoder.write(buffer.subarray(offset));
    for (const char of text) {
      const codepoint = char.codePointAt(0);
      const modifierMask = codepoint >= 65 && codepoint <= 90 ? 2 : 1;
      dispatchKey(codepoint, modifierMask);
    }
    break;
  }
}

// Ghostty produces no PTY encoding for Cmd combinations (a key probe confirmed that
// plain, modifyOtherKeys and Kitty modes all send zero bytes). They are carried as
// private sequences instead and turned back into the original key here. 5020 and up
// is the Cmd range, and each code must be registered in tmux user-keys[120+] or its
// ESC gets re-encoded. The codes have to match doctor's CMD_PASSTHROUGH_KEYS.
const CMD_PRIVATE_KEYS = new Map([
  [5020, "k"],
  [5021, "a"],
  [5022, "c"],
  [5023, "x"],
]);

function dispatchPrivateShortcut(code) {
  if (debugLogging) console.error(`tweb: private key ${code}`);
  // Ctrl-; — bypass toggle. Leaves vimium alone.
  if (code === 5001) {
    toggleBrowserShortcuts();
    return;
  }
  // Ctrl-: — vimium toggle. Leaves bypass alone.
  if (code === 5014) {
    setVimiumShortcutsEnabled(!vimiumShortcutsEnabled);
    return;
  }
  // The legacy forced ON/OFF sequences — under the new flags they force bypass.
  if (code === 5011 || code === 5012) {
    setCmdBypassEnabled(code === 5012);
    return;
  }
  const cmdKey = CMD_PRIVATE_KEYS.get(code);
  if (cmdKey) {
    // 1 + meta(8). Sent to the page regardless of cmdBypassEnabled — in any mode,
    // what the user pressed is that web app's Cmd shortcut.
    dispatchNamedKey(cmdKey, 9);
    return;
  }
  if (vimiumShortcutsEnabled) {
    if (code === 5002 || code === 5007) setBrowserZoom("in");
    else if (code === 5003) setBrowserZoom("out");
    else if (code === 5004) setBrowserZoom("reset");
    else if (code === 5008) dispatchNamedKey("Enter", 2);
    else if (code === 5009) dispatchKey(",".codePointAt(0), 5);
    return;
  }

  if (code === 5002) dispatchKey("=".codePointAt(0), 5);
  else if (code === 5003) dispatchKey("-".codePointAt(0), 5);
  else if (code === 5004) dispatchKey("0".codePointAt(0), 5);
  else if (code === 5005) dispatchKey("H".codePointAt(0), 8);
  else if (code === 5006) dispatchKey("L".codePointAt(0), 8);
  else if (code === 5007) dispatchKey("+".codePointAt(0), 6);
  else if (code === 5008) dispatchNamedKey("Enter", 2);
  else if (code === 5009) dispatchKey(",".codePointAt(0), 5);
}

function scheduleRawInputFlush() {
  if (rawInputFlushTimer || rawInput.length === 0) return;
  rawInputFlushTimer = setTimeout(() => {
    rawInputFlushTimer = null;
    if (rawInput[0] === 0x1b) {
      // An ESC-prefixed sequence that ends without further bytes is a real Escape key. After a
      // short disambiguation window, deliver that first ESC and re-parse the rest.
      dispatchKey(27);
      rawInput = rawInput.subarray(1);
      consumeRawInput();
    }
  }, 35);
}

function consumeRawInput() {
  for (;;) {
    if (rawInput.length === 0) return;

    // A paste body is never parsed as escape sequences. It can hold arbitrary bytes
    // including ESC, and everything up to the closing bracket is text to paste.
    if (paste.active) {
      const chunk = rawInput;
      rawInput = Buffer.alloc(0);
      const done = paste.push(chunk);
      if (!done) return;
      if (done.dropped) {
        if (debugLogging) console.error("tweb: paste exceeded limit, dropped");
        return;
      }
      rawInput = done.rest;
      dispatchPaste(done.text);
      continue;
    }

    const escape = rawInput.indexOf(0x1b);
    if (escape > 0) {
      dispatchText(rawInput.subarray(0, escape));
      rawInput = rawInput.subarray(escape);
      continue;
    }
    if (escape < 0) {
      dispatchText(rawInput);
      rawInput = Buffer.alloc(0);
      return;
    }

    const input = rawInput.toString("utf8");

    // Start of a bracketed paste. Ghostty never encodes Cmd-V as a key; the whole
    // event is paste_from_clipboard writing the clipboard into the PTY. On the
    // opening bracket, collect the body that follows and handle it as one paste.
    if (paste.begins(rawInput)) {
      // Stops the ESC-disambiguation timer from firing mid-paste and committing the
      // body's first byte as an Escape key.
      if (rawInputFlushTimer) {
        clearTimeout(rawInputFlushTimer);
        rawInputFlushTimer = null;
      }
      paste.start();
      rawInput = rawInput.subarray(PASTE_START.length);
      continue;
    }

    // Focus reporting is not used. An ESC[I/ESC[O left over from a previous run or from
    // tmux/terminal state is never forwarded as browser text or a shell string either.
    const focus = /^\x1b\[[IO]/.exec(input);
    if (focus) {
      rawInput = rawInput.subarray(Buffer.byteLength(focus[0]));
      continue;
    }

    // 5001-5012 are the existing shortcuts, 5013-5019 the mode toggles
    // (5014 = Ctrl-:), and 5020 and up the Cmd combinations.
    let match = /^\x1b\[(50(?:0[1-9]|1[0-9]|[2-9][0-9]))~/.exec(input);
    if (match) {
      dispatchPrivateShortcut(Number(match[1]));
      rawInput = rawInput.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(input);
    if (match) {
      dispatchMouse(Number(match[1]), Number(match[2]), Number(match[3]), match[4] === "m");
      rawInput = rawInput.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    match = /^\x1b\[([0-9]+)(?::[0-9]+)*(?:;([0-9]+)(?::([123]))?)?(?:;([0-9:]+))?u/.exec(input);
    if (match) {
      const text = match[4] ? match[4].split(":").map(Number).filter(Number.isFinite) : [];
      dispatchKey(Number(match[1]), Number(match[2] || 1), Number(match[3] || 1), text);
      rawInput = rawInput.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    match = /^\x1b\[(?:1;([2-8]))?([ABCDHF])/.exec(input);
    if (match) {
      const keys = { A: "ArrowUp", B: "ArrowDown", C: "ArrowRight", D: "ArrowLeft", H: "Home", F: "End" };
      dispatchNamedKey(keys[match[2]], Number(match[1] || 1));
      rawInput = rawInput.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    match = /^\x1b\[(\d+)(?:;([2-8]))?~/.exec(input);
    if (match) {
      const keys = {
        1: "Home", 2: "Insert", 3: "Delete", 4: "End", 5: "PageUp", 6: "PageDown",
        11: "F1", 12: "F2", 13: "F3", 14: "F4", 15: "F5", 17: "F6",
        18: "F7", 19: "F8", 20: "F9", 21: "F10", 23: "F11", 24: "F12",
      };
      if (keys[match[1]]) dispatchNamedKey(keys[match[1]], Number(match[2] || 1));
      rawInput = rawInput.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    match = /^\x1bO([P-SABCDHF])/.exec(input);
    if (match) {
      const keys = {
        P: "F1", Q: "F2", R: "F3", S: "F4",
        A: "ArrowUp", B: "ArrowDown", C: "ArrowRight", D: "ArrowLeft", H: "Home", F: "End",
      };
      dispatchNamedKey(keys[match[1]]);
      rawInput = rawInput.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    match = /^\x1b\[27;([2-8]);(\d+)~/.exec(input);
    if (match) {
      dispatchKey(Number(match[2]), Number(match[1]));
      rawInput = rawInput.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    // Modified keys use modifyOtherKeys or Kitty CSI-u, both enabled by the
    // frontend. Treating ESC + printable as legacy Alt swallows a quick
    // Escape followed by a normal-mode key; the fallback below emits Escape
    // and then reparses the remaining printable input instead.

    // If the escape sequence is still incomplete, wait for the next INPUT chunk.
    // A lone ESC is settled as the Escape key once the short disambiguation window passes.
    if (/^\x1b(?:\[|\[<|O)?[0-9;:<]*$/.test(input)) {
      scheduleRawInputFlush();
      return;
    }

    // An unrecognized ESC is delivered as the Escape key, consuming just that one byte.
    dispatchKey(27);
    rawInput = rawInput.subarray(1);
  }
}

// --- resize/input control channel ---
// tweb-pane forwards SIGWINCH and raw terminal input over this pipe.

// What an ATTACH does when there is no page host behind it.
//
// The choice here is the whole subject of this seam, so it is written out. A host that RECORDED
// the pane — registered it, allocated its writer, handed back an agent socket — and did not open
// a window would be worse than one that refuses: the supervisor would count the attach as
// accepted, the frontend would stop falling back, and the pane would sit blank forever with
// every check green. That state was produced once and observed exactly that way.
//
// So this refuses, loudly and without recording anything. `hostProtocolVersion()` is null, the
// engine never printed READY, and a supervisor that never got a handshake is not sending real
// attaches anyway — this exists so that if one ever arrives, the answer is a diagnostic rather
// than a half-built registration.
function handleAttach(command) {
  if (!hostedRuntime) {
    // A per-pane engine already serves the pane it was started for. Accepting an attach would
    // give it a second registration it has no window for.
    console.error(`tweb: ignoring ATTACH for ${command.paneId}: this engine is not a host`);
    return;
  }
  if (!command.paneId) return;

  // The image id is the caller's, and a base that treads on a live pane's pool is refused rather
  // than used. An overlap does not fail loudly — it puts one pane's frame in another pane's
  // rectangle — and a pane that never appears is a better failure than two panes corrupting each
  // other, because the frontend still has its own engine to fall back to.
  const collision = collidingImageRange(paneRegistry.list(), command.imageId);
  if (collision) {
    console.error(`tweb: refusing ATTACH for ${command.paneId}: image id ${command.imageId}`
      + ` overlaps ${collision.paneId} (${collision.imageId})`);
    return;
  }

  // ONE pane per host, refused explicitly rather than half-accepted.
  //
  // The state a pane owns is per-pane throughout: the registry keys it, `frame-context.cjs` holds
  // the frame pipeline, `pane-windows.cjs` holds the window/tab/rate/surface state, and each has
  // a test asserting two panes share nothing. What is NOT yet per-pane is the window and tab
  // plumbing that builds on them — `createTab`, `activateTab`, the tab-keyed maps and the input
  // dispatch still reach for the sole window context — so a second attach would be recorded and
  // would then draw into the first pane's window.
  //
  // Refusing is the only honest answer to that. A records-only accept is the one unacceptable
  // outcome of this work: the supervisor counts the attach, the frontend stops falling back, and
  // the pane sits blank with every check green. A refusal keeps that frontend's own engine, which
  // is a working browser.
  if (paneRegistry.size > 0) {
    console.error(`tweb: refusing ATTACH for ${command.paneId}: this host serves one pane`);
    return;
  }
  if (!hostReady) {
    console.error(`tweb: refusing ATTACH for ${command.paneId}: the host is not started yet`);
    return;
  }

  let record;
  try {
    record = createPaneRecord({
      tmuxServer: command.tmuxServer,
      paneId: command.paneId,
      generation: command.generation,
      tty: command.tty,
      imageId: command.imageId,
      viewport: command.viewport,
      origin: command.origin ?? null,
      // A pane starts hidden and is revealed by its frontend's VIS push. Assuming visible would
      // have it paint into a pane nobody is looking at — and with tmux `allow-passthrough=all`,
      // into whatever window the client IS looking at.
      visible: false,
    });
  } catch (error) {
    console.error(`tweb: refusing ATTACH for ${command.paneId}: ${error.message}`);
    return;
  }

  const { superseded } = paneRegistry.attach(record);
  if (superseded) closePane(superseded, "superseded");

  const frames = createFrameContext(record, { frameRate: command.frameRate });
  frameContexts.set(record.key, frames);
  if (command.viewport) applyFrameViewport(frames, command.viewport, command.origin);

  // The socket is named after the PANE. A daemon-started engine's own `TMUX_PANE` is the
  // daemon's — measured claiming `agent-%304.sock`, a name in an unrelated pane's namespace.
  const server = startAgentServer({
    paneId: record.paneId,
    dispatch: handleAgentCommand,
    log: (message) => {
      if (debugLogging) console.error(`tweb: ${message}`);
    },
  });
  record.agentSocketPath = server.path;
  paneAgentServers.set(record.key, server);
  writeProtocolLine(formatOutbound("AGENT", record.paneId, server.path));

  const url = normalizeUrl(command.url || "https://example.com");
  // Everything below this line is the shipping path, run for the attached pane: the same
  // `applyViewport`, the same `createWindow`, the same input and agent handling. It reaches the
  // right pane because every one of them takes the record and the frame context, which is what
  // the extraction was for. What it does NOT yet do is run twice — see the refusal above.
  if (command.viewport) applyViewport(command.viewport, command.origin ?? null, frames, record);
  createWindow(url, frames);
  markInteractionActivity();

  console.error(`tweb: hosting ${record.paneId} generation=${record.generation}`
    + ` image=${record.imageId} tty=${record.tty || "-"} url=${url}`);
}

/** Tears a pane down: its window, its writer, its socket and its image on the terminal. */
function closePane(record, reason) {
  const frames = frameContexts.get(record.key);
  if (frames) {
    try {
      terminalCleanup(record);
    } catch (error) {
      void error;
    }
    frameContexts.delete(record.key);
  }
  const server = paneAgentServers.get(record.key);
  if (server) {
    server.close();
    paneAgentServers.delete(record.key);
  }
  const writer = paneWriters.get(record.key);
  if (writer) {
    void writer.close();
    paneWriters.delete(record.key);
  }
  paneRegistry.detach(record.key);
  // Before the registry forgets it, since the id is how its files are named. A host serving
  // panes for hours would otherwise accumulate the frames of every pane it has ever served —
  // up to 20MB each, and the startup sweep only collects files whose *engine* is gone.
  cleanupPaneFrameFiles(record);
  if (debugLogging) console.error(`tweb: closed ${record.paneId}: ${reason}`);
}

let controlBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  controlBuffer += chunk;
  for (;;) {
    const newline = controlBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = controlBuffer.slice(0, newline).trim();
    controlBuffer = controlBuffer.slice(newline + 1);

    // Parsed by `pane-control.cjs`, and addressed lines resolve through the registry. An
    // unaddressed line means "the implicit sole pane", which is what the shipping frontend has
    // always meant by it — so a frontend that never learns the `@%N` prefix keeps working.
    const command = parseControlLine(line);
    if (!command) continue;

    // ATTACH is dispatched before resolution, because resolution is what it *creates*: the pane
    // it names is by definition not registered yet, so `resolveTarget` answers null for it and
    // the line would be dropped in silence. Left below the guard — which is where it sat — a
    // perfectly well-formed attach did nothing at all, with no error and no log.
    if (command.kind === "attach") {
      handleAttach(command);
      continue;
    }

    // A line addressed to a pane this runtime does not hold is dropped rather than applied to
    // whichever pane happened to be first. With one registration the sole pane always resolves.
    const target = resolveTarget(command, paneRegistry, tmuxServerIdentity);
    if (!target) continue;

    // A detach carrying a stale generation is a message from a pane that has already been
    // replaced, and `resolveTarget` has already turned that into a miss rather than delivering
    // it to the successor.
    if (command.kind === "detach") {
      closePane(target, "detached");
      continue;
    }

    if (command.kind === "resize") {
      markInteractionActivity();
      // An absent origin means "leave the anchor where it is". Normalising it to 0,0 would
      // re-anchor the pane at the window's top-left, i.e. draw it over its neighbours.
      applyViewport(command.viewport, command.origin === undefined ? currentFrames().origin : command.origin);
      continue;
    }

    // The frontend's pane visibility push — see the pane visibility section. It is not
    // interaction, so unlike RESIZE/INPUT it deliberately does not mark activity: a
    // client attaching elsewhere must not count as someone using this pane.
    if (command.kind === "visibility") {
      applyVisibilityPush(command.hex);
      continue;
    }

    if (command.kind === "input") {
      markInteractionActivity();
      if (rawInputFlushTimer) {
        clearTimeout(rawInputFlushTimer);
        rawInputFlushTimer = null;
      }
      // The escape sequence's raw bytes. Being pre-decoding, it separates "the
      // terminal never sent it" from "it arrived but was not understood" — this log
      // is how tmux re-encoding ESC[5020~ into ESC[91;3u5020~ was found. Logging
      // ordinary typing too would drown it, so only sequences are kept.
      if (debugLogging && command.hex.startsWith("1b")) {
        console.error(`tweb: input ${command.hex}`);
      }
      rawInput = Buffer.concat([rawInput, Buffer.from(command.hex, "hex")]);
      consumeRawInput();
    }
  }
});
process.stdin.resume();

// --- app lifecycle ---

app.on("browser-window-created", (_event, window) => keepWindowHidden(window));

app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.hide();
  // A supervisor started this process to host panes, and this build cannot yet. Say so and
  // stop, rather than doing what a per-pane engine would do next.
  //
  // What a per-pane engine does next is the failure mode, not a harmless one: it would open its
  // own default page and paint it — into stdout, which here is the supervisor's control pipe
  // rather than any terminal. The requesting pane stays blank while megabytes of graphics go
  // into a line parser. The supervisor kills an engine that has not declared itself within
  // READY_TIMEOUT and every frontend falls back to spawning its own engine, which works; this
  // exits first so nothing is painted anywhere in the meantime.
  //
  // TWEB_HOST_PREVIEW is how the page host is exercised before the gate opens. It runs the hosted
  // path for real — attach, per-pane record, per-pane writer, frames out as addressed events —
  // WITHOUT declaring the protocol, so `twebd` still refuses and every frontend still falls back.
  // The harness in `bench/t1-host-harness.py` sets it; nothing else does, so no shipping path can
  // reach the host until `hostProtocolVersion()` stops returning null.
  const hostPreview = process.env.TWEB_HOST_PREVIEW === "1";
  if (hostedRuntime && hostProtocolVersion() === null && !hostPreview) {
    console.error("tweb: started as a pane host, but this build has no page host — exiting so"
      + " the supervisor falls back to per-pane engines");
    app.quit();
    return;
  }
  configureDownloads();
  // A backstop, not the mechanism: `browser-window-created` above and the per-tab
  // show/focus/move listeners in `configureTab` are what actually keep a window hidden.
  // This caught anything they missed, twenty times a second, forever — a second is plenty
  // for a safety net whose job is to correct a window nobody can see anyway.
  // Nothing in the OS ties this process to whoever owns it: a frontend killed with SIGKILL,
  // or a supervisor that crashes, cannot send the SIGTERM that normally stops us. The
  // engine then keeps painting into a pane that has moved on — observed drawing a stale page
  // over two other panes for four hours. Quitting through the normal path is what matters
  // here, because that is what deletes the image from the terminal.
  //
  // The owner is resolved once rather than per tick: it cannot change over this process's
  // life, and re-reading it every second only invites the reading to differ from the one the
  // rest of startup used.
  const ownerPid = watchedPid(process.env);
  orphanWatchdog = setInterval(() => {
    if (!isOrphaned(ownerPid, process.ppid)) return;
    clearInterval(orphanWatchdog);
    orphanWatchdog = null;
    console.error("tweb: owner is gone, quitting");
    app.quit();
  }, 1000);
  orphanWatchdog.unref();
  hiddenWindowWatchdog = setInterval(enforceHiddenWindows, 1000);
  hiddenWindowWatchdog.unref();
  enforceHiddenWindows();
  getTmuxPaneOrigin();

  // The first argument after the Electron app path is the URL. A bare host with no scheme is allowed.
  const rawUrl = process.env.TWEB_URL
    || commandLineUrl()
    || "https://example.com";
  const currentUrl = normalizeUrl(rawUrl);

  compactHistory();
  sweepAbandonedFrameFiles();

  // A host has no pane at startup and must not act as though it does: no terminal setup (there is
  // no terminal), no window (there is no url or geometry yet), no visibility poll (the pane it
  // would poll is the daemon's) and no agent socket (a socket named after this process is a name
  // in some other pane's namespace). Everything arrives with the first ATTACH.
  if (hostedRuntime) {
    hostReady = true;
    console.error("tweb: pane host waiting for attach");
    return;
  }

  terminalSetup();
  if (restoreWindowSession) {
    initializeTmuxVisibility();
    createWindow(currentUrl);
  } else {
    createWindow(currentUrl);
    setImmediate(initializeTmuxVisibility);
  }
  markInteractionActivity();
  agentServer = startAgentServer({
    // The pane, not the process. `solePaneId` is this pane's registered identity — the same
    // `%3` on a tmux pane and `pid-<pid>` on a bare terminal that the socket was named after
    // before, so the shipping path's socket name is unchanged. What changes is where it comes
    // from: a host resolves the record first and names each pane's socket after that pane.
    paneId: currentPane().paneId,
    socketOverride: process.env.TWEB_AGENT_SOCKET || null,
    dispatch: handleAgentCommand,
    log: (message) => {
      if (debugLogging) console.error(`tweb: ${message}`);
    },
  });
  currentPane().agentSocketPath = agentServer.path;
  // Chromium startup may reset the terminal modified-key mode after the Rust
  // frontend enabled it. Re-declare it from the PTY-owning parent once startup
  // has settled.
  scheduleTrackedKeyboardModeRestore();
  startAudioCoordination();
  // The resolved settings used to be flashed into tmux's status line at startup, which
  // belongs to the session rather than to this pane. They are reachable where they are
  // asked for instead: `tweb diag` reports `frames.tiers` and the zoom, and the line
  // below goes to the engine log.
  console.error(`tweb: started ${modeLabel()} — toggle Ctrl-; · frame ${adaptiveFrameRate
    ? `adaptive ${idleFrameRate}/${playbackFrameRate}/${maxActiveFrameRate}`
    : `fixed ${maxActiveFrameRate}`}fps`
    + ` · zoom ${Math.round(defaultZoomFactor * 100)}%`);
});

// The frame files one pane owns. The naming rule lives in pane-registry.cjs beside the id
// layout it derives from; this only joins it to the userData directory.
function paneFrameFiles(imageId) {
  return paneFrameFileNames(process.pid, imageId)
    .map((name) => path.join(app.getPath("userData"), name));
}

function removeFrameFiles(paths) {
  for (const filePath of paths) {
    try { unlinkSync(filePath); } catch (error) {
      if (error.code !== "ENOENT" && debugLogging) {
        console.error(`tweb: frame file cleanup failed ${filePath}: ${error.message}`);
      }
    }
  }
}

// A detaching pane drops its files now rather than at process exit: a host that serves panes
// for hours would otherwise hold the frames of every pane it has ever served.
function cleanupPaneFrameFiles(record) {
  const imageId = Number(record?.imageId);
  if (!Number.isSafeInteger(imageId)) return;
  removeFrameFiles(paneFrameFiles(imageId));
}

function cleanupFrameFiles() {
  const panes = paneRegistry.list();
  const ids = new Set(panes.map((record) => Number(record.imageId)).filter(Number.isSafeInteger));
  // `solePane` is not in the registry on the hosted path and is on the default one, so it is
  // added by id: a set means naming it twice costs nothing and forgetting it would leak.
  if (Number.isSafeInteger(Number(solePane?.imageId))) ids.add(Number(solePane.imageId));
  removeFrameFiles([...ids].flatMap(paneFrameFiles));
}

// The above only removes this engine's own files, and only if it reaches its exit path. An
// engine that is SIGKILLed — or orphaned, which is the case `orphan-watch.cjs` exists for —
// leaves its last whole frame behind at up to 20MB, and nothing collects it. Observed: four
// abandoned files in a real userData directory, the oldest five hours old.
//
// Sweeping at startup rather than on a timer: the files are named after the pid that wrote
// them, so a dead one stays collectable indefinitely, and doing it once means never racing
// a sibling that is mid-write.
function sweepAbandonedFrameFiles() {
  const directory = app.getPath("userData");
  let names;
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (debugLogging) console.error(`tweb: frame sweep failed: ${error.message}`);
    return;
  }
  let removed = 0;
  for (const name of abandonedFrameFiles(names, process.pid, processAlive)) {
    try {
      unlinkSync(path.join(directory, name));
      removed += 1;
    } catch (error) {
      if (error.code !== "ENOENT" && debugLogging) {
        console.error(`tweb: frame sweep failed ${name}: ${error.message}`);
      }
    }
  }
  if (removed > 0) console.error(`tweb: swept ${removed} frame files from dead engines`);
}

app.on("window-all-closed", () => {
  if (!quitting) app.quit();
});

app.on("before-quit", () => {
  if (agentServer) {
    agentServer.close();
    agentServer = null;
  }
  // A clean exit hands audio back immediately rather than making the survivors wait out
  // the TTL. The TTL is what covers the exit that is not clean.
  if (audioTimer) {
    clearInterval(audioTimer);
    audioTimer = null;
  }
  clearAudioClaim();
  if (hiddenWindowWatchdog) {
    clearInterval(hiddenWindowWatchdog);
    hiddenWindowWatchdog = null;
  }
  if (windowSessionSaveTimer) {
    clearTimeout(windowSessionSaveTimer);
    windowSessionSaveTimer = null;
  }
  writeWindowSession();
  quitting = true;
  mouseClicks.reset();
  if (currentFrames().pendingFrameTimer) {
    clearTimeout(currentFrames().pendingFrameTimer);
    currentFrames().pendingFrameTimer = null;
    currentFrames().pendingFrame = null;
  }
  currentFrames().pendingGfxFrame = null;
  void gfxWorker.terminate();
  cleanupFrameFiles();
  if (debugLogging && currentFrames().droppedGfxFrames > 0) {
    console.error(`tweb: dropped ${currentFrames().droppedGfxFrames} superseded graphics frames`);
  }
  for (const tab of soleWindows.tabs) {
    if (!tab.isDestroyed()) tab.webContents.stopPainting();
  }
  restoreTmuxPassthroughClients();
  terminalCleanup();
  for (const tty of visibleClientTtys) deleteImageFromClientTty(tty);
  restorePaneTitle();
});

// Delete the image on process exit too (safety net).
process.on("exit", () => {
  cleanupFrameFiles();
  // The delete that takes each pane's image off the terminal. An exit handler cannot await, so
  // this only works because every pane writer has a synchronous sink — see `fdSink`. Give a
  // writer an async sink and these deletes are dropped, stranding the images.
  for (const record of paneRegistry.list()) {
    try {
      writeGfx(`a=d,d=I,i=${record.imageId}`, "");
    } catch (e) {}
  }
});
