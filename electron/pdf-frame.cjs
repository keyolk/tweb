"use strict";

// Driving Chromium's built-in PDF viewer from the main process.
//
// A PDF does not render in the page: Chromium loads a fixed extension into a child frame
// (`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html`) and that frame owns
// the toolbar, the sidebar and the scroll position. The preload never runs there, so every
// TWeb shortcut lands in a main frame whose body is empty and the viewer never moves.
//
// Measured on a live offscreen window (electron 43, 5-page PDF), each result read back as
// a `capturePage()` md5 before and after:
//
//   contents.sendInputEvent keyDown Down            bytes UNCHANGED
//   contents.sendInputEvent mouseWheel              bytes UNCHANGED
//   click inside the viewer, then keyDown Down      bytes UNCHANGED
//   setIgnoreMenuShortcuts(true) + focus() + key    bytes UNCHANGED
//   CDP Input.dispatchKeyEvent on the page session  bytes UNCHANGED
//   CDP the same on a flattened session attached
//     to the extension iframe target, before and
//     after focusing <pdf-viewer> through CDP       bytes UNCHANGED
//   CDP Input.dispatchMouseEvent mouseWheel there   bytes UNCHANGED
//   a synthetic KeyboardEvent dispatched inside
//     the frame, and viewport_.handleDirectionalKeyEvent
//     called directly (it returns true)             bytes UNCHANGED
//
// The window is `focusable: false` and never shown, so nothing in it holds keyboard focus
// and no input path that depends on focus can reach the viewer. What does work is calling
// the viewer's own API: `webFrameMain.executeJavaScript` runs in the extension frame, and
// `pdf-viewer.viewport_` exposes `setPosition`, `goToNextPage`, `goToPreviousPage` and
// `contentSize` — each of those moved the rendered bytes in the same harness.
//
// So scrolling and page navigation are driven here through that API. The viewer's own
// toolbar (its download and print buttons, its page box, its find) stays out of reach:
// those are shadow-DOM buttons that expect real clicks, and the click path is exactly what
// was measured dead above.

// Chromium's PDF viewer extension id is a fixed constant, so a PDF served with any URL or
// content type is recognised without sniffing either.
const PDF_EXTENSION_PREFIX = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";

// How far each key moves the viewport. `px` is a fixed CSS-pixel step, `viewport` is a
// multiple of the visible height — the same shape as the preload's `scrollSurfaceBy`, so
// `j` moves a PDF by what it moves a page by.
const LINE_STEP = 90;
const ARROW_STEP = 40;

// Below this the viewer's reported viewport is the collapsed offscreen surface of a pane
// nobody is watching, not a window a person could read a PDF in.
const COLLAPSED_VIEWPORT_LIMIT = 80;

/// The viewport operation a key press performs, or null when the key is not ours.
///
/// `state.pendingG` carries the half-typed `gg`, mirroring the preload's own pending-g so
/// the motion means the same thing in a PDF as on a page. Returned rather than mutated:
/// the caller stores it back, and the mapping stays a pure function.
///
/// Letters only act in vimium (browser-shortcut) mode. In passthrough mode a PDF gets the
/// navigation keys and nothing else, which is what Chrome does — `j` there types nothing.
function pdfKeyAction(key, modifiers = [], state = {}) {
  const vimium = Boolean(state.vimium);
  const pendingG = Boolean(state.pendingG);
  const shift = modifiers.includes("shift");
  // A modified key is a shortcut aimed at TWeb or the page, never a PDF motion. Shift is
  // the exception: Shift-Space is page-up everywhere.
  if (modifiers.some((modifier) => modifier === "control" || modifier === "meta" || modifier === "alt")) {
    return { action: null, pendingG: false };
  }

  const done = (action) => ({ action, pendingG: false });

  if (vimium && pendingG && key === "g") return done({ kind: "to", where: "start" });

  switch (key) {
    case "ArrowDown": return done({ kind: "by", dx: 0, dy: ARROW_STEP, unit: "px" });
    case "ArrowUp": return done({ kind: "by", dx: 0, dy: -ARROW_STEP, unit: "px" });
    case "ArrowRight": return done({ kind: "by", dx: ARROW_STEP, dy: 0, unit: "px" });
    case "ArrowLeft": return done({ kind: "by", dx: -ARROW_STEP, dy: 0, unit: "px" });
    case "PageDown": return done({ kind: "by", dx: 0, dy: 1, unit: "viewport" });
    case "PageUp": return done({ kind: "by", dx: 0, dy: -1, unit: "viewport" });
    case "Home": return done({ kind: "to", where: "start" });
    case "End": return done({ kind: "to", where: "end" });
    // Space is spelled by name on the agent path and as a literal on the real key path.
    case " ":
    case "Space":
      return done({ kind: "by", dx: 0, dy: shift ? -1 : 1, unit: "viewport" });
    default: break;
  }

  if (!vimium) return { action: null, pendingG: false };

  switch (key) {
    case "j": return done({ kind: "by", dx: 0, dy: LINE_STEP, unit: "px" });
    case "k": return done({ kind: "by", dx: 0, dy: -LINE_STEP, unit: "px" });
    case "h": return done({ kind: "by", dx: -LINE_STEP, dy: 0, unit: "px" });
    case "l": return done({ kind: "by", dx: LINE_STEP, dy: 0, unit: "px" });
    case "d": return done({ kind: "by", dx: 0, dy: 0.5, unit: "viewport" });
    case "u": return done({ kind: "by", dx: 0, dy: -0.5, unit: "viewport" });
    case "n": return done({ kind: "page", delta: 1 });
    case "p": return done({ kind: "page", delta: -1 });
    case "G": return done({ kind: "to", where: "end" });
    case "g": return { action: null, pendingG: true };
    default: return { action: null, pendingG: false };
  }
}

