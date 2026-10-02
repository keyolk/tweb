"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  cachesToClear, cachePaths, isStorageFailure, DISPOSABLE, PRESERVED, DISPOSABLE_LIMIT_BYTES,
} = require("./profile-hygiene.cjs");

// A 1.9GB profile with a missing QuotaManager hung a pane: no frame ever sent, 0% CPU, SIGTERM
// ignored. These are the two guards against arriving there again.

const GB = 1_000_000_000;

test("an ordinary profile is left alone", () => {
  // What a healthy one measured: ~120MB total.
  const { clear, total } = cachesToClear({ Cache: 60e6, "Code Cache": 40e6, "Service Worker": 20e6 });
  assert.deepEqual(clear, []);
  assert.equal(total, 120e6);
});

test("an oversized profile has every cache cleared, not just the biggest", () => {
  // The sizes the hung profile actually had.
  const { clear } = cachesToClear({ Cache: 988e6, "Service Worker": 495e6, "Code Cache": 381e6 });
  // They regrow together, so clearing one at a time would only run again tomorrow.
  assert.deepEqual(clear.sort(), ["Cache", "Code Cache", "Service Worker"]);
});

test("caches that are not there are not named", () => {
  const { clear } = cachesToClear({ Cache: 2 * GB });
  assert.deepEqual(clear, ["Cache"]);
});

test("nothing is cleared at or below the limit, and something is above it", () => {
  assert.deepEqual(cachesToClear({ Cache: DISPOSABLE_LIMIT_BYTES }).clear, []);
  assert.deepEqual(cachesToClear({ Cache: DISPOSABLE_LIMIT_BYTES + 1 }).clear, ["Cache"]);
});

// The whole point of the split: a cache sweep may cost a re-download and must never cost a login.
test("nothing that holds a login or a page's data is disposable", () => {
  for (const kept of PRESERVED) assert.ok(!DISPOSABLE.includes(kept), `${kept} must not be cleared`);
});

test("paths stay inside the profile directory", () => {
  const dir = "/tmp/profile";
  for (const p of cachePaths(dir, DISPOSABLE)) {
    assert.equal(path.dirname(p), dir);
    assert.ok(!p.includes(".."));
  }
});

// The failure is silent — the pane does not crash, it stops, and a stopped pane looks like a slow
// one. Recognising the line is what turns hours of guessing into one sentence.
test("the storage errors that preceded the hang are recognised", () => {
  assert.ok(isStorageFailure(
    "[54407:0930/010143:ERROR:storage/browser/quota/quota_database.cc:989] "
    + "Could not open the quota database, resetting."));
  assert.ok(isStorageFailure(
    "[54407:0930/010144:ERROR:storage/browser/file_system/sandbox_origin_database.cc:198] "
    + "SandboxOriginDatabase failed at: Init@storage/browser/file_system/sandbox_origin_database.cc"));
});

test("ordinary engine chatter is not mistaken for it", () => {
  assert.ok(!isStorageFailure("tweb: frame sent #12 raw"));
  assert.ok(!isStorageFailure("tweb: loaded https://meet.google.com/home (Google Meet)"));
  // A different storage error, which does not precede the hang and must not be reported as it.
  assert.ok(!isStorageFailure(
    "[ERROR:components/services/storage/service_worker/service_worker_storage.cc:1814] "
    + "Failed to delete the database: Database IO error"));
  assert.ok(!isStorageFailure(""));
  assert.ok(!isStorageFailure(null));
});
