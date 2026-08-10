// tweb-electron/main.cjs — Electron offscreen browser → Kitty graphics.
//
// cliweb 방식 정확히 따름:
// - tmux passthrough: ESC 두 번 escape + pane origin anchor
// - a=T transfer&display, C=1, f=100 PNG, local file transport
// - frame file로 terminal byte flood를 피하고 direct transfer는 fallback으로 사용
// - alternate screen, raw mode는 tweb-pane(Rust)이 처리

const { app, BrowserWindow, clipboard, ipcMain, nativeImage, screen, session } = require("electron");
const {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} = require("node:fs");
const { execFile, execFileSync } = require("node:child_process");
const { Worker } = require("node:worker_threads");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { MouseClickState } = require("./mouse-click-state.cjs");
const { startAgentServer } = require("./agent-server.cjs");
const { buildBrowserContextMenu } = require("./context-menu.cjs");
const { visibleTmuxClientTtys } = require("./tmux-visibility.cjs");
const {
  isRestorableUrl,
  normalizeWindowSession,
  windowSessionForSave,
  windowSessionKeys,
} = require("./window-session.cjs");

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

let win = null;
const tabs = [];
const closedTabs = [];
let activeTabIndex = -1;
let quitting = false;
let browserShortcutsEnabled = true;
let terminalVisible = true;
let visibilityCheckRunning = false;
let visibleClientTtys = new Set();
const passthroughClientTables = new Map();
let tmuxIdentity = null;
let originalPaneTitle = null;
const tabFrames = new Map();
const tabZoomFactors = new Map();
const tabSessionUrls = new Map();
const navigationHistory = [];
let navigationSerial = 0;
const restoreWindowSession = process.env.TWEB_RESTORE_SESSION === "1";
let windowSessionPath = null;
let legacyWindowSessionPath = null;
let windowSessionSaveTimer = null;
let hiddenWindowWatchdog = null;
let agentServer = null;
// Mirrors the preload's insert mode so key dispatch knows to go native.
let pageInsertMode = false;
// Set while a close came from the tab list, so the list can be redrawn once the
// tab has actually left `tabs`.
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
let activeFrameRate = maxActiveFrameRate;
let frameIntervalMs = Math.ceil(1000 / activeFrameRate);
let frameIdleTimer = null;
const configuredDefaultZoom = Number.parseFloat(process.env.TWEB_DEFAULT_ZOOM || "");
const defaultZoomFactor = Number.isFinite(configuredDefaultZoom)
  ? Math.min(2, Math.max(0.5, configuredDefaultZoom))
  : 0.8;
const configuredDeviceScaleFactor = Number.parseFloat(process.env.TWEB_DEVICE_SCALE_FACTOR || "");
let pendingFrame = null;
let pendingFrameTimer = null;
let lastFrameSentAt = 0;
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
const imageId = Number.isSafeInteger(configuredImageId) && configuredImageId > 0
  ? configuredImageId
  : 1;
const frameTransport = process.env.TWEB_FRAME_TRANSPORT === "direct" ? "direct" : "file";
const frameFilePath = path.join(app.getPath("userData"), `tweb-frame-${process.pid}-${imageId}.png`);
let lastViewport = null;
let viewportGeneration = 0;
let loggedFrameGeneration = -1;
let gfxWorkerBusy = false;
let activeGfxGeneration = null;
let pendingGfxFrame = null;
let droppedGfxFrames = 0;
const gfxWorker = new Worker(path.join(__dirname, "gfx-worker.cjs"));
gfxWorker.unref();

const ESC = "\x1b";
const CSI = (s) => `${ESC}[${s}`;

// --- tmux passthrough (cliweb escapeCodes.ts 방식) ---

let tmuxOrigin = null;

function getTmuxPaneOrigin() {
  if (!process.env.TMUX_PANE) return;
  const configured = String(process.env.TWEB_PANE_ORIGIN || "").split(/[ ,]+/).map(Number);
  if (configured.length === 2 && configured.every(Number.isFinite)) {
    tmuxOrigin = { left: configured[0], top: configured[1] };
    return;
  }
  try {
    const out = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", process.env.TMUX_PANE, "#{pane_left}\t#{pane_top}"],
      { encoding: "utf8", timeout: 1000 }
    ).trim();
    const parts = out.split("\t").map(Number);
    if (parts.length >= 2) {
      tmuxOrigin = { left: parts[0], top: parts[1] };
    }
  } catch (e) {}
}

// cliweb wrapTmuxPassthrough: ESC를 두 번으로 escape.
function wrapTmuxPassthrough(sequence) {
  const escaped = sequence.split(ESC).join(ESC + ESC);
  return `${ESC}Ptmux;${escaped}${ESC}\\`;
}

// cliweb anchorTmuxGraphics: pane origin에 cursor 이동 후 graphics, 복원.
function anchorTmuxGraphics(sequence) {
  if (!tmuxOrigin) return wrapTmuxPassthrough(sequence);
  const row = tmuxOrigin.top + 1;
  const col = tmuxOrigin.left + 1;
  return wrapTmuxPassthrough(`${ESC}7${ESC}[${row};${col}H${sequence}${ESC}8`);
}

function graphicsPassthrough(sequence) {
  if (!process.env.TMUX) return sequence;
  return anchorTmuxGraphics(sequence);
}

function rawKittyDelete() {
  return `${ESC}_Ga=d,d=I,i=${imageId},q=2${ESC}\\`;
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

  // User110은 Ghostty의 Ctrl-; private sequence다. 이전 TWeb의 binding은
  // client table까지 바꿨지만, 이제 engine만 table 전환과 복원을 담당한다.
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
  ensureTmuxRootBinding(
    "User112",
    ["detach-client"],
    (binding) => binding.includes("detach-client"),
  );
}

