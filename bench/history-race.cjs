#!/usr/bin/env node
"use strict";

// Reproduces the history.jsonl append-vs-rewrite race, with and without the lock.
//
// The loss is real but narrow: an append that resolves the old inode after a rewrite's
// rename lands in a file nothing will read again. Measured window on a 900-line file was
// 0.38-0.68ms, so a plain concurrent run almost never hits it — this harness widens the
// window by rewriting in a tight loop while appenders run, which is the same code path a
// user hits when compaction fires during a burst of navigation.
//
//   node bench/history-race.cjs         # with the lock (the shipping path)
//   node bench/history-race.cjs --bare  # without, to see the loss the lock removes

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { fork } = require("node:child_process");
const { withHistoryLock } = require("../electron/history-lock.cjs");

const BARE = process.argv.includes("--bare");
const APPENDS = 400;
const REWRITERS = 3;

function run(file, lockPath, role, count) {
  const guard = BARE ? (_p, body) => body() : withHistoryLock;
  if (role === "append") {
    for (let i = 0; i < count; i += 1) {
      guard(lockPath, () => fs.appendFileSync(file, `${JSON.stringify({ n: i })}\n`));
    }
    return;
  }
  // The rewriter: read, write a temp, rename. Exactly the shape of compactHistory and
  // deleteHistoryEntries, including the re-read that carries arrivals across.
  for (let i = 0; i < count; i += 1) {
    guard(lockPath, () => {
      const before = fs.readFileSync(file, "utf8");
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, before);
      fs.renameSync(temporary, file);
    });
  }
}

if (process.env.HISTORY_RACE_ROLE) {
  run(
    process.env.HISTORY_RACE_FILE,
    `${process.env.HISTORY_RACE_FILE}.lock`,
    process.env.HISTORY_RACE_ROLE,
    Number(process.env.HISTORY_RACE_COUNT)
  );
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tweb-histrace-"));
const file = path.join(dir, "history.jsonl");
fs.writeFileSync(file, "");

const spawn = (role, count) =>
  new Promise((resolve) => {
    const child = fork(__filename, BARE ? ["--bare"] : [], {
      env: {
        ...process.env,
        HISTORY_RACE_ROLE: role,
        HISTORY_RACE_FILE: file,
        HISTORY_RACE_COUNT: String(count),
      },
      stdio: "inherit",
    });
    child.on("exit", resolve);
  });

Promise.all([
  spawn("append", APPENDS),
  ...Array.from({ length: REWRITERS }, () => spawn("rewrite", APPENDS)),
]).then(() => {
  const kept = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim()).length;
  const mode = BARE ? "bare (no lock)" : "locked";
  console.log(`${mode}: appended ${APPENDS}, survived ${kept}, lost ${APPENDS - kept}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = BARE || kept === APPENDS ? 0 : 1;
});
