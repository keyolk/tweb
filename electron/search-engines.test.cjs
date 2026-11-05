"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { searchUrl, suggestUrl, parseSuggestions, keywordTable, keywordSearch } = require("./search-engines.cjs");

test("the default engine is the one the omnibox always used", () => {
  assert.equal(searchUrl("a b", "google"), "https://www.google.com/search?q=a%20b");
  assert.equal(searchUrl("a b", undefined), "https://www.google.com/search?q=a%20b");
});

test("an engine is chosen by name, case-insensitively", () => {
  assert.equal(searchUrl("tweb", "DuckDuckGo"), "https://duckduckgo.com/?q=tweb");
});

test("a custom template takes the query where %s is", () => {
  assert.equal(searchUrl("x&y", "https://search.example/?q=%s&lang=ko"), "https://search.example/?q=x%26y&lang=ko");
});

test("an unusable setting falls back to the default instead of searching nowhere", () => {
  assert.equal(searchUrl("q", "https://no-placeholder.example/"), "https://www.google.com/search?q=q");
  assert.equal(searchUrl("q", "javascript:alert(%s)"), "https://www.google.com/search?q=q");
});

test("suggestions are off unless asked for, and never for an empty query", () => {
  assert.equal(suggestUrl("tweb", "off"), null);
  assert.equal(suggestUrl("tweb", ""), null);
  assert.equal(suggestUrl("   ", "google"), null);
  assert.match(suggestUrl("tweb", "google"), /^https:\/\/suggestqueries\.google\.com\/.*q=tweb$/);
});

test("an engine without a suggestion endpoint offers none", () => {
  assert.equal(suggestUrl("tweb", "perplexity"), null);
});

test("both reply shapes parse, anything else is no suggestions", () => {
  assert.deepEqual(parseSuggestions('["tw",["tweb","twitch",3]]'), ["tweb", "twitch"]);
  assert.deepEqual(parseSuggestions('{"suggestions":["a","b"]}'), ["a", "b"]);
  assert.deepEqual(parseSuggestions("<html>"), []);
  assert.deepEqual(parseSuggestions('{"other":1}'), []);
  assert.equal(parseSuggestions(JSON.stringify(["q", Array.from({ length: 20 }, (_, i) => `s${i}`)])).length, 5);
});

test("a keyword picks the site and the rest of the line is the query", () => {
  const table = keywordTable([]);
  assert.deepEqual(keywordSearch("gh tweb terminal", table), {
    keyword: "gh",
    label: "GitHub",
    query: "tweb terminal",
    url: "https://github.com/search?q=tweb%20terminal&type=repositories",
  });
  assert.equal(keywordSearch("YT lofi", table).url, "https://www.youtube.com/results?search_query=lofi");
});

test("a keyword alone, or a first word that is no keyword, is not a keyword search", () => {
  const table = keywordTable([]);
  assert.equal(keywordSearch("gh", table), null);
  assert.equal(keywordSearch("gh   ", table), null);
  assert.equal(keywordSearch("hello world", table), null);
});

test("search.keywords adds, replaces and removes entries, and skips what does not parse", () => {
  const table = keywordTable([
    "jira=https://jira.example/issues/?jql=text~%s",
    "gh=duckduckgo",
    "yt=",
    "no-equals",
    "two words=google",
    "bad=https://no-placeholder.example/",
  ]);
  const keywords = table.map((entry) => entry.keyword);
  assert.ok(keywords.includes("jira"));
  assert.ok(!keywords.includes("yt"));
  assert.ok(!keywords.includes("bad"));
  assert.equal(keywordSearch("jira CPLAT-1", table).url, "https://jira.example/issues/?jql=text~CPLAT-1");
  assert.equal(keywordSearch("jira CPLAT-1", table).label, "jira.example");
  assert.deepEqual(
    [keywordSearch("gh x", table).label, keywordSearch("gh x", table).url],
    ["Duckduckgo", "https://duckduckgo.com/?q=x"],
  );
});
