"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MISSING_APIS,
  classifyManifest,
  declaredPopup,
  describeVerdict,
  missingApisRequested,
  workingCapabilities,
} = require("./extension-policy.cjs");

// The manifests of the two real extensions this policy was measured against, reduced to the
// fields the classifier reads. Keeping them here means a future Electron that gains
// chrome.webRequest can be checked against the same shapes that were actually driven.
const UBLOCK_ORIGIN_MV2 = {
  manifest_version: 2,
  name: "uBlock Origin",
  version: "1.68.0",
  permissions: [
    "alarms", "contextMenus", "privacy", "storage", "tabs", "unlimitedStorage",
    "webNavigation", "webRequest", "webRequestBlocking", "<all_urls>",
  ],
  background: { page: "background.html" },
  content_scripts: [{ js: ["/js/contentscript.js"] }],
};

const UBLOCK_ORIGIN_LITE_MV3 = {
  manifest_version: 3,
  name: "__MSG_extName__",
  short_name: "uBO Lite",
  author: "Raymond Hill",
  version: "2026.812.1211",
  permissions: [
    "activeTab", "alarms", "declarativeNetRequest", "offscreen", "scripting", "storage",
    "unlimitedStorage", "userScripts",
  ],
  action: { default_popup: "popup.html" },
  background: { service_worker: "/js/background.js", type: "module" },
  declarative_net_request: {
    rule_resources: [{ id: "ublock-filters", enabled: true, path: "/rulesets/main/ublock-filters.json" }],
  },
};

// Endpoint Verification, from the owner's real Chrome profile: MV3, a popup, and nothing else.
const POPUP_ONLY_MV3 = {
  manifest_version: 3,
  name: "Endpoint Verification",
  permissions: ["cookies", "idle", "nativeMessaging", "storage", "alarms"],
  action: { default_popup: "popup.html" },
  background: { service_worker: "sw.js" },
};

test("MV2 request blockers are refused because chrome.webRequest does not exist", () => {
  const verdict = classifyManifest(UBLOCK_ORIGIN_MV2);
  assert.equal(verdict.supported, false);
  assert.equal(verdict.manifestVersion, 2);
  assert.match(verdict.reasons.join(" "), /requires webRequest/);
  assert.match(verdict.reasons.join(" "), /does not implement/);
});

test("MV2 content scripts are allowed because they work offscreen", () => {
  // Measured in Electron 43: this exact shape injected into an offscreen page, changed its
  // title to MV2-CONTENT-RAN and set a DOM marker. Refusing it merely because MV2 is old
  // turns a specific webRequest absence into a false blanket claim.
  const verdict = classifyManifest({
    manifest_version: 2,
    name: "mv2 content only",
    content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }],
  });
  assert.equal(verdict.supported, true, describeVerdict(verdict));
  assert.deepEqual(verdict.capabilities, ["contentScripts"]);
});

test("uBlock Origin Lite is supported: DNR rules are a capability that works", () => {
  const verdict = classifyManifest(UBLOCK_ORIGIN_LITE_MV3);
  assert.equal(verdict.supported, true, describeVerdict(verdict));
  assert.deepEqual(verdict.reasons, []);
  assert.ok(verdict.capabilities.includes("declarativeNetRequest"));
  assert.ok(verdict.capabilities.includes("scripting"));
  // It declares a popup that cannot be opened here, but that does not make it useless: the
  // blocking is the point and the blocking was measured working.
  assert.equal(verdict.popupOnly, false);
});

test("uBlock Origin Lite is reported as degraded, naming the APIs it will not get", () => {
  const verdict = classifyManifest(UBLOCK_ORIGIN_LITE_MV3);
  assert.deepEqual(verdict.missingApis, ["userScripts", "action"]);
  assert.match(describeVerdict(verdict), /degraded: no userScripts, action/);
});

test("a popup-only extension is refused with the toolbar reason", () => {
  const verdict = classifyManifest(POPUP_ONLY_MV3);
  assert.equal(verdict.supported, false);
  assert.equal(verdict.popupOnly, true);
  assert.match(verdict.reasons.join(" "), /toolbar popup popup\.html/);
  assert.match(verdict.reasons.join(" "), /chrome\.action does not exist/);
});

test("generic DNR extensions are refused because manifest rulesets start disabled here", () => {
  const verdict = classifyManifest({
    manifest_version: 3,
    name: "generic blocker",
    permissions: ["declarativeNetRequest"],
    declarative_net_request: {
      rule_resources: [{ id: "rules", enabled: true, path: "rules.json" }],
    },
  });
  assert.equal(verdict.supported, false);
  assert.match(verdict.reasons.join(" "), /generic declarativeNetRequest extensions are not supported/);
});

test("scripting-only extensions are refused as an unmeasured class", () => {
  const verdict = classifyManifest({
    manifest_version: 3,
    name: "dynamic injector",
    permissions: ["scripting"],
    background: { service_worker: "sw.js" },
  });
  assert.equal(verdict.supported, false);
  assert.match(verdict.reasons.join(" "), /scripting-only extensions are not supported/);
});

test("an MV3 extension with only content scripts is supported", () => {
  const verdict = classifyManifest({
    manifest_version: 3,
    name: "dom tweaker",
    content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }],
  });
  assert.equal(verdict.supported, true, describeVerdict(verdict));
  assert.deepEqual(verdict.capabilities, ["contentScripts"]);
});

