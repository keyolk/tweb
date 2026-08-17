"use strict";

// Which Chrome extensions can actually function in this browser, decided from the manifest
// before anything is loaded.
//
// The measurements this encodes (task-1-extensions.md) are the whole reason the file exists.
// Electron 43 gives an extension a SUBSET of Chrome's API surface, and the missing pieces are
// not cosmetic:
//
//   - `chrome.webRequest` does not exist. An MV2 blocker built on webRequestBlocking —
//     uBlock Origin 1.68.0 is the archetype — loads cleanly, reports healthy, and blocks
//     nothing. Measured: server hit counts identical to no extension at all.
//   - `chrome.action` does not exist. So a toolbar-popup extension has no surface to draw in
//     a tmux pane AND no API to open one. Popup-only is dead twice over.
//   - `declarativeNetRequest` DOES work, and content scripts DO run. Those two classes are
//     real, and measured blocking a real page.
//
// The reason this is a refusal and not a warning: this project has twice chosen to withhold
// rather than half-ship, because a feature that fails at the moment of USE is worse than one
// honestly absent — the user finds out mid-task having already committed. An ad blocker that
// loads and silently blocks nothing is the purest form of that failure: the user browses
// believing they are protected. So a manifest that cannot work here is refused with the
// reason, at install time, and never sits inert in a list.
//
// Everything here is pure: manifest object in, verdict out. The engine owns loadExtension.

// Namespaces an extension may reach for that Electron 43 does not implement. Measured from
// inside an extension's own service worker rather than read from documentation, because the
// documentation describes Chrome. `chrome` topLevelKeys under Electron 43.2.0 were exactly:
// alarms, declarativeNetRequest, extension, i18n, management, offscreen, runtime, scripting,
// storage, tabs.
const MISSING_APIS = Object.freeze([
  "webRequest",
  "webRequestBlocking",
  "permissions",
  "webNavigation",
  "action",
  "browserAction",
  "pageAction",
  "contextMenus",
  "cookies",
  "downloads",
  "userScripts",
  "idle",
  "commands",
  "notifications",
  "nativeMessaging",
  "identity",
  "enterprise.deviceAttributes",
  "browsingData",
  "privacy",
  "dns",
  "declarativeContent",
  "proxy",
  "tabCapture",
  "desktopCapture",
  "debugger",
  "devtools",
]);

