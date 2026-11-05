"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  check, createStore, decide, describe, originOf, parseKind, requestKinds,
} = require("./site-permissions.cjs");

test("a media request is split by device", () => {
  assert.deepEqual(requestKinds("media", { mediaTypes: ["audio"] }), ["microphone"]);
  assert.deepEqual(requestKinds("media", { mediaTypes: ["video", "audio"] }), ["camera", "microphone"]);
  assert.deepEqual(requestKinds("media", { mediaType: "video" }), ["camera"]);
  assert.deepEqual(requestKinds("media", {}), ["camera", "microphone"]);
  assert.deepEqual(requestKinds("notifications"), ["notifications"]);
});

// Measured before this: every one of these was granted to every page without a prompt.
test("devices, notifications and clipboard reads are asked, not granted", () => {
  for (const kind of ["camera", "microphone", "notifications", "clipboard-read", "midi"]) {
    assert.equal(decide([kind]), "ask", kind);
  }
});

test("what a page needs and cannot misuse is allowed without asking", () => {
  for (const kind of ["fullscreen", "clipboard-sanitized-write", "mediaKeySystem", "pointerLock", "openExternal"]) {
    assert.equal(decide([kind]), "allow", kind);
  }
});

test("what a terminal cannot serve, and anything unknown, is denied", () => {
  assert.equal(decide(["display-capture"]), "deny");
  assert.equal(decide(["geolocation"]), "deny");
  assert.equal(decide(["something-new"]), "deny");
  assert.equal(decide([]), "deny");
});

test("a remembered decision answers without a prompt, and one refusal refuses the request", () => {
  assert.equal(decide(["microphone"], { microphone: true }), "allow");
  assert.equal(decide(["microphone"], { microphone: false }), "deny");
  assert.equal(decide(["camera", "microphone"], { microphone: true }), "ask");
  assert.equal(decide(["camera", "microphone"], { camera: false, microphone: true }), "deny");
});

test("an undecided check says yes for devices, which are asked on use, and no for notifications", () => {
  assert.equal(check(["microphone"]), true);
  assert.equal(check(["notifications"]), false);
  assert.equal(check(["notifications"], { notifications: true }), true);
  assert.equal(check(["microphone"], { microphone: false }), false);
  assert.equal(check(["display-capture"]), false);
});

test("decisions are keyed by origin; a page without one has none", () => {
  assert.equal(originOf("https://meet.google.com/abc?x=1"), "https://meet.google.com");
  assert.equal(originOf("http://127.0.0.1:8080/a"), "http://127.0.0.1:8080");
  assert.equal(originOf("file:///tmp/a.html"), "file://");
  assert.equal(originOf("data:text/html,x"), null);
  assert.equal(originOf("not a url"), null);
});

test("the store remembers per origin, forgets, and survives an unreadable file", () => {
  const files = new Map([["/p.json", "{not json"]]);
  const store = createStore("/p.json", {
    read: (file) => {
      if (!files.has(file)) throw new Error("ENOENT");
      return files.get(file);
    },
    write: (file, text) => files.set(file, text),
  });
  assert.deepEqual(store.get("https://a.example"), {});
  store.set("https://a.example", ["microphone", "fullscreen"], true);
  store.set("https://a.example", ["camera"], false);
  assert.deepEqual(store.get("https://a.example"), { microphone: true, camera: false });
  assert.deepEqual(JSON.parse(files.get("/p.json")).origins["https://a.example"], { microphone: true, camera: false });
  assert.equal(store.forget("https://a.example"), true);
  assert.equal(store.forget("https://a.example"), false);
  assert.deepEqual(store.get("https://a.example"), {});
});

test("typed kinds and their labels", () => {
  assert.equal(parseKind("mic"), "microphone");
  assert.equal(parseKind("Camera"), "camera");
  assert.equal(parseKind("notifications"), "notifications");
  assert.equal(parseKind("location"), null);
  assert.equal(describe(["camera", "microphone"]), "camera and microphone");
});
