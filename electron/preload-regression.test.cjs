"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const electron = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
const tauri = fs.readFileSync(path.join(root, "crates/tweb-engine/tauri/src/preload.js.inc"), "utf8");

function assertPreload(source) {
  assert.match(source, /"ㄹ": "f", "ᄅ": "f", "ㅎ": "g", "ᄒ": "g"/);
  assert.match(source, /function commandKey\(value, shiftKey = false\)/);
  assert.match(source, /return commandKey\(keys\[event\.code\] \|\| event\.key, event\.shiftKey\)/);
  assert.match(source, /commandKey\(payload\.key, Boolean\(payload\.shiftKey\)\)/);
  assert.match(source, /else send\("native-click", hintClickPoint\(item\)\)/);
  assert.match(source, /const rect = visibleRect\(item\.element\) \|\| item\.rect/);
  assert.doesNotMatch(source, /item\.element\.click\(\)/);

  // Sweeping every probe point across every shadow root cost over a second on a
  // page with a handful of web components. A root only needs the points its
  // host covers — and it does need its own probe, since elementsFromPoint
  // retargets at the boundary and would otherwise miss delegated surfaces.
  const hitTest = source.slice(source.indexOf("function hitTestTargets(semantic)"),
    source.indexOf("const mediaControlPresentation"));
  assert.match(hitTest, /const bounds = isElement\(host\) \? visibleRect\(host\) : null;/);
  assert.match(hitTest, /if \(bounds && \(ourX < bounds\.left \|\| ourX > bounds\.right/);
  assert.match(hitTest, /root\.elementsFromPoint\(x, y\)/);

  // Hints must land on the controls a site actually draws, so the pointer is
  // parked over the video first and no lookalike overlay is painted.
  assert.match(source, /function mediaHoverPoints\(\)/);
  assert.doesNotMatch(source, /renderMediaControlOverlays/);
  // Players fade their controls once the pointer stops, so the loop has to keep
  // nudging — and it must start after startPicker's cancelTransient, which is
  // what stops any previous loop.
  assert.match(source, /mediaHoverTimer = setInterval\(\(\) => nudgeMediaPointer\(points\), 700\)/);
  assert.match(source, /pickerState = null;\s*\n\s*stopMediaHover\(\);/);
  // The function body ends at the first closing brace back at two-space indent.
  const hintsAt = source.indexOf("function startHints(newTab)");
  const startHints = source.slice(hintsAt, source.indexOf("\n  }\n", hintsAt));
  assert.ok(
    startHints.indexOf("startMediaHoverLoop(points)") > startHints.indexOf("startPicker("),
    "the hover loop must start after startPicker, or cancelTransient kills it"
  );
  // Deferring the first draw makes `f` feel dead and invites a second press.
  assert.ok(
    startHints.indexOf("collect();") < startHints.indexOf("setTimeout("),
    "hints must be drawn before waiting on the control bar"
  );
  // Synthetic control targets are for UA shadow-DOM controls only.
  assert.match(source, /if \(!media\.controls \|\| rect\.width < 160/);

  // Insert mode pauses TWeb keys for a page's own shortcuts; Escape comes back
  // and also leaves fullscreen, which an offscreen window never does by itself.
  assert.match(source, /function enterInsertMode\(\)/);
  assert.match(source, /case "i": enterInsertMode\(\); break;/);
  assert.match(source, /if \(insertMode\) \{\s*\n\s*if \(key !== "Escape"\) return;/);
  assert.match(source, /if \(key === "Escape" && document\.fullscreenElement\)/);
  assert.match(source, /!editable && !insertMode/);

  // In shortcuts mode the page only ever sees synthetic keys, which sites that
  // gate on isTrusted ignore, so dismissing a panel needs a real Escape from the
  // engine — delivered while the field still has focus, blurring only after.
  assert.match(source, /handled = dismissPageOverlay\(\);/);
  assert.match(source, /function dismissPageOverlay\(\)/);
  assert.match(source, /send\("native-escape"\)/);
  assert.match(source, /if \(key === "Escape" && passThroughEscape\)/);
  assert.doesNotMatch(source, /outsideClickPoint/);
  const dismiss = source.slice(source.indexOf("function dismissPageOverlay()"),
    source.indexOf("function startHints(newTab)"));
  assert.doesNotMatch(dismiss, /blur\(\)[\s\S]*send\("native-escape"\)/,
    "blurring before the page sees Escape makes the key meaningless");
}

test("Electron preload maps Korean normal keys and uses trusted hint clicks", () => {
  assertPreload(electron);
});

test("Tauri preload maps Korean normal keys and uses trusted hint clicks", () => {
  assertPreload(tauri);
});

// `cursor` inherits, so a pointer-styled ad card makes every descendant compute
// as `pointer` and the parent check suppresses them — including the dismiss "x"
// the card puts in its own corner. Reproduced with two identical `x` elements
// differing only in whether the card above them was pointer-styled: only the one
// under a pointer parent lost its hint.
test("an element that declares its own pointer cursor keeps its hint", () => {
  const source = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const intent = source.slice(source.indexOf("function hasPointerIntent(element)"),
    source.indexOf("function clickableAncestor(element)"));
  assert.match(intent, /return ownsPointerIntent\(element\)/,
    "the parent-cursor suppression must consult the element's own declaration");

  const owns = source.slice(source.indexOf("function ownsPointerIntent(element)"),
    source.indexOf("function hasPointerIntent(element)"));
  assert.match(owns, /element\.style\?\.cursor === "pointer"/);
  assert.match(owns, /aria-label/);

  // Computed style reports the inherited value, so it cannot answer "did this
  // element declare a cursor itself" — only the sheets can.
  const matcher = source.slice(source.indexOf("function declaredCursorMatcher()"),
    source.indexOf("function forgetDeclaredCursors()"));
  assert.match(matcher, /adoptedStyleSheets/);
  assert.match(matcher, /if \(rule\.cssRules\) walk\(rule\.cssRules\)/,
    "cursor rules nested under @media would otherwise be invisible");
  assert.match(matcher, /:is\(\$\{selectors\.join\(","\)\}\)/,
    ":is() is forgiving, so one unparsable selector cannot poison the match");
  assert.match(matcher, /catch \(_\) \{\}/,
    "a cross-origin sheet must degrade to the old behaviour, not throw");

  // A page can load or adopt a sheet between passes.
  const targets = source.slice(source.indexOf("function interactiveTargets()"),
    source.indexOf("function resourceUrl(value, element)"));
  assert.match(targets, /forgetDeclaredCursors\(\)/);
});

// The reported ad's close button was a bare `<div class="Sticky__cancel">` —
// no cursor, no label, no attribute, its click added with `addEventListener`.
// Listener inspection would not have found it either: such a click is often
// delegated from `document`, so the element holds no listener at all. The name
// is the only signal it emits.
test("a dismiss button is found by its name when nothing else marks it", () => {
  const source = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const dismiss = source.slice(source.indexOf("function dismissNameTargets(roots)"),
    source.indexOf("function interactiveTargets()"));

  // `Sticky__cancel` and `closableContainer` both have to yield their word.
  assert.match(dismiss, /replace\(\/\(\[a-z0-9\]\)\(\[A-Z\]\)\/g, "\$1 \$2"\)/,
    "camelCase names must be split or closableContainer never matches");
  assert.match(dismiss, /split\(\/\[\^a-z0-9\]\+\//);
  assert.match(dismiss, /dismissNames\.has\(word\)/,
    "matching by substring would take `disclosure` for a close button");
  assert.doesNotMatch(dismiss, /\.includes\(name\)|indexOf\(name\)/);

  // A dismiss button is small; the bound keeps a page-covering close overlay out.
  assert.match(dismiss, /box\.width > 48 \|\| box\.height > 48/);
  assert.match(dismiss, /pointerEvents === "none"/);

  for (const name of ["close", "cancel", "dismiss", "closable"]) {
    assert.match(dismiss.slice(0, 0) + source, new RegExp(`"${name}"`),
      `dismissNames is missing ${name}`);
  }

  const targets = source.slice(source.indexOf("function interactiveTargets()"),
    source.indexOf("function resourceUrl(value, element)"));
  assert.match(targets, /dismissNameTargets\(roots\)/,
    "the source has to be collected, not just defined");
});

// A put with no `p=` is an anonymous placement, and the protocol adds one each time
// rather than replacing the last. A resize re-places the base image, so each one stacked
// another copy at a different cell box and the taller ones kept showing below the pane.
test("every placement carries a fixed placement id", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

  // `a=d` deletes and `a=q` queries make no placement; `a=T` and `a=p` do, and an
  // anonymous one coexists with `p=1` rather than replacing it — so all of them need it.
  const placements = main.match(/`a=[Tp][^`]*`/g) || [];
  assert.ok(placements.length >= 3, `expected placement headers, found ${placements.length}`);
  for (const header of placements) {
    assert.match(header, /p=\$\{PLACEMENT_ID\}/,
      `placement header without a placement id accumulates: ${header}`);
  }

  assert.match(main, /const PLACEMENT_ID = 1;/);
});

// PageUp/PageDown moved by 90px, which is the line step `j`/`k` use — so the two keys did
// the same thing as the ones beside them.
test("page keys scroll by the surface, not by a line", () => {
  const source = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const pageKeys = source.slice(source.indexOf('if (key === "PageUp" || key === "PageDown") {'),
    source.indexOf("function hideTabPopover()"));
  assert.match(pageKeys, /scrollSurfaceHeight\(\)/,
    "a fixed pixel step is a line step, whatever the number");
  assert.doesNotMatch(pageKeys, /scrollSurfaceBy\(0, key === "PageUp" \? -?\d+ : \d+\)/);

  // Measured against the same surface `d`/`u` use, so an inner pane pages by its own height.
  const halfPage = source.slice(source.indexOf('case "d": '), source.indexOf('case "G": '));
  assert.match(halfPage, /scrollSurfaceHeight\(\)/);
});

// `visibleRect(panSurface())?.height` reads as guarded, but `?.` protects the result and
// not the argument: with no pan surface picked, `getComputedStyle(null)` threw and took
// the whole key handler with it, so the key did nothing at all and said nothing about it.
test("visibleRect survives a null element", () => {
  for (const source of [electron, tauri]) {
    const start = source.indexOf("function visibleRect(element)");
    const rect = source.slice(start, start + 600);
    assert.match(rect, /if \(!isElement\(element\)\) return null;/,
      "an optional chain on the result does not guard the argument");
    // Compare the code, not the comment above it, which names getComputedStyle too.
    const code = rect.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    const guardAt = code.indexOf("isElement(element)");
    const styleAt = code.indexOf("getComputedStyle");
    assert.ok(guardAt >= 0 && guardAt < styleAt, "the guard must precede getComputedStyle");
  }
});

// Picking an inner surface with `s` was defeated by the very keys a reader reaches for:
// Home/End/arrows called the window directly, so the page behind the panel moved instead.
test("Home, End and the arrows scroll the picked surface", () => {
  for (const source of [electron, tauri]) {
    const start = source.indexOf('if (!editable && key === "Home")');
    assert.ok(start > 0, "the non-editable scroll branch is missing");
    const block = source.slice(start, start + 400)
      .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

    assert.match(block, /key === "Home"\) scrollSurfaceTo\(0\)/);
    assert.match(block, /key === "End"\) scrollSurfaceTo\(scrollSurfaceEnd\(\)\)/);
    assert.match(block, /key === "ArrowUp"\) scrollSurfaceBy\(0, -40\)/);
    assert.match(block, /key === "ArrowDown"\) scrollSurfaceBy\(0, 40\)/);

    // The window calls are what picking a surface exists to avoid.
    assert.doesNotMatch(block, /[^e]scrollTo\(\{/);
    assert.doesNotMatch(block, /[^e]scrollBy\(\{/);
  }
});

// A CSI sequence sent as literal text has its leading ESC encoded as a key of its own
// once modified keys are on, so Home arrived as `ESC[91;3u` + `1~` — read as Alt-`[` with
// the rest thrown away. Captured from a real pane:
//   1b5b39313b3375317e  Home        1b5b39313b3375347e  End
//   1b5b39313b3375353030387e        this engine's own ESC[5008~ Cmd code
test("a CSI sequence folded into Alt-[ is put back together", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const start = main.indexOf('match = /^\\x1b\\[([0-9]+)(?::[0-9]+)*');
  assert.ok(start > 0, "the CSI-u matcher is missing");
  const block = main.slice(start, start + 1600)
    .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

  // 91 is `[`, and bit 2 of the modifier bitfield is alt.
  assert.match(block, /Number\(match\[1\]\) === 91/);
  assert.match(block, /& 0b10/);
  // Only when something trails it: a real Alt-`[` alone must still dispatch.
  assert.match(block, /input\.raw\.length > folded/);
  assert.match(block, /Buffer\.concat\(\[Buffer\.from\("\\x1b\["\), input\.raw\.subarray\(folded\)\]\)/);

  // The rewrite is 7 bytes to 2, so the buffer always shrinks and the loop terminates.
  assert.match(block, /const folded = Buffer\.byteLength\(match\[0\]\)/);
});

// Cmd is not a terminal modifier, so these arrive as private ESC[50XX~ codes and have to
// be driven through the renderer: a `meta` modifier takes the native path, and a synthetic
// native key carries no default editing behaviour with it.
test("Cmd caret motions are driven through the renderer", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const table = main.slice(main.indexOf("const CMD_CARET_MOTIONS"),
    main.indexOf("function dispatchPrivateShortcut"));

  // Four directions, each with and without Shift.
  for (const code of [5024, 5025, 5026, 5027, 5028, 5029, 5030, 5031]) {
    assert.match(table, new RegExp(`\\[${code}, \\{`), `motion ${code} is missing`);
  }
  assert.equal((table.match(/extend: true/g) || []).length, 4);
  assert.equal((table.match(/extend: false/g) || []).length, 4);
  // Cmd-Up/Down are the field's ends; the line pair reuses Home/End, which the preload
  // movers already understand.
  assert.match(table, /DocumentStart/);
  assert.match(table, /DocumentEnd/);

  assert.match(main, /sendToFocusedTabFrame\(currentWindows\(\)\.win, "tweb-caret-motion", motion\)/);
  // The motion branch returns before the Cmd key table below it, which legitimately does
  // use dispatchNamedKey — so the check is on the branch, not on a span of the file.
  const branch = main.slice(main.indexOf("const motion = CMD_CARET_MOTIONS.get(code)"),
    main.indexOf("const cmdKey = CMD_PRIVATE_KEYS.get(code)"));
  assert.doesNotMatch(branch, /dispatchNamedKey|dispatchNativeKey/);
  assert.match(branch, /return;/);

  const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const handler = preload.slice(preload.indexOf('ipcRenderer.on("tweb-caret-motion"'),
    preload.indexOf('ipcRenderer.on("tweb-tabs"'));
  assert.match(handler, /moveTextControlCaret\(active, key, extend\)/);
  assert.match(handler, /moveContentEditableCaret\(key, extend\)/);

  // Both movers have to know the document boundary, or Cmd-Up/Down do nothing.
  assert.match(preload, /if \(key === "DocumentStart"\) return 0;/);
  assert.match(preload, /if \(key === "DocumentEnd"\) return value\.length;/);
  assert.match(preload, /DocumentStart: \["backward", "documentboundary"\]/);
  assert.match(preload, /DocumentEnd: \["forward", "documentboundary"\]/);
});

test("Electron sends each Unicode terminal key through one input path", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.doesNotMatch(main, /codepoint > 0x7f\) sendToTabFrames\(win, "tweb-terminal-text"/);
});

// The page speaks CSS pixels and sendInputEvent speaks unzoomed window pixels.
// Feeding one to the other silently lands clicks off-target at any zoom ≠ 100%.
test("synthetic pointer events are scaled by the zoom factor", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /function pageToWindowPoint\(contents, point\)/);
  assert.match(main, /const zoom = contents\.getZoomFactor\(\) \|\| 1/);
  const pointerEvents = main.match(/sendInputEvent\(\{\s*type: "mouse(?:Move|Down|Up)"[^}]*\}/g) || [];
  assert.ok(pointerEvents.length > 0, "expected synthetic pointer events");
  for (const call of pointerEvents) {
    assert.doesNotMatch(
      call,
      /Math\.round\((?:value|point)\.[xy]\)/,
      `pointer event uses unscaled page coordinates: ${call}`
    );
  }
});

test("agent bridge exposes snapshot, act and query to the socket", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  for (const method of ["snapshot", "act", "navigate", "eval", "wait", "console", "errors", "screenshot"]) {
    assert.match(main, new RegExp(`case "${method}"`), `main is missing agent method ${method}`);
  }
  assert.match(electron, /function agentSnapshot\(params = \{\}\)/);
  assert.match(electron, /function agentAct\(params\)/);
  assert.match(electron, /ipcRenderer\.on\("tweb-agent-request"/);
  // Refs are hint labels so the agent and the human name the same element.
  assert.match(electron, /const labels = hintLabels\(targets\.length\);\s*\n\s*agentTargets = new Map/);
});

// A page that half-loaded is a network question, and Chromium keeps no history of the
// requests once they finish, so the buffer has to exist before anyone thinks to ask.
test("network requests are recorded into a bounded session-wide buffer", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const watch = main.slice(main.indexOf("function watchNetwork()"),
    main.indexOf("ipcMain.on(\"tweb-agent-response\""));
  assert.match(main, /const networkLog = \[\];/);
  assert.match(main, /const networkLogLimit = 200;/);
  assert.match(watch, /session\.defaultSession\.webRequest\.onBeforeRequest\(/);
  assert.match(watch, /session\.defaultSession\.webRequest\.onCompleted\(/);
  // A registered onBeforeRequest listener that never calls back stalls every request in
  // the session — the browser stops loading pages at all, not just stops logging them.
  assert.match(watch, /callback\(\{\}\);/);
  // Unbounded, this grows for as long as the browser runs.
  assert.match(watch, /networkLog\.splice\(0, networkLog\.length - networkLogLimit\)/);
  // Registration replaces rather than stacks, so it belongs at startup, not per tab.
  const configureTab = main.slice(main.indexOf("function configureTab(tab"),
    main.indexOf("function createTab("));
  assert.doesNotMatch(configureTab, /webRequest/, "webRequest must be wired once, not per tab");
  assert.match(main, /case "network":/);
  assert.match(main, /requests: params\.clear \? networkLog\.splice\(0\) : networkLog\.slice/);
});

// Deleting the image before the new tab paints uncovers the terminal behind it.
test("switching tabs replaces the image instead of deleting it", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const activateTab = main.slice(main.indexOf("function activateTab(index)"),
    main.indexOf("function cycleTab(direction)"));
  assert.doesNotMatch(activateTab, /a=d,d=I/, "activateTab must not clear the image");
});

// Painting runs on Chromium's frame clock, so an overlay drawn just after the
// clock dropped to its idle rate would sit invisible for up to a full interval.
test("overlays ask for a paint instead of waiting for the frame clock", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /case "repaint":/);
  assert.match(main, new RegExp(`const wasIdle = isThrottled\\((?:soleWindows|currentWindows\\(\\))\\);`));
  assert.match(main, new RegExp(
    `if \\(wasIdle && (?:soleWindows|currentWindows\\(\\))\\.win && !(?:soleWindows|currentWindows\\(\\))\\.win\\.isDestroyed\\(\\)`
    + ` && currentPane\\(\\)\\.visible\\)\\s*\\{?\\s*(?:soleWindows|currentWindows\\(\\))\\.win\\.webContents\\.invalidate\\(\\);`));
  assert.match(electron, /function paintNow\(\)/);
  // Every transient overlay mount requests a paint. The persistent mode/tab
  // indicator additionally repaints when its hover popover opens or closes.
  const mounts = electron.match(/document\.documentElement\.append\(host\);/g) || [];
  const requests = electron.match(/^ +paintNow\(\);$/gm) || [];
  assert.ok(requests.length >= mounts.length - 1,
    "each transient overlay should request a paint");
  const tabPopover = electron.slice(electron.indexOf("function hideTabPopover()"),
    electron.indexOf("function ensureIndicator()"));
  assert.equal(tabPopover.match(/^ +paintNow\(\);$/gm)?.length, 2,
    "opening and closing the tab popover should repaint immediately");
});

// Same hazard as the tab switch: a delete with no frame behind it shows the
// terminal, so a resize never deletes on its own — it re-places the image the
// terminal already holds, and any delete rides along with that.
test("a resize re-places the existing image instead of baring the pane", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const applyViewport = main.slice(main.indexOf("function applyViewport(vp, origin"),
    main.indexOf("function createWindow(url, frames"));
  assert.match(applyViewport, /if \(record\.visible\) replacePlacement\(frames\);/);
  assert.doesNotMatch(applyViewport, /writeGfx/);
  // A moved or shrunk pane leaves a placement the next frame cannot cover.
  assert.match(applyViewport, /if \(change\.originChanged \|\| change\.shrank\) frames\.pendingImageDelete = true;/);
  // `d=I` frees the pixels, which would leave nothing to re-place. The id comes from the pane's
  // own range, never from anything process-wide.
  const replace = main.slice(main.indexOf("function deletePlacement(frames"),
    main.indexOf("// --- damage patches ---"));
  assert.match(replace, /a=d,d=i,i=\$\{frames\.imageIds\.base\}/);
  assert.match(replace, /a=p,i=\$\{frames\.imageIds\.base\}/);
});

test("bare open never restores or saves an internal blank page", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /require\("\.\/window-session\.cjs"\)/);
  assert.match(main, /if \(showingLoadError \|\| !isRestorableUrl\(url\)\) return;/);
  assert.match(main, /const state = windowSessionForSave\(/);
  assert.match(main, new RegExp(
    `if \\(!sess\\(\\)\\.path \\|\\| (?:soleWindows|currentWindows\\(\\))\\.tabs\\.length === 0\\) return;`));
  assert.match(main, /function writeWindowSessionState\(state\)/);
  assert.match(main, /if \(!sess\(\)\.path \|\| !state\) return;/);
  assert.match(main, /claimWindowSessionSlot\(\{/);
  assert.match(main, /for \(const candidate of \[sess\(\)\.path, sess\(\)\.legacyPath\]\)/);
  // Per-pane now: `tweb open` with no url means "restore this window's tabs" and with a url means
  // "open that", and one host serves both at once.
  assert.match(main, /sess\(\)\.restore && !isRestorableUrl\(url\)/);
  assert.match(main, /noWindowSessionPage\(\)/);
  assert.match(main, /if \(!isRestorableUrl\(url\) \|\| url\.startsWith\("tweb-action:"\)\) return;/);
  assert.match(main, /if \(isRestorableUrl\(entry\?\.url\) && !seen\.has\(entry\.url\)\)/);
});

// Two panes in one tmux window used to hash to one session file, and the last writer
// silently replaced the other's tabs. The arbitration is an exclusive create plus a
// pid-checked release, and both are only reachable through a real run — a parse check
// would not notice either going missing.
test("the window session slot is claimed exclusively and released only by its owner", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // "wx" IS the arbitration: without it the create truncates a live pane's claim.
  assert.match(main, /flag: "wx"/);
  // Liveness has to be the real syscall, not a TTL — a pane sits idle for days.
  assert.match(main, /isAlive: processAlive,/);
  // Deleting a claim we do not own is what would hand a live pane's session away.
  // The PANE as well as the pid. One process used to mean one pane, so a matching pid was proof of
  // ownership; a host has N panes on one pid, and releasing by pid alone would let one pane delete
  // a sibling's claim while that sibling is still saving into the slot.
  assert.match(main,
    /claimIsReleasable\(readFileSync\(claimPath, "utf8"\), process\.pid, claimPane\)/);
  // The release runs on the exit path, after the final save.
  assert.match(main, /writeWindowSession\(\);\s*releaseWindowSessionClaim\(\);/);
  // A pane given a URL never restores but still saves, so it needs its own file too.
  assert.match(main, /resolveWindowSessionPaths\(\);\s*vis\(\)\.placement =/);
});

// A client can still report this window while tmux has zoomed a different pane.
// In that state the TWeb image must be removed from that client, then repainted
// when the zoom ends and the browser pane becomes visible again.
test("another pane owning tmux zoom hides the browser image", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /require\("\.\/tmux-visibility\.cjs"\)/);
  assert.match(main, /#\{window_zoomed_flag\}\\t#\{pane_id\}/);
  assert.match(main, /paneId: ownTmuxPane/);
  // Both the frontend's push and the no-frontend fallback poll run this one function,
  // so the zoom handling and the per-client delete cannot drift apart.
  assert.match(main, /const next = visibleTmuxClientTtys\(clients, vis\(\)\.placement\);/);
  // The invariant is that a client no longer showing this pane gets the delete, whatever the loop
  // is spelled like — it now logs the eviction first, which `bench/host-multipane.py` gates on.
  assert.match(main, /if \(next\.has\(tty\)\) continue;[\s\S]*?deleteImageFromClientTty\(tty\);/);
  assert.match(main, /if \(becameVisible\) repaintActiveTab\(\);/);
});

// The block a hint can pick is rarely exactly what one wants to copy, so `v` has
// to lead somewhere: a caret to move the start to, and motions free to leave the
// block.
test("visual mode drops to a caret and selects from it", () => {
  assert.match(electron, /function enterCaret\(\)/);
  assert.match(electron, /function selectFromCaret\(\)/);
  const handler = electron.slice(electron.indexOf("function handleVisualKey(event, key)"),
    electron.indexOf("function cssSelector(element)"));
  assert.match(handler, /key === "c" && !visualState\.caret/);
  assert.match(handler, /key === "v" && visualState\.caret/);

  const motions = electron.slice(electron.indexOf("function moveVisualSelection(key)"),
    electron.indexOf("function cancelVisual("));
  // Paragraph motions are what reach the next block at all.
  assert.match(motions, /"\{": \["backward", "paragraph"\]/);
  assert.match(motions, /"\}": \["forward", "paragraph"\]/);
  // The old guard snapped the focus back whenever a motion left the picked block.
  assert.doesNotMatch(motions, /!target\.contains\(nextFocusNode\)/);
  // A caret moves; it must never extend.
  assert.match(motions, /if \(visualState\.caret\) \{\n\s+selection\.modify\("move"/);
});

// `V` selects the whole document, whose start is scrolled far off; collapsing
// there put the caret out of sight and dragged the page to the top with it.
test("the caret starts inside the part of the selection that is on screen", () => {
  assert.match(electron, /function visibleSelectionStart\(range\)/);
  const start = electron.slice(electron.indexOf("function visibleSelectionStart(range)"),
    electron.indexOf("function enterCaret()"));
  assert.match(start, /getBoundingClientRect\(\)\.top \+ shift\.y >= 0\) return fallback/);
  assert.match(start, /caretRangeFromPoint/);

  // Scrolling follows the end that moved, not the whole selection.
  const scroll = electron.slice(electron.indexOf("function scrollSelectionIntoView(selection)"),
    electron.indexOf("function updateCaretBar(rect)"));
  assert.match(scroll, /pageSelection && !visualState\.caret\) return;/);
  assert.match(scroll, /const rect = focusRect\(selection\);/);
});

// The terminal cursor followed the web caret only inside form fields and
// contenteditable, because that is where a caret normally lives. Visual caret mode
// puts one on ordinary text, so nothing reported a position and the cursor stayed
// where it was last parked — which read as the caret always starting in the pane's
// top-left corner, wherever the selection actually was.
test("the terminal cursor follows the visual caret on an ordinary page", () => {
  assert.match(electron, /function visualCaretPoint\(\)/);
  const visual = electron.slice(electron.indexOf("function visualCaretPoint()"),
    electron.indexOf("function caretPoint()"));
  // Only in caret mode, and from the collapsed selection — that is the caret.
  assert.match(visual, /if \(!visualState\?\.caret\) return null;/);
  assert.match(visual, /range\.collapse\(true\);/);
  assert.match(visual, /getBoundingClientRect\(\)/);

  // A collapsed range measures 0x0 whenever its container is an element rather than a
  // text node, which is the normal case here: selecting an element's contents and
  // collapsing lands on the element at offset 0. Measured on a real page, that is what
  // made the position unreportable, so the descent to a text node is the actual fix.
  assert.match(visual, /if \(!box\.width && !box\.height\)/);
  assert.match(visual, /firstCharacterRect\(range\)/);
  const measure = electron.slice(electron.indexOf("function firstCharacterRect(range)"),
    electron.indexOf("function caretPoint()"));
  assert.match(measure, /while \(node && node\.nodeType !== Node\.TEXT_NODE && node\.childNodes\?\.length\)/);
  assert.match(measure, /node\.childNodes\[Math\.min\(offset, node\.childNodes\.length - 1\)\]/);
  assert.match(measure, /probe\.setEnd\(node, start \+ 1\)/);

  // caretPoint consults it before the editable paths, which bail on a plain page.
  const point = electron.slice(electron.indexOf("function caretPoint()"),
    electron.indexOf("function reportCaret()"));
  assert.match(point, /const visual = visualCaretPoint\(\);\n\s+if \(visual\) return visual;/);
  assert.match(point, /if \(!isEditable\(element\)/,
    "the editable guard must stay: it is what made the visual caret invisible");

  // The IME slot reserves cells and paints over the page for composition. Nothing is
  // composed at a visual caret, so blanking text there would be pure loss.
  const report = electron.slice(electron.indexOf("function reportCaret()"),
    electron.indexOf("// Suggestion panels and popovers close on Escape"));
  assert.match(report, /const composing = !visualState\?\.caret;/);
  assert.match(report, /point && composing && caretAtContentEnd\(\) \? imeSlotRect/);

  // Leaving visual mode has to release the cursor, since no other reporter covers a
  // plain page and it would otherwise stay parked on the last caret.
  const cancel = electron.slice(electron.indexOf("function cancelVisual(restoreMode = true)"),
    electron.indexOf("function enterVisual(item)"));
  assert.match(cancel, /const hadCaret = Boolean\(visualState\.caret\);/);
  assert.match(cancel, /if \(hadCaret\) reportCaret\(\);/);
});

test("the caret mode keys are mirrored into the Tauri preload", () => {
  const tauri = fs.readFileSync(
    path.join(__dirname, "..", "crates", "tweb-engine", "tauri", "src", "preload.js.inc"), "utf8");
  for (const marker of ["function enterCaret()", "function selectFromCaret()",
    'key === "v" && visualState.caret', '"}": ["forward", "paragraph"]',
    "function visibleSelectionStart(range)", "function focusRect(selection)"]) {
    assert.ok(tauri.includes(marker), `Tauri preload is missing ${marker}`);
  }
  // That engine has no caret reporting, so the mirror must not call into it.
  assert.doesNotMatch(tauri, /reportCaret\(\)/);
});

// One form named its control "id" and the whole hint pass died on it: `form.id`
// answered with that input, and `.startsWith` on an element throws.
test("id reads survive a form whose control is named id", () => {
  for (const [name, source] of [["preload", electron], ["tauri", fs.readFileSync(
    path.join(__dirname, "..", "crates", "tweb-engine", "tauri", "src", "preload.js.inc"), "utf8")]]) {
    assert.match(source, /function ownId\(element\) \{/, `${name} is missing ownId`);
    // Any raw `.id` read outside ownId itself is the bug coming back.
    const outside = source.replace(/function ownId\(element\) \{[^}]*\}/, "");
    const raw = outside.match(/(?<![\w.])element\.id(?![\w(])/g) || [];
    assert.deepEqual(raw, [], `${name} still reads element.id directly`);
  }
});

test("browser context menu uses Chromium hit-test data and native commands", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /buildBrowserContextMenu\(params/);
  assert.match(main, /contextMenuStateByTab\.set\(tab/);
  assert.match(main, /actions: new Set\(items\.filter\(\(item\) => item\.enabled\)/);
  assert.match(main, /case "paste-plain": contents\.pasteAndMatchStyle\(\)/);
  assert.match(main, /case "copy-image":\s+contents\.copyImageAt/);
  assert.match(main, /case "save-image":[\s\S]*downloadUrl\(contents, params\.srcURL\)/);
  assert.match(main, /session\.defaultSession\.on\("will-download"/);
  assert.match(main, /item\.setSavePath\(destination\)/);
  assert.match(main, /configureDownloads\(\)/);
  assert.match(main, /sendToMainTabFrame\(tab, "tweb-context-menu"/);
  assert.doesNotMatch(main, /navigator\.clipboard\.writeText\(item\.value\)/);
  assert.match(electron, /function showBrowserContextMenu\(model\)/);
  assert.match(electron, /send\(action \? "context-menu-command" : "context-menu-dismiss", action\)/);
  assert.match(electron, /returnFocus\?\.focus\?\.\(\{ preventScroll: true \}\)/);
  assert.match(electron, /restoredContextFocus && isEditable\(activeElement\(\)\)/);
  assert.match(electron, /menu\.onkeydown/);
});

test("each pane owns an interactive tab badge instead of publishing tabs in tmux", () => {
  for (const [name, source] of [["Electron", electron], ["Tauri", tauri]]) {
    assert.match(source, /let tabState = \{ activeIndex: 0, count: 1, tabs:/,
      `${name} has no initial pane-local tab state`);
    assert.match(source, /function showTabPopover\(pinned = false\)/,
      `${name} has no hoverable tab-title popover`);
    assert.match(source, /badge\.onmouseenter = \(\) => showTabPopover\(false\)/,
      `${name} does not open tab titles on hover`);
    assert.match(source, /button\.onclick = \(event\) => \{[\s\S]*send\("activate-tab", tab\.index\)/,
      `${name} cannot switch tabs by clicking a title`);
    assert.match(source, /tabBadge\.textContent = `\$\{active\}\/\$\{tabState\.count\}`/,
      `${name} does not render current\/total in a separate badge`);
    assert.match(source, /ipcRenderer\.on\("tweb-tab-state"/,
      `${name} does not receive pane-local tab state updates`);
  }

  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /function tabStateModel\(\)[\s\S]*title: candidate\.webContents\.getTitle\(\)/);
  assert.match(main, /event\.reply\("tweb-tab-state", tabStateModel\(\)\)/);
  assert.match(main, /function activateTab\(index\)[\s\S]*sendTabState\(\)/);
  const paneTitle = main.slice(main.indexOf("function updatePaneTitle()"),
    main.indexOf("function restorePaneTitle()"));
  assert.match(paneTitle, /"-T", "tweb"/);
  assert.doesNotMatch(paneTitle, /tabLabel|activeTabIndex/);

  const tauriBrowser = fs.readFileSync(path.join(root,
    "crates/tweb-engine/tauri/src/browser.rs"), "utf8");
  assert.match(tauriBrowser, /fn send_tab_state\(&self\)[\s\S]*"title": tab\.title/);
  assert.match(tauriBrowser, /self\.emit_active\("tweb-tab-state", &model\)/);
  assert.match(tauriBrowser, /fn sync_title\(&self\)[\s\S]*self\.tmux\.update_title\("tweb"\)/);
});

test("visual image actions copy pixels, copy current source, and download", () => {
  for (const [name, source] of [["Electron", electron], ["Tauri", tauri]]) {
    assert.match(source, /function imageSource\(image\)/, `${name} has no image source resolver`);
    assert.match(source, /image\.currentSrc \|\| image\.src/);
    assert.match(source, /imageURL: imageSource\(image\)/);
    assert.match(source, /link\?\.querySelector\?\.\("img,picture,canvas,svg,video,\[role=img\]"\) \|\| null/,
      `${name} does not preserve an image nested inside a link`);
    const handler = source.slice(source.indexOf("function handleVisualKey(event, key)"),
      source.indexOf("function cssSelector(element)"));
    assert.match(handler, /visualState\.kind === "image" \? visualState\.imageURL/);
    assert.match(handler, /key === "D" && visualState\.kind === "image" && visualState\.imageURL/);
    assert.match(handler, /send\("download", visualState\.imageURL\)/);
    assert.match(source, /send\("copy-image", \{/);
  }
});

// A picked image or link has no selection, so `c` had nothing to collapse and did
// nothing at all — the caret was unreachable from anything but a text target.
test("c reaches a caret from a target that carries no text", () => {
  assert.match(electron, /function caretRangeFor\(item\)/);
  const reach = electron.slice(electron.indexOf("function caretRangeFor(item)"),
    electron.indexOf("function selectFromCaret()"));
  assert.match(reach, /firstTextNode\(item\.element\)/);
  // An image carries no text of its own; the caret comes from around it.
  assert.match(reach, /caretRangeFromPoint/);
  assert.doesNotMatch(electron,
    /key === "c" && visualState\.selectionMade/);
  // In caret mode `y` means the text, not the bitmap or the href.
  assert.match(electron, /smart && !item\.caret && item\.kind === "image"/);
  assert.match(electron, /smart && !item\.caret && item\.kind === "link"/);
});

// Chromium paints nothing until a page commits. On google.com that was 5.5s of a
// pane showing nothing at all — and once the pane ran in the alternate screen,
// "nothing" meant a black rectangle rather than the user's old shell output.
test("the first tab shows something before the real page commits", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /function placeholderPage\(target\)/);
  const open = main.slice(main.indexOf("const load = () => {"),
    main.indexOf("function placeholderPage(target)"));
  assert.match(open, /showInitialPlaceholder && isRestorableUrl\(url\) && !url\.startsWith\("file:"\)/,
    "the placeholder must skip local files and respect the active startup tab");
  // A later tab has the previous page on screen to hold, while the restored
  // active tab explicitly opts into the placeholder.
  assert.match(open, /once\("did-finish-load", load\)/);
  // If the placeholder itself fails there still has to be a navigation.
  assert.match(open, /loadURL\(placeholderPage\(url\)\)\.catch\(load\)/);
});

// The image sits below the terminal's text now, which put Chromium's own stderr
// chatter on top of the page.
test("engine stderr stays off the pane and in the log buffer", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // Recording must not depend on TWEB_DEBUG: engine-log was empty exactly when
  // someone was debugging a pane that had not been launched with it.
  assert.match(main, /const debugLogging = true;/);
  assert.doesNotMatch(main, /process\.env\.TWEB_DEBUG/);
  // The buffer is installed before anything can log into it.
  assert.ok(main.indexOf("const engineLog = []") < main.indexOf("function queueFrame("),
    "the log buffer is installed after the first thing that logs");

  const pane = fs.readFileSync(path.join(__dirname, "..", "crates", "tweb-pane", "src", "lib.rs"), "utf8");
  assert.match(pane, /\.stderr\(engine_stderr\(\)\)/);
  // `tweb open` starts inside a pane the user was already using, and its leftover
  // shell output shows through the page now that the image is below the text.
  // terminal_setup existed for this and was never called by anything.
  assert.match(pane, /let _screen_guard = terminal::ScreenGuard::enter\(\);/,
    "the pane never enters the alternate screen");
  const term = fs.readFileSync(
    path.join(__dirname, "..", "crates", "tweb-pane", "src", "terminal.rs"), "utf8");
  assert.match(term, /impl Drop for ScreenGuard/, "the user's screen is never restored");
  assert.match(term, /\\x1b\[\?1049h/);
  const stderr = pane.slice(pane.indexOf("fn engine_stderr()"), pane.indexOf("/// Finds the Electron binary path"));
  // stdout is the graphics channel; only stderr may be redirected.
  assert.match(stderr, /TWEB_DEBUG.*is_ok\(\)/s, "TWEB_DEBUG no longer keeps stderr inherited");
  assert.match(stderr, /engine-\{name\}\.log/, "engine stderr is not kept anywhere");
});

// The shortcut runtime lives in an isolated world, so an agent could not see the
// mode it was in, what a picker was showing, or what the collectors would find.
test("the shortcut runtime reports its own state to an agent", () => {
  assert.match(electron, /case "page-diag":/);
  const diag = electron.slice(electron.indexOf('case "page-diag":'),
    electron.indexOf("const shortcutHelpSections"));
  for (const field of ["mode", "picker", "visual", "scrollSurface", "activeElement", "targets"]) {
    assert.ok(diag.includes(`${field}:`), `page-diag omits ${field}`);
  }
  // Counting what the collectors find is the point: a frame that contributes
  // nothing shows up as zero here rather than as an empty screen.
  assert.match(diag, /scrollable: scrollableTargets\(\)\.length/);
  assert.match(diag, /visual: visualTargets\(\)\.length/);

  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // A page that cannot answer must not fail the whole diagnostic.
  assert.match(main, /page = await agentPageRequest\("page-diag"/);
  assert.match(main, /page = \{ error: String\(error\?\.message \|\| error\) \};/);
});

// Picking a scroll surface used to be a one-way door: the surface was dropped the
// moment it was used, and there was no candidate standing for the page.
test("a picked scroll surface survives use and can be left", () => {
  for (const [name, source] of [["preload", electron], ["tauri", fs.readFileSync(
    path.join(__dirname, "..", "crates", "tweb-engine", "tauri", "src", "preload.js.inc"), "utf8")]]) {
    const surface = source.slice(source.indexOf("function scrollSurface()"),
      source.indexOf("function panSurface()"));
    // A scrolled document root sits above the viewport, so visibility is the wrong
    // test — it is what dropped the surface.
    assert.doesNotMatch(surface, /visibleRect/, `${name} still gates the surface on visibility`);
    assert.match(surface, /scrollsAtAll\(scrollTarget\)/, `${name} does not check it still scrolls`);

    const targets = source.slice(source.indexOf("function scrollableTargets()"),
      source.indexOf("function scrollSurface()"));
    assert.match(targets, /page: true/, `${name} offers no page candidate`);
    assert.match(targets, /if \(picked\) targets\.unshift\(entry\)/,
      `${name} does not put the way out first`);
    assert.match(source, /scrollTarget = item\.page \|\| item\.pan \? null : item\.element;/,
      `${name} does not release the surface when the page is picked`);
    // Escape is the other way out.
    assert.match(source, /if \(scrollSurface\(\) \|\| panSurface\(\)\) \{\n\s+scrollTarget = null;\n\s+panTarget = null;/,
      `${name} does not release the surface on Escape`);
    // The state is invisible without this: the indicator said nothing was picked.
    assert.match(source, /scrollSurface\(\) \? "⇅ inner · Esc" : ""/,
      `${name} does not show a picked surface`);
  }
});

// A page whose content is proxied through an iframe offered nothing to hint,
// scroll or select unless focus happened to be inside the frame.
test("collectors reach into a same-origin frame", () => {
  for (const [name, source] of [["preload", electron], ["tauri", fs.readFileSync(
    path.join(__dirname, "..", "crates", "tweb-engine", "tauri", "src", "preload.js.inc"), "utf8")]]) {
    const roots = source.slice(source.indexOf("function collectRoots()"),
      source.indexOf("function uniqueVisibleTargets("));
    assert.match(roots, /sameOriginFrameDocument\(element\)/, `${name} skips frame documents`);
    // Constructors do not cross realms, so the tag name is what identifies a frame.
    assert.match(roots, /element\.localName !== "iframe"/, `${name} tests iframes by constructor`);
    assert.match(roots, /frameOffsets\.set\(inner/, `${name} forgets the frame offset`);

    // Every element check on the collection path has to survive another realm.
    assert.doesNotMatch(source, /instanceof (?:Element|HTML[A-Za-z]*Element)\b/,
      `${name} still uses a realm-bound instanceof`);
    assert.match(source, /function isElement\(node\)/, `${name} is missing isElement`);

    // Selection is per document; the parent's would stay empty for a frame target.
    assert.match(source, /function visualSelection\(\)/, `${name} is missing visualSelection`);

    // A frame scrolls as a document, not through an overflow container.
    const scroll = source.slice(source.indexOf("function scrollableTargets()"),
      source.indexOf("function scrollSurface()"));
    assert.match(scroll, /root\.scrollingElement/, `${name} cannot scroll a frame`);
  }
});

// Twice now a helper was called before it existed, and the preload only fails at
// run time: the whole mode silently stops working.
test("every function the preload calls is defined in it", () => {
  // CSS text carries function-looking tokens that are not calls.
  const cssFunctions = new Set(["calc", "clamp", "minmax", "repeat", "rgba", "rgb", "scale",
    "translate", "var", "url", "type", "value", "attr", "linear", "cubic"]);
  const builtins = new Set(["require", "setTimeout", "clearTimeout", "setInterval",
    "clearInterval", "parseInt", "parseFloat", "getComputedStyle", "getSelection",
    "addEventListener", "removeEventListener", "queueMicrotask", "requestAnimationFrame",
    "cancelAnimationFrame", "scrollBy", "scrollTo", "isNaN", "isFinite", "structuredClone",
    "fetch", "btoa", "atob", "encodeURIComponent", "decodeURIComponent", "setImmediate",
    "matchMedia", "postMessage", "reportError", "blur", "focus"]);
  for (const [name, source] of [["preload", electron], ["tauri", fs.readFileSync(
    path.join(__dirname, "..", "crates", "tweb-engine", "tauri", "src", "preload.js.inc"), "utf8")]]) {
    const defined = new Set([...source.matchAll(/function ([A-Za-z_$][\w$]*)\s*\(/g)]
      .map((found) => found[1]));
    for (const found of source.matchAll(/(?:const|let|var) ([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) {
      defined.add(found[1]);
    }
    // A name destructured out of a require is as defined as one declared here — the point
    // of the check is that nothing is called into thin air, not that nothing is imported.
    for (const found of source.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(/g)) {
      for (const part of found[1].split(",")) {
        const name = part.split(":").pop().trim();
        if (name) defined.add(name);
      }
    }
    const called = new Set([...source.matchAll(/(?<![\w.$])([a-z][A-Za-z0-9_$]{3,})\(/g)]
      .map((found) => found[1]));
    const missing = [...called].filter((call) => !defined.has(call) && !builtins.has(call)
      && !cssFunctions.has(call) && !source.includes(`.${call}(`));
    assert.deepEqual(missing, [], `${name} calls functions it does not define`);
  }
});

test("the terminal caret follows the focused field for IME composition", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /function moveTerminalCaret\(point\)/);
  assert.match(main, /case "caret":/);
  // Parking the cursor is pointless if the image covers it: the terminal paints
  // preedit and the cursor in the same layer, and z >= 0 hides both.
  assert.match(main, /const imageZ = Number\.isSafeInteger\(configuredImageZ\) \? configuredImageZ : -1;/);
  assert.match(main, /imageZ === 0 \? "" : `,z=\$\{imageZ\}`/);
  // No caret to follow means no cursor on top of the page, and the shape we
  // borrowed goes back — otherwise the shell inherits a bar cursor.
  assert.match(main, /function unparkTerminalCaret\(\)[\s\S]*?CSI\("\?25l"\)\}\$\{CARET_SHAPE_RESET\}/);
  assert.match(main, /function terminalCleanup\(record = currentPane\(\)\)[\s\S]*?paneWrite\(CSI\("0 q"\)\)/);
  // A block cursor sits on the character and hides the page's own caret.
  assert.match(main, /const CARET_BAR = CSI\("6 q"\);/);
  assert.match(main, /\$\{CARET_BAR\}/);
  // Preedit is painted on the cell's text baseline, so the row is chosen by
  // baseline; picking the cell that contains the caret's centre put a composing
  // syllable a line above page text taller than one cell.
  assert.match(main, /Math\.round\(baseline \/ cellHeight - CARET_BASELINE\) \+ 1/);
  assert.match(main, /Math\.round\(point\.x \* zoom \/ cellWidth\) \+ 1/);
  // The report is deduped on CSS pixels, so zoom and resize have to re-derive the
  // cell themselves — measured 3 rows / 2 columns of drift without this.
  assert.match(main, /function reparkTerminalCaret\(\)/);
  const viewportTail = main.slice(main.indexOf("function applyViewport(vp, origin"),
    main.indexOf("function createWindow(url, frames"));
  assert.match(viewportTail, /if \(record\.visible\) replacePlacement\(frames\);[\s\S]{0,120}reparkTerminalCaret\(\);/);
  const zoomStep = main.slice(main.indexOf("function setBrowserZoom(action)"));
  assert.match(zoomStep.slice(0, zoomStep.indexOf("\n}")), /reparkTerminalCaret\(\);/);
  assert.match(electron, /function caretPoint\(\)/);
  assert.match(electron, /send\("caret",/);
});

// The terminal and the page cannot be aligned — different fonts, one on a cell
// grid — and the preedit text never reaches us, so we cannot draw it ourselves.
// Give it a cell-aligned surface of its own instead of letting it land on page text.
test("composition gets a cell-aligned surface past the caret", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // Only main can measure a cell: it owns the pane geometry and the zoom factor.
  assert.match(main, /function cellMetrics\(\)/);
  assert.match(main, /width: logical\.width \/ Math\.max\(1, currentFrames\(\)\.cells\.cols\) \/ zoom/);
  assert.match(main, /sendToTabFrames\(tab, "tweb-cell-metrics", cellMetrics\(\)\)/);
  // Cell size changes with both of those, and the page cannot see either change.
  const viewport = main.slice(main.indexOf("function applyViewport(vp, origin"),
    main.indexOf("function createWindow(url, frames"));
  assert.match(viewport, /broadcastCellMetrics\(\);/);
  const zoomStep = main.slice(main.indexOf("function setBrowserZoom(action)"));
  assert.match(zoomStep.slice(0, zoomStep.indexOf("\n}")), /broadcastCellMetrics\(\);/);
  assert.match(electron, /ipcRenderer\.on\("tweb-cell-metrics"/);
  assert.match(electron, /function imeSlotRect\(caret\)/);
  // Past the caret, so the character before it keeps its pixels. The backdrop
  // starts on that exact boundary rather than expanding back over the glyph.
  assert.match(electron, /let left = Math\.ceil\(caret\.x \/ cell\.width\) \* cell\.width;/);
  assert.match(electron, /imeSlotBox\.style\.left = `\$\{rect\.left\}px`;/);
  // The clearing borrows the nearest opaque input/container background and has no
  // boundary chrome of its own, so it blends into both light and dark pages.
  assert.match(electron, /function imeSurfaceColor\(\)/);
  assert.match(electron, /getComputedStyle\(element\)\.backgroundColor/);
  const slotStyle = electron.slice(electron.indexOf("function ensureImeSlot()"),
    electron.indexOf("function removeImeSlot()"));
  assert.doesNotMatch(slotStyle, /outline:/);
  assert.doesNotMatch(slotStyle, /box-shadow:/);
  assert.match(slotStyle, /backdrop-filter:blur\(1\.5px\)/);
  assert.match(electron, /imeSlotBox\.style\.background = surface;/);
  // At the right edge, wrap to another terminal row instead of moving backward
  // over text on the caret's line.
  assert.match(electron, /top = top \+ cell\.height <= lastRow \? top \+ cell\.height : Math\.max\(0, top - cell\.height\);/);
  assert.match(electron, /left = 0;/);
  // The reported point is the surface's own cell, which is what the cursor parks on.
  assert.match(electron, /point = \{ x: slot\.left, y: slot\.top \};/);
  // A new cell size moves the surface without the caret moving, and the report is
  // deduped on the reported point.
  assert.match(electron, /lastCaretReport = "";\n\s+reportCaret\(\);/);
  // Hidden offscreen windows may stop servicing rAF after blur. Cleanup must not
  // depend on another painted frame or the surface and terminal cursor stick around.
  assert.match(electron, /addEventListener\("focusout", \(\) => queueMicrotask\(\(\) => \{/);
  // Same-origin frames share one terminal cursor; a late report from the frame
  // that just lost focus must not overwrite the new focused frame's report.
  assert.match(main, /handleNativeShortcut\(tab, message\.action, message\.value, event\.senderFrame\)/);
  assert.match(main, /frameKey\(sourceFrame\) !== frameKey\(focused\)/);
});

test("scroll keys can target a picked inner surface", () => {
  assert.match(electron, /function scrollableTargets\(\)/);
  // An app shell's scroller fills the viewport and often shares a corner with
  // the scroller nested in it; the hint filter would discard both.
  const scrollable = electron.slice(electron.indexOf("function scrollableTargets()"),
    electron.indexOf("function scrollSurface()"));
  assert.doesNotMatch(scrollable, /uniqueVisibleTargets\(/);
  assert.match(electron, /case "s": startScrollPicker\(\); break;/);
  for (const key of ["h", "j", "k", "l"]) {
    assert.match(electron, new RegExp(`case "${key}": scrollSurfaceBy\\(`),
      `${key} must scroll the picked surface`);
  }
  assert.doesNotMatch(electron, /case "j": scrollBy\(/);
  // The surface, not the step: how far a page key moves is pinned by its own test.
  assert.match(electron, /if \(key === "PageUp" \|\| key === "PageDown"\) \{[\s\S]*?scrollSurfaceBy\(0, /);
});

test("large canvas and SVG surfaces can be panned with scroll keys", () => {
  for (const source of [electron, tauri]) {
    assert.match(source, /querySelectorAll\("canvas,svg"\)/);
    assert.match(source, /rect\.width < 320 \|\| rect\.height < 220/);
    assert.match(source, /function panSurfaceBy\(left, top\)/);
    assert.match(source, /send\("native-drag", \{/);
    assert.match(source, /scrollTarget = item\.page \|\| item\.pan \? null : item\.element/);
    assert.match(source, /panTarget = item\.pan \? item\.element : null/);
  }
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /case "native-drag":/);
  assert.match(main, /type: "mouseDown"[\s\S]*type: "mouseMove"[\s\S]*type: "mouseUp"/);
  const browser = fs.readFileSync(path.join(root, "crates/tweb-engine/tauri/src/browser.rs"), "utf8");
  assert.match(browser, /"native-drag" =>/);
  assert.match(browser, /fn dispatch_native_drag\(/);
});

// Ctrl-; and Ctrl-/ are independent toggles: bypass (Cmd to the page) and
// vimium shortcuts. A single flag used to drive both, and collapsing them again
// makes one key silently move the other mode.
test("the mode toggles stay independent across tmux and the engine", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /privateKey\("C-\\\\;", "5001"\)/);
  assert.match(main, /privateKey\("C-\/", "5014"\)/);
  // In the passthrough table Ctrl-; must return the client to root, or the
  // table keeps re-arming itself after the mode it guards is gone.
  assert.match(main, /passthroughTable, "C-\\\\;"[\s\S]*?switch-client", "-T", "root"/);
  // The mode lives on the pane's input state: a user switching one pane to passthrough is saying it
  // about that pane's page, and shared it re-routed every pane's keys at once.
  assert.match(main, /code === 5014[\s\S]*?setVimiumShortcutsEnabled\(!inputState\(\)\.vimium\)/);
  assert.match(main, /code === 5011 \|\| code === 5012/);
  assert.match(main, /setCmdBypassEnabled\(code === 5012\)/);
  // The private-sequence regex has to cover the Cmd codes at 5020+; a code
  // outside its range is dropped before any table is consulted.
  assert.match(main, /50\(\?:0\[1-9\]\|1\[0-9\]\|\[2-9\]\[0-9\]\)/);
});

// A site's own shortcuts (m to mute, j/k on a feed) check isTrusted, so insert
// mode has to bypass the renderer round-trip that makes keys synthetic.
// A site's own shortcuts (m to mute, j/k on a feed) check isTrusted, so insert
// mode has to bypass the renderer round-trip that makes keys synthetic. A
// focused input needs the same treatment for a different reason: renderer-built
// KeyboardEvents always carry keyCode 0, and sites branching on
// `e.keyCode === 40` — suggestion lists among them — then ignore ArrowDown.
test("insert mode delivers native keys to the page", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /if \(!inputState\(\)\.vimium \|\| inputState\(\)\.insertMode \|\| modifiers\.includes\("meta"\)\) \{/);
  assert.match(main, /case "insert-mode":/);
  // setMode is the single place that mirrors the state, so an editable focus
  // arms native delivery just like an explicit `i` does.
  assert.match(electron, /function setEngineNativeKeys\(enabled\)[\s\S]*?send\("insert-mode", enabled\)/);
  assert.match(electron, /setEngineNativeKeys\(mode === "insert"\)/);
  // The mirror must reset wherever the preload's own flag would.
  assert.match(main, /if \(frame === tab\.webContents\.mainFrame\) inputState\(\)\.insertMode = false;/);
  // The preload skips redundant IPC, so every engine-side reset has to tell the
  // page — otherwise native delivery never re-arms after a tab switch.
  assert.match(electron, /engineNativeKeys = false;/);
  assert.match(main, new RegExp(
    `inputState\\(\\)\\.insertMode = false;\\s*\\/\\/ The preload mirrors this flag[\\s\\S]*?`
    + `sendToTabFrames\\((?:soleWindows|currentWindows\\(\\))\\.win, "tweb-shortcuts-mode"`));
});

// Cmd-V never arrives as a key — Ghostty emits no PTY encoding for Cmd combos,
// so paste_from_clipboard writing the clipboard into the PTY is the whole
// event. Losing either the DECSET or the reassembly types the clipboard
// character by character, and a multiline body sends Enter mid-paste.
test("Cmd-V arrives as a bracketed paste rather than typed characters", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const terminal = fs.readFileSync(path.join(root, "crates/tweb-pane/src/terminal.rs"), "utf8");
  assert.match(terminal, /\\x1b\[\?2004h/);
  assert.match(terminal, /\\x1b\[\?2004l/);
  // The paste state and the parse buffer live on the pane's record — one buffer for N panes crossed
  // input, measured. `input` is the local handle `consumeRawInput` holds.
  assert.match(main, /if \(input\.paste\.begins\(input\.raw\)\) \{/);
  assert.match(main, /if \(input\.paste\.active\) \{/);
  // The ESC-disambiguation timer must not fire into a paste body.
  assert.match(main, /if \(input\.paste\.begins\(input\.raw\)\) \{[\s\S]*?clearTimeout\(input\.flushTimer\)/);
  assert.match(main, /function dispatchPaste\(text\)/);
  // A real paste event carries formatting that insertText cannot.
  assert.match(main, /normalize\(clipboard\.readText\(\)\) === body[\s\S]*?contents\.paste\(\)/);
});

// Clicking an ad or embed moves focus into a cross-origin subframe whose preload
// ignores shortcuts; without a fall-back every key silently disappears.
test("shortcut keys fall back to a frame that can handle them", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /function shortcutFrameKeys\(tab\)/);
  assert.match(main, /if \(frame && !shortcutFrameKeys\(tab\)\.has\(frameKey\(frame\)\)\) frame = contents\.mainFrame;/);
  assert.match(electron, /ipcRenderer\.send\("tweb-preload-ready", \{ shortcutFrame \}\)/);
});

// The omnibox should offer what the user visited in any pane, not just here.
test("history is shared through a file", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /function historyPath\(\)/);
  assert.match(main, /appendFileSync\(historyPath\(\)/);
  assert.match(main, /function readGlobalHistory\(/);
  assert.match(main, /const history = readGlobalHistory\(\);/);
  // Append-only, so concurrent panes cannot clobber each other.
  assert.doesNotMatch(main, /writeFileSync\(historyPath\(\)/);
});

test("agent socket refuses a path longer than sun_path", () => {
  const server = fs.readFileSync(path.join(__dirname, "agent-server.cjs"), "utf8");
  // The socket is bound at a staging name and renamed into place, so the staging name — the
  // longer of the two — is the one bind(2) sees and the one the budget has to be measured
  // against. See agent-server.test.cjs for the behavioural test.
  assert.match(server, /Buffer\.byteLength\(staging\) > 100/);
  assert.match(server, /agent-\$\{pane\.replace/);
});

// The startup identity is pinned because the window-session save path derives
// from it, so visibility must not reuse it: a pane moved by break-pane/join-pane
// keeps its id but changes window, every client match fails, and painting stops.
test("visibility matches the pane's live placement, not its startup identity", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // The live placement lives on the pane's record, not in a module variable: panes in one engine
  // sit in different tmux windows, and one shared placement had the last pane to push overwrite
  // every other pane's — measured with three panes, %11 pushed as @2 and reported @1.
  const registry = fs.readFileSync(path.join(__dirname, "pane-registry.cjs"), "utf8");
  assert.match(registry, /visibility: \{\s*placement: null,/);
  assert.match(main, /function vis\(\) \{\s*return currentPane\(\)\.visibility;/);
  // The frontend re-resolves placement through `-t <pane id>` on every tick and the
  // push carries the result, so the engine adopts the pane's current window rather
  // than the one it started in.
  assert.match(main, /applyClientListing\(push\.clients, push\.placement\)/);
  assert.match(main, /function applyClientListing\(clients, placement\) \{\s*vis\(\)\.placement = placement;/);
  assert.match(main, /visibleTmuxClientTtys\(clients, vis\(\)\.placement\)/);
  // The no-frontend fallback keeps re-resolving it for itself.
  assert.match(main, /function syncTmuxVisibility\(\)[\s\S]*?"display-message", "-p", "-t", vis\(\)\.placement\.paneId/);
  assert.match(main, /placement = \{ \.\.\.vis\(\)\.placement, session, windowId \}/);
  // The save path stays on the startup identity; a moved pane must not silently
  // adopt another window's stored tabs. The slot claim derives from it too.
  // The identity lives on the pane record: a host serves panes in different tmux windows, and one
  // module-level identity would key every pane's session slot off whichever pane probed first.
  assert.match(main, /identity: sess\(\)\.identity,/);
  // The in-flight guard has to clear even if spawning throws, or polling stops.
  assert.match(main, /catch \(spawnError\) \{\s*vis\(\)\.checkRunning = false;/);
});

// The engine is launched directly by tests and by hand, where no frontend exists to push
// visibility. It must not sit waiting for a line that will never arrive — a pane frozen at
// its startup visibility looks exactly like a dead engine.
test("visibility falls back to polling when no push arrives", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /const delay = process\.env\.TWEB_FRONTEND_PID \? VISIBILITY_PUSH_GRACE_MS : 0;/);
  // Armed per pane: a frontend that pushes for one pane says nothing about another whose frontend
  // is older or absent, so the source and the timers are on the record like the placement.
  assert.match(main, /if \(vis\(\)\.source === "push"\) return;\s*vis\(\)\.source = "poll";/);
  // The first push disarms both timers for good.
  assert.match(main, /vis\(\)\.source = "push";/);
  assert.match(main, /if \(vis\(\)\.pollTimer\) \{\s*clearTimeout\(vis\(\)\.pollTimer\);/);
});
// Chromium's sendInputEvent takes Accelerator key codes, and it silently drops
// names it does not know: measured in offscreen Chromium, keyDown with
// "ArrowDown" arrives as key="" keyCode=0 while "Down" arrives as
// key="ArrowDown" keyCode=40. The same measurement rules out rewriting a letter
// under Cmd — "KeyK" arrives empty, "k" as keyCode 75. keyDown once sent the raw
// name while only keyUp used the resolved one, which broke every arrow key.
test("native keys go out under the names Chromium accepts", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /\["ArrowUp", "Up"\], \["ArrowDown", "Down"\]/);
  const fn = main.slice(main.indexOf("function dispatchNativeKey("),
    main.indexOf("function dispatchNamedKey("));
  assert.match(fn, /const keyCode = ACCELERATOR_KEYS\.get\(key\) \|\| key;/);
  // Both edges must use the resolved code, not the raw web name.
  assert.match(fn, /contents\.sendInputEvent\(\{ \.\.\.event, type: "keyDown" \}\)/);
  assert.match(fn, /contents\.sendInputEvent\(\{ \.\.\.event, type: "keyUp" \}\)/);
  assert.doesNotMatch(fn, /type: "keyDown", keyCode: key/,
    "keyDown must not bypass the Accelerator resolution");
  assert.doesNotMatch(main, /META_LETTER_KEYS/,
    "rewriting a Cmd letter to KeyX makes the page see an empty key");
});

// With a focused input now armed for native delivery, the physical Escape
// already arrives as a real key. dismissPageOverlay must not turn that into a
// second one: measured end to end, one physical Escape reaches the page exactly
// once (trusted), then focus clears and the mode returns to normal.
test("Escape stays a single delivery once a focused input goes native", () => {
  // The pass-through branch consumes the native Escape instead of re-sending it.
  assert.match(electron, /if \(key === "Escape" && passThroughEscape\) \{[\s\S]*?passThroughEscape = false;/);
  // The editable branch is what asks the engine for it, and only when TWeb has
  // not already got one in flight.
  const handler = electron.slice(electron.indexOf("if (eventIsEditable(event)) {"),
    electron.indexOf("if (pendingG) {"));
  assert.match(handler, /dismissPageOverlay\(\);/);
  // Only the top frame mirrors the flag; pageInsertMode is one flag per tab, so a
  // subframe blurring must not disarm the main frame's focused input.
  assert.match(electron, /if \(!topFrame \|\| enabled === engineNativeKeys\) return;/);
});

// The mode label used to carry three unrelated things: the page mode (normal/editing), the
// shortcuts toggle, and the Cmd bypass toggle. Because the toggles were checked first,
// focusing an input showed `P` instead of `E` — the mode label hid the one state it exists
// to report. The toggles are settings, not modes, so they moved to their own badge.
test("the input toggles are a badge, not a mode", () => {
  const normal = electron.slice(electron.indexOf("function normalMode()"),
    electron.indexOf("const koreanLangmap"));
  assert.doesNotMatch(normal, /setMode\("bypass"\)/);
  assert.doesNotMatch(normal, /setMode\("passthrough"\)/);
  // What is left is the page mode alone, editing first.
  assert.match(normal, /if \(insertMode\) setMode\("insert", "Esc"\);/);
  assert.match(normal, /isEditable\(activeElement\(\)\)\) setMode\("insert"\)/);
  // And nothing renders a mode label for them any more.
  assert.doesNotMatch(electron, /passthrough: "P"/);

  const badge = electron.slice(electron.indexOf("function inputBadgeState()"),
    electron.indexOf("function renderIndicator()"));
  // Silent when both toggles are at their defaults — a badge that is always lit says
  // nothing — and one badge, not two, when both are off.
  assert.match(badge, /return \{ text: "", title: "" \};/);
  assert.match(badge, /if \(!vimiumEnabled && bypassEnabled\)/);
  assert.match(badge, /if \(!vimiumEnabled\)/);
  assert.match(badge, /if \(bypassEnabled\)/);

  // The badge is hidden rather than emptied, so it takes no space when it has nothing
  // to say.
  const render = electron.slice(electron.indexOf("function renderIndicator()"),
    electron.indexOf("function updateTabState(model)"));
  assert.match(render, /inputBadge\.style\.display = input\.text \? "" : "none";/);
  // The mode label keeps its own colours, minus the one the toggles used.
  assert.doesNotMatch(render, /indicatorMode === "passthrough"/);
});

// Every graphics write anchors the cursor at the pane origin and restores it afterwards,
// but that restore uses the terminal's single DECSC slot, which the caret's own placement
// does not own — so the cursor came back at the origin. Whole frames are continuous, so a
// caret parked on a word halfway down the page was dragged to the pane's top-left corner
// several times a second, which read as "the caret always starts in the corner".
test("the caret is re-asserted after anything that moves the cursor", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /function reassertTerminalCaret\(\)/);
  // Rewriting the same position is a few bytes and idempotent, so it simply repeats.
  const reassert = main.slice(main.indexOf("function reassertTerminalCaret()"),
    main.indexOf("function unparkTerminalCaret()") > main.indexOf("function reassertTerminalCaret()")
      ? main.indexOf("function unparkTerminalCaret()")
      : main.length);
  // The caret cell is per-pane, on the input state: the coordinates go to that pane's own terminal
  // through `paneWrite`, so a shared cell parked every pane's cursor where one pane's caret was.
  assert.match(reassert, /if \(!input\.caretCell\) return;/);
  assert.match(reassert, /writeTerminalCaret\(input\.caretCell\.row, input\.caretCell\.col\)/);

  // Every path that emits graphics: the two inline ones and the one that puts the worker's
  // whole frames on the pane. The last is the one that fires continuously.
  const gfx = main.slice(main.indexOf("function writeGfxCommands(commands)"),
    main.indexOf("// --- terminal setup ---"));
  assert.equal((gfx.match(/reassertTerminalCaret\(\);/g) || []).length, 3,
    "writeGfxCommands, writeGfx and writeGfxChunked must all re-assert");
  assert.match(gfx.slice(0, gfx.indexOf("function writeGfx(header, payload)")),
    /reassertTerminalCaret\(\);/);
});

// The worker used to write whole frames to `process.stdout` from its own thread while the main
// thread wrote caret, patch and placement sequences to the same tty — two writers on one pane,
// which is the tear `frame-writer.cjs` was built to remove and measured at roughly one frame in
// 750. It is also unsurvivable for a hosted engine, whose stdout is the supervisor's control
// pipe: a frame written there is not a frame, it is a corrupted protocol stream.
test("whole frames reach the terminal through the pane's writer, not the worker", () => {
  const worker = fs.readFileSync(path.join(__dirname, "gfx-worker.cjs"), "utf8");
  assert.doesNotMatch(worker, /process\.stdout/,
    "the worker must not write to any terminal itself");
  // What it does instead: hand back the escape sequences for someone else to write, with the
  // pane they belong to. A reply that dropped the key would strand that pane believing the
  // worker is busy — measured: every whole frame silently dropped, stdout down to 11 bytes,
  // while frames.whole, the log lines and the frame file on disk all still said "working".
  // Matched on the two fields that carry the invariant rather than on the whole literal: the
  // reply gained a `compressed` flag for diag (DETAIL.md 8.6) and this assertion failed, which
  // is a test protecting its own punctuation instead of the behaviour it names.
  assert.match(worker, /postMessage\(\{ type: "ready", paneKey, commands[,}]/);
  assert.match(worker, /postMessage\(\{ type: "error", paneKey,/);

  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const commands = main.slice(main.indexOf("function writeGfxCommands(commands)"),
    main.indexOf("// --- terminal setup ---"));
  assert.match(commands, /paneWrite\(graphicsPassthrough\(raw\)\)/);
});

// Wire names are matched by string equality across three process boundaries, so a rename on one
// side is invisible until someone tries the feature.
//
// This is not hypothetical. A bulk rename of the `soleWindows` variable in #29 rewrote the
// LITERALS too, and the result shipped: main.cjs sent `"tweb-soleWindows.tabs"` while preload
// listened for `"tweb-tabs"`, main.cjs matched `case "list-soleWindows.tabs"` while preload sent
// `"list-tabs"`, and the agent method became `"soleWindows.tabs"` while the CLI asked for
// `"tabs"`. Measured on a live pane: `tweb tabs` answered `unknown method "tabs"` and the tab
// list never reached the UI. Nothing failed at build time and no test noticed.
// The host protocol version is a literal in two languages, linked by nothing but string equality:
// `hostProtocolVersion()` in JS and `PROTOCOL_VERSION` in `crates/twebd/src/protocol.rs`. The daemon
// kills an engine whose version differs (`engine_host::spawn_engine`), so a drift here does not
// corrupt anything — but it silently disables hosting for every pane, and both sides individually
// look correct. This is the same shape as the tab wire names below, which shipped broken in #29.
test("the engine and the daemon agree on the host protocol version", () => {
  const { hostProtocolVersion } = require("./hosted-runtime.cjs");
  const rust = fs.readFileSync(
    path.join(__dirname, "..", "crates", "twebd", "src", "protocol.rs"), "utf8");
  const declared = /pub const PROTOCOL_VERSION: u32 = (\d+);/.exec(rust);
  assert.ok(declared, "PROTOCOL_VERSION not found in crates/twebd/src/protocol.rs");
  assert.equal(hostProtocolVersion(), Number(declared[1]),
    "the engine declares a version the daemon refuses, which disables hosting silently");
});

test("the tab wire names agree across main, preload and the CLI", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");

  // 1. The IPC channel main pushes the tab model on, and preload receives it on.
  assert.match(main, /sendToTabFrames\([^)]*"tweb-tabs"/,
    "main must publish the tab model on tweb-tabs");
  assert.match(preload, /ipcRenderer\.on\("tweb-tabs"/,
    "preload must listen on the channel main publishes on");

  // 2. The command preload sends to open the tab list, and the case main dispatches it by.
  assert.match(preload, /send\("list-tabs"\)/, "preload must request the list as list-tabs");
  assert.match(main, /case "list-tabs":/, "main must handle the command preload sends");

  // 3. The agent method the Rust CLI asks for (`Command::Tabs` maps to "tabs" in lib.rs).
  assert.match(main, /case "tabs":/, "main must expose the agent method the CLI calls");

  // A rename that moves the variable but not the wire is the failure this guards, so assert the
  // clobbered spellings are gone rather than only that the right ones are present.
  for (const wrong of ["tweb-soleWindows.tabs", "list-soleWindows.tabs", '"soleWindows.tabs"']) {
    assert.ok(!main.includes(wrong), `main.cjs still carries the clobbered name ${wrong}`);
  }
});

// The pane inherits the shell's cursor: a visible block in the top-left corner. Nothing
// hid it until a caret was parked, so from load through picking a visual target the cursor
// sat in the corner — which reads as the caret having started there, since the corner is
// exactly where a mis-placed caret would be.
test("the terminal cursor is hidden until a caret is parked on it", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // Startup hides it rather than leaving whatever the shell had.
  const setup = main.slice(main.indexOf("function terminalSetup()"),
    main.indexOf("function requestTrackedKeyboardModeRestore()"));
  assert.match(setup, /CSI\("\?25l"\)/);
  assert.match(setup, /inputState\(\)\.caretHidden = true;/);

  // And a report with no caret hides it unconditionally — a frame's cursor anchoring can
  // leave one visible at the pane origin even when TWeb never placed it.
  const move = main.slice(main.indexOf("function moveTerminalCaret(point)"),
    main.indexOf("function writeTerminalCaret(row, col)"));
  assert.match(move, /unparkTerminalCaret\(\);/);
  assert.doesNotMatch(move, /if \(input\.caretCell\) unparkTerminalCaret\(\)/,
    "hiding must not be conditional on TWeb having parked the caret itself");

  // That runs on every caret-less report, so the write happens only on the transition.
  const unpark = main.slice(main.indexOf("function unparkTerminalCaret()"),
    main.indexOf("// The page draws the IME composition surface"));
  assert.match(unpark, /if \(input\.caretHidden\) return;/);
});

// The page draws its own caret bar, separate from the terminal cursor, and it was
// positioned from the collapsed range's bounding rect. That measures 0x0 whenever the
// range's container is an element rather than a text node — the usual case after
// collapsing to a selection start — so the bar was drawn at the viewport's top-left
// corner. Two bars appeared: one on the caret, one in the corner.
test("the page's caret bar is measured the same way as the terminal cursor", () => {
  const update = electron.slice(electron.indexOf("function updateVisualSelection()"),
    electron.indexOf("// The caret starts where the selection starts"));
  assert.match(update, /const range = selection\.getRangeAt\(0\);/);
  assert.match(update, /rect\.width \|\| rect\.height \? rect : firstCharacterRect\(range\)/);
  // The same helper the terminal cursor uses, so the two can never disagree about where
  // the caret is.
  assert.match(electron, /function firstCharacterRect\(range\)/);
});

// Backspace navigating back is the one Chrome reflex that can destroy work: pressed inside
// a form field it would leave the page and take what was typed with it. The editable check
// is what makes it safe, so the binding and its guard are pinned together — an edit that
// keeps the binding and drops the guard is the failure this exists to catch.
//
// Electron only: the Tauri preload is a separate file that does not carry these bindings.
test("Backspace only navigates back when nothing editable has focus", () => {
  const binding = electron.slice(
    electron.indexOf('if (key === "Backspace" && !event.ctrlKey'),
    electron.indexOf("if (event.ctrlKey || event.metaKey || event.altKey) return;"));
  assert.ok(binding.length > 0, "the Backspace binding must exist");
  assert.match(binding, /!eventIsEditable\(event\)/);
  assert.match(binding, /send\("history-back"\)/);
});

// Alt-arrow rather than Cmd-[: a terminal cannot deliver Cmd combinations to the page
// unless bypass mode is on, so binding Cmd would work only sometimes — worse than not
// binding it. This pins the choice so nobody "completes" it with the Cmd variant.
test("history keys use Alt-arrow, never Cmd", () => {
  const alt = electron.slice(
    electron.indexOf("if (event.altKey && !event.ctrlKey && !event.metaKey"),
    electron.indexOf('if (key === "Backspace" && !event.ctrlKey'));
  assert.match(alt, /key === "ArrowLeft" \|\| key === "ArrowRight"/);
  assert.match(alt, /history-back.*history-forward/s);
  assert.doesNotMatch(alt, /metaKey &&/, "Cmd cannot be delivered reliably through a terminal");
});

// The same destroy-work case as Backspace, and it was live: measured in a real pane with
// the caret in an input, `M-Left` navigated away and took the typed text with it. In Chrome
// these keys belong to the field when one has focus — Alt-arrow moves the caret one word —
// so the guard is not merely defensive, it is what Chrome does. Pinned separately from the
// binding above because the binding survived while the guard was missing.
test("Alt-arrow only navigates when nothing editable has focus", () => {
  const alt = electron.slice(
    electron.indexOf("if (event.altKey && !event.ctrlKey && !event.metaKey"),
    electron.indexOf('if (key === "Backspace" && !event.ctrlKey'));
  assert.match(alt, /!eventIsEditable\(event\)/);
});

// Reopening the find bar with `/` then pressing Enter without retyping used to send
// the stale query as a continuation of a session that no longer existed. Clearing
// `lastSearch` when no result has landed makes the bar open into the same fresh state
// as the first ever open — no prefilled query, no inherited match.
test("find bar reopen with no live result clears the last query", () => {
  assert.match(electron, /if \(!searchState \|\| !searchState\.result\.textContent\) lastSearch = "";/);
});

// `printQueueOutcome` decides what the user is told about a paper job they cannot see in
// any queue window, so it is exercised for real rather than matched in the source: the
// exit status is the only evidence that reaches them. Lifted out of main.cjs and evaluated
// because main.cjs cannot be required outside Electron.
function loadPrintQueueOutcome() {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const start = main.indexOf("function printQueueOutcome(");
  assert.ok(start > 0, "printQueueOutcome must exist in main.cjs");
  const end = main.indexOf("\n}\n", start);
  // eslint-disable-next-line no-new-func
  return new Function(`${main.slice(start, end + 2)}\nreturn printQueueOutcome;`)();
}

test("a successful lpr reports paper, a missing printer says so specifically", () => {
  const printQueueOutcome = loadPrintQueueOutcome();

  // lpr is silent on success, so no error is the only success signal there is.
  assert.deepEqual(printQueueOutcome(null), { ok: true, message: "queued for the printer" });

  // The two strings macOS CUPS actually emits when no usable default queue exists,
  // captured by running the failures rather than taken from the man page. This is the case
  // a terminal user is most likely to hit and least able to guess, so it must not collapse
  // into a generic failure — otherwise they re-press the key at a machine with no printer.
  for (const stderr of [
    "lpr: Error - PRINTER environment variable names default destination that does not exist.\n",
    "lpr: Error - ~/.cups/lpoptions file names default destination that does not exist.\n",
  ]) {
    const none = printQueueOutcome(new Error("exit 1"), stderr);
    assert.equal(none.ok, false);
    assert.match(none.message, /no printer configured/);
    // The PDF survives a failed paper job, and saying so is what stops it looking like the
    // whole print was lost.
    assert.match(none.message, /~\/Downloads/);
  }

  // No print system at all is a different diagnosis from a misconfigured one.
  const missing = Object.assign(new Error("spawn lpr ENOENT"), { code: "ENOENT" });
  assert.match(printQueueOutcome(missing).message, /no print system/);

  // An unknown `-P` queue produces a bare "No such file or directory" — the same string a
  // missing FILE produces. Guessing between them would put a wrong diagnosis on the badge,
  // so it is quoted verbatim instead, still saying the PDF survived.
  const bare = printQueueOutcome(new Error("exit 1"), "lpr: No such file or directory\n");
  assert.equal(bare.ok, false);
  assert.match(bare.message, /No such file or directory/);
  assert.doesNotMatch(bare.message, /no printer configured/);
  assert.match(bare.message, /PDF saved/);

  // Anything unrecognised keeps its real message but stays one line, so it fits the badge.
  const other = printQueueOutcome(new Error("exit 1"), "lpr: Error - job queue is full\nsecond line\n");
  assert.match(other.message, /job queue is full/);
  assert.doesNotMatch(other.message, /second line/);
});

// Save-as-PDF is the common case and must keep its meaning: Ctrl-P and a page's own
// window.print() go on saving, and paper is reached only by the explicit `gp` chord
// through its own IPC action. A regression here would silently start printing pages.
test("paper printing is opt-in and never remaps Ctrl-P", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /case "print":\s*\n\s*void printPageToPdf\(tab\);/);
  assert.match(main, /case "print-paper":\s*\n\s*void printPageToPdf\(tab, \{ paper: true \}\);/);
  // The paper hand-off happens only after the PDF has settled, so a failed queue cannot
  // cost the user the file.
  assert.match(main, /settleTransfer\(transfer, "completed"\);\s*\n\s*if \(paper\) sendToPrintQueue/);
  // Never awaited: Chromium's own print path wedged the renderer permanently, and blocking
  // the engine on a child process talking to an absent printer rebuilds that failure shape.
  assert.match(main, /execFile\("lpr", \[destination\], \{ timeout: 15_000 \}, \(error, _stdout, stderr\) =>/);
  // The PDF's completed badge has already scheduled an expiry. The paper result is newer
  // and promises a full six-second hold, so the stale timer must not erase it early.
  assert.match(main, /if \(transferBadgeTimer\) \{\s*clearTimeout\(transferBadgeTimer\);\s*transferBadgeTimer = null;/);
  // Ctrl-P is handled in the engine and still routes to the save path, not the paper one.
  assert.match(main, /const print = control && key\.toLowerCase\(\) === "p"/);
  assert.match(main, /else if \(print\) void printPageToPdf\(\);/);
  assert.match(electron, /else if \(key === "p"\) send\("print-paper"\);/);
});

// A focused field the user cannot see is not a place to put a cursor. Pages hold focus in
// hidden inputs constantly — search overlays, paste targets, focus traps — and reporting
// those put the terminal cursor in the middle of a heading, which is what the user saw.
test("an invisible or offscreen field reports no caret", () => {
  // Bounded by a string unique to caretPoint: `const computed = getComputedStyle(element)`
  // also appears in `textControlPageLines`, which is defined earlier in the file.
  const gate = electron.slice(electron.indexOf("function caretPoint()"),
    electron.indexOf("let x = box.left +"));
  // Both axes. Only the vertical pair was checked, so `left:-9999px` — the commonest way
  // to park a hidden field — sailed through.
  assert.match(gate, /box\.bottom <= 0 \|\| box\.top >= innerHeight/);
  assert.match(gate, /box\.right <= 0 \|\| box\.left >= innerWidth/);
  // Laid out but invisible: opacity:0 over a real position, or a hidden ancestor.
  assert.match(gate, /checkVisibility\(\{ visibilityProperty: true, opacityProperty: true \}\)/);
  // And a 1x1 focus trap is not somewhere a person types.
  assert.match(gate, /box\.width < 2 \|\| box\.height < 2/);
});

// Two carets a few pixels apart read as a rendering fault, not as two systems agreeing.
// The terminal's is the one that matters: it is the anchor composition lands on.
test("the page caret is hidden while the terminal draws one", () => {
  assert.match(electron, /function hidePageCaret\(element\)/);
  assert.match(electron, /element\.style\.caretColor = "transparent"/);
  // Restored when the slot goes away, or a field keeps an invisible caret after this pane
  // stops driving it.
  assert.match(electron, /function restorePageCaret\(\)/);
  // Keyed off the parked terminal cursor rather than off the IME slot, which is now
  // withheld mid-text — see "the IME slot is withheld when the caret is not at the end".
  // Tying it to the slot would leave the page's caret drawn beside the terminal's in
  // exactly the case the slot is skipped.
  const report = electron.slice(electron.indexOf("  function reportCaret()"),
    electron.indexOf("  function dismissPageOverlay()"));
  assert.match(report, /hidePageCaret\(activeElement\(\)\)/);
  assert.match(report, /else restorePageCaret\(\);/);
  // An inline style rather than a stylesheet: caret-color inherits, and a page-wide rule
  // would blank the caret in fields this pane is not driving.
  assert.match(electron, /caretColorBefore = element\.style\.caretColor \|\| ""/);
});

// The slot is up whenever a field has focus — composition is never signalled to the
// preload — so its alpha is paid every time someone clicks a search box, not only while
// something is being composed.
test("the composition surface stays faint enough to be furniture", () => {
  const surface = electron.slice(electron.indexOf("function imeSurfaceColor()"),
    electron.indexOf("function imeSlotRect(caret)"));
  assert.doesNotMatch(surface, /,\.7[0-9]\)/, "the .76 that read as an opaque block");
  assert.match(surface, /,\.42\)`/);
  assert.match(surface, /rgba\(24,24,27,\.42\)/);
  assert.match(surface, /rgba\(255,255,255,\.42\)/);
});

// A renderer crash reloads the page and it paints again — but the reload's preload sometimes
// never registers, and then every key is dropped while the page looks fine. Observed on a real
// pane: `shortcut frames=0 ready=0` for minutes after `loaded`, with no way out but a manual
// reload. Nothing noticed, because a dropped key is silent.
test("undeliverable shortcuts repair themselves", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // The drop is what starts the repair: it is the only evidence delivery is broken.
  const send = main.slice(main.indexOf("function sendToFocusedTabFrame(tab, channel"),
    main.indexOf("// The preload receives the two flags separately"));
  assert.match(send, /repairShortcutDelivery\(tab\);/);

  const repair = main.slice(main.indexOf("function repairShortcutDelivery(tab)"),
    main.indexOf("function sendToFocusedTabFrame(tab, channel"));
  // A ping first. Ready-gating is this file's bookkeeping, not an Electron rule — send always
  // works, and a live preload answering re-registers itself.
  assert.match(repair, /frame\.send\("tweb-are-you-there"\)/);
  // A page mid-load has not had its chance to register yet; reloading would cancel the very
  // navigation about to fix things.
  assert.match(repair, /contents\.isLoading\(\)/);
  // Silence means no preload is there, so the page needs reloading to get one...
  assert.match(repair, /tab\.webContents\.reload\(\)/);
  // ...but not forever: a page that crashes on load would otherwise reload in a loop.
  assert.match(repair, /state\.reloads >= MAX_SHORTCUT_RELOADS/);
  // And an answered ping must not also reload.
  assert.match(repair, /if \(readyFrameKeys\(tab\)\.has\(frameKey\(tab\.webContents\.mainFrame\)\)\)/);

  // The preload's half: the same registration it sends at startup, which is idempotent.
  assert.match(electron, /ipcRenderer\.on\("tweb-are-you-there", \(\) => \{/);
  const answer = electron.slice(electron.indexOf('ipcRenderer.on("tweb-are-you-there"'));
  assert.match(answer.slice(0, 200), /ipcRenderer\.send\("tweb-preload-ready", \{ shortcutFrame \}\)/);
});

// Both sets are keyed by frame and go stale together, but only one was pruned on navigation.
// A leftover shortcut key makes the sender believe a dead frame can take shortcuts, so it
// skips the fall-back to the main frame and drops the key instead.
test("navigation prunes both frame sets, not just the ready one", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const navigation = main.slice(main.indexOf('onContents("did-start-navigation"'));
  const body = navigation.slice(0, navigation.indexOf("onContents(\"context-menu\""));
  assert.match(body, /readyFrameKeys\(tab\)\.delete\(key\);/);
  assert.match(body, /shortcutFrameKeys\(tab\)\.delete\(key\);/);
});

// The ordinary answer to "show me it is loading" is an animated indeterminate bar. It is the
// wrong answer here, and these pin why so the next person does not helpfully add one.
test("the loading bar steps rather than animates", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // A page that loads quickly shows nothing: the first step is scheduled, not sent.
  assert.match(main, /const LOADING_INDICATOR_DELAY_MS = \d+;/);
  assert.match(main, /function scheduleLoadingProgress\(tab, progress\)/);
  // Main-frame navigation only. `did-start-loading` also fires for subframes, so a video page
  // fetching ads would flicker the bar — and every flicker is a whole frame to the terminal.
  const navigation = main.slice(main.indexOf('onContents("did-start-navigation"'));
  assert.match(navigation.slice(0, 400), /if \(details\.isMainFrame\) scheduleLoadingProgress\(tab, 0\.3\);/);
  assert.match(main, /onContents\("dom-ready", \(\) => \{/);
  // Removed at the end of the load however it ended — an error page must not keep a bar.
  assert.match(main, /onContents\("did-stop-loading", \(\) => sendLoadingProgress\(tab, null\)\);/);

  const bar = electron.slice(electron.indexOf("function ensureLoadingBar()"),
    electron.indexOf("function removeLoadingBar()"));
  // NO ANIMATION. A transition or keyframes here would push whole frames continuously for the
  // length of every page load, and would read as video to the playback detector, which decides
  // a page is playing by counting paints.
  assert.doesNotMatch(bar, /transition/);
  assert.doesNotMatch(bar, /animation/);
  assert.doesNotMatch(bar, /@keyframes/);
  // Thin, at the top, and never in the way of a click.
  assert.match(bar, /height:2px/);
  assert.match(bar, /pointer-events:none/);
  assert.match(electron, /ipcRenderer\.on\("tweb-loading"/);
});

// Chrome does not fire blur or focusout when the focused element is removed from the DOM,
// which is exactly how a search overlay closes. Every other caret trigger is an event on the
// focused field, so the terminal cursor stayed parked on a field that no longer existed —
// visible in normal mode, on top of the page, until some unrelated key reported again.
test("leaving a mode re-reports the caret", () => {
  const normal = electron.slice(electron.indexOf("  function normalMode() {"),
    electron.indexOf("  function hasTransientMode()"));
  assert.match(normal, /reportCaret\(\);/);
  // `""` is itself the no-caret report, so resetting the dedup key to it would swallow the
  // one send that clears the cursor.
  assert.match(normal, /lastCaretReport = null;/);
});

// The slot reserves cells past the caret and paints over them. At the end of a field that is
// empty space; anywhere else it is the page's own text, three cells of it blurred out.
test("the IME slot is withheld when the caret is not at the end", () => {
  assert.match(electron, /const slot = point && composing && caretAtContentEnd\(\)/);
  const helper = electron.slice(electron.indexOf("  function caretAtContentEnd()"),
    electron.indexOf("  function reportCaret()"));
  // Measured from `selectionStart`, which is where the caret is drawn. Shift+Home leaves
  // `selectionEnd` at the far end of the text, so asking it said "at the end" while the
  // caret sat in front of everything — the reported smear.
  assert.match(helper, /const start = element\.selectionStart/);
  assert.match(helper, /!value\.slice\(start\)\.trim\(\)/);
  // A range selection is never a place to compose: the next character replaces it.
  assert.match(helper, /if \(\(element\.selectionEnd \?\? start\) !== start\) return false;/);
  assert.match(helper, /if \(!selection\.isCollapsed\) return false;/);
  // contentEditable has no value, so the range from the caret to the end of the host is it.
  assert.match(helper, /after\.setEndAfter\(element\)/);

  // Suppressing the page caret must follow the parked terminal cursor, not the slot —
  // otherwise withholding the slot brings back the two carets a few pixels apart.
  const report = electron.slice(electron.indexOf("  function reportCaret()"),
    electron.indexOf("  function dismissPageOverlay()"));
  assert.match(report, /if \(point && isEditable\(activeElement\(\)\)\) hidePageCaret\(activeElement\(\)\);/);
  assert.match(report, /else restorePageCaret\(\);/);
  const slot = electron.slice(electron.indexOf("  function updateImeSlot(rect)"),
    electron.indexOf("  function ensureImeSlot()"));
  assert.doesNotMatch(slot, /hidePageCaret/);
  assert.doesNotMatch(slot, /restorePageCaret/);
});

// The page keys scrolled the document from inside a focused textarea, because they skipped
// the caret step the arrows right next to them take. No other editor does that with them.
test("the page keys move the caret in a field before they scroll", () => {
  const perform = electron.slice(electron.indexOf("function performKeyDefault(active, payload, editable)"));
  const page = perform.slice(perform.indexOf('if (key === "PageUp" || key === "PageDown")'));
  // Same two calls, in the same order, as the arrow branch above it.
  assert.match(page, /if \(moveTextControlCaret\(active, key, Boolean\(payload\.shiftKey\)\)\) return;/);
  assert.match(page, /if \(active\?\.isContentEditable && moveContentEditableCaret\(key, Boolean\(payload\.shiftKey\)\)\) return;/);
  // And only then the surface, which is what it always did.
  assert.match(page, /scrollSurfaceBy\(0, \(key === "PageUp" \? -0\.9 : 0\.9\) \* scrollSurfaceHeight\(\)\)/);

  const destination = electron.slice(electron.indexOf("function textControlDestination(element, key, position)"),
    electron.indexOf("function moveTextControlCaret("));
  // A page of the FIELD. A textarea is routinely much shorter than the viewport, and the
  // caret is moving inside its box.
  assert.match(destination, /textControlPageLines\(element\)/);
  assert.match(electron, /element\.clientHeight \* 0\.9 \/ lineHeight/);
  // A single-line input has no page to move through, so it answers with the ends — which
  // is what a browser does there too.
  assert.match(destination, /if \(!\(isTag\(element, "textarea"\)\)\) return key === "PageUp" \? 0 : value\.length;/);
});

// A pane that goes hidden and does not come back is invisible from the outside: no frames
// arrive, and every other symptom — a strip of stale image, a page that looks dead — is
// downstream of this one transition. Observed once during a resize and never pinned,
// because the line that would have said so was behind `debugLogging`.
test("a visibility transition is logged whether or not debug logging is on", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const listing = main.slice(main.indexOf("function applyClientListing(clients, placement)"),
    main.indexOf("function applyVisibilityPush(hex)"));
  const transition = listing.slice(listing.indexOf("const changed = recordVisibility("));
  assert.match(transition, /console\.error\(`tweb: visibility \$\{changed\.visible \? "visible" : "hidden"\}`/);
  // Not gated. The eviction log above it still is, because that one fires per client per
  // poll; this one fires only on a change.
  assert.doesNotMatch(transition, /if \(debugLogging\)/);
  // "Hidden" has two very different causes — no client is watching, or this pane resolved
  // to the wrong window — and the line has to tell them apart on its own.
  assert.match(transition, /ttys=\$\{\[\.\.\.next\]\.join\(","\) \|\| "none"\}/);
  assert.match(transition, /placement=\$\{vis\(\)\.placement\?\.session\}/);
});

// Native scrollbars are an OS widget, not page CSS, so Chromium's light-mode default
// paints a white track over dark content — a bright strip the user saw on dogdrip.
// The fix is a style injected alongside the caret indicator.
test("scrollbar styling is injected with the caret style", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const block = main.slice(main.indexOf("style.textContent = ["),
    main.indexOf("(document.head || document.documentElement).append(style);"));
  // Transparent track so the page shows through on both light and dark.
  assert.match(block, /::-webkit-scrollbar\{[^}]*background:transparent/);
  assert.match(block, /::-webkit-scrollbar-track\{[^}]*background:transparent/);
  // A thin thumb in a muted tone, not the OS default white/grey.
  assert.match(block, /::-webkit-scrollbar-thumb\{[^}]*background:rgba\(130,130,140/);
  // The standards path for non-Chromium engines.
  assert.match(block, /scrollbar-width:thin/);
  assert.match(block, /scrollbar-color:rgba\(130,130,140/);
  // The corner between two scrollbars — transparent, not white.
  assert.match(block, /::-webkit-scrollbar-corner\{[^}]*background:transparent/);
});

// `tweb pdf` cannot reuse printPageToPdf: that one is the Ctrl-P path, which invents a name
// under ~/Downloads. An agent has already picked the path and cannot discover a generated
// name afterwards, so the agent command has to own the destination.
test("the pdf agent command prints to the caller's path", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const pdf = main.slice(main.indexOf("async function agentPdf(params)"),
    main.indexOf("// Every agent command goes through the surface hold"));
  // The same Chromium call printPageToPdf makes, on the agent's active tab.
  assert.match(pdf, /await agentContents\(\)\.printToPDF\(\{\}\)/);
  // No path means no file: the bytes come back inline, as screenshot does with its PNG.
  assert.match(pdf, /if \(!params\.path\) return \{ pdf: pdf\.toString\("base64"\) \}/);
  assert.match(pdf, /const target = path\.resolve\(params\.path\)/);
  assert.match(pdf, /writeFileSync\(target, pdf, \{ mode: 0o600 \}\)/);
  assert.match(pdf, /return \{ path: target, size: pdf\.length \}/);
  // Not the download-badging path — that would put an agent's file in the transfer list
  // under a name it never asked for.
  assert.doesNotMatch(pdf, /printPageToPdf|trackTransfer/);

  const dispatch = main.slice(main.indexOf("async function dispatchAgentCommand(method, params)"));
  assert.match(dispatch, /case "pdf":\n\s+return agentPdf\(params\);/);
});
