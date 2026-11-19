"use strict";

// What an engine does differently from Electron, asked by name instead of by engine.
//
// main.cjs drives every tab through one `webContents` shape: Electron's own, or the Chrome
// (cdp/web-contents.cjs) and WebKit (webkit/web-contents.cjs) objects that imitate it. Where the
// engines really differ, main.cjs used to ask `tabEngine(tab) === "chrome"`, and a fix written for
// one engine then ran on another it was never meant for: Electron's frame box routing ran on Chrome
// and sent the claude.ai share menu's clicks into the iframe under it (#278).
//
// So a difference is a capability here, and an engine opts in from its own contents constructor
// (`this.capabilities = { ... }`). Electron declares nothing: every capability is off there, which
// makes Electron the baseline and each name a statement about how another engine departs from it.
// A new engine reads this list, sets what applies, and main.cjs needs no change.
//
// `engine-capabilities.test.cjs` checks that every declared name is listed here and that main.cjs
// compares no engine names outside the places that pick an engine.
const CAPABILITIES = Object.freeze({
  // A pointer event sent to the root session reaches whatever is drawn at the point, inside
  // out-of-process frames too, so the pointer router sends everything to the root. Electron's root
  // does not forward into an out-of-process frame, so main.cjs routes by the frame's box there.
  hitTestsFrames: "boolean",
  // A background tab of a visible pane keeps its full size while it paints nothing, and keeps its
  // last frame: undoing a collapse costs this engine a metrics override, a window resize and a
  // relayout before the first capture (see `surfacePlan`).
  keepsSizeInStandby: "boolean",
  // `focusedFrame` is always the main frame (the engine cannot say which frame has focus), so the
  // terminal caret follows the frame that last reported one instead.
  focusedFrameIsMainOnly: "boolean",
  // `executeJavaScript` rejects with the page's own exception, so `tweb eval` needs no debugger to
  // report it. Electron's answers only "Script failed to execute".
  reportsScriptExceptions: "boolean",
  // `sendInputEvent` key events carry their editing commands (select all, delete word), so edit mode
  // sends keys the native way instead of through a debugger.
  keyEventsRunEditCommands: "boolean",
  // The browser refuses a permission prompt itself, so a site's remembered decisions are granted
  // through the browser before the page asks, and take effect on the next load.
  grantsPermissionsAhead: "boolean",
  // The engine cannot sign in to Google, and replaces Google's refusal page with what to do instead.
  blocksGoogleSignIn: "boolean",
  // The name of the inspector `tweb devtools` opens beside the pane; none on an engine that has no
  // inspector of its own outside the page.
  inspectorName: "string",
});

const DEFAULTS = Object.freeze({ boolean: false, string: null });

/**
 * The value of capability `name` for `contents`: what the engine declared, or the Electron
 * baseline (off) when it declared nothing. An unknown name throws, so a typo cannot read as "off".
 */
function capability(contents, name) {
  const type = CAPABILITIES[name];
  if (!type) throw new Error(`unknown engine capability: ${name}`);
  const declared = contents?.capabilities?.[name];
  return declared === undefined ? DEFAULTS[type] : declared;
}

/** Freezes an engine's declaration after checking each name and type against the list. */
function declareCapabilities(declared) {
  for (const [name, value] of Object.entries(declared)) {
    const type = CAPABILITIES[name];
    if (!type) throw new Error(`unknown engine capability: ${name}`);
    if (typeof value !== type) throw new Error(`engine capability ${name} must be a ${type}`);
  }
  return Object.freeze({ ...declared });
}

module.exports = { CAPABILITIES, capability, declareCapabilities };
