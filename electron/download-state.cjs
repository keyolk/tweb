"use strict";

// What the pane says about a transfer — downloads, and the PDF a print turns into.
//
// The transfer itself already worked before this file existed: `will-download` set a save
// path under ~/Downloads and Chromium wrote the bytes. What was missing is that nothing
// ever told the user, so a click produced a file nobody knew about. Chrome pushes that
// information at you with a shelf; the terminal equivalent is a badge in the pane plus a
// record on disk, and both need the same few decisions made once, here, where they can be
// tested at a fixed instant rather than against a live download.
//
// Everything is pure. The engine owns the DownloadItem and the file writes; this module
// only decides what the user is told.

// Chrome shows a byte count while a transfer runs and the filename when it lands, so the
// same two shapes are what a badge has to produce.
function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  // One decimal below 10 keeps "1.4 MB" honest without "1.43 MB"'s false precision.
  return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)} ${units[unit]}`;
}

/**
 * Percent complete, or null when the server did not say how big the file is.
 *
 * A server that omits Content-Length reports totalBytes 0, and treating that as "0% of 0"
 * would paint a progress bar stuck at zero for a transfer that is running fine. The badge
 * falls back to a running byte count instead, which is what Chrome does in the same case.
 */
function transferPercent(received, total) {
  const done = Number(received);
  const size = Number(total);
  if (!Number.isFinite(done) || !Number.isFinite(size) || size <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((done / size) * 100)));
}

// A filename long enough to push the badge across the pane says less than a truncated one,
// because the badge's whole job is to be readable at a glance next to the page.
function shortFilename(filename, limit = 28) {
  const name = String(filename || "");
  if (name.length <= limit) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const head = Math.max(1, limit - extension.length - 1);
  return `${name.slice(0, head)}…${extension}`;
}

/**
 * The badge for one transfer, or null when it has nothing to say.
 *
 * Four stopped states that a user experiences differently, kept apart on purpose:
 *   paused      — the user did this, and can undo it
 *   stalled     — the connection broke mid-transfer; Chromium may still resume it
 *   cancelled   — the user did this, and the partial file is gone
 *   interrupted — it failed and will not resume
 * Collapsing `stalled` into `paused` was measured to be actively misleading: a dropped
 * connection showed "drop.bin paused", which tells the user they did something they did
 * not do, and leaves them waiting for a transfer that is not running.
 */
function transferBadge(transfer) {
  if (!transfer) return null;
  const name = shortFilename(transfer.filename);
  switch (transfer.state) {
    case "progressing": {
      if (transfer.paused) return { text: `⇣ ${name} paused`, tone: "pending" };
      if (transfer.stalled) return { text: `⇣ ${name} stalled`, tone: "failed" };
      const percent = transferPercent(transfer.received, transfer.total);
      const detail = percent === null ? formatBytes(transfer.received) : `${percent}%`;
      return { text: `⇣ ${name} ${detail}`, tone: "pending" };
    }
    case "completed":
      return { text: `✓ ${name}`, tone: "done" };
    case "cancelled":
      return { text: `✕ ${name} cancelled`, tone: "failed" };
    case "interrupted":
      return { text: `✕ ${name} failed`, tone: "failed" };
    default:
      return null;
  }
}

// Only one badge fits beside the mode indicator, so N concurrent transfers have to collapse
// into one line. An in-flight transfer outranks a finished one — the finished file is
// already on disk and its path is in the list, while the running one is the thing the user
// might still want to cancel.
function activeTransfer(transfers) {
  const list = Array.isArray(transfers) ? transfers.filter(Boolean) : [];
  if (list.length === 0) return null;
  const running = list.filter((entry) => entry.state === "progressing");
  if (running.length > 0) {
    // The newest running transfer is the one the user just started, so it is the one they
    // are looking for confirmation of.
    return running.reduce((latest, entry) => (entry.startedAt >= latest.startedAt ? entry : latest));
  }
  return list.reduce((latest, entry) => (entry.endedAt >= latest.endedAt ? entry : latest));
}

// Long enough to notice while looking at the page, short enough that it does not become
// furniture. Chrome's download bubble auto-hides on a comparable timescale.
const SETTLED_HOLD_MS = 8000;

/**
 * The badge for the pane, given every transfer it knows about and the time now.
 *
 * A finished transfer's badge expires: "✓ report.pdf" that never goes away would sit over
 * the page forever, and Chrome's own shelf is dismissible for the same reason. An in-flight
 * one never expires, because a transfer that is still running is still true.
 */
function transferSummary(transfers, now, holdMs = SETTLED_HOLD_MS) {
  const transfer = activeTransfer(transfers);
  if (!transfer) return null;
  if (transfer.state !== "progressing") {
    const ended = Number(transfer.endedAt);
    if (!Number.isFinite(ended) || Number(now) - ended > holdMs) return null;
  }
  const badge = transferBadge(transfer);
  if (!badge) return null;
  return { ...badge, id: transfer.id, path: transfer.path || "", state: transfer.state };
}

/**
 * The line written to downloads.jsonl, or null for a transfer not worth recording.
 *
 * A cancelled transfer IS recorded: "I cancelled that, that is why there is no file" is
 * exactly the question the list exists to answer, and Chrome's own downloads page keeps
 * cancelled rows too.
 */
function downloadRecord(transfer) {
  if (!transfer || !transfer.filename) return null;
  if (transfer.state === "progressing") return null;
  return {
    at: Number(transfer.endedAt) || Number(transfer.startedAt) || 0,
    state: String(transfer.state),
    filename: String(transfer.filename),
    path: String(transfer.path || ""),
    url: String(transfer.url || ""),
    bytes: Number(transfer.received) || 0,
    // Printing lands a PDF through the same pipe as a download, and the list has to be
    // able to say which it was — "I never downloaded this" about a file you printed is
    // the kind of confusion a record is supposed to prevent.
    origin: transfer.origin === "print" ? "print" : "download",
  };
}

function parseDownloadLines(lines) {
  const entries = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw || "").trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      // A torn line from a concurrent append, same as history's reader: skip it rather
      // than letting one bad write hide every download behind it.
      continue;
    }
    const at = Number(parsed?.at);
    if (!parsed?.filename || !Number.isFinite(at)) continue;
    entries.push({
      at,
      state: String(parsed.state || "completed"),
      filename: String(parsed.filename),
      path: String(parsed.path || ""),
      url: String(parsed.url || ""),
      bytes: Number(parsed.bytes) || 0,
      origin: parsed.origin === "print" ? "print" : "download",
    });
  }
  return entries;
}

/// Every space-separated term has to appear in the filename, the path or the URL.
function matchesDownloadQuery(entry, query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${entry.filename} ${entry.path} ${entry.url}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

// Enough rows that scrolling rather than the cap is what limits browsing, matching the
// history page's reasoning.
const MAX_ROWS = 400;

/**
 * The downloads list model: newest first, filtered, with the cap reported.
 *
 * Unlike history this does NOT collapse repeats. Downloading the same URL twice produces
 * two files on disk — `report.pdf` and `report (1).pdf` — and hiding one of them would
 * leave the user unable to find a file that exists.
 */
function downloadRows(entries, { query = "", limit = MAX_ROWS } = {}) {
  const matched = (Array.isArray(entries) ? entries : []).filter((entry) => matchesDownloadQuery(entry, query));
  const ordered = [...matched].sort((left, right) => right.at - left.at);
  const kept = ordered.slice(0, Math.max(0, limit));
  return {
    rows: kept,
    total: ordered.length,
    shown: kept.length,
    // Reported rather than silently dropped, for the same reason the history page reports
    // it: a cap that looks like the whole list is how a reader concludes a file is gone.
    truncated: Math.max(0, ordered.length - kept.length),
  };
}

// What a print becomes. Chrome fuses "save as PDF" and "put ink on paper" into one dialog;
// a tmux pane can draw neither the preview nor the system print sheet, so TWeb does the
// half it can do honestly and names the file after the page.
//
// The extension is forced to .pdf even when the title already ends in one, because
// "invoice.pdf" as a title would otherwise produce a file called `invoice.pdf` that is a
// PDF *of the viewer*, indistinguishable from the original by name alone.
function printFilename(title, url) {
  const fromTitle = String(title || "").trim();
  let stem = fromTitle;
  if (!stem) {
    try {
      const parsed = new URL(String(url));
      stem = `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "");
    } catch (_) {
      stem = "";
    }
  }
  // Path separators and the characters a shell or Finder would fight over; everything else
  // — including spaces and unicode — survives, because a filename the user recognises is
  // worth more than one that is easy to quote.
  stem = stem.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  if (stem.length > 80) stem = stem.slice(0, 80).trim();
  return `${stem || "page"}.pdf`;
}

