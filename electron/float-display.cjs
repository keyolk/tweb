"use strict";

// The pure half of floating mode: what a display window should be, and how a click in it
// maps back onto the page.
//
// WHY a display window relays frames rather than simply showing the tab's own window.
// Floating started as `tab.show()` on the offscreen BrowserWindow, and the window came up
// reading "No content under offscreen mode". That is not a bug to work around — it is
// Chromium telling us that a webContents composites EITHER into an offscreen `paint`
// stream OR onto a native surface, never both. Measured on Electron 43.2.0, three ways in:
//
//   `tab.show()` on the offscreen window     paints keep flowing (24/1.2s), native
//                                            surface says "No content under offscreen mode"
//   `new WebContentsView({ webContents })`    throws: "options.webContents is already
//     (the adoption the design asked for)     attached to a window"
//   offscreen WebContentsView in a shown      same placeholder; the view presents nothing
//     window, or a normal view inside an      the other way round either: host paints=0,
//     offscreen host window                   the host's frames carry only its own body
//
// So the page's pixels can only leave through the channel it already uses — the `paint`
// event that feeds Kitty graphics. Floating therefore takes a second consumer of that same
// stream: the frames are encoded once more as JPEG and drawn on a canvas in an ordinary
// visible window, and that window's input is forwarded back with `sendInputEvent`. The tab
// itself never becomes visible, which is what keeps the frames coming at all.
//
// The consequence worth stating plainly: this is a view toggle, not a session toggle. The
// same webContents keeps the page, the history and the scroll position, so floating and
// pinning cost nothing but the window.

// JPEG rather than PNG for the relay. The pane's own path already encodes PNG (or raw
// pixels) for Kitty; encoding a *second* PNG for the viewer measured 3ms per frame at
// 700x500 dsf2, and a full-screen page costs several times that — at 30fps that is main-
// thread time the keyboard is waiting for. JPEG at this quality is visually clean on text
// and decodes in the viewer through `createImageBitmap` off the main thread.
const RELAY_JPEG_QUALITY = 80;

/// The BrowserWindow options for a tab's display window.
///
/// Everything the offscreen window turns off, this turns back on: it is an ordinary
/// desktop window the user can move, resize and focus. It hosts the viewer document, not
/// the page, so it takes no preload of the browser's own and no offscreen block.
function displayWindowOptions(bounds, preloadPath) {
  return {
    ...bounds,
    useContentSize: true,
    show: false,
    frame: true,
    resizable: true,
    movable: true,
    focusable: true,
    // The viewer is chrome for a page the user is actively looking at, and Chromium
    // throttles an unfocused window's timers and rAF. That throttle ate the resize the
    // viewer reports back: measured by resizing the window twice while the terminal held
    // focus, only the first `resize` event reached the main process and the page stayed
    // laid out at the old size until something else woke the renderer. The relay is driven
    // by the page's paints, not by the viewer's clock, so nothing here spins when idle.
    webPreferences: {
      preload: preloadPath,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  };
}

/// Where a floating window opens: centred on the display the pane's window sits on, at the
/// pane's current size. The user moves it from there; nothing re-centres it afterwards.
function centeredDisplayBounds(displayBounds, width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return {
    x: Math.round(displayBounds.x + (displayBounds.width - w) / 2),
    y: Math.round(displayBounds.y + (displayBounds.height - h) / 2),
    width: w,
    height: h,
  };
}

/// Maps a point on the viewer's canvas to a point in the page.
///
/// Three coordinate spaces meet here and getting it wrong is silent — the click lands
/// somewhere else on the page rather than failing. The canvas is sized in *rendered* pixels
/// (the frame's own size, page size x deviceScaleFactor), it is laid out at whatever CSS
/// size the window happens to be, and `sendInputEvent` wants DIPs. So the click is taken as
/// a fraction of the laid-out element and re-applied to the page's logical size, which
/// makes a resized display window keep aiming true.
///
/// Measured while probing: forwarding the canvas coordinate unscaled put a click at 50,60
/// onto the page at 50,60 device pixels — half the intended distance down the document.
function canvasPointToPage(point, layout, page) {
  const layoutWidth = Math.max(1, layout.width);
  const layoutHeight = Math.max(1, layout.height);
  const x = Math.round(((point.x - (layout.left || 0)) / layoutWidth) * page.width);
  const y = Math.round(((point.y - (layout.top || 0)) / layoutHeight) * page.height);
  return {
    x: Math.min(Math.max(0, x), Math.max(0, page.width - 1)),
    y: Math.min(Math.max(0, y), Math.max(0, page.height - 1)),
  };
}

/// The `sendInputEvent` calls one relayed viewer event becomes.
///
/// Returned as data rather than sent here so the mapping is testable without an Electron
/// window. A click is three events because Chromium wants the pointer moved to where the
/// press happens — a bare `mouseDown` at a new position lands on whatever the page thought
/// was hovered.
function relayInputEvents(kind, data = {}) {
  if (kind === "mouse") {
    const { x, y, button = "left", clickCount = 1, modifiers = [] } = data;
    return [
      { type: "mouseMove", x, y, modifiers },
      { type: "mouseDown", x, y, button, clickCount, modifiers },
      { type: "mouseUp", x, y, button, clickCount, modifiers },
    ];
  }
  if (kind === "move") {
    return [{ type: "mouseMove", x: data.x, y: data.y, modifiers: data.modifiers || [] }];
  }
  if (kind === "wheel") {
    // The viewer reports the wheel the way the DOM does (positive deltaY scrolls down);
    // sendInputEvent takes the scroll offset, whose sign is the other way round.
    return [{
      type: "mouseWheel",
      x: data.x,
      y: data.y,
      deltaX: -(data.deltaX || 0),
      deltaY: -(data.deltaY || 0),
      canScroll: true,
      modifiers: data.modifiers || [],
    }];
  }
  if (kind === "key") {
    const key = String(data.key || "");
    if (!key) return [];
    // `char` is what puts a printable key into a text field; a bare keyDown/keyUp pair
    // moves focus and fires shortcuts but types nothing. Non-printable keys (arrows,
    // Escape) must NOT get one — Chromium would insert the name as literal text.
    const printable = key.length === 1;
    const modifiers = data.modifiers || [];
    const events = [{ type: "keyDown", keyCode: key, modifiers }];
    if (printable) events.push({ type: "char", keyCode: key, modifiers });
    events.push({ type: "keyUp", keyCode: key, modifiers });
    return events;
  }
  return [];
}

module.exports = {
  RELAY_JPEG_QUALITY,
  displayWindowOptions,
  centeredDisplayBounds,
  canvasPointToPage,
  relayInputEvents,
};
