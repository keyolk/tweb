"use strict";

// Chromium's find is a *session*, and `findNext` in Electron's FindInPageOptions does not
// mean "go to the next match" — it means "this request opens a new session" (true for the
// first request, false for every follow-up). Sending a follow-up when no session is open
// makes Chromium do the search and move the active match but emit no `found-in-page` at
// all, so the caller sees silence rather than an error. That inversion is what made
// find-in-page look completely dead: every fresh query was sent as a follow-up.
//
// The session is tracked here rather than trusted from the pane, because the pane cannot
// know what invalidates it — navigation and a lost renderer end a session without anyone
// asking. The asymmetry also decides which way to guess when the state is uncertain: an
// unneeded `findNext: true` only re-anchors the session at the current match, while a
// wrong `false` loses the result event entirely. So anything doubtful opens a new session.

/** No find session is open for a tab until it asks for one. */
const IDLE = Object.freeze({ active: false, query: "" });

/**
 * Translate a pane-level find request into Electron's options plus the next session state.
 * A changed query starts over — that is what makes the counter read 1/N while typing,
 * the way Chrome's find bar does, rather than walking the matches as the query grows.
 */
function findStep(state, query, forward = true) {
  const continues = Boolean(state?.active) && state.query === query;
  return {
    options: { forward: forward !== false, findNext: !continues },
    state: { active: true, query },
  };
}

/** Anything that ends or invalidates the renderer's session lands back on IDLE. */
function endStep() {
  return { state: IDLE };
}

module.exports = { IDLE, findStep, endStep };
