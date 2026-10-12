"use strict";

// The run facts the `?` help shows at its top: which engine serves the pane, which build of the
// app code is running, and how frames are paced.
//
// Before this, telling an installed tweb from a worktree build, or an Electron pane from a
// `--engine chrome` one, took `tweb diag --json` from another shell — and a bug report made
// without it was often about the wrong build. The help is the one screen a user already opens
// when something feels off.

const path = require("node:path");

// `~/.cache/tweb/app-<hash>` is the installed binary's embedded app code; anything else is a
// checkout (`…/tweb/electron`). The hash is what distinguishes two installed builds, since the
// package version has stayed 0.1.0.
function appBuild(appDir) {
  const base = path.basename(String(appDir || ""));
  const match = /^app-([0-9a-f]+)$/i.exec(base);
  if (match) return `installed ${match[1].slice(0, 8)}`;
  return `dev ${appDir}`;
}

// Chrome's `/json/version` says `"Browser": "Chrome/141.0.7390.54"` (or `HeadlessChrome/…`).
function chromeVersion(versionInfo) {
  const browser = String(versionInfo?.Browser || "");
  const match = /Chrome\/([\d.]+)/.exec(browser);
  return match ? match[1] : null;
}

function engineLabel({ backend, electronVersion, chromiumVersion, chromeInfo }) {
  if (backend === "chrome") {
    const version = chromeVersion(chromeInfo);
    return version ? `Chrome ${version} (CDP)` : "Chrome (CDP)";
  }
  return `Electron ${electronVersion || "?"} · Chromium ${chromiumVersion || "?"}`;
}

// Ordered [label, value] rows, so the preload only lays them out and never decides what matters.
function runtimeInfoRows(facts) {
  const rows = [
    ["tweb", `${facts.version || "?"} · ${appBuild(facts.appDir)}`],
    ["engine", engineLabel(facts)],
    ["pane", [facts.pane || (facts.hosted ? "twebd" : "no tmux"), `pid ${facts.pid}`, facts.hosted ? "hosted by twebd" : "own process"].join(" · ")],
  ];
  const frames = facts.frames;
  if (frames) {
    const rate = frames.adaptive
      ? `adaptive ${frames.idle}–${frames.max}fps (now ${frames.rate})`
      : `fixed ${frames.max}fps`;
    rows.push(["frames", frames.size ? `${rate} · ${frames.size.width}x${frames.size.height}` : rate]);
  }
  if (facts.mode) rows.push(["input", facts.mode]);
  return rows;
}

module.exports = { appBuild, chromeVersion, engineLabel, runtimeInfoRows };
