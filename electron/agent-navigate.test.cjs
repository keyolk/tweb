"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { navigate, historyWord } = require("./agent-navigate.cjs");

const ERROR_PAGE = "data:text/html;charset=utf-8,%3Ch1%3ECan't%20open%20this%20page";

// A tab driven by a script of events: each step is [delayMs, action]. Mirrors how main.cjs feeds
// the module — `did-fail-load` records a failure and swaps in the error page.
function fakeTab({ loadResolvesAfter = 0, loadRejects = null, events = [] } = {}) {
  const state = { url: "https://before.test/", loading: false, failure: null, title: "" };
  const fail = (url, code, description) => {
    state.failure = { url, code, description, errorPageUrl: ERROR_PAGE };
    state.url = ERROR_PAGE;
  };
  return {
    state,
    clearFailure: () => { state.failure = null; },
    failure: () => state.failure,
    isLoading: () => state.loading,
    currentUrl: () => state.url,
    title: () => state.title,
    load: async (url) => {
      state.loading = true;
      for (const [delay, action] of events) setTimeout(() => action(state, fail, url), delay);
      await new Promise((resolve) => setTimeout(resolve, loadResolvesAfter));
      if (loadRejects) throw Object.assign(new Error(loadRejects), { code: loadRejects.split(" ")[0] });
    },
  };
}

const opts = { timeout: 3000, settleMs: 150 };

test("a load that ends on the error page fails with the URL that failed", async () => {
  const tab = fakeTab({
    loadRejects: "ERR_ABORTED (-3) loading 'data:text/html;charset=utf-8,...'",
    events: [[5, (s, fail) => { fail("https://back/", -105, "ERR_NAME_NOT_RESOLVED"); s.loading = false; }]],
  });
  await assert.rejects(navigate("https://back/", tab, opts), (error) => {
    assert.match(error.message, /ERR_NAME_NOT_RESOLVED \(-105\) loading https:\/\/back\//);
    assert.doesNotMatch(error.message, /data:text\/html/);
    return true;
  });
});

test("a script redirect that fails after load still fails the navigate", async () => {
  // `loadURL` resolved on the first document; its script then sent the tab somewhere unreachable.
  const tab = fakeTab({
    events: [
      [10, (s, _f, url) => { s.url = url; s.loading = false; }],
      [60, (s) => { s.loading = true; }],
      [90, (s, fail) => { fail("https://nonexistent.invalid/y", -2, "ERR_FAILED"); s.loading = false; }],
    ],
  });
  await assert.rejects(navigate("file:///jsredir.html", tab, opts), /ERR_FAILED \(-2\) loading https:\/\/nonexistent\.invalid\/y/);
});

test("the reply names the page navigated to, not the one left", async () => {
  // Chrome engine: `loadURL` resolves before the new document commits.
  const tab = fakeTab({ events: [[30, (s, _f, url) => { s.url = url; s.title = "Report"; s.loading = false; }]] });
  assert.deepEqual(await navigate("https://app.test/report/1", tab, opts), { url: "https://app.test/report/1", title: "Report" });
});

test("a client-side redirect that aborts loadURL is a success", async () => {
  const tab = fakeTab({
    loadRejects: "ERR_ABORTED (-3) loading 'https://app.test/'",
    events: [[5, (s) => { s.url = "https://app.test/home"; s.loading = false; }]],
  });
  assert.equal((await navigate("https://app.test/", tab, opts)).url, "https://app.test/home");
});

test("a failure the user has since navigated away from is not reported", async () => {
  const tab = fakeTab({
    events: [
      [5, (s, fail) => { fail("https://a.invalid/", -105, "ERR_NAME_NOT_RESOLVED"); }],
      [20, (s) => { s.url = "https://fallback.test/"; s.loading = false; }],
    ],
  });
  assert.equal((await navigate("https://a.invalid/", tab, opts)).url, "https://fallback.test/");
});

test("history words are commands, not hosts", () => {
  assert.equal(historyWord("back"), "back");
  assert.equal(historyWord(" Forward "), "forward");
  assert.equal(historyWord("reload"), "reload");
  assert.equal(historyWord("back.example.com"), null);
  assert.equal(historyWord("https://back"), null);
});
