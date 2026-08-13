"use strict";

function appendGroup(items, group) {
  const enabled = group.filter(Boolean);
  if (enabled.length === 0) return;
  if (items.length > 0) items.push({ separator: true });
  items.push(...enabled);
}

function selectionLabel(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const clipped = normalized.length > 28 ? `${normalized.slice(0, 27)}…` : normalized;
  return clipped ? `Search for “${clipped}”` : "Search for the selected text";
}

function buildBrowserContextMenu(params, navigation = {}) {
  const editFlags = params?.editFlags || {};
  const mediaType = params?.mediaType || "none";
  const srcURL = String(params?.srcURL || "");
  const items = [];

  if (params?.isEditable) {
    appendGroup(items, [
      { label: "Undo", action: "undo", enabled: Boolean(editFlags.canUndo) },
      { label: "Redo", action: "redo", enabled: Boolean(editFlags.canRedo) },
    ]);
    appendGroup(items, [
      { label: "Cut", action: "cut", enabled: Boolean(editFlags.canCut) },
      { label: "Copy", action: "copy", enabled: Boolean(editFlags.canCopy) },
      { label: "Paste", action: "paste", enabled: Boolean(editFlags.canPaste) },
      { label: "Paste without formatting", action: "paste-plain", enabled: Boolean(editFlags.canPaste) },
    ]);
    appendGroup(items, [
      { label: "Select all", action: "select-all", enabled: Boolean(editFlags.canSelectAll) },
    ]);
  } else if (params?.selectionText) {
    appendGroup(items, [
      { label: "Copy", action: "copy", enabled: true },
      { label: selectionLabel(params.selectionText), action: "search-selection", enabled: true },
    ]);
  }

  if (params?.linkURL) {
    appendGroup(items, [
      { label: "Open link in new tab", action: "open-link", enabled: true },
      { label: "Open link in this tab", action: "open-link-here", enabled: true },
      { label: "Save link as", action: "save-link", enabled: true },
      { label: "Copy link address", action: "copy-link", enabled: true },
    ]);
  }

  if (mediaType === "image" && srcURL) {
    appendGroup(items, [
      { label: "Open image in new tab", action: "open-image", enabled: true },
      { label: "Save image as", action: "save-image", enabled: true },
      { label: "Copy image", action: "copy-image", enabled: true },
      { label: "Copy image address", action: "copy-image-url", enabled: true },
    ]);
  } else if (["video", "audio"].includes(mediaType) && srcURL) {
    const noun = mediaType === "video" ? "video" : "audio";
    appendGroup(items, [
      { label: `Open ${noun} in new tab`, action: "open-media", enabled: true },
      { label: `Save ${noun} as`, action: "save-media", enabled: true },
      { label: `Copy ${noun} address`, action: "copy-media-url", enabled: true },
    ]);
  }

  appendGroup(items, [
    { label: "Back", action: "back", enabled: Boolean(navigation.canGoBack) },
    { label: "Forward", action: "forward", enabled: Boolean(navigation.canGoForward) },
    { label: "Reload", action: "reload", enabled: true },
  ]);
  appendGroup(items, [
    { label: "Inspect element", action: "inspect", enabled: true },
  ]);
  return items;
}

module.exports = { buildBrowserContextMenu };
