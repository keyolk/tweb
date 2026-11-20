"use strict";

// One page, one tab, in a pane.
//
// A pane's tabs are few and walked with J/K, so the same page open twice is a tab to step over and,
// once saved, a tab every restart brings back. They piled up: 54 of 479 saved window sessions held
// the same URL twice or more (the briefs index most often), and 85 of the 98 repeats sat in the
// MIDDLE of the list — an existing tab later sent to a page another tab already showed, not a new
// tab appended. `brief side` does exactly that: `tweb navigate --pane` loads the URL into whichever
// tab is active. And restore re-created the list as saved, repeats included, on every start.
//
// So a page asked for by URL — `tweb navigate`, `tweb tab new`, a pane opened with a URL — goes to
// the tab that already shows it, and a saved session keeps each URL once. What a person does inside
// a page (follow a link, submit a form) is left alone: that is the page's navigation, not a request
// to show a page.

/**
 * The page a URL names: the URL without its fragment, in the form the WHATWG parser writes it.
 *
 * The fragment is a place in the page, not another page: the briefs index keeps its filter in
 * `#t=…`, and asking for the index while a tab shows it filtered is asking for that tab. Parsed so
 * that `file:///a/b%20c.html` and `file:///a/b c.html`, which a tab reports and a CLI sends
 * respectively, are the same page.
 */
function pageKey(url) {
  if (typeof url !== "string" || url.length === 0) return "";
  let href = url;
  try {
    href = new URL(url).href;
  } catch (_) {
    // Not absolute: compared as given.
  }
  const hash = href.indexOf("#");
  return hash >= 0 ? href.slice(0, hash) : href;
}

/**
 * The index of a tab in `urls` showing the page `url` names, other than `except`; -1 when none.
 * The active tab is preferred when it is one of several, then the first.
 */
function tabShowingPage(urls, url, { except = -1, active = -1 } = {}) {
  const key = pageKey(url);
  if (!key || /^(?:about|data):/i.test(key)) return -1;
  if (active !== except && active >= 0 && pageKey(urls[active]) === key) return active;
  return urls.findIndex((candidate, index) => index !== except && pageKey(candidate) === key);
}

/**
 * Session tabs with each URL kept once, the first occurrence, and the active index moved to the
 * tab that survives in place of a dropped one. Exact URLs: two tabs on the same page at different
 * fragments may be two places a person keeps open.
 */
function dedupeSessionTabs(tabs, activeIndex) {
  const kept = [];
  const firstAt = new Map();
  let active = 0;
  tabs.forEach((tab, index) => {
    const seen = firstAt.get(tab.url);
    if (seen === undefined) {
      firstAt.set(tab.url, kept.length);
      if (index === activeIndex) active = kept.length;
      kept.push(tab);
    } else if (index === activeIndex) {
      active = seen;
    }
  });
  if (activeIndex >= tabs.length) active = Math.max(0, kept.length - 1);
  return { tabs: kept, activeIndex: active };
}

module.exports = { dedupeSessionTabs, pageKey, tabShowingPage };
