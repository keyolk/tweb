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
  assert.match(hitTest, /const bounds = host instanceof Element \? visibleRect\(host\) : null;/);
  assert.match(hitTest, /if \(bounds && \(x < bounds\.left \|\| x > bounds\.right/);
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
  assert.match(main, /const wasIdle = activeFrameRate !== maxActiveFrameRate;/);
  assert.match(main, /if \(wasIdle && win && !win\.isDestroyed\(\) && terminalVisible\) win\.webContents\.invalidate\(\);/);
  assert.match(electron, /function paintNow\(\)/);
  // Every overlay mount must request it; the mode indicator rides along instead.
  const mounts = electron.match(/document\.documentElement\.append\(host\);/g) || [];
  const requests = electron.match(/^ +paintNow\(\);$/gm) || [];
  assert.equal(requests.length, mounts.length - 1,
    "each overlay except the mode indicator should request a paint");
});

// Same hazard as the tab switch: a delete with no frame behind it shows the
// terminal, so a resize never deletes on its own — it re-places the image the
// terminal already holds, and any delete rides along with that.
test("a resize re-places the existing image instead of baring the pane", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const applyViewport = main.slice(main.indexOf("function applyViewport(vp, origin"),
    main.indexOf("function createWindow(url)"));
  assert.match(applyViewport, /if \(terminalVisible\) replacePlacement\(\);/);
  assert.doesNotMatch(applyViewport, /writeGfx/);
  // A moved or shrunk pane leaves a placement the next frame cannot cover.
  assert.match(applyViewport, /if \(originChanged \|\| shrank\) pendingImageDelete = true;/);
  // `d=I` frees the pixels, which would leave nothing to re-place.
  const replace = main.slice(main.indexOf("function deletePlacement()"),
    main.indexOf("function transferFrame("));
  assert.match(replace, /a=d,d=i,i=\$\{imageId\}/);
  assert.match(replace, /a=p,i=\$\{imageId\}/);
});

// The block a hint can pick is rarely exactly what one wants to copy, so `v` has
// to lead somewhere: a caret to move the start to, and motions free to leave the
// block.
test("visual mode drops to a caret and selects from it", () => {
  assert.match(electron, /function enterCaret\(\)/);
  assert.match(electron, /function selectFromCaret\(\)/);
  const handler = electron.slice(electron.indexOf("function handleVisualKey(event, key)"),
    electron.indexOf("function cssSelector(element)"));
  assert.match(handler, /key === "c" && visualState\.selectionMade && !visualState\.caret/);
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

test("the caret mode keys are mirrored into the Tauri preload", () => {
  const tauri = fs.readFileSync(
    path.join(__dirname, "..", "crates", "tweb-engine", "tauri", "src", "preload.js.inc"), "utf8");
  for (const marker of ["function enterCaret()", "function selectFromCaret()",
    'key === "v" && visualState.caret', '"}": ["forward", "paragraph"]']) {
    assert.ok(tauri.includes(marker), `Tauri preload is missing ${marker}`);
  }
  // That engine has no caret reporting, so the mirror must not call into it.
  assert.doesNotMatch(tauri, /reportCaret\(\)/);
});

test("the terminal caret follows the focused field for IME composition", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /function moveTerminalCaret\(point\)/);
  assert.match(main, /case "caret":/);
  assert.match(electron, /function caretPoint\(\)/);
  assert.match(electron, /send\("caret",/);
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
});

// A site's own shortcuts (m to mute, j/k on a feed) check isTrusted, so insert
// mode has to bypass the renderer round-trip that makes keys synthetic.
test("insert mode delivers native keys to the page", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /if \(!browserShortcutsEnabled \|\| pageInsertMode\) \{/);
  assert.match(main, /case "insert-mode":/);
  assert.match(electron, /send\("insert-mode", true\)/);
  assert.match(electron, /send\("insert-mode", false\)/);
  // The mirror must reset wherever the preload's own flag would.
  assert.match(main, /if \(frame === tab\.webContents\.mainFrame\) pageInsertMode = false;/);
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
  assert.match(server, /Buffer\.byteLength\(target\) > 100/);
  assert.match(server, /agent-\$\{pane\.replace/);
});
