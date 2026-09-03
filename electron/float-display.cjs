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
// thread time the keyboard is waiting for. JPEG decodes in the viewer through
// `createImageBitmap` off the main thread.
//
// The quality was 80, which was never measured — it was the number that came with the
// choice of JPEG over PNG. Measured on Electron 43.2.0, a 2800x1800 frame (a typical float
// window at dsf2), encode time against quality:
//
//   q80  26.6ms  2.00MB      q92  29.6ms  2.91MB
//   q88  28.2ms  2.53MB      q95  27.6ms  3.41MB
//
// Encode time is dominated by pixel count and barely responds to quality at all — 80 to 92
// is +11%, inside the run-to-run noise. What it buys is measurable, on 1200x720 of
// antialiased black-on-white text against the source bitmap:
//
//   q80  MAE 3.70  max error 26  14.1% of pixels off by more than 8  PSNR 33.1dB
//   q92  MAE 1.52  max error 10   0.3% of pixels off by more than 8  PSNR 40.7dB
//
// q80 is inside the range where ringing around text strokes is visible. And unlike the
// Kitty path, these bytes never reach a disk or a terminal — the relay is IPC inside one
// process — so the byte growth costs nothing the pane's own budget cares about.
const RELAY_JPEG_QUALITY = 92;

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
    fullscreenable: true,
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

/// The ANSI to draw a one-line status centred in a pane of `cols` x `rows` cells.
///
/// The pane shows bare terminal while a tab floats — the page is in an OS window — so this line
/// is the only thing telling the user where their page went and how to get it back. It was
/// written at a hardcoded `\x1b[12;1H`: row 12 whatever the pane's height, column 1 whatever
/// its width, which put it against the left edge and above centre on anything but one exact
/// size.
///
/// Centred by cell count rather than by pixels, because that is the unit the cursor address
/// takes. The label is plain ASCII in both callers, so `length` is its cell width; a label with
/// wide characters in it would need a width function, and there is none here to mislead a
/// later reader into thinking one exists.
///
/// Clamped to 1 on both axes. A pane one cell wide is not worth a special case, but an address
/// of `0` or a negative column is one the terminal is entitled to reject outright, and a
/// status line that silently does not appear is worse than one slightly off centre.
function centeredStatusSequence(label, cols, rows, escape = "\x1b") {
  const text = String(label ?? "");
  const width = Math.max(1, Math.round(cols) || 1);
  const height = Math.max(1, Math.round(rows) || 1);
  const row = Math.max(1, Math.ceil(height / 2));
  // `(width - text.length) / 2 + 1` in cell terms: floor, so a label that cannot be centred
  // exactly sits one cell left rather than one right — the same bias a terminal's own
  // wrapping has, and it keeps a label wider than the pane starting at column 1 instead of
  // off screen to the left.
  const column = Math.max(1, Math.floor((width - text.length) / 2) + 1);
  // Clear, address, then bold cyan and a reset. The clear is what removes the frame the pane
  // was showing; see the caller for why the Kitty placement has to go first.
  return `${escape}[2J${escape}[${row};${column}H${escape}[1m${escape}[36m${text}${escape}[0m`;
}

/// How much to shrink a fullscreen float's surface so its frame matches the monitor.
///
/// An offscreen window's `deviceScaleFactor` is fixed when the window is constructed, from the
/// PRIMARY display, and there is no runtime setter — verified under Electron 43.2.0:
/// `setDeviceScaleFactor` is undefined on both webContents and BrowserWindow. Fullscreen float
/// deliberately opens on a DIFFERENT monitor so the terminal stays visible, and that monitor
/// need not share the primary's scale. Measured here: primary 1728x1117 @2x, external 2560x1440
/// @1x, so asking for 2560x1440 DIPs rendered 5120x2880 — four times the pixels the monitor can
/// show, all of them discarded by the viewer's canvas, and enough to set the ceiling on its own
/// (q92: 87.4ms/8.51MB at 5120x2880 against ~20ms/2.13MB at 2560x1440).
///
/// Below 1 only when the target is coarser than the surface. A monitor at or above the window's
/// own scale gets 1 — shrinking there would throw away pixels the user can actually see.
function fullscreenSurfaceScale(targetScaleFactor, surfaceScaleFactor) {
  const target = Number(targetScaleFactor) || 0;
  const surface = Number(surfaceScaleFactor) || 0;
  if (!(target > 0) || !(surface > 0) || target >= surface) return 1;
  return target / surface;
}

/// The DIPs a surface laid out at `logical` CSS pixels is asked for under `scale`.
///
/// Rounded to even numbers so the fixed dsf produces a whole-pixel frame; an odd DIP count at
/// dsf2 lands the frame half a pixel off the monitor's, which the viewer then resamples for
/// nothing. The zoom that keeps the layout unchanged is `scale` applied to the user's own
/// factor — the two are always set together, since the resize alone would lay the page out at a
/// fraction of the monitor and the zoom alone would render the same pixels at a different size.
function scaledSurfaceSize(logical, scale) {
  if (!(scale > 0) || scale === 1) {
    return { width: Math.max(1, Math.round(logical.width)), height: Math.max(1, Math.round(logical.height)) };
  }
  return {
    width: Math.max(2, Math.round((logical.width * scale) / 2) * 2),
    height: Math.max(2, Math.round((logical.height * scale) / 2) * 2),
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
  centeredStatusSequence,
  fullscreenSurfaceScale,
  scaledSurfaceSize,
  displayWindowOptions,
  centeredDisplayBounds,
  canvasPointToPage,
  relayInputEvents,
};
