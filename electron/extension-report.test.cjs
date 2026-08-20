"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { extensionDetail, extensionReport, extensionState } = require("./extension-report.cjs");

const ubol = {
  dir: "/profile/extensions/ublock-origin-lite",
  loaded: true,
  id: "oipomcflpglmdjckbbgmjgbfpfhjjanh",
  rulesetIds: ["ubol-filters"],
  serviceWorkerStarted: true,
  workerError: null,
  adapted: true,
  verdict: {
    supported: true,
    name: "uBlock Origin Lite",
    capabilities: ["declarativeNetRequest"],
    missingApis: [],
    reasons: [],
    manifestVersion: 3,
  },
};

// The measured failure this whole command exists for: `loadExtension` resolves either way,
// so a worker that died leaves the rules unarmed while the extension still reports loaded.
test("a loaded extension whose worker died is not called loaded", () => {
  assert.equal(extensionState(ubol), "loaded");
  const dead = { ...ubol, serviceWorkerStarted: false, workerError: "worker did not start" };
  assert.equal(extensionState(dead), "degraded");
  assert.match(extensionDetail(dead), /worker: worker did not start/);
});

test("a supported extension missing APIs is degraded, and says which", () => {
  const degraded = {
    ...ubol,
    verdict: { ...ubol.verdict, missingApis: ["chrome.permissions", "chrome.action"] },
  };
  assert.equal(extensionState(degraded), "degraded");
  assert.match(extensionDetail(degraded), /no chrome\.permissions, chrome\.action/);
});

// A refusal is only useful if it carries its reason — the user has to know what to change.
test("a refusal carries its reason", () => {
  const refused = {
    dir: "/profile/extensions/some-mv2",
    loaded: false,
    verdict: {
      supported: false,
      name: "Some MV2 Thing",
      reasons: ["manifest version 2 is not supported"],
      capabilities: [],
      missingApis: [],
      manifestVersion: 2,
    },
  };
  assert.equal(extensionState(refused), "refused");
  assert.equal(extensionDetail(refused), "manifest version 2 is not supported");
});

test("an unreadable manifest reports the read error, not an empty refusal", () => {
  const broken = { dir: "/profile/extensions/broken", loaded: false, verdict: null, error: "ENOENT" };
  assert.equal(extensionState(broken), "refused");
  assert.equal(extensionDetail(broken), "ENOENT");
  // With no verdict there is no name, so the directory has to stand in for one.
  assert.equal(extensionReport([broken], "/profile/extensions").extensions[0].name, "broken");
});

test("the report counts degraded as loaded, because it is", () => {
  const dead = { ...ubol, serviceWorkerStarted: false, workerError: "no worker" };
  const refused = { dir: "/x/y", loaded: false, verdict: null, error: "bad" };
  const report = extensionReport([ubol, dead, refused], "/profile/extensions");
  assert.equal(report.loaded, 2);
  assert.equal(report.refused, 1);
  assert.equal(report.dir, "/profile/extensions");
});

test("an empty directory reports nothing rather than throwing", () => {
  const report = extensionReport([], "/profile/extensions");
  assert.deepEqual(report.extensions, []);
  assert.equal(report.loaded, 0);
  assert.equal(report.refused, 0);
  assert.deepEqual(extensionReport(null, null).extensions, []);
});

// Reporting only. Installing would drag in signature checks, the web store protocol and a
// permissions dialog; the directory is the interface.
test("the report exposes no way to install or remove", () => {
  // Comments name these deliberately, so compare the code and not the prose above it.
  const code = require("node:fs")
    .readFileSync(require("node:path").join(__dirname, "extension-report.cjs"), "utf8")
    .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /loadExtension|removeExtension|rmSync|unlinkSync|download/);
});
