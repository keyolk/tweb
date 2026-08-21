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
const { AsyncLocalStorage } = require("node:async_hooks");
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
  interactionRate,
  PLAYBACK_BYTE_BUDGET,
} = require("./frame-rate-policy.cjs");
const { isOrphaned, watchedPid, abandonedFrameFiles } = require("./orphan-watch.cjs");
const {
  surfacePlan, surfaceResizeNeeded, paintingTransition, agentNeedsGeometry, restoredLayoutScript,
} = require("./surface-policy.cjs");
const { pressEvents } = require("./agent-key.cjs");
const { pdfKeyAction, pdfViewportScript, findPdfFrame } = require("./pdf-frame.cjs");
const { recoveryDecision } = require("./renderer-recovery.cjs");
const { IDLE: FIND_IDLE, findStep, endStep } = require("./find-session.cjs");
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
  claimIsReleasable,
  claimWindowSessionSlot,
  isRestorableUrl,
  normalizeWindowSession,
  windowSessionForSave,
} = require("./window-session.cjs");
const {
  parseHistoryLines,
  historyDays,
  removeEntries,
  appendedSince,
  compactLines,
} = require("./history-view.cjs");
const {
  extensionsDir,
  loadExtensions,
  watchServiceWorkers,
} = require("./extensions.cjs");
const { extensionReport } = require("./extension-report.cjs");
const { createPaneWriter, fdSink, channelSink } = require("./frame-writer.cjs");
const { serverIdentityFrom, paneKey } = require("./pane-identity.cjs");
const {
  PaneRegistry, createPaneRecord, applyVisibility: recordVisibility,
  applyFrameTier: recordFrameTier, applySurface: recordSurface, applyAudio: recordAudio,
  audioOwnerAmong, paneImageIds, collidingImageRange, PATCH_ID_COUNT,
} = require("./pane-registry.cjs");
const { paneFrameFileList, runTeardown } = require("./teardown.cjs");
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
const {
  transferSummary, downloadRecord, parseDownloadLines, downloadRows, printFilename,
  printShimScript, SETTLED_HOLD_MS,
} = require("./download-state.cjs");
const {
  completionScope, expandHome, completionEntries, completedInput, chosenPaths,
} = require("./file-chooser.cjs");

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
// The shortcut mode is per-pane, on the input state beside the parse buffer it steers. A user
// switching one pane to passthrough is saying it about THAT pane's page; shared, one Ctrl-;
// re-routed every pane's keys at once, and a pane in insert mode made every other pane's typing go
// native. Same for the insert-mode mirror below.
// Pane visibility lives in the registry record, not in a variable beside it. It is the gate on
// frame send, frame rate, and the surface plan — and on a terminal with tmux
// `allow-passthrough=all`, which forwards a hidden pane's passthrough to whatever window the
// client is actually viewing, it is the only thing between a hidden pane and drawing over the
// user's visible one. A second copy of it is therefore the one piece of state that must not exist.

const passthroughClientTables = new Map();

// Where this pane lives *right now* is `vis().placement`, on the pane's record. `sess().identity`
// above is the startup identity and stays pinned because the window-session save path is derived
// from it, but a pane moves: `break-pane` gives it a new window id and `join-pane` can change its
// session too. Matching clients against the startup window then fails for every client, the pane
// looks hidden, and painting stops — the pane freezes after being moved. Visibility therefore
// tracks the live placement instead.
let originalPaneTitle = null;
const tabFrames = new Map();
const tabZoomFactors = new Map();
const tabSessionUrls = new Map();
// The pane a tab belongs to. Every event a tab emits — paint above all — arrives with the tab and
// nothing else, so this is what turns that into a pane. Read at fire time and never captured when a
// handler is registered: `configureTab` runs before `adoptTab` records the mapping.
const tabPanes = new Map();
// Recovery attempts per tab, so a page that crashes its renderer on every load stops being
// reloaded instead of looping forever. See renderer-recovery.cjs.
const tabRendererRecoveries = new Map();
// Shared on purpose, and shared BEYOND this process: `historyPath` is one file per user-data
// directory that every pane and every engine appends to under a lock, because history is the user's,
// not the pane's. See `historyLockPath`.
const navigationHistory = [];
let navigationSerial = 0;
// This pane's window-session state, on its record — see `createPaneRecord` for why it cannot be one
// set of module variables once a host serves panes in different tmux windows.
function sess() {
  return currentPane().session;
}
// Deliberately not per-pane, because in a host it is never set: `resolveWindowSessionPaths` runs only
// where `sess().identity` was built from the process's own `$TMUX_PANE`, and `ownTmuxPane` is null for a
// hosted runtime. So `writeWindowSession` returns on its first guard and a host saves no session at
// all. Restoring per-pane sessions in a host needs the claim to key off the ATTACH identity rather
// than the process — a separate piece of work, and one that has to arbitrate against the per-pane
// engines that may still hold those slots.

let windowSessionSaveTimer = null;
let hiddenWindowWatchdog = null;
let orphanWatchdog = null;
let agentServer = null;
// Set while a close came from the tab list, so the list can be redrawn once the
// tab has actually left `soleWindows.tabs`.
let refreshTabListAfterClose = false;
// Electron logs an ipcNative error when frame.send races preload setup or navigation.
// A frame opts in only after its preload has installed all IPC listeners.
const readyFrameKeysByTab = new WeakMap();
// Context-menu URLs come from Chromium's hit test, not renderer input. Keep them
// here so a compromised page can only choose among the actions we displayed.
const contextMenuStateByTab = new WeakMap();
// Whether Chromium currently holds an open find session for a tab. See find-session.cjs:
// the renderer emits nothing at all for a follow-up request with no session behind it.
const findSessionByTab = new WeakMap();
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
const playbackWindow = playbackWindowMs(idleFrameRate);
// The window/tab and frame-rate state for this pane. Like the frame context, the shipping path
// has exactly one and runs through it — the ceiling is per-pane because a host serves panes
// launched with different `--tweb-frame-rate` settings, and because the adaptive tiers are decided
// by counting THAT pane's paints.
const soleWindows = createPaneWindows({
  maxFrameRate: maxActiveFrameRate,
  adaptive: adaptiveFrameRate,
});
// One window context per pane, keyed like `frameContexts` and for the same reason. What lives in
// here is not only the window: `frameIdleTimer`, `activeFrameRate` and `paintsSinceSettle` are
// the adaptive frame-rate state, and sharing those across panes would let one pane's video pull
// another pane's rate up — the tiers are decided by counting THAT pane's paints.
//
// The sole pane's entry IS `soleWindows`, so the single-pane path that ships resolves to the same
// object it always did rather than to a copy of it.
const paneWindows = new Map();

/**
 * The window context a pane owns, created on first use.
 *
 * Keyed rather than assumed, exactly as `frameContextFor` is. A window resolved for the wrong
 * pane does not fail loudly — it draws one pane's page into another pane's rectangle, which is
 * the hazard `attachPane` refuses a second pane to avoid.
 */
function windowsFor(record) {
  const key = record?.key;
  if (!key) return soleWindows;
  const existing = paneWindows.get(key);
  if (existing) return existing;
  // Per-pane rates, not the process's: a hosted engine serves panes whose frontends were launched
  // with different `--tweb-frame-rate` settings.
  const created = createPaneWindows({
    maxFrameRate: maxActiveFrameRate,
    adaptive: adaptiveFrameRate,
  });
  paneWindows.set(key, created);
  return created;
}

/** The window context for the pane a bare call means — the same rule `currentFrames` uses. */
function currentWindows() {
  return windowsFor(currentPane());
}
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

// Which pane the code currently running belongs to.
//
// A host serving N panes has to answer that at roughly 240 call sites, and threading a parameter
// through all of them is not the shape of the problem: the frame-rate policy defers with
// `setTimeout(settleFrameRate, 700)` and settles with no tab in hand, the agent surface path
// resumes after an `await`, and `setWindowOpenHandler` opens a tab from a `setImmediate`. None of
// those callbacks has a pane argument to receive.
//
// So the pane travels with the execution instead. Verified under Electron 43 rather than assumed:
// a `paint` handler registered outside any store reads `undefined` (native emit captures nothing at
// registration, which is why every entry point below binds explicitly), a store established inside
// the handler survives both a `setTimeout` and an `await` continuation, and a timer bound to a
// second pane reads that second pane — not the first.
//
// `run` and never `enterWith`: the latter leaks into the rest of the tick, which for an event
// dispatch means into whatever the emitter does next.
const paneScope = new AsyncLocalStorage();

/**
 * Runs `fn` as work belonging to `record`.
 *
 * `record` may be resolved lazily by passing a function, because a tab's pane is not always known
 * when a handler is registered — `configureTab` runs before `adoptTab` records the mapping.
 */
function withPaneScope(record, fn) {
  const resolved = typeof record === "function" ? record() : record;
  if (!resolved) return fn();
  return paneScope.run(resolved, fn);
}

/**
 * Runs `fn` once per hosted pane, each time in that pane's scope.
 *
 * For the process-wide work that is really per-pane work N times: the hidden-window watchdog
 * reconciles every window every second, and the quit path tears down every pane. Both used to run
 * once against whichever pane was first, which for the watchdog meant reconciling pane 2..N's tabs
 * against pane 1's visibility and frame rate — 84 fallback resolutions in a 15s three-pane run.
 */
function forEachPane(fn) {
  if (!hostedRuntime) return void fn(solePane);
  const records = paneRegistry.list();
  if (records.length === 0) return void withPaneScope(solePane, () => fn(solePane));
  for (const record of records) withPaneScope(record, () => fn(record));
}

/** Wraps a handler so every call runs in its pane's scope. Registration order does not matter. */
function bindPane(resolve, handler) {
  return function boundToPane(...handlerArgs) {
    return withPaneScope(() => resolve(...handlerArgs), () => handler.apply(this, handlerArgs));
  };
}

// A pane the ambient scope could not name, in a host that serves more than one. Every such
// resolution silently falls back to the first pane, which is the bug this whole change removes —
// so it is counted and reported by `diag` rather than left to be discovered as one pane's input
// occasionally landing in another. An entry point nobody bound shows up here.
let unscopedPaneResolutions = 0;
const loggedUnscopedSites = new Set();
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
// The sole pane's window context is registered under its key, so `windowsFor` returns the very
// object the single-pane path has always used instead of creating a second one beside it.
paneWindows.set(solePane.key, soleWindows);

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
/**
 * The file descriptor this pane's bytes go to, or null when they travel over the host channel.
 *
 * A HOSTED pane always answers null, whatever `record.tty` says. That field carries the pane's tty
 * PATH — `/dev/ttys013` — and it is diagnostics only: the protocol says so, and the reason is the
 * one `hostedFrameSink` records below. An engine that wrote there would be a second writing
 * *process* on that pty, racing the frontend's own caret, alternate-screen and keyboard writes,
 * and `createPaneWriter` serialises within one process only.
 *
 * It used to be returned as if it were a descriptor, and `writeSync` rejected it every time:
 * `The "fd" argument must be of type number. Received type string ('/dev/ttys013')`. Every frame
 * for every hosted pane failed, the engine exited, and the pane fell back to spawning its own —
 * so the daemon path cost a full engine startup and then did what it had always done. It survived
 * because no harness sent a tty: they all pass `None`, which took the null branch, and only the
 * real frontend fills the field in.
 */
