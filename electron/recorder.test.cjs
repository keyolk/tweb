"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Recording, cleanPageEvent, sensitiveField, timelineMarkdown } = require("./recorder.cjs");

test("a password, card, code or token-like field never keeps its value", () => {
  for (const field of [
    { type: "password", value: "hunter2" },
    { type: "text", name: "otp", value: "SECRET123456" },
    { type: "text", id: "card-number", value: "SECRET4111" },
    { type: "text", autocomplete: "one-time-code", value: "SECRETotc" },
    { type: "text", autocomplete: "cc-number", value: "SECRETcc" },
    { type: "text", name: "api_token", value: "SECRETtok" },
  ]) {
    assert.ok(sensitiveField(field), JSON.stringify(field));
    const event = cleanPageEvent({ kind: "field", selector: "#f", field, url: "https://a.test/" });
    assert.equal(event.redacted, true);
    assert.equal("value" in event, false, JSON.stringify(event));
    assert.doesNotMatch(JSON.stringify(event), new RegExp(field.value));
  }
  const plain = cleanPageEvent({ kind: "field", selector: "#q", field: { type: "search", name: "q", value: "shoes\nred" } });
  assert.equal(plain.value, "shoes red");
  const box = cleanPageEvent({ kind: "field", selector: "#c", field: { type: "checkbox", checked: true, value: "on" } });
  assert.equal(box.checked, true);
  assert.equal("value" in box, false);
});

test("only the page event shapes the timeline knows are kept", () => {
  assert.equal(cleanPageEvent({ kind: "keystroke", key: "a" }), null);
  assert.equal(cleanPageEvent(null), null);
  const click = cleanPageEvent({ kind: "click", selector: "#b", text: "x".repeat(300), extra: "dropped" });
  assert.deepEqual(Object.keys(click).sort(), ["kind", "selector", "text", "url"]);
  assert.ok(click.text.length <= 81);
});

test("events and keyframes are bounded, and the drops are counted", () => {
  const recording = new Recording({ directory: "/r", maxEvents: 2, maxKeyframes: 1, startedAt: 0 });
  assert.ok(recording.record("click", {}, 1));
  assert.ok(recording.record("click", {}, 2));
  assert.equal(recording.record("click", {}, 3), null);
  assert.equal(recording.droppedEvents, 1);
  assert.equal(recording.reserveKeyframe("start", 10), "000-start.jpg");
  assert.equal(recording.reserveKeyframe("click", 20), null);
  assert.equal(recording.skippedKeyframes, 1);
});

test("a timer keyframe needs both a paint since the last one and the interval to have passed", () => {
  const recording = new Recording({ directory: "/r", intervalMs: 5000, startedAt: 0 });
  recording.reserveKeyframe("start", 1000);
  assert.equal(recording.periodicDue(9000), false, "nothing painted");
  recording.dirty = true;
  assert.equal(recording.periodicDue(4000), false, "too soon");
  assert.equal(recording.periodicDue(6000), true);
  recording.reserveKeyframe("change", 6000);
  assert.equal(recording.dirty, false);
  // Never more often than once a second, whatever the caller asks for.
  assert.equal(new Recording({ intervalMs: 10 }).intervalMs, 1000);
});

test("the timeline links each keyframe by absolute path and says what was not captured", () => {
  const recording = new Recording({ directory: "/rec/x", pane: "%1", startedAt: 0 });
  const start = recording.record("start", { url: "https://a.test/" }, 0);
  start.keyframe = recording.reserveKeyframe("start", 0);
  recording.record("click", { selector: "a|b", text: "Next" }, 1500);
  recording.record("field", { selector: "#pw", type: "password", redacted: true }, 2000);
  recording.record("console-error", { message: "boom", source: "app.js", line: 3 }, 2500);
  recording.record("network-failure", { method: "GET", url: "https://a.test/x.json", status: 404 }, 2600);
  recording.endedAt = 4000;
  const text = timelineMarkdown(recording, path.join);
  assert.match(text, /\| \+0\.0s \| start \| https:\/\/a\.test\/ \| \/rec\/x\/000-start\.jpg \|/);
  assert.match(text, /\| \+1\.5s \| click \| `a\\\|b` "Next" \|/);
  assert.match(text, /\| \+2\.0s \| field change \| `#pw` \[password\] → \(value not recorded\) \|/);
  assert.match(text, /console error \| boom \(app\.js:3\)/);
  assert.match(text, /request failed \| GET https:\/\/a\.test\/x\.json → 404/);
  assert.match(text, /Not captured: password/);
  assert.match(recording.summary("/rec/x/timeline.md"),
    /^tweb recording: \/rec\/x\/timeline\.md\n4\.0s from https:\/\/a\.test\/: 0 navigations, 1 clicks, 1 field changes, 1 console errors, 1 failed requests, 1 keyframes\.\n$/);
});

