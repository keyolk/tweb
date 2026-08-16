"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const {
  formatBytes,
  transferPercent,
  shortFilename,
  transferBadge,
  activeTransfer,
  transferSummary,
  downloadRecord,
  parseDownloadLines,
  downloadRows,
  printFilename,
  printShimScript,
  SETTLED_HOLD_MS,
} = require("./download-state.cjs");

const NOW = 1_700_000_000_000;

function progressing(overrides = {}) {
  return {
    id: 1,
    filename: "sample.txt",
    path: "/Users/x/Downloads/sample.txt",
    url: "http://127.0.0.1:8751/sample.txt",
    state: "progressing",
    paused: false,
    received: 512,
    total: 2048,
    startedAt: NOW - 1000,
    endedAt: 0,
    origin: "download",
    ...overrides,
  };
}

test("byte counts read the way a person reads them", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1500), "1.5 MB");
  assert.equal(formatBytes(1024 * 1024 * 48), "48 MB");
});

test("a byte count that is not a number says nothing rather than NaN", () => {
  assert.equal(formatBytes(undefined), "");
  assert.equal(formatBytes(-1), "");
});

test("a server that omits Content-Length gets no percentage", () => {
  // Reporting 0% for a transfer that is running fine is worse than reporting bytes.
  assert.equal(transferPercent(4096, 0), null);
  assert.equal(transferPercent(4096, -1), null);
  assert.equal(transferPercent(512, 2048), 25);
});

test("a percentage never leaves 0..100 even if the server undercounted", () => {
  assert.equal(transferPercent(5000, 2048), 100);
  assert.equal(transferPercent(-10, 2048), 0);
});

test("a long filename keeps its extension when it is truncated", () => {
  const short = shortFilename("a-very-long-quarterly-financial-report-2026.pdf");
  assert.ok(short.length <= 28, short);
  assert.ok(short.endsWith(".pdf"), short);
  assert.equal(shortFilename("short.txt"), "short.txt");
});

test("an in-flight transfer shows a percentage, and a headerless one shows bytes", () => {
  assert.equal(transferBadge(progressing()).text, "⇣ sample.txt 25%");
  assert.equal(transferBadge(progressing({ total: 0, received: 1024 })).text, "⇣ sample.txt 1.0 KB");
});

test("cancelled and interrupted read differently, because the user caused only one", () => {
  const cancelled = transferBadge(progressing({ state: "cancelled" }));
  const interrupted = transferBadge(progressing({ state: "interrupted" }));
  assert.match(cancelled.text, /cancelled/);
  assert.match(interrupted.text, /failed/);
  assert.notEqual(cancelled.text, interrupted.text);
});

test("a broken connection reads as stalled, not as something the user paused", () => {
  // Measured: reporting a dropped connection as "paused" told the user they had paused a
  // transfer they never touched, and left them waiting for one that was not running.
  const paused = transferBadge(progressing({ paused: true }));
  const stalled = transferBadge(progressing({ stalled: true }));
  assert.match(paused.text, /paused/);
  assert.match(stalled.text, /stalled/);
  assert.equal(paused.tone, "pending");
  assert.equal(stalled.tone, "failed");
});

test("a user pause outranks a stall, because the user's own action explains the stop", () => {
  assert.match(transferBadge(progressing({ paused: true, stalled: true })).text, /paused/);
});

test("a running transfer outranks a finished one for the single badge slot", () => {
  const done = progressing({ id: 1, state: "completed", endedAt: NOW });
  const running = progressing({ id: 2, startedAt: NOW - 100 });
  assert.equal(activeTransfer([done, running]).id, 2);
});

test("with nothing running, the most recently finished transfer wins the slot", () => {
  const older = progressing({ id: 1, state: "completed", endedAt: NOW - 5000 });
  const newer = progressing({ id: 2, state: "completed", endedAt: NOW - 10 });
  assert.equal(activeTransfer([older, newer]).id, 2);
});

test("a finished badge expires, an in-flight one does not", () => {
  const done = [progressing({ state: "completed", endedAt: NOW - SETTLED_HOLD_MS - 1 })];
  assert.equal(transferSummary(done, NOW), null);
  const fresh = [progressing({ state: "completed", endedAt: NOW - 100 })];
  assert.equal(transferSummary(fresh, NOW).state, "completed");
  // A transfer still running is still true no matter how long it has been running.
  const slow = [progressing({ startedAt: NOW - 60 * 60 * 1000 })];
  assert.equal(transferSummary(slow, NOW).state, "progressing");
});

test("the summary carries the absolute path, which is what replaces Show in folder", () => {
  const summary = transferSummary([progressing({ state: "completed", endedAt: NOW })], NOW);
  assert.equal(summary.path, "/Users/x/Downloads/sample.txt");
});

test("no transfers means no badge", () => {
  assert.equal(transferSummary([], NOW), null);
  assert.equal(transferSummary(null, NOW), null);
});

test("an in-flight transfer is not recorded, a cancelled one is", () => {
  assert.equal(downloadRecord(progressing()), null);
  const record = downloadRecord(progressing({ state: "cancelled", endedAt: NOW }));
  assert.equal(record.state, "cancelled");
  assert.equal(record.filename, "sample.txt");
});

test("a printed PDF is recorded as a print, not as a download", () => {
  const record = downloadRecord(progressing({ state: "completed", endedAt: NOW, origin: "print" }));
  assert.equal(record.origin, "print");
});