test("an MV3 extension with no working capability and no popup is refused", () => {
  const verdict = classifyManifest({
    manifest_version: 3,
    name: "nothing useful",
    permissions: ["storage", "alarms"],
    background: { service_worker: "sw.js" },
  });
  assert.equal(verdict.supported, false);
  assert.equal(verdict.popupOnly, false);
  assert.match(verdict.reasons.join(" "), /declares no capability that works here/);
});

test("webRequestBlocking is fatal even if an MV3 manifest somehow declares it", () => {
  const verdict = classifyManifest({
    manifest_version: 3,
    name: "confused",
    permissions: ["webRequestBlocking", "declarativeNetRequest"],
  });
  assert.equal(verdict.supported, false);
  assert.match(verdict.reasons.join(" "), /requires webRequestBlocking/);
});

test("measured-absent idle and nativeMessaging APIs are refused", () => {
  const verdict = classifyManifest({
    manifest_version: 3,
    name: "endpoint agent",
    permissions: ["idle", "nativeMessaging"],
    content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }],
  });
  assert.equal(verdict.supported, false);
  assert.match(verdict.reasons.join(" "), /requires idle/);
  assert.match(verdict.reasons.join(" "), /requires nativeMessaging/);
});

test("a malformed manifest is refused rather than throwing", () => {
  for (const bad of [null, undefined, 42, "manifest", [], { name: "no version" }]) {
    const verdict = classifyManifest(bad);
    assert.equal(verdict.supported, false);
    assert.ok(verdict.reasons.length > 0);
  }
});

test("a content script does not rescue an ordinary extension that declares chrome.action", () => {
  const verdict = classifyManifest({
    manifest_version: 3,
    name: "content plus toolbar",
    action: { default_popup: "popup.html" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }],
  });
  assert.equal(verdict.supported, false);
  assert.match(verdict.reasons.join(" "), /requires action/);
});

test("missing APIs are fatal for ordinary MV3 extensions, even with a working content script", () => {
  const verdict = classifyManifest({
    manifest_version: 3,
    name: "security extension",
    permissions: ["webRequest", "cookies"],
    content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }],
  });
  assert.equal(verdict.supported, false);
  assert.match(verdict.reasons.join(" "), /requires webRequest/);
  assert.match(verdict.reasons.join(" "), /requires cookies/);
});

test("uBO Lite alone may degrade without userScripts, because that exact path was measured", () => {
  const verdict = classifyManifest(UBLOCK_ORIGIN_LITE_MV3);
  assert.equal(verdict.supported, true, describeVerdict(verdict));
  assert.deepEqual(verdict.missingApis, ["userScripts", "action"]);
});

test("optional_permissions for missing APIs cause refusal too", () => {
  const verdict = classifyManifest({
    manifest_version: 3,
    name: "optional asker",
    permissions: ["declarativeNetRequest"],
    optional_permissions: ["cookies", "downloads"],
  });
  assert.equal(verdict.supported, false);
  assert.deepEqual(verdict.missingApis, ["cookies", "downloads"]);
  assert.match(verdict.reasons.join(" "), /requires cookies/);
  assert.match(verdict.reasons.join(" "), /requires downloads/);
});

test("declaredPopup reads MV3 action and both MV2 action shapes", () => {
  assert.equal(declaredPopup({ action: { default_popup: "a.html" } }), "a.html");
  assert.equal(declaredPopup({ browser_action: { default_popup: "b.html" } }), "b.html");
  assert.equal(declaredPopup({ page_action: { default_popup: "c.html" } }), "c.html");
  assert.equal(declaredPopup({ action: {} }), null);
  assert.equal(declaredPopup({ action: { default_popup: "" } }), null);
  assert.equal(declaredPopup({}), null);
  assert.equal(declaredPopup({ action: "not an object" }), null);
});

test("workingCapabilities counts a ruleset even without the permission named", () => {
  // The permission and the ruleset are declared separately and either alone is enough to mean
  // the extension intends to block.
  assert.deepEqual(
    workingCapabilities({ declarative_net_request: { rule_resources: [{ id: "r", path: "r.json" }] } }),
    ["declarativeNetRequest"],
  );
  assert.deepEqual(workingCapabilities({ permissions: ["declarativeNetRequest"] }), ["declarativeNetRequest"]);
  assert.deepEqual(workingCapabilities({}), []);
});

test("missingApisRequested reports in MISSING_APIS order, not manifest order", () => {
  const requested = missingApisRequested({ permissions: ["cookies", "webRequest", "privacy"] });
  assert.deepEqual(requested, ["webRequest", "cookies", "privacy"]);
  for (const api of requested) assert.ok(MISSING_APIS.includes(api));
});

test("describeVerdict is a single line in both directions", () => {
  const ok = describeVerdict(classifyManifest(UBLOCK_ORIGIN_LITE_MV3));
  const no = describeVerdict(classifyManifest(UBLOCK_ORIGIN_MV2));
  for (const line of [ok, no]) assert.equal(line.includes("\n"), false);
  assert.match(ok, /^__MSG_extName__: loaded — /);
  assert.match(no, /^uBlock Origin: refused — /);
});

test("describeVerdict falls back to a label when the manifest has no name", () => {
  assert.match(describeVerdict(classifyManifest({ manifest_version: 3 })), /^extension: refused/);
});
