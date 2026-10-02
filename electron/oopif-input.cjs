"use strict";

// Pointer events that reach an out-of-process iframe.
//
// WHY THIS EXISTS. `webContents.sendInputEvent` delivers into the widget of the frame tree's
// ROOT and nothing hit-tests past a process boundary from there. A cross-SITE iframe is a
// separate widget in a separate process — an OOPIF — so a click over one stops at the `<iframe>`
// element in the parent document, and the embedded page never learns a pointer touched it.
//
// Measured, in the pane, with a parent page and a child page on two local servers:
//
//   parent 127.0.0.1:8801 -> child 127.0.0.1:8802   same site (a port is not a site)
//     child sees pointerdown/mousedown/mouseup/click, target "b", isTrusted true
//
//   parent  localhost:8801 -> child 127.0.0.1:8802   cross-site, so an OOPIF
//     child sees NOTHING; the parent sees click at the iframe's centre with target "f",
//     the `<iframe>` element itself
//
// Same coordinates, same code path, same engine — only the site changed. That is the whole bug,
// and it is why an embedded app is dead to the mouse: Google Meet's add-on panel is
// `meet.whiteboard.sdix.io` inside `meet.google.com`, so every control in it, sign-in included,
// was unclickable.
//
// CDP's `Input.dispatchMouseEvent` is handled by the browser process's input router — but only
// for the session it is sent on. Sending on the ROOT session is not enough: measured, a click at
// the iframe's centre still arrived in the parent with `target` = the `<iframe>` element, and the
// child saw nothing. The OOPIF is its own CDP target, and the event has to be addressed to ITS
// session, which `Target.setAutoAttach({flatten: true})` hands out.
//
// And that session measures from its own viewport, not the top one. Sending the top-frame point
// to the child session put the click 30px/69px off — the iframe's own offset. Subtracting it is
// what finally delivered: the child reported the full pointerdown/mousedown/mouseup/click, and
// `window.open` inside its handler returned a live handle.
//
// It is NOT a blanket replacement for `sendInputEvent`: the debugger may be unavailable (devtools
// or an extension host owns it), and a CDP round trip is async where `sendInputEvent` is not. So
// the direct path stays as the fallback, and the root session still gets every event — a point
// over no subframe has to land in the main frame as it always did.

/**
 * Which attached child sessions a point falls inside, innermost last, with the point rewritten
 * into each one's own viewport.
 *
 * A session's `rect` is where that frame sits in the TOP frame's viewport, in CSS pixels — the
 * page reports it and the engine records it. Nesting is handled by the same subtraction applied
 * at each level, because each rect is already absolute.
 *
 * @param {Map<string, {rect?: {x: number, y: number, width: number, height: number}}>} sessions
 * @param {{x: number, y: number}} point In the top frame's viewport.
 * @returns {{sessionId: string, x: number, y: number}[]}
 */
function sessionsUnderPoint(sessions, point) {
  const hits = [];
  for (const [sessionId, info] of sessions) {
    const rect = info?.rect;
    // A frame whose box we have not been told about cannot be aimed at. Guessing its origin
    // would put the click somewhere arbitrary inside it, which is worse than not sending.
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) continue;
    if (point.x < rect.x || point.y < rect.y) continue;
    if (point.x > rect.x + rect.width || point.y > rect.y + rect.height) continue;
    hits.push({
      sessionId,
      x: Math.round(point.x - rect.x),
      y: Math.round(point.y - rect.y),
      area: rect.width * rect.height,
    });
  }
  // Smallest last: a frame nested inside another is the more specific target, and the ordering
  // makes "the innermost one" the final word without needing the frame tree itself.
  return hits.sort((a, b) => b.area - a.area).map(({ sessionId, x, y }) => ({ sessionId, x, y }));
}

/**
 * Where one pointer event should be delivered: a single frame's session, or the root.
 *
 * ONE target, never several. Sending to the root as well as to the frame under the point made the
 * root page see a click on the `<iframe>` element, which focuses the parent document and BLURS the
 * frame. Measured on the Google Meet whiteboard (Excalidraw): two `blur` events landed 5ms after
 * every pointerdown, and Excalidraw abandons the stroke in progress when its window loses focus —
 * `state.newElement` was empty on every move that followed, and each drag left a single dot, which
 * is the reported "dots instead of a line". A hardware mouse delivers to one frame; so does this.
 *
 * The innermost frame under the point, because that frame does its own hit-testing for everything
 * inside it, same-origin children included. Sending to an intermediate frame too would blur the
 * inner one the same way.
 *
 * And a drag stays with the frame it started in. Between a press and its release the frame that
 * took the press keeps receiving the moves and the release, even outside its box — that is the
 * implicit pointer capture a browser gives a pressed mouse, and without it a stroke dragged past
 * the edge of a panel would end in the page behind it with the button still down in the frame.
 *
 * @param {Map<string, {rect?: object}>} sessions attached frame sessions with their boxes
 * @param {{x: number, y: number}} point top-viewport CSS pixels
 * @param {string|null} captured the session holding the drag, or null
 * @returns {{sessionId: string, x: number, y: number}|null} null means the root
 */