function ensureTmuxPassthroughTable() {
  if (!process.env.TMUX_PANE) return;
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
    [
      "bind-key", "-T", passthroughTable, "User110",
      "send-keys", "-H", "1b", "5b", "35", "30", "30", "31", "7e",
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
  if (!process.env.TMUX_PANE) return new Map();
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

function reconcileTmuxPassthrough(states = listTmuxClientStates()) {
  if (!process.env.TMUX_PANE) return;
  const paneId = process.env.TMUX_PANE;

  for (const [tty, originalTable] of [...passthroughClientTables]) {
    const state = states.get(tty);
    if (browserShortcutsEnabled || !state || state.paneId !== paneId) {
      if (state) switchTmuxClientTable(tty, originalTable);
      passthroughClientTables.delete(tty);
      if (debugLogging) {
        console.error(`tweb: passthrough client restore ${tty} ${state?.paneId || "detached"} -> ${originalTable}`);
      }
    }
  }

  if (browserShortcutsEnabled) return;
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
  if (!process.env.TMUX_PANE) return;
  ensureTmuxPassthroughTable();
  try {
    const output = execFileSync(
      "tmux",
      [
        "display-message",
        "-p",
        "-t",
        process.env.TMUX_PANE,
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
        paneId: process.env.TMUX_PANE,
      };
      const keys = windowSessionKeys(tmuxIdentity);
      if (keys) {
        const directory = path.join(app.getPath("userData"), "window-sessions");
        windowSessionPath = path.join(directory, `${keys.primary}.json`);
        legacyWindowSessionPath = keys.legacy
          ? path.join(directory, `${keys.legacy}.json`)
          : null;
      }
    }
    originalPaneTitle = titleParts.join("\t");

    if (tmuxIdentity) {
      const clients = execFileSync(
        "tmux",
        ["list-clients", "-F", "#{client_tty}\t#{client_session}\t#{window_id}\t#{window_zoomed_flag}\t#{pane_id}"],
        { encoding: "utf8", timeout: 1000 }
      );
      visibleClientTtys = visibleTmuxClientTtys(clients, tmuxIdentity);
      terminalVisible = visibleClientTtys.size > 0;
    }
  } catch (error) {
    if (debugLogging) console.error(`tweb: visibility init failed: ${error.message}`);
  }
  syncTmuxVisibility();
  const timer = setInterval(syncTmuxVisibility, 150);
  timer.unref();
}

function syncTmuxVisibility() {
  if (!tmuxIdentity || visibilityCheckRunning) return;
  visibilityCheckRunning = true;
  execFile(
    "tmux",
    ["list-clients", "-F", "#{client_tty}\t#{client_session}\t#{window_id}\t#{window_zoomed_flag}\t#{pane_id}"],
    { encoding: "utf8", timeout: 1000 },
    (error, stdout) => {
      visibilityCheckRunning = false;
      if (error) return;
      const next = visibleTmuxClientTtys(stdout, tmuxIdentity);

      const wasVisible = terminalVisible;
      for (const tty of visibleClientTtys) {
        if (!next.has(tty)) deleteImageFromClientTty(tty);
      }
      const becameVisible = [...next].some((tty) => !visibleClientTtys.has(tty));
      visibleClientTtys = next;
      terminalVisible = next.size > 0;
      reconcileTmuxPassthrough();
      if (wasVisible !== terminalVisible) {
        updatePaintingState();
        if (debugLogging) {
          console.error(`tweb: visibility ${terminalVisible ? "visible" : "hidden"}`);
        }
      }
      if (becameVisible) repaintActiveTab();
    }
  );
}

// --- Kitty graphics ---

function dispatchGfxFrame(frame) {
  const png = frame.png.byteOffset === 0 && frame.png.byteLength === frame.png.buffer.byteLength
    ? frame.png
    : Buffer.from(frame.png);
  gfxWorkerBusy = true;
  activeGfxGeneration = frame.generation;
  try {
    gfxWorker.postMessage({
      type: "frame",
      buffer: png.buffer,
      byteOffset: png.byteOffset,
      byteLength: png.byteLength,
      header: frame.header,
      transport: frameTransport,
      filePath: frameFilePath,
      tmux: Boolean(process.env.TMUX),
      origin: tmuxOrigin,
    }, [png.buffer]);
  } catch (error) {
    gfxWorkerBusy = false;
    activeGfxGeneration = null;
    console.error(`tweb: graphics dispatch failed: ${error.message}`);
  }
}

function handleGfxWorkerReady() {
  const staleOutput = activeGfxGeneration !== null && activeGfxGeneration !== viewportGeneration;
  gfxWorkerBusy = false;
  activeGfxGeneration = null;
  if (staleOutput) writeGfx(`a=d,d=I,i=${imageId},q=2`, "");
  const frame = pendingGfxFrame;
  pendingGfxFrame = null;
  if (frame && frame.generation === viewportGeneration) dispatchGfxFrame(frame);
}

gfxWorker.on("message", (message) => {
  if (message?.type === "error") {
    console.error(`tweb: graphics writer failed: ${message.message}`);
  }
  handleGfxWorkerReady();
});
gfxWorker.on("error", (error) => {
  gfxWorkerBusy = false;
  activeGfxGeneration = null;
  pendingGfxFrame = null;
  console.error(`tweb: graphics writer crashed: ${error.stack || error.message}`);
});

function queueGfxFrame(png, header, generation) {
  if (generation !== viewportGeneration) return;
  const frame = { png, header, generation };
  if (!gfxWorkerBusy) {
    dispatchGfxFrame(frame);
    return;
  }
  if (pendingGfxFrame) droppedGfxFrames += 1;
  pendingGfxFrame = frame;
}

function writeGfx(header, payload) {
  // ESC _ G <header> [; <payload>] ESC \
  let raw = `${ESC}_G${header}`;
  if (payload && payload.length > 0) {
    raw += `;${payload}`;
  }
  raw += `${ESC}\\`;
  // tmux passthrough로 감쌈.
  const wrapped = graphicsPassthrough(raw);
  try {
    writeSync(1, wrapped);
  } catch (e) {}
}

// --- terminal setup ---
// 주의: tmux 안에서는 alternate screen(1049h)이나 clear screen(2J)이
// 다른 pane에 영향을 줄 수 있으므로 사용하지 않음.
// image가 pane 영역에만 placement되도록 cell 단위 placement 사용.

function terminalSetup() {
  // 아무것도 안 함. image가 자연스럽게 pane에 표시됨.
}

function requestTrackedKeyboardModeRestore() {
  if (!process.env.TMUX) return;
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

function terminalCleanup() {
  try {
    // image delete만 수행.
    writeGfx(`a=d,d=I,i=${imageId}`, "");
  } catch (e) {}
  // caret parking이 cursor shape를 bar로 바꿔 두므로 terminal 기본값으로 돌려준다.
  try {
    writeSync(1, CSI("0 q"));
  } catch (e) {}
}

// --- frame 전송 ---

function applyActiveFrameRate(rate) {
  const next = Math.min(maxActiveFrameRate, Math.max(1, Math.round(rate)));
  if (next === activeFrameRate) return;
  activeFrameRate = next;
  frameIntervalMs = Math.ceil(1000 / activeFrameRate);
  if (win && !win.isDestroyed() && terminalVisible) win.webContents.setFrameRate(activeFrameRate);
  if (debugLogging) console.error(`tweb: frame rate ${activeFrameRate}fps`);
}

function markInteractionActivity() {
  if (!adaptiveFrameRate) return;
  // Raising the rate only affects future paints, so coming out of the idle rate
  // would otherwise leave the last idle frame on screen for a whole interval —
  // a quarter second of "nothing happened" after a keypress.
  const wasIdle = activeFrameRate !== maxActiveFrameRate;
  applyActiveFrameRate(maxActiveFrameRate);
  if (wasIdle && win && !win.isDestroyed() && terminalVisible) win.webContents.invalidate();
  if (frameIdleTimer) clearTimeout(frameIdleTimer);
  frameIdleTimer = setTimeout(() => {
    frameIdleTimer = null;
    // Dropping the rate while a page is still loading stops offscreen painting
    // almost entirely: measured on google.com, the page committed at 1.4s and the
    // next frame did not go out until 5.4s. Stay at the active rate until the load
    // settles — that is precisely when the screen is changing anyway.
    if (win && !win.isDestroyed() && win.webContents.isLoading()) {
      markInteractionActivity();
      return;
    }
    applyActiveFrameRate(idleFrameRate);
  }, 700);
}

// A placement the next frame will not fully cover has to be deleted, but the
// delete is paired with the replacement so the pane is never left bare: on its
// own it would bare the terminal for as long as the frame takes to arrive.
let framesSentCount = 0;
let pendingImageDelete = false;
// The terminal holds the last image we transferred under `imageId`, which lets a
// resize re-place it without sending the pixels again.
let imageTransferred = false;

// `d=i` drops the placements but keeps the image data, so it can be re-placed.
function deletePlacement() {
  pendingImageDelete = false;
  writeGfx(`a=d,d=i,i=${imageId},q=2`, "");
}

// Chromium needs a moment to repaint at a new size, and tmux has already redrawn
// the pane underneath — so a resize would show the bare terminal until the frame
// lands. Re-placing the image the terminal already has covers the pane at once:
// it is a few dozen bytes, so unlike a frame it never waits behind the encoder.
// The accurate frame replaces it as soon as it arrives.
function replacePlacement() {
  if (!imageTransferred) return;
  if (pendingImageDelete) deletePlacement();
  writeGfx(`a=p,i=${imageId},C=1,c=${paneCells.cols},r=${paneCells.rows}`
    + (imageZ === 0 ? "" : `,z=${imageZ}`) + ",q=2", "");
}

function transferFrame(png, generation) {
  if (pendingImageDelete) deletePlacement();
  // c=/r= make the terminal scale the image into the pane's cell box, so a frame
  // whose pixel size no longer matches still covers exactly the pane.
  const header = `a=T,f=100,i=${imageId},C=1,c=${paneCells.cols},r=${paneCells.rows}`
    + (imageZ === 0 ? "" : `,z=${imageZ}`);
  queueGfxFrame(png, header, generation);
  // Only the first few: enough to see when a page actually reached the pane, which
  // is what separates "the engine is behind" from "the site is slow", and quiet
  // after that.
  if (framesSentCount < 12) console.error(`tweb: frame sent #${++framesSentCount}`);
  lastFrameSentAt = Date.now();
}

function sendFrameNow(image, generation) {
  if (!terminalVisible || generation !== viewportGeneration || !image || image.isEmpty()) return;
  const viewport = lastViewport;
  const size = image.getSize();
  const expected = viewport && renderedFrameSize(viewport);
  if (!expected || size.width !== expected.width || size.height !== expected.height) return;
  try {
    // PNG 생성 후 base64 변환과 terminal write는 worker에 맡긴다. stdout
    // backpressure가 생겨도 Electron main thread와 keyboard input은 멈추지 않는다.
    const png = image.toPNG();
    imageTransferred = true;
    transferFrame(png, generation);
  } catch (error) {
    console.error(`tweb: frame encode failed: ${error.message}`);
  }
}

function flushPendingFrame() {
  pendingFrameTimer = null;
  const frame = pendingFrame;
  pendingFrame = null;
  if (!frame || frame.tab !== win || frame.generation !== viewportGeneration || !terminalVisible) return;
  sendFrameNow(frame.image, frame.generation);
}

function queueFrame(tab, image, immediate = false) {
  const generation = viewportGeneration;
  const viewport = lastViewport;
  const size = image?.getSize();
  const expected = viewport && renderedFrameSize(viewport);
  if (!expected || !size || size.width !== expected.width || size.height !== expected.height) {
    if (debugLogging) {
      console.error(`tweb: frame dropped got=${size?.width}x${size?.height}`
        + ` want=${expected?.width}x${expected?.height}`);
    }
    return;
  }
  tabFrames.set(tab, { image, generation });
  if (tab !== win || !terminalVisible) return;
  pendingFrame = { tab, image, generation };
  if (pendingFrameTimer) return;
  const elapsed = Date.now() - lastFrameSentAt;
  const delay = immediate ? 0 : Math.max(0, frameIntervalMs - elapsed);
  pendingFrameTimer = setTimeout(flushPendingFrame, delay);
}

function repaintActiveTab() {
  if (!terminalVisible || !win || win.isDestroyed()) return;
  const frame = tabFrames.get(win);
  if (frame && frame.generation === viewportGeneration && !frame.image.isEmpty()) {
    queueFrame(win, frame.image, true);
    if (debugLogging) console.error("tweb: visibility repaint");
    return;
  }
  win.webContents.invalidate();
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
  if (!process.env.TMUX_PANE) return null;
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(
      "tmux",
      [
        "display-message",
        "-p",
        "-t",
        process.env.TMUX_PANE,
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

// tmux의 pane cell 수와 Ghostty client cell pixel 크기를 최우선으로 사용한다.
function queryViewportSize() {
  return parseViewport(process.env.TWEB_VIEWPORT)
    || queryTmuxViewport()
    || lastViewport
    || { cols: 80, rows: 24, width: 640, height: 384 };
}

let paneCells = { cols: 80, rows: 24 };

// --- browser window ---

function normalizeUrl(input) {
  const value = (input || "").trim();
  if (!value) return "https://example.com";
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(value)) {
    return `http://${value}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(about|data|file):/i.test(value)) {
    return value;
  }
  return `https://${value}`;
}

function errorPage(url, code, description) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    :root{color-scheme:light dark}body{font:16px system-ui;margin:3rem;line-height:1.5}
    code{overflow-wrap:anywhere}small{opacity:.7}
  </style><h1>페이지를 열 수 없음</h1><p><code>${escapeHtml(url)}</code></p>
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
  // tmux/Ghostty viewport는 device pixel이고 BrowserWindow 크기는 DIP이다.
  // CSS 크기는 scale로 나누되 offscreen output은 같은 scale로 렌더링해
  // 최종 bitmap이 pane의 실제 pixel 크기에 최대한 가깝게 한다.
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

function browserWindowOptions(vp = lastViewport || queryViewportSize()) {
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
  const title = tab.webContents.getTitle() || tab.webContents.getURL() || "새 탭";
  return `${index + 1}/${tabs.length} ${title}`;
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
  if (!windowSessionPath || tabs.length === 0) return;
  const state = windowSessionForSave(tabs.flatMap((tab) => {
    if (tab.isDestroyed()) return [];
    return [{
      url: tabSessionUrls.get(tab) || tab.webContents.getURL(),
      zoom: tabZoomFactors.get(tab) ?? defaultZoomFactor,
    }];
  }), activeTabIndex, defaultZoomFactor);
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

function notify(message) {
  if (process.env.TMUX && process.env.TMUX_PANE) {
    execFile("tmux", ["display-message", "-t", process.env.TMUX_PANE, message], () => {});
  }
  if (debugLogging) console.error(`tweb: ${message}`);
}

function updatePaneTitle() {
  if (!win || !process.env.TMUX_PANE) return;
  execFile(
    "tmux",
    ["select-pane", "-t", process.env.TMUX_PANE, "-T", `tweb ${tabLabel(win, activeTabIndex)}`],
    () => {}
  );
}

function restorePaneTitle() {
  if (!process.env.TMUX_PANE || originalPaneTitle === null) return;
  try {
    execFileSync(
      "tmux",
      ["select-pane", "-t", process.env.TMUX_PANE, "-T", originalPaneTitle],
      { timeout: 1000, stdio: "ignore" }
    );
  } catch (e) {}
}

function updatePaintingState() {
  for (const tab of tabs) {
    if (tab.isDestroyed()) continue;
    const active = tab === win && terminalVisible;
    tab.webContents.setBackgroundThrottling(!active);
    tab.webContents.setFrameRate(active ? activeFrameRate : 1);
    if (active) tab.webContents.startPainting();
    else tab.webContents.stopPainting();
  }
}

function installPageEnhancements(tab = win) {
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
    for (const key of readyKeys) {
      if (!liveKeys.has(key)) readyKeys.delete(key);
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

function broadcastShortcutMode() {
  for (const tab of tabs) {
    sendToTabFrames(tab, "tweb-shortcuts-enabled", browserShortcutsEnabled);
  }
}

function toggleBrowserShortcuts() {
  browserShortcutsEnabled = !browserShortcutsEnabled;
  // The preload drops insert mode on this signal; keep the mirror in step.
  pageInsertMode = false;
  broadcastShortcutMode();
  if (!browserShortcutsEnabled && win && !win.isDestroyed()) win.webContents.focus();
  reconcileTmuxPassthrough();
  updatePaneTitle();
  if (debugLogging) {
    console.error(`tweb: input mode ${browserShortcutsEnabled ? "shortcuts" : "passthrough"}`);
  }
  notify(browserShortcutsEnabled ? "browser shortcuts ON" : "web passthrough ON");
}

function activateTab(index) {
  if (tabs.length === 0) {
    win = null;
    activeTabIndex = -1;
    return;
  }
  const normalized = ((index % tabs.length) + tabs.length) % tabs.length;
  activeTabIndex = normalized;
  win = tabs[normalized];
  mouseClicks.reset();
  pageInsertMode = false;
  // The other tab's caret says nothing about this one, and its preload only
  // reports on focus — which switching tabs does not fire.
  moveTerminalCaret(null);
  // Zoom is shared per origin in Chromium, so a sibling tab on the same host can
  // have moved it. Only the active tab is ever painted, so restoring this tab's
  // own factor on activation is what makes zoom look per-tab.
  const zoomFactor = tabZoomFactors.get(win) ?? defaultZoomFactor;
  if (!win.isDestroyed() && win.webContents.getZoomFactor() !== zoomFactor) {
    win.webContents.setZoomFactor(zoomFactor);
  }
  // Cell size in CSS pixels depends on the zoom just restored.
  broadcastCellMetrics();
  // Do not delete the current image first: the next frame reuses the same image
  // id and replaces it in place. Deleting would uncover the bare terminal until
  // the new tab paints, which reads as a flicker on every switch.
  updatePaintingState();
  win.webContents.invalidate();
  updatePaneTitle();
  scheduleWindowSessionSave();
  if (debugLogging) console.error(`tweb: tab active ${tabLabel(win, normalized)}`);
}

function cycleTab(direction) {
  if (tabs.length > 1) activateTab(activeTabIndex + direction);
}

function closeTab(index = activeTabIndex) {
  const tab = tabs[index];
  if (!tab || tab.isDestroyed()) return;
  const url = tab.webContents.getURL();
  if (isRestorableUrl(url)) {
    closedTabs.push(url);
    if (closedTabs.length > 25) closedTabs.shift();
  }
  if (tabs.length === 1) {
    app.quit();
    return;
  }
  tab.close();
}

function restoreClosedTab() {
  const url = closedTabs.pop();
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

function historyPath() {
  return path.join(app.getPath("userData"), "history.jsonl");
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
    appendFileSync(historyPath(), line, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    if (debugLogging) console.error(`tweb: history append failed: ${error.message}`);
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

// Rewrite atomically so a pane reading mid-compaction still sees a whole file.
function compactHistory(keep = 600) {
  try {
    const lines = readFileSync(historyPath(), "utf8").split("\n").filter((line) => line.trim());
    if (lines.length <= keep * 3) return;
    const temporary = `${historyPath()}.${process.pid}.tmp`;
    writeFileSync(temporary, `${lines.slice(-keep).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, historyPath());
  } catch (error) {
    if (error.code !== "ENOENT" && debugLogging) {
      console.error(`tweb: history compaction failed: ${error.message}`);
    }
  }
}

function omniboxModel() {
  const history = readGlobalHistory();
  // Open tabs always outrank history entries.
  const base = history.length;
  const tabEntries = tabs.flatMap((candidate, index) => {
    if (candidate.isDestroyed()) return [];
    const url = tabSessionUrls.get(candidate) || candidate.webContents.getURL() || "about:blank";
    return [{
      kind: "tab",
      index,
      url,
      title: candidate.webContents.getTitle() || url,
      recency: base + tabs.length - index,
    }];
  });
  return {
    current: win && !win.isDestroyed() ? tabSessionUrls.get(win) || win.webContents.getURL() || "" : "",
    entries: [
      ...tabEntries,
      ...history.map((entry, index) => ({ ...entry, kind: "history", recency: base - index })),
    ],
  };
}

function tabListModel() {
  return {
    activeIndex: activeTabIndex,
    tabs: tabs.map((candidate, index) => ({
      index,
      title: candidate.webContents.getTitle() || "새 탭",
      url: candidate.webContents.getURL() || "about:blank",
    })),
  };
}

function handleNativeShortcut(tab, action, value, sourceFrame = null) {
  if (!browserShortcutsEnabled || tab !== win || tab.isDestroyed()) return;
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
    case "activate-tab":
      if (Number.isInteger(value) && value >= 0 && value < tabs.length) activateTab(value);
      break;
    // The tab list closes a specific row; the bare shortcut closes the active tab.
    case "close-tab":
      // Closing from the list keeps it open, so it has to be redrawn — but only
      // then: sending the model unprompted would pop the list open.
      refreshTabListAfterClose = Number.isInteger(value);
      closeTab(Number.isInteger(value) ? value : activeTabIndex);
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
  event.reply("tweb-shortcuts-enabled", browserShortcutsEnabled);
  if (tab === win) event.reply("tweb-cell-metrics", cellMetrics());
});

ipcMain.on("tweb-shortcut", (event, message) => {
  if (!message || typeof message.action !== "string") return;
  const tab = tabs.find((candidate) => !candidate.isDestroyed() && candidate.webContents.id === event.sender.id);
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
  const tab = win;
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
  const tab = win && !win.isDestroyed() ? win : null;
  const size = tab ? tab.getContentSize() : null;
  const frame = tab ? tabFrames.get(tab)?.image?.getSize() : null;
  return {
    pane: process.env.TMUX_PANE || null,
    pid: process.pid,
    engineApp: __dirname,
    pane_geometry: {
      cells: paneCells,
      pixels: lastViewport ? { width: lastViewport.width, height: lastViewport.height } : null,
      origin: tmuxOrigin,
      logical: lastViewport ? logicalContentSize(lastViewport) : null,
      scaleFactor: renderScaleFactor(),
    },
    window: {
      contentSize: size ? { width: size[0], height: size[1] } : null,
      zoomFactor: tab ? tab.webContents.getZoomFactor() : null,
      defaultZoomFactor,
      visible: tab ? tab.isVisible() : null,
    },
    frames: {
      generation: viewportGeneration,
      lastSentMsAgo: lastFrameSentAt ? Date.now() - lastFrameSentAt : null,
      lastSize: frame ? { width: frame.width, height: frame.height } : null,
      // A frame whose size does not match the pane is dropped, which is what a
      // pane that stopped following a resize looks like.
      expected: lastViewport ? renderedFrameSize(lastViewport) : null,
      rate: activeFrameRate,
      adaptive: adaptiveFrameRate,
      droppedByBackpressure: droppedGfxFrames,
      imageId,
    },
    input: {
      shortcutsEnabled: browserShortcutsEnabled,
      pageInsertMode,
      terminalVisible,
      shortcutFrames: tab ? shortcutFrameKeys(tab).size : 0,
      // Where IME preedit will land. Comparing cell against point is the only way
      // to tell "caret parked on the wrong line" from "page never reported one".
      caret: { cell: caretCell, point: lastCaretPoint },
    },
    tabs: { active: activeTabIndex, count: tabs.length },
  };
}

function agentContents() {
  if (!win || win.isDestroyed()) throw new Error("no active tab");
  return win.webContents;
}

function agentNativeClick(point) {
  const contents = agentContents();
  const { x, y } = pageToWindowPoint(contents, point);
  contents.sendInputEvent({ type: "mouseMove", x, y });
  contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
}

function agentPressKey(key, modifiers = []) {
  const contents = agentContents();
  contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
  if (key.length === 1 && modifiers.length === 0) {
    contents.sendInputEvent({ type: "char", keyCode: key });
  }
  contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
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
    active: activeTabIndex,
    tabs: tabs.map((tab, index) => ({
      index,
      title: tab.isDestroyed() ? "" : tab.webContents.getTitle(),
      url: tab.isDestroyed() ? "" : tab.webContents.getURL(),
      active: index === activeTabIndex,
    })),
  };
}

async function agentScreenshot(params) {
  const contents = agentContents();
  const image = await contents.capturePage();
  if (!params.path) return { png: image.toPNG().toString("base64") };
  const target = path.resolve(params.path);
  writeFileSync(target, image.toPNG());
  return { path: target, size: image.getSize() };
}

async function handleAgentCommand(method, params) {
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
    case "tabs":
      return agentTabList();
    case "tab":
      activateTab(Number(params.index));
      return agentTabList();
    case "tab-new":
      createTab(normalizeUrl(String(params.url || "about:blank")), true);
      return agentTabList();
    case "tab-close":
      closeTab(params.index === undefined ? activeTabIndex : Number(params.index));
      return agentTabList();
    case "console":
      return { messages: params.clear ? consoleLog.splice(0) : consoleLog.slice(-(params.limit || 100)) };
    case "errors":
      return { errors: consoleLog.filter((entry) => entry.level === "error").slice(-(params.limit || 50)) };
    case "status":
      return {
        pid: process.pid,
        pane: process.env.TMUX_PANE || null,
        tabs: agentTabList(),
      };
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

function unparkTerminalCaret() {
  caretCell = null;
  lastCaretPoint = null;
  try { writeSync(1, `${CSI("?25l")}${CARET_SHAPE_RESET}`); } catch (error) { void error; }
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
  if (!lastViewport || !win || win.isDestroyed()) return null;
  const logical = logicalContentSize(lastViewport);
  const zoom = win.webContents.getZoomFactor() || 1;
  return {
    width: logical.width / Math.max(1, paneCells.cols) / zoom,
    height: logical.height / Math.max(1, paneCells.rows) / zoom,
    columns: imeSlotCells,
  };
}

function broadcastCellMetrics(tab = win) {
  if (!tab || tab.isDestroyed() || tab !== win) return;
  sendToTabFrames(tab, "tweb-cell-metrics", cellMetrics());
}

// The page reports the caret in CSS pixels and dedupes on them, so a zoom step or
// a pane resize moves the cell under a caret that never "moved" — and the report
// that would correct it never comes. Recompute from the last one instead.
function reparkTerminalCaret() {
  if (lastCaretPoint) moveTerminalCaret(lastCaretPoint);
}

function moveTerminalCaret(point) {
  const vp = lastViewport;
  if (!point || !vp || !win || win.isDestroyed()) {
    if (caretCell) unparkTerminalCaret();
    return;
  }
  const logical = logicalContentSize(vp);
  const zoom = win.webContents.getZoomFactor() || 1;
  const cellWidth = logical.width / Math.max(1, paneCells.cols);
  const cellHeight = logical.height / Math.max(1, paneCells.rows);
  // Nearest cell edge, not the containing cell: a bar on the left edge is off by
  // at most half a cell that way instead of a whole one.
  const col = Math.min(paneCells.cols, Math.max(1, Math.round(point.x * zoom / cellWidth) + 1));
  const baseline = (point.y + (point.height || 0) * CARET_BASELINE) * zoom;
  const row = Math.min(paneCells.rows,
    Math.max(1, Math.round(baseline / cellHeight - CARET_BASELINE) + 1));
  lastCaretPoint = { x: point.x, y: point.y, height: point.height || 0 };
  if (caretCell && caretCell.row === row && caretCell.col === col) return;
  caretCell = { row, col };
  try {
    writeSync(1, `${CSI(`${row};${col}H`)}${CARET_BAR}${CSI("?25h")}`);
  } catch (error) {
    void error;
  }
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
  if (!state || tab !== win || tab.isDestroyed()) return;
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
  if (tab !== win || tab.isDestroyed()) return;
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

function keepWindowHidden(tab) {
  if (!tab || tab.isDestroyed()) return;
  const bounds = tab.getBounds();
  if (bounds.x !== -10_000 || bounds.y !== -10_000) {
    tab.setBounds({ ...bounds, x: -10_000, y: -10_000 });
  }
  if (tab.getOpacity() !== 0) tab.setOpacity(0);
  if (tab.isFocusable()) tab.setFocusable(false);
  tab.setSkipTaskbar(true);
  tab.setIgnoreMouseEvents(true);
  if (tab.isFocused()) tab.blur();
  if (tab.isVisible()) tab.hide();
}

function enforceHiddenWindows() {
  for (const window of BrowserWindow.getAllWindows()) keepWindowHidden(window);
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
  contents.on("paint", (_event, _dirty, image) => {
    const size = image.getSize();
    const expected = lastViewport && renderedFrameSize(lastViewport);
    if (loggedFrameGeneration !== viewportGeneration && !image.isEmpty()
      && size.width === expected?.width && size.height === expected?.height) {
      loggedFrameGeneration = viewportGeneration;
      if (debugLogging) {
        const vp = lastViewport || queryViewportSize();
        console.error(
          `tweb: frame generation=${viewportGeneration} ${size.width}x${size.height}, `
          + `pane ${vp.width}x${vp.height}, scale ${renderScaleFactor().toFixed(2)}`
        );
      }
    }
    queueFrame(tab, image);
  });

  // Electron이 custom offscreen child를 연결하기 전에 macOS OffScreenView
  // placeholder를 native popup으로 노출할 수 있다. 원 요청은 거부하고 URL을
  // 별도 TWeb tab으로 직접 열어 native popup 생성 자체를 막는다.
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
    if (browserShortcutsEnabled) showBrowserContextMenu(tab, params);
  });
  contents.on("media-started-playing", () => {
    if (debugLogging) {
      setTimeout(() => {
        if (!contents.isDestroyed()) {
          console.error(`tweb: media playing audible=${contents.isCurrentlyAudible()} muted=${contents.audioMuted}`);
        }
      }, 250);
    }
  });
  contents.on("media-paused", () => {
    if (debugLogging) console.error("tweb: media paused");
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
    if (tab === win) {
      broadcastCellMetrics(tab);
      reparkTerminalCaret();
    }
    if (!initialZoomApplied) {
      initialZoomApplied = true;
      if (debugLogging) console.error(`tweb: default zoom ${zoomFactor.toFixed(3)}`);
    }
    installPageEnhancements(tab);
    sendToTabFrames(tab, "tweb-shortcuts-enabled", browserShortcutsEnabled);
    if (debugLogging) {
      console.error(`tweb: loaded ${contents.getURL()} (${contents.getTitle()})`);
    }
  });
  tab.on("page-title-updated", (_event, title) => {
    const url = tabSessionUrls.get(tab) || contents.getURL();
    recordNavigationHistory(url, title);
    if (tab === win) updatePaneTitle();
    if (debugLogging) console.error(`tweb: title ${title}`);
  });
  contents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || showingLoadError) return;
    showingLoadError = true;
    console.error(`tweb: failed to load ${failedUrl}: ${description} (${code})`);
    void contents.loadURL(errorPage(failedUrl || contents.getURL(), code, description));
  });
}

function adoptTab(tab, url, activate = true, initialZoomFactor = defaultZoomFactor) {
  if (tabs.includes(tab)) return tab;
  configureTab(tab, initialZoomFactor);
  tabSessionUrls.set(tab, url || "about:blank");
  tabs.push(tab);
  const index = tabs.length - 1;

  tab.on("closed", () => {
    const closedIndex = tabs.indexOf(tab);
    if (closedIndex < 0) return;
    const wasActive = tab === win;
    tabFrames.delete(tab);
    tabZoomFactors.delete(tab);
    tabSessionUrls.delete(tab);
    tabs.splice(closedIndex, 1);
    if (tabs.length === 0) {
      win = null;
      activeTabIndex = -1;
      if (!quitting) app.quit();
      return;
    }
    if (wasActive) activateTab(Math.min(closedIndex, tabs.length - 1));
    else if (closedIndex < activeTabIndex) activeTabIndex -= 1;
    if (refreshTabListAfterClose) {
      refreshTabListAfterClose = false;
      sendToTabFrames(win, "tweb-tabs", tabListModel());
    }
    scheduleWindowSessionSave();
  });

  if (activate) activateTab(index);
  else scheduleWindowSessionSave();
  if (debugLogging) console.error(`tweb: tab opened ${index + 1} ${url}`);
  return tab;
}

function createTab(
  url = "about:blank",
  activate = true,
  initialZoomFactor = defaultZoomFactor,
  showInitialPlaceholder = tabs.length === 0
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
  if (showInitialPlaceholder && isRestorableUrl(url) && !process.env.TWEB_NO_PLACEHOLDER) {
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
${escaped} 여는 중…</body>`)}`;
}

function noWindowSessionPage() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8"><title>TWeb</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#161616;color:#9aa0a6;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;
flex-direction:column;gap:8px">
<div>복원할 이전 페이지가 없습니다</div><div style="color:#6f747c">t 키로 주소를 입력하세요</div></body>`)}`;
}

function applyViewport(vp, origin = tmuxOrigin) {
  if (!vp) return;
  const previous = lastViewport;
  const viewportChanged = !lastViewport ||
    lastViewport.cols !== vp.cols || lastViewport.rows !== vp.rows ||
    lastViewport.width !== vp.width || lastViewport.height !== vp.height;
  const originChanged = origin?.left !== tmuxOrigin?.left || origin?.top !== tmuxOrigin?.top;
  if (!viewportChanged && !originChanged) return;

  viewportGeneration += 1;
  mouseClicks.reset();
  if (pendingFrameTimer) {
    clearTimeout(pendingFrameTimer);
    pendingFrameTimer = null;
  }
  pendingFrame = null;
  pendingGfxFrame = null;
  tabFrames.clear();
  // A moved pane leaves a placement at the old anchor, and a shrunk one leaves
  // the rows it gave up still covered — usually hiding the pane that just
  // appeared there. Neither is fixed by replacement, so both need a delete;
  // growing is, so it gets none. The delete rides along with the next transfer.
  const shrank = previous && (vp.cols < previous.cols || vp.rows < previous.rows);
  if (originChanged || shrank) pendingImageDelete = true;
  tmuxOrigin = origin;
  paneCells = { cols: vp.cols, rows: vp.rows };
  lastViewport = vp;
  const logical = logicalContentSize(vp);
  if (debugLogging) {
    const anchor = tmuxOrigin ? `${tmuxOrigin.left},${tmuxOrigin.top}` : "none";
    console.error(
      `tweb: resize generation=${viewportGeneration} cells=${vp.cols}x${vp.rows} `
      + `pixels=${vp.width}x${vp.height} logical=${logical.width}x${logical.height} origin=${anchor}`
    );
  }
  if (viewportChanged) {
    for (const tab of tabs) {
      if (tab.isDestroyed()) continue;
      tab.setContentSize(logical.width, logical.height);
      // Resizing the window resets the zoom factor, so a pane resize silently
      // undid whatever the user had zoomed to. Put it back.
      const zoomFactor = tabZoomFactors.get(tab) ?? defaultZoomFactor;
      if (tab.webContents.getZoomFactor() !== zoomFactor) {
        tab.webContents.setZoomFactor(zoomFactor);
      }
    }
  }
  win?.webContents.invalidate();
  if (terminalVisible) replacePlacement();
  broadcastCellMetrics();
  reparkTerminalCaret();
}

function createWindow(url) {
  const vp = queryViewportSize();
  paneCells = { cols: vp.cols, rows: vp.rows };
  lastViewport = vp;

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
  return win;
}

// --- browser input ---

let rawInput = Buffer.alloc(0);
let rawInputFlushTimer = null;
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
  const vp = lastViewport || queryViewportSize();
  const logical = logicalContentSize(vp);
  if (process.env.TMUX) {
    // tmux는 1016을 받아도 pane-relative cell 좌표를 전달한다.
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
  if (!win) return;
  const contents = win.webContents;
  // Chromium keeps zoom per origin, so getZoomFactor() reports whatever another
  // tab on the same host last set. Step from this tab's own remembered value.
  const current = tabZoomFactors.get(win) ?? contents.getZoomFactor();
  const next = action === "reset"
    ? defaultZoomFactor
    : Math.min(2, Math.max(0.5, current * (action === "in" ? 1.2 : 1 / 1.2)));
  tabZoomFactors.set(win, next);
  contents.setZoomFactor(next);
  contents.invalidate();
  broadcastCellMetrics();
  reparkTerminalCaret();
  scheduleWindowSessionSave();
  if (debugLogging) console.error(`tweb: zoom ${next.toFixed(3)}`);
}

function hasZoomModifier(modifiers) {
  // Cmd +/-는 Ghostty의 font zoom이 먼저 소비하므로 browser shortcut으로 쓰지 않는다.
  return modifiers.includes("control") && !modifiers.includes("meta");
}

function dispatchMouse(cb, rawX, rawY, release) {
  if (!win) return;
  const contents = win.webContents;
  const { x, y } = logicalMousePoint(rawX, rawY);
  const modifiers = mouseModifiers(cb);
  const buttonCode = cb & 3;
  const motion = (cb & 32) !== 0;
  const wheel = (cb & 64) !== 0;

  if (wheel) {
    const direction = buttonCode === 0 ? 1 : buttonCode === 1 ? -1 : 0;
    if (browserShortcutsEnabled && direction !== 0 && hasZoomModifier(modifiers)) {
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
  // 일부 offscreen Chromium 경로는 right mouseUp만으로 contextmenu를 만들지 않는다.
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

function dispatchNativeKey(contents, key, text, modifiers, eventKind) {
  const event = {
    keyCode: key,
    modifiers,
  };
  if (eventKind === 3) {
    contents.sendInputEvent({ ...event, type: "keyUp" });
    return;
  }
  contents.sendInputEvent({ ...event, type: "rawKeyDown" });
  if (text && !modifiers.includes("control") && !modifiers.includes("meta")) {
    contents.sendInputEvent({ type: "char", keyCode: text, modifiers });
  }
  if (eventKind === 1) contents.sendInputEvent({ ...event, type: "keyUp" });
}

function dispatchNamedKey(key, modifierMask = 1, eventKind = 1, textCodepoints = []) {
  if (!win || !key) return;
  const modifiers = electronModifiers(modifierMask);
  const pressed = eventKind !== 3;
  const control = modifiers.includes("control");
  const shift = modifiers.includes("shift");

  // tmux가 modifier를 제거하지 않는 환경에서는 표준 CSI-u도 지원한다.
  // release도 소비해 웹페이지에 orphan keyUp이 전달되지 않게 한다.
  if (control && key === ";") {
    if (pressed) toggleBrowserShortcuts();
    return;
  }

  if (modifiers.includes("meta") && key.toLowerCase() === "a") {
    if (pressed) sendToTabFrames(win, "tweb-select-all");
    return;
  }

  // Cmd-C/V/X reach us as CSI-u like Cmd-A does, but nothing acted on them, so
  // copy and paste simply did nothing inside the page. Drive the editing
  // commands directly: the renderer knows the selection and the focused field.
  if (modifiers.includes("meta") && ["c", "v", "x"].includes(key.toLowerCase())) {
    if (pressed) {
      const contents = win.webContents;
      if (key.toLowerCase() === "c") contents.copy();
      else if (key.toLowerCase() === "v") contents.paste();
      else contents.cut();
    }
    return;
  }

  // Browser shortcut mode에서만 Ctrl-C를 pane 종료로 사용한다. Web passthrough
  // mode에서는 페이지의 KeyboardEvent로 그대로 전달한다.
  if (browserShortcutsEnabled && key.toLowerCase() === "c" && control) {
    if (pressed) app.quit();
    return;
  }

  if (browserShortcutsEnabled) {
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
  if (!browserShortcutsEnabled || pageInsertMode) {
    dispatchNativeKey(win.webContents, key, text, modifiers, eventKind);
    return;
  }
  sendToFocusedTabFrame(win, "tweb-terminal-key", {
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

function dispatchPrivateShortcut(code) {
  if (debugLogging) console.error(`tweb: private key ${code}`);
  if (code === 5001) {
    toggleBrowserShortcuts();
    return;
  }
  if (browserShortcutsEnabled) {
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
      // ESC-prefix sequence가 추가 byte 없이 끝나면 실제 Escape key다. 짧은
      // disambiguation 시간 후 첫 ESC를 전달하고 나머지는 다시 파싱한다.
      dispatchKey(27);
      rawInput = rawInput.subarray(1);
      consumeRawInput();
    }
  }, 35);
}

function consumeRawInput() {
  for (;;) {
    if (rawInput.length === 0) return;
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

    // Focus reporting은 사용하지 않는다. 이전 실행이나 tmux/terminal 상태에서
    // 남아 들어온 ESC[I/ESC[O도 browser text 또는 shell 문자열로 보내지 않는다.
    const focus = /^\x1b\[[IO]/.exec(input);
    if (focus) {
      rawInput = rawInput.subarray(Buffer.byteLength(focus[0]));
      continue;
    }

    let match = /^\x1b\[(500[1-9])~/.exec(input);
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

    // escape sequence가 아직 덜 들어왔다면 다음 INPUT chunk를 기다린다.
    // 단독 ESC는 짧은 판별 시간이 지나면 Escape key로 확정한다.
    if (/^\x1b(?:\[|\[<|O)?[0-9;:<]*$/.test(input)) {
      scheduleRawInputFlush();
      return;
    }

    // 알 수 없는 ESC는 Escape key로 전달하고 한 byte만 소비한다.
    dispatchKey(27);
    rawInput = rawInput.subarray(1);
  }
}

// --- resize/input control channel ---
// tweb-pane이 SIGWINCH와 raw terminal input을 이 pipe로 전달한다.
let controlBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  controlBuffer += chunk;
  for (;;) {
    const newline = controlBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = controlBuffer.slice(0, newline).trim();
    controlBuffer = controlBuffer.slice(newline + 1);

    const resize = /^RESIZE\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+)\s+(\d+))?$/.exec(line);
    if (resize) {
      markInteractionActivity();
      const origin = resize[5] !== undefined && resize[6] !== undefined
        ? { left: Number(resize[5]), top: Number(resize[6]) }
        : tmuxOrigin;
      applyViewport({
        cols: Number(resize[1]),
        rows: Number(resize[2]),
        width: Number(resize[3]),
        height: Number(resize[4]),
      }, origin);
      continue;
    }

    const input = /^INPUT\s+([0-9a-f]*)$/i.exec(line);
    if (input && input[1].length % 2 === 0) {
      markInteractionActivity();
      if (rawInputFlushTimer) {
        clearTimeout(rawInputFlushTimer);
        rawInputFlushTimer = null;
      }
      rawInput = Buffer.concat([rawInput, Buffer.from(input[1], "hex")]);
      consumeRawInput();
    }
  }
});
process.stdin.resume();

// --- app lifecycle ---

app.on("browser-window-created", (_event, window) => keepWindowHidden(window));

app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.hide();
  configureDownloads();
  hiddenWindowWatchdog = setInterval(enforceHiddenWindows, 50);
  hiddenWindowWatchdog.unref();
  enforceHiddenWindows();
  getTmuxPaneOrigin();

  // Electron app path 다음의 첫 인자를 URL로 사용한다. scheme 없는 host도 허용한다.
  const rawUrl = process.env.TWEB_URL
    || commandLineUrl()
    || "https://example.com";
  const currentUrl = normalizeUrl(rawUrl);

  terminalSetup();
  if (restoreWindowSession) {
    initializeTmuxVisibility();
    createWindow(currentUrl);
  } else {
    createWindow(currentUrl);
    setImmediate(initializeTmuxVisibility);
  }
  markInteractionActivity();
  compactHistory();
  agentServer = startAgentServer({
    dispatch: handleAgentCommand,
    log: (message) => {
      if (debugLogging) console.error(`tweb: ${message}`);
    },
  });
  // Chromium startup may reset the terminal modified-key mode after the Rust
  // frontend enabled it. Re-declare it from the PTY-owning parent once startup
  // has settled.
  scheduleTrackedKeyboardModeRestore();
  notify(
    `browser shortcuts ON — toggle: Ctrl-; · frame: ${adaptiveFrameRate ? `adaptive 4-${maxActiveFrameRate}` : `${maxActiveFrameRate}`}fps`
    + ` · zoom: Ctrl +/-/0 · default: ${Math.round(defaultZoomFactor * 100)}%`
  );
});

function cleanupFrameFiles() {
  for (const filePath of [frameFilePath, `${frameFilePath}.tmp`]) {
    try { unlinkSync(filePath); } catch (error) {
      if (error.code !== "ENOENT" && debugLogging) {
        console.error(`tweb: frame file cleanup failed ${filePath}: ${error.message}`);
      }
    }
  }
}

app.on("window-all-closed", () => {
  if (!quitting) app.quit();
});

app.on("before-quit", () => {
  if (agentServer) {
    agentServer.close();
    agentServer = null;
  }
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
  if (pendingFrameTimer) {
    clearTimeout(pendingFrameTimer);
    pendingFrameTimer = null;
    pendingFrame = null;
  }
  pendingGfxFrame = null;
  void gfxWorker.terminate();
  cleanupFrameFiles();
  if (debugLogging && droppedGfxFrames > 0) {
    console.error(`tweb: dropped ${droppedGfxFrames} superseded graphics frames`);
  }
  for (const tab of tabs) {
    if (!tab.isDestroyed()) tab.webContents.stopPainting();
  }
  restoreTmuxPassthroughClients();
  terminalCleanup();
  for (const tty of visibleClientTtys) deleteImageFromClientTty(tty);
  restorePaneTitle();
});

// process exit에서도 image delete (안전망).
process.on("exit", () => {
  cleanupFrameFiles();
  try {
    writeGfx(`a=d,d=I,i=${imageId}`, "");
  } catch (e) {}
});
