"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildBrowserContextMenu } = require("./context-menu.cjs");

function actions(items) {
  return items.filter((item) => !item.separator).map((item) => item.action);
}

function assertCleanSeparators(items) {
  assert.ok(items.length > 0);
  assert.equal(items[0].separator, undefined);
  assert.equal(items.at(-1).separator, undefined);
  for (let index = 1; index < items.length; index += 1) {
    assert.ok(!(items[index - 1].separator && items[index].separator), "consecutive separators");
  }
}

test("editable context exposes Chromium-style edit commands", () => {
  const items = buildBrowserContextMenu({
    isEditable: true,
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canSelectAll: true,
    },
  });

  assert.deepEqual(actions(items), [
    "undo", "redo", "cut", "copy", "paste", "paste-plain", "select-all",
    "back", "forward", "reload", "inspect",
  ]);
  assert.equal(items.find((item) => item.action === "redo").enabled, false);
  assert.equal(items.find((item) => item.action === "paste-plain").enabled, true);
  assertCleanSeparators(items);
});

test("selection context offers copy and a clipped web search", () => {
  const items = buildBrowserContextMenu({
    selectionText: "  a selection with enough words to exceed the label limit  ",
  });

  assert.deepEqual(actions(items).slice(0, 2), ["copy", "search-selection"]);
  const search = items.find((item) => item.action === "search-selection");
  assert.match(search.label, /^Search for “a selection with enough wor…”$/);
  assertCleanSeparators(items);
});

test("a linked image keeps link and image actions in separate groups", () => {
  const items = buildBrowserContextMenu({
    linkURL: "https://example.com/page",
    mediaType: "image",
    srcURL: "https://example.com/image.png",
  }, { canGoBack: true, canGoForward: false });

  assert.deepEqual(actions(items), [
    "open-link", "open-link-here", "save-link", "copy-link",
    "open-image", "save-image", "copy-image", "copy-image-url",
    "back", "forward", "reload", "inspect",
  ]);
  assert.equal(items.find((item) => item.action === "back").enabled, true);
  assert.equal(items.find((item) => item.action === "forward").enabled, false);
  assertCleanSeparators(items);
});

test("video context offers open, save and address copy", () => {
  const items = buildBrowserContextMenu({
    mediaType: "video",
    srcURL: "https://example.com/movie.mp4",
  });

  assert.deepEqual(actions(items).slice(0, 3), ["open-media", "save-media", "copy-media-url"]);
  assert.match(items.find((item) => item.action === "save-media").label, /video/);
  assertCleanSeparators(items);
});
