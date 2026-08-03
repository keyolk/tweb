
{
  const topFrame = window.top === window;
  let shortcutsEnabled = true;
  let pendingG = false;
  let pendingGTimer = null;
  let pendingZ = false;
  let pendingZTimer = null;
  let pickerState = null;
  let promptHost = null;
  let searchState = null;
  let visualState = null;
  let inspectState = null;
  let tabListState = null;
  let indicatorHost = null;
  let indicatorLabel = null;
  let caretIndicator = null;
  let caretCanvas = null;
  let terminalEditable = null;
  let lastSearch = "";

  const hintAlphabet = "asdfghjklqwertyuiopzxcvbnm";
  const modeLabels = {
    normal: "N",
    insert: "E",
    hint: "H",
    search: "/",
    visual: "V",
    inspect: "I",
    tabs: "T",
    omnibox: "O",
    passthrough: "P",
  };

  function send(action, value) {
    ipcRenderer.send("tweb-shortcut", { action, value });
  }

  function isEditable(element) {
    if (!(element instanceof Element)) return false;
    if (element.isContentEditable) return true;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
    if (element instanceof HTMLInputElement) {
      return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(element.type);
    }
    return false;
  }

  function activeElement() {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (isEditable(active)) return active;
    if (terminalEditable?.isConnected) return terminalEditable;
    return active;
  }

  function eventIsEditable(event) {
    return event.composedPath().some(isEditable) || isEditable(activeElement());
  }

  function requestImplicitSubmit(element) {
    const form = element?.form || element?.closest?.("form");
    if (form instanceof HTMLFormElement) {
      const submitters = [...form.elements].filter((candidate) => {
        if (candidate.disabled) return false;
        if (candidate instanceof HTMLButtonElement) return candidate.type === "submit";
        return candidate instanceof HTMLInputElement && ["submit", "image"].includes(candidate.type);
      });
      const submitter = submitters.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (submitter) form.requestSubmit(submitter);
      else form.requestSubmit();
      return true;
    }
    const container = element?.closest?.('[role="search"],search') || element?.parentElement;
    const submitter = container?.querySelector?.(
      'button[type="submit"]:not(:disabled),input[type="submit"]:not(:disabled),input[type="image"]:not(:disabled),button[aria-label*="Search" i]:not(:disabled),button[aria-label*="검색"]:not(:disabled)'
    );
    if (submitter instanceof HTMLElement) {
      submitter.click();
      return true;
    }
    return false;
  }

  function singleLineTextarea(element) {
    if (!(element instanceof HTMLTextAreaElement)) return false;
    const role = (element.getAttribute("role") || "").toLowerCase();
    const enterKeyHint = (element.enterKeyHint || element.getAttribute("enterkeyhint") || "").toLowerCase();
    return element.rows <= 1
      || ["combobox", "searchbox"].includes(role)
      || element.hasAttribute("aria-autocomplete")
      || ["done", "go", "next", "search", "send"].includes(enterKeyHint);
  }

  function previousCharacter(value, position) {
    if (position <= 0) return 0;
    const next = position - 1;
    return next > 0 && /[\uDC00-\uDFFF]/.test(value[next]) && /[\uD800-\uDBFF]/.test(value[next - 1]) ? next - 1 : next;
  }

  function nextCharacter(value, position) {
    if (position >= value.length) return value.length;
    return position + (/[\uD800-\uDBFF]/.test(value[position]) && /[\uDC00-\uDFFF]/.test(value[position + 1]) ? 2 : 1);
  }

  function textControlDestination(element, key, position) {
    const value = element.value;
    if (key === "ArrowLeft") return previousCharacter(value, position);
    if (key === "ArrowRight") return nextCharacter(value, position);
    if (key === "Home") {
      return element instanceof HTMLTextAreaElement ? value.lastIndexOf("\n", position - 1) + 1 : 0;
    }
    if (key === "End") {
      if (!(element instanceof HTMLTextAreaElement)) return value.length;
      const end = value.indexOf("\n", position);
      return end < 0 ? value.length : end;
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      if (!(element instanceof HTMLTextAreaElement)) return key === "ArrowUp" ? 0 : value.length;
      const lineStart = value.lastIndexOf("\n", position - 1) + 1;
      const column = position - lineStart;
      if (key === "ArrowUp") {
        if (lineStart === 0) return 0;
        const previousEnd = lineStart - 1;
        const previousStart = value.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
        return Math.min(previousStart + column, previousEnd);
      }
      const lineEnd = value.indexOf("\n", position);
      if (lineEnd < 0) return value.length;
      const nextEnd = value.indexOf("\n", lineEnd + 1);
      return Math.min(lineEnd + 1 + column, nextEnd < 0 ? value.length : nextEnd);
    }
    return position;
  }

  function moveTextControlCaret(element, key, extend) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      || element.selectionStart === null || element.selectionEnd === null) return false;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (!extend) {
      const position = key === "ArrowLeft" && start !== end ? start
        : key === "ArrowRight" && start !== end ? end
        : textControlDestination(element, key, end);
      element.setSelectionRange(position, position);
      return true;
    }
    const backward = element.selectionDirection === "backward";
    const anchor = backward ? end : start;
    const focus = backward ? start : end;
    const destination = textControlDestination(element, key, focus);
    element.setSelectionRange(
      Math.min(anchor, destination),
      Math.max(anchor, destination),
      destination < anchor ? "backward" : "forward",
    );
    return true;
  }

  function moveContentEditableCaret(key, extend) {
    const selection = getSelection();
    if (!selection || typeof selection.modify !== "function") return false;
    const motion = {
      ArrowLeft: ["backward", "character"], ArrowRight: ["forward", "character"],
      ArrowUp: ["backward", "line"], ArrowDown: ["forward", "line"],
      Home: ["backward", "lineboundary"], End: ["forward", "lineboundary"],
    }[key];
    if (!motion) return false;
    selection.modify(extend ? "extend" : "move", motion[0], motion[1]);
    return true;
  }

  function performKeyDefault(active, payload, editable) {
    const key = { Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" }[payload.key] || payload.key;
    if (key === "Enter") {
      if (active instanceof HTMLTextAreaElement) {
        if (!payload.shiftKey && singleLineTextarea(active) && requestImplicitSubmit(active)) return;
        document.execCommand("insertText", false, "\n");
        return;
      }
      if (active?.isContentEditable) {
        document.execCommand("insertLineBreak", false, null);
        return;
      }
      if (active instanceof HTMLButtonElement
        || active instanceof HTMLInputElement && ["button", "submit", "image", "reset"].includes(active.type)) {
        active.click();
        return;
      }
      if (active instanceof HTMLInputElement) requestImplicitSubmit(active);
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key)) {
      if (moveTextControlCaret(active, key, Boolean(payload.shiftKey))) return;
      if (active?.isContentEditable && moveContentEditableCaret(key, Boolean(payload.shiftKey))) return;
      if (!editable && key === "Home") scrollTo({ top: 0, behavior: "instant" });
      else if (!editable && key === "End") scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      else if (!editable && key === "ArrowUp") scrollBy({ top: -40, behavior: "instant" });
      else if (!editable && key === "ArrowDown") scrollBy({ top: 40, behavior: "instant" });
      return;
    }
    if (key === "PageUp" || key === "PageDown") {
      if (active instanceof HTMLTextAreaElement && active.scrollHeight > active.clientHeight) {
        active.scrollBy({ top: (key === "PageUp" ? -1 : 1) * active.clientHeight * 0.9, behavior: "instant" });
      } else {
        scrollBy({ top: (key === "PageUp" ? -1 : 1) * innerHeight * 0.9, behavior: "instant" });
      }
      return;
    }
    if (editable && typeof payload.text === "string" && payload.text) {
      document.execCommand("insertText", false, payload.text);
    } else if (editable && key === "Backspace") {
      document.execCommand("delete", false, null);
    }
  }

  function ensureIndicator() {
    if (!topFrame || !document.documentElement || indicatorHost?.isConnected) return;
    const host = document.createElement("div");
    host.id = "__tweb_mode__";
    host.style.cssText = "position:fixed;right:5px;bottom:5px;z-index:2147483647;pointer-events:none";
    const shadow = host.attachShadow({ mode: "closed" });
    const label = document.createElement("div");
    label.style.cssText = [
      "box-sizing:border-box", "min-width:18px", "height:18px", "padding:1px 5px",
      "border:1px solid #ffffff42", "border-radius:4px", "background:#111c", "color:#fff",
      "box-shadow:0 1px 4px #0007", "font:700 11px/14px ui-monospace,SFMono-Regular,Menlo,monospace",
      "text-align:center", "white-space:nowrap", "backdrop-filter:blur(3px)",
    ].join(";");
    shadow.append(label);
    document.documentElement.append(host);
    indicatorHost = host;
    indicatorLabel = label;
  }

  function setMode(mode, detail = "") {
    const root = document.documentElement;
    if (!root) return;
    root.dataset.twebMode = mode;
    root.dataset.twebModeDetail = detail;
    if (!topFrame) {
      if (document.hasFocus()) send("frame-mode", { mode, detail });
      return;
    }
    ensureIndicator();
    const short = modeLabels[mode] || mode.slice(0, 1).toUpperCase();
    indicatorLabel.textContent = detail ? `${short} ${detail}` : short;
    indicatorLabel.title = `TWeb ${mode}${detail ? ` — ${detail}` : ""}`;
    indicatorLabel.style.color = mode === "passthrough" ? "#9aa0a6"
      : mode === "normal" ? "#8ab4f8"
      : mode === "insert" ? "#81c995"
      : "#fdd663";
  }

  function normalMode() {
    if (!shortcutsEnabled) setMode("passthrough");
    else if (isEditable(activeElement())) setMode("insert");
    else setMode("normal");
  }

  function ensureCaretIndicator() {
    if (!topFrame || !document.documentElement || caretIndicator?.isConnected) return;
    const style = document.createElement("style");
    style.id = "__tweb_caret_style__";
    style.textContent = "input,textarea,[contenteditable]:focus{caret-color:#00e5ff!important}";
    (document.head || document.documentElement).append(style);
    const caret = document.createElement("div");
    caret.id = "__tweb_caret__";
    caret.style.cssText = "display:none;position:fixed;z-index:2147483647;width:2px;pointer-events:none;background:#00e5ff;box-shadow:0 0 3px #001bff,0 0 1px #fff";
    document.documentElement.append(caret);
    caretIndicator = caret;
    caretCanvas = document.createElement("canvas").getContext("2d");
  }

  function updateCaretIndicator() {
    if (!topFrame) return;
    ensureCaretIndicator();
    const element = activeElement();
    if (!isEditable(element) || element instanceof HTMLSelectElement) {
      caretIndicator.style.display = "none";
      return;
    }
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height || box.bottom <= 0 || box.top >= innerHeight) {
      caretIndicator.style.display = "none";
      return;
    }
    const computed = getComputedStyle(element);
    let x = box.left + (parseFloat(computed.paddingLeft) || 0) + 1;
    let y = box.top + (parseFloat(computed.paddingTop) || 0) + 1;
    let height = Math.max(12, parseFloat(computed.lineHeight) || (parseFloat(computed.fontSize) || 13) * 1.25);
    caretIndicator.style.display = "block";
    caretIndicator.style.left = `${Math.max(0, Math.min(innerWidth - 2, x))}px`;
    caretIndicator.style.top = `${Math.max(0, y)}px`;
    caretIndicator.style.height = `${Math.min(box.height || height, height)}px`;
    try {
      if (element instanceof HTMLInputElement && caretCanvas) {
        caretCanvas.font = computed.font || `${computed.fontSize} ${computed.fontFamily}`;
        const before = element.value.slice(0, element.selectionStart ?? element.value.length);
        x += caretCanvas.measureText(before).width - element.scrollLeft;
        y = box.top + Math.max(1, (box.height - height) / 2);
      } else if (element instanceof HTMLTextAreaElement) {
        const mirror = document.createElement("div");
        mirror.style.cssText = `position:fixed;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;top:${box.top}px;left:${box.left}px`;
        for (const property of ["font", "letterSpacing", "lineHeight", "padding", "border", "boxSizing", "width"]) {
          mirror.style[property] = computed[property];
        }
        mirror.textContent = element.value.slice(0, element.selectionStart ?? 0);
        const marker = document.createElement("span");
        marker.textContent = "​";
        mirror.append(marker);
        document.documentElement.append(mirror);
        const markerBox = marker.getBoundingClientRect();
        x = markerBox.left - element.scrollLeft;
        y = markerBox.top - element.scrollTop;
        mirror.remove();
      } else if (element.isContentEditable) {
        const selection = getSelection();
        if (selection?.rangeCount) {
          const range = selection.getRangeAt(0).cloneRange();
          range.collapse(true);
          const rangeBox = range.getBoundingClientRect();
          if (rangeBox.left || rangeBox.top) {
            x = rangeBox.left;
            y = rangeBox.top;
            height = rangeBox.height || height;
          }
        }
      }
      caretIndicator.style.left = `${Math.max(0, Math.min(innerWidth - 2, x))}px`;
      caretIndicator.style.top = `${Math.max(0, y)}px`;
      caretIndicator.style.height = `${Math.min(box.height || height, height)}px`;
    } catch (_) {
      // 기본 위치의 indicator는 유지한다.
    }
  }

  function scheduleCaretUpdate() {
    try {
      updateCaretIndicator();
    } catch (_) {
      if (caretIndicator) caretIndicator.style.display = "none";
    }
  }

  const koreanLangmap = new Map(Object.entries({
    "ㅂ": "q", "ㅃ": "Q", "ᄇ": "q", "ᄈ": "Q",
    "ㅈ": "w", "ㅉ": "W", "ᄌ": "w", "ᄍ": "W",
    "ㄷ": "e", "ㄸ": "E", "ᄃ": "e", "ᄄ": "E",
    "ㄱ": "r", "ㄲ": "R", "ᄀ": "r", "ᄁ": "R",
    "ㅅ": "t", "ㅆ": "T", "ᄉ": "t", "ᄊ": "T",
    "ㅛ": "y", "ᅭ": "y", "ㅕ": "u", "ᅧ": "u", "ㅑ": "i", "ᅣ": "i",
    "ㅐ": "o", "ㅒ": "O", "ᅢ": "o", "ᅤ": "O",
    "ㅔ": "p", "ㅖ": "P", "ᅦ": "p", "ᅨ": "P",
    "ㅁ": "a", "ᄆ": "a", "ㄴ": "s", "ᄂ": "s", "ㅇ": "d", "ᄋ": "d",
    "ㄹ": "f", "ᄅ": "f", "ㅎ": "g", "ᄒ": "g",
    "ㅗ": "h", "ᅩ": "h", "ㅓ": "j", "ᅥ": "j", "ㅏ": "k", "ᅡ": "k", "ㅣ": "l", "ᅵ": "l",
    "ㅋ": "z", "ᄏ": "z", "ㅌ": "x", "ᄐ": "x", "ㅊ": "c", "ᄎ": "c", "ㅍ": "v", "ᄑ": "v",
    "ㅠ": "b", "ᅲ": "b", "ㅜ": "n", "ᅮ": "n", "ㅡ": "m", "ᅳ": "m",
  }));

  function physicalKey(event) {
    if (/^Key[A-Z]$/.test(event.code)) {
      const letter = event.code.slice(3).toLowerCase();
      return event.shiftKey ? letter.toUpperCase() : letter;
    }
    if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
    const keys = {
      Slash: event.shiftKey ? "?" : "/",
      Semicolon: event.shiftKey ? ":" : ";",
      Quote: event.shiftKey ? "\"" : "'",
      Comma: event.shiftKey ? "<" : ",",
      Period: event.shiftKey ? ">" : ".",
      BracketLeft: event.shiftKey ? "{" : "[",
      BracketRight: event.shiftKey ? "}" : "]",
      Minus: event.shiftKey ? "_" : "-",
      Equal: event.shiftKey ? "+" : "=",
      Backquote: event.shiftKey ? "~" : "`",
      Backslash: event.shiftKey ? "|" : "\\",
      Escape: "Escape",
      Backspace: "Backspace",
      Enter: "Enter",
      Space: " ",
      Tab: "Tab",
    };
    return keys[event.code] || event.key;
  }

  function visibleRect(element) {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
    for (const rect of element.getClientRects()) {
      if (rect.width < 3 || rect.height < 3) continue;
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) continue;
      return rect;
    }
    return null;
  }

  function collectRoots() {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      for (const element of roots[index].querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    return roots;
  }

  function uniqueVisibleTargets(elements, classify) {
    const seen = new Set();
    const occupied = new Set();
    const targets = [];
    for (const element of elements) {
      if (!(element instanceof Element) || seen.has(element) || element.matches(":disabled,[aria-disabled=true],[inert]")) continue;
      const rect = visibleRect(element);
      if (!rect) continue;
      if (rect.width > innerWidth * 0.98 && rect.height > innerHeight * 0.8) continue;
      const point = `${Math.round(rect.left / 4)},${Math.round(rect.top / 4)}`;
      if (occupied.has(point)) continue;
      seen.add(element);
      occupied.add(point);
      targets.push({ element, rect, ...(classify?.(element) || {}) });
    }
    return targets.sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
  }

  function interactiveTargets() {
    const selector = [
      "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary", "label[for]",
      "[contenteditable=true]", "[onclick]", "[jsaction]:not([jsaction=''])", "[aria-haspopup]", "[aria-controls]",
      "[role=button]", "[role=link]", "[role=menuitem]", "[role=menuitemcheckbox]", "[role=menuitemradio]",
      "[role=option]", "[role=tab]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=treeitem]",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    return uniqueVisibleTargets(collectRoots().flatMap((root) => [...root.querySelectorAll(selector)]));
  }

  function visualTargets() {
    const selector = [
      "a[href]", "img", "picture", "canvas", "svg", "video", "p", "li", "pre", "code", "blockquote",
      "h1", "h2", "h3", "h4", "h5", "h6", "figcaption", "article", "[role=article]", "[role=img]",
      "input:not([type=hidden])", "textarea", "[contenteditable=true]",
    ].join(",");
    return uniqueVisibleTargets(collectRoots().flatMap((root) => [...root.querySelectorAll(selector)]), (element) => {
      const link = element.closest("a[href]");
      const image = element.matches("img,picture,canvas,svg,video,[role=img]")
        ? element.querySelector?.("img,canvas,svg,video") || element
        : null;
      return { kind: isEditable(element) ? "editable" : image ? "image" : link ? "link" : "text", link, image };
    }).filter((item) => item.kind !== "text" || item.element.innerText?.trim());
  }

  function inspectTargets() {
    const excluded = new Set(["html", "head", "body", "style", "script", "link", "meta"]);
    const elements = collectRoots()
      .flatMap((root) => [...root.querySelectorAll("*")])
      .filter((element) => !excluded.has(element.localName) && !element.id.startsWith("__tweb_"));
    return uniqueVisibleTargets(elements).slice(0, 300);
  }

  function hintLabels(count) {
    let width = 1;
    while (hintAlphabet.length ** width < count) width += 1;
    return Array.from({ length: count }, (_, index) => {
      let value = index;
      let label = "";
      for (let position = 0; position < width; position += 1) {
        label = hintAlphabet[value % hintAlphabet.length] + label;
        value = Math.floor(value / hintAlphabet.length);
      }
      return label.padStart(width, hintAlphabet[0]);
    });
  }

  function cancelPicker(restoreMode = true) {
    pickerState?.host.remove();
    pickerState = null;
    if (restoreMode) normalMode();
  }

  function startPicker(targets, mode, onPick) {
    cancelTransient(false);
    if (targets.length === 0) {
      setMode(mode, "0");
      setTimeout(normalMode, 500);
      return;
    }
    const labels = hintLabels(targets.length);
    const host = document.createElement("div");
    host.id = "__tweb_picker__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    const items = targets.map((target, index) => {
      const badge = document.createElement("span");
      badge.textContent = labels[index];
      badge.style.cssText = [
        "position:fixed", `left:${Math.max(0, target.rect.left)}px`, `top:${Math.max(0, target.rect.top)}px`,
        "padding:1px 4px", "border:1px solid #9b6b00", "border-radius:3px", "background:#ffd75f",
        "color:#161616", "box-shadow:0 1px 4px #0008", "font:700 12px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace",
      ].join(";");
      shadow.append(badge);
      return { ...target, label: labels[index], badge };
    });
    document.documentElement.append(host);
    pickerState = { host, items, typed: "", mode, onPick };
    setMode(mode, `${targets.length}`);
  }

  function updatePicker() {
    if (!pickerState) return;
    const matches = pickerState.items.filter((item) => item.label.startsWith(pickerState.typed));
    for (const item of pickerState.items) {
      item.badge.style.display = matches.includes(item) ? "block" : "none";
      item.badge.style.opacity = item.label === pickerState.typed ? "1" : ".9";
    }
    const exact = matches.find((item) => item.label === pickerState.typed);
    if (exact || matches.length === 1 && pickerState.typed.length > 0) {
      const selected = exact || matches[0];
      const onPick = pickerState.onPick;
      cancelPicker(false);
      onPick(selected);
    } else if (matches.length === 0) {
      cancelPicker();
    }
  }

  function handlePickerKey(event, key) {
    if (!pickerState) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === "Escape") {
      cancelPicker();
      return true;
    }
    if (key === "Backspace") {
      pickerState.typed = pickerState.typed.slice(0, -1);
      updatePicker();
      return true;
    }
    const lower = key.toLowerCase();
    if (lower.length === 1 && hintAlphabet.includes(lower)) {
      pickerState.typed += lower;
      updatePicker();
    }
    return true;
  }

  function startHints(newTab) {
    startPicker(interactiveTargets(), "hint", (item) => {
      const link = item.element.closest("a[href]");
      if (newTab && link?.href) send("new-tab", link.href);
      else {
        item.element.focus({ preventScroll: true });
        item.element.click();
      }
      normalMode();
    });
  }

  function cancelPrompt(restoreMode = true) {
    promptHost?.remove();
    promptHost = null;
    if (restoreMode) normalMode();
  }

  function showPrompt(newTab) {
    cancelTransient(false);
    const host = document.createElement("div");
    host.id = "__tweb_omnibox__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = newTab ? "새 탭에서 URL 또는 검색어 열기" : "URL 또는 검색어 열기";
    input.style.cssText = [
      "display:block", "box-sizing:border-box", "width:min(760px,calc(100vw - 32px))", "margin:14px auto",
      "padding:10px 13px", "border:2px solid #f6a723", "border-radius:7px", "outline:0",
      "background:#202124", "color:#f8f9fa", "box-shadow:0 8px 28px #000a",
      "font:16px/1.3 system-ui,-apple-system,sans-serif", "pointer-events:auto",
    ].join(";");
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.code === "Escape") {
        event.preventDefault();
        cancelPrompt();
      } else if (event.code === "Enter") {
        event.preventDefault();
        const value = input.value.trim();
        cancelPrompt();
        send(newTab ? "new-tab" : "navigate", value);
      }
    });
    shadow.append(input);
    document.documentElement.append(host);
    promptHost = host;
    setMode("omnibox");
    requestAnimationFrame(() => input.focus());
  }

  function cancelSearch(clearSelection = true, restoreMode = true) {
    if (!searchState) return;
    searchState.host.remove();
    searchState = null;
    send("stop-find", clearSelection ? "clearSelection" : "keepSelection");
    if (restoreMode) normalMode();
  }

  function showSearch() {
    cancelTransient(false);
    const host = document.createElement("div");
    host.id = "__tweb_search__";
    host.style.cssText = "position:fixed;right:8px;top:8px;z-index:2147483646;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    const box = document.createElement("div");
    box.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 7px;border:1px solid #5f6368;border-radius:6px;background:#202124;color:#fff;box-shadow:0 4px 16px #0008;pointer-events:auto";
    const input = document.createElement("input");
    input.type = "text";
    input.value = lastSearch;
    input.placeholder = "페이지 검색";
    input.autocomplete = "off";
    input.style.cssText = "width:min(320px,55vw);padding:4px 6px;border:0;outline:0;background:#303134;color:#fff;font:13px system-ui";
    const result = document.createElement("span");
    result.style.cssText = "min-width:48px;color:#bdc1c6;font:11px ui-monospace,monospace;text-align:right";
    input.addEventListener("input", () => {
      lastSearch = input.value;
      result.textContent = "";
      if (lastSearch) send("find", { query: lastSearch, forward: true, findNext: false });
      else send("stop-find", "clearSelection");
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.code === "Escape") {
        event.preventDefault();
        cancelSearch(true);
      } else if (event.code === "Enter" && input.value) {
        event.preventDefault();
        lastSearch = input.value;
        const direction = event.shiftKey ? false : true;
        send("find", { query: lastSearch, forward: direction, findNext: false });
        cancelSearch(false);
      }
    });
    box.append(input, result);
    shadow.append(box);
    document.documentElement.append(host);
    searchState = { host, input, result };
    setMode("search");
    requestAnimationFrame(() => input.focus());
  }

  function cancelTabList(restoreMode = true) {
    tabListState?.host.remove();
    tabListState = null;
    if (restoreMode) normalMode();
  }

  function selectTabListIndex(index) {
    if (!tabListState || tabListState.items.length === 0) return;
    const count = tabListState.items.length;
    tabListState.selected = ((index % count) + count) % count;
    for (const [itemIndex, item] of tabListState.items.entries()) {
      const selected = itemIndex === tabListState.selected;
      item.row.style.background = selected ? "#3c4043" : "transparent";
      item.row.style.outline = selected ? "1px solid #8ab4f8" : "none";
    }
    tabListState.items[tabListState.selected].row.scrollIntoView({ block: "nearest" });
    setMode("tabs", `${tabListState.selected + 1}/${count}`);
  }

  function activateSelectedTab() {
    if (!tabListState) return;
    const item = tabListState.items[tabListState.selected];
    if (!item) return;
    cancelTabList(false);
    send("activate-tab", item.tab.index);
  }

  function showTabList() {
    cancelTransient(false);
    setMode("tabs", "…");
    send("list-tabs");
  }

  function renderTabList(model) {
    if (!topFrame || !Array.isArray(model?.tabs)) return;
    cancelTabList(false);
    const host = document.createElement("div");
    host.id = "__tweb_tabs__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:flex-start;justify-content:center;padding-top:8vh;background:#0007;pointer-events:auto";
    const shadow = host.attachShadow({ mode: "open" });
    const panel = document.createElement("div");
    panel.style.cssText = "box-sizing:border-box;width:min(760px,calc(100vw - 32px));max-height:76vh;overflow:auto;padding:8px;border:1px solid #5f6368;border-radius:8px;background:#202124;color:#e8eaed;box-shadow:0 12px 36px #000b;font:13px/1.4 system-ui,-apple-system,sans-serif";
    const title = document.createElement("div");
    title.textContent = `열린 탭 ${model.tabs.length}개 · j/k 이동 · Enter 열기 · 1-9 바로 열기 · Esc`;
    title.style.cssText = "padding:4px 7px 8px;color:#bdc1c6;font-size:12px";
    panel.append(title);
    const items = model.tabs.map((tab, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.style.cssText = "display:grid;grid-template-columns:3ch minmax(0,1fr);gap:8px;width:100%;padding:7px;border:0;border-radius:5px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer";
      const number = document.createElement("span");
      number.textContent = index < 9 ? String(index + 1) : "·";
      number.style.cssText = "color:#8ab4f8;text-align:right";
      const text = document.createElement("span");
      const tabTitle = document.createElement("strong");
      tabTitle.textContent = tab.title || "새 탭";
      tabTitle.style.cssText = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500";
      const url = document.createElement("small");
      url.textContent = tab.url || "about:blank";
      url.style.cssText = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa0a6";
      text.append(tabTitle, url);
      row.append(number, text);
      row.onmouseenter = () => selectTabListIndex(index);
      row.onclick = () => { selectTabListIndex(index); activateSelectedTab(); };
      panel.append(row);
      return { tab, row };
    });
    shadow.append(panel);
    document.documentElement.append(host);
    tabListState = { host, items, selected: 0 };
    selectTabListIndex(Math.max(0, Number(model.activeIndex) || 0));
  }

  function handleTabListKey(event, key) {
    if (!tabListState) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === "Escape") cancelTabList();
    else if (key === "j" || key === "ArrowDown") selectTabListIndex(tabListState.selected + 1);
    else if (key === "k" || key === "ArrowUp") selectTabListIndex(tabListState.selected - 1);
    else if (key === "g" || key === "Home") selectTabListIndex(0);
    else if (key === "G" || key === "End") selectTabListIndex(tabListState.items.length - 1);
    else if (key === "Enter") activateSelectedTab();
    else if (/^[1-9]$/.test(key) && Number(key) <= tabListState.items.length) {
      selectTabListIndex(Number(key) - 1);
      activateSelectedTab();
    }
    return true;
  }

  function targetPoint(item) {
    return {
      x: Math.max(0, Math.floor(item.rect.left + item.rect.width / 2)),
      y: Math.max(0, Math.floor(item.rect.top + item.rect.height / 2)),
    };
  }

  function makeOutline(rect, color) {
    const outline = document.createElement("div");
    outline.style.cssText = [
      "position:fixed", `left:${rect.left}px`, `top:${rect.top}px`, `width:${rect.width}px`, `height:${rect.height}px`,
      `outline:2px solid ${color}`, "outline-offset:1px", "background:transparent", "z-index:2147483645", "pointer-events:none",
    ].join(";");
    document.documentElement.append(outline);
    return outline;
  }

  function flash(message) {
    setMode("normal", message);
    setTimeout(normalMode, 650);
  }

  function updateOutline(outline, rect) {
    outline.style.left = `${rect.left}px`;
    outline.style.top = `${rect.top}px`;
    outline.style.width = `${rect.width}px`;
    outline.style.height = `${rect.height}px`;
  }

  function updateVisualSelection() {
    if (!visualState?.selectionMade) return;
    const selection = getSelection();
    if (!selection?.rangeCount) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (visualState.pageSelection) {
      updateOutline(visualState.outline, { left: 1, top: 1, width: innerWidth - 2, height: innerHeight - 2 });
    } else if (rect.width || rect.height) {
      updateOutline(visualState.outline, rect);
    }
    setMode("visual", `text ${selection.toString().length} h·j·k·l·w·e·b·o`);
  }

  function moveVisualSelection(key) {
    const selection = getSelection();
    if (!visualState?.selectionMade || !selection?.rangeCount || typeof selection.modify !== "function") return false;
    if (key === "o") {
      const anchorNode = selection.anchorNode;
      const anchorOffset = selection.anchorOffset;
      const focusNode = selection.focusNode;
      const focusOffset = selection.focusOffset;
      selection.collapse(focusNode, focusOffset);
      selection.extend(anchorNode, anchorOffset);
      updateVisualSelection();
      return true;
    }
    const motions = {
      h: ["backward", "character"],
      l: ["forward", "character"],
      b: ["backward", "word"],
      w: ["forward", "word"],
      e: ["forward", "word"],
      k: ["backward", "line"],
      j: ["forward", "line"],
      "0": ["backward", "lineboundary"],
      "$": ["forward", "lineboundary"],
    };
    const motion = motions[key];
    if (!motion) return false;
    const anchorNode = selection.anchorNode;
    const anchorOffset = selection.anchorOffset;
    const focusNode = selection.focusNode;
    const focusOffset = selection.focusOffset;
    selection.collapse(focusNode, focusOffset);
    selection.modify("move", motion[0], motion[1]);
    const nextFocusNode = selection.focusNode;
    const nextFocusOffset = selection.focusOffset;
    const target = visualState.element;
    if (nextFocusNode !== target && !target.contains(nextFocusNode)) {
      selection.collapse(anchorNode, anchorOffset);
      selection.extend(focusNode, focusOffset);
      return true;
    }
    selection.collapse(anchorNode, anchorOffset);
    selection.extend(nextFocusNode, nextFocusOffset);
    updateVisualSelection();
    return true;
  }

  function cancelVisual(restoreMode = true) {
    if (!visualState) return;
    visualState.outline.remove();
    if (visualState.selectionMade) getSelection()?.removeAllRanges();
    visualState = null;
    if (restoreMode) normalMode();
  }

  function enterVisual(item) {
    const outline = makeOutline(item.rect, "#fdd663");
    let selectionMade = false;
    if (item.kind === "text") {
      const range = document.createRange();
      range.selectNodeContents(item.element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      selectionMade = true;
    }
    visualState = { ...item, outline, selectionMade };
    if (selectionMade) updateVisualSelection();
    else setMode("visual", `${item.kind} y·Y·u·o·p`);
  }

  function startVisual() {
    startPicker(visualTargets(), "visual", enterVisual);
  }

  function selectPageText() {
    cancelTransient(false);
    const element = document.body || document.documentElement;
    if (!element) return;
    enterVisual({
      element,
      rect: { left: 0, top: 0, width: innerWidth, height: innerHeight },
      kind: "text",
      link: null,
      image: null,
      pageSelection: true,
    });
  }

  function copyVisual(smart = true) {
    if (!visualState) return;
    const item = visualState;
    if (smart && item.kind === "image") {
      send("copy-image", {
        x: Math.max(0, Math.floor(item.rect.left)),
        y: Math.max(0, Math.floor(item.rect.top)),
        width: Math.max(1, Math.ceil(item.rect.width)),
        height: Math.max(1, Math.ceil(item.rect.height)),
      });
    } else if (smart && item.kind === "link" && item.link?.href) {
      send("copy-text", item.link.href);
    } else {
      const selectedText = item.selectionMade ? getSelection()?.toString() || "" : "";
      const text = item.selectionMade ? selectedText : (typeof item.element.value === "string" ? item.element.value
        : item.element.innerText?.trim() || item.element.getAttribute("alt") || item.element.getAttribute("aria-label") || "");
      if (text) send("copy-text", text);
    }
    cancelVisual(false);
    flash("copied");
  }

  function handleVisualKey(event, key) {
    if (!visualState) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === "Escape") cancelVisual();
    else if (moveVisualSelection(key)) return true;
    else if (key === "y") copyVisual(true);
    else if (key === "Y") copyVisual(false);
    else if (key === "u" && visualState.link?.href) {
      send("copy-text", visualState.link.href);
      cancelVisual(false);
      flash("url");
    } else if ((key === "o" || key === "O") && visualState.link?.href) {
      const url = visualState.link.href;
      cancelVisual();
      send(key === "O" ? "new-tab" : "navigate", url);
    } else if (key === "p" && visualState.kind === "editable") {
      visualState.element.focus();
      send("paste");
      cancelVisual(false);
      flash("pasted");
    } else if (key === "d") {
      send("inspect-devtools", targetPoint(visualState));
    }
    return true;
  }

  function cssSelector(element) {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.localName;
      const classes = [...current.classList].filter(Boolean).slice(0, 2);
      if (classes.length) part += classes.map((name) => `.${CSS.escape(name)}`).join("");
      const siblings = current.parentElement ? [...current.parentElement.children].filter((item) => item.localName === current.localName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      current = current.parentElement;
      if (parts.length >= 6) break;
    }
    return parts.join(" > ");
  }

  function cancelInspect(restoreMode = true) {
    if (!inspectState) return;
    inspectState.outline.remove();
    inspectState.panel.remove();
    inspectState = null;
    if (restoreMode) normalMode();
  }

  function enterInspect(item) {
    const element = item.element;
    const selector = cssSelector(element);
    const computed = getComputedStyle(element);
    const outline = makeOutline(item.rect, "#8ab4f8");
    const panel = document.createElement("div");
    const attributes = ["role", "href", "src", "alt", "aria-label"]
      .map((name) => element.getAttribute(name) ? `${name}=${JSON.stringify(element.getAttribute(name))}` : "")
      .filter(Boolean).join(" ");
    const summary = [
      selector,
      `${Math.round(item.rect.width)}×${Math.round(item.rect.height)} @ ${Math.round(item.rect.left)},${Math.round(item.rect.top)}`,
      attributes,
      `display=${computed.display} position=${computed.position} color=${computed.color} font=${computed.fontSize}`,
      "y selector · h HTML · t text · d DevTools · Esc",
    ].filter(Boolean).join("\n");
    panel.textContent = summary;
    panel.style.cssText = [
      "position:fixed", "left:6px", "bottom:6px", "z-index:2147483646", "box-sizing:border-box",
      "max-width:min(760px,calc(100vw - 50px))", "max-height:34vh", "overflow:auto", "padding:7px 9px",
      "border:1px solid #5f6368", "border-radius:5px", "background:#111e", "color:#e8eaed",
      "white-space:pre-wrap", "font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace", "pointer-events:none",
    ].join(";");
    document.documentElement.append(panel);
    inspectState = { ...item, selector, outline, panel };
    setMode("inspect", element.localName);
  }

  function startInspect() {
    startPicker(inspectTargets(), "inspect", enterInspect);
  }

  function handleInspectKey(event, key) {
    if (!inspectState) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const item = inspectState;
    if (key === "Escape") cancelInspect();
    else if (key === "y") {
      send("copy-text", item.selector);
      cancelInspect(false);
      flash("selector");
    } else if (key === "h") {
      send("copy-text", item.element.outerHTML);
      cancelInspect(false);
      flash("html");
    } else if (key === "t") {
      send("copy-text", item.element.innerText || item.element.textContent || "");
      cancelInspect(false);
      flash("text");
    } else if (key === "d") {
      send("inspect-devtools", targetPoint(item));
    }
    return true;
  }

  function resetPendingG() {
    pendingG = false;
    if (pendingGTimer) clearTimeout(pendingGTimer);
    pendingGTimer = null;
  }

  function resetPendingZ() {
    pendingZ = false;
    if (pendingZTimer) clearTimeout(pendingZTimer);
    pendingZTimer = null;
  }

  function cancelTransient(restoreMode = true) {
    cancelPicker(false);
    cancelPrompt(false);
    cancelSearch(true, false);
    cancelVisual(false);
    cancelInspect(false);
    cancelTabList(false);
    document.getElementById("__tweb_context_menu__")?.remove();
    resetPendingG();
    resetPendingZ();
    if (restoreMode) normalMode();
  }

  function hasTransientMode() {
    return Boolean(pickerState || promptHost || searchState || visualState || inspectState || tabListState || pendingG || pendingZ || document.getElementById("__tweb_context_menu__"));
  }

  function handleNormalKey(event) {
    if (!shortcutsEnabled) return;
    const key = physicalKey(event);

    // Escape is handled before defaultPrevented/isComposing/editable checks so one
    // physical press always cancels the current TWeb mode.
    if (key === "Escape" && hasTransientMode()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelTransient();
      return;
    }

    if (handlePickerKey(event, key)) return;
    if (handleVisualKey(event, key)) return;
    if (handleInspectKey(event, key)) return;
    if (handleTabListKey(event, key)) return;
    if (searchState || promptHost) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (eventIsEditable(event)) {
      if (key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        document.activeElement?.blur();
        normalMode();
      } else {
        setMode("insert");
      }
      return;
    }

    if (pendingG) {
      resetPendingG();
      if (key === "g") scrollTo({ top: 0, behavior: "instant" });
      else if (key === "i") document.querySelector("input:not([type=hidden]):not(:disabled),textarea:not(:disabled),[contenteditable=true]")?.focus();
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (pendingZ) {
      resetPendingZ();
      if (key === "i") send("zoom-in");
      else if (key === "o") send("zoom-out");
      else if (key === "z") send("zoom-reset");
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    let handled = true;
    switch (key) {
      case "f": startHints(false); break;
      case "F": startHints(true); break;
      case "v": startVisual(); break;
      case "V": selectPageText(); break;
      case "b": showTabList(); break;
      case "I": startInspect(); break;
      case "/": showSearch(); break;
      case "n": if (lastSearch) send("find", { query: lastSearch, forward: true, findNext: true }); else handled = false; break;
      case "N": if (lastSearch) send("find", { query: lastSearch, forward: false, findNext: true }); else handled = false; break;
      case "h": scrollBy({ left: -90, behavior: "instant" }); break;
      case "j": scrollBy({ top: 90, behavior: "instant" }); break;
      case "k": scrollBy({ top: -90, behavior: "instant" }); break;
      case "l": scrollBy({ left: 90, behavior: "instant" }); break;
      case "d": scrollBy({ top: innerHeight * 0.5, behavior: "instant" }); break;
      case "u": scrollBy({ top: -innerHeight * 0.5, behavior: "instant" }); break;
      case "G": scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }); break;
      case "g": pendingG = true; pendingGTimer = setTimeout(resetPendingG, 800); setMode("normal", "g"); break;
      case "z": pendingZ = true; pendingZTimer = setTimeout(resetPendingZ, 800); setMode("normal", "z"); break;
      case "H": send("history-back"); break;
      case "L": send("history-forward"); break;
      case "J": send("previous-tab"); break;
      case "K": send("next-tab"); break;
      case "t": showPrompt(true); break;
      case "o": showPrompt(false); break;
      case "O": showPrompt(true); break;
      case "x": send("close-tab"); break;
      case "X": send("restore-tab"); break;
      case "r": send("reload"); break;
      default: handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  ipcRenderer.on("tweb-shortcuts-enabled", (_event, enabled) => {
    shortcutsEnabled = Boolean(enabled);
    const root = document.documentElement;
    if (root) root.dataset.twebInputMode = shortcutsEnabled ? "shortcuts" : "passthrough";
    if (!shortcutsEnabled) cancelTransient(false);
    normalMode();
  });

  ipcRenderer.on("tweb-find-result", (_event, result) => {
    if (!searchState) return;
    searchState.result.textContent = result?.matches ? `${result.activeMatchOrdinal}/${result.matches}` : "0/0";
    setMode("search", searchState.result.textContent);
  });

  ipcRenderer.on("tweb-select-all", () => {
    if (topFrame && document.activeElement instanceof HTMLIFrameElement) return;
    if (!topFrame && !document.hasFocus()) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      active.select();
    } else {
      document.execCommand("selectAll");
    }
  });

  ipcRenderer.on("tweb-tabs", (_event, model) => {
    renderTabList(model);
  });

  ipcRenderer.on("tweb-frame-mode", (_event, state) => {
    if (topFrame && state?.mode) setMode(state.mode, state.detail || "");
  });

  ipcRenderer.on("tweb-terminal-text", (_event, text) => {
    if (!shortcutsEnabled || typeof text !== "string" || [...text].length !== 1) return;
    const mapped = koreanLangmap.get(text);
    if (!mapped || eventIsEditable({ composedPath: () => [] })) return;
    // Only the frame that owns focus handles terminal text. The main frame
    // yields when an iframe is focused; background subframes ignore it.
    if (topFrame && document.activeElement instanceof HTMLIFrameElement) return;
    if (!topFrame && !document.hasFocus()) return;
    handleNormalKey({
      key: mapped,
      code: "",
      shiftKey: mapped !== mapped.toLowerCase(),
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      composedPath: () => [],
      preventDefault: () => {},
      stopImmediatePropagation: () => {},
    });
  });

  Object.defineProperty(window, "__twebTerminalWheel", {
    configurable: true,
    value(payload) {
      const cols = Math.max(1, Number(payload.cols) || 1);
      const rows = Math.max(1, Number(payload.rows) || 1);
      const x = Math.min(innerWidth - 1, Math.max(0, (Number(payload.column) - 0.5) * innerWidth / cols));
      const y = Math.min(innerHeight - 1, Math.max(0, (Number(payload.row) - 0.5) * innerHeight / rows));
      const direction = Number(payload.code) & 3;
      const target = document.elementFromPoint(x, y) || document.body;
      target.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        deltaX: direction === 2 ? -100 : direction === 3 ? 100 : 0,
        deltaY: direction === 0 ? -100 : direction === 1 ? 100 : 0,
        shiftKey: Boolean(Number(payload.code) & 4),
        altKey: Boolean(Number(payload.code) & 8),
        ctrlKey: Boolean(Number(payload.code) & 16),
      }));
    },
  });

  Object.defineProperty(window, "__twebTerminalKey", {
    configurable: true,
    value(payload) {
      const active = activeElement() || document.body;
      const editable = isEditable(active);
      const mapped = shortcutsEnabled && !editable ? koreanLangmap.get(payload.key) || payload.key : payload.key;
      let prevented = false;
      let stopped = false;
      const event = {
        key: mapped,
        code: payload.code || "",
        shiftKey: Boolean(payload.shiftKey),
        ctrlKey: Boolean(payload.ctrlKey),
        metaKey: Boolean(payload.metaKey),
        altKey: Boolean(payload.altKey),
        isComposing: false,
        defaultPrevented: false,
        composedPath: () => [active],
        preventDefault() { prevented = true; this.defaultPrevented = true; },
        stopImmediatePropagation() { stopped = true; },
      };
      if (payload.event === "keydown") handleNormalKey(event);
      if (prevented || stopped) return;

      const init = {
        key: payload.key,
        code: payload.code || payload.key,
        bubbles: true,
        cancelable: true,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
      };
      const runDefault = active.dispatchEvent(new KeyboardEvent(payload.event, init));
      if (payload.event !== "keydown") return;
      if (runDefault) performKeyDefault(active, payload, editable);
      if (payload.synthesizeKeyUp) active.dispatchEvent(new KeyboardEvent("keyup", init));
    },
  });

  const isMouseProbe = (event) => event.shiftKey && event.ctrlKey && event.altKey && event.metaKey;
  const suppressMouseProbe = (event) => {
    if (!isMouseProbe(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const captureTerminalEditable = (event) => {
    if (event.button !== 0 || isMouseProbe(event)) return;
    terminalEditable = event.composedPath().find(isEditable) || null;
    if (terminalEditable) {
      terminalEditable.focus({ preventScroll: true });
      if (shortcutsEnabled) setMode("insert");
    } else if (!hasTransientMode()) {
      normalMode();
    }
    scheduleCaretUpdate();
  };
  addEventListener("pointerdown", captureTerminalEditable, true);
  for (const event of ["pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup", "click", "auxclick", "contextmenu"]) {
    addEventListener(event, suppressMouseProbe, true);
  }

  addEventListener("keydown", handleNormalKey, true);
  addEventListener("focusin", () => {
    if (shortcutsEnabled && isEditable(activeElement()) && !searchState && !promptHost) setMode("insert");
    scheduleCaretUpdate();
  }, true);
  addEventListener("focusout", () => requestAnimationFrame(() => {
    if (!hasTransientMode()) normalMode();
    scheduleCaretUpdate();
  }), true);
  for (const event of ["input", "keyup", "click", "selectionchange"]) {
    document.addEventListener(event, scheduleCaretUpdate, true);
  }
  document.addEventListener("scroll", scheduleCaretUpdate, true);
  addEventListener("resize", scheduleCaretUpdate);
  addEventListener("blur", () => {
    cancelPicker(false);
    resetPendingG();
    resetPendingZ();
    scheduleCaretUpdate();
  });

  const initializeDocument = () => {
    document.documentElement.dataset.twebInputMode = shortcutsEnabled ? "shortcuts" : "passthrough";
    ensureIndicator();
    ensureCaretIndicator();
    normalMode();
    scheduleCaretUpdate();
  };
  if (document.documentElement) initializeDocument();
  else addEventListener("DOMContentLoaded", initializeDocument, { once: true });

  // Register only after every listener above is installed. Main then targets
  // this frame for IPC broadcasts without racing preload initialization.
  ipcRenderer.send("tweb-preload-ready");
}