test("a torn line does not hide the downloads behind it", () => {
  const entries = parseDownloadLines([
    JSON.stringify({ at: NOW, filename: "a.txt", path: "/d/a.txt", state: "completed" }),
    '{"at":170000,"filena',
    "",
    JSON.stringify({ at: NOW + 1, filename: "b.txt", path: "/d/b.txt", state: "completed" }),
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.filename), ["a.txt", "b.txt"]);
});

test("a line with no filename is not a download record", () => {
  assert.deepEqual(parseDownloadLines([JSON.stringify({ at: NOW })]), []);
});

test("the same file downloaded twice keeps both rows", () => {
  // History collapses repeats; downloads must not, because two files exist on disk.
  const entries = parseDownloadLines([
    JSON.stringify({ at: NOW, filename: "report.pdf", path: "/d/report.pdf", url: "u", state: "completed" }),
    JSON.stringify({ at: NOW + 5, filename: "report (1).pdf", path: "/d/report (1).pdf", url: "u", state: "completed" }),
  ]);
  const model = downloadRows(entries);
  assert.equal(model.total, 2);
  assert.deepEqual(model.rows.map((row) => row.filename), ["report (1).pdf", "report.pdf"]);
});

test("the list searches the path and the URL, not just the filename", () => {
  const entries = parseDownloadLines([
    JSON.stringify({ at: NOW, filename: "a.txt", path: "/d/invoices/a.txt", url: "http://x/a", state: "completed" }),
    JSON.stringify({ at: NOW + 1, filename: "b.txt", path: "/d/photos/b.txt", url: "http://y/b", state: "completed" }),
  ]);
  assert.equal(downloadRows(entries, { query: "invoices" }).total, 1);
  assert.equal(downloadRows(entries, { query: "http://y" }).total, 1);
});

test("the list reports what the cap dropped rather than looking complete", () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    at: NOW + index, state: "completed", filename: `f${index}`, path: "", url: "", bytes: 0, origin: "download",
  }));
  const model = downloadRows(entries, { limit: 2 });
  assert.equal(model.shown, 2);
  assert.equal(model.total, 5);
  assert.equal(model.truncated, 3);
});

test("a printed page is named after the page and always ends in .pdf", () => {
  assert.equal(printFilename("Quarterly Report", "http://x/q"), "Quarterly Report.pdf");
  // A page whose title already ends in .pdf must not produce a file indistinguishable
  // from the original document by name — printing the viewer is not the document.
  assert.equal(printFilename("invoice.pdf", "http://x/i"), "invoice.pdf.pdf");
});

test("a titleless page is named after its URL, and a nameless one still gets a file", () => {
  assert.equal(printFilename("", "http://example.com/docs/spec/"), "example.com docs spec.pdf");
  assert.equal(printFilename("", "not a url"), "page.pdf");
  assert.equal(printFilename("///", "not a url"), "page.pdf");
});

test("a print filename cannot escape the downloads directory", () => {
  const name = printFilename("../../etc/passwd", "http://x/");
  assert.ok(!name.includes("/"), name);
  assert.ok(!name.includes("\\"), name);
});

test("a very long page title is trimmed to a usable filename", () => {
  const name = printFilename("x".repeat(300), "http://x/");
  assert.ok(name.length <= 84, name.length);
  assert.ok(name.endsWith(".pdf"));
});

test("the print shim carries the caller's own way of reporting the request", () => {
  // The preload's frame can raise a DOM event it listens for; a frame reached from main
  // reports differently. One script, two notifiers, so the two cannot drift apart.
  assert.match(printShimScript("sendIt();"), /const notify = \(\) => \{ sendIt\(\); \}/);
});

test("the print shim refuses to install twice over itself", () => {
  // Re-injection happens on every navigation and every reached child; stacking the
  // wrappers would grow a chain of shims around one print.
  const script = printShimScript("x();");
  assert.match(script, /if \(window\.__twebPrintShim\) return "already"/);
});

test("the print shim reaches a child window synchronously, not on a later tick", () => {
  // Measured: a page that creates an iframe and prints it in ONE TICK wedges the renderer
  // before Electron's async frame-created hook can land a shim. Patching the accessors the
  // page must go through to reach the child is what closes that race, so their presence is
  // the property worth pinning.
  const script = printShimScript("x();");
  assert.match(script, /HTMLIFrameElement[\s\S]*?"contentWindow"/);
  assert.match(script, /HTMLIFrameElement[\s\S]*?"contentDocument"/);
  assert.match(script, /descriptor\.get\.call\(this\)/);
});

test("the print shim leaves window.print replaceable by the page", () => {
  // A page that assigns its own print() must still be able to; a non-configurable,
  // non-writable property would throw in strict mode on a perfectly ordinary page.
  const script = printShimScript("x();");
  assert.match(script, /configurable: true/);
  assert.match(script, /writable: true/);
});

test("the preload's own copy of the shim keeps the same protections", () => {
  // The preload cannot require this module — it is sandboxed, and doing so failed the
  // whole preload with "module not found". So it carries its own copy, and the copies have
  // to be checked against each other rather than trusted to stay in step.
  const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const shim = preload.slice(preload.indexOf("function installPrintShim"),
    preload.indexOf("installPrintShim();"));
  assert.match(shim, /if \(window\.__twebPrintShim\) return "already"/, "missing re-entry guard");
  assert.match(shim, /configurable: true/, "print must stay replaceable by the page");
  assert.match(shim, /HTMLIFrameElement[\s\S]*?"contentWindow"/, "missing the child-frame accessor patch");
  assert.match(shim, /descriptor\.get\.call\(this\)/, "the patched accessor must still return the real value");
});