// A permission that only gates a missing API is a signal, not a defect on its own: an
// extension can declare `cookies` and never touch it. Only permissions whose ABSENCE breaks
// the extension's core purpose are fatal, and there is exactly one that is provably so.
const FATAL_PERMISSIONS = Object.freeze(["webRequestBlocking"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * The popup an extension declares, or null. MV3 puts it under `action`, MV2 under
 * `browser_action` or `page_action`.
 */
function declaredPopup(manifest) {
  const action = manifest.action || manifest.browser_action || manifest.page_action;
  if (!action || typeof action !== "object") return null;
  const popup = action.default_popup;
  return typeof popup === "string" && popup !== "" ? popup : null;
}

/**
 * Whether the extension does anything at all that does not require the missing surface.
 *
 * The three capabilities measured to work: declarativeNetRequest rules, content scripts, and
 * `scripting`-based injection from a background worker. An extension with none of them and a
 * popup has nothing left to do here.
 */
function workingCapabilities(manifest) {
  const capabilities = [];
  const permissions = asArray(manifest.permissions).map(String);
  const rulesets = asArray(manifest.declarative_net_request?.rule_resources);
  if (rulesets.length > 0 || permissions.includes("declarativeNetRequest")) {
    capabilities.push("declarativeNetRequest");
  }
  if (asArray(manifest.content_scripts).length > 0) capabilities.push("contentScripts");
  if (permissions.includes("scripting")) capabilities.push("scripting");
  return capabilities;
}

/**
 * Which of the missing APIs this manifest actually asks for.
 *
 * Both `permissions` and `optional_permissions` are read: an optional permission still tells
 * us what the extension will reach for, and there is no user to grant it here.
 */
function missingApisRequested(manifest) {
  const requested = new Set([
    ...asArray(manifest.permissions).map(String),
    ...asArray(manifest.optional_permissions).map(String),
  ]);
  const missing = MISSING_APIS.filter((api) => requested.has(api));
  if (manifest.action && !missing.includes("action")) missing.push("action");
  if (manifest.browser_action && !missing.includes("browserAction")) missing.push("browserAction");
  if (manifest.page_action && !missing.includes("pageAction")) missing.push("pageAction");
  return missing;
}

function isUblockOriginLiteManifest(manifest) {
  return manifest?.manifest_version === 3
    && manifest?.short_name === "uBO Lite"
    && manifest?.author === "Raymond Hill"
    && manifest?.background?.type === "module";
}

/**
 * Classify a parsed manifest.
 *
 * Returns `{ supported, reasons, capabilities, missingApis, manifestVersion, name, popupOnly }`.
 * `reasons` is non-empty exactly when `supported` is false, and each entry is written to be
 * shown to a person as-is — the user has to understand why their extension was refused.
 */
function classifyManifest(manifest) {
  const verdict = {
    supported: false,
    reasons: [],
    capabilities: [],
    missingApis: [],
    manifestVersion: null,
    name: "",
    popupOnly: false,
  };

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    verdict.reasons.push("manifest.json is not a JSON object");
    return verdict;
  }

  verdict.name = typeof manifest.name === "string" ? manifest.name : "";
  const version = manifest.manifest_version;
  verdict.manifestVersion = Number.isInteger(version) ? version : null;
  verdict.missingApis = missingApisRequested(manifest);
  verdict.capabilities = workingCapabilities(manifest);

  if (verdict.manifestVersion === null) {
    verdict.reasons.push("manifest_version is missing or not an integer");
    return verdict;
  }

  // MV2 is not refused merely for being old. Measured, a content-script-only MV2
  // extension injects and changes the DOM in an offscreen Electron 43 window. What is
  // impossible is MV2's request-blocking model: chrome.webRequest is not exposed to
  // extensions at all, so uBlock Origin loads cleanly and blocks nothing. The ordinary
  // missing-API check below refuses that manifest with the true, specific reason.
  if (verdict.manifestVersion !== 2 && verdict.manifestVersion !== 3) {
    verdict.reasons.push(`manifest_version ${verdict.manifestVersion} is not supported`);
    return verdict;
  }

  const ubol = isUblockOriginLiteManifest(manifest);
  const unsupported = verdict.missingApis.filter(
    (api) => !(["action", "userScripts"].includes(api) && ubol),
  );
  for (const api of unsupported) {
    verdict.reasons.push(`requires ${api}, which Electron does not implement for extensions`);
  }

  if (verdict.capabilities.includes("declarativeNetRequest") && !ubol) {
    verdict.reasons.push(
      "generic declarativeNetRequest extensions are not supported: Electron ignores manifest"
      + " ruleset enablement, and only the measured uBO Lite adapter is known to arm its rules",
    );
  }
  if (
    verdict.capabilities.includes("scripting")
    && !verdict.capabilities.includes("contentScripts")
    && !ubol
  ) {
    verdict.reasons.push(
      "scripting-only extensions are not supported: dynamic injection was not measured as a"
      + " complete extension class",
    );
  }

  const fatal = asArray(manifest.permissions)
    .map(String)
    .filter((permission) => FATAL_PERMISSIONS.includes(permission));
  for (const permission of fatal) {
    verdict.reasons.push(`requires ${permission}, which Electron does not implement`);
  }

  // A popup is the extension's entire interface and there is no toolbar in a tmux pane to
  // click. Refusing it is not about the missing pixels — `chrome.action` does not exist
  // either, so there is no API through which anything could open it.
  const popup = declaredPopup(manifest);
  verdict.popupOnly = popup !== null && verdict.capabilities.length === 0;
  if (verdict.popupOnly) {
    verdict.reasons.push(
      `its whole interface is the toolbar popup ${popup}: a terminal pane has no toolbar,`
      + " and chrome.action does not exist here to open one",
    );
  }

  if (verdict.capabilities.length === 0 && !verdict.popupOnly) {
    verdict.reasons.push(
      "declares no capability that works here (needs declarativeNetRequest rules, content"
      + " scripts, or scripting)",
    );
  }

  verdict.supported = verdict.reasons.length === 0;
  return verdict;
}

/**
 * One line describing a verdict, for the engine log and for the user.
 */
function describeVerdict(verdict) {
  const label = verdict.name || "extension";
  if (verdict.supported) {
    const extras = verdict.missingApis.length > 0
      ? ` (degraded: no ${verdict.missingApis.join(", ")})`
      : "";
    return `${label}: loaded — ${verdict.capabilities.join(", ")}${extras}`;
  }
  return `${label}: refused — ${verdict.reasons.join("; ")}`;
}

module.exports = {
  MISSING_APIS,
  classifyManifest,
  declaredPopup,
  describeVerdict,
  missingApisRequested,
  workingCapabilities,
};