function pointerTarget(sessions, point, captured) {
  if (captured) {
    const rect = sessions.get(captured)?.rect;
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)) {
      return { sessionId: captured, x: Math.round(point.x - rect.x), y: Math.round(point.y - rect.y) };
    }
  }
  const hits = sessionsUnderPoint(sessions, point);
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * The capture after an event: a press takes it for the target, a release gives it back.
 *
 * @param {string|null} captured the session holding the drag before this event
 * @param {string} type the CDP event type
 * @param {{sessionId: string}|null} target where the event went
 */
function nextCapture(captured, type, target) {
  if (type === "mousePressed") return target ? target.sessionId : null;
  if (type === "mouseReleased") return null;
  return captured;
}

/** CDP's button names, and the bitmask `buttons` it wants alongside them. */
const BUTTONS = {
  left: { name: "left", mask: 1 },
  right: { name: "right", mask: 2 },
  middle: { name: "middle", mask: 4 },
};

/** CDP modifier bits: alt 1, control 2, meta 4, shift 8. */
const MODIFIER_BITS = { alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, shift: 8 };

// CDP names the event types differently from `sendInputEvent`, and rejects the other spelling
// outright — measured: `Unexpected event type 'mouseMove'`, after which every pointer event fell
// back to the direct path and the OOPIF stayed unreachable. A silent-looking rename, but the
// whole fix rides on it.
const CDP_TYPES = {
  mouseMove: "mouseMoved",
  mouseDown: "mousePressed",
  mouseUp: "mouseReleased",
  mouseWheel: "mouseWheel",
};

function modifierMask(modifiers = []) {
  let mask = 0;
  for (const name of modifiers) mask |= MODIFIER_BITS[String(name).toLowerCase()] || 0;
  return mask;
}

/**
 * The `Input.dispatchMouseEvent` parameters for one pointer event.
 *
 * @param {object} event
 * @param {"mouseMove"|"mouseDown"|"mouseUp"|"mouseWheel"} event.type As `sendInputEvent` names
 *   it; CDP's own spelling is applied here, so callers speak one vocabulary.
 * @param {number} event.x CSS pixels in the top frame's viewport.
 * @param {number} event.y
 * @param {"left"|"middle"|"right"} [event.button] Absent means no button is involved.
 * @param {string[]} [event.modifiers] Keyboard modifiers, as `sendInputEvent` names them.
 * @param {number} [event.clickCount]
 * @param {boolean} [event.held] Whether `button` is currently down — what fills `buttons`, and
 *   therefore what a page reads as `MouseEvent.buttons` during a drag.
 * @param {number} [event.deltaX] Wheel only.
 * @param {number} [event.deltaY]
 * @returns {object|null} Null when the type has no CDP equivalent, so the caller sends it the
 *   direct way rather than emitting something the protocol will reject.
 */
function mouseEventParams(event) {
  const type = CDP_TYPES[event.type];
  if (!type) return null;
  const button = BUTTONS[event.button];
  const params = {
    type,
    x: event.x,
    y: event.y,
    modifiers: modifierMask(event.modifiers),
    // CDP names the absence of a button explicitly; omitting the field is not the same thing.
    button: button ? button.name : "none",
    // A move carries the mask of what is HELD, a press carries its own button, and a release
    // carries neither — by the time the page sees mouseup, that button is no longer down.
    buttons: event.held && button ? button.mask : 0,
    // What a real mouse reports while a button is down. CDP's `force` defaults to 0, and Chromium
    // carries it into `PointerEvent.pressure` as is — so every synthetic drag arrived pressed but
    // weightless. Measured on the Google Meet whiteboard (Excalidraw): every point of a drag had
    // `buttons: 1, pressure: 0`, and the pen, which sizes its stroke from pressure, drew a stroke
    // of width zero — only the starting dot showed, which is the "dots instead of a line" that
    // was reported. Pointer Events defines 0.5 for a pressed mouse and 0 for a released one, which
    // is exactly what a hardware mouse produces in the same browser.
    force: event.held && button ? 0.5 : 0,
  };
  if (event.type === "mouseWheel") {
    params.deltaX = event.deltaX || 0;
    params.deltaY = event.deltaY || 0;
  } else if (event.type === "mouseDown" || event.type === "mouseUp") {
    // Only a press or a release has a click count. A move with a button held down is part of a
    // drag, not a click, and giving it one would make each move read as a fresh press.
    params.clickCount = event.clickCount || 0;
  }
  return params;
}

module.exports = { mouseEventParams, modifierMask, sessionsUnderPoint, pointerTarget, nextCapture, CDP_TYPES, BUTTONS };
