"use strict";

// A video or audio picked with `f` or `v` is held, and the media keys act on it until Esc.
// These run the real `handleMediaKey` / `holdMedia` out of preload.cjs against a fake element, and
// pin that both pickers reach the same code and that the keys belong to the page when nothing is
// held (j/k scroll, m takes audio back).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const electron = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");

function slice(from, to) {
  const start = electron.indexOf(from);
  const end = electron.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} is gone`);
  return electron.slice(start, end);
}

const mediaSource = slice("function isMediaElement(element)", "function inspectTargets()");

function fakeMedia(overrides = {}) {
  const listeners = new Map();
  return {
    localName: "video",
    isConnected: true,
    volume: 0.5,
    muted: false,
    paused: true,
    currentTime: 100,
    duration: 600,
    playbackRate: 1,
    plays: 0,
    play() { this.paused = false; this.plays += 1; return Promise.resolve(); },
    pause() { this.paused = true; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    listeners,
    ...overrides,
  };
}

function harness() {
  const sent = [];
  const modes = [];
  const location = { href: "https://www.youtube.com/watch?v=one" };
  const api = new Function("sent", "modes", "location", `
    let mediaTarget = null;
    let mediaTargetWatch = null;
    let mediaHeldPage = null;
    const document = { documentElement: { dataset: { twebMode: "media" } } };
    const isTag = (element, ...names) => names.includes(element?.localName);
    const visibleRect = () => ({ left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 });
    const topViewportPoint = (point) => point;
    const send = (...args) => sent.push(args);
    const normalMode = () => modes.push(mediaTarget && mediaTarget.isConnected
      ? ["media", mediaStatus(mediaTarget)] : ["normal", ""]);
    ${mediaSource}
    return {
      hold: (element) => holdMedia({ element }),
      key: (key) => {
        const event = { prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
        return { handled: handleMediaKey(event, key), prevented: event.prevented };
      },
      held: () => mediaTarget,
      status: (media) => mediaStatus(media),
    };
  `)(sent, modes, location);
  return { ...api, sent, modes, location };
}

test("with nothing held the media keys go on to the page", () => {
  const h = harness();
  for (const key of ["j", "k", "h", "l", "H", "L", " ", "m", "<", ">", "Escape"]) {
    const { handled, prevented } = h.key(key);
    assert.equal(handled, false, `${key} must stay the page's`);
    assert.equal(prevented, false, key);
  }
});

test("held media: volume, play, seek, mute and speed, each clamped", () => {
  const h = harness();
  const media = fakeMedia();
  h.hold(media);
  assert.equal(h.held(), media);
  assert.equal(h.sent[0][0], "native-hover", "the site's control bar is hover-gated");

  h.key("k");
  assert.equal(media.volume, 0.6);
  for (let i = 0; i < 8; i += 1) h.key("k");
  assert.equal(media.volume, 1, "clamped at 100%");
  for (let i = 0; i < 12; i += 1) h.key("j");
  assert.equal(media.volume, 0, "clamped at 0%");

  media.muted = true;
  h.key("k");
  assert.equal(media.muted, false, "raising the volume unmutes");
  assert.equal(media.volume, 0.1);

  h.key(" ");
  assert.equal(media.paused, false);
  h.key(" ");
  assert.equal(media.paused, true);

  h.key("l");
  assert.equal(media.currentTime, 105);
  h.key("H");
  assert.equal(media.currentTime, 75);
  h.key("L");
  assert.equal(media.currentTime, 105);
  media.currentTime = 2;
  h.key("h");
  assert.equal(media.currentTime, 0, "not before the start");
  media.currentTime = 590;
  h.key("L");
  assert.equal(media.currentTime, 600, "not past the end");

  h.key("m");
  assert.equal(media.muted, true);
  h.key("m");
  assert.equal(media.muted, false);

  h.key(">");
  assert.equal(media.playbackRate, 1.25);
  for (let i = 0; i < 20; i += 1) h.key(">");
  assert.equal(media.playbackRate, 4);
  for (let i = 0; i < 20; i += 1) h.key("<");
  assert.equal(media.playbackRate, 0.25);
});

test("held media leaves every other key alone, and Esc lets it go", () => {
  const h = harness();
  const media = fakeMedia();
  h.hold(media);
  for (const key of ["f", "v", "o", "x", "J", "K", "/"]) {
    assert.equal(h.key(key).handled, false, `${key} keeps its usual meaning while media is held`);
  }
  assert.equal(h.key("Escape").handled, true);
  assert.equal(h.held(), null);
  assert.equal(media.listeners.size, 0, "its listeners go with it");
  assert.equal(h.key("j").handled, false, "j scrolls again after Esc");
});

test("a held element removed from the page releases itself", () => {
  const h = harness();
  const media = fakeMedia();
  h.hold(media);
  media.isConnected = false;
  assert.equal(h.key("k").handled, false);
  assert.equal(h.held(), null);
});

