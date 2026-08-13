"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseHistoryLines,
  startOfDay,
  dayLabel,
  formatVisitTime,
  matchesQuery,
  historyDays,
  removeEntries,
  appendedSince,
  compactLines,
} = require("./history-view.cjs");

// A fixed local instant, so the Today/Yesterday arithmetic is not a race with the clock.
const NOW = new Date(2026, 7, 14, 14, 30, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function at(daysAgo, hour, minute = 0) {
  const date = new Date(NOW);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

function line(url, title, when) {
  return JSON.stringify({ url, title, at: when });
}

test("parsing keeps well-formed entries and skips torn lines", () => {
  const entries = parseHistoryLines([
    line("https://a.test/", "A", NOW),
    "",
    '{"url":"https://torn.test/","tit',
    "   ",
    line("https://b.test/", "B", NOW - 1000),
  ]);
  assert.deepEqual(entries.map((entry) => entry.url), ["https://a.test/", "https://b.test/"]);
});

test("an entry without a usable timestamp cannot be placed on a day, so it is dropped", () => {
  const entries = parseHistoryLines([
    JSON.stringify({ url: "https://a.test/", title: "A" }),
    JSON.stringify({ url: "https://b.test/", title: "B", at: "not a number" }),
    JSON.stringify({ title: "no url", at: NOW }),
    line("https://c.test/", "C", NOW),
  ]);
  assert.deepEqual(entries.map((entry) => entry.url), ["https://c.test/"]);
});

test("the title falls back to the URL", () => {
  const [entry] = parseHistoryLines([JSON.stringify({ url: "https://a.test/", at: NOW })]);
  assert.equal(entry.title, "https://a.test/");
});

test("days start at local midnight, not UTC", () => {
  const justAfterMidnight = new Date(2026, 7, 14, 0, 5).getTime();
  const justBeforeMidnight = new Date(2026, 7, 13, 23, 55).getTime();
  assert.equal(startOfDay(justAfterMidnight), new Date(2026, 7, 14).getTime());
  assert.notEqual(startOfDay(justAfterMidnight), startOfDay(justBeforeMidnight));
});

test("day labels name today and yesterday, then fall back to the date", () => {
  assert.equal(dayLabel(startOfDay(NOW), NOW), "Today");
  assert.equal(dayLabel(startOfDay(NOW - DAY), NOW), "Yesterday");
  assert.equal(dayLabel(startOfDay(at(3, 12)), NOW), "Tue, Aug 11");
});

test("an older year is spelled out, the current one is not", () => {
  const lastYear = new Date(2025, 11, 24, 9, 0).getTime();
  assert.equal(dayLabel(startOfDay(lastYear), NOW), "Wed, Dec 24 2025");
  assert.equal(dayLabel(startOfDay(new Date(2026, 0, 2, 9, 0).getTime()), NOW), "Fri, Jan 2");
});

test("visit times are zero-padded local 24h", () => {
  assert.equal(formatVisitTime(new Date(2026, 7, 14, 9, 5).getTime()), "09:05");
  assert.equal(formatVisitTime(new Date(2026, 7, 14, 23, 59).getTime()), "23:59");
});

test("every search term must appear, in the title or the URL, case-insensitively", () => {
  const entry = { title: "Rust Async Book", url: "https://rust-lang.github.io/async-book/" };
  assert.ok(matchesQuery(entry, ""));
  assert.ok(matchesQuery(entry, "async"));
  assert.ok(matchesQuery(entry, "RUST book"));
  assert.ok(matchesQuery(entry, "github.io"));
  assert.ok(!matchesQuery(entry, "rust python"));
});

test("entries group by day, newest day and newest visit first", () => {
  const entries = parseHistoryLines([
    line("https://a.test/", "A", at(0, 9)),
    line("https://b.test/", "B", at(0, 13)),
    line("https://c.test/", "C", at(1, 20)),
    line("https://d.test/", "D", at(5, 8)),
  ]);
  const { days } = historyDays(entries, { now: NOW });
  assert.deepEqual(days.map((day) => day.label), ["Today", "Yesterday", "Sun, Aug 9"]);
  assert.deepEqual(days[0].rows.map((row) => row.url), ["https://b.test/", "https://a.test/"]);
  assert.deepEqual(days[0].rows.map((row) => row.time), ["13:00", "09:00"]);
});

test("repeat visits collapse per day, keeping the latest visit and its title", () => {
  const entries = parseHistoryLines([
    line("https://a.test/", "a.test", at(0, 9)),
    line("https://a.test/", "Real Title", at(0, 11)),
    line("https://a.test/", "Yesterday's visit", at(1, 22)),
  ]);
  const { days, total } = historyDays(entries, { now: NOW });
  assert.equal(total, 2);
  assert.deepEqual(days.map((day) => day.label), ["Today", "Yesterday"]);
  assert.equal(days[0].rows.length, 1);
  assert.equal(days[0].rows[0].title, "Real Title");
  assert.equal(days[0].rows[0].time, "11:00");
  // The same URL still stands on its own under the other day it was visited.
  assert.equal(days[1].rows[0].title, "Yesterday's visit");
});

test("search reaches the oldest entry, not just the newest page of them", () => {
  const entries = parseHistoryLines([
    line("https://needle.test/", "Needle", at(300, 10)),
    ...Array.from({ length: 500 }, (_, index) =>
      line(`https://hay-${index}.test/`, `Hay ${index}`, at(0, 1, index % 60))),
  ]);
  const { days, total } = historyDays(entries, { now: NOW, query: "needle" });
  assert.equal(total, 1);
  assert.equal(days[0].rows[0].url, "https://needle.test/");
});

test("the row cap is reported rather than passed off as the whole history", () => {
  const entries = parseHistoryLines(Array.from({ length: 30 }, (_, index) =>
    line(`https://a-${index}.test/`, `A ${index}`, at(0, 10, index))));
  const capped = historyDays(entries, { now: NOW, limit: 10 });
  assert.equal(capped.shown, 10);
  assert.equal(capped.total, 30);
  assert.equal(capped.truncated, 20);

  const whole = historyDays(entries, { now: NOW });
  assert.equal(whole.truncated, 0);
  assert.equal(whole.shown, 30);
});

test("an empty history yields no days rather than an empty day", () => {
  assert.deepEqual(historyDays([], { now: NOW }), { days: [], total: 0, shown: 0, truncated: 0 });
});

test("deleting a row removes every visit to that URL on that day, and no other day", () => {
  const lines = [
    line("https://a.test/", "A", at(0, 9)),
    line("https://a.test/", "A again", at(0, 11)),
    line("https://a.test/", "A yesterday", at(1, 22)),
    line("https://b.test/", "B", at(0, 10)),
  ];
  const { lines: kept, removed } = removeEntries(lines, [
    { url: "https://a.test/", dayStart: startOfDay(at(0, 9)) },
  ]);
  assert.equal(removed, 2);
  const remaining = parseHistoryLines(kept);
  assert.deepEqual(remaining.map((entry) => entry.title), ["A yesterday", "B"]);
});

test("deleting several rows at once removes exactly those rows", () => {
  const lines = [
    line("https://a.test/", "A", at(0, 9)),
    line("https://b.test/", "B", at(0, 10)),
    line("https://c.test/", "C", at(1, 10)),
  ];
  const { lines: kept, removed } = removeEntries(lines, [
    { url: "https://a.test/", dayStart: startOfDay(at(0, 9)) },
    { url: "https://c.test/", dayStart: startOfDay(at(1, 10)) },
  ]);
  assert.equal(removed, 2);
  assert.deepEqual(parseHistoryLines(kept).map((entry) => entry.url), ["https://b.test/"]);
});

test("deleting nothing rewrites nothing", () => {
  const lines = [line("https://a.test/", "A", at(0, 9))];
  assert.deepEqual(removeEntries(lines, []), { lines, removed: 0 });
});

test("a torn line survives a delete — rewriting it would lose a concurrent write", () => {
  const torn = '{"url":"https://torn.test/","tit';
  const lines = [line("https://a.test/", "A", at(0, 9)), torn];
  const { lines: kept, removed } = removeEntries(lines, [
    { url: "https://a.test/", dayStart: startOfDay(at(0, 9)) },
  ]);
  assert.equal(removed, 1);
  assert.deepEqual(kept, [torn]);
});

test("a delete target from another day does not match today's row", () => {
  const lines = [line("https://a.test/", "A", at(0, 9))];
  const { lines: kept, removed } = removeEntries(lines, [
    { url: "https://a.test/", dayStart: startOfDay(at(4, 9)) },
  ]);
  assert.equal(removed, 0);
  assert.equal(kept.length, 1);
});

test("a concurrent append is carried across a rewrite instead of being lost", () => {
  const before = `${line("https://a.test/", "A", at(0, 9))}\n`;
  const arrival = line("https://new.test/", "New", at(0, 12));
  const { diverged, lines } = appendedSince(before, `${before}${arrival}\n`);
  assert.equal(diverged, false);
  assert.deepEqual(lines, [arrival]);
});

test("nothing appended means nothing to carry", () => {
  const before = `${line("https://a.test/", "A", at(0, 9))}\n`;
  assert.deepEqual(appendedSince(before, before), { diverged: false, lines: [] });
});

test("a file rewritten underneath is reported as diverged, not merged", () => {
  // Another pane compacted while we were deciding. Our kept lines describe content that
  // no longer exists, so merging them would resurrect what that pane just dropped.
  const before = `${line("https://a.test/", "A", at(0, 9))}\n${line("https://b.test/", "B", at(0, 10))}\n`;
  const compacted = `${line("https://b.test/", "B", at(0, 10))}\n`;
  assert.deepEqual(appendedSince(before, compacted), { diverged: true, lines: [] });
});

test("a truncated file is diverged rather than a negative append", () => {
  assert.equal(appendedSince("abc\ndef\n", "abc\n").diverged, true);
  assert.equal(appendedSince("abc\n", "").diverged, true);
});

test("an append that lands on a row being deleted does not survive the delete", () => {
  // Otherwise the row the user just deleted would reappear the moment it was carried back.
  const doomed = { url: "https://a.test/", dayStart: startOfDay(at(0, 9)) };
  const arrived = [line("https://a.test/", "A again", at(0, 12)), line("https://b.test/", "B", at(0, 13))];
  const { lines: carried } = removeEntries(arrived, [doomed]);
  assert.deepEqual(parseHistoryLines(carried).map((entry) => entry.url), ["https://b.test/"]);
});

// Compaction used to keep "the last N lines". The file is append-per-visit, so that unit
// punishes exactly the pages a user returns to: measured on a real file, 824 lines held 267
// distinct URLs and a 600-line trim would have kept 182 of them.
test("compaction keeps the newest visit per URL, not the last N lines", () => {
  const lines = [
    JSON.stringify({ url: "a", title: "A", at: 1 }),
    JSON.stringify({ url: "b", title: "B", at: 2 }),
    JSON.stringify({ url: "a", title: "A2", at: 3 }),
  ];
  const kept = compactLines(lines);
  assert.equal(kept.length, 2);
  // Oldest-first, like the append-only file it replaces.
  assert.deepEqual(kept.map((line) => JSON.parse(line).url), ["b", "a"]);
  // The surviving `a` is the newest visit, not the first one.
  assert.equal(JSON.parse(kept[1]).at, 3);
});

test("compaction trims to a URL budget, counting URLs not lines", () => {
  // Ten visits, three URLs. A budget of two must drop one URL, not seven lines.
  const lines = [];
  for (let visit = 0; visit < 10; visit++) {
    lines.push(JSON.stringify({ url: `u${visit % 3}`, at: visit }));
  }
  const kept = compactLines(lines, 2);
  assert.equal(kept.length, 2);
  const urls = kept.map((line) => JSON.parse(line).url);
  assert.equal(new Set(urls).size, 2);
  // The two most recently visited URLs survive.
  assert.deepEqual(urls.sort(), ["u0", "u2"].sort());
});

test("compaction reports nothing to do rather than rewriting an identical file", () => {
  // Every rewrite races other panes' appends, so a no-op rewrite is pure risk.
  const lines = [
    JSON.stringify({ url: "a", at: 1 }),
    JSON.stringify({ url: "b", at: 2 }),
  ];
  assert.equal(compactLines(lines, 10), null);
});

test("compaction drops corrupt lines instead of carrying them forward", () => {
  // A truncated write from a killed pane. Compaction is the only place that can clean it.
  const lines = [
    JSON.stringify({ url: "a", at: 1 }),
    '{"url":"b","at":',
    JSON.stringify({ url: "c", at: 3 }),
  ];
  const kept = compactLines(lines, 10);
  assert.deepEqual(kept.map((line) => JSON.parse(line).url), ["a", "c"]);
});
