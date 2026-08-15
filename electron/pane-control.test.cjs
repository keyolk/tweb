"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseControlLine, splitAddress, resolveTarget, formatOutbound } = require("./pane-control.cjs");
const { PaneRegistry, createPaneRecord } = require("./pane-registry.cjs");

test("an unaddressed RESIZE parses exactly as it always did", () => {
  // The shipping frontend sends this and must keep working unchanged.
  assert.deepEqual(parseControlLine("RESIZE 80 24 800 480"), {
    kind: "resize", paneId: null, viewport: { cols: 80, rows: 24, width: 800, height: 480 },
    origin: undefined,
  });
});

test("an absent origin is not an origin of 0,0", () => {
  // Re-anchoring a pane at the window's top-left is how a pane draws over its neighbours.
  assert.equal(parseControlLine("RESIZE 80 24 800 480").origin, undefined);
  assert.deepEqual(parseControlLine("RESIZE 80 24 800 480 0 0").origin, { left: 0, top: 0 });
  assert.deepEqual(parseControlLine("RESIZE 80 24 800 480 20 7").origin, { left: 20, top: 7 });
});

test("VIS and INPUT keep their shipping shapes, case included", () => {
  assert.deepEqual(parseControlLine("VIS 01ab"), { kind: "visibility", paneId: null, hex: "01ab" });
  // A payload-less VIS trims to a bare keyword, which the shipping regex rejects too — the
  // frontend only pushes when it has a placement to report, so there is no such line to honour.
  assert.equal(parseControlLine("VIS "), null);
  assert.deepEqual(parseControlLine("INPUT 1B5B41"), { kind: "input", paneId: null, hex: "1B5B41" });
});

test("half a byte of input is ignored rather than decoded into one the frontend never sent", () => {
  assert.equal(parseControlLine("INPUT 1b5"), null);
});

test("the address prefix targets a pane and leaves the rest of the line alone", () => {
  assert.deepEqual(parseControlLine("@%3 RESIZE 80 24 800 480 20 0"), {
    kind: "resize", paneId: "%3", viewport: { cols: 80, rows: 24, width: 800, height: 480 },
    origin: { left: 20, top: 0 },
  });
  assert.deepEqual(parseControlLine("@%42 VIS ff"), { kind: "visibility", paneId: "%42", hex: "ff" });
  assert.deepEqual(splitAddress("@%7 INPUT ab"), { paneId: "%7", rest: "INPUT ab" });
  assert.deepEqual(splitAddress("INPUT ab"), { paneId: null, rest: "INPUT ab" });
});

test("ATTACH carries the image id, because the host must not invent one", () => {
  // Kitty ids are terminal-wide and per-pane engines derive theirs from their pid; an invented
  // range would eventually overwrite one of their images.
  assert.deepEqual(parseControlLine("@%3 ATTACH /tmp/sock,111 7 4242 30 1 0 https://example.com"), {
    kind: "attach", paneId: "%3", tmuxServer: "/tmp/sock,111", generation: 7, imageId: 4242,
    frameRate: 30, adaptive: true, restoreSession: false, url: "https://example.com",
  });
});

test("a pane outside tmux attaches with an explicit dash, not an empty field", () => {
  const attach = parseControlLine("@%0 ATTACH - 1 900 30 0 1");
  assert.equal(attach.tmuxServer, null);
  assert.equal(attach.adaptive, false);
  assert.equal(attach.restoreSession, true);
  assert.equal(attach.url, null);
});

test("DETACH parses addressed, and unaddressed for the sole pane", () => {
  assert.deepEqual(parseControlLine("@%3 DETACH"), { kind: "detach", paneId: "%3" });
  assert.deepEqual(parseControlLine("DETACH"), { kind: "detach", paneId: null });
});

test("anything unrecognised is null, never a half-filled command", () => {
  const lines = [
    "", "   ", null, undefined, "RESIZE", "RESIZE 80 24", "RESIZE 80 24 800 480 20",
    "VIS zz", "INPUT xyz", "@%3", "@ RESIZE 80 24 800 480", "ATTACH", "ATTACH /tmp 1",
    "@%3 ATTACH /tmp,1 7 4242 30 2 0", "RESIZE -80 24 800 480", "NONSENSE 1",
  ];
  for (const line of lines) assert.equal(parseControlLine(line), null, `parsed: ${line}`);
});

test("an unaddressed line resolves to the sole pane, which is the shipping path", () => {
  const registry = new PaneRegistry();
  const only = createPaneRecord({ paneId: "%3", generation: 1, imageId: 1 });
  registry.attach(only);
  assert.equal(resolveTarget(parseControlLine("RESIZE 80 24 800 480"), registry), only);
});

test("an unaddressed line with several panes is dropped rather than guessed", () => {
  // Applying one pane's resize to whichever happened to be first in the map is worse than
  // doing nothing.
  const registry = new PaneRegistry();
  registry.attach(createPaneRecord({ paneId: "%1", generation: 1, imageId: 1 }));
  registry.attach(createPaneRecord({ paneId: "%2", generation: 2, imageId: 2 }));
  assert.equal(resolveTarget(parseControlLine("RESIZE 80 24 800 480"), registry), null);
});

test("an addressed line finds its pane, and an unknown address finds nothing", () => {
  const registry = new PaneRegistry();
  const pane = createPaneRecord({ tmuxServer: "srv", paneId: "%3", generation: 1, imageId: 1 });
  registry.attach(pane);
  assert.equal(resolveTarget(parseControlLine("@%3 VIS 01"), registry, "srv"), pane);
  assert.equal(resolveTarget(parseControlLine("@%9 VIS 01"), registry, "srv"), null);
  // A right pane id on the wrong server is a different pane.
  assert.equal(resolveTarget(parseControlLine("@%3 VIS 01"), registry, "other"), null);
});

test("an empty registry resolves nothing rather than throwing", () => {
  const registry = new PaneRegistry();
  assert.equal(resolveTarget(parseControlLine("RESIZE 80 24 800 480"), registry), null);
  assert.equal(resolveTarget(null, registry), null);
});

test("outbound lines mirror the same optional-address rule", () => {
  assert.equal(formatOutbound("FRAME", "%3", "1b5f47"), "@%3 FRAME 1b5f47\n");
  assert.equal(formatOutbound("FRAME", null, "1b5f47"), "FRAME 1b5f47\n");
  assert.equal(formatOutbound("DETACHED", "%3"), "@%3 DETACHED\n");
  assert.equal(formatOutbound("DETACHED", null), "DETACHED\n");
});
