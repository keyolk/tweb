"use strict";

// What `tweb extensions` answers, shaped from what `loadExtensions` already returns.
//
// This exists because of a measured property of the loader: `loadExtension` resolves cleanly
// whether the extension's service worker lives or dies, and a dead worker leaves the DNR rules
// unarmed while everything still reports success (see extensions.cjs). Silence is this area's
// default failure mode, so the state has to be askable rather than inferred from a page that
// looks slightly wrong.
//
// Reporting only. Installing, removing and enabling are deliberately absent — the directory is
// the interface, and adding a management surface here would drag in signature checks, the web
// store protocol and a permissions dialog.

const path = require("node:path");

// The one-word answer, chosen so a person scanning a column sees the problem rather than
// having to read the detail.
function extensionState(result) {
  if (!result?.loaded) return "refused";
  // Loaded, but its rules are not necessarily armed. The worker is what arms them.
  if (result.workerError) return "degraded";
  if (result.verdict?.missingApis?.length > 0) return "degraded";
  return "loaded";
}

function extensionDetail(result) {
  if (!result?.loaded) {
    if (result?.error) return result.error;
    const reasons = result?.verdict?.reasons || [];
    return reasons.length > 0 ? reasons.join("; ") : "refused";
  }
  const parts = [];
  const rules = result.rulesetIds?.length || 0;
  if (rules > 0) parts.push(`${rules} ruleset${rules === 1 ? "" : "s"}`);
  if (result.verdict?.capabilities?.length > 0) parts.push(result.verdict.capabilities.join(", "));
  // Named rather than hidden: the two meanings Electron does not distinguish are "another
  // process owns the scope, and its rules DO apply here" and "the worker could not start".
  if (result.workerError) parts.push(`worker: ${result.workerError}`);
  else if (result.serviceWorkerStarted) parts.push("worker running");
  if (result.verdict?.missingApis?.length > 0) {
    parts.push(`no ${result.verdict.missingApis.join(", ")}`);
  }
  if (result.adapted) parts.push("TWeb compatibility adapter");
  return parts.join("; ");
}

function extensionReport(results, dir) {
  const entries = (Array.isArray(results) ? results : []).map((result) => ({
    name: result?.verdict?.name || path.basename(result?.dir || "") || "unknown",
    id: result?.id || null,
    state: extensionState(result),
    detail: extensionDetail(result),
    dir: result?.dir || null,
    manifestVersion: result?.verdict?.manifestVersion ?? null,
  }));
  return {
    dir: dir || null,
    loaded: entries.filter((entry) => entry.state !== "refused").length,
    refused: entries.filter((entry) => entry.state === "refused").length,
    extensions: entries,
  };
}

module.exports = { extensionDetail, extensionReport, extensionState };