/**
 * The script main injects to replace `window.print` in a frame the preload never reached.
 *
 * Chromium services a print by opening the platform's print sheet. TWeb's window is
 * offscreen and `show: false`, so the sheet has nowhere to appear — and the call never
 * returns. Measured: the renderer's main thread blocks permanently, eval and page-diag
 * both time out, the real key path dies, and the pane keeps painting its last frame so it
 * still LOOKS healthy. Killing the pane then leaves the frontend orphaned at PPID 1.
 *
 * The preload carries its own copy of this rather than requiring it, and that duplication
 * is deliberate: the preload is SANDBOXED, so `require` reaches Electron's builtins and
 * nothing else. Requiring this module from there fails the entire preload with "module not
 * found" and takes every shortcut and overlay down with it — measured, after trying it.
 *
 * The accessor patch is what covers a child frame. Electron's `frame-created` is too late:
 * a page that does `f.contentWindow.document.write(...); f.contentWindow.print()` in ONE
 * TICK wedges the renderer before an async shim can land, and writing a receipt into a
 * hidden iframe and printing THAT is a common real-site pattern rather than a corner case.
 * Patching the accessors the page must go through to reach a child shims it synchronously,
 * on the very access that precedes the call. Same-origin children only — a cross-origin
 * child throws on access and gets its own preload anyway.
 */