test("moving to another page lets the held media go, though the element stays in the page", () => {
  // YouTube: a video page to the home page, or to the next video, is pushState with the same <video>.
  for (const next of ["https://www.youtube.com/", "https://www.youtube.com/watch?v=two"]) {
    const h = harness();
    const media = fakeMedia();
    h.hold(media);
    h.location.href = next;
    assert.equal(h.key("k").handled, false, `${next}: k is the page's again`);
    assert.equal(media.volume, 0.5, "and does not change the old player's volume");
    assert.equal(h.held(), null);
    assert.equal(media.listeners.size, 0, "its listeners go with it");
  }
});

test("a hash change is the same page, and the media stays held", () => {
  const h = harness();
  const media = fakeMedia();
  h.hold(media);
  h.location.href += "#chapter-2";
  assert.equal(h.key("k").handled, true);
  assert.equal(h.held(), media);
});

test("a same-document navigation tells the top frame at once", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const inPage = main.slice(main.indexOf('onContents("did-navigate-in-page"'));
  assert.match(inPage.slice(0, inPage.indexOf("});")), /sendToMainTabFrame\(tab, "tweb-page-changed", url\)/);
  const listener = slice('ipcRenderer.on("tweb-page-changed"', 'ipcRenderer.on("tweb-audio-state"');
  assert.match(listener, /if \(!mediaSurface\(\) && showing\) normalMode\(\);/,
    "the indicator is redrawn only when it was showing the media, not over a hint round");
});

test("the indicator reads volume, speed and position", () => {
  const h = harness();
  assert.equal(h.status(fakeMedia({ volume: 0.6, playbackRate: 1.25, currentTime: 192, duration: 640, paused: false })),
    "🔊 60% · 1.25x · 03:12/10:40 · Esc");
  assert.equal(h.status(fakeMedia({ muted: true, currentTime: 3700, duration: 7200 })),
    "⏸ 🔇 50% · 1x · 1:01:40/2:00:00 · Esc");
  assert.equal(h.status(fakeMedia({ duration: Infinity })), "⏸ 🔊 50% · 1x · 01:40/live · Esc");
});

test("the media keys are claimed before scroll and the single-key shortcuts, and only there", () => {
  const normal = slice("function handleNormalKey(event)", "// This frame's share of a hint round");
  const claim = normal.indexOf("if (handleMediaKey(event, key)) return;");
  assert.notEqual(claim, -1);
  assert.ok(claim < normal.indexOf("if (scrollHeldSurface(key, event.shiftKey))"), "before a held scroll area");
  assert.ok(claim < normal.indexOf("const action = normalKeyActions.get(key);"), "before j/k/m as shortcuts");
  assert.ok(claim > normal.indexOf("if (eventIsEditable(event))"), "never while typing in a field");
  assert.ok(claim > normal.indexOf("if (insertMode)"), "never in insert mode");
});

test("f and v both hold media through the same holdMedia", () => {
  // `v`: a video or audio is its own kind, orange, and picking it holds it.
  const visual = slice("function visualClass(element)", "function scrollableTargets()");
  assert.match(visual, /"video", "audio"/);
  assert.match(visual, /isMediaElement\(element\) \? "media"/);
  assert.match(electron, /media: \{ fill: "#fcad70"/);
  assert.match(electron, /\["media", "media"\]/);
  const enter = slice("function enterVisual(item)", "function startVisual()");
  assert.match(enter, /item\.kind === "media"\) \{\s*holdMedia\(item\);/);

  // `f`: the hint on the element itself holds it; its buttons keep doing what they did.
  const draw = slice("function drawHints(space)", "// --- agent bridge ---");
  const pick = draw.slice(draw.indexOf("const onPick"));
  assert.ok(pick.indexOf("performMediaControl(item)") < pick.indexOf("holdMedia(item)"),
    "play/mute/fullscreen buttons are still pressed, not held");
  assert.match(pick, /!item\.mediaControl && isMediaElement\(item\.element\)\) \{\s*send\("hint-done"\);\s*holdMedia\(item\);/);
  // A video with the browser's own controls gets that element-level hint too.
  const controls = slice("function mediaControlTargets(media)", "function pointerIntentTargets(roots)");
  assert.match(controls, /return \[whole, \.\.\.controls\.map/);
});

test("the v round shows the players' control bars without collecting again", () => {
  const draw = slice("function drawHints(space)", "const points = mediaHoverPoints();");
  assert.match(draw, /if \(players\.length\) nudgeMediaPointer\(players\);\s*startPicker\(targets, "hint", pickVisualTarget, space, "visual"\);\s*startMediaHoverLoop\(players\);/);
  assert.doesNotMatch(draw.slice(draw.indexOf('pendingRoundKind === "visual"')), /setTimeout/,
    "a shared round's targets are the ones already counted");
});
