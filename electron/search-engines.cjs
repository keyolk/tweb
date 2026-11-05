"use strict";
// Where an omnibox search goes, and where its suggestions come from (`search.engine`,
// `search.suggest` in config.toml).
//
// The search half replaces a hard-coded Google URL. The suggestion half is new: the omnibox only ever
// matched history and open tabs, so a query nobody had typed before offered nothing. Both lists of
// endpoints are the ones zenbu-labs/terminal-browser ships (shared/src/config/search.ts), which
// already settled which providers answer an anonymous request with OpenSearch JSON.
//
// Suggestions are OFF unless asked for. Turning them on sends every keystroke typed in the omnibox
// to the provider — including URLs being typed, which can carry tokens. That is the browser norm, and
// it is still a decision for the user to make, not a default to inherit.

const ENGINES = {
  google: {
    search: "https://www.google.com/search?q=%s",
    suggest: "https://suggestqueries.google.com/complete/search?client=firefox&q=%s",
  },
  duckduckgo: {
    search: "https://duckduckgo.com/?q=%s",
    suggest: "https://duckduckgo.com/ac/?q=%s&type=list",
  },
  bing: {
    search: "https://www.bing.com/search?q=%s",
    suggest: "https://api.bing.com/osjson.aspx?query=%s",
  },
  brave: {
    search: "https://search.brave.com/search?q=%s",
    suggest: "https://search.brave.com/api/suggest?q=%s",
  },
  kagi: {
    search: "https://kagi.com/search?q=%s",
    suggest: "https://kagi.com/api/autosuggest?q=%s",
  },
  ecosia: {
    search: "https://www.ecosia.org/search?q=%s",
    suggest: "https://ac.ecosia.org/?q=%s",
  },
  perplexity: {
    search: "https://www.perplexity.ai/search?q=%s",
    suggest: null,
  },
};

const DEFAULT_ENGINE = "google";

// Keyword searches: `gh tweb` in the omnibox searches GitHub for "tweb". The first word picks the
// site, the rest is the query — Chrome's site search and Vimium's search engines, without leaving the
// keyboard for a site's own search box. `search.keywords` adds or replaces entries as `keyword=engine`
// or `keyword=https://…%s…`.
//
// Only short keywords that are not words anyone starts a search with. `w` for Wikipedia is the one
// exception, and the price is small: `w foo` with nothing else typed is a Wikipedia search, and the
// omnibox's top row says so before Enter.
const DEFAULT_KEYWORDS = {
  g: { label: "Google", template: ENGINES.google.search },
  d: { label: "DuckDuckGo", template: ENGINES.duckduckgo.search },
  b: { label: "Bing", template: ENGINES.bing.search },
  p: { label: "Perplexity", template: ENGINES.perplexity.search },
  gh: { label: "GitHub", template: "https://github.com/search?q=%s&type=repositories" },
  ghc: { label: "GitHub code", template: "https://github.com/search?q=%s&type=code" },
  yt: { label: "YouTube", template: "https://www.youtube.com/results?search_query=%s" },
  w: { label: "Wikipedia", template: "https://en.wikipedia.org/w/index.php?search=%s" },
  nv: { label: "Naver", template: "https://search.naver.com/search.naver?query=%s" },
  mdn: { label: "MDN", template: "https://developer.mozilla.org/en-US/search?q=%s" },
  npm: { label: "npm", template: "https://www.npmjs.com/search?q=%s" },
  crates: { label: "crates.io", template: "https://crates.io/search?q=%s" },
  pkg: { label: "Go packages", template: "https://pkg.go.dev/search?q=%s" },
  tr: { label: "Google Translate", template: "https://translate.google.com/?sl=auto&tl=ko&text=%s" },
};

const KEYWORD_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,15}$/i;

function hostLabel(template) {
  try {
    return new URL(template.replace("%s", "q")).hostname.replace(/^www\./, "");
  } catch {
    return template;
  }
}

/**
 * The keyword table: the defaults with `search.keywords` laid over them. An entry that does not parse
 * — no `=`, a keyword with spaces, a template without `%s` — is skipped rather than failing the rest.
 * `keyword=` with nothing after it removes a default.
 */
function keywordTable(entries) {
  const table = new Map(Object.entries(DEFAULT_KEYWORDS).map(([keyword, entry]) => [keyword, { keyword, ...entry }]));
  for (const raw of Array.isArray(entries) ? entries : []) {
    const text = String(raw || "").trim();
    const split = text.indexOf("=");
    if (split <= 0) continue;
    const keyword = text.slice(0, split).trim().toLowerCase();
    const target = text.slice(split + 1).trim();
    if (!KEYWORD_PATTERN.test(keyword)) continue;
    if (!target) {
      table.delete(keyword);
      continue;
    }
    const named = ENGINES[target.toLowerCase()];
    const chosen = template(target, "search");
    if (!chosen) continue;
    const label = named ? target.charAt(0).toUpperCase() + target.slice(1).toLowerCase() : hostLabel(chosen);
    table.set(keyword, { keyword, label, template: chosen });
  }
  return [...table.values()];
}

/** `gh tweb` → the GitHub search for "tweb", or null when the first word is no keyword or nothing follows it. */
function keywordSearch(input, table) {
  const match = /^(\S+)\s+(\S[\s\S]*)$/.exec(String(input || "").trim());
  if (!match) return null;
  const entry = (table || []).find((candidate) => candidate.keyword === match[1].toLowerCase());
  if (!entry) return null;
  const query = match[2].trim();
  return { keyword: entry.keyword, label: entry.label, query, url: entry.template.replace("%s", encodeURIComponent(query)) };
}

// A setting is either an engine name or a URL template. A template must be http(s) and carry `%s`,
// or the query would silently go nowhere.
function template(setting, field) {
  const value = String(setting || "").trim();
  const named = ENGINES[value.toLowerCase()];
  if (named) return named[field];
  if (/^https?:\/\//i.test(value) && value.includes("%s")) return value;
  return null;
}

/** The URL a search for `query` opens. An unusable setting falls back to the default engine. */
function searchUrl(query, setting) {
  const chosen = template(setting, "search") || ENGINES[DEFAULT_ENGINE].search;
  return chosen.replace("%s", encodeURIComponent(query));
}

/** The URL to fetch suggestions for `query` from, or null when suggestions are off or unavailable. */
function suggestUrl(query, setting) {
  const value = String(setting || "").trim().toLowerCase();
  if (!value || value === "off" || !String(query || "").trim()) return null;
  const chosen = template(setting, "suggest");
  return chosen ? chosen.replace("%s", encodeURIComponent(query)) : null;
}

/**
 * Suggestions from a provider's reply. Most answer OpenSearch `[query, [suggestions], ...]`; Ecosia
 * answers `{ suggestions: [...] }`. Anything else is no suggestions rather than an error — a provider
 * changing its format must not break the omnibox.
 */
function parseSuggestions(body, limit = 5) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed[1] : parsed?.suggestions;
  if (!Array.isArray(list)) return [];
  return list.filter((item) => typeof item === "string" && item.trim()).slice(0, limit);
}

module.exports = {
  ENGINES, DEFAULT_ENGINE, DEFAULT_KEYWORDS, searchUrl, suggestUrl, parseSuggestions, keywordTable, keywordSearch,
};
