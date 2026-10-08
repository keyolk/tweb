"use strict";

// `tweb wait` — poll the page until a condition holds. Kept out of main.cjs so the loop can be
// driven against a fake page: every probe here is injected.

const POLL_INTERVAL_MS = 100;

// The CLI sends every flag, absent ones as `null` (clap's None through serde); the MCP server
// omits them. Both mean "not asked for". Testing `!== undefined` took the CLI's `ms: null` for a
// fixed wait of 0ms, so every `tweb wait --selector/--url/--text/--load` returned `{waited: 0}` —
// printed as `0`, exit 0 — on the first pass without looking at the page at all. Measured on
// SAP Concur (a React SPA) and on a plain file page alike: even a selector matching nothing
// "succeeded" at once.
const given = (value) => value !== undefined && value !== null;

function describe(params) {
  return [
    given(params.selector) && `selector ${params.selector}`,
    given(params.url) && `url containing ${params.url}`,
    given(params.text) && `text ${JSON.stringify(params.text)}`,
    params.load && "load to complete",
  ].filter(Boolean).join(", ");
}

async function waitFor(params, probes) {
  const timeout = given(params.timeout) ? Number(params.timeout) : 10000;
  if (given(params.ms)) {
    await new Promise((resolve) => setTimeout(resolve, Number(params.ms)));
    return { waited: Number(params.ms) };
  }
  const what = describe(params);
  if (!what) throw new Error("nothing to wait for: pass --selector, --url, --text, --load or --ms");
  const deadline = Date.now() + timeout;
  let lastError = null;
  for (;;) {
    try {
      const info = await probes.info();
      // Every condition given has to hold — `--url X --selector Y` is "Y on page X", not either.
      let met = true;
      let result = info;
      if (given(params.url) && !String(info.url || "").includes(params.url)) met = false;
      if (met && params.load && info.readyState !== "complete") met = false;
      if (met && given(params.text) && !(await probes.hasText(params.text))) met = false;
      if (met && given(params.selector)) {
        try {
          // Rendered, not necessarily in view: an element below the fold has appeared.
          result = await probes.query(params.selector, { rendered: true });
        } catch (error) {
          // Not there yet, or there but not visible — both are "keep polling".
          lastError = error;
          met = false;
        }
      }
      if (met) return result;
    } catch (error) {
      // The page is between documents: the old one is gone and the new one's preload has not
      // registered yet, so the probe itself fails. That is the moment a wait right after a
      // navigation lands in, and it is a reason to look again, not an answer.
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const detail = lastError ? ` (last: ${lastError.message || lastError})` : "";
      throw new Error(`timed out after ${timeout}ms waiting for ${what}${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

module.exports = { waitFor };
