"use strict";

// `tweb navigate` — load a URL and report where the tab actually ended up.
//
// `loadURL` alone answers the wrong question. In the Chrome engine it resolves as soon as the
// navigation is sent, so the reply named the page being LEFT (measured: navigating from
// example.com to a Concur report answered `https://example.com/`). A load that fails is replaced by
// tweb's own "Can't open this page" data: URL; a script redirect that fails lands there AFTER
// `loadURL` resolved, and the command exited 0 on the error page. And the opposite: Electron
// rejects `loadURL` with ERR_ABORTED for a perfectly good client-side redirect, and for the error
// page superseding a failed load — which made the error message name the error page's data: URL
// instead of the URL that failed.
//
// So the outcome is read off the tab once loading has settled: the failure the tab recorded for
// this navigation, if the tab is still showing its error page, else success at the final URL.

const SETTLE_MS = 400;
const POLL_MS = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function navigate(url, tab, { timeout = 30000, settleMs = SETTLE_MS } = {}) {
  tab.clearFailure();
  let loadError = null;
  try {
    await tab.load(url);
  } catch (error) {
    loadError = error;
  }
  // Settled = not loading for `settleMs` in a row. The quiet period is what catches a redirect
  // started by the page's own script right after its load event.
  const deadline = Date.now() + timeout;
  let quietSince = null;
  while (Date.now() < deadline) {
    if (tab.isLoading()) quietSince = null;
    else if (quietSince === null) quietSince = Date.now();
    else if (Date.now() - quietSince >= settleMs) break;
    await sleep(POLL_MS);
  }
  const failure = tab.failure();
  if (failure && tab.currentUrl() === failure.errorPageUrl) {
    const error = new Error(`${failure.description} (${failure.code}) loading ${failure.url}`);
    error.code = failure.description;
    throw error;
  }
  // A rejection with no error page behind it: ERR_ABORTED is a redirect that superseded the load
  // and the tab is on the page it was sent to; anything else is a real failure nobody displayed.
  if (loadError && !/ERR_ABORTED/.test(String(loadError.code || loadError.message))) throw loadError;
  return { url: tab.currentUrl(), title: tab.title() };
}

// `back`, `forward` and `reload` are commands, not hosts. As URLs they became `https://back`,
// which failed DNS and left every following read running on an error page.
const HISTORY_WORDS = new Set(["back", "forward", "reload"]);

function historyWord(input) {
  const value = String(input ?? "").trim().toLowerCase();
  return HISTORY_WORDS.has(value) ? value : null;
}

module.exports = { navigate, historyWord };
