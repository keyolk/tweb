"use strict";

// Which engine a page belongs on, and what to do when the tab showing it is on another one.
//
// A site pinned with engine.<engine>_sites (chrome-sites.cjs) renders on that engine. One pane
// can hold tabs on several engines, so following a pin means replacing the tab with one on the
// pinned engine at the same place — not opening another pane. Cookies do not cross engines:
// each engine is its own browser profile, so a page moved to another engine is signed out there
// until signed in there.
//
// Only a navigation the user made moves a tab: a typed URL, a followed link, a new tab. A server
// redirect does not. An SSO chain is redirects, and moving mid-chain loses the state and PKCE
// cookies the chain was started with, so the sign-in fails rather than merely asking again. A
// redirect onto a pinned site is shown on the engine badge instead, which offers the move.
//
// A tab a pin carried off the pane's own engine goes back when the user leaves for a page with
// no pin: the pin was for that site, not for whatever the tab shows next. A tab moved by hand
// stays where it was put — the user chose that engine for the page, and following its links on
// the same engine is the point of choosing it.

const { PINNABLE_ENGINES, pinnedEngine, siteHost, sitesKey } = require("./chrome-sites.cjs");

const ENGINE_LABELS = { electron: "Electron", chrome: "Chrome", webkit: "WebKit" };

/** The three pin lists as settings hold them. */
function pinLists(settings) {
  const lists = {};
  for (const engine of PINNABLE_ENGINES) lists[engine] = settings.get(sitesKey(engine));
  return lists;
}

/**
 * The pins as the preload matches them: normalised sites, most specific first, ties in
 * PINNABLE_ENGINES order — so the first entry that covers a host is the one `pinnedEngine` picks.
 * The preload is injected as source into Chrome and WebKit frames and cannot require this module.
 */
function pinTable(lists) {
  const rows = [];
  for (const [rank, engine] of PINNABLE_ENGINES.entries()) {
    for (const entry of Array.isArray(lists?.[engine]) ? lists[engine] : []) {
      const site = siteHost(entry);
      if (site) rows.push({ site, engine, rank });
    }
  }
  rows.sort((a, b) => b.site.length - a.site.length || a.rank - b.rank);
  return rows.map(({ site, engine }) => ({ site, engine }));
}

/**
 * What to do with a navigation to `url` from a tab on `tabEngine`.
 *
 * `cause` is "typed", "link" or "new-tab" for a navigation the user made, anything else (a
 * redirect, a script) for one they did not. `availability(engine)` is `{ ok, reason }`.
 * `remote` is a pane whose network goes through --ssh: its proxy is Electron's session, so its
 * pages stay on Electron whatever the pins say.
 *
 * `fromUrl` is the page the tab shows now and `paneEngine` the engine the pane was opened on;
 * together they say whether a pin put the tab where it is (see above). Without them a tab on
 * another engine is taken to have been moved by hand, and stays.
 *
 * Returns `{ action: "stay" }`, `{ action: "switch", engine, site }` (`site` null for a tab
 * going back to the pane's engine), or `{ action: "notice", engine, site, reason }`.
 */
function routeNavigation({ url, tabEngine, lists, cause, availability, remote = false, fromUrl = null, paneEngine = null }) {
  const userMade = cause === "typed" || cause === "link" || cause === "new-tab";
  const pin = pinnedEngine(url, lists);
  if (!pin) {
    if (userMade && returnsHome({ fromUrl, tabEngine, paneEngine, lists }) && availability(paneEngine).ok) {
      return { action: "switch", engine: paneEngine, site: null };
    }
    return { action: "stay" };
  }
  if (pin.engine === tabEngine) return { action: "stay" };
  const { engine, site } = pin;
  if (remote && engine !== "electron") {
    return { action: "notice", engine, site, reason: "--ssh panes stay on Electron" };
  }
  const available = availability(engine);
  if (!available.ok) return { action: "notice", engine, site, reason: available.reason };
  if (userMade) return { action: "switch", engine, site };
  return { action: "notice", engine, site, reason: null };
}

/** Whether the tab is off the pane's engine because the page it shows is pinned there. */
function returnsHome({ fromUrl, tabEngine, paneEngine, lists }) {
  if (!fromUrl || !paneEngine || tabEngine === paneEngine) return false;
  return pinnedEngine(fromUrl, lists)?.engine === tabEngine;
}

/**
 * What the engine badge shows for the active tab, and the switch menu behind it.
 *
 * `emphasis` is "plain" for a page on the pane's own engine with no pin (the badge is quiet),
 * "pinned" for a page on the engine it is pinned to, "other" for an unpinned page moved off the
 * pane's engine by hand, and "mismatch" for a pinned page on another engine — the case the badge
 * exists to show.
 */
function engineBadgeModel({ url, tabEngine, paneEngine, lists, availability, remote = false }) {
  const pin = pinnedEngine(url, lists);
  let emphasis = "plain";
  if (pin && pin.engine !== tabEngine) emphasis = "mismatch";
  else if (pin) emphasis = "pinned";
  else if (tabEngine !== paneEngine) emphasis = "other";
  const choices = ["electron", "chrome", "webkit"].map((engine) => {
    let { ok, reason = null } = availability(engine);
    if (ok && remote && engine !== "electron") {
      ok = false;
      reason = "--ssh panes stay on Electron";
    }
    return {
      engine,
      label: ENGINE_LABELS[engine],
      current: engine === tabEngine,
      pinned: pin?.engine === engine,
      ok,
      reason,
    };
  });
  return {
    engine: tabEngine,
    label: ENGINE_LABELS[tabEngine] || tabEngine,
    paneEngine,
    pin: pin ? { engine: pin.engine, site: pin.site, label: ENGINE_LABELS[pin.engine] } : null,
    emphasis,
    choices,
  };
}

module.exports = { ENGINE_LABELS, engineBadgeModel, pinLists, pinTable, routeNavigation };
