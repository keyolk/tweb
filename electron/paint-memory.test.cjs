"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPaintCollector, minorCollector, PAINT_GC_BYTES } = require("./paint-memory.cjs");
const { releasePixels } = require("./gfx-worker.cjs");

test("collects once the painted bytes reach the budget, then starts counting again", () => {
  let runs = 0;
  const note = createPaintCollector(() => { runs += 1; }, 100);
  assert.equal(note(60), false);
  assert.equal(note(30), false);
  assert.equal(note(10), true);
  assert.equal(runs, 1);
  assert.equal(note(99), false);
  assert.equal(note(1), true);
  assert.equal(runs, 2);
});

test("a still page costs nothing: no bytes, no collection", () => {
  let runs = 0;
  const note = createPaintCollector(() => { runs += 1; }, 1);
  for (const bytes of [0, -5, NaN, undefined]) assert.equal(note(bytes), false);
  assert.equal(runs, 0);
});

test("without a collector it only records", () => {
  const note = createPaintCollector(null, 1);
  assert.equal(note(PAINT_GC_BYTES * 2), false);
});

test("a collector that throws does not take the paint down", () => {
  const note = createPaintCollector(() => { throw new Error("nope"); }, 1);
  assert.equal(note(2), false);
  assert.equal(note(2), false);
});

test("TWEB_PAINT_GC=0 turns it off", () => {
  assert.equal(minorCollector({ TWEB_PAINT_GC: "0" }), null);
});

test("the collector this runtime gives, if any, runs", () => {
  // Node and Electron give one; bun, which runs this suite, has no `--expose-gc` to set and
  // gets null — the engine then frees frames on V8's own schedule, so null must be safe too.
  const collect = minorCollector({});
  assert.ok(collect === null || typeof collect === "function");
  if (collect) collect();
});

test("releasePixels detaches the frame buffer so its memory goes back now", () => {
  const buffer = new ArrayBuffer(1024);
  const view = Buffer.from(buffer);
  releasePixels(buffer);
  assert.equal(buffer.detached, true);
  assert.equal(view.length, 0);
  // Twice, or on nothing, is harmless: the worker's `finally` runs after an error too.
  releasePixels(buffer);
  releasePixels(undefined);
});

test("releasePixels leaves a view into a shared buffer alone", () => {
  // Node's `Buffer.allocUnsafe` under 4KB slices a shared pool like this one: detaching it would
  // break every small Buffer after it. (Built by hand: bun, which runs this suite, has no pool.)
  const pool = new ArrayBuffer(8192);
  const small = Buffer.from(pool, 128, 64);
  releasePixels(small);
  assert.equal(pool.detached, false);
  const owned = Buffer.from(new ArrayBuffer(64 * 1024));
  releasePixels(owned);
  assert.equal(owned.buffer.detached, true);
});
