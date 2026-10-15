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

module.exports = { ENGINES, DEFAULT_ENGINE, searchUrl, suggestUrl, parseSuggestions };
