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
  const stderr = pane.slice(pane.indexOf("fn engine_stderr()"), pane.indexOf("/// Electron binary 경로"));
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
      source.indexOf("function scrollSurfaceBy("));
    // A scrolled document root sits above the viewport, so visibility is the wrong
    // test — it is what dropped the surface.
    assert.doesNotMatch(surface, /visibleRect/, `${name} still gates the surface on visibility`);
    assert.match(surface, /scrollsAtAll\(scrollTarget\)/, `${name} does not check it still scrolls`);

    const targets = source.slice(source.indexOf("function scrollableTargets()"),
      source.indexOf("function scrollSurface()"));
    assert.match(targets, /page: true/, `${name} offers no page candidate`);
    assert.match(targets, /if \(scrollTarget\) targets\.unshift\(entry\)/,
      `${name} does not put the way out first`);
    assert.match(source, /scrollTarget = item\.page \? null : item\.element;/,
      `${name} does not release the surface when the page is picked`);
    // Escape is the other way out.
    assert.match(source, /if \(scrollSurface\(\)\) \{\n\s+scrollTarget = null;/,
      `${name} does not release the surface on Escape`);
    // The state is invisible without this: the indicator said nothing was picked.
    assert.match(source, /scrollSurface\(\) \? "⇅ 내부 · Esc" : ""/,
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
  // No caret to follow means no cursor on top of the page.
  assert.match(main, /caretCell = null;\n\s+try \{ writeSync\(1, CSI\("\?25l"\)\);/);
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
