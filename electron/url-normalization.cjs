"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

function normalizeUrl(input, workingDirectory = process.cwd()) {
  const value = (input || "").trim();
  if (!value) return "https://example.com";
  const localPath = path.isAbsolute(value) ? value
    : /^\.{1,2}(?:[\\/]|$)/.test(value) ? path.resolve(workingDirectory, value)
      : null;
  if (localPath) return pathToFileURL(localPath).href;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(value)) {
    return `http://${value}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(about|data|file):/i.test(value)) {
    return value;
  }
  return `https://${value}`;
}

module.exports = { normalizeUrl };
