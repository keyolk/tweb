"use strict";

function isRestorableUrl(url) {
  return typeof url === "string"
    && url.length > 0
    && url.length <= 2_000_000
    && !/^(?:about|data):/i.test(url);
}

function clampedZoom(zoom, fallback) {
  return Number.isFinite(zoom) ? Math.min(2, Math.max(0.5, zoom)) : fallback;
}

function activeRestoredIndex(entries, activeIndex) {
  if (entries.length === 0) return 0;
  const requested = Number.isInteger(activeIndex) ? Math.max(0, activeIndex) : 0;
  const next = entries.findIndex((entry) => entry.sourceIndex >= requested);
  return next >= 0 ? next : entries.length - 1;
}

function normalizeWindowSession(parsed, defaultZoomFactor) {
  if (parsed?.version !== 1 || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return null;
  const entries = parsed.tabs.slice(0, 50).flatMap((entry, sourceIndex) => {
    if (!entry || !isRestorableUrl(entry.url)) return [];
    return [{ url: entry.url, zoom: clampedZoom(entry.zoom, defaultZoomFactor), sourceIndex }];
  });
  if (entries.length === 0) return null;
  return {
    tabs: entries.map(({ url, zoom }) => ({ url, zoom })),
    activeIndex: activeRestoredIndex(entries, parsed.activeIndex),
  };
}

function windowSessionForSave(tabs, activeIndex, defaultZoomFactor) {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  const entries = tabs.slice(0, 50).flatMap((entry, sourceIndex) => {
    if (!entry || !isRestorableUrl(entry.url)) return [];
    return [{ url: entry.url, zoom: clampedZoom(entry.zoom, defaultZoomFactor), sourceIndex }];
  });
  if (entries.length === 0) return null;
  return {
    version: 1,
    activeIndex: activeRestoredIndex(entries, activeIndex),
    tabs: entries.map(({ url, zoom }) => ({ url, zoom })),
  };
}

module.exports = { isRestorableUrl, normalizeWindowSession, windowSessionForSave };