/// The script that performs one operation inside the PDF extension frame.
///
/// `fallbackHeight` is the pane's own logical height, used only when the viewer reports a
/// viewport too short to be real. A pane nobody is looking at has its offscreen surface
/// collapsed to one pixel, and measured through that state a PageDown moved the document
/// by 1px while the same key on a held surface moved it by 229 — the sort of key that
/// works when watched and not otherwise. The step is the pane's height either way.
///
/// Every branch checks the viewer is still what this expects and answers `{ok: false}`
/// rather than throwing, so a future Chromium that renames `viewport_` degrades to the
/// caller's existing key path instead of losing the keystroke to an exception.
function pdfViewportScript(action, fallbackHeight = 0) {
  let body;
  if (!action) return null;
  if (action.kind === "by") {
    const height = `(vp.size.height > ${COLLAPSED_VIEWPORT_LIMIT}`
      + ` ? vp.size.height : ${Math.max(0, Math.round(fallbackHeight))})`;
    const dx = action.unit === "viewport" ? `${action.dx} * vp.size.width` : `${action.dx}`;
    const dy = action.unit === "viewport" ? `${action.dy} * ${height}` : `${action.dy}`;
    body = `const p = vp.position;`
      + ` vp.setPosition({ x: p.x + (${dx}), y: p.y + (${dy}) });`;
  } else if (action.kind === "to") {
    body = action.where === "start"
      ? `vp.setPosition({ x: 0, y: 0 });`
      // contentSize is the whole document; setPosition clamps, so this lands on the last page.
      : `vp.setPosition({ x: vp.position.x, y: vp.contentSize.height });`;
  } else if (action.kind === "page") {
    body = action.delta > 0 ? `vp.goToNextPage();` : `vp.goToPreviousPage();`;
  } else {
    return null;
  }
  return `(() => {`
    + ` const viewer = document.querySelector('pdf-viewer');`
    + ` const vp = viewer && viewer.viewport_;`
    + ` if (!vp || typeof vp.setPosition !== 'function') return { ok: false, reason: 'no pdf viewport' };`
    + ` ${body}`
    + ` return { ok: true, position: vp.position, page: viewer.pageNo_ };`
    + ` })()`;
}

/// The PDF extension frame of a tab, or null when the tab is not showing a PDF.
///
/// Only a viewer whose parent is the main frame counts. A PDF embedded in an ordinary page
/// is a widget inside someone else's document, and stealing `j` from that page to scroll
/// the embed would be a regression, not a fix.
function findPdfFrame(mainFrame) {
  if (!mainFrame) return null;
  let frames;
  try {
    frames = mainFrame.framesInSubtree || [];
  } catch (error) {
    return null;
  }
  for (const frame of frames) {
    if (!frame || frame === mainFrame) continue;
    let url;
    try {
      if (frame.isDestroyed && frame.isDestroyed()) continue;
      if (frame.detached) continue;
      url = frame.url || "";
      if (!url.startsWith(PDF_EXTENSION_PREFIX)) continue;
      if (frame.parent !== mainFrame) continue;
    } catch (error) {
      continue;
    }
    return frame;
  }
  return null;
}

module.exports = {
  PDF_EXTENSION_PREFIX,
  LINE_STEP,
  ARROW_STEP,
  COLLAPSED_VIEWPORT_LIMIT,
  pdfKeyAction,
  pdfViewportScript,
  findPdfFrame,
};