function paneOutputFd(record) {
  if (hostedRuntime) return null;
  return typeof record.tty === "number" ? record.tty : 1;
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
  if (!hostedRuntime) return solePane;
  const scoped = paneScope.getStore();
  if (scoped) return scoped;
  // Falling back to the first pane is right for exactly one pane and wrong for two, so say so.
  if (paneRegistry.size > 1) {
    unscopedPaneResolutions += 1;
    if (debugLogging) {
      const stack = new Error("unscoped").stack.split("\n").slice(1, 5).join("\n");
      if (!loggedUnscopedSites.has(stack)) {
        loggedUnscopedSites.add(stack);
        console.error(`tweb: pane resolved with no scope\n${stack}`);
      }
    }
  }
  return paneRegistry.list()[0] || solePane;
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
// Shared on purpose: it dedupes ONE log line per frame generation. N panes bump each other's value,
// so a host logs that line less often than it could — the cost of getting this wrong is log noise.
let loggedFrameGeneration = -1;
// Whole frames the worker deflated, against `whole` for the total. The ratio is the only outside
// view of the sampling decision in `gfx-worker.cjs`: 0 on a text-heavy page means compression
// silently stopped engaging, which shows up as dropped frames long before anything says why.
//
// Per pane, on the frame context, because a host serves N and the ratio is only meaningful against
// THAT pane's `whole`. As a module-level counter it summed every pane's compressions and reported
// the sum to each of them: two panes with wildly different content both read 473, which reads as
// a working ratio for the idle pane and hides the sampling decision for the playing one.
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
  const passthroughArmed = !inputState().vimium;

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
      sess().identity = {
        socketPath,
        serverStartedAt,
        session,
        windowId,
        windowIndex,
        paneId: ownTmuxPane,
      };
      resolveWindowSessionPaths();
      vis().placement = { session, windowId, paneId: ownTmuxPane };
    }
    originalPaneTitle = titleParts.join("\t");

    if (vis().placement) {
      const clients = execFileSync(
        "tmux",
        ["list-clients", "-F", "#{client_tty}\t#{client_session}\t#{window_id}\t#{window_zoomed_flag}\t#{pane_id}"],
        { encoding: "utf8", timeout: 1000 }
      );
      vis().clientTtys = visibleTmuxClientTtys(clients, vis().placement);
      recordVisibility(currentPane(), vis().clientTtys.size > 0);
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

// This pane's visibility state, which lives on its record — see `createPaneRecord` for why it is
// not one set of module variables. Every read below goes through here so the ambient pane decides
// which pane's placement, clients and poll timer are meant.
function vis() {
  return currentPane().visibility;
}

function armVisibilityFallback() {
  if (!ownTmuxPane) return;
  const delay = process.env.TWEB_FRONTEND_PID ? VISIBILITY_PUSH_GRACE_MS : 0;
  vis().fallbackTimer = setTimeout(() => {
    vis().fallbackTimer = null;
    if (vis().source === "push") return;
    vis().source = "poll";
    if (debugLogging) console.error("tweb: visibility falling back to polling tmux");
    scheduleVisibilityCheck();
  }, delay);
  vis().fallbackTimer.unref();
}

function scheduleVisibilityCheck() {
  if (vis().pollTimer) clearTimeout(vis().pollTimer);
  vis().pollTimer = setTimeout(() => {
    vis().pollTimer = null;
    syncTmuxVisibility();
    scheduleVisibilityCheck();
  }, VISIBILITY_POLL_MS);
  vis().pollTimer.unref();
}

// Applies a client listing to this pane. Shared by the push and the fallback poll so the
// two cannot drift — the tty bookkeeping below is the part that has to stay identical.
function applyClientListing(clients, placement) {
  vis().placement = placement;
  const next = visibleTmuxClientTtys(clients, vis().placement);
  const wasVisible = currentPane().visible;
  // A client that stopped showing this pane keeps the image placed on it, so the delete
  // goes to that tty directly.
  for (const tty of vis().clientTtys) {
    if (next.has(tty)) continue;
    // Logged because it is a pane going blank, and the two reasons for it are indistinguishable
    // from the outside: a client that really stopped showing this pane, or this pane reading
    // another pane's client set and evicting itself from a terminal still watching it. That second
    // one is what per-pane visibility state exists to prevent, and `bench/host-multipane.py`
    // gates on this line.
    if (debugLogging) {
      console.error(`tweb: image evicted from ${tty} for ${currentPane().paneId}`);
    }
    deleteImageFromClientTty(tty);
  }
  const becameVisible = [...next].some((tty) => !vis().clientTtys.has(tty));
  vis().clientTtys = next;
  const changed = recordVisibility(currentPane(), next.size > 0);
  if (changed) {
    updatePaintingState();
    // Logged unconditionally, not behind `debugLogging`. A pane that goes hidden and does
    // not come back is invisible from the outside — no frames arrive, and every other
    // symptom (a strip of stale image, a dead-looking page) is downstream of this one line.
    // The placement and the client set go with it because "hidden" has two very different
    // causes: no client is watching, or this pane resolved to the wrong window.
    console.error(`tweb: visibility ${changed.visible ? "visible" : "hidden"}`
      + ` ttys=${[...next].join(",") || "none"} source=${vis().source}`
      + ` placement=${vis().placement?.session}:${vis().placement?.windowId}:${vis().placement?.paneId}`);
  }
  if (becameVisible) repaintActiveTab();
}

// The frontend's push. It carries the client key tables too, so the passthrough
// reconcile runs off the same data instead of spawning its own `list-clients`.
function applyVisibilityPush(hex) {
  const push = parseVisibilityPush(hex);
  if (!push) return;
  if (vis().fallbackTimer) {
    clearTimeout(vis().fallbackTimer);
    vis().fallbackTimer = null;
  }
  if (vis().pollTimer) {
    clearTimeout(vis().pollTimer);
    vis().pollTimer = null;
  }
  vis().source = "push";
  vis().pushedAt = Date.now();
  if (debugLogging
    && (push.placement.session !== vis().placement?.session
      || push.placement.windowId !== vis().placement?.windowId)) {
    console.error(
      `tweb: pane moved ${vis().placement?.session}:${vis().placement?.windowId}`
      + ` -> ${push.placement.session}:${push.placement.windowId}`
    );
  }
  applyClientListing(push.clients, push.placement);
  reconcileTmuxPassthrough(push.states);
}

function syncTmuxVisibility() {
  if (!vis().placement || vis().checkRunning) return;
  vis().checkRunning = true;
  // Re-resolve where the pane is before matching clients. A pane that was moved
  // by break-pane/join-pane keeps its id but changes window (and possibly
  // session); matching against a stale window makes every client miss and the
  // pane look hidden, which stops painting until the process restarts.
  execFile(
    "tmux",
    ["display-message", "-p", "-t", vis().placement.paneId, "#{session_name}\t#{window_id}"],
    { encoding: "utf8", timeout: 1000 },
    (placementError, placementOut) => {
      let placement = vis().placement;
      if (!placementError) {
        const [session, windowId] = String(placementOut).trim().split("\t");
        if (session && windowId) placement = { ...vis().placement, session, windowId };
      }
      // The flag is cleared in the inner callback. If spawning it throws, clear
      // it here instead — otherwise visibility polling stops for good.
      try {
        execFile(
          "tmux",
          ["list-clients", "-F", "#{client_tty}\t#{client_session}\t#{window_id}\t#{window_zoomed_flag}\t#{pane_id}"],
          { encoding: "utf8", timeout: 1000 },
          (error, stdout) => {
            vis().checkRunning = false;
            if (error) return;
            // A push can land while this poll is still in flight: clearing the timer
            // does not recall an execFile already running. Its answer predates the
            // push, so applying it would put the engine back on stale state that
            // nothing corrects until the next change.
            if (vis().source === "push") return;
            applyClientListing(stdout, placement);
            reconcileTmuxPassthrough();
          }
        );
      } catch (spawnError) {
        vis().checkRunning = false;
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
  if (currentWindows().win && !currentWindows().win.isDestroyed() && currentPane().visible) currentWindows().win.webContents.invalidate();
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
  // Counted after the routing, not before it: the key is what says whose compression this was,
  // and a count taken above would land on whichever pane happened to ask for its diag.
  if (message?.type !== "error" && message?.compressed) frames.compressedWholeFrames += 1;
  // Scoped to the pane the completion belongs to: dispatching the queue reads the frame-rate state
  // and the window, and doing that against another pane's is how one pane's frame lands in
  // another's rectangle.
  withPaneScope(frames.record, () => {
    handleGfxWorkerReady(message?.commands, frames);
  });
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
  inputState().caretHidden = true;
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

function applyActiveFrameRate(rate, windows = currentWindows(), record = currentPane()) {
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
  const wasIdle = isThrottled(currentWindows());
  // Capped while the page is painting on its own. Without this the playback budget holds only
  // between interactions: a hover, a resize, or the `isLoading` branch below hands the pane the
  // full rate for the next 700ms, which on a large pane is more than twice the bytes the tier
  // exists to bound. `invalidate()` below is what makes an interaction feel immediate, and it
  // still runs — the rate only decides what happens after that first paint.
  applyActiveFrameRate(interactionRate(currentWindows().settledPainting, currentPlaybackTiers()));
  if (wasIdle && currentWindows().win && !currentWindows().win.isDestroyed() && currentPane().visible) currentWindows().win.webContents.invalidate();
  if (currentWindows().frameIdleTimer) clearTimeout(currentWindows().frameIdleTimer);
  // The paints this interaction is about to cause say nothing about whether the page
  // paints on its own, which is the only thing the settle decides — so the count starts
  // fresh. It does not need a handicap beyond that: over a 700ms window, echoing a
  // keystroke is one or two paints while an animating page is dozens, and the threshold
  // sits between them.
  currentWindows().paintsSinceSettle = 0;
  currentWindows().frameIdleTimer = setTimeout(settleFrameRate, 700);
}

// Where the rate lands once the active window expires: the playback rate while the page is
// still painting by itself, the idle rate once it stops. Re-armed rather than left alone,
// so a video that ends drops the rest of the way and a static page that starts an animation
// picks up without needing a keystroke.
function settleFrameRate() {
  currentWindows().frameIdleTimer = null;
  // Dropping the rate while a page is still loading stops offscreen painting
  // almost entirely: measured on google.com, the page committed at 1.4s and the
  // next frame did not go out until 5.4s. Stay at the active rate until the load
  // settles — that is precisely when the screen is changing anyway.
  if (currentWindows().win && !currentWindows().win.isDestroyed() && currentWindows().win.webContents.isLoading()) {
    markInteractionActivity();
    return;
  }
  // Judge against the paints that arrived over the window just ended, then reset the
  // count. Reading a timestamp instead would count the paint that changing the rate
  // itself provokes, and a static page would hold the playback rate forever.
  //
  // The tiers are resolved here rather than at startup because the playback rate depends on
  // how large this pane is right now, and a pane is resized freely while it runs. A resize
  // during playback is picked up at the next settle — within the 1.5s window — which is soon
  // enough for a bound on bytes and avoids a second path that recomputes the rate mid-frame.
  const settled = settledFrameRate(currentWindows().paintsSinceSettle, currentPlaybackTiers());
  currentWindows().paintsSinceSettle = 0;
  // Remembered for the interaction path, which has no paint count of its own to judge from.
  currentWindows().settledPainting = settled.painting;
  applyActiveFrameRate(settled.rate);
  if (settled.painting) {
    currentWindows().frameIdleTimer = setTimeout(settleFrameRate, playbackWindow);
  }
}

// The tiers for THIS pane at its current size.
//
// `frameRates` is the startup shape, computed before any viewport exists; this is the one that
// bounds the bytes. Per pane because a host serves panes of different sizes, and a rate derived
// from another pane's area is exactly the crossing this engine is careful about elsewhere.
function currentPlaybackTiers() {
  const viewport = currentFrames().viewport;
  if (!viewport) return frameRates;
  const size = renderedFrameSize(viewport);
  return frameRateTiers(maxActiveFrameRate, adaptiveFrameRate, size.width * size.height);
}

// A page can start painting long after the last keystroke — a video begins, an animation
// runs — and at the idle rate nothing would raise it again. Arm the timer so the next
// settle sees the paints and moves up to the playback rate.
function notePaintActivity() {
  currentWindows().paintsSinceSettle += 1;
  if (!adaptiveFrameRate || currentWindows().frameIdleTimer) return;
  if (currentWindows().activeFrameRate >= currentPlaybackTiers().playback) return;
  currentWindows().frameIdleTimer = setTimeout(settleFrameRate, playbackWindow);
}

// A placement the next frame will not fully cover has to be deleted, but the
// delete is paired with the replacement so the pane is never left bare: on its
// own it would bare the terminal for as long as the frame takes to arrive.
// The terminal holds the last image we transferred under `imageId`, which lets a
// resize re-place it without sending the pixels again.

// Every placement this pane makes carries this id. A put with no `p=` is an *anonymous*
// placement, and the protocol adds one each time rather than replacing the last: "Not
// specifying a placement id or using p=0 for multiple put commands (a=p) with the same
// non-zero image id results in multiple placements of the image." A resize re-places the
// base image, so each one stacked another copy at a different cell box, and the taller
// ones kept showing below the pane. Placements are keyed by (image id, placement id), so
// one fixed id per pane makes every re-place replace rather than accumulate.
//
// It goes on the transmits too, not just the put. An anonymous placement and `p=1` are
// different keys and would coexist: fixing only the put would leave the last whole
// frame's anonymous placement underneath the one the resize just made.
const PLACEMENT_ID = 1;

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
  writeGfx(`a=p,i=${frames.imageIds.base},p=${PLACEMENT_ID},C=1,c=${frames.cells.cols},r=${frames.cells.rows}`
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
  const header = `a=T,f=100,i=${id},p=${PLACEMENT_ID},C=1,c=${place.cols},r=${place.rows}`
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
  const header = `a=T,i=${currentFrames().imageIds.base},p=${PLACEMENT_ID},C=1,`
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
  if (!frame || frame.tab !== currentWindows().win || frame.generation !== currentFrames().generation || !currentPane().visible) return;
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
  if (tab === currentWindows().win) tabFrames.set(tab, { image, generation });
  else tabFrames.delete(tab);
  if (tab !== currentWindows().win || !currentPane().visible) return;
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
  const delay = immediate ? 0 : Math.max(0, currentWindows().frameIntervalMs - elapsed);
  currentFrames().pendingFrameTimer = setTimeout(flushPendingFrame, delay);
}

function repaintActiveTab() {
  if (!currentPane().visible || !currentWindows().win || currentWindows().win.isDestroyed()) return;
  const frame = tabFrames.get(currentWindows().win);
  if (frame && frame.generation === currentFrames().generation && !frame.image.isEmpty()) {
    queueFrame(currentWindows().win, frame.image, true);
    if (debugLogging) console.error("tweb: visibility repaint");
    return;
  }
  currentWindows().win.webContents.invalidate();
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
  return `${index + 1}/${currentWindows().tabs.length} ${title}`;
}

// Two browser panes split into ONE tmux window used to hash to one session file and
// silently overwrite each other's tabs. Each engine now claims a per-window slot and
// keys on it; see window-session.cjs for why a slot rather than the pane id, and for
// the guarantee that slot 0 still hashes exactly as the old key did.
//
// Not gated on TWEB_RESTORE_SESSION: a pane given a URL never restores but still SAVES,
// and it needs its own file to save into just as much.
function resolveWindowSessionPaths() {
  const directory = path.join(app.getPath("userData"), "window-sessions");
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (debugLogging) console.error(`tweb: window session dir failed: ${error.message}`);
  }
  const claim = claimWindowSessionSlot({
    identity: sess().identity,
    directory,
    pid: process.pid,
    // THIS pane's id, not the process's. `ownTmuxPane` is null in a host, and the claim uses the
    // pane id to tell "my own claim" from "another pane's" — so passing null would make every
    // hosted pane in one window look like the same claimant.
    paneId: currentPane().paneId,
    now: Date.now(),
    io: {
      readClaim: (file) => {
        try {
          return readFileSync(file, "utf8");
        } catch (_) {
          return null;
        }
      },
      // "wx" is the whole arbitration: the create fails rather than truncating when
      // another engine got there first, so two panes cannot both believe they claimed.
      createClaim: (file, text) => {
        try {
          writeFileSync(file, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
          return true;
        } catch (_) {
          return false;
        }
      },
      removeClaim: (file) => {
        try { unlinkSync(file); } catch {}
      },
      isAlive: processAlive,
    },
  });
  if (!claim) return;
  sess().path = path.join(directory, `${claim.keys.primary}.json`);
  sess().legacyPath = claim.keys.legacy
    ? path.join(directory, `${claim.keys.legacy}.json`)
    : null;
  sess().claimPath = claim.claimPath;
  if (debugLogging) {
    console.error(`tweb: window session slot ${claim.slot} (claimed=${claim.claimed})`);
  }
}

// The claim file is deleted only by the process named in it, and only on a clean exit.
// A SIGKILLed engine leaves its claim behind, which costs nothing: the next pane in that
// window reads it, finds the pid gone, and takes the slot over. Deleting a claim we do
// not own is the one thing that could hand a LIVE pane's session to a second pane, so
// the pid check is not optional.
function releaseWindowSessionClaim() {
  if (!sess().claimPath) return;
  const claimPath = sess().claimPath;
  sess().claimPath = null;
  try {
    // The pane as well as the pid: a host has N panes on one pid, and releasing by pid alone would
    // let one pane delete a sibling's claim while that pane is still saving into the slot.
    const claimPane = currentPane().paneId;
    if (!claimIsReleasable(readFileSync(claimPath, "utf8"), process.pid, claimPane)) return;
    unlinkSync(claimPath);
  } catch (error) {
    if (error.code !== "ENOENT" && debugLogging) {
      console.error(`tweb: window session claim release failed: ${error.message}`);
    }
  }
}

function writeWindowSessionState(state) {
  if (!sess().path || !state) return;
  const temporaryPath = `${sess().path}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(sess().path), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, sess().path);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    if (debugLogging) console.error(`tweb: window session save failed: ${error.message}`);
  }
}

function readWindowSession() {
  if (!sess().restore || !sess().path) return null;
  for (const candidate of [sess().path, sess().legacyPath]) {
    if (!candidate) continue;
    try {
      const session = normalizeWindowSession(
        JSON.parse(readFileSync(candidate, "utf8")),
        defaultZoomFactor
      );
      if (!session) continue;
      if (candidate !== sess().path) {
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
  if (!sess().path || currentWindows().tabs.length === 0) return;
  const state = windowSessionForSave(currentWindows().tabs.flatMap((tab) => {
    if (tab.isDestroyed()) return [];
    return [{
      url: tabSessionUrls.get(tab) || tab.webContents.getURL(),
      zoom: tabZoomFactors.get(tab) ?? defaultZoomFactor,
    }];
  }), currentWindows().activeTabIndex, defaultZoomFactor);
  // A bare startup used to replace the last useful session with about:blank
  // after 100 ms. Preserve the existing file until a real page commits.
  writeWindowSessionState(state);
}

function scheduleWindowSessionSave() {
  if (!sess().path || quitting) return;
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
  for (const tab of currentWindows().tabs) {
    if (tab.isDestroyed()) continue;
    const plan = surfacePlan(tab === currentWindows().win, currentPane().visible, logicalContentSize(currentViewport()), held, inputState().floating);
    tab.webContents.setBackgroundThrottling(plan.backgroundThrottling);
    tab.webContents.setFrameRate(plan.painting ? currentWindows().activeFrameRate : 1);
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
  // A floating tab is shown on the OS desktop rather than painted into the Kitty graphics
  // channel, so it gets a real window position and opacity rather than the offscreen
  // treatment `keepWindowHidden` applies to every other tab.
  if (plan.floating) {
    if (tab.isVisible()) return;
    // Add to floatingTabs BEFORE setBounds/show: the hidden-window watchdog runs
    // every second and would move this window back offscreen between show() and
    // the next tick. Adding first means keepWindowHidden skips it from that point on.
    floatingTabs.add(tab);
    tab.setOpacity(1);
    tab.setFocusable(true);
    // Centre on the display the pane is on, at the pane's current size. The user can
    // move the window freely afterwards — this is just a sensible default.
    const display = screen.getDisplayMatching(tab.getBounds());
    const bounds = {
      x: Math.round(display.bounds.x + (display.bounds.width - plan.width) / 2),
      y: Math.round(display.bounds.y + (display.bounds.height - plan.height) / 2),
      width: plan.width,
      height: plan.height,
    };
    tab.setBounds(bounds);
    tab.show();
    return;
  }
  // A tab that was floating and is no longer: hide it again and put it back offscreen.
  if (floatingTabs.has(tab) && !plan.floating) {
    floatingTabs.delete(tab);
    keepWindowHidden(tab);
  }
  const size = tab.getContentSize();
  const current = { width: size[0], height: size[1] };
  if (!surfaceResizeNeeded(plan, current)) return;
  // Recorded before the resize, and only for the tab that is this pane's active one: the
  // record's `logical` is the size a restore goes back to, and reading it off a collapsed
  // surface is how the agent API came back with innerHeight=1.
  if (tab === currentWindows().win) {
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

function surfaceHeldForAgent(windows = currentWindows()) {
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
async function withAgentSurface(method, body, windows = currentWindows(), record = currentPane()) {
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
// UNRESOLVED for a host serving N panes. The claim is arbitrated through a file so that separate
// per-pane ENGINES can agree on who owns the speakers, and inside one process these three variables
// are that agreement for all of its panes at once — so pane A going audible mutes pane B by the same
// mechanism that mutes another engine. That may even be what a user wants, but it is not a decision
// this change made, and it needs the claim to distinguish "another process" from "another pane in
// this process" before it can be one. Left shared, and named as unresolved rather than left to be
// discovered.
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
  for (const tab of currentWindows().tabs) {
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
  for (const tab of currentWindows().tabs) {
    if (!tab.isDestroyed()) tab.webContents.setAudioMuted(muted);
  }
}

function broadcastAudioState() {
  for (const tab of currentWindows().tabs) {
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

function installPageEnhancements(tab = currentWindows().win) {
  if (!tab || tab.isDestroyed()) return;
  void tab.webContents.executeJavaScript(`(() => {
    document.getElementById('__tweb_status__')?.remove();
    let style = document.getElementById('__tweb_caret_style__');
    if (!style) {
      style = document.createElement('style');
      style.id = '__tweb_caret_style__';
      // Native scrollbars are drawn by the OS widget, not by the page, so a dark
      // page (dogdrip, most dashboards) gets a white scrollbar from Chromium's
      // light-mode default — a bright strip over dark content. This keeps the
      // track transparent so the page shows through, and draws a thin thumb in a
      // muted tone that reads on both light and dark pages. scrollbar-width:thin
      // is the standards path; the webkit-* rules cover Chromium, which is
      // what this engine is.
      style.textContent = [
        'input,textarea,[contenteditable]:focus{caret-color:#00e5ff!important}',
        '::-webkit-scrollbar{width:8px;height:8px;background:transparent}',
        '::-webkit-scrollbar-track{background:transparent}',
        '::-webkit-scrollbar-thumb{background:rgba(130,130,140,.4);border-radius:4px;border:2px solid transparent;background-clip:padding-box}',
        '::-webkit-scrollbar-thumb:hover{background:rgba(130,130,140,.6);background-clip:padding-box}',
        '::-webkit-scrollbar-corner{background:transparent}',
        '*{scrollbar-width:thin;scrollbar-color:rgba(130,130,140,.4) transparent}',
      ].join('');
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

// Bringing a tab's main frame back into the ready set after it fell out of it.
//
// A renderer crash is recoverable — `render-process-gone` reloads the page and it paints
// again — but the reload's preload sometimes never registers, and then every key is dropped
// while the page looks perfectly fine. Observed on a real pane: `shortcut frames=0 ready=0`
// for minutes after `loaded`, with the user's only recourse being to reload by hand.
//
// The ready set is this file's own bookkeeping, not an Electron restriction: `frame.send()`
// is always allowed and a send with no listener on the other end is harmless. So the repair
// is a ping. A preload that is alive answers it and re-registers itself, which fixes the case
// where only the bookkeeping was lost. Silence past the deadline means there is no preload
// there at all, and the page has to be reloaded to get one.
const RECOVERY_PING_MS = 1200;
// Reloading in a loop would be worse than the defect it repairs: a page that crashes its
// renderer on load would reload forever. `render-process-gone` already has a limiter for
// exactly this; this is the same idea for the path that never raised an event.
const MAX_SHORTCUT_RELOADS = 2;
const shortcutRecoveryByTab = new WeakMap();

function shortcutRecoveryState(tab) {
  let state = shortcutRecoveryByTab.get(tab);
  if (!state) {
    state = { pinging: false, reloads: 0 };
    shortcutRecoveryByTab.set(tab, state);
  }
  return state;
}

// Called from the drop path, so a dropped key is what starts the repair.
function repairShortcutDelivery(tab) {
  const state = shortcutRecoveryState(tab);
  if (state.pinging) return;
  const contents = tab.webContents;
  // A page that is still loading has not had the chance to register yet, and its
  // `tweb-preload-ready` is on the way. Reloading it here would cancel the very navigation
  // that is about to fix things.
  if (contents.isLoading()) return;
  const frame = contents.mainFrame;
  if (!frame || frame.isDestroyed() || frame.detached) return;
  state.pinging = true;
  try {
    frame.send("tweb-are-you-there");
  } catch (error) {
    if (debugLogging) console.error(`tweb: shortcut ping failed: ${error.message}`);
  }
  setTimeout(() => {
    state.pinging = false;
    if (tab.isDestroyed()) return;
    // Answered, and the reply path re-registered the frame. Nothing more to do.
    if (readyFrameKeys(tab).has(frameKey(tab.webContents.mainFrame))) {
      state.reloads = 0;
      return;
    }
    if (state.reloads >= MAX_SHORTCUT_RELOADS) {
      console.error("tweb: shortcuts still undeliverable after"
        + ` ${state.reloads} reload(s); not reloading again`);
      return;
    }
    state.reloads += 1;
    console.error(`tweb: no preload answered; reloading to restore shortcuts (${state.reloads})`);
    tab.webContents.reload();
  }, RECOVERY_PING_MS);
}

// Telling the pane that a page is on its way.
//
// Three things shape this, and together they rule out the ordinary answer of an indeterminate
// animated bar:
//
//   1. Every pixel change here is a frame to the terminal — megabytes of it. A bar that
//      animates would push whole frames continuously for the length of every page load, which
//      is precisely the cost the playback budget exists to bound.
//   2. Continuous painting is also how `settleFrameRate` decides a page is playing video, so
//      an animated indicator would hold the pane at its playback rate while nothing plays.
//   3. A load that finishes in under a second does not need announcing. An indicator that
//      appears and vanishes is noise, and it costs two frames to say nothing.
//
// So: nothing is drawn for the first `LOADING_INDICATOR_DELAY_MS`, and after that the state
// changes only on lifecycle events — two or three paints for a whole load, and a bar that
// grows in steps a person can read as progress.
const LOADING_INDICATOR_DELAY_MS = 250;
const loadingTimersByTab = new WeakMap();

function clearLoadingTimer(tab) {
  const timer = loadingTimersByTab.get(tab);
  if (timer) clearTimeout(timer);
  loadingTimersByTab.delete(tab);
}

// `progress` is 0..1, or null to take the indicator away.
function sendLoadingProgress(tab, progress) {
  clearLoadingTimer(tab);
  if (progress === null) {
    sendToMainTabFrame(tab, "tweb-loading", null);
    return;
  }
  sendToMainTabFrame(tab, "tweb-loading", { progress });
}

// The first step waits, so a fast page never shows anything at all.
function scheduleLoadingProgress(tab, progress) {
  clearLoadingTimer(tab);
  const timer = setTimeout(() => {
    loadingTimersByTab.delete(tab);
    if (tab.isDestroyed()) return;
    sendToMainTabFrame(tab, "tweb-loading", { progress });
  }, LOADING_INDICATOR_DELAY_MS);
  loadingTimersByTab.set(tab, timer);
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
    if (!deliverable) {
      if (debugLogging) {
        console.error(`tweb: dropped ${channel}; shortcut frames=${shortcutFrameKeys(tab).size}`
          + ` ready=${readyFrameKeys(tab).size}`);
      }
      // A dropped key is the signal that delivery is broken — nothing else notices, which
      // is why this went unrepaired until a user reported it.
      repairShortcutDelivery(tab);
      return;
    }
    frame.send(channel, ...args);
  } catch (error) {
    if (debugLogging) console.error(`tweb: focused frame send failed: ${error.message}`);
  }
}

// The preload receives the two flags separately and drives the mode indicator and
// each gate independently.
function broadcastShortcutMode() {
  for (const tab of currentWindows().tabs) {
    sendToTabFrames(tab, "tweb-shortcuts-mode", { vimium: inputState().vimium, bypass: inputState().bypass });
  }
}

// Applies the correct combination of the two flags and runs the follow-up work once.
function applyShortcutMode() {
  inputState().insertMode = false;
  broadcastShortcutMode();
  // Once passthrough is armed (vimium off), focus so the page can receive keys.
  if (!inputState().vimium && currentWindows().win && !currentWindows().win.isDestroyed()) currentWindows().win.webContents.focus();
  // A Ghostty config reload or a pane restart can reset one side only, so reconcile
  // always runs even when the value already matches.
  reconcileTmuxPassthrough();
  updatePaneTitle();
  // The mode belongs to this pane, so it is reported by this pane's in-page indicator.
  // It used to also flash `tmux display-message`, which writes to the status line the
  // whole session shares — one pane's mode change interrupting every other pane.
  if (debugLogging) {
    console.error(`tweb: mode ${modeLabel()}`
      + ` (vimium=${inputState().vimium} bypass=${inputState().bypass})`);
  }
}

function modeLabel() {
  const v = inputState().vimium;
  const b = inputState().bypass;
  if (v && !b) return "bypass OFF";
  if (!v && b) return "web bypass ON";
  if (v && b) return "shortcuts and bypass ON";
  return "web only ON";
}

function setCmdBypassEnabled(enabled) {
  inputState().bypass = enabled;
  applyShortcutMode();
}

function setVimiumShortcutsEnabled(enabled) {
  inputState().vimium = enabled;
  applyShortcutMode();
}

// 5001 (Ctrl-;) and the legacy forcing sequences toggle or set bypass only.
function setBrowserShortcutsEnabled(enabled) {
  setCmdBypassEnabled(enabled);
}

function toggleBrowserShortcuts() {
  setCmdBypassEnabled(!inputState().bypass);
}

function activateTab(index) {
  if (currentWindows().tabs.length === 0) {
    currentWindows().win = null;
    currentWindows().activeTabIndex = -1;
    return;
  }
  const normalized = ((index % currentWindows().tabs.length) + currentWindows().tabs.length) % currentWindows().tabs.length;
  currentWindows().activeTabIndex = normalized;
  currentWindows().win = currentWindows().tabs[normalized];
  inputState().clicks.reset();
  inputState().insertMode = false;
  // The preload mirrors this flag and skips redundant IPC, so tell the tab we
  // just cleared it. Without this its focused input keeps thinking native
  // delivery is armed and its keys go back through the renderer, where they
  // arrive with keyCode 0.
  sendToTabFrames(currentWindows().win, "tweb-shortcuts-mode", { vimium: inputState().vimium, bypass: inputState().bypass });
  // The other tab's caret says nothing about this one, and its preload only
  // reports on focus — which switching soleWindows.tabs does not fire.
  moveTerminalCaret(null);
  // Zoom is shared per origin in Chromium, so a sibling tab on the same host can
  // have moved it. Only the active tab is ever painted, so restoring this tab's
  // own factor on activation is what makes zoom look per-tab.
  const zoomFactor = tabZoomFactors.get(currentWindows().win) ?? defaultZoomFactor;
  if (!currentWindows().win.isDestroyed() && currentWindows().win.webContents.getZoomFactor() !== zoomFactor) {
    currentWindows().win.webContents.setZoomFactor(zoomFactor);
  }
  // Cell size in CSS pixels depends on the zoom just restored.
  broadcastCellMetrics();
  // Do not delete the current image first: the next frame reuses the same image
  // id and replaces it in place. Deleting would uncover the bare terminal until
  // the new tab paints, which reads as a flicker on every switch.
  updatePaintingState();
  currentWindows().win.webContents.invalidate();
  updatePaneTitle();
  sendTabState();
  scheduleWindowSessionSave();
  if (debugLogging) console.error(`tweb: tab active ${tabLabel(currentWindows().win, normalized)}`);
}

function cycleTab(direction) {
  if (currentWindows().tabs.length > 1) activateTab(currentWindows().activeTabIndex + direction);
}

function closeTab(index = currentWindows().activeTabIndex) {
  const tab = currentWindows().tabs[index];
  if (!tab || tab.isDestroyed()) return;
  const url = tab.webContents.getURL();
  if (isRestorableUrl(url)) {
    currentWindows().closedTabs.push(url);
    if (currentWindows().closedTabs.length > 25) currentWindows().closedTabs.shift();
  }
  if (currentWindows().tabs.length === 1) {
    app.quit();
    return;
  }
  tab.close();
}

function restoreClosedTab() {
  const url = currentWindows().closedTabs.pop();
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
  const tabEntries = currentWindows().tabs.flatMap((candidate, index) => {
    if (candidate.isDestroyed()) return [];
    const url = tabSessionUrls.get(candidate) || candidate.webContents.getURL() || "about:blank";
    return [{
      kind: "tab",
      index,
      url,
      title: candidate.webContents.getTitle() || url,
      recency: base + currentWindows().tabs.length - index,
    }];
  });
  return {
    current: currentWindows().win && !currentWindows().win.isDestroyed() ? tabSessionUrls.get(currentWindows().win) || currentWindows().win.webContents.getURL() || "" : "",
    entries: [
      ...tabEntries,
      ...history.map((entry, index) => ({ ...entry, kind: "history", recency: base - index })),
    ],
  };
}

function tabListModel() {
  return {
    activeIndex: currentWindows().activeTabIndex,
    tabs: currentWindows().tabs.map((candidate, index) => ({
      index,
      title: candidate.webContents.getTitle() || "New tab",
      url: candidate.webContents.getURL() || "about:blank",
    })),
  };
}

function tabStateModel() {
  return {
    activeIndex: currentWindows().activeTabIndex,
    count: currentWindows().tabs.length,
    tabs: currentWindows().tabs.flatMap((candidate, index) => candidate.isDestroyed() ? [] : [{
      index,
      title: candidate.webContents.getTitle() || candidate.webContents.getURL() || "New tab",
    }]),
  };
}

function sendTabState(tab = currentWindows().win) {
  sendToMainTabFrame(tab, "tweb-tab-state", tabStateModel());
}

// Toggles the active pane's page between the tmux pane and an OS desktop window.
// Sends the `float` or `pin` agent RPC, which flips `inputState().floating` and
// re-runs `updatePaintingState`. The same webContents is redirected, so the
// page state carries over — this is a view toggle, not a session toggle.
function toggleFloat() {
  const state = inputState();
  state.floating = !state.floating;
  updatePaintingState();
}


function handleNativeShortcut(tab, action, value, sourceFrame = null) {
  // `toggle-float` is a view toggle, not a browser shortcut — it works regardless of vimium mode.
  if (action === "toggle-float") { toggleFloat(); return; }
  if (!inputState().vimium || tab !== currentWindows().win || tab.isDestroyed()) return;
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
    case "list-tabs":
      sendToTabFrames(tab, "tweb-tabs", tabListModel());
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
    // Printing and the downloads list share one story: where a file landed. The page asks
    // for the model on every keystroke, like history, so the filter runs over the whole
    // file rather than over a slice the renderer happens to be holding.
    case "print":
      void printPageToPdf(tab);
      break;
    // The paper tier is its own action rather than a flag on "print", so nothing that
    // already asks to print can start putting ink on paper by accident.
    case "print-paper":
      void printPageToPdf(tab, { paper: true });
      break;
    case "downloads-model":
      sendToFocusedTabFrame(tab, "tweb-downloads", downloadsPageModel(value?.query));
      break;
    case "cancel-transfer":
      cancelTransfer(value);
      break;
    case "file-chooser-completion":
      sendToFocusedTabFrame(tab, "tweb-file-chooser-completion", {
        value: String(value?.value || ""),
        ...fileChooserCompletion(value?.value, value?.accept),
      });
      break;
    case "file-chooser-resolve":
      resolveFileChooser(tab, value);
      break;
    case "activate-tab":
      if (Number.isInteger(value) && value >= 0 && value < currentWindows().tabs.length) activateTab(value);
      break;
    // The tab list closes a specific row; the bare shortcut closes the active tab.
    case "close-tab":
      // Closing from the list keeps it open, so it has to be redrawn — but only
      // then: sending the model unprompted would pop the list open.
      refreshTabListAfterClose = Number.isInteger(value);
      closeTab(Number.isInteger(value) ? value : currentWindows().activeTabIndex);
      break;
    case "restore-tab": restoreClosedTab(); break;
    case "reload": contents.reload(); break;
    case "zoom-in": setBrowserZoom("in"); break;
    case "zoom-out": setBrowserZoom("out"); break;
    case "zoom-reset": setBrowserZoom("reset"); break;
    case "find": {
      const query = String(value?.query || "");
      if (query) {
        const step = findStep(findSessionByTab.get(tab) ?? FIND_IDLE, query, value?.forward !== false);
        findSessionByTab.set(tab, step.state);
        if (debugLogging) console.error(`tweb: find ${JSON.stringify(query)} findNext=${step.options.findNext} forward=${step.options.forward}`);
        contents.findInPage(query, step.options);
      }
      break;
    }
    case "stop-find":
      findSessionByTab.set(tab, endStep().state);
      if (debugLogging) console.error(`tweb: stop-find ${JSON.stringify(value)}`);
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
      inputState().insertMode = Boolean(value);
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

// The three IPC handlers all reach a window, so each resolves its pane from the tab that sent the
// message. `event.sender` is the only pane evidence an IPC message carries.
ipcMain.on("tweb-preload-ready", bindPane(
  (event) => tabPanes.get(BrowserWindow.fromWebContents(event.sender)),
  (event, info) => {
  const tab = BrowserWindow.fromWebContents(event.sender);
  const frame = event.senderFrame;
  if (!tab || !frame || frame.isDestroyed() || frame.detached) return;
  // A fresh document starts in normal mode, so the mirror has to follow.
  if (frame === tab.webContents.mainFrame) inputState().insertMode = false;
  const key = frameKey(frame);
  if (info?.shortcutFrame) shortcutFrameKeys(tab).add(key);
  else shortcutFrameKeys(tab).delete(key);
  readyFrameKeys(tab).add(frameKey(frame));
  event.reply("tweb-shortcuts-mode", { vimium: inputState().vimium, bypass: inputState().bypass });
  if (tab === currentWindows().win && frame === tab.webContents.mainFrame) {
    event.reply("tweb-cell-metrics", cellMetrics());
    event.reply("tweb-tab-state", tabStateModel());
    // A download outlives the page that started it — clicking a link can navigate and
    // download at once. Without this the badge for a transfer still running would vanish
    // with the old document and never come back.
    event.reply("tweb-transfer", transferSummary(transfers, Date.now()));
  }
}));

ipcMain.on("tweb-shortcut", bindPane(
  (event) => tabPanes.get(BrowserWindow.fromWebContents(event.sender)),
  (event, message) => {
  if (!message || typeof message.action !== "string") return;
  const tab = currentWindows().tabs.find((candidate) => !candidate.isDestroyed() && candidate.webContents.id === event.sender.id);
  if (!tab) return;
  handleNativeShortcut(tab, message.action, message.value, event.senderFrame);
}));

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

// Deliberately not pane-scoped: `recordConsoleMessage` appends to one process-wide ring buffer that
// `tweb console` reads, and each entry carries its own page url. Nothing here reaches a window.
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

// The other half of "why is the page broken": the request that never came back. Same shape as
// the console buffer — bounded, process-wide, each entry carrying its own url — because by the
// time an agent thinks to ask, the request is long finished and Chromium keeps no history of it.
const networkLog = [];
const networkLogLimit = 200;

// Session-wide, registered once at startup rather than per tab. `webRequest` keeps exactly one
// listener per event per session, so a second registration *replaces* the first — a per-tab call
// would look like it was watching every tab while only ever watching the newest. Every tab
// already runs in `session.defaultSession` (see `setUpExtensions` for why no partition), so one
// registration covers all of them.
function watchNetwork() {
  // No filter: an agent debugging a page wants the whole picture, and the ring buffer is what
  // bounds the cost, not the filter.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    networkLog.push({
      id: details.id,
      url: details.url,
      method: details.method,
      resourceType: details.resourceType,
      statusCode: null,
      fromCache: false,
      timestamp: new Date().toISOString(),
    });
    if (networkLog.length > networkLogLimit) networkLog.splice(0, networkLog.length - networkLogLimit);
    // Not optional. A registered onBeforeRequest listener that returns without calling back
    // stalls every request in the session — the browser stops loading pages entirely.
    callback({});
  });
  session.defaultSession.webRequest.onCompleted((details) => {
    // Searched from the back because the matching entry is almost always the most recent one,
    // and a request whose entry has already aged out of the ring simply keeps no status.
    const entry = networkLog.findLast((candidate) => candidate.id === details.id);
    if (!entry) return;
    entry.statusCode = details.statusCode;
    entry.fromCache = Boolean(details.fromCache);
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
  const tab = currentWindows().win;
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
  const tab = currentWindows().win && !currentWindows().win.isDestroyed() ? currentWindows().win : null;
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
      rate: currentWindows().activeFrameRate,
      adaptive: adaptiveFrameRate,
      // All three resolved rates, not just the one in force. The startup banner was the
      // only place they were stated together, and it wrote into tmux's shared status line.
      tiers: {
        idle: idleFrameRate,
        playback: currentPlaybackTiers().playback,
        max: maxActiveFrameRate,
      },
      // Which of the three adaptive rates is in force. `playback` means the page is
      // painting on its own — a video, an animation — which is what separates "the pane
      // is throttled" from "the page has nothing new to show".
      rateKind: !adaptiveFrameRate ? "fixed"
        : currentWindows().activeFrameRate >= maxActiveFrameRate ? "active"
          : currentWindows().activeFrameRate >= currentPlaybackTiers().playback ? "playback" : "idle",
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
      // How whole frames reach the terminal, and where the setting came from.
      //
      // Reported because setting it is silently a no-op on the hosted path, which is the
      // default: the engine is spawned by the DAEMON, so `TWEB_FRAME_TRANSPORT` on a pane never
      // reaches `process.env` here — it is the daemon's value, from whenever the daemon started.
      // Measured the hard way: an experiment run with the variable set on the pane produced a
      // fresh engine that still wrote frame files, and nothing anywhere said so.
      transport: frameTransport,
      transportFromDaemonEnv: hostedRuntime,
      // Of `whole`, how many went out deflated (`o=z`). See DETAIL.md 8.6.
      wholeCompressed: currentFrames().compressedWholeFrames,
    },
    panes: {
      hosted: paneRegistry.size,
      // How many times a pane had to be resolved with no ambient scope while more than one was
      // hosted. Every one of those fell back to the first pane, so this is not a statistic — it is
      // an entry point nobody bound, and the symptom would be one pane's input or frame
      // occasionally landing in another's rectangle. It must stay 0.
      unscopedResolutions: unscopedPaneResolutions,
    },
    input: {
      vimiumShortcuts: inputState().vimium,
      cmdBypass: inputState().bypass,
      pageInsertMode: inputState().insertMode,
      terminalVisible: currentPane().visible,
      // Whether visibility is coming from the frontend's push or the no-frontend
      // polling fallback, and how stale the last push is. A pane that reads hidden
      // while showing "poll" is a frontend that never pushed, not a tmux problem.
      visibilitySource: vis().source,
      visibilityPushAgeMs: vis().pushedAt === null ? null : Date.now() - vis().pushedAt,
      visibleClientTtys: [...vis().clientTtys],
      tmuxPlacement: vis().placement,
      shortcutFrames: tab ? shortcutFrameKeys(tab).size : 0,
      // Where IME preedit will land. Comparing cell against point is the only way
      // to tell "caret parked on the wrong line" from "page never reported one".
      caret: { cell: inputState().caretCell, point: inputState().caretPoint },
    },
    tabs: { active: currentWindows().activeTabIndex, count: currentWindows().tabs.length },
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
  if (!currentWindows().win || currentWindows().win.isDestroyed()) throw new Error("no active tab");
  return currentWindows().win.webContents;
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
  // Same reason as the real key path: sendInputEvent does not reach a PDF's extension
  // frame, so `tweb press PageDown` would answer ok while the viewer stayed on page 1.
  if (routePdfKey(key, modifiers)) return;
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
    active: currentWindows().activeTabIndex,
    tabs: currentWindows().tabs.map((tab, index) => ({
      index,
      title: tab.isDestroyed() ? "" : tab.webContents.getTitle(),
      url: tab.isDestroyed() ? "" : tab.webContents.getURL(),
      active: index === currentWindows().activeTabIndex,
    })),
  };
}

async function agentScreenshot(params) {
  const contents = agentContents();
  // On a hidden pane the hold has already collected a frame at the restored size, and
  // going back to the compositor for a second copy of it is what failed intermittently.
  const image = currentWindows().agentSurfaceFrame || await contents.capturePage();
  if (!params.path) return { png: image.toPNG().toString("base64") };
  const target = path.resolve(params.path);
  writeFileSync(target, image.toPNG());
  return { path: target, size: image.getSize() };
}

// How many viewports one full-page capture will stitch before it stops and returns what it has.
//
// The bound is not arbitrary. The agent surface hold expires after AGENT_SURFACE_HOLD_TTL_MS, and
// the tick that notices collapses the surface again — so a capture that outlived the hold would
// stitch full-height slices onto one-pixel ones and call the result a screenshot. Sixteen
// viewports stays well inside that, and it bounds the stitched bytes the way DESIGN.md 6.5 bounds
// every other frame buffer here: an infinite-scroll feed has no last page, so this has to stop
// short rather than fill memory looking for one.
const FULL_SCREENSHOT_MAX_SLICES = 16;

// Scroll, then report where the page actually landed — in one round trip, because the two answers
// have to describe the same instant.
//
// The read-back is the load-bearing half. `scrollTo` is a request: the document clamps it at its
// own bottom, and the last slice of any page that is not an exact multiple of the viewport lands
// short of where it was sent. Pasting that frame at the row that was ASKED for instead of the row
// that was REACHED is what duplicates the final band.
//
// Two frames of settle, because one is not enough: the first lands the new scroll offset in
// layout, and the second is the one whose paint is worth capturing. The timer is the backstop for
// a page whose rAF never runs — the capture should lose a slice's fidelity there, not hang.
function scrollProbeScript(top) {
  return `new Promise((resolve) => {
    const answer = () => resolve({
      scrollY: Math.round(scrollY),
      innerHeight: Math.round(innerHeight),
      scrollHeight: Math.round(Math.max(
        document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0)),
    });
    scrollTo({ top: ${Math.round(top)}, left: 0, behavior: "instant" });
    const timer = setTimeout(answer, 250);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); answer(); }));
  })`;
}

// One slice's pixels. `awaitRestoredFrame` is the same wait the surface hold uses — it invalidates
// and takes the next paint at the expected size — which is exactly the question here, since a
// frame that arrives before the scroll has repainted shows the previous slice.
//
// It answers null rather than throwing when no paint arrives in time. `capturePage` is the same
// read one round later, and one blurry slice beats failing a capture that is otherwise complete.
async function fullScreenshotFrame(contents) {
  return (await awaitRestoredFrame(contents)) || await contents.capturePage();
}

/**
 * `tweb full-screenshot` — the whole document, not the part of it that fits.
 *
 * `screenshot` returns what the compositor has, and the compositor only ever has the viewport.
 * Everything below the fold is not cropped or dimmed in that frame, it is absent — so the only
 * way to photograph it is to scroll the page past the viewport and stitch the frames. A short
 * page has nothing below the fold and is handed straight to `screenshot`, which already has the
 * frame the hold collected and needs no scrolling at all.
 *
 * Each slice contributes only the rows nobody has captured yet, which is what makes the final
 * scroll safe: the document clamps it at its own bottom, so its frame re-shows rows already
 * stitched and pasting it whole would duplicate that band.
 *
 * What this does NOT fix, and cannot without mutating the page: sticky and fixed chrome repaints
 * at the top of every frame, so a sticky header appears once per slice in the stitch — and the
 * document rows it covers are occluded in that frame, so they are missing rather than merely
 * duplicated. Hiding those elements mid-capture is the only way to stitch around them, and it
 * would mean editing a page the user may be watching and perturbing its own scroll handlers, to
 * fix an artifact every stitcher that leaves the page alone has. Stated here rather than
 * half-fixed.
 */
async function agentFullScreenshot(params) {
  const contents = agentContents();
  const start = await contents.executeJavaScript(`({
    scrollY: Math.round(scrollY),
    innerHeight: Math.round(innerHeight),
    scrollHeight: Math.round(Math.max(
      document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0)),
  })`, true);
  if (start.scrollHeight <= start.innerHeight) return agentScreenshot(params);

  const slices = [];
  // How much of the document is already stitched, in CSS pixels. It doubles as the next scroll
  // target: the viewport is sent to the first row nobody has captured yet.
  let covered = 0;
  let width = 0;
  let scale = 1;
  try {
    for (let index = 0; index < FULL_SCREENSHOT_MAX_SLICES; index += 1) {
      const at = await contents.executeJavaScript(scrollProbeScript(covered), true);
      const image = await fullScreenshotFrame(contents);
      const size = image.getSize();
      if (!width) {
        width = size.width;
        // Device pixels per CSS pixel, measured off this frame rather than assumed. It folds the
        // pane's scale factor and the tab's zoom together, and zoom is per tab — see
        // `tabZoomFactors` — so neither can be read off a constant.
        scale = size.height / Math.max(1, at.innerHeight);
      }
      // A viewport that changed mid-capture (the pane was resized) makes the remaining frames a
      // different width, and there is no honest way to stitch those onto what is already here.
      if (size.width !== width) break;
      const skipRows = Math.min(size.height, Math.round(Math.max(0, covered - at.scrollY) * scale));
      const rows = size.height - skipRows;
      // No new rows means the page stopped moving — a shorter document than it claimed, or one
      // that refuses to scroll. Stopping is what keeps that from looping to the slice cap.
      if (rows <= 0) break;
      slices.push({ destRow: Math.round(covered * scale), bitmap: image.toBitmap(), skipRows, rows });
      covered = at.scrollY + at.innerHeight;
      if (covered >= at.scrollHeight) break;
    }
  } finally {
    // The page goes back where the user left it however this ended. An agent's capture is
    // supposed to observe the page, not to have moved it.
    await contents.executeJavaScript(scrollProbeScript(start.scrollY), true).catch(() => {});
  }
  if (!slices.length) return agentScreenshot(params);

  const stride = width * 4;
  const last = slices[slices.length - 1];
  const height = last.destRow + last.rows;
  const canvas = Buffer.alloc(height * stride);
  for (const slice of slices) {
    slice.bitmap.copy(canvas, slice.destRow * stride,
      slice.skipRows * stride, (slice.skipRows + slice.rows) * stride);
  }
  // Scale factor 1 because the stitch is already in device pixels: the slices came off the
  // compositor at the pane's scale, and declaring that scale again would halve the reported size
  // of an image whose bytes are the full-resolution page.
  const image = nativeImage.createFromBitmap(canvas, { width, height, scaleFactor: 1 });
  if (!params.path) return { png: image.toPNG().toString("base64") };
  const target = path.resolve(params.path);
  writeFileSync(target, image.toPNG());
  return { path: target, size: image.getSize() };
}

/**
 * `tweb pdf` — the page as a PDF, wherever the caller asked for it.
 *
 * Deliberately not `printPageToPdf`: that one is the Ctrl-P path, and it picks its own name
 * under ~/Downloads and badges a transfer. An agent has already decided where the file goes
 * and has no way to learn a generated name, so this takes the caller's path instead and
 * stays out of the transfer list.
 */
async function agentPdf(params) {
  const pdf = await agentContents().printToPDF({});
  if (!params.path) return { pdf: pdf.toString("base64") };
  const target = path.resolve(params.path);
  writeFileSync(target, pdf, { mode: 0o600 });
  return { path: target, size: pdf.length };
}

/**
 * `tweb capture` — console, network and a screenshot from one moment.
 *
 * Three commands already answer these separately, and running them separately is the problem:
 * each round trip re-holds the surface and lets the page move on, so the screenshot shows a
 * page the log entries no longer describe. Reading all three inside a single hold is what makes
 * them one observation rather than three.
 *
 * Both buffers are drained together under `clear` so the next capture starts from this instant
 * on both — clearing only one would leave the two logs describing different windows of time.
 */
async function agentCapture(params) {
  const limit = params.limit || 100;
  const messages = params.clear ? consoleLog.splice(0) : consoleLog.slice(-limit);
  const requests = params.clear ? networkLog.splice(0) : networkLog.slice(-limit);
  return { console: messages, network: requests, screenshot: await agentScreenshot(params) };
}

/**
 * `tweb device` — lay the page out as a phone or tablet does.
 *
 * Two things make a site serve its mobile form, and a device that sets only one of them gets a
 * half-emulated page: the viewport the media queries match against, and the user agent the
 * server and any UA-sniffing script read. Chromium's device emulation covers the first and has
 * no opinion at all about the second — `Parameters` carries no userAgent field — so the UA is
 * overridden separately, through `setUserAgent` on the same contents.
 */
const emulatedDevices = {
  // Dimensions are CSS pixels, which is what `screenSize` and `viewSize` are measured in.
  // The user agents are the real ones those devices send; a made-up string is worse than
  // none, because sniffers match on the specific tokens rather than on "looks mobile".
  "iPhone 12": {
    width: 390,
    height: 844,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
      + " (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  iPad: {
    width: 820,
    height: 1180,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
      + " (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "Pixel 5": {
    width: 393,
    height: 851,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 5) AppleWebKit/537.36"
      + " (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  },
};

// The user agent each tab had before emulation first overrode it. Captured on the way in
// because `getUserAgent` answers with the override once one is set, so reading it at reset
// time would restore the phone's UA over itself and leave the tab permanently mobile.
// Keyed by tab like `tabZoomFactors`, since the tab that gets reset need not be the one that
// was emulated.
const tabDefaultUserAgents = new Map();

// Resolved case-insensitively: the names are display strings with a capital and a space in
// them, and `tweb device "iphone 12"` is the same request as `tweb device "iPhone 12"`.
function findEmulatedDevice(name) {
  const wanted = String(name).trim().toLowerCase();
  const key = Object.keys(emulatedDevices).find((candidate) => candidate.toLowerCase() === wanted);
  return key ? { name: key, ...emulatedDevices[key] } : null;
}

function agentDevice(params) {
  const contents = agentContents();
  const tab = currentWindows().win;
  if (params.reset) {
    contents.disableDeviceEmulation();
    // Only if this tab was ever emulated. Restoring an uncaptured default would write the
    // literal string "undefined" as the user agent.
    if (tabDefaultUserAgents.has(tab)) {
      contents.setUserAgent(tabDefaultUserAgents.get(tab));
      tabDefaultUserAgents.delete(tab);
    }
    return { reset: true };
  }
  const device = findEmulatedDevice(params.name || "");
  if (!device) {
    throw new Error(`unknown device ${JSON.stringify(String(params.name || ""))};`
      + ` known: ${Object.keys(emulatedDevices).join(", ")}`);
  }
  // `viewSize` is what re-lays the page out at the device's width — NOT `setContentSize`.
  // The window's content size is not ours to set: `updatePaintingState` recomputes it from
  // the tmux viewport every second through the hidden-window watchdog, so a resize here is
  // reverted within a second; and until it is, `queueFrame` drops every paint whose size
  // fails to match `renderedFrameSize(viewport)`, freezing the pane on a stale frame.
  // Emulation asks the renderer for a different layout while the surface stays the size the
  // pane actually is, which is the same separation the zoom factor already relies on.
  contents.enableDeviceEmulation({
    screenPosition: "mobile",
    screenSize: { width: device.width, height: device.height },
    viewSize: { width: device.width, height: device.height },
    viewPosition: { x: 0, y: 0 },
    // Zero means "keep the pane's own scale factor". Forcing the device's 2x or 3x would
    // render a frame the terminal has to scale down again for no gain in fidelity.
    deviceScaleFactor: 0,
    scale: 1,
  });
  if (!tabDefaultUserAgents.has(tab)) tabDefaultUserAgents.set(tab, contents.getUserAgent());
  contents.setUserAgent(device.userAgent);
  return { device: device.name, width: device.width, height: device.height };
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
    // Reporting only, like `diag`. The loader keeps its results precisely so this can answer
    // without re-reading the profile directory.
    case "extensions":
      return extensionReport(extensionResults, extensionsDirectory);
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
    case "full-screenshot":
      return agentFullScreenshot(params);
    case "pdf":
      return agentPdf(params);
    case "device":
      return agentDevice(params);
    case "wait":
      return agentWaitFor(params);
    case "tabs":
      return agentTabList();
    case "tab":
      activateTab(Number(params.index));
      return agentTabList();
    case "tab-new":
      createTab(normalizeUrl(String(params.url || "about:blank")), true);
      return agentTabList();
    case "tab-close":
      closeTab(params.index === undefined ? currentWindows().activeTabIndex : Number(params.index));
      return agentTabList();
    case "console":
      return { messages: params.clear ? consoleLog.splice(0) : consoleLog.slice(-(params.limit || 100)) };
    case "errors":
      return { errors: consoleLog.filter((entry) => entry.level === "error").slice(-(params.limit || 50)) };
    case "network":
      return { requests: params.clear ? networkLog.splice(0) : networkLog.slice(-(params.limit || 100)) };
    case "inspect-element": {
      // The user picked an element in inspect mode. Forward the payload the preload
      // collected to the agent — or answer null if inspect mode is closed.
      const result = await agentPageRequest("inspect-element", {}, 3000);
      return result || { ok: false, message: "no element picked" };
    }
    case "float": {
      inputState().floating = true;
      updatePaintingState();
      return { ok: true, floating: true };
    }
    case "pin": {
      inputState().floating = false;
      updatePaintingState();
      return { ok: true, floating: false };
    }
    case "capture":
      return agentCapture(params);
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
// Per-pane, on the input state: the coordinates are written to the pane's own terminal through
// `paneWrite`, so a shared cell parked every pane's cursor at whichever pane last reported a caret —
// and a hidden flag shared means one pane's blur leaves another pane's cursor showing.
// A block cursor covers the cell it sits on, so the parked cursor hid the page's
// own caret and the character next to it. Ask for a steady bar (DECSCUSR 6): it
// draws on the cell's left edge, which is where a text caret belongs anyway.
const CARET_BAR = CSI("6 q");
const CARET_SHAPE_RESET = CSI("0 q");
// Where a fixed-width font puts its baseline inside the cell. The terminal paints
// preedit on that baseline, so the row has to be picked by baseline — matching
// cell *centres* floated a composing syllable a row above tall page text.
const CARET_BASELINE = 0.78;



function unparkTerminalCaret() {
  const input = inputState();
  input.caretCell = null;
  input.caretPoint = null;
  // Reported on every frame with no caret, so it writes only on the transition.
  if (input.caretHidden) return;
  input.caretHidden = true;
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
  if (!currentFrames().viewport || !currentWindows().win || currentWindows().win.isDestroyed()) return null;
  const logical = logicalContentSize(currentFrames().viewport);
  const zoom = currentWindows().win.webContents.getZoomFactor() || 1;
  return {
    width: logical.width / Math.max(1, currentFrames().cells.cols) / zoom,
    height: logical.height / Math.max(1, currentFrames().cells.rows) / zoom,
    columns: imeSlotCells,
  };
}

function broadcastCellMetrics(tab = currentWindows().win) {
  if (!tab || tab.isDestroyed() || tab !== currentWindows().win) return;
  sendToTabFrames(tab, "tweb-cell-metrics", cellMetrics());
}

// The page reports the caret in CSS pixels and dedupes on them, so a zoom step or
// a pane resize moves the cell under a caret that never "moved" — and the report
// that would correct it never comes. Recompute from the last one instead.
function reparkTerminalCaret() {
  if (inputState().caretPoint) moveTerminalCaret(inputState().caretPoint);
}

function moveTerminalCaret(point) {
  const vp = currentFrames().viewport;
  if (!point || !vp || !currentWindows().win || currentWindows().win.isDestroyed()) {
    // Unconditionally, not just when a caret was parked: a frame's cursor anchoring can
    // leave a visible cursor at the pane origin even when TWeb never put one there, and in
    // the corner that reads as a caret sitting in the wrong place.
    unparkTerminalCaret();
    return;
  }
  const logical = logicalContentSize(vp);
  const zoom = currentWindows().win.webContents.getZoomFactor() || 1;
  const cellWidth = logical.width / Math.max(1, currentFrames().cells.cols);
  const cellHeight = logical.height / Math.max(1, currentFrames().cells.rows);
  // Nearest cell edge, not the containing cell: a bar on the left edge is off by
  // at most half a cell that way instead of a whole one.
  const col = Math.min(currentFrames().cells.cols, Math.max(1, Math.round(point.x * zoom / cellWidth) + 1));
  const baseline = (point.y + (point.height || 0) * CARET_BASELINE) * zoom;
  const row = Math.min(currentFrames().cells.rows,
    Math.max(1, Math.round(baseline / cellHeight - CARET_BASELINE) + 1));
  inputState().caretPoint = { x: point.x, y: point.y, height: point.height || 0 };
  if (inputState().caretCell && inputState().caretCell.row === row && inputState().caretCell.col === col) return;
  inputState().caretCell = { row, col };
  writeTerminalCaret(row, col);
}

function writeTerminalCaret(row, col) {
  inputState().caretHidden = false;
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
  const input = inputState();
  if (!input.caretCell) return;
  writeTerminalCaret(input.caretCell.row, input.caretCell.col);
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

// Transfers this pane knows about, newest last. The bytes were always written; what was
// missing is that nobody was told, so a click produced a file the user could not find.
//
// Bounded because a badge only ever shows one of these and the list on disk is the record
// that lasts. A pane left open for a week must not accumulate every transfer in memory.
const transfers = [];
const MAX_LIVE_TRANSFERS = 40;
let nextTransferId = 1;
let transferBadgeTimer = null;

function downloadsPath() {
  return path.join(app.getPath("userData"), "downloads.jsonl");
}

/// Append one finished transfer to the on-disk record the downloads page reads.
function recordTransfer(transfer) {
  const record = downloadRecord(transfer);
  if (!record) return;
  try {
    mkdirSync(path.dirname(downloadsPath()), { recursive: true });
    appendFileSync(downloadsPath(), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    if (debugLogging) console.error(`tweb: download record failed: ${error.message}`);
  }
}

function readDownloadEntries() {
  try {
    return parseDownloadLines(readFileSync(downloadsPath(), "utf8").split("\n"));
  } catch (error) {
    if (error.code !== "ENOENT" && debugLogging) {
      console.error(`tweb: download list read failed: ${error.message}`);
    }
    return [];
  }
}

function downloadsPageModel(query = "") {
  const model = downloadRows(readDownloadEntries(), { query: String(query || "") });
  return { ...model, query: String(query || "") };
}

/**
 * Push the current transfer badge to the page, and schedule the push that retires it.
 *
 * The badge for a finished transfer expires on a timer rather than on the next event,
 * because the next event may never come: a single download that completes is the common
 * case, and without the timer its badge would sit over the page until something else
 * happened to redraw it.
 */
function sendTransferState(tab = currentWindows().win) {
  if (transferBadgeTimer) {
    clearTimeout(transferBadgeTimer);
    transferBadgeTimer = null;
  }
  const summary = transferSummary(transfers, Date.now());
  sendToMainTabFrame(tab, "tweb-transfer", summary);
  if (summary && summary.state !== "progressing") {
    transferBadgeTimer = setTimeout(() => {
      transferBadgeTimer = null;
      sendToMainTabFrame(currentWindows().win, "tweb-transfer", transferSummary(transfers, Date.now()));
    }, SETTLED_HOLD_MS + 100);
  }
}

function trackTransfer(fields) {
  const transfer = {
    id: nextTransferId,
    paused: false,
    stalled: false,
    received: 0,
    total: 0,
    startedAt: Date.now(),
    endedAt: 0,
    origin: "download",
    ...fields,
  };
  nextTransferId += 1;
  transfers.push(transfer);
  if (transfers.length > MAX_LIVE_TRANSFERS) transfers.shift();
  return transfer;
}

/// A transfer reached a terminal state: tell the page, write the record, log the path.
function settleTransfer(transfer, state) {
  transfer.state = state;
  transfer.endedAt = Date.now();
  transfer.cancel = null;
  recordTransfer(transfer);
  sendTransferState();
  // Kept un-gated for the same reason the engine log is: a user who did not launch the
  // pane with debug flags still needs the path recoverable after the badge is gone.
  console.error(`tweb: download ${state} ${transfer.path}`);
}

/**
 * Stop an in-flight transfer.
 *
 * Chrome leaves the partial file behind as a `.crdownload`; Electron's `cancel()` removes
 * the partial itself, and TWeb does not fight it. Half a file under the name of a whole
 * one is worse than no file, and the row in the list says the transfer was cancelled so
 * the absence is explained rather than mysterious.
 */
function cancelTransfer(id) {
  const target = Number.isInteger(id)
    ? transfers.find((entry) => entry.id === id)
    : transfers.findLast((entry) => entry.state === "progressing");
  if (!target || target.state !== "progressing" || !target.cancel) return;
  try {
    target.cancel();
  } catch (error) {
    if (debugLogging) console.error(`tweb: transfer cancel failed: ${error.message}`);
  }
}

// The extensions the user has put in the extensions directory, loaded into the session the
// pane's windows will use.
//
// `session.defaultSession` deliberately, not a partition: `browserWindowOptions()` names no
// partition, so every tab in this engine already runs in the default session, and loading an
// extension anywhere else would arm rules for a session no page uses.
//
let extensionResults = [];
let extensionsDirectory = null;

// What is NOT here is any attempt to install, download or update anything. The directory is
// the interface — see `extension-policy.cjs` for which manifests are accepted and why an
// unsupported one is refused with a reason rather than loaded and left inert.
async function setUpExtensions() {
  const dir = extensionsDir(process.env, app.getPath("userData"));
  extensionsDirectory = dir;
  watchServiceWorkers(session.defaultSession, {
    log: (message) => console.error(`tweb: ${message}`),
  });
  try {
    const results = await loadExtensions(session.defaultSession, dir, {
      log: (message) => console.error(`tweb: ${message}`),
      // Source extensions are treated as read-only. Compatibility files belong to TWeb, not
      // to the downloaded archive, and therefore live beside the rest of TWeb's managed
      // profile state rather than under the source directory.
      runtimeRoot: path.join(app.getPath("userData"), "extension-runtime"),
    });
    // Kept rather than counted. Everything `tweb extensions` reports is already in here —
    // the refusal reason, the worker's fate, the ruleset count — and reducing it to two
    // numbers is what made the state unaskable.
    extensionResults = results;
    if (results.length > 0) {
      const loaded = results.filter((result) => result.loaded).length;
      console.error(`tweb: extensions ${loaded} loaded, ${results.length - loaded} refused`);
    }
  } catch (error) {
    // A broken extensions directory must not stop the browser from starting. The user came
    // here to read a page.
    console.error(`tweb: extension setup failed: ${error.message}`);
  }
}

function configureDownloads() {
  session.defaultSession.on("will-download", (_event, item) => {
    const destination = availableDownloadPath(item.getFilename());
    pendingDownloadPaths.add(destination);
    item.setSavePath(destination);
    const transfer = trackTransfer({
      filename: path.basename(destination),
      path: destination,
      url: item.getURL(),
      state: "progressing",
      total: item.getTotalBytes(),
      cancel: () => item.cancel(),
    });
    sendTransferState();
    item.on("updated", (_updatedEvent, state) => {
      transfer.received = item.getReceivedBytes();
      transfer.total = item.getTotalBytes();
      // `updated` reports "interrupted" for a transfer Chromium has not given up on, and
      // isPaused() is separately true only when something asked it to pause. Reporting a
      // broken connection as "paused" tells the user they did something they did not do.
      transfer.paused = item.isPaused();
      transfer.stalled = state === "interrupted" && !item.isPaused();
      sendTransferState();
    });
    item.once("done", (_doneEvent, state) => {
      pendingDownloadPaths.delete(destination);
      transfer.received = item.getReceivedBytes();
      settleTransfer(transfer, state);
    });
  });
}

// --- file chooser ---
//
// Chromium services `<input type=file>` by opening the platform's chooser. This window is
// offscreen and `show: false`, so nothing opens: measured, the click lands on the element,
// the DOM click event fires, and then absolutely nothing happens — no window, no error,
// no file. The control looks present and does nothing, which is the worst shape a gap can
// take, because the user only finds out mid-task with a composed message in front of them.
//
// So the request is intercepted before Chromium tries, and answered by a path prompt in
// the pane. The interception is CDP's `Page.setInterceptFileChooserDialog`, and the answer
// goes back through `DOM.setFileInputFiles` — there is no supported non-CDP way to put a
// file on an input, and `value` cannot be assigned for security reasons that are
// Chromium's and correct.
//
// WHAT THIS DOES NOT REPLACE: dragging a file from Finder onto the page. That does not
// exist in a terminal and cannot be made to.
const fileChooserByTab = new WeakMap();

function attachChooserDebugger(tab) {
  const contents = tab.webContents;
  if (contents.debugger.isAttached()) return true;
  try {
    contents.debugger.attach("1.3");
  } catch (error) {
    // Something else owns the debugger (devtools, an extension host). The chooser cannot
    // be intercepted then, and saying so beats a prompt that would never deliver.
    if (debugLogging) console.error(`tweb: chooser debugger attach failed: ${error.message}`);
    return false;
  }
  // Bound like configureTab's handlers and for the same reason: the chooser prompt is drawn into
  // the pane, so it has to be drawn into THIS tab's pane.
  contents.debugger.on("message", bindPane(() => tabPanes.get(tab), (_event, method, params) => {
    if (method !== "Page.fileChooserOpened") return;
    openFileChooser(tab, params);
  }));
  contents.debugger.on("detach", () => fileChooserByTab.delete(tab));
  void contents.debugger.sendCommand("Page.enable")
    .then(() => contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }))
    .catch((error) => {
      if (debugLogging) console.error(`tweb: chooser interception failed: ${error.message}`);
    });
  return true;
}

function openFileChooser(tab, params) {
  const pending = {
    backendNodeId: params?.backendNodeId,
    frameId: params?.frameId,
    multiple: params?.mode === "selectMultiple",
    accept: "",
  };
  fileChooserByTab.set(tab, pending);
  // The `accept` attribute is on the element, and CDP's event does not carry it. Reading
  // it back from the page keeps the prompt able to offer the right files.
  void tab.webContents.executeJavaScript(`(() => {
    const active = document.activeElement;
    const input = active && active.tagName === "INPUT" && active.type === "file" ? active : null;
    return input ? input.accept || "" : "";
  })()`, false).then((accept) => {
    pending.accept = String(accept || "");
    sendToMainTabFrame(tab, "tweb-file-chooser", {
      multiple: pending.multiple,
      accept: pending.accept,
      // Starting where the user's shell is beats starting at / — they are far likelier to
      // want something near their working directory than at the filesystem root.
      start: `${process.cwd()}/`,
    });
  }).catch(() => {
    sendToMainTabFrame(tab, "tweb-file-chooser", { multiple: pending.multiple, accept: "", start: `${process.cwd()}/` });
  });
}

/// What the prompt shows as it is typed: the entries under the path, and the Tab completion.
function fileChooserCompletion(value, accept) {
  const home = app.getPath("home");
  const { directory, prefix } = completionScope(value, home);
  let listed = [];
  try {
    listed = readdirSync(expandHome(directory, home), { withFileTypes: true })
      .map((item) => ({ name: item.name, directory: item.isDirectory() }));
  } catch (error) {
    // A path that does not exist yet is the normal state of a half-typed one, so an empty
    // list is the answer rather than an error the user has to dismiss.
    void error;
  }
  const model = completionEntries(listed, { prefix, accept });
  return {
    ...model,
    directory,
    completed: completedInput(value, model.entries, home),
  };
}

/**
 * Hand the chosen paths to the page, or cancel the request.
 *
 * A cancelled chooser must still be answered: `setFileInputFiles` with an empty list is
 * what tells Chromium the dialog closed. Leaving it unanswered would leave the page
 * believing a chooser is still open, which is the state this whole path exists to avoid.
 *
 * A path that does not exist is NOT a cancel, and this is the failure mode a path prompt
 * has that Chrome's picker cannot: one mistyped character. Answering it as a cancel closes
 * the prompt and does nothing, which is exactly the "looked like it worked" shape this
 * whole change set exists to remove. So the request stays open and the prompt is reopened
 * carrying the typed text and the reason.
 */
function resolveFileChooser(tab, value) {
  const pending = fileChooserByTab.get(tab);
  if (!pending) return;
  const home = app.getPath("home");
  const typed = (Array.isArray(value?.paths) ? value.paths : []).map(String).filter(Boolean);
  const missing = typed.filter((entry) => !existsSync(expandHome(entry, home)));
  if (typed.length > 0 && missing.length > 0) {
    sendToMainTabFrame(tab, "tweb-file-chooser", {
      multiple: pending.multiple,
      accept: pending.accept,
      start: typed[0],
      error: missing.length === 1
        ? `No such file: ${missing[0]}`
        : `No such files: ${missing.join(", ")}`,
    });
    return;
  }
  fileChooserByTab.delete(tab);
  const { paths } = chosenPaths(typed.map((entry) => expandHome(entry, home)), { multiple: pending.multiple });
  void tab.webContents.debugger.sendCommand("DOM.setFileInputFiles", {
    files: paths,
    backendNodeId: pending.backendNodeId,
  }).catch((error) => {
    if (debugLogging) console.error(`tweb: file chooser delivery failed: ${error.message}`);
  });
  if (debugLogging) console.error(`tweb: file chooser ${paths.length ? paths.join(", ") : "cancelled"}`);
}


/**
 * Shim `window.print` in a frame the preload never reached.
 *
 * This is the SECOND net, not the first. The primary cover for a preload-less child is the
 * accessor patch inside `printShimScript`, which shims the child synchronously on the
 * access that precedes the call — necessary because a page can create an iframe and print
 * it in one tick, which this hook cannot win: measured, `frame-created` arrives after the
 * renderer has already wedged. What this catches is the slower shapes, where a frame is
 * created in one turn and printed in a later one, and any frame reached without going
 * through a patched accessor.
 *
 * The frame has no IPC of its own, but an `about:blank`/`srcdoc` child is same-origin with
 * its parent, so it can raise the event on an ancestor that DOES have a preload listening.
 * A cross-origin frame cannot reach an ancestor, and it also gets its own preload
 * (`nodeIntegrationInSubFrames`), so it is already covered there.
 */
function shimFramePrint(frame) {
  if (!frame || frame.isDestroyed() || frame.detached) return;
  const notify = `
    try {
      (window.top || window.parent).dispatchEvent(new CustomEvent("tweb-print-request"));
    } catch (error) {
      // A frame that can reach no listening ancestor cannot report the request. Swallowing
      // it loses a print; letting it through would lose the renderer.
    }`;
  frame.executeJavaScript(printShimScript(notify), false).catch((error) => {
    // A frame that navigated or died between creation and this call needs no shim.
    void error;
  });
}

/**
 * What Ctrl-P and a page's own `window.print()` do instead of opening a print dialog.
 *
 * Chrome fuses two different jobs into one dialog: save-as-PDF, which is the common case,
 * and putting ink on paper. A tmux pane can draw neither the preview nor the macOS print
 * sheet, and Chromium's own attempt to open that sheet from an offscreen window never
 * returns — it wedges the renderer's main thread permanently, measured. So printing does
 * the half a terminal can do honestly: it writes the PDF next to the user's downloads and
 * says where it went. The badge names it as a PDF rather than claiming the page printed,
 * because silently swallowing a request for paper would be its own surprise.
 *
 * `paper` adds the second tier on top of that, never instead of it: the PDF is written and
 * reported exactly as before, and only then handed to `lpr`. Ctrl-P and `window.print()`
 * keep their existing meaning.
 */
async function printPageToPdf(tab = currentWindows().win, { paper = false } = {}) {
  if (!tab || tab.isDestroyed()) return;
  const contents = tab.webContents;
  const destination = availableDownloadPath(printFilename(contents.getTitle(), contents.getURL()));
  pendingDownloadPaths.add(destination);
  const transfer = trackTransfer({
    filename: path.basename(destination),
    path: destination,
    url: contents.getURL(),
    state: "progressing",
    origin: "print",
  });
  sendTransferState();
  try {
    const pdf = await contents.printToPDF({});
    writeFileSync(destination, pdf, { mode: 0o600 });
    transfer.received = pdf.length;
    transfer.total = pdf.length;
    pendingDownloadPaths.delete(destination);
    settleTransfer(transfer, "completed");
    if (paper) sendToPrintQueue(destination, transfer);
  } catch (error) {
    pendingDownloadPaths.delete(destination);
    settleTransfer(transfer, "interrupted");
    if (debugLogging) console.error(`tweb: print failed: ${error.message}`);
  }
}

/**
 * Classify what `lpr` did, so the user is told the truth about a job they cannot see.
 *
 * A terminal browser has no print dialog and no queue window, so the exit status is the
 * ONLY evidence the user will ever get that paper is coming. The one case that has to stay
 * distinct is "no printer configured": reporting it as a generic failure would leave
 * someone re-pressing the key at a machine that has no printer at all. `lpr` is silent on
 * success, so no news is the good news.
 *
 * The patterns are the strings macOS CUPS actually emits, captured by running the failures
 * rather than guessed from the man page — an earlier version of this matched "no default
 * destination", which real `lpr` never says. Measured on macOS 15:
 *   PRINTER names a missing queue -> "Error - PRINTER environment variable names default
 *                                     destination that does not exist."
 *   lpoptions names a missing one -> "Error - ~/.cups/lpoptions file names default
 *                                     destination that does not exist."
 *   `-P` an unknown queue         -> bare "No such file or directory", which is
 *                                     indistinguishable from a missing FILE and so is
 *                                     deliberately NOT special-cased.
 */
function printQueueOutcome(error, stderr = "") {
  if (!error) return { ok: true, message: "queued for the printer" };
  const text = String(stderr || error.message || "").trim();
  if (error.code === "ENOENT") {
    return { ok: false, message: "lpr not found — no print system on this machine" };
  }
  if (/destination that does not exist|no default destination|unknown destination|is not accepting/i.test(text)) {
    return { ok: false, message: "no printer configured · PDF in ~/Downloads" };
  }
  // Everything else, including the bare "No such file or directory" an unknown `-P` queue
  // produces, surfaces verbatim. A wrong specific diagnosis is worse than an honest quote.
  const first = text.split("\n")[0].replace(/^lpr:\s*(Error - )?/i, "").trim();
  return { ok: false, message: `lpr: ${first || "unknown error"} · PDF saved` };
}

/**
 * Hand the PDF that was just written to the print queue.
 *
 * The second tier of printing: save-as-PDF is the common case and stays exactly as it was,
 * and this is opt-in on top of it (`gp`), never a remap of Ctrl-P — silently turning a
 * save into a paper job would surprise someone who wanted the file.
 *
 * Deliberately not awaited. This whole feature exists because Chromium's own print path
 * wedges the renderer permanently when it tries to open a dialog from an offscreen window;
 * blocking the engine on a child process that talks to a possibly-absent printer would
 * reintroduce the failure shape the interception was built to remove. The PDF is already
 * on disk and already reported before this runs, so a queue that never answers costs the
 * user nothing they had. The 15-second child-process timeout turns that last shape into an
 * ordinary failed badge rather than an invisible paper job that waits forever.
 */
function sendToPrintQueue(destination, transfer) {
  execFile("lpr", [destination], { timeout: 15_000 }, (error, _stdout, stderr) => {
    const outcome = printQueueOutcome(error, stderr);
    // The PDF's completed badge scheduled its own expiry before lpr started. It must not
    // erase this newer result halfway through its six-second hold.
    if (transferBadgeTimer) {
      clearTimeout(transferBadgeTimer);
      transferBadgeTimer = null;
    }
    // Un-gated for the same reason settleTransfer's line is: the user pressed a key asking
    // for paper and has no other surface on which to learn what happened to it.
    console.error(`tweb: print to paper ${outcome.ok ? "queued" : "failed"} ${destination}: ${outcome.message}`);
    sendToMainTabFrame(currentWindows().win, "tweb-print-paper", {
      ok: outcome.ok,
      message: outcome.message,
      filename: transfer ? transfer.filename : path.basename(destination),
    });
  });
}

function runBrowserContextMenuCommand(tab, action) {
  const state = contextMenuStateByTab.get(tab);
  contextMenuStateByTab.delete(tab);
  if (!state || tab !== currentWindows().win || tab.isDestroyed()) return;
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
    case "toggle-float": toggleFloat(); break;
    case "inspect":
      sendToMainTabFrame(tab, "tweb-context-inspect", { x: params.x, y: params.y });
      break;
  }
}

function showBrowserContextMenu(tab, inputParams) {
  if (tab !== currentWindows().win || tab.isDestroyed()) return;
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
  // A floating tab is intentionally visible on the OS desktop — the watchdog would
  // hide it every tick, fighting the user's `tweb float`. Skip it here rather than
  // in the watchdog, so the watchdog's "hide everything" loop stays simple.
  if (floatingTabs.has(tab)) return;
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
  // Hiding is genuinely process-wide — a window belongs to no pane as far as the OS is concerned.
  for (const window of BrowserWindow.getAllWindows()) keepWindowHidden(window);
  // Surfaces are reconciled on the same tick. A transition calls `updatePaintingState`
  // directly, but a pane that is *born* hidden has no transition to react to — measured:
  // an engine started in an unviewed tmux window reported terminalVisible=false and sent
  // zero frames, yet held a full-size surface indefinitely, which is the DESIGN.md 6.5
  // gate failing at the one moment it most obviously should not. The reconciler reads
  // each window's size before writing it, so a tick that has nothing to do costs nothing.
  //
  // Per pane, because that is what the reconciler decides: this pane's visibility against this
  // pane's tabs at this pane's frame rate. Run once for the first pane it would have collapsed
  // every other pane's surfaces against a visibility that was not theirs.
  forEachPane(() => updatePaintingState());
}

function configureTab(tab, initialZoomFactor = defaultZoomFactor) {
  // Every handler registered below runs as work belonging to this tab's pane.
  //
  // Registration cannot capture the pane: verified under Electron 43 that a `paint` handler
  // registered outside a store reads `undefined`, and `configureTab` runs before `adoptTab` records
  // the mapping anyway. So the pane is resolved when the handler fires, from the tab it fires for.
  //
  // Registered through these three rather than one wrap per handler, so a handler added later is
  // bound by writing it in the same style as the rest — the failure mode of the per-handler form is
  // that the one somebody forgets falls back to the first pane and silently draws into it.
  const scoped = (handler) => bindPane(() => tabPanes.get(tab), handler);
  const onContents = (event, handler) => contents.on(event, scoped(handler));
  const onTab = (event, handler) => tab.on(event, scoped(handler));
  const setWindowOpenHandler = (handler) => contents.setWindowOpenHandler(scoped(handler));
  const contents = tab.webContents;
  // A floating window takes focus from the tmux pane, so `w` (the toggle key)
  // would not reach the pane's key handler. Catch it here and toggle back.
  // This is after `const contents` so the reference is initialised.
  contents.on("before-input-event", scoped((_event, input) => {
    if (!floatingTabs.has(tab)) return;
    if (input.type === "keyDown" && input.key === "w" && !input.control && !input.meta) {
      toggleFloat();
    }
  }));
  const keepHidden = () => keepWindowHidden(tab);
  keepHidden();
  attachChooserDebugger(tab);
  // A frame with no preload gets its print shim from here; see shimFramePrint.
  onContents("frame-created", (_event, details) => shimFramePrint(details.frame));
  onTab("show", keepHidden);
  onTab("focus", keepHidden);
  onTab("move", keepHidden);
  onContents("preload-error", (_event, preloadPath, error) => {
    console.error(`tweb: preload failed ${preloadPath}: ${error.stack || error.message}`);
  });
  watchConsole(contents);
  tabZoomFactors.set(tab, initialZoomFactor);
  contents.setZoomFactor(initialZoomFactor);
  contents.setBackgroundThrottling(true);
  contents.setFrameRate(1);
  // A muted instance opening a tab must not leak audio through the new one.
  contents.setAudioMuted(audioMutedByOther);
  onContents("paint", (_event, dirty, image) => {
    // A page painting on its own is what separates video from a static screen, and the
    // frame-rate policy reads it to decide whether to fall all the way to idle.
    if (tab === currentWindows().win) notePaintActivity();
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
  setWindowOpenHandler((details) => {
    const target = details.url || "about:blank";
    // Middle-click and window.open share this path, and Chrome treats them differently:
    // window.open takes you to the new tab, middle-click deliberately does not. The whole
    // point of the gesture is to queue several links off a results page while staying
    // where you are — force-activating the first one lands the rest on the wrong document,
    // which makes the gesture worse than an ordinary click rather than better.
    const activate = details.disposition !== "background-tab";
    setImmediate(() => createTab(target, activate));
    return { action: "deny" };
  });

  onContents("did-start-navigation", (details) => {
    if (details.isSameDocument || !details.frame) return;
    if (details.isMainFrame) scheduleLoadingProgress(tab, 0.3);
    const key = frameKey(details.frame);
    readyFrameKeys(tab).delete(key);
    // Both sets are keyed the same way and go stale the same way, but only the ready set was
    // pruned here. A leftover shortcut key makes `sendToFocusedTabFrame` believe a dead frame
    // can take shortcuts, so it skips the fall-back to the main frame and drops the key.
    shortcutFrameKeys(tab).delete(key);
    // A new document has no find session behind it. Carrying the old flag over would send
    // the next query as a follow-up to a session that no longer exists, and Chromium
    // answers that with silence — the exact failure this state exists to prevent.
    if (details.isMainFrame) findSessionByTab.set(tab, endStep().state);
  });
  onContents("context-menu", (_event, params) => {
    if (inputState().vimium) showBrowserContextMenu(tab, params);
  });
  onContents("media-started-playing", () => {
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
  onContents("media-paused", () => {
    if (debugLogging) console.error("tweb: media paused");
    // The release itself is debounced in reconcileAudio; this only makes the pane
    // notice its own silence on the next tick rather than several ticks later.
    reconcileAudio();
  });
  onContents("found-in-page", (_event, result) => {
    sendToTabFrames(tab, "tweb-find-result", result);
  });
  // The document exists and the page is now fetching what it references. Nothing is scheduled
  // here: if the delay has not elapsed the pending first step just carries the higher value,
  // and a page that reached this within the delay still shows nothing.
  onContents("dom-ready", () => {
    if (loadingTimersByTab.has(tab)) scheduleLoadingProgress(tab, 0.7);
    else sendLoadingProgress(tab, 0.7);
  });
  // Gone on the way out, whether the load worked or not. `did-stop-loading` covers the
  // ordinary end, a stop, and a failure alike — a bar left behind by an error page would be
  // the most annoying form of this feature.
  onContents("did-stop-loading", () => sendLoadingProgress(tab, null));

  let showingLoadError = false;
  const recordNavigation = (url) => {
    if (showingLoadError || !isRestorableUrl(url)) return;
    tabSessionUrls.set(tab, url);
    recordNavigationHistory(url, contents.getTitle());
    scheduleWindowSessionSave();
  };
  onContents("did-navigate", (_event, url) => recordNavigation(url));
  onContents("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) recordNavigation(url);
  });

  let initialZoomApplied = false;
  onContents("did-finish-load", () => {
    showingLoadError = false;
    const zoomFactor = tabZoomFactors.get(tab) ?? defaultZoomFactor;
    contents.setZoomFactor(zoomFactor);
    contents.invalidate();
    // Autofocused fields report their caret before this zoom lands.
    if (tab === currentWindows().win) {
      broadcastCellMetrics(tab);
      reparkTerminalCaret();
    }
    if (!initialZoomApplied) {
      initialZoomApplied = true;
      if (debugLogging) console.error(`tweb: default zoom ${zoomFactor.toFixed(3)}`);
    }
    installPageEnhancements(tab);
    sendToTabFrames(tab, "tweb-shortcuts-mode", { vimium: inputState().vimium, bypass: inputState().bypass });
    if (debugLogging) {
      console.error(`tweb: loaded ${contents.getURL()} (${contents.getTitle()})`);
    }
  });
  onTab("page-title-updated", (_event, title) => {
    const url = tabSessionUrls.get(tab) || contents.getURL();
    recordNavigationHistory(url, title);
    sendTabState();
    if (debugLogging) console.error(`tweb: title ${title}`);
  });
  onContents("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || showingLoadError) return;
    showingLoadError = true;
    console.error(`tweb: failed to load ${failedUrl}: ${description} (${code})`);
    void contents.loadURL(errorPage(failedUrl || contents.getURL(), code, description));
  });
  // A lost render process leaves an offscreen tab dead but silent: the bytes are released, the
  // engine keeps answering `tweb status` with a healthy pid, and the pane holds the last image
  // it was sent. Chromium restarts a *visible* window's renderer on its next paint; an
  // offscreen one has no such trigger, so nothing ever comes back without this.
  onContents("render-process-gone", (_event, details) => {
    const reason = details?.reason;
    findSessionByTab.set(tab, endStep().state);
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
  // The pane whose scope we were called in — `attachPane` establishes it, and a tab opened from an
  // existing tab inherits it through that tab's bound handlers. Recorded before `configureTab` so
  // the handlers it registers can resolve this tab the first time they fire.
  const record = currentPane();
  tabPanes.set(tab, record);
  if (currentWindows().tabs.includes(tab)) return tab;
  configureTab(tab, initialZoomFactor);
  tabSessionUrls.set(tab, url || "about:blank");
  currentWindows().tabs.push(tab);
  const index = currentWindows().tabs.length - 1;

  tab.on("closed", bindPane(() => tabPanes.get(tab), () => {
    tabPanes.delete(tab);
    const closedIndex = currentWindows().tabs.indexOf(tab);
    if (closedIndex < 0) return;
    const wasActive = tab === currentWindows().win;
    tabFrames.delete(tab);
    tabZoomFactors.delete(tab);
    tabSessionUrls.delete(tab);
    tabRendererRecoveries.delete(tab);
    currentWindows().tabs.splice(closedIndex, 1);
    if (currentWindows().tabs.length === 0) {
      currentWindows().win = null;
      currentWindows().activeTabIndex = -1;
      // One pane running out of tabs is that pane closing, not the process ending. A per-pane
      // engine serves exactly one, so its last tab IS the last tab and quitting is right; a host
      // serving others would take them all down with it.
      if (quitting) return;
      if (hostedRuntime && paneRegistry.size > 1) closePane(record, "last tab closed");
      else app.quit();
      return;
    }
    if (wasActive) activateTab(Math.min(closedIndex, currentWindows().tabs.length - 1));
    else {
      if (closedIndex < currentWindows().activeTabIndex) currentWindows().activeTabIndex -= 1;
      sendTabState();
    }
    if (refreshTabListAfterClose) {
      refreshTabListAfterClose = false;
      sendToTabFrames(currentWindows().win, "tweb-tabs", tabListModel());
    }
    scheduleWindowSessionSave();
  }));

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
  showInitialPlaceholder = currentWindows().tabs.length === 0
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

  inputState().clicks.reset();
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
    for (const tab of currentWindows().tabs) {
      if (tab.isDestroyed()) continue;
      applySurfacePlan(tab, surfacePlan(tab === currentWindows().win, record.visible, logical, surfaceHeldForAgent(), inputState().floating));
    }
  }
  currentWindows().win?.webContents.invalidate();
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
    const initialUrl = sess().restore && !isRestorableUrl(url)
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
  return currentWindows().win;
}

// --- browser input ---

// This pane's input-stream state, on its record.
//
// One buffer for N panes crosses input, and not subtly: `ESC [` is an incomplete sequence, so the
// parser keeps it and waits for the final byte — and the next pane's INPUT line appends to that same
// buffer. Measured with three panes, sending `ESC [` to %10 and `jjj` to %11: %11's page received
// `[Escape` and no `j` at all, while %10 received nothing. The flush timer is per-pane for the same
// reason: armed in one pane's scope, it delivers a leftover ESC to whichever pane's bytes are in the
// buffer when it fires.
//
// The paste body, the UTF-8 decoder's split-codepoint carry, and the click-count state are all the
// same input stream and cross the same way — a paste in one pane swallowing another's typing, a
// multi-byte character split across panes, a double-click assembled from two panes' clicks.
const paneInputStates = new Map();

// A pane's tmux identity between its `SESSION` line and the `ATTACH` that follows. Keyed by pane id
// rather than pane key because the key includes a generation the SESSION line does not carry — it
// is written immediately before the attach it belongs to and consumed by it.
const pendingSessionIdentities = new Map();

function inputState() {
  const record = currentPane();
  let state = paneInputStates.get(record.key);
  if (!state) {
    state = {
      raw: Buffer.alloc(0),
      flushTimer: null,
      paste: new PasteState(),
      decoder: new StringDecoder("utf8"),
      clicks: new MouseClickState(),
      // Where this pane's terminal cursor is parked for IME preedit, and whether it is showing.
      caretCell: null,
      caretPoint: null,
      caretHidden: false,
      // The shortcut mode, and the mirror of the preload's insert mode that key dispatch reads.
      vimium: true,
      bypass: false,
      insertMode: false,
      // Whether this pane's page is shown as an OS desktop window (floating mode).
      floating: false,
    };
    paneInputStates.set(record.key, state);
  }
  return state;
}

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
  if (!currentWindows().win) return;
  const contents = currentWindows().win.webContents;
  // Chromium keeps zoom per origin, so getZoomFactor() reports whatever another
  // tab on the same host last set. Step from this tab's own remembered value.
  const current = tabZoomFactors.get(currentWindows().win) ?? contents.getZoomFactor();
  const next = action === "reset"
    ? defaultZoomFactor
    : Math.min(2, Math.max(0.5, current * (action === "in" ? 1.2 : 1 / 1.2)));
  tabZoomFactors.set(currentWindows().win, next);
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
  if (!currentWindows().win) return;
  const contents = currentWindows().win.webContents;
  const { x, y } = logicalMousePoint(rawX, rawY);
  const clicks = inputState().clicks;
  const modifiers = mouseModifiers(cb);
  const buttonCode = cb & 3;
  const motion = (cb & 32) !== 0;
  const wheel = (cb & 64) !== 0;

  if (wheel) {
    const direction = buttonCode === 0 ? 1 : buttonCode === 1 ? -1 : 0;
    if (inputState().vimium && direction !== 0 && hasZoomModifier(modifiers)) {
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
    clickCount = clicks.press(button, x, y);
  } else if (type === "mouseUp") {
    clickCount = clicks.release(button).count;
  } else {
    clicks.move(button, x, y);
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

// Half of a `gg`, kept next to the key path rather than in the pure mapping so the
// mapping stays a function of its arguments.
// Tabs currently shown as OS desktop windows (floating mode, see surface-policy.cjs).
let floatingTabs = new Set();
let pdfPendingG = false;
let pdfPendingGTimer = null;

/// Runs a key inside Chromium's PDF viewer when the tab is showing one.
///
/// Returns true when the key was consumed. The reasoning, the measurements behind it, and
/// what stays out of reach are in electron/pdf-frame.cjs: every input path Chromium offers
/// leaves the viewer's rendered bytes identical, and calling the viewer's own viewport API
/// is the only thing that moves it.
///
/// Deliberately not awaited by the caller. The script resolves a frame round-trip later,
/// and a keystroke that waited for it would make held keys stutter; each call reads the
/// position inside the frame, so two in flight still compose.
function routePdfKey(key, modifiers) {
  if (!currentWindows().win || currentWindows().win.isDestroyed()) return false;
  const frame = findPdfFrame(currentWindows().win.webContents.mainFrame);
  if (!frame) {
    pdfPendingG = false;
    return false;
  }
  const next = pdfKeyAction(key, modifiers, { vimium: inputState().vimium, pendingG: pdfPendingG });
  clearTimeout(pdfPendingGTimer);
  pdfPendingG = next.pendingG;
  // The same 800ms the preload gives `g`, so a `g` typed alone does not silently arm a
  // jump-to-start for the next keystroke minutes later.
  if (pdfPendingG) pdfPendingGTimer = setTimeout(() => { pdfPendingG = false; }, 800);
  // A pane nobody is watching has its offscreen surface collapsed, so the viewer's own
  // viewport height is not the height the user reads the PDF at. See pdf-frame.cjs.
  const script = pdfViewportScript(next.action, logicalContentSize(currentViewport()).height);
  if (!script) return next.pendingG;
  frame.executeJavaScript(script, true).then((result) => {
    if (debugLogging) console.error(`tweb: pdf key ${key} -> ${JSON.stringify(result)}`);
  }).catch((error) => {
    if (debugLogging) console.error(`tweb: pdf key ${key} failed: ${error.message}`);
  });
  return true;
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
  if (!currentWindows().win || !key) return;
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
    if (pressed) sendToTabFrames(currentWindows().win, "tweb-select-all");
    return;
  }

  // Editing commands are driven directly rather than dispatched as key events:
  // the renderer knows the selection and the focused field, so this works while
  // typing (mode E) where it matters most. Ghostty's own Cmd-C/V act on the
  // terminal selection instead, which is why these need a passthrough entry.
  if (modifiers.includes("meta") && ["c", "v", "x"].includes(key.toLowerCase())) {
    if (pressed) {
      const contents = currentWindows().win.webContents;
      if (key.toLowerCase() === "c") contents.copy();
      else if (key.toLowerCase() === "v") contents.paste();
      else contents.cut();
    }
    return;
  }

  // Ctrl-C quits the pane only in browser shortcut mode. In web passthrough mode it goes to
  // the page as an ordinary KeyboardEvent.
  if (inputState().vimium && key.toLowerCase() === "c" && control) {
    if (pressed) app.quit();
    return;
  }

  if (inputState().vimium) {
    const tabCycle = control && (key === "Tab" || key === "PageDown" || key === "PageUp");
    const tabClose = control && key.toLowerCase() === "w";
    const print = control && key.toLowerCase() === "p";
    // Ctrl-D only belongs to a transfer while one is running. Claiming it unconditionally
    // would take a key away from the page for a feature that has nothing to cancel.
    const cancel = control && key.toLowerCase() === "d"
      && transfers.some((entry) => entry.state === "progressing");
    const zoom = hasZoomModifier(modifiers) && ["+", "=", "-", "0"].includes(key);
    if (tabCycle || tabClose || print || cancel || zoom) {
      if (pressed) {
        if (key === "Tab") cycleTab(shift ? -1 : 1);
        else if (key === "PageDown") cycleTab(1);
        else if (key === "PageUp") cycleTab(-1);
        else if (tabClose) closeTab();
        else if (print) void printPageToPdf();
        else if (cancel) cancelTransfer();
        else if (key === "+" || key === "=") setBrowserZoom("in");
        else if (key === "-") setBrowserZoom("out");
        else if (key === "0") setBrowserZoom("reset");
      }
      return;
    }
  }

  // A PDF is rendered by an extension frame the preload never reaches, so both the
  // passthrough and the vimium key paths below would deliver into an empty document.
  // Only the press is routed: the viewer has no notion of a key being held.
  if (pressed && routePdfKey(key, modifiers)) return;

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
  if (!inputState().vimium || inputState().insertMode || modifiers.includes("meta")) {
    dispatchNativeKey(currentWindows().win.webContents, key, text, modifiers, eventKind);
    return;
  }
  sendToFocusedTabFrame(currentWindows().win, "tweb-terminal-key", {
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
  if (!currentWindows().win || !text) return;
  const contents = currentWindows().win.webContents;
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
    const text = inputState().decoder.write(buffer.subarray(offset));
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

// Cmd motions inside a text field. macOS semantics: Cmd-Left/Right travel to the ends of
// the line, Cmd-Up/Down to the ends of the field, and Shift extends the selection to the
// same place. `Home`/`End` are reused for the line pair because the preload's movers
// already know what those mean in an input and a textarea.
const CMD_CARET_MOTIONS = new Map([
  [5024, { key: "Home", extend: false }],
  [5025, { key: "End", extend: false }],
  [5026, { key: "DocumentStart", extend: false }],
  [5027, { key: "DocumentEnd", extend: false }],
  [5028, { key: "Home", extend: true }],
  [5029, { key: "End", extend: true }],
  [5030, { key: "DocumentStart", extend: true }],
  [5031, { key: "DocumentEnd", extend: true }],
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
    setVimiumShortcutsEnabled(!inputState().vimium);
    return;
  }
  // The legacy forced ON/OFF sequences — under the new flags they force bypass.
  if (code === 5011 || code === 5012) {
    setCmdBypassEnabled(code === 5012);
    return;
  }
  // Driven through the renderer rather than as a key event, and this was measured rather
  // than assumed. Sending the combination straight to Electron does nothing at all — same
  // field, caret at offset 12, each key delivered by `sendInputEvent`:
  //
  //     Left               12 -> 11        moved
  //     Shift-Left         12 -> [11,12]   selected
  //     Cmd-Left           12 -> 12        nothing
  //     Cmd-Shift-Right    12 -> 12        nothing
  //     Cmd-Up (textarea)  20 -> 20        nothing
  //     Cmd-Left (in a contenteditable)    nothing
  //
  // The plain arrows work because Blink moves the caret itself. Cmd-arrow is not web
  // behaviour at all: on macOS, AppKit translates the key into an editing selector like
  // `moveToBeginningOfLine:` before the web content ever sees it, and a synthetic key
  // skips that translation entirely. Nothing downstream gives it meaning, which is the
  // same reason Cmd-C/V/X and Cmd-A are driven directly a few lines above.
  const motion = CMD_CARET_MOTIONS.get(code);
  if (motion) {
    sendToFocusedTabFrame(currentWindows().win, "tweb-caret-motion", motion);
    return;
  }
  const cmdKey = CMD_PRIVATE_KEYS.get(code);
  if (cmdKey) {
    // 1 + meta(8). Sent to the page regardless of the bypass flag — in any mode,
    // what the user pressed is that web app's Cmd shortcut.
    dispatchNamedKey(cmdKey, 9);
    return;
  }
  if (inputState().vimium) {
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
  // Captured once, and the timer closes over it: the ambient scope carries into the callback, but
  // resolving again there would re-read a map for a pane we already have in hand.
  const input = inputState();
  if (input.flushTimer || input.raw.length === 0) return;
  input.flushTimer = setTimeout(() => {
    input.flushTimer = null;
    if (input.raw[0] === 0x1b) {
      // An ESC-prefixed sequence that ends without further bytes is a real Escape key. After a
      // short disambiguation window, deliver that first ESC and re-parse the rest.
      dispatchKey(27);
      input.raw = input.raw.subarray(1);
      consumeRawInput();
    }
  }, 35);
}

function consumeRawInput() {
  // One lookup for the whole parse: this pane's buffer, paste state and decoder.
  const input = inputState();
  for (;;) {
    if (input.raw.length === 0) return;

    // A paste body is never parsed as escape sequences. It can hold arbitrary bytes
    // including ESC, and everything up to the closing bracket is text to paste.
    if (input.paste.active) {
      const chunk = input.raw;
      input.raw = Buffer.alloc(0);
      const done = input.paste.push(chunk);
      if (!done) return;
      if (done.dropped) {
        if (debugLogging) console.error("tweb: paste exceeded limit, dropped");
        return;
      }
      input.raw = done.rest;
      dispatchPaste(done.text);
      continue;
    }

    const escape = input.raw.indexOf(0x1b);
    if (escape > 0) {
      dispatchText(input.raw.subarray(0, escape));
      input.raw = input.raw.subarray(escape);
      continue;
    }
    if (escape < 0) {
      dispatchText(input.raw);
      input.raw = Buffer.alloc(0);
      return;
    }

    const decoded = input.raw.toString("utf8");

    // Start of a bracketed paste. Ghostty never encodes Cmd-V as a key; the whole
    // event is paste_from_clipboard writing the clipboard into the PTY. On the
    // opening bracket, collect the body that follows and handle it as one paste.
    if (input.paste.begins(input.raw)) {
      // Stops the ESC-disambiguation timer from firing mid-paste and committing the
      // body's first byte as an Escape key.
      if (input.flushTimer) {
        clearTimeout(input.flushTimer);
        input.flushTimer = null;
      }
      input.paste.start();
      input.raw = input.raw.subarray(PASTE_START.length);
      continue;
    }

    // Focus reporting is not used. An ESC[I/ESC[O left over from a previous run or from
    // tmux/terminal state is never forwarded as browser text or a shell string either.
    const focus = /^\x1b\[[IO]/.exec(decoded);
    if (focus) {
      input.raw = input.raw.subarray(Buffer.byteLength(focus[0]));
      continue;
    }

    // 5001-5012 are the existing shortcuts, 5013-5019 the mode toggles
    // (5014 = Ctrl-:), and 5020 and up the Cmd combinations.
    let match = /^\x1b\[(50(?:0[1-9]|1[0-9]|[2-9][0-9]))~/.exec(decoded);
    if (match) {
      dispatchPrivateShortcut(Number(match[1]));
      input.raw = input.raw.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(decoded);
    if (match) {
      dispatchMouse(Number(match[1]), Number(match[2]), Number(match[3]), match[4] === "m");
      input.raw = input.raw.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    match = /^\x1b\[([0-9]+)(?::[0-9]+)*(?:;([0-9]+)(?::([123]))?)?(?:;([0-9:]+))?u/.exec(decoded);
    if (match) {
      // A CSI sequence written as literal text — a `keybind = home=text:\x1b[1~`, or this
      // engine's own `ESC[5008~` Cmd codes coming back through the terminal — has its
      // leading ESC encoded as a key in its own right once modified keys are on. What
      // arrives is `ESC[91;3u` (Alt-`[`) with the rest of the sequence trailing behind it,
      // so Home read as Alt-`[` and the `1~` after it was dropped.
      //
      // Unfolding it here rather than at the source covers every leg: whatever did the
      // folding, the bytes are put back and the matchers below handle Home, End and the
      // private shortcuts as they always did. A real Alt-`[` with nothing after it still
      // dispatches — what is given up is a real Alt-`[` arriving in the same read as a
      // trailing CSI, which no keyboard produces.
      const folded = Buffer.byteLength(match[0]);
      if (Number(match[1]) === 91 && (Number(match[2] || 1) - 1) & 0b10 && input.raw.length > folded) {
        input.raw = Buffer.concat([Buffer.from("\x1b["), input.raw.subarray(folded)]);
        continue;
      }
      const text = match[4] ? match[4].split(":").map(Number).filter(Number.isFinite) : [];
      dispatchKey(Number(match[1]), Number(match[2] || 1), Number(match[3] || 1), text);
      input.raw = input.raw.subarray(folded);
      continue;
    }

    match = /^\x1b\[(?:1;([2-8]))?([ABCDHF])/.exec(decoded);
    if (match) {
      const keys = { A: "ArrowUp", B: "ArrowDown", C: "ArrowRight", D: "ArrowLeft", H: "Home", F: "End" };
      dispatchNamedKey(keys[match[2]], Number(match[1] || 1));
      input.raw = input.raw.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    match = /^\x1b\[(\d+)(?:;([2-8]))?~/.exec(decoded);
    if (match) {
      const keys = {
        1: "Home", 2: "Insert", 3: "Delete", 4: "End", 5: "PageUp", 6: "PageDown",
        11: "F1", 12: "F2", 13: "F3", 14: "F4", 15: "F5", 17: "F6",
        18: "F7", 19: "F8", 20: "F9", 21: "F10", 23: "F11", 24: "F12",
      };
      if (keys[match[1]]) dispatchNamedKey(keys[match[1]], Number(match[2] || 1));
      input.raw = input.raw.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    match = /^\x1bO([P-SABCDHF])/.exec(decoded);
    if (match) {
      const keys = {
        P: "F1", Q: "F2", R: "F3", S: "F4",
        A: "ArrowUp", B: "ArrowDown", C: "ArrowRight", D: "ArrowLeft", H: "Home", F: "End",
      };
      dispatchNamedKey(keys[match[1]]);
      input.raw = input.raw.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    match = /^\x1b\[27;([2-8]);(\d+)~/.exec(decoded);
    if (match) {
      dispatchKey(Number(match[2]), Number(match[1]));
      input.raw = input.raw.subarray(Buffer.byteLength(match[0]));
      continue;
    }

    // Modified keys use modifyOtherKeys or Kitty CSI-u, both enabled by the
    // frontend. Treating ESC + printable as legacy Alt swallows a quick
    // Escape followed by a normal-mode key; the fallback below emits Escape
    // and then reparses the remaining printable input instead.

    // If the escape sequence is still incomplete, wait for the next INPUT chunk.
    // A lone ESC is settled as the Escape key once the short disambiguation window passes.
    if (/^\x1b(?:\[|\[<|O)?[0-9;:<]*$/.test(decoded)) {
      scheduleRawInputFlush();
      return;
    }

    // An unrecognized ESC is delivered as the Escape key, consuming just that one byte.
    dispatchKey(27);
    input.raw = input.raw.subarray(1);
  }
}

// --- resize/input control channel ---
// tweb-pane forwards SIGWINCH and raw terminal input over this pipe.

// What an ATTACH does, and what it refuses.
//
// Every refusal below records NOTHING. That asymmetry is the subject of this seam: a host that
// registered the pane, allocated its writer and handed back an agent socket without opening a
// window would be worse than one that refuses, because the supervisor would count the attach as
// accepted, the frontend would stop falling back, and the pane would sit blank forever with every
// check green. That state was produced once and observed exactly that way.
//
// A refusal leaves the frontend its own engine, which is a working browser.
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

  // Two panes with the same id on different tmux servers cannot both be hosted here, because an
  // addressed control line carries `@%N` and no server — so a second one would make every VIS,
  // RESIZE and INPUT for that id ambiguous, and `resolveTarget` answers null rather than guessing.
  // Refusing the second is what keeps the answer unique; that frontend spawns its own engine and
  // works. The daemon refuses this too, which is the half that matters: an engine-only refusal
  // would leave the supervisor believing the pane was accepted.
  const sameId = paneRegistry.allById(command.paneId);
  if (sameId.length > 0 && sameId.some((record) => record.tmuxServer !== command.tmuxServer)) {
    const other = sameId.find((record) => record.tmuxServer !== command.tmuxServer);
    console.error(`tweb: refusing ATTACH for ${command.paneId}: already hosted for tmux server`
      + ` ${other.tmuxServer || "local"}, and an addressed line cannot tell them apart`);
    return;
  }

  // A second pane used to be refused here, because the window and tab plumbing reached for one
  // global context and a second attach would have drawn into the first pane's window. That plumbing
  // is per-pane now, and `bench/host-multipane.py` is what says so rather than this comment: 5 panes
  // in one engine, each rendering its own image id, no crossed frames, no pane resolved by falling
  // back to the first, each holding its own tmux placement and client set, input parsed per pane,
  // modes isolated, and a detached pane's windows torn down while the others keep running. Every one
  // of those gates was verified to fail when the state it guards is put back the way it was.
  //
  // `twebd` still refuses to use a host, independently, because `hostProtocolVersion()` returns
  // null. That is the gate that decides whether any of this is reached in a shipping build, and
  // opening it is a separate decision — the supervisor's READY handshake has to be confirmed
  // against a host that serves N panes, not just measured by a harness that speaks its protocol.
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

  // The identity its `SESSION` line carried, if it sent one. A frontend that did not — an older
  // build, or a pane outside tmux — leaves this null, and the pane simply has no window session,
  // which is what a host did for every pane until now.
  const sessionIdentity = pendingSessionIdentities.get(command.paneId) || null;
  pendingSessionIdentities.delete(command.paneId);
  if (sessionIdentity) {
    record.session.identity = sessionIdentity;
    withPaneScope(record, () => resolveWindowSessionPaths());
  }

  const frames = createFrameContext(record, { frameRate: command.frameRate });
  frameContexts.set(record.key, frames);
  if (command.viewport) applyFrameViewport(frames, command.viewport, command.origin);

  // The socket is named after the PANE. A daemon-started engine's own `TMUX_PANE` is the
  // daemon's — measured claiming `agent-%304.sock`, a name in an unrelated pane's namespace.
  const server = startAgentServer({
    paneId: record.paneId,
    // Scoped to this record: `tweb click`, `tweb screenshot` and the rest reach a window, and the
    // socket is what says which pane asked. A host has one socket per pane for exactly this.
    dispatch: (method, params) => withPaneScope(record, () => handleAgentCommand(method, params)),
    log: (message) => {
      if (debugLogging) console.error(`tweb: ${message}`);
    },
  });
  record.agentSocketPath = server.path;
  paneAgentServers.set(record.key, server);
  writeProtocolLine(formatOutbound("AGENT", record.paneId, server.path));

  // The ATTACH has carried this since the wire was written and nothing read it, because a host had
  // no session to restore. It does now: the `SESSION` line before this one gave the pane its tmux
  // window identity, and `resolveWindowSessionPaths` keyed a slot off it.
  record.session.restore = Boolean(command.restoreSession);

  const url = normalizeUrl(command.url || "https://example.com");
  // Everything below this line is the shipping path, run for the attached pane: the same
  // `applyViewport`, the same `createWindow`, the same input and agent handling. It reaches the
  // right pane because every one of them takes the record and the frame context, which is what
  // the extraction was for. What it does NOT yet do is run twice — see the refusal above.
  // Run as work belonging to this record, which is what makes `createWindow` reach THIS pane's
  // window context and what gives the tab it creates its `tabPanes` entry — every handler that tab
  // registers resolves back here from that entry, including `paint`.
  withPaneScope(record, () => {
    if (command.viewport) applyViewport(command.viewport, command.origin ?? null, frames, record);
    createWindow(url, frames);
    markInteractionActivity();
  });

  console.error(`tweb: hosting ${record.paneId} generation=${record.generation}`
    + ` image=${record.imageId} tty=${record.tty || "-"} url=${url}`);
}

/** Tears a pane down: its window, its writer, its socket and its image on the terminal. */
const panesClosing = new Set();

function closePane(record, reason) {
  // Destroying this pane's tabs fires their `closed` handlers, and the "last tab closed" branch
  // there calls back into here for the same pane. The second pass would run against state the first
  // is halfway through dismantling, and measured, it let 10 frames out after the DETACH.
  if (panesClosing.has(record.key)) return;
  panesClosing.add(record.key);
  try {
    closePaneOnce(record, reason);
  } finally {
    panesClosing.delete(record.key);
  }
}

function closePaneOnce(record, reason) {
  // The pane's windows go first, and inside its own scope: they are per-pane now, and a window left
  // running keeps painting frames addressed to a pane the registry no longer holds. Measured with
  // three panes and a DETACH of the middle one: `%10` received a frame carrying `i=5242` — %11's
  // image id — 19 pane resolutions fell back to the first pane, and `%12` stopped painting
  // altogether. Destroying the windows is what stops all three.
  withPaneScope(record, () => {
    const windows = paneWindows.get(record.key);
    if (windows) {
      // `destroy()` fires `closed`, and that handler resolves its pane from `tabPanes` — so the
      // mapping has to outlive the destroy. Clearing it first sent the handler to the first pane
      // instead: measured on a DETACH of the middle pane, %10 received a frame carrying i=5242
      // (%11's image id), 20 resolutions fell back, and %12 stopped painting.
      for (const tab of windows.tabs.slice()) {
        if (tab.isDestroyed()) continue;
        tab.webContents.stopPainting();
        tab.destroy();
      }
      for (const tab of windows.tabs.slice()) {
        tabPanes.delete(tab);
        tabFrames.delete(tab);
        tabZoomFactors.delete(tab);
        tabSessionUrls.delete(tab);
        tabRendererRecoveries.delete(tab);
      }
      windows.tabs.length = 0;
      windows.win = null;
      windows.activeTabIndex = -1;
      if (windows.frameIdleTimer) {
        clearTimeout(windows.frameIdleTimer);
        windows.frameIdleTimer = null;
      }
      paneWindows.delete(record.key);
    }
    paneInputStates.delete(record.key);
  });

  const frames = frameContexts.get(record.key);
  if (frames) {
    try {
      // In this pane's scope: `terminalCleanup` writes the image delete through `paneWrite`, which
      // picks the writer from the ambient pane. Unscoped it addressed the delete to the first pane,
      // leaving this pane's image on its terminal.
      withPaneScope(record, () => terminalCleanup(record));
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

    // SESSION carries the pane's tmux window identity and arrives immediately before its ATTACH,
    // so like ATTACH it cannot resolve through the registry — the pane it names is not registered
    // yet. It is held until the attach claims a slot with it.
    if (command.kind === "session") {
      pendingSessionIdentities.set(command.paneId, command.identity);
      continue;
    }

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

    // From here the line is addressed to a known pane, so it is handled as that pane's work: a
    // RESIZE reads that pane's origin, a VIS flips that pane's visibility, and INPUT is delivered
    // to that pane's active tab.
    withPaneScope(target, () => handleTargetedCommand(command, target));
  }
});

/**
 * A control line whose pane is already resolved.
 *
 * Called inside that pane's scope, which is why nothing here takes the record: `applyViewport`,
 * `applyVisibilityPush` and the input path all reach it the same way every other pane-owned
 * function does.
 */
function handleTargetedCommand(command, target) {
  void target;
  if (command.kind === "resize") {
    markInteractionActivity();
    // An absent origin means "leave the anchor where it is". Normalising it to 0,0 would
    // re-anchor the pane at the window's top-left, i.e. draw it over its neighbours.
    applyViewport(command.viewport, command.origin === undefined ? currentFrames().origin : command.origin);
    return;
  }

  // The frontend's pane visibility push — see the pane visibility section. It is not
  // interaction, so unlike RESIZE/INPUT it deliberately does not mark activity: a
  // client attaching elsewhere must not count as someone using this pane.
  if (command.kind === "visibility") {
    applyVisibilityPush(command.hex);
    return;
  }

  if (command.kind === "input") {
    markInteractionActivity();
    const input = inputState();
    if (input.flushTimer) {
      clearTimeout(input.flushTimer);
      input.flushTimer = null;
    }
    // The escape sequence's raw bytes. Being pre-decoding, it separates "the
    // terminal never sent it" from "it arrived but was not understood" — this log
    // is how tmux re-encoding ESC[5020~ into ESC[91;3u5020~ was found. Logging
    // ordinary typing too would drown it, so only sequences are kept.
    if (debugLogging && command.hex.startsWith("1b")) {
      console.error(`tweb: input ${command.hex}`);
    }
    input.raw = Buffer.concat([input.raw, Buffer.from(command.hex, "hex")]);
    consumeRawInput();
  }
}
process.stdin.resume();

// --- app lifecycle ---

app.on("browser-window-created", (_event, window) => {
    // A floating tab is shown on purpose — do not let the watchdog hide it
    // before applySurfacePlan has had a chance to add it to floatingTabs.
    if (!floatingTabs.has(window)) keepWindowHidden(window);
  });

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock?.hide();
  // A supervisor started this process to host panes and this build cannot. Say so and stop, rather
  // than doing what a per-pane engine would do next.
  //
  // What a per-pane engine does next is the failure mode, not a harmless one: it would open its
  // own default page and paint it — into stdout, which here is the supervisor's control pipe
  // rather than any terminal. The requesting pane stays blank while megabytes of graphics go
  // into a line parser. The supervisor kills an engine that has not declared itself within
  // READY_TIMEOUT and every frontend falls back to spawning its own engine, which works; this
  // exits first so nothing is painted anywhere in the meantime.
  //
  // Unreachable in this build, where `hostProtocolVersion()` is 2. Kept because it is the answer
  // for any build where it is not — a version bump the daemon has not learned, or a host that is
  // deliberately disabled — and because an early exit here is what preserves the fallback.
  if (hostedRuntime && hostProtocolVersion() === null) {
    console.error("tweb: started as a pane host, but this build has no page host — exiting so"
      + " the supervisor falls back to per-pane engines");
    app.quit();
    return;
  }
  configureDownloads();
  watchNetwork();
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
    // `hostReady` first, then the declaration, in that order and in this tick. stdin was resumed
    // before `whenReady` ran, so the daemon's first ATTACH can arrive as soon as READY is out —
    // declaring first would race it into the `!hostReady` refusal below.
    hostReady = true;
    const protocol = hostProtocolVersion();
    if (protocol === null) {
      // Unreachable from the guard above, which exits when the version is null. Kept because the
      // two answers must not drift: an engine that got here without a version to declare would
      // sit silent until the supervisor's READY_TIMEOUT, which is a ten-second stall rather than
      // the immediate fallback that guard buys.
      console.error("tweb: pane host cannot declare a protocol version");
      app.quit();
      return;
    }
    writeProtocolLine(`READY ${protocol}\n`);
    console.error(`tweb: pane host ready (protocol ${protocol}), waiting for attach`);
    return;
  }

  terminalSetup();
  // Before the first navigation, not after: a DNR rule enabled once a page has begun loading
  // does not retroactively block that page's requests, so an ad blocker wired up after
  // `createWindow` would miss the very first page the user opens. The await is why
  // `whenReady` is async — a few tens of milliseconds of startup buys a session whose rules
  // are armed for request one.
  await setUpExtensions();
  if (sess().restore) {
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
    ? `adaptive ${idleFrameRate}/≤${maxActiveFrameRate} (playback ≤${
      Math.round(PLAYBACK_BYTE_BUDGET / 1e6)}MB/s)`
    : `fixed ${maxActiveFrameRate}`}fps`
    + ` · zoom ${Math.round(defaultZoomFactor * 100)}%`);
});

// The frame files a set of panes owns, as paths. The naming rule and the enumeration live in
// pane-registry.cjs and teardown.cjs — pure, and tested there; this only joins them to the
// userData directory, which is the one part that needs Electron.
function paneFrameFilePaths(records) {
  return paneFrameFileList(records, process.pid)
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
  removeFrameFiles(paneFrameFilePaths([record]));
}

function cleanupFrameFiles() {
  // Every live pane, plus the sole pane: it is attached to the registry on the default path and not
  // on the hosted one (see the `attach` guarded by `!hostedRuntime`), and `paneFrameFileList` dedupes
  // by image id, so naming it both ways costs nothing while forgetting it leaks. The enumeration is
  // pure and tested because it is only ever reached from `before-quit` and the exit handler — no
  // test and no measurement exercises it here, which is how a dead identifier once survived a green
  // suite and took the whole teardown with it.
  removeFrameFiles(paneFrameFilePaths([...paneRegistry.list(), solePane]));
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

// Every step guarded, and every failure logged. A throw out of this listener is not contained by
// anything: Electron may cancel the quit outright — an orphaned engine was observed logging "owner
// is gone, quitting" and then living on at ppid=1 with its window up, its image still placed on the
// terminal and its 1.5MB frame file on disk — and where the quit does survive the throw, everything
// after the throwing step is simply skipped, silently. Both were measured. On this Electron the
// second is what reproduces: one dead identifier in the frame-file enumeration cut the teardown
// from 532 bytes to 413, so `terminalCleanup`, all ten image deletes and the title restore never
// ran, with nothing in the log to say why. A stranded image on a real terminal is invisible from
// inside the process, so the failure is logged rather than swallowed. The steps are independent
// effects on different surfaces, so each is attempted whether or not the one before it worked; see
// `teardown.cjs`.
app.on("before-quit", () => {
  runTeardown([
    ["agent server", () => {
      if (agentServer) {
        agentServer.close();
        agentServer = null;
      }
    }],
    // A clean exit hands audio back immediately rather than making the survivors wait out
    // the TTL. The TTL is what covers the exit that is not clean.
    ["audio claim", () => {
      if (audioTimer) {
        clearInterval(audioTimer);
        audioTimer = null;
      }
      clearAudioClaim();
    }],
    ["watchdog timers", () => {
      if (hiddenWindowWatchdog) {
        clearInterval(hiddenWindowWatchdog);
        hiddenWindowWatchdog = null;
      }
      if (windowSessionSaveTimer) {
        clearTimeout(windowSessionSaveTimer);
        windowSessionSaveTimer = null;
      }
    }],
    ["window session", () => {
      writeWindowSession();
      releaseWindowSessionClaim();
    }],
    ["graphics worker", () => {
      quitting = true;
      void gfxWorker.terminate();
    }],
    // Per pane: each has its own pending frame, its own tabs still painting, and its own image on
    // the terminal. Running this once for the first pane would leave every other pane's image drawn
    // over the terminal after the engine is gone — the four-hour stale-page failure, N-1 times over.
    // Guarded per pane and per surface for the same reason it is per pane: one pane whose window is
    // already destroyed must not take the remaining panes' images down with it.
    ["panes", () => forEachPane((record) => {
      const label = `pane ${record?.imageId ?? "?"}`;
      runTeardown([
        [`${label} pending frame`, () => {
          inputState().clicks.reset();
          if (currentFrames().pendingFrameTimer) {
            clearTimeout(currentFrames().pendingFrameTimer);
            currentFrames().pendingFrameTimer = null;
            currentFrames().pendingFrame = null;
          }
          currentFrames().pendingGfxFrame = null;
          if (debugLogging && currentFrames().droppedGfxFrames > 0) {
            console.error(
              `tweb: dropped ${currentFrames().droppedGfxFrames} superseded graphics frames`);
          }
        }],
        [`${label} frame files`, cleanupFrameFiles],
        [`${label} stop painting`, () => {
          for (const tab of currentWindows().tabs) {
            if (!tab.isDestroyed()) tab.webContents.stopPainting();
          }
        }],
        [`${label} terminal`, () => terminalCleanup()],
        // Each pane's image is placed on the clients watching THAT pane's window, which after the
        // move to per-pane visibility state are a different set per pane.
        [`${label} client images`, () => {
          for (const tty of vis().clientTtys) deleteImageFromClientTty(tty);
        }],
      ]);
    })],
    ["tmux passthrough", restoreTmuxPassthroughClients],
    ["pane title", restorePaneTitle],
  ]);
});

// Delete the image on process exit too (safety net). Guarded for the same reason as `before-quit`:
// this is the handler that runs when the quit path did not, so a throw out of its first step is a
// backstop that fails exactly when it is needed. It was — the enumeration it shares with the quit
// path threw the same ReferenceError, so the net had the same hole as the thing it was catching.
process.on("exit", () => {
  runTeardown([
    ["exit frame files", cleanupFrameFiles],
    // The delete that takes each pane's image off the terminal. An exit handler cannot await, so
    // this only works because every pane writer has a synchronous sink — see `fdSink`. Give a
    // writer an async sink and these deletes are dropped, stranding the images.
    // The record is already in hand, so the delete is written in that pane's scope: `writeGfx` picks
    // the writer from the ambient pane, and unscoped it would address every pane's delete to the
    // first one — leaving N-1 images on the terminal, which is precisely what this handler is for.
    ["exit image deletes", () => runTeardown(paneRegistry.list().map((record) => [
      `exit image ${record.imageId}`,
      () => withPaneScope(record, () => writeGfx(`a=d,d=I,i=${record.imageId}`, "")),
    ]))],
  ]);
});
