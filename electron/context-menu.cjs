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
  return clipped ? `“${clipped}” 검색` : "선택한 텍스트 검색";
}

function buildBrowserContextMenu(params, navigation = {}) {
  const editFlags = params?.editFlags || {};
  const mediaType = params?.mediaType || "none";
  const srcURL = String(params?.srcURL || "");
  const items = [];

  if (params?.isEditable) {
    appendGroup(items, [
      { label: "실행 취소", action: "undo", enabled: Boolean(editFlags.canUndo) },
      { label: "다시 실행", action: "redo", enabled: Boolean(editFlags.canRedo) },
    ]);
    appendGroup(items, [
      { label: "잘라내기", action: "cut", enabled: Boolean(editFlags.canCut) },
      { label: "복사", action: "copy", enabled: Boolean(editFlags.canCopy) },
      { label: "붙여넣기", action: "paste", enabled: Boolean(editFlags.canPaste) },
      { label: "서식 없이 붙여넣기", action: "paste-plain", enabled: Boolean(editFlags.canPaste) },
    ]);
    appendGroup(items, [
      { label: "전체 선택", action: "select-all", enabled: Boolean(editFlags.canSelectAll) },
    ]);
  } else if (params?.selectionText) {
    appendGroup(items, [
      { label: "복사", action: "copy", enabled: true },
      { label: selectionLabel(params.selectionText), action: "search-selection", enabled: true },
    ]);
  }

  if (params?.linkURL) {
    appendGroup(items, [
      { label: "링크를 새 탭에서 열기", action: "open-link", enabled: true },
      { label: "링크를 현재 탭에서 열기", action: "open-link-here", enabled: true },
      { label: "링크를 다른 이름으로 저장", action: "save-link", enabled: true },
      { label: "링크 주소 복사", action: "copy-link", enabled: true },
    ]);
  }

  if (mediaType === "image" && srcURL) {
    appendGroup(items, [
      { label: "이미지를 새 탭에서 열기", action: "open-image", enabled: true },
      { label: "이미지를 다른 이름으로 저장", action: "save-image", enabled: true },
      { label: "이미지 복사", action: "copy-image", enabled: true },
      { label: "이미지 주소 복사", action: "copy-image-url", enabled: true },
    ]);
  } else if (["video", "audio"].includes(mediaType) && srcURL) {
    const noun = mediaType === "video" ? "동영상" : "오디오";
    appendGroup(items, [
      { label: `${noun}을 새 탭에서 열기`, action: "open-media", enabled: true },
      { label: `${noun}을 다른 이름으로 저장`, action: "save-media", enabled: true },
      { label: `${noun} 주소 복사`, action: "copy-media-url", enabled: true },
    ]);
  }

  appendGroup(items, [
    { label: "뒤로", action: "back", enabled: Boolean(navigation.canGoBack) },
    { label: "앞으로", action: "forward", enabled: Boolean(navigation.canGoForward) },
    { label: "새로고침", action: "reload", enabled: true },
  ]);
  appendGroup(items, [
    { label: "요소 검사", action: "inspect", enabled: true },
  ]);
  return items;
}

module.exports = { buildBrowserContextMenu };