test("the preload redacts with the very same rule before anything leaves the page", () => {
  const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const recorder = fs.readFileSync(path.join(__dirname, "recorder.cjs"), "utf8");
  const pattern = (source, name) => source.match(new RegExp(`const ${name} = (/.*/[a-z]*);`))?.[1];
  assert.equal(pattern(preload, "RECORD_SENSITIVE_NAME"), pattern(recorder, "SENSITIVE_NAME"));
  assert.equal(pattern(preload, "RECORD_SENSITIVE_AUTOCOMPLETE"), pattern(recorder, "SENSITIVE_AUTOCOMPLETE"));
  const change = preload.slice(preload.indexOf("function recordFieldChange("), preload.indexOf('ipcRenderer.on("tweb-recording"'));
  // The value is read only on the non-sensitive branch.
  assert.match(change, /if \(!recordSensitiveField\(field\)\) \{[^}]*field\.value = /);
  assert.equal((change.match(/element\.value/g) || []).length, 1);
});

test("what the engine cannot record is said in the timeline and the summary", () => {
  const recording = new Recording({ directory: "/r", startedAt: 0, unavailable: ["failed requests (x)"] });
  recording.record("start", { url: "https://a.test/" }, 0);
  recording.endedAt = 1000;
  assert.match(timelineMarkdown(recording, path.join), /\n- Not recorded on this engine: failed requests \(x\)\n/);
  assert.match(recording.summary("/r/timeline.md"), / Not recorded on this engine: failed requests \(x\)\.\n$/);
  assert.doesNotMatch(new Recording({ directory: "/r" }).summary("/t"), /Not recorded/);
});

test("a recording made to be learned asks for the site's playbook; an ordinary one does not", () => {
  const learning = new Recording({ directory: "/r", startedAt: 0, learn: true });
  learning.record("start", { url: "https://www.coupang.com/np/search?q=x" }, 0);
  learning.endedAt = 1000;
  const summary = learning.summary("/r/timeline.md");
  assert.match(summary, /^tweb learning: \/r\/timeline\.md\n/);
  assert.match(summary, /\nLearn this flow: .*`tweb playbook path https:\/\/www\.coupang\.com\/np\/search\?q=x`.*\n$/);
  assert.match(timelineMarkdown(learning, path.join), /Recorded to be learned/);

  const plain = new Recording({ directory: "/r", startedAt: 0 });
  plain.record("start", { url: "https://example.com/" }, 0);
  assert.match(plain.summary("/t"), /^tweb recording: /);
  assert.doesNotMatch(plain.summary("/t"), /playbook/);
  assert.doesNotMatch(timelineMarkdown(plain, path.join), /Recorded to be learned/);
});

test("a demonstration an agent asked for names the goal; a declined one asks for nothing", () => {
  const asked = new Recording({ directory: "/r", startedAt: 0, goal: "  buy it\nwith 쿠페이 " });
  assert.equal(asked.learn, true, "asking to be shown is learning");
  assert.equal(asked.goal, "buy it with 쿠페이");
  asked.record("start", { url: "https://www.coupang.com/" }, 0);
  asked.endedAt = 1000;
  assert.match(asked.summary("/r/timeline.md"), /^tweb learning: \/r\/timeline\.md\nAsked to be shown: buy it with 쿠페이\n/);
  assert.match(asked.summary("/r/timeline.md"), /Learn this flow/);
  assert.match(timelineMarkdown(asked, path.join), /\n- The agent asked to be shown: buy it with 쿠페이\n/);

  asked.declined = true;
  assert.equal(asked.summary("/r/timeline.md"), 'tweb learning: declined — the user chose not to show "buy it with 쿠페이" (/r/timeline.md)\n');
  assert.match(timelineMarkdown(asked, path.join), /The user declined/);
  assert.equal(new Recording({ directory: "/r", goal: " " }).goal, null);
});