function printShimScript(notifyExpression) {
  return `(() => {
    if (window.__twebPrintShim) return "already";
    window.__twebPrintShim = true;
    const notify = () => { ${notifyExpression} };
    // Configurable so a page that assigns its own print() still can, and writable so the
    // assignment does not throw in strict mode.
    const define = (target) => Object.defineProperty(target, "print", {
      configurable: true,
      writable: true,
      value: function print() { notify(); },
    });
    define(window);
    const shimChild = (child) => {
      try {
        if (!child || child.__twebPrintShim) return;
        child.__twebPrintShim = true;
        define(child);
      } catch (error) {
        // Cross-origin: unreachable from here, and covered by its own preload instead.
      }
    };
    for (const [proto, property] of [
      [window.HTMLIFrameElement && window.HTMLIFrameElement.prototype, "contentWindow"],
      [window.HTMLIFrameElement && window.HTMLIFrameElement.prototype, "contentDocument"],
      [window.HTMLObjectElement && window.HTMLObjectElement.prototype, "contentWindow"],
      [window.HTMLEmbedElement && window.HTMLEmbedElement.prototype, "getSVGDocument"],
    ]) {
      if (!proto) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, property);
      if (!descriptor || !descriptor.get) continue;
      Object.defineProperty(proto, property, { ...descriptor, get() {
        const value = descriptor.get.call(this);
        shimChild(property === "contentDocument" ? value && value.defaultView : value);
        return value;
      } });
    }
    return "installed";
  })()`;
}

module.exports = {
  printShimScript,
  formatBytes,
  transferPercent,
  shortFilename,
  transferBadge,
  activeTransfer,
  transferSummary,
  downloadRecord,
  parseDownloadLines,
  matchesDownloadQuery,
  downloadRows,
  printFilename,
  SETTLED_HOLD_MS,
  MAX_ROWS,
};
