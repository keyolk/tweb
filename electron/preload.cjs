const { ipcRenderer, webFrame } = require("electron");

// window.print() must never reach Chromium's own handler.
//
// Chromium services a print by opening the platform's print sheet. This window is
// offscreen and `show: false`, so the sheet has nowhere to appear — and the call never
// returns. Measured: the renderer's main thread blocks permanently, `eval` and page-diag
// both time out, the real key path dies, and the pane keeps painting its last frame so it
// still LOOKS healthy. Killing the pane then leaves the frontend orphaned at PPID 1. Sites
// call `window.print()` from their own Print buttons, so a user reaches this without ever
// pressing Ctrl-P.
//
// The replacement has to live in the PAGE's world, not the preload's: with
// contextIsolation the preload's `window` is a different object, so assigning to it leaves
// the page's own `print` untouched. `webFrame.executeJavaScript` runs in the main world.
//
// The script is spelled out here rather than shared with main.cjs because THIS PRELOAD IS
// SANDBOXED: `require` reaches Electron's builtins and nothing else, and requiring a local
// module fails the whole preload with "module not found" — measured, and it takes every
// shortcut and overlay down with it. main.cjs keeps its own copy for the frames it reaches.
//
// The accessor patch is what covers a child frame. Electron's `frame-created` is too late:
// a page that does `f.contentWindow.document.write(...); f.contentWindow.print()` in ONE
// TICK wedges the renderer before an async shim can land, and writing a receipt into a
// hidden iframe and printing THAT is a common real-site pattern. Patching the accessors
// the page must go through to reach a child shims it synchronously, on the very access
// that precedes the call.
//
// `printToPDF` on the engine side does not go through the page and is unaffected.
function installPrintShim() {
  try {
    webFrame.executeJavaScript(`(() => {
      if (window.__twebPrintShim) return "already";
      window.__twebPrintShim = true;
      const notify = () => window.dispatchEvent(new CustomEvent("tweb-print-request"));
      // Configurable so a page that assigns its own print() still can, and writable so the
      // assignment does not throw in strict mode.
      const define = (target) => Object.defineProperty(target, "print", {
        configurable: true,
        writable: true,
        value: function print() { notify(); },
      });
      define(window);
      const shimChild = (child) => {
        try {
          if (!child || child.__twebPrintShim) return;
          child.__twebPrintShim = true;
          Object.defineProperty(child, "print", {
            configurable: true,
            writable: true,
            value: function print() { notify(); },
          });
        } catch (error) {
          // Cross-origin: unreachable from here, and it gets its own preload instead.
        }
      };
      for (const [proto, property] of [
        [window.HTMLIFrameElement && window.HTMLIFrameElement.prototype, "contentWindow"],
        [window.HTMLIFrameElement && window.HTMLIFrameElement.prototype, "contentDocument"],
        [window.HTMLObjectElement && window.HTMLObjectElement.prototype, "contentWindow"],
      ]) {
        if (!proto) continue;
        const descriptor = Object.getOwnPropertyDescriptor(proto, property);
        if (!descriptor || !descriptor.get) continue;
        Object.defineProperty(proto, property, { ...descriptor, get() {
          const value = descriptor.get.call(this);
          shimChild(property === "contentDocument" ? value && value.defaultView : value);
          return value;
        } });
      }
      return "installed";
    })()`);
  } catch (error) {
    // A frame that is already gone cannot be shimmed, and there is nothing to protect.
    void error;
  }
}
installPrintShim();

{
  const topFrame = window.top === window;
  let sameOriginFrame = topFrame;
  if (!topFrame) {
    try {
      sameOriginFrame = top.location.origin === location.origin;
    } catch (_) {
      sameOriginFrame = false;
    }
  }
  const shortcutFrame = topFrame || sameOriginFrame;
  // Mirrors the engine's two flags: vimium normal-mode keys and Cmd bypass.
  let vimiumEnabled = true;
  let bypassEnabled = false;
  // The old shortcutsEnabled folded into vimiumEnabled — bypass does not gate the
  // preload directly (the engine delivers Cmd natively), so only vimium matters here.
  let insertMode = false;
  let mediaHoverTimer = null;
  let mediaHoverNudge = 0;
  let passThroughEscape = false;
  let passThroughEscapeTimer = null;
  let scrollTarget = null;
  let panTarget = null;
  let tabListRefresh = false;
  let pendingG = false;
  let pendingGTimer = null;
  let pendingZ = false;
  let pendingZTimer = null;
  let pickerState = null;
  // The command palette: a fixed-position menu of actions, opened with `c`. Unlike the
  // hint picker this is a static list, not a DOM scan — see DESIGN §15.
  // The palette is a fuzzy-search menu: type letters to filter by label, and the
  // match runs immediately. `j`/`k` + `Enter` is the fallback when the filter
  // leaves more than one entry. There are no keyboard-shortcut hints in the
  // list — shortcuts like `gd`/`gh`/`b` already work from normal mode, and
  // listing them here would only duplicate them. The palette is for actions
  // that do not have a key: "Open in Chrome" is the reason it exists.
  let commandPaletteState = null;
  const commandPaletteEntries = [
    { label: "Open in Chrome", action: () => send("chrome-current") },
    { label: "Fullscreen", action: () => send("toggle-fullscreen") },
  ];
  let promptHost = null;
  let searchState = null;
  // Requests still waiting for a result, and the backstop that un-hides the bar if one
  // never arrives. See hideSearchBarText for why the bar hides itself while searching.
  let searchPending = 0;
  let searchRestoreTimer = null;
  // An `n`/`N` step waiting for its result so it can end the session with the match selected.
  let stepSearchPending = false;
  const FIND_PLACEHOLDER = "Find in page";
  let visualState = null;
  let inspectState = null;
  // The element context the user picked in inspect mode, kept so an agent that
  // asks for it later still gets it. Cleared when inspect mode closes.
  let lastInspectPayload = null;
  let tabListState = null;
  let historyState = null;
  let helpHost = null;
  let contextMenuReturnFocus = null;
  let indicatorHost = null;
  let indicatorLabel = null;
  let inputBadge = null;
  let audioBadge = null;
  let audioState = { muted: false, owner: null };
  let transferBadge = null;
  let transferState = null;
  let downloadsState = null;
  let fileChooserState = null;
  let tabBadge = null;
  let tabPopover = null;
  let tabPopoverPinned = false;
  let tabPopoverTimer = null;
  let indicatorMode = "normal";
  let indicatorDetail = "";
  let tabState = { activeIndex: 0, count: 1, tabs: [{ index: 0, title: "New tab" }] };
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
    history: "≡",
    downloads: "⇣",
    chooser: "⇡",
    omnibox: "O",
    help: "?",
  };

  function send(action, value) {
    ipcRenderer.send("tweb-shortcut", { action, value });
  }

  // Overlays are only worth drawing if they reach the terminal promptly; the
  // frame clock alone can hold them back by a whole idle interval.
  function paintNow() {
    send("repaint");
  }

  function isEditable(element) {
    if (!(isElement(element))) return false;
    if (element.isContentEditable) return true;
    if (isTag(element, "textarea") || isTag(element, "select")) return true;
    if (isTag(element, "input")) {
      return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(element.type);
    }
    return false;
  }

  function activeElement() {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  }

  // Whether THIS frame is the one holding the caret, for the editing commands the engine
  // drives directly (`tweb-select-all`, `tweb-caret-motion`). Those go to every frame in the
  // tab, so each has to decide for itself whether the command was meant for it.
  //
  // Not `document.hasFocus()`, which was the test here and is always false in this browser:
  // every page renders into an offscreen window, and an offscreen window never holds OS
  // focus. Measured — an offscreen BrowserWindow with an input focused reports
  // `{hasFocus: false, activeElement: "input"}`. So a subframe returned early every time,
  // while the main frame yields as soon as its activeElement is the iframe. Between the two
  // guards, a caret inside any iframe was reachable by nobody: Cmd-A did nothing at all.
  //
  // The document's own `activeElement` is the right question and needs no OS focus. A frame
  // that is not the one being typed in has `body` (or null) there, not an editable.
  function frameOwnsCaret() {
    if (topFrame && isTag(document.activeElement, "iframe", "frame")) return false;
    return isEditable(activeElement()) || Boolean(topFrame);
  }

  function eventIsEditable(event) {
    return event.composedPath().some(isEditable) || isEditable(activeElement());
  }

  function requestImplicitSubmit(element) {
    const form = element?.form || element?.closest?.("form");
    if (isTag(form, "form")) {
      const submitters = [...form.elements].filter((candidate) => {
        if (candidate.disabled) return false;
        if (isTag(candidate, "button")) return candidate.type === "submit";
        return isTag(candidate, "input") && ["submit", "image"].includes(candidate.type);
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
    // The Korean literal is match data, not prose: Korean-language pages label their
    // search button in Korean, so translating it away would lose those matches.
    const submitter = container?.querySelector?.(
      'button[type="submit"]:not(:disabled),input[type="submit"]:not(:disabled),input[type="image"]:not(:disabled),button[aria-label*="Search" i]:not(:disabled),button[aria-label*="검색"]:not(:disabled)'
    );
    if (isElement(submitter)) {
      submitter.click();
      return true;
    }
    return false;
  }

  function singleLineTextarea(element) {
    if (!(isTag(element, "textarea"))) return false;
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

  // The editing host the caret is in — `activeElement` when a page focuses the
  // contentEditable itself, otherwise the closest ancestor that is one.
  function contentEditableHost() {
    const active = activeElement();
    if (active?.isContentEditable) return active;
    const node = getSelection()?.anchorNode;
    const element = isElement(node) ? node : node?.parentElement;
    return element?.closest?.("[contenteditable]") || null;
  }

  // How many lines a page is worth in this field. Its own height, not the window's — the
  // key is moving a caret inside the box, and a textarea is routinely much shorter than
  // the viewport. Nine tenths, matching the page keys' own overlap on a scrolled page.
  function textControlPageLines(element) {
    const computed = getComputedStyle(element);
    const lineHeight = parseFloat(computed.lineHeight) || (parseFloat(computed.fontSize) || 13) * 1.25;
    return Math.max(1, Math.floor(element.clientHeight * 0.9 / lineHeight));
  }

  function textControlDestination(element, key, position) {
    const value = element.value;
    // Cmd-Up/Down go to the ends of the field, not of a line — the one motion the
    // per-line arrows below cannot express.
    if (key === "DocumentStart") return 0;
    if (key === "DocumentEnd") return value.length;
    if (key === "ArrowLeft") return previousCharacter(value, position);
    if (key === "ArrowRight") return nextCharacter(value, position);
    if (key === "Home") {
      return isTag(element, "textarea") ? value.lastIndexOf("\n", position - 1) + 1 : 0;
    }
    if (key === "End") {
      if (!(isTag(element, "textarea"))) return value.length;
      const end = value.indexOf("\n", position);
      return end < 0 ? value.length : end;
    }
    if (key === "PageUp" || key === "PageDown") {
      // A page of the field, not of the document. Single-line inputs have no page to move
      // through, so they answer with the ends — which is what a browser does there too.
      if (!(isTag(element, "textarea"))) return key === "PageUp" ? 0 : value.length;
      let destination = position;
      for (let line = 0; line < textControlPageLines(element); line += 1) {
        const next = textControlDestination(element, key === "PageUp" ? "ArrowUp" : "ArrowDown", destination);
        if (next === destination) break;
        destination = next;
      }
      return destination;
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      if (!(isTag(element, "textarea"))) return key === "ArrowUp" ? 0 : value.length;
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
    if (!(isTag(element, "input") || isTag(element, "textarea"))
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
      DocumentStart: ["backward", "documentboundary"],
      DocumentEnd: ["forward", "documentboundary"],
      PageUp: ["backward", "line"], PageDown: ["forward", "line"],
    }[key];
    if (!motion) return false;
    // `selection.modify` has no page granularity, so a page is a run of line steps — the
    // same count the text-control path uses, taken from the editing host's own height.
    const steps = key === "PageUp" || key === "PageDown"
      ? textControlPageLines(contentEditableHost() || document.documentElement)
      : 1;
    for (let step = 0; step < steps; step += 1) {
      selection.modify(extend ? "extend" : "move", motion[0], motion[1]);
    }
    return true;
  }

  function performKeyDefault(active, payload, editable) {
    const key = { Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" }[payload.key] || payload.key;
    if (key === "Enter") {
      if (isTag(active, "textarea")) {
        if (!payload.shiftKey && singleLineTextarea(active) && requestImplicitSubmit(active)) return;
        document.execCommand("insertText", false, "\n");
        return;
      }
      if (active?.isContentEditable) {
        document.execCommand("insertLineBreak", false, null);
        return;
      }
      if (isTag(active, "button")
        || isTag(active, "input") && ["button", "submit", "image", "reset"].includes(active.type)) {
        active.click();
        return;
      }
      if (isTag(active, "input")) requestImplicitSubmit(active);
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key)) {
      if (moveTextControlCaret(active, key, Boolean(payload.shiftKey))) return;
      if (active?.isContentEditable && moveContentEditableCaret(key, Boolean(payload.shiftKey))) return;
      // Through the picked surface, the way `gg`/`G` and `j`/`k` already go. These four
      // called the window directly, so picking an inner pane with `s` moved the page
      // behind it instead — the one thing picking a surface exists to prevent.
      //
      // On a panned surface Home/End now do nothing, because `scrollSurfaceTo` refuses a
      // pan target: there is no "top" of a drag-panned canvas to go to. That matches
      // `gg`/`G`, which have always behaved this way.
      if (!editable && key === "Home") scrollSurfaceTo(0);
      else if (!editable && key === "End") scrollSurfaceTo(scrollSurfaceEnd());
      else if (!editable && key === "ArrowUp") scrollSurfaceBy(0, -40);
      else if (!editable && key === "ArrowDown") scrollSurfaceBy(0, 40);
      return;
    }
    if (key === "PageUp" || key === "PageDown") {
      // A focused field gets the caret motion, exactly as the arrows above do. These two
      // skipped that step and scrolled the page from inside a textarea, which is not what
      // any other editor does with them. A single-line input has no page of its own, so
      // `textControlDestination` answers with the ends there.
      if (moveTextControlCaret(active, key, Boolean(payload.shiftKey))) return;
      if (active?.isContentEditable && moveContentEditableCaret(key, Boolean(payload.shiftKey))) return;
      // A page, not a line. 90px is the line step `j`/`k` use, which made these two keys
      // do the same thing as the ones right next to them. Measured against the scroll
      // surface like `d`/`u`, so an inner pane pages by its own height rather than the
      // window's. Nine tenths rather than the whole thing: browsers leave a few lines of
      // the previous screen behind so the reader can pick the thread back up.
      scrollSurfaceBy(0, (key === "PageUp" ? -0.9 : 0.9) * scrollSurfaceHeight());
      return;
    }
    if (editable && typeof payload.text === "string" && payload.text) {
      document.execCommand("insertText", false, payload.text);
    } else if (editable && key === "Backspace") {
      document.execCommand("delete", false, null);
    }
  }

  function hideTabPopover() {
    clearTimeout(tabPopoverTimer);
    tabPopoverTimer = null;
    tabPopoverPinned = false;
    if (tabPopover) tabPopover.style.display = "none";
    if (tabBadge) tabBadge.setAttribute("aria-expanded", "false");
    if (document.documentElement) document.documentElement.dataset.twebTabPopover = "closed";
    paintNow();
  }

  function scheduleTabPopoverHide() {
    clearTimeout(tabPopoverTimer);
    if (!tabPopoverPinned) tabPopoverTimer = setTimeout(hideTabPopover, 180);
  }

  function showTabPopover(pinned = false) {
    if (!topFrame) return;
    ensureIndicator();
    clearTimeout(tabPopoverTimer);
    tabPopoverTimer = null;
    tabPopoverPinned = pinned;
    tabPopover.replaceChildren();
    for (const tab of tabState.tabs) {
      const button = document.createElement("button");
      button.type = "button";
      button.style.cssText = [
        "display:flex", "width:100%", "gap:7px", "align-items:center", "padding:5px 7px",
        "border:0", "border-radius:4px", "background:transparent", "color:#e8eaed",
        "font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace", "text-align:left",
        "cursor:pointer", "white-space:nowrap",
      ].join(";");
      if (tab.index === tabState.activeIndex) button.style.background = "#8ab4f82b";
      const number = document.createElement("span");
      number.textContent = `${tab.index + 1}`;
      number.style.cssText = "flex:0 0 18px;color:#8ab4f8;text-align:right";
      const title = document.createElement("span");
      title.textContent = tab.title || "New tab";
      title.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis";
      button.append(number, title);
      button.onmouseenter = () => { button.style.background = "#ffffff18"; };
      button.onmouseleave = () => {
        button.style.background = tab.index === tabState.activeIndex ? "#8ab4f82b" : "transparent";
      };
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        hideTabPopover();
        if (tab.index !== tabState.activeIndex) send("activate-tab", tab.index);
      };
      tabPopover.append(button);
    }
    tabPopover.style.display = "block";
    tabBadge.setAttribute("aria-expanded", "true");
    if (document.documentElement) document.documentElement.dataset.twebTabPopover = "open";
    paintNow();
  }

  function ensureIndicator() {
    if (!topFrame || !document.documentElement || indicatorHost?.isConnected) return;
    const host = document.createElement("div");
    host.id = "__tweb_mode__";
    host.style.cssText = "position:fixed;right:5px;bottom:5px;z-index:2147483647;display:flex;gap:4px;align-items:flex-end;pointer-events:none";
    const shadow = host.attachShadow({ mode: "closed" });
    const label = document.createElement("div");
    label.style.cssText = [
      "box-sizing:border-box", "min-width:18px", "height:18px", "padding:1px 5px",
      "border:1px solid #ffffff42", "border-radius:4px", "background:#111c", "color:#fff",
      "box-shadow:0 1px 4px #0007", "font:700 11px/14px ui-monospace,SFMono-Regular,Menlo,monospace",
      "text-align:center", "white-space:nowrap", "backdrop-filter:blur(3px)",
    ].join(";");
    const badge = document.createElement("button");
    badge.type = "button";
    badge.setAttribute("aria-haspopup", "menu");
    badge.setAttribute("aria-expanded", "false");
    badge.style.cssText = [
      "box-sizing:border-box", "height:18px", "padding:1px 6px", "border:1px solid #8ab4f866",
      "border-radius:4px", "background:#111d", "color:#8ab4f8", "box-shadow:0 1px 4px #0007",
      "font:700 11px/14px ui-monospace,SFMono-Regular,Menlo,monospace", "cursor:pointer",
      "white-space:nowrap", "pointer-events:auto", "backdrop-filter:blur(3px)",
    ].join(";");
    // The input badge is muted on purpose: it reports a setting, not what the pane is
    // doing, so it should read as an aside next to the mode rather than compete with it.
    const input = document.createElement("span");
    input.style.cssText = [
      "box-sizing:border-box", "display:none", "height:18px", "padding:1px 6px",
      "border:1px solid #9aa0a666", "border-radius:4px", "background:#111d", "color:#9aa0a6",
      "box-shadow:0 1px 4px #0007", "font:700 11px/14px ui-monospace,SFMono-Regular,Menlo,monospace",
      "white-space:nowrap", "backdrop-filter:blur(3px)",
    ].join(";");
    // Only ever shown when another pane took the speakers. An indicator that is always
    // lit says nothing, and "this pane has audio" is already answered by hearing it.
    const audio = document.createElement("span");
    audio.style.cssText = [
      "box-sizing:border-box", "display:none", "height:18px", "padding:1px 6px",
      "border:1px solid #fdd66366", "border-radius:4px", "background:#111d", "color:#fdd663",
      "box-shadow:0 1px 4px #0007", "font:700 11px/14px ui-monospace,SFMono-Regular,Menlo,monospace",
      "white-space:nowrap", "backdrop-filter:blur(3px)",
    ].join(";");
    // A transfer badge is the terminal's download shelf. It only appears while there is
    // something to say — a running transfer, or one that just finished — because the
    // point of the badge is that the user is TOLD, and a permanent one is furniture.
    const transfer = document.createElement("span");
    transfer.style.cssText = [
      "box-sizing:border-box", "display:none", "max-width:min(46ch,60vw)", "height:18px",
      "padding:1px 6px", "border:1px solid #81c99566", "border-radius:4px", "background:#111d",
      "color:#81c995", "box-shadow:0 1px 4px #0007", "overflow:hidden", "text-overflow:ellipsis",
      "font:700 11px/14px ui-monospace,SFMono-Regular,Menlo,monospace",
      "white-space:nowrap", "backdrop-filter:blur(3px)",
    ].join(";");
    const popover = document.createElement("div");
    popover.setAttribute("role", "menu");
    popover.style.cssText = [
      "display:none", "position:absolute", "right:0", "bottom:22px", "width:min(300px,calc(100vw - 10px))",
      "max-height:min(50vh,320px)", "overflow:auto", "box-sizing:border-box", "padding:5px",
      "border:1px solid #5f6368", "border-radius:6px", "background:#202124f5", "color:#e8eaed",
      "box-shadow:0 6px 22px #000a", "pointer-events:auto", "backdrop-filter:blur(5px)",
    ].join(";");
    badge.onmouseenter = () => showTabPopover(false);
    badge.onmouseleave = scheduleTabPopoverHide;
    badge.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (tabPopover.style.display !== "none" && tabPopoverPinned) hideTabPopover();
      else showTabPopover(true);
    };
    popover.onmouseenter = () => clearTimeout(tabPopoverTimer);
    popover.onmouseleave = scheduleTabPopoverHide;
    shadow.append(label, input, audio, transfer, badge, popover);
    document.documentElement.append(host);
    indicatorHost = host;
    indicatorLabel = label;
    inputBadge = input;
    audioBadge = audio;
    transferBadge = transfer;
    tabBadge = badge;
    tabPopover = popover;
  }

  // A two-pixel bar across the top of the pane while a page loads.
  //
  // It grows in steps rather than animating, and the reason is not taste: in this browser a
  // pixel change is a frame to the terminal, and a continuously animating bar would push whole
  // frames for the length of every load — the cost the playback budget exists to bound. It
  // would also read as video to `settleFrameRate`, which decides a page is playing by counting
  // paints, and hold the pane at its playback rate while nothing plays.
  //
  // So the engine sends a value on lifecycle events only, and waits 250ms before the first
  // one, so a page that loads quickly never draws anything at all. Two or three paints for a
  // whole load, against a bar a person can still read as progress.
  //
  // DO NOT add a transition here. It would restore exactly the cost this shape avoids.
  let loadingHost = null;
  let loadingBar = null;

  function ensureLoadingBar() {
    if (!topFrame || !document.documentElement || loadingHost?.isConnected) return;
    const host = document.createElement("div");
    host.id = "__tweb_loading__";
    host.style.cssText = "position:fixed;left:0;top:0;right:0;height:2px;"
      + "z-index:2147483646;pointer-events:none";
    const shadow = host.attachShadow({ mode: "closed" });
    const bar = document.createElement("div");
    // The same blue the tab badge uses, so the pane's own chrome stays one palette.
    bar.style.cssText = "height:2px;width:0;background:#8ab4f8;box-shadow:0 0 4px #8ab4f899";
    shadow.append(bar);
    document.documentElement.append(host);
    loadingHost = host;
    loadingBar = bar;
  }

  function removeLoadingBar() {
    loadingHost?.remove();
    loadingHost = null;
    loadingBar = null;
  }

  function updateLoadingBar(state) {
    if (!topFrame) return;
    if (!state) {
      if (!loadingHost) return;
      removeLoadingBar();
      paintNow();
      return;
    }
    ensureLoadingBar();
    if (!loadingBar) return;
    loadingBar.style.width = `${Math.round(Math.max(0, Math.min(1, state.progress)) * 100)}%`;
    // The frame clock may be at its idle rate, and an indicator that appears a quarter second
    // after the page started loading is worse than none.
    paintNow();
  }

  ipcRenderer.on("tweb-loading", (_event, state) => updateLoadingBar(state));

  // What the input badge says, or "" for nothing to say.
  //
  // Two independent toggles: whether TWeb's shortcuts are on (Ctrl-/), and whether Cmd
  // combinations reach the page (Ctrl-;). Both are the default, so the badge only appears
  // when one is not — an indicator that is always lit says nothing. With both off, one
  // badge covers them: the pane is then simply out of the way, and two badges saying so
  // is noise.
  //
  // Neither belongs in the mode label. The mode is what the keyboard does on the page,
  // and folding these in meant a focused input showed the toggle state instead of `E`.
  function inputBadgeState() {
    if (!vimiumEnabled && bypassEnabled) {
      return { text: "web", title: "Shortcuts off, Cmd to the page — every key goes to the web page" };
    }
    if (!vimiumEnabled) {
      return { text: "web", title: "TWeb shortcuts off (Ctrl-/ to turn them back on)" };
    }
    if (bypassEnabled) {
      return { text: "⌘", title: "Cmd combinations go to the page (Ctrl-; to keep them in tmux)" };
    }
    return { text: "", title: "" };
  }

  function renderIndicator() {
    if (!topFrame) return;
    ensureIndicator();
    const short = modeLabels[indicatorMode] || indicatorMode.slice(0, 1).toUpperCase();
    indicatorLabel.textContent = indicatorDetail ? `${short} ${indicatorDetail}` : short;
    indicatorLabel.title = `TWeb ${indicatorMode}${indicatorDetail ? ` — ${indicatorDetail}` : ""}`;
    indicatorLabel.style.color = indicatorMode === "normal" ? "#8ab4f8"
      : indicatorMode === "insert" ? "#81c995"
      : "#fdd663";
    const input = inputBadgeState();
    inputBadge.textContent = input.text;
    inputBadge.title = input.title;
    inputBadge.style.display = input.text ? "" : "none";
    // The owner's pane id is what makes the badge actionable: it says where the sound is
    // coming from, so the user knows which pane to go to instead of guessing.
    audioBadge.textContent = audioState.muted ? `🔇 ${audioState.owner || "other pane"}` : "";
    audioBadge.title = audioState.muted
      ? `Audio muted — ${audioState.owner || "another pane"} owns it · press m to take it back`
      : "";
    audioBadge.style.display = audioState.muted ? "" : "none";
    // The absolute path is what a terminal has instead of "Show in folder", and it is
    // strictly more useful: a path can be fed to the user's own tools, a Finder window
    // cannot. It goes in the tooltip rather than the badge because a full path would push
    // the badge across the pane, and `gd` shows it in full.
    transferBadge.textContent = transferState ? transferState.text : "";
    transferBadge.title = transferState
      ? `${transferState.path || transferState.text}${transferState.state === "progressing" ? " · Ctrl-D cancels · gd lists downloads" : " · gd lists downloads"}`
      : "";
    transferBadge.style.color = transferState?.tone === "failed" ? "#f28b82"
      : transferState?.tone === "pending" ? "#8ab4f8"
      : "#81c995";
    transferBadge.style.borderColor = transferState?.tone === "failed" ? "#f28b8266"
      : transferState?.tone === "pending" ? "#8ab4f866"
      : "#81c99566";
    transferBadge.style.display = transferState ? "" : "none";
    const active = Math.min(tabState.count, Math.max(1, tabState.activeIndex + 1));
    tabBadge.textContent = `${active}/${tabState.count}`;
    tabBadge.title = `Tab ${active}/${tabState.count} in this pane · hover/click for the list`;
    if (tabPopover.style.display !== "none") showTabPopover(tabPopoverPinned);
  }

  function updateTabState(model) {
    const tabs = Array.isArray(model?.tabs) ? model.tabs.flatMap((tab, index) => {
      if (!tab || !Number.isInteger(tab.index)) return [];
      return [{ index: tab.index, title: String(tab.title || `Tab ${index + 1}`) }];
    }) : [];
    const count = tabs.length || (Number.isInteger(model?.count) && model.count > 0 ? model.count : 1);
    const activeIndex = Number.isInteger(model?.activeIndex) ? model.activeIndex : 0;
    tabState = {
      activeIndex: Math.min(count - 1, Math.max(0, activeIndex)),
      count,
      tabs: tabs.length ? tabs : Array.from({ length: count }, (_, index) => ({ index, title: `Tab ${index + 1}` })),
    };
    const root = document.documentElement;
    if (root) {
      root.dataset.twebTabIndex = String(tabState.activeIndex);
      root.dataset.twebTabCount = String(tabState.count);
    }
    renderIndicator();
  }

  // Mirrors "the page should get real key events" to the engine, deduplicated so
  // a mode set on every focus change does not spam IPC.
  //
  // Only the top frame reports. `pageInsertMode` is one flag for the whole tab,
  // so a subframe blurring would otherwise disarm native delivery while the main
  // frame's input still holds focus.
  let engineNativeKeys = false;
  function setEngineNativeKeys(enabled) {
    if (!topFrame || enabled === engineNativeKeys) return;
    engineNativeKeys = enabled;
    send("insert-mode", enabled);
  }

  function setMode(mode, detail = "") {
    const root = document.documentElement;
    if (!root) return;
    root.dataset.twebMode = mode;
    root.dataset.twebModeDetail = detail;
    // A focused input needs native keys just as much as an explicit insert mode
    // does. Renderer-built KeyboardEvents always carry keyCode 0 — the
    // constructor cannot set it — and sites that branch on `e.keyCode === 40`
    // rather than `e.key` (search suggestion lists among them) then see nothing,
    // so ArrowDown in a suggestion box did nothing. Mirror the editable state to
    // the engine so those keys arrive natively, with their real key codes.
    setEngineNativeKeys(mode === "insert");
    if (!topFrame) {
      if (document.hasFocus()) send("frame-mode", { mode, detail });
      return;
    }
    indicatorMode = mode;
    indicatorDetail = detail;
    renderIndicator();
  }

  // The value written to dataset.twebInputMode. The two flags combine into a mode.
  function modeIndicator() {
    if (vimiumEnabled && !bypassEnabled) return "shortcuts";
    if (!vimiumEnabled && bypassEnabled) return "bypass";
    if (vimiumEnabled && bypassEnabled) return "shortcuts and bypass";
    return "web-only";
  }

  function normalMode() {
    // The mode says what the keyboard is doing on the page — normal or editing. Whether
    // TWeb's own shortcuts are on, and whether Cmd goes to the page, are separate facts
    // with their own badge: folding them in here meant a focused input showed `P` instead
    // of `E`, hiding the one thing the mode was there to say.
    if (insertMode) setMode("insert", "Esc");
    else if (isEditable(activeElement())) setMode("insert");
    else if (panSurface()) setMode("normal", "↔ pan · Esc");
    else setMode("normal", scrollSurface() ? "⇅ inner · Esc" : "");
    // Every other caret trigger is an event on the focused field, and a field can leave
    // without firing one: Chrome does not fire blur or focusout when the focused element is
    // removed from the DOM, which is how a search overlay closes. The terminal cursor was
    // then stranded on the vanished field's last position, in normal mode, with nothing to
    // clear it until some unrelated key happened to report again. Measured on Google:
    // Escape left `caret {col:22,row:28}` with `activeElement: body`, and the next `j`
    // cleared it. A mode change is the one moment that always happens, so it reports.
    // `lastCaretReport` is invalidated with a sentinel rather than `""`, because `""` IS the
    // no-caret report: resetting to it would make dedup swallow the very send that clears
    // the cursor. `null` matches no report the function can build.
    lastCaretReport = null;
    reportCaret();
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

  function commandKey(value, shiftKey = false) {
    if (typeof value !== "string") return value;
    const mapped = koreanLangmap.get(value) || koreanLangmap.get(value.normalize("NFD"));
    if (!mapped) return value;
    return shiftKey && mapped.length === 1 ? mapped.toUpperCase() : mapped;
  }

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
    return commandKey(keys[event.code] || event.key, event.shiftKey);
  }

  // Elements inside a frame belong to that frame's realm, so `instanceof` against
  // our own constructors answers false for every one of them — which silently
  // dropped every frame target. Node types and tag names cross realms; constructors
  // do not.
  function isElement(node) {
    return node?.nodeType === Node.ELEMENT_NODE;
  }

  function isTag(node, ...names) {
    return isElement(node) && names.includes(node.localName);
  }

  // Where each same-origin iframe document sits in our viewport. Rects inside a
  // frame are measured against that frame, so everything that leaves a collector
  // has to be shifted by this — otherwise a hint lands at the wrong place, or is
  // discarded as off-screen.
  const frameOffsets = new WeakMap();

  function ownerView(element) {
    return element?.ownerDocument?.defaultView || window;
  }

  function frameOffset(node) {
    const document_ = node?.nodeType === Node.DOCUMENT_NODE ? node : node?.ownerDocument;
    return frameOffsets.get(document_) || { x: 0, y: 0 };
  }

  function visibleRect(element) {
    // Callers reach here from optional chains — `visibleRect(panSurface())?.height` reads
    // as guarded, but `?.` protects the result and not the argument, so a null surface
    // threw out of `getComputedStyle` and took the whole key handler with it.
    if (!isElement(element)) return null;
    const style = ownerView(element).getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
    const offset = frameOffset(element);
    for (const rect of element.getClientRects()) {
      if (rect.width < 3 || rect.height < 3) continue;
      const left = rect.left + offset.x;
      const top = rect.top + offset.y;
      const right = rect.right + offset.x;
      const bottom = rect.bottom + offset.y;
      if (right <= 0 || bottom <= 0 || left >= innerWidth || top >= innerHeight) continue;
      return { left, top, right, bottom, width: rect.width, height: rect.height,
               x: left, y: top };
    }
    return null;
  }

  function sameOriginFrameDocument(frame) {
    try {
      const inner = frame.contentDocument;
      return inner?.documentElement ? inner : null;
    } catch (_) {
      // Cross-origin: that frame has its own preload and collects for itself.
      return null;
    }
  }

  // Frames are an implementation detail of the page, not of what the user sees, so
  // a same-origin iframe's document is just another root to collect from. Without
  // this, a page whose content is entirely proxied through an iframe offered
  // nothing to hint, scroll or select unless focus happened to be inside it.
  function collectRoots() {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      const base = frameOffset(root.nodeType === Node.DOCUMENT_NODE ? root : root.host);
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
        // Tag name, not a constructor check: a frame's own elements come from its
        // realm, where our constructors do not apply.
        if (element.localName !== "iframe" && element.localName !== "frame") continue;
        const inner = sameOriginFrameDocument(element);
        if (!inner || roots.includes(inner)) continue;
        const box = element.getBoundingClientRect();
        if (box.width < 8 || box.height < 8) continue;
        frameOffsets.set(inner, { x: base.x + box.left, y: base.y + box.top });
        roots.push(inner);
      }
    }
    return roots;
  }

  function uniqueVisibleTargets(elements, classify) {
    const seen = new Set();
    const occupied = new Set();
    const targets = [];
    for (const element of elements) {
      if (!(isElement(element)) || seen.has(element) || element.matches(":disabled,[aria-disabled=true],[inert]")) continue;
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

  const interactiveSelector = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary", "label[for]",
    "audio", "video", "canvas", "[contenteditable=true]", "[onclick]",
    "[jsaction]:not([jsaction=''])", "[aria-haspopup]", "[aria-controls]",
    "[role=button]", "[role=link]", "[role=menuitem]", "[role=menuitemcheckbox]", "[role=menuitemradio]",
    "[role=option]", "[role=tab]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=treeitem]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  // `<form>` exposes its controls as own properties, so a form containing
  // `<input name="id">` answers `form.id` with that input rather than a string.
  // Every id read has to survive that: one such form used to throw and take the
  // whole hint pass down with it.
  function ownId(element) {
    return typeof element?.id === "string" ? element.id : "";
  }

  // `cursor` inherits, so every descendant of a pointer-styled card computes as
  // `pointer` too and the suppression below is what keeps one card from emitting
  // a hint per descendant. Telling the two apart needs the *declared* cursor,
  // which no computed style reports — so the stylesheets are read for the
  // selectors that set one. Recomputed once per hint pass because a page can
  // load or adopt a sheet between passes.
  let declaredCursorSelector;

  function declaredCursorMatcher() {
    if (declaredCursorSelector !== undefined) return declaredCursorSelector;
    const selectors = [];
    const walk = (rules) => {
      for (const rule of rules || []) {
        // `@media`/`@supports`/nesting hold their own lists, and real sites put
        // plenty of cursor rules under a media query.
        if (rule.cssRules) walk(rule.cssRules);
        if (rule.style?.cursor && rule.selectorText) selectors.push(rule.selectorText);
      }
    };
    for (const root of collectRoots()) {
      const document_ = root.ownerDocument || root;
      // Cross-origin sheets throw on `cssRules`; their declarations are simply
      // invisible and such elements keep the old behaviour.
      try { for (const sheet of document_.styleSheets || []) walk(sheet.cssRules); } catch (_) {}
      try { for (const sheet of root.adoptedStyleSheets || []) walk(sheet.cssRules); } catch (_) {}
    }
    // `:is()` is forgiving, so one selector this engine cannot parse does not
    // poison the whole match.
    declaredCursorSelector = selectors.length ? `:is(${selectors.join(",")})` : "";
    return declaredCursorSelector;
  }

  function forgetDeclaredCursors() {
    declaredCursorSelector = undefined;
  }

  // An element that declares its own pointer cursor, or names itself for a
  // screen reader, is asking to be clicked in its own right — a dismiss "x" in
  // the corner of a pointer-styled ad is exactly this. Only consulted on the
  // branch that would otherwise suppress it, so the `*` sweep does not pay for
  // it.
  function ownsPointerIntent(element) {
    if (element.style?.cursor === "pointer") return true;
    if (element.matches("[aria-label],[aria-labelledby],[title]")) return true;
    const selector = declaredCursorMatcher();
    if (!selector) return false;
    try { return element.matches(selector); } catch (_) { return false; }
  }

  function hasPointerIntent(element) {
    if (!(isElement(element)) || ownId(element).startsWith("__tweb_")) return false;
    const style = getComputedStyle(element);
    if (style.pointerEvents === "none") return false;
    if (element.matches(interactiveSelector) || typeof element.onclick === "function") return true;
    if ([...element.attributes].some((attribute) => /^on(?:click|mouse|pointer|touch|key)/i.test(attribute.name))) return true;
    if (style.cursor !== "pointer") return false;
    const root = element.getRootNode();
    const parent = element.parentElement || root instanceof ShadowRoot && root.host || null;
    if (!(isElement(parent)) || getComputedStyle(parent).cursor !== "pointer") return true;
    return ownsPointerIntent(element);
  }

  function clickableAncestor(element) {
    let current = element;
    while (isElement(current)) {
      if (hasPointerIntent(current)) return current;
      const root = current.getRootNode();
      current = current.parentElement || root instanceof ShadowRoot && root.host || null;
    }
    return null;
  }

  function hitTestTargets(semantic) {
    const found = new Set(semantic);

    // Topmost hit targets reveal delegated click surfaces whose child owns the
    // pixels while a pointer-styled ancestor owns the interaction.
    const stepX = Math.max(32, Math.min(72, Math.floor(innerWidth / 18)));
    const stepY = Math.max(28, Math.min(64, Math.floor(innerHeight / 14)));
    const points = [];
    for (let y = stepY / 2; y < innerHeight; y += stepY) {
      for (let x = stepX / 2; x < innerWidth; x += stepX) points.push([x, y]);
    }
    for (const element of found) {
      const rect = visibleRect(element);
      if (rect) points.push([
        Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
        Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)),
      ]);
    }
    // elementsFromPoint retargets at a shadow boundary, so each root has to be
    // probed to reach delegated surfaces inside it. Sweeping every point across
    // every root is what made this slow — over a second on GitHub's 19 roots —
    // so a root only sees the points its host actually covers.
    const probes = points.slice(0, 600);
    for (const root of collectRoots()) {
      const host = root === document ? null : (root.host || root.defaultView?.frameElement);
      const bounds = isElement(host) ? visibleRect(host) : null;
      if (host && !bounds) continue;
      // A frame document measures points against itself, so ours have to come back
      // out of our coordinates before probing it.
      const offset = frameOffset(root);
      for (const [ourX, ourY] of probes) {
        if (bounds && (ourX < bounds.left || ourX > bounds.right || ourY < bounds.top || ourY > bounds.bottom)) {
          continue;
        }
        const x = ourX - offset.x;
        const y = ourY - offset.y;
        const hits = typeof root.elementsFromPoint === "function" ? root.elementsFromPoint(x, y) : [];
        const target = hits.map(clickableAncestor).find(Boolean);
        if (target) found.add(target);
      }
    }
    return [...found];
  }

  const mediaControlPresentation = {
    play: { label: "play/pause" },
    mute: { label: "mute" },
    fullscreen: { label: "fullscreen" },
    menu: { label: "menu" },
  };

  // Sites that ship their own control bar (YouTube and friends) expose real
  // buttons, and `revealMediaControls` makes them visible before hints are
  // collected, so they get ordinary hints that sit on the controls the user
  // actually sees. Only the UA shadow-DOM controls are unreachable from script
  // and still need synthetic targets at their known offsets.
  function mediaControlTargets(media) {
    const rect = visibleRect(media);
    if (!rect) return [];
    if (!media.controls || rect.width < 160 || rect.height < 70) {
      return [{
        element: media,
        rect,
        mediaRect: rect,
        nativePoint: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      }];
    }
    const y = rect.bottom - Math.min(50, Math.max(28, rect.height * 0.14));
    const controls = isTag(media, "video")
      ? [
        [26, "play"],
        [Math.max(58, rect.width - 122), "mute"],
        [Math.max(86, rect.width - 72), "fullscreen"],
        [Math.max(114, rect.width - 26), "menu"],
      ]
      : [[24, "play"], [Math.max(54, rect.width - 28), "mute"]];
    return controls.map(([offset, mediaControl]) => ({
      element: media,
      rect: {
        left: rect.left + offset - 8,
        top: y - 8,
        right: rect.left + offset + 8,
        bottom: y + 8,
        width: 16,
        height: 16,
      },
      mediaRect: rect,
      nativePoint: { x: rect.left + offset, y },
      mediaControl,
    }));
  }

  // An ad's dismiss control is a pointer-styled div of ~18px with no semantic
  // role, so it matches no selector and usually falls between hit-test probes.
  // Scanning every element for pointer intent costs a few milliseconds — far
  // less than tightening the probe grid — and catches them all.
  function pointerIntentTargets(roots) {
    return roots
      .flatMap((root) => [...root.querySelectorAll("*")])
      .filter((element) => !ownId(element).startsWith("__tweb_") && hasPointerIntent(element));
  }

  const dismissNames = new Set(["close", "closable", "cancel", "dismiss", "xbutton", "closebtn", "closebutton"]);

  // Ad dismiss buttons are the one control a person actually wants and the one
  // this file cannot see: the real ones are bare `<div class="Sticky__cancel">`
  // with no cursor, no label, no attribute, and their click wired by
  // `addEventListener` — often delegated from `document`, so the element itself
  // never holds a listener at all and no amount of listener inspection would
  // find it. What it does carry is a name. Matching that name is a guess, but it
  // is the only signal such a button emits, and clicking one that turns out to
  // be inert costs nothing.
  function dismissNameTargets(roots) {
    const named = [];
    for (const root of roots) {
      for (const element of root.querySelectorAll("[class],[id]")) {
        if (ownId(element).startsWith("__tweb_")) continue;
        const box = element.getBoundingClientRect();
        // A dismiss button is small. The size bound is what keeps a
        // `.modal-close-overlay` covering the page out of the hints.
        if (box.width < 4 || box.height < 4 || box.width > 48 || box.height > 48) continue;
        // `Sticky__cancel` and `closableContainer` both have to yield their word,
        // and matching by substring would take `disclosure` for a close button.
        const words = `${element.className?.baseVal ?? (typeof element.className === "string" ? element.className : "")} ${ownId(element)}`
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .split(/[^a-z0-9]+/);
        if (!words.some((word) => dismissNames.has(word))) continue;
        if (getComputedStyle(element).pointerEvents === "none") continue;
        named.push(element);
      }
    }
    return named;
  }

  function interactiveTargets() {
    forgetDeclaredCursors();
    const roots = collectRoots();
    const semantic = roots.flatMap((root) => [...root.querySelectorAll(interactiveSelector)]);
    const media = semantic.filter((element) => element.matches("video,audio"));
    const elements = [
      ...semantic.filter((element) => !element.matches("video,audio")),
      ...pointerIntentTargets(roots),
      ...dismissNameTargets(roots),
    ];
    const targets = uniqueVisibleTargets(hitTestTargets(elements), (element) => ({
      nativeSurface: isTag(element, "canvas"),
    })).filter((item) => !item.element.matches("video,audio,iframe"));
    return [...targets, ...media.flatMap(mediaControlTargets)]
      .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
  }

  function resourceUrl(value, element) {
    if (!value) return "";
    try {
      return new URL(value, element?.baseURI || document.baseURI).href;
    } catch (_) {
      return "";
    }
  }

  function imageSource(image) {
    if (!image) return "";
    if (isTag(image, "img")) return resourceUrl(image.currentSrc || image.src, image);
    if (isTag(image, "video")) return resourceUrl(image.poster || image.currentSrc || image.src, image);
    const nested = image.querySelector?.("img,video");
    if (nested) return imageSource(nested);
    const background = ownerView(image).getComputedStyle(image).backgroundImage;
    const match = background?.match(/url\((['"]?)(.*?)\1\)/);
    return resourceUrl(match?.[2], image);
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
        : link?.querySelector?.("img,picture,canvas,svg,video,[role=img]") || null;
      return {
        kind: isEditable(element) ? "editable" : image ? "image" : link ? "link" : "text",
        link,
        image,
        imageURL: imageSource(image),
      };
    }).filter((item) => item.kind !== "text" || item.element.innerText?.trim());
  }

  // Comment panels, sidebars and chat logs scroll independently of the page and
  // only react to a wheel while the pointer is over them, so `j`/`k` on the
  // document does nothing. Large canvas/SVG apps often pan only by mouse drag;
  // expose both kinds through the same `s` picker.
  function scrollableTargets() {
    const roots = collectRoots();
    const scrollable = roots
      .flatMap((root) => [...root.querySelectorAll("*")])
      .filter((element) => {
        if (ownId(element).startsWith("__tweb_")) return false;
        const overflow = ownerView(element).getComputedStyle(element);
        if (!/auto|scroll|overlay/.test(`${overflow.overflowY} ${overflow.overflowX}`)) return false;
        return scrollsAtAll(element);
      })
      .slice(0, 200);

    // A frame scrolls as a document rather than through an overflow container, so
    // its scrolling element never matches the filter above — and on a page that is
    // one big proxied iframe that leaves nothing to scroll at all.
    for (const root of roots) {
      if (root.nodeType !== Node.DOCUMENT_NODE || root === document) continue;
      const scroller = root.scrollingElement;
      if (scroller && scroller.scrollHeight > scroller.clientHeight + 8) scrollable.push(scroller);
    }

    // Not uniqueVisibleTargets: it drops anything covering the viewport, which
    // is exactly what an app shell's scroller looks like, and it dedupes by
    // top-left corner, which would hide a nested scroller behind its parent.
    const targets = [];
    const seen = new Set();
    for (const element of scrollable) {
      if (seen.has(element)) continue;
      const rect = visibleRect(element);
      if (!rect || rect.width < 80 || rect.height < 80) continue;
      seen.add(element);
      targets.push({ element, rect });
    }

    // Charts and maps commonly keep their viewport in a transform instead of DOM
    // scroll offsets. Restrict this fallback to large root drawing surfaces so icon
    // SVGs do not flood the picker. A real overflow container wins if it is both.
    for (const element of roots.flatMap((root) => [...root.querySelectorAll("canvas,svg")])) {
      if (seen.has(element) || ownId(element).startsWith("__tweb_")) continue;
      if (element.parentElement?.closest("canvas,svg")) continue;
      const rect = visibleRect(element);
      if (!rect || rect.width < 320 || rect.height < 220) continue;
      if (ownerView(element).getComputedStyle(element).pointerEvents === "none") continue;
      seen.add(element);
      targets.push({ element, rect, pan: true });
    }

    // Without the page in the list there is no way back once an inner surface is
    // picked — and on a page whose content is one big frame, the only candidate
    // would be that frame forever.
    const picked = Boolean(scrollTarget || panTarget);
    const page = document.scrollingElement;
    if (page && (picked || scrollsAtAll(page))) {
      const entry = { element: page, page: true,
                      rect: { left: 2, top: 2, right: 40, bottom: 20, width: 38, height: 18, x: 2, y: 2 } };
      // Picked something already? Then getting back out is the likely intent.
      if (picked) targets.unshift(entry);
      else targets.push(entry);
    }

    // Innermost first: that is usually the one under discussion.
    return targets.sort((left, right) => {
      if (left.page !== right.page) return left.page ? (picked ? -1 : 1) : (picked ? 1 : -1);
      const related = left.element.ownerDocument === right.element.ownerDocument
        && right.element.compareDocumentPosition(left.element) & Node.DOCUMENT_POSITION_CONTAINED_BY;
      if (related) return -1;
      return left.rect.top - right.rect.top || left.rect.left - right.rect.left;
    });
  }

  function scrollsAtAll(element) {
    return element.scrollHeight > element.clientHeight + 8
      || element.scrollWidth > element.clientWidth + 8;
  }

  function scrollSurface() {
    // Visibility is the wrong test here: a scrolled document root — which is what
    // a frame offers — has its box above the viewport, so requiring a visible rect
    // dropped the surface the moment it was used, leaving the keys on the page and
    // the indicator claiming nothing was picked. What matters is that it scrolls.
    if (scrollTarget?.isConnected && scrollsAtAll(scrollTarget)) return scrollTarget;
    scrollTarget = null;
    return null;
  }

  function panSurface() {
    if (panTarget?.isConnected && visibleRect(panTarget)) return panTarget;
    panTarget = null;
    return null;
  }

  function panSurfaceBy(left, top) {
    const target = panSurface();
    if (!target) return false;
    const rect = visibleRect(target);
    const dx = Math.max(-rect.width * 0.35, Math.min(rect.width * 0.35, -left));
    const dy = Math.max(-rect.height * 0.35, Math.min(rect.height * 0.35, -top));
    if (!dx && !dy) return true;

    // Prefer blank drawing surface so a card or map marker does not turn the pan
    // into an activation. Fall back to any point inside the selected surface.
    const ratios = [[.18, .18], [.82, .18], [.18, .82], [.82, .82], [.5, .5], [.5, .25], [.5, .75]];
    let fallback = null;
    let start = null;
    for (const [rx, ry] of ratios) {
      const point = { x: rect.left + rect.width * rx, y: rect.top + rect.height * ry };
      const end = { x: point.x + dx, y: point.y + dy };
      if (end.x < rect.left + 4 || end.x > rect.right - 4
        || end.y < rect.top + 4 || end.y > rect.bottom - 4) continue;
      const hit = target.ownerDocument.elementFromPoint(point.x, point.y);
      if (!hit || !target.contains(hit)) continue;
      fallback ||= point;
      if (hit === target) {
        start = point;
        break;
      }
    }
    start ||= fallback || { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    send("native-drag", {
      from: topViewportPoint(start),
      to: topViewportPoint({ x: start.x + dx, y: start.y + dy }),
    });
    return true;
  }

  function scrollSurfaceBy(left, top) {
    if (panSurfaceBy(left, top)) return;
    const target = scrollSurface();
    if (target) target.scrollBy({ left, top, behavior: "instant" });
    else scrollBy({ left, top, behavior: "instant" });
  }

  function scrollSurfaceTo(top) {
    if (panSurface()) return;
    const target = scrollSurface();
    if (target) target.scrollTo({ top, behavior: "instant" });
    else scrollTo({ top, behavior: "instant" });
  }

  function scrollSurfaceHeight() {
    return visibleRect(panSurface())?.height || scrollSurface()?.clientHeight || innerHeight;
  }

  function scrollSurfaceEnd() {
    if (panSurface()) return 0;
    return scrollSurface()?.scrollHeight ?? document.documentElement.scrollHeight;
  }

  function startScrollPicker() {
    startPicker(scrollableTargets(), "scroll", (item) => {
      // The page entry means "no inner surface", which is what null already is.
      scrollTarget = item.page || item.pan ? null : item.element;
      panTarget = item.pan ? item.element : null;
      // Some panels also gate their wheel handling on hover, so move the pointer.
      send("native-hover", hintClickPoint(item));
      normalMode();
    });
  }

  function inspectTargets() {
    const excluded = new Set(["html", "head", "body", "style", "script", "link", "meta"]);
    const elements = collectRoots()
      .flatMap((root) => [...root.querySelectorAll("*")])
      .filter((element) => !excluded.has(element.localName) && !ownId(element).startsWith("__tweb_"));
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
    stopMediaHover();
    if (restoreMode) normalMode();
  }

  function showHintFeedback(item) {
    const point = item.nativePoint || {
      x: item.rect.left + item.rect.width / 2,
      y: item.rect.top + item.rect.height / 2,
    };
    const host = document.createElement("div");
    host.id = "__tweb_hint_feedback__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    const outline = document.createElement("div");
    outline.style.cssText = [
      "position:fixed", `left:${Math.max(0, item.rect.left - 3)}px`, `top:${Math.max(0, item.rect.top - 3)}px`,
      `width:${Math.max(8, item.rect.width + 6)}px`, `height:${Math.max(8, item.rect.height + 6)}px`,
      "box-sizing:border-box", "border:3px solid #ffb300", "border-radius:7px", "background:#ffd75f33",
      "box-shadow:0 0 0 2px #111b,0 0 18px #ffb300", "transition:opacity .32s ease,transform .32s ease",
    ].join(";");
    const ripple = document.createElement("div");
    ripple.style.cssText = [
      "position:fixed", `left:${point.x - 9}px`, `top:${point.y - 9}px`, "width:18px", "height:18px",
      "box-sizing:border-box", "border:3px solid #fff", "border-radius:50%", "background:#ffb300aa",
      "box-shadow:0 0 0 2px #111a", "transition:opacity .32s ease,transform .32s ease",
    ].join(";");
    shadow.append(outline, ripple);
    document.documentElement.append(host);
    paintNow();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      outline.style.opacity = "0";
      outline.style.transform = "scale(1.04)";
      ripple.style.opacity = "0";
      ripple.style.transform = "scale(2.8)";
    }));
    setTimeout(() => host.remove(), 380);
  }

  // A video's control bar is hover-gated, so hints collected on an idle page
  // would miss it entirely. Park the pointer over the largest video: the site
  // then paints its own controls, and the hints land on the very buttons the
  // user sees rather than on a lookalike overlay of ours.
  function mediaHoverPoints() {
    const videos = [...document.querySelectorAll("video")]
      .map((media) => ({ media, rect: visibleRect(media) }))
      .filter((item) => item.rect && item.rect.width >= 160 && item.rect.height >= 70);
    videos.sort((left, right) =>
      right.rect.width * right.rect.height - left.rect.width * left.rect.height);
    return videos.map(({ media, rect }) => ({
      media,
      // Aim low in the frame: that is where control bars live, and it keeps the
      // pointer off click-to-pause surfaces in the middle.
      point: { x: rect.left + rect.width / 2, y: rect.bottom - Math.min(40, rect.height * 0.1) },
    }));
  }

  // Players hide their controls a few seconds after the pointer stops moving,
  // which would leave hint badges floating over an empty frame. Keep nudging
  // until the picker closes.
  function startMediaHoverLoop(points) {
    stopMediaHover();
    if (points.length) mediaHoverTimer = setInterval(() => nudgeMediaPointer(points), 700);
  }

  function nudgeMediaPointer(points) {
    // A pointer that never moves reads as idle, so alternate by a pixel.
    mediaHoverNudge = mediaHoverNudge ? 0 : 1;
    for (const { media, point } of points) {
      const moved = { x: point.x + mediaHoverNudge, y: point.y };
      for (const type of ["mouseover", "mousemove"]) {
        media.dispatchEvent(new MouseEvent(type, {
          bubbles: true, clientX: moved.x, clientY: moved.y,
        }));
      }
    }
    // There is only one cursor: it goes to the largest video.
    const [primary] = points;
    if (primary) {
      send("native-hover", topViewportPoint({
        x: primary.point.x + mediaHoverNudge,
        y: primary.point.y,
      }));
    }
  }

  function stopMediaHover() {
    if (mediaHoverTimer) clearInterval(mediaHoverTimer);
    mediaHoverTimer = null;
  }

  // "0" alone reads as a malfunction. Say which kind of target came up empty, and
  // stay up long enough to be read.
  const emptyPickerReason = {
    hint: "no clickable target",
    visual: "no text·link·image",
    scroll: "no inner scroll area",
    inspect: "no target",
    command: "no command to run",
  };

  function startPicker(targets, mode, onPick) {
    cancelTransient(false);
    if (targets.length === 0) {
      setMode(mode, emptyPickerReason[mode] || "0");
      setTimeout(normalMode, 1100);
      return;
    }
    const labels = hintLabels(targets.length);
    const host = document.createElement("div");
    host.id = "__tweb_picker__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    const items = targets.map((target, index) => {
      const badge = document.createElement("span");
      const badgeLeft = target.mediaControl ? target.nativePoint.x - 10 : target.rect.left;
      const badgeTop = target.mediaControl ? target.nativePoint.y - 39 : target.rect.top;
      badge.textContent = labels[index];
      badge.style.cssText = [
        "position:fixed", `left:${Math.max(0, badgeLeft)}px`, `top:${Math.max(0, badgeTop)}px`,
        "padding:1px 4px", "border:1px solid #9b6b00", "border-radius:3px", "background:#ffd75f",
        "color:#161616", "box-shadow:0 1px 4px #0008", "font:700 12px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace",
      ].join(";");
      shadow.append(badge);
      return { ...target, label: labels[index], badge };
    });
    document.documentElement.append(host);
    paintNow();
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
      showHintFeedback(selected);
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

  function performMediaControl(item) {
    const media = item.element;
    if (!(isTag(media, "video", "audio"))) return false;
    if (item.mediaControl === "play") {
      if (media.paused) void media.play().catch(() => {});
      else media.pause();
      return true;
    }
    if (item.mediaControl === "mute") {
      media.muted = !media.muted;
      return true;
    }
    if (item.mediaControl === "fullscreen") {
      if (document.fullscreenElement) void document.exitFullscreen?.();
      else void media.requestFullscreen?.();
      return true;
    }
    return false;
  }

  function topViewportPoint(point) {
    let x = point.x;
    let y = point.y;
    let frameWindow = window;
    try {
      while (frameWindow !== frameWindow.top) {
        const frame = frameWindow.frameElement;
        if (!(isElement(frame))) break;
        const rect = frame.getBoundingClientRect();
        x += rect.left;
        y += rect.top;
        frameWindow = frameWindow.parent;
      }
    } catch (_) {}
    return { x, y };
  }

  function hintClickPoint(item) {
    if (item.mediaControl && item.nativePoint) return topViewportPoint(item.nativePoint);
    const rect = visibleRect(item.element) || item.rect;
    return topViewportPoint({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  }

  // --- caret reporting ---
  //
  // Korean (and any IME) composition happens in the terminal emulator, which
  // paints the in-progress syllable at the *terminal* cursor. That cursor sits
  // at the pane origin, so the composition appears in the wrong place — and
  // under the browser image. Report where the web caret is and let the main
  // process park the terminal cursor there.
  //
  // Two renderers cannot be aligned: the terminal draws preedit in its own font on
  // the cell grid, the page draws text in its font at arbitrary offsets, and we
  // never learn the preedit text (it is not sent over the pty) so we cannot draw it
  // ourselves. Give it a place of its own instead — a surface snapped to the cell grid
  // just past the caret, with the terminal cursor parked on its first cell. The
  // composition then lands inside the surface, never on top of page glyphs, and reads
  // as the terminal surface it is.
  let caretCanvas = null;
  let lastCaretReport = "";
  let cellMetrics = null;
  let imeSlotHost = null;
  let imeSlotBox = null;
  let imeSlotKey = "";

  function ensureImeSlot() {
    if (imeSlotHost?.isConnected) return;
    const host = document.createElement("div");
    host.id = "__tweb_ime__";
    host.style.cssText = "position:fixed;left:0;top:0;z-index:2147483644;pointer-events:none";
    const shadow = host.attachShadow({ mode: "closed" });
    const box = document.createElement("div");
    // No border or shadow: this should read as a little clearing in the input's
    // own surface, not as a second UI component sitting on top of it.
    //
    // The blur stays, and the alpha is what came down instead. Composition is not
    // signalled to this preload at all — preedit happens in the terminal and only
    // committed text reaches the page — so the slot is painted for as long as a field has
    // focus, not while something is being composed. At `.76` that read as an opaque block
    // sitting in a search box nobody had typed in yet. But the blur is doing the job the
    // alpha cannot: it is what keeps page glyphs from being legible UNDER the preedit, and
    // a lower alpha needs it more, not less. Removing it was tried and the regression test
    // for this surface caught it.
    box.style.cssText = ["position:fixed", "box-sizing:border-box", "border-radius:2px",
      "background:transparent", "backdrop-filter:blur(1.5px)"].join(";");
    shadow.append(box);
    document.documentElement.append(host);
    imeSlotHost = host;
    imeSlotBox = box;
  }

  function removeImeSlot() {
    imeSlotHost?.remove();
    imeSlotHost = null;
    imeSlotBox = null;
  }

  function imeSurfaceColor() {
    let element = activeElement();
    while (isElement(element)) {
      const values = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.map(Number) || [];
      const alpha = values.length > 3 ? values[3] : 1;
      if (values.length >= 3 && alpha > 0.05) {
        // Reuse the input surface's hue, at an alpha that hides the page glyphs a
        // composition would otherwise be read against WITHOUT announcing itself. It was
        // `.76`, chosen against the composition case alone — but the slot is up whenever a
        // field has focus, so that value spent its budget on the case that is rare and paid
        // for it in the case that is constant.
        return `rgba(${Math.round(values[0])},${Math.round(values[1])},${Math.round(values[2])},.42)`;
      }
      const root = element.getRootNode();
      element = element.parentElement || (root instanceof ShadowRoot ? root.host : null);
    }
    return matchMedia("(prefers-color-scheme: dark)").matches
      ? "rgba(24,24,27,.42)"
      : "rgba(255,255,255,.42)";
  }

  // Where composition should appear, in cell-grid coordinates: the page image fills
  // the pane's cell box exactly, so CSS (0,0) is the grid origin.
  function imeSlotRect(caret) {
    const cell = cellMetrics;
    if (!cell || !(cell.width > 0) || !(cell.height > 0) || !topFrame) return null;
    const columns = Math.max(1, cell.columns || 3);
    const width = Math.min(columns * cell.width, innerWidth);
    // Past the caret, never on it: the character before the caret keeps its pixels.
    let left = Math.ceil(caret.x / cell.width) * cell.width;
    // The cell whose middle is nearest the caret's — page line boxes are routinely
    // taller than a cell, and picking by top edge drifts a row on those.
    const middle = caret.y + (caret.height || cell.height) / 2;
    const lastRow = Math.max(0, Math.floor((innerHeight - cell.height) / cell.height) * cell.height);
    let top = Math.min(lastRow,
      Math.max(0, Math.round((middle - cell.height / 2) / cell.height) * cell.height));
    let wrapped = false;
    if (left + width > innerWidth) {
      // Never move the slot backward over text on the caret's line. Prefer the next
      // terminal row; at the bottom edge use the previous one instead.
      top = top + cell.height <= lastRow ? top + cell.height : Math.max(0, top - cell.height);
      left = 0;
      wrapped = true;
    }
    // On the caret's row, draw over the union of the cell and page line box so the
    // surface does not hang below the text it belongs to. A wrapped surface is deliberately
    // separate and stays exactly one cell high.
    const lineTop = wrapped ? top : Math.min(top, caret.y);
    const lineBottom = wrapped ? top + cell.height
      : Math.max(top + cell.height, caret.y + (caret.height || cell.height));
    return { left, top, width, height: cell.height, lineTop, lineBottom };
  }

  // While the terminal draws a cursor for this pane, the page must not draw one too.
  //
  // Both are honest: the page paints its own caret because a field has focus, and the
  // terminal paints one because that is where composition will land. Together they are two
  // bars a few pixels apart, which reads as a rendering fault rather than as two systems
  // agreeing. The terminal's is the one to keep — it is the anchor the terminal composes
  // against, and it blinks with the rest of the terminal.
  //
  // An inline style on the focused element, restored when focus leaves, rather than a
  // stylesheet: `caret-color` inherits, and a page-wide rule would hide the caret in every
  // field including ones this pane is not driving.
  let caretHiddenElement = null;
  let caretColorBefore = "";

  function hidePageCaret(element) {
    if (caretHiddenElement === element) return;
    restorePageCaret();
    if (!isElement(element) || !element.style) return;
    caretHiddenElement = element;
    caretColorBefore = element.style.caretColor || "";
    element.style.caretColor = "transparent";
  }

  function restorePageCaret() {
    if (!caretHiddenElement) return;
    try {
      if (caretColorBefore) caretHiddenElement.style.caretColor = caretColorBefore;
      else caretHiddenElement.style.removeProperty("caret-color");
    } catch (_) { /* the element may be gone with its document */ }
    caretHiddenElement = null;
    caretColorBefore = "";
  }

  function updateImeSlot(rect) {
    const surface = rect ? imeSurfaceColor() : "";
    const key = rect ? `${rect.left},${rect.lineTop},${rect.width},${rect.lineBottom},${surface}` : "";
    if (key === imeSlotKey && Boolean(rect) === Boolean(imeSlotHost?.isConnected)) return;
    imeSlotKey = key;
    if (!rect) {
      removeImeSlot();
    } else {
      ensureImeSlot();
      // Match the reserved cells exactly. Extra padding would turn the translucent
      // clearing back into a visible surface and could cover the preceding page glyph.
      imeSlotBox.style.left = `${rect.left}px`;
      imeSlotBox.style.top = `${rect.lineTop}px`;
      imeSlotBox.style.width = `${rect.width}px`;
      imeSlotBox.style.height = `${rect.lineBottom - rect.lineTop}px`;
      imeSlotBox.style.background = surface;
    }
    // The frame clock may have dropped to its idle rate, and a surface that appears
    // a quarter second after the caret moved reads as lag.
    paintNow();
  }

  // Where the visual caret sits, for a page that is not editable at all. `caretPoint`
  // below only knows about form fields and contenteditable, because that is where a web
  // caret normally lives — but visual caret mode puts one on ordinary text, and the
  // terminal cursor has to follow it there too. Without this the cursor stays wherever it
  // was last parked, which reads as the caret starting in the pane's top-left corner no
  // matter where the selection is.
  function visualCaretPoint() {
    if (!visualState?.caret) return null;
    const selection = visualSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    let box = range.getBoundingClientRect();
    // A collapsed range measures as 0x0 whenever its container is an element rather than
    // a text node — which is the normal case here, since selecting an element's contents
    // and collapsing lands on the element at offset 0. Descend to the text the caret is
    // actually in front of and measure its first character instead.
    if (!box.width && !box.height) {
      const measured = firstCharacterRect(range);
      if (!measured) return null;
      box = measured;
    }
    // Frame-local coordinates, like the editable path below: `reportCaret` runs the
    // result through `topViewportPoint`, which is what shifts a subframe into the top
    // document.
    return {
      x: Math.max(0, Math.min(innerWidth - 1, box.left)),
      y: Math.max(0, Math.min(innerHeight - 1, box.top)),
      height: box.height || 16,
    };
  }

  // The box of the character a collapsed range sits in front of.
  function firstCharacterRect(range) {
    const owner = range.startContainer?.ownerDocument || document;
    let node = range.startContainer;
    let offset = range.startOffset;
    // Walk down to a text node. An element container's offset indexes its children, so
    // it points at the child the caret precedes.
    while (node && node.nodeType !== Node.TEXT_NODE && node.childNodes?.length) {
      node = node.childNodes[Math.min(offset, node.childNodes.length - 1)];
      offset = 0;
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.nodeValue?.length) return null;
    const start = Math.min(offset, node.nodeValue.length - 1);
    try {
      const probe = owner.createRange();
      probe.setStart(node, start);
      probe.setEnd(node, start + 1);
      const box = probe.getBoundingClientRect();
      return box.width || box.height ? box : null;
    } catch (_) {
      return null;
    }
  }

  function caretPoint() {
    const visual = visualCaretPoint();
    if (visual) return visual;
    const element = activeElement();
    if (!isEditable(element) || isTag(element, "select")) return null;
    const box = element.getBoundingClientRect();
    // Offscreen in EITHER axis, not just vertically. A hidden field parked at
    // `left:-9999px` is one of the commonest ways a page holds focus for a search overlay
    // or a paste target, and reporting its caret put the terminal cursor at the pane's
    // edge — sitting in the middle of a heading, where nothing can be typed.
    if (!box.width || !box.height) return null;
    if (box.bottom <= 0 || box.top >= innerHeight) return null;
    if (box.right <= 0 || box.left >= innerWidth) return null;
    // A field can also be present and laid out while being invisible — `opacity:0` over a
    // real position, `visibility:hidden` on an ancestor. `checkVisibility` answers both,
    // and is guarded because it is newer than the oldest engine this preload runs in.
    if (typeof element.checkVisibility === "function"
      && !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) {
      return null;
    }
    // A 1x1 field is a focus trap, not somewhere a person types.
    if (box.width < 2 || box.height < 2) return null;

    const computed = getComputedStyle(element);
    let x = box.left + (parseFloat(computed.paddingLeft) || 0) + 1;
    let y = box.top + (parseFloat(computed.paddingTop) || 0) + 1;
    let height = Math.max(12, parseFloat(computed.lineHeight)
      || (parseFloat(computed.fontSize) || 13) * 1.25);

    try {
      if (isTag(element, "input")) {
        caretCanvas = caretCanvas || document.createElement("canvas").getContext("2d");
        caretCanvas.font = computed.font || `${computed.fontSize} ${computed.fontFamily}`;
        const before = element.value.slice(0, element.selectionStart ?? element.value.length);
        x += caretCanvas.measureText(before).width - element.scrollLeft;
        y = box.top + Math.max(1, (box.height - height) / 2);
      } else if (isTag(element, "textarea")) {
        // Measure with a mirror: a textarea gives no caret rect of its own.
        const mirror = document.createElement("div");
        mirror.style.cssText = "position:fixed;visibility:hidden;white-space:pre-wrap;"
          + `overflow-wrap:break-word;top:${box.top}px;left:${box.left}px`;
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
    } catch (_) {
      // Fall back to the element's own origin.
    }
    return {
      x: Math.max(0, Math.min(innerWidth - 1, x)),
      y: Math.max(0, Math.min(innerHeight - 1, y)),
      height,
    };
  }

  // The slot reserves cells PAST the caret and paints over them, which is right where a
  // preedit lands — and right on top of real text whenever the caret is not at the end.
  // Typing at the end is the overwhelming case (and the only one an IME preedit normally
  // happens in), so the surface is withheld rather than allowed to smear three cells of the
  // page. Reported after Home and Cmd-Left started putting the caret in front of text a
  // person could still read: `asdfasdf` came back with its first cells blurred out.
  //
  // Trailing whitespace does not count as content — a preedit over a run of spaces hides
  // nothing worth keeping.
  function caretAtContentEnd() {
    const element = activeElement();
    if (!isElement(element)) return false;
    if (isTag(element, "input", "textarea")) {
      const value = element.value ?? "";
      const start = element.selectionStart ?? value.length;
      // A range selection is never a place to compose: the next character replaces it, and
      // the surface would sit on the highlight. `selectionEnd` is also the wrong end to ask
      // about — Shift+Home leaves it at the far end of the text while the caret is drawn at
      // `selectionStart`, so measuring from it said "at the end" while the caret sat in
      // front of everything. That is the reported smear: three cells of `asdfasdf` blurred
      // out, immediately right of a caret at position 0.
      if ((element.selectionEnd ?? start) !== start) return false;
      return !value.slice(start).trim();
    }
    if (!element.isContentEditable) return false;
    const selection = getSelection();
    if (!selection?.rangeCount) return true;
    if (!selection.isCollapsed) return false;
    try {
      const after = selection.getRangeAt(0).cloneRange();
      after.collapse(false);
      after.setEndAfter(element);
      return !after.toString().trim();
    } catch (_) {
      // A range that cannot be built says nothing about the text, so keep the surface.
      return true;
    }
  }

  function reportCaret() {
    if (!topFrame && !document.hasFocus()) return;
    const caret = caretPoint();
    let point = caret ? topViewportPoint(caret) : null;
    let height = caret?.height;
    // The IME slot is a composition area: it reserves cells past the caret and paints
    // them over the page. That is right where typing goes, but the visual caret only
    // navigates — nothing is ever composed there — so reserving cells would blank text
    // for no reason. Move the terminal cursor to it and leave the page alone.
    const composing = !visualState?.caret;
    // A subframe cannot draw the surface in the top document, so it reports the raw
    // caret and the top frame's own report wins as soon as focus moves there.
    const slot = point && composing && caretAtContentEnd() ? imeSlotRect({ ...point, height }) : null;
    if (slot) {
      point = { x: slot.left, y: slot.top };
      height = slot.height;
      updateImeSlot(slot);
    } else {
      updateImeSlot(null);
    }
    // Tied to the parked terminal cursor rather than to the slot. The page's caret is
    // suppressed because the terminal draws one on the same spot, and that stays true in
    // every case the slot is withheld — otherwise withholding it above would bring back
    // the two-carets-a-few-pixels-apart this was written to fix.
    if (point && isEditable(activeElement())) hidePageCaret(activeElement());
    else restorePageCaret();
    const report = point ? `${Math.round(point.x)},${Math.round(point.y)},${Math.round(height)}` : "";
    if (report === lastCaretReport) return;
    lastCaretReport = report;
    send("caret", point ? { ...point, height } : null);
  }

  // Suggestion panels and popovers close on Escape, but in shortcuts mode every
  // key reaches the page as a synthetic event, and sites like Google ignore
  // untrusted input. Ask the main process for a real Escape instead. Clicking an
  // inert spot was the other option, but pages built on delegated handlers
  // (jsaction and friends) have no inert spot to click.
  // Focus must still be on the field when the page sees Escape — that is the
  // state a suggestion panel closes from — so the blur happens afterwards.
  function dismissPageOverlay() {
    passThroughEscape = true;
    clearTimeout(passThroughEscapeTimer);
    // If the engine never delivers the key — an engine without a native-escape
    // handler, or a dropped event — still release focus so Escape is not a no-op.
    passThroughEscapeTimer = setTimeout(() => {
      if (!passThroughEscape) return;
      passThroughEscape = false;
      activeElement()?.blur?.();
      normalMode();
    }, 500);
    send("native-escape");
    return true;
  }

  function startHints(newTab) {
    const points = mediaHoverPoints();
    const onPick = (item) => {
      const link = item.element.closest("a[href]");
      if (newTab && link?.href) send("new-tab", link.href);
      else if (performMediaControl(item)) {}
      else send("native-click", hintClickPoint(item));
      normalMode();
    };
    const collect = () => {
      startPicker(interactiveTargets(), "hint", onPick);
      // Start the loop only now: startPicker cancels transient state first, and
      // that cancellation is what stops a previously running hover loop.
      startMediaHoverLoop(points);
    };

    if (points.length) nudgeMediaPointer(points);
    // Draw hints immediately — waiting on the control bar to animate in makes `f`
    // feel unresponsive and invites a second press. A revealed bar adds targets a
    // moment later, so re-collect once, and only while nothing has been typed.
    collect();
    if (points.length === 0) return;
    setTimeout(() => {
      if (!pickerState || pickerState.mode !== "hint" || pickerState.typed) return;
      if (interactiveTargets().length === pickerState.items.length) return;
      collect();
    }, 220);
  }

  // --- agent bridge ---
  //
  // Agents drive the very page the user is watching, so refs reuse the labels
  // the `f` hint overlay paints. `@a` for the agent is the badge the human sees
  // as "a", which makes hand-off in either direction free of translation.
  let agentTargets = new Map();

  const agentInputRoles = {
    checkbox: "checkbox", radio: "radio", button: "button", submit: "button",
    reset: "button", image: "button", range: "slider", file: "file",
    search: "searchbox", email: "textbox", password: "textbox", url: "textbox",
  };

  function agentRole(element, item) {
    if (item?.mediaControl) return `media-${item.mediaControl}`;
    const explicit = element.getAttribute?.("role");
    if (explicit) return explicit;
    switch (element.localName) {
      case "a": return element.hasAttribute("href") ? "link" : "generic";
      case "button": case "summary": return "button";
      case "select": return "combobox";
      case "textarea": return "textbox";
      case "video": case "audio": case "canvas": return element.localName;
      case "input":
        return agentInputRoles[(element.getAttribute("type") || "text").toLowerCase()] || "textbox";
      default:
        return element.isContentEditable ? "textbox" : "generic";
    }
  }

  function agentName(element, item) {
    if (item?.mediaControl) return mediaControlPresentation[item.mediaControl]?.label || item.mediaControl;
    const labelledBy = (element.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.innerText || "")
      .join(" ").trim();
    const forLabel = ownId(element)
      ? document.querySelector(`label[for="${CSS.escape(ownId(element))}"]`)?.innerText
      : element.closest?.("label")?.innerText;
    const candidates = [
      element.getAttribute?.("aria-label"),
      labelledBy,
      element.getAttribute?.("alt"),
      element.getAttribute?.("placeholder"),
      forLabel,
      element.localName === "input" && /^(button|submit|reset)$/i.test(element.type) ? element.value : "",
      element.innerText,
      element.getAttribute?.("title"),
      element.getAttribute?.("name"),
    ];
    const name = candidates.find((value) => typeof value === "string" && value.trim());
    return (name || "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function agentValue(element) {
    if (isTag(element, "select")) return element.value;
    if (isTag(element, "input") || isTag(element, "textarea")) {
      return element.type === "password" ? "" : element.value;
    }
    return element.isContentEditable ? (element.innerText || "").slice(0, 200) : undefined;
  }

  function agentState(element) {
    const state = {};
    if (element.disabled) state.disabled = true;
    if (isTag(element, "input") && /^(checkbox|radio)$/.test(element.type)) {
      state.checked = element.checked;
    }
    for (const attribute of ["aria-expanded", "aria-selected", "aria-checked", "aria-current"]) {
      const value = element.getAttribute?.(attribute);
      if (value) state[attribute.replace("aria-", "")] = value;
    }
    if (element === activeElement()) state.focused = true;
    return state;
  }

  function agentNode(item, ref) {
    const element = item.element;
    const state = agentState(element);
    return {
      ref,
      role: agentRole(element, item),
      name: agentName(element, item),
      tag: element.localName,
      value: agentValue(element),
      href: element.getAttribute?.("href") || undefined,
      selector: cssSelector(element),
      rect: {
        x: Math.round(item.rect.left), y: Math.round(item.rect.top),
        width: Math.round(item.rect.width), height: Math.round(item.rect.height),
      },
      state: Object.keys(state).length ? state : undefined,
    };
  }

  function agentSnapshot(params = {}) {
    const targets = params.mode === "text" ? visualTargets() : interactiveTargets();
    const labels = hintLabels(targets.length);
    agentTargets = new Map(targets.map((target, index) => [labels[index], target]));
    const nodes = targets.map((target, index) => {
      const node = agentNode(target, labels[index]);
      if (params.mode === "text") node.text = (target.element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400);
      return node;
    });
    return {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
      nodes,
    };
  }

  function agentResolve(ref) {
    const item = agentTargets.get(ref);
    if (!item) throw new Error(`unknown ref @${ref} — run snapshot first`);
    if (!item.element.isConnected) throw new Error(`ref @${ref} is stale — re-run snapshot`);
    return item;
  }

  // React and other frameworks track the value through the prototype setter, so
  // assigning `element.value` directly leaves their state machine behind.
  function agentSetValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function agentAct(params) {
    const { ref, action, value } = params;
    const item = agentResolve(ref);
    const element = item.element;
    switch (action) {
      case "click":
      case "hover":
        element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        // Trusted input must come from the main process; hand back the point.
        return { [action]: hintClickPoint(item) };
      case "fill":
        element.focus({ preventScroll: true });
        if (element.isContentEditable) {
          element.textContent = value ?? "";
          element.dispatchEvent(new InputEvent("input", { bubbles: true }));
        } else {
          agentSetValue(element, value ?? "");
        }
        return { value: agentValue(element) };
      case "focus":
        element.focus({ preventScroll: true });
        return { focused: true };
      case "select": {
        if (!(isTag(element, "select"))) throw new Error(`@${ref} is not a <select>`);
        const option = [...element.options].find((candidate) =>
          candidate.value === value || candidate.label === value || candidate.text === value);
        if (!option) throw new Error(`option ${JSON.stringify(value)} not found in @${ref}`);
        element.value = option.value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { value: element.value };
      }
      case "check":
      case "uncheck": {
        if (!(isTag(element, "input"))) throw new Error(`@${ref} is not checkable`);
        const want = action === "check";
        if (element.checked === want) return { checked: want };
        return { click: hintClickPoint(item) };
      }
      case "scrollto":
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        return { scrolled: true };
      case "text":
        return { text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim() };
      case "html":
        return { html: element.outerHTML };
      case "attr":
        return { [value]: element.getAttribute(value) };
      case "describe":
        return { node: agentNode(item, ref) };
      default:
        throw new Error(`unknown action ${JSON.stringify(action)}`);
    }
  }

  function agentQuery(params) {
    const element = document.querySelector(params.selector);
    if (!element) throw new Error(`no element matches ${JSON.stringify(params.selector)}`);
    const rect = visibleRect(element);
    if (!rect) throw new Error(`${JSON.stringify(params.selector)} is not visible`);
    const item = { element, rect };
    const ref = `q${agentTargets.size}`;
    agentTargets.set(ref, item);
    return { node: agentNode(item, ref) };
  }

  function agentDispatch(request) {
    switch (request.method) {
      case "snapshot": return agentSnapshot(request.params || {});
      case "act": return agentAct(request.params || {});
      case "query": return agentQuery(request.params || {});
      case "info": return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        viewport: { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
      };
      // The shortcut runtime lives in an isolated world, so none of this is
      // reachable through `eval` — which left the mode an agent could not see and
      // a hint count it could only infer from the overlay.
      case "page-diag": {
        const surface = scrollSurface();
        const active = activeElement();
        return {
          mode: document.documentElement?.dataset.twebMode || null,
          detail: document.documentElement?.dataset.twebModeDetail || "",
          vimiumEnabled,
          bypassEnabled,
          insertMode,
          picker: pickerState ? { mode: pickerState.mode, items: pickerState.items.length, typed: pickerState.typed } : null,
          visual: visualState ? { kind: visualState.kind, caret: Boolean(visualState.caret) } : null,
          scrollSurface: surface
            ? { tag: surface.localName, id: ownId(surface) || null, inFrame: surface.ownerDocument !== document,
                scrollTop: Math.round(surface.scrollTop) }
            : null,
          activeElement: active ? { tag: active.localName, id: ownId(active) || null, editable: isEditable(active) } : null,
          // What `f`, `s` and `v` would find right now, frames included.
          targets: {
            roots: collectRoots().length,
            frames: collectRoots().filter((root) => root.nodeType === Node.DOCUMENT_NODE).length - 1,
            scrollable: scrollableTargets().length,
            visual: visualTargets().length,
          },
        };
      }
      case "inspect-element": {
        // An agent asked for the element the user picked in inspect mode. The payload
        // is built in the key handler rather than here because the element is gone by
        // the time this runs — inspect mode may have closed and the reference is to a
        // live DOM node.
        return lastInspectPayload || null;
      }
      default: throw new Error(`unknown agent method ${JSON.stringify(request.method)}`);
    }
  }

  const shortcutHelpSections = [
    ["Motion", [
      ["h · j · k · l", "scroll left · down · up · right"],
      ["d · u", "half page down · up"],
      ["gg · G", "top · bottom of page"],
      ["H · L", "history back · forward"],
      ["Alt-← · Alt-→ · Backspace", "history back · forward — the Chrome keys"],
    ]],
    ["Opening and tabs", [
      ["f · F", "open via hint · open in new tab"],
      ["o · O / t", "omnibox in current tab · new tab"],
      ["b", "list open tabs"],
      ["gh · gd", "history page · downloads — search, copy the path, open"],
      ["J · K", "previous · next tab"],
      ["x · X", "close tab · restore recent tab"],
      ["r · gi", "reload · focus first input"],
      ["s", "pick a scroll/drag-pan area (Esc or s returns to page)"],
    ]],
    ["Search and selection", [
      ["/ · n · N", "search · next · previous match"],
      ["v · V", "visual picker · select whole page"],
      ["h/l · b/w/e · j/k · 0/$ · {/}", "adjust visual selection (beyond the block too)"],
      ["c · v", "drop to caret to move the anchor · select from there"],
      ["y · Y · u", "smart copy · text copy · image/link URL copy"],
      ["D · o/O · p · d", "image download · open target · paste · inspect"],
      ["I", "inspect picker"],
    ]],
    ["Browser and modes", [
      ["zi · zo · zz", "zoom in · out · reset"],
      ["Ctrl + / - / 0", "browser zoom"],
      ["Ctrl-Tab / PgUp / PgDn", "switch browser tab"],
      ["Ctrl-W", "close current browser tab"],
      ["Ctrl-P", "save the page as a PDF in ~/Downloads (a terminal cannot draw a print dialog)"],
      ["gp", "save the PDF, then send it to the printer with lpr"],
      ["Ctrl-D", "cancel the running download"],
      ["i", "insert mode — page's own shortcuts, Esc returns"],
      ["m", "take audio back — only one pane plays at a time"],
      ["Ctrl-;", "Shortcuts ↔ web passthrough"],
      ["Ctrl-C", "quit TWeb from Shortcuts mode"],
      ["Esc", "clear current mode · fullscreen · input focus"],
    ]],
  ];

  function cancelHelp(restoreMode = true) {
    helpHost?.remove();
    helpHost = null;
    if (restoreMode) normalMode();
  }

  function showHelp() {
    cancelTransient(false);
    const host = document.createElement("div");
    host.id = "__tweb_help__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:auto";
    const shadow = host.attachShadow({ mode: "open" });
    const backdrop = document.createElement("div");
    backdrop.style.cssText = "box-sizing:border-box;display:flex;align-items:flex-start;justify-content:center;width:100%;height:100%;padding:clamp(16px,5vh,48px) 16px;background:#000a;overflow:auto";
    const panel = document.createElement("section");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "TWeb shortcuts");
    panel.style.cssText = "box-sizing:border-box;width:min(920px,100%);padding:18px;border:1px solid #5f6368;border-radius:10px;background:#202124;color:#e8eaed;box-shadow:0 16px 48px #000c;font:13px/1.45 system-ui,-apple-system,sans-serif";
    const header = document.createElement("header");
    header.style.cssText = "display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px";
    const heading = document.createElement("div");
    heading.innerHTML = '<strong style="display:block;font-size:19px;color:#fff">TWeb shortcuts</strong><span style="color:#9aa0a6">Shortcuts mode · close with <kbd>?</kbd> or <kbd>Esc</kbd></span>';
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "close  Esc";
    close.style.cssText = "padding:5px 9px;border:1px solid #5f6368;border-radius:5px;background:#303134;color:#e8eaed;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer";
    close.onclick = () => cancelHelp();
    header.append(heading, close);
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:10px";
    for (const [title, entries] of shortcutHelpSections) {
      const group = document.createElement("section");
      group.style.cssText = "padding:11px;border:1px solid #ffffff18;border-radius:7px;background:#ffffff08";
      const name = document.createElement("strong");
      name.textContent = title;
      name.style.cssText = "display:block;margin-bottom:7px;color:#8ab4f8;font-size:13px";
      const list = document.createElement("dl");
      list.style.cssText = "display:grid;grid-template-columns:minmax(108px,auto) 1fr;gap:5px 12px;margin:0";
      for (const [keys, description] of entries) {
        const key = document.createElement("dt");
        key.textContent = keys;
        key.style.cssText = "margin:0;color:#fdd663;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap";
        const detail = document.createElement("dd");
        detail.textContent = description;
        detail.style.cssText = "margin:0;color:#bdc1c6";
        list.append(key, detail);
      }
      group.append(name, list);
      grid.append(group);
    }
    panel.append(header, grid);
    backdrop.append(panel);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) cancelHelp();
    });
    shadow.append(backdrop);
    document.documentElement.append(host);
    paintNow();
    helpHost = host;
    setMode("help", "?·Esc close");
    requestAnimationFrame(() => close.focus({ preventScroll: true }));
  }

  function handleHelpKey(event, key) {
    if (!helpHost) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === "?" || key === "Escape") cancelHelp();
    return true;
  }

  function cancelPrompt(restoreMode = true) {
    promptHost?.remove();
    promptHost = null;
    if (restoreMode) normalMode();
  }

  function fuzzyScore(query, candidate) {
    const needle = query.trim().toLowerCase();
    if (!needle) return 0;
    const haystack = candidate.toLowerCase();
    const direct = haystack.indexOf(needle);
    if (direct >= 0) return 1000 - direct * 3 - (haystack.length - needle.length) * 0.02;
    let score = 0;
    let cursor = 0;
    let previous = -2;
    for (const character of needle) {
      const found = haystack.indexOf(character, cursor);
      if (found < 0) return -Infinity;
      score += found === previous + 1 ? 12 : 4;
      score -= Math.max(0, found - cursor) * 0.15;
      previous = found;
      cursor = found + 1;
    }
    return score - haystack.length * 0.01;
  }

  function showPrompt(newTab) {
    cancelTransient(false);
    const host = document.createElement("div");
    host.id = "__tweb_omnibox__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    const box = document.createElement("div");
    box.style.cssText = "box-sizing:border-box;width:min(760px,calc(100vw - 32px));margin:14px auto;border:2px solid #f6a723;border-radius:8px;background:#202124;box-shadow:0 8px 28px #000a;overflow:hidden;pointer-events:auto";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = newTab ? "Open URL or search in a new tab" : "Open URL or search";
    input.style.cssText = "display:block;box-sizing:border-box;width:100%;padding:10px 13px;border:0;border-bottom:1px solid #5f6368;outline:0;background:#202124;color:#f8f9fa;font:16px/1.3 system-ui,-apple-system,sans-serif";
    const list = document.createElement("div");
    list.setAttribute("role", "listbox");
    list.style.cssText = "display:none;max-height:min(420px,60vh);overflow:auto;padding:4px";
    let model = { current: location.href, entries: [] };
    let matches = [];
    let selected = 0;

    const render = () => {
      const query = input.value.trim();
      const deduped = new Map();
      for (const entry of model.entries || []) {
        if (!entry?.url || deduped.has(entry.url)) continue;
        const score = fuzzyScore(query, `${entry.title || ""} ${entry.url}`);
        if (!query || Number.isFinite(score)) deduped.set(entry.url, { ...entry, score });
      }
      matches = [...deduped.values()]
        .sort((left, right) => query ? right.score - left.score : (right.recency || 0) - (left.recency || 0))
        .slice(0, 10);
      if (selected >= 0) selected = Math.min(selected, Math.max(0, matches.length - 1));
      list.replaceChildren();
      list.style.display = matches.length ? "block" : "none";
      matches.forEach((entry, index) => {
        const row = document.createElement("div");
        row.setAttribute("role", "option");
        row.style.cssText = `padding:7px 9px;border-radius:5px;background:${index === selected ? "#3c4043" : "transparent"};color:#e8eaed;cursor:pointer`;
        const title = document.createElement("div");
        title.textContent = entry.title || entry.url;
        title.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:13px/1.35 system-ui,-apple-system,sans-serif";
        const detail = document.createElement("div");
        detail.textContent = `${entry.kind === "tab" ? "TAB  " : ""}${entry.url}`;
        detail.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa0a6;font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace";
        row.append(title, detail);
        row.onmousedown = (event) => {
          event.preventDefault();
          selected = index;
          input.value = entry.url;
          submit();
        };
        list.append(row);
      });
      setMode("omnibox", matches.length ? `${selected >= 0 ? selected + 1 : "-"}/${matches.length}` : "");
    };
    const submit = () => {
      const entry = matches[selected];
      const value = entry?.url || input.value.trim();
      if (!value) return;
      cancelPrompt();
      if (!newTab && entry?.kind === "tab" && Number.isInteger(entry.index)) send("activate-tab", entry.index);
      else send(newTab ? "new-tab" : "navigate", value);
    };
    input.addEventListener("input", () => { selected = -1; render(); });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.code === "Escape") {
        event.preventDefault();
        cancelPrompt();
      } else if (["ArrowDown", "Tab"].includes(event.code) && !event.shiftKey || event.ctrlKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        if (matches.length) selected = selected < 0 ? 0 : (selected + 1) % matches.length;
        render();
      } else if (event.code === "ArrowUp" || event.code === "Tab" && event.shiftKey || event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (matches.length) selected = selected < 0 ? matches.length - 1 : (selected - 1 + matches.length) % matches.length;
        render();
      } else if (event.code === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    box.append(input, list);
    shadow.append(box);
    document.documentElement.append(host);
    paintNow();
    promptHost = host;
    setMode("omnibox");
    ipcRenderer.once("tweb-omnibox", (_event, nextModel) => {
      if (promptHost !== host) return;
      model = nextModel || model;
      input.value = newTab ? "" : model.current || "";
      if (!newTab) input.select();
      render();
    });
    send("omnibox-model");
    requestAnimationFrame(() => input.focus());
  }

  // The find bar lives inside the document, so Chromium's find walks it like any other
  // content and counts the bar's own text: searching "ZEBRA" on a page with three of them
  // reported 4/4, and stepping stopped on the bar itself (selectionArea y=11, the bar's
  // own box). Measured, every piece of the bar is searchable — the input's value, the
  // result span's "1/4", and the "Find in page" placeholder. Chrome does not have this
  // because its find bar is browser chrome; ours is in the page and has to hide from the
  // search itself.
  //
  // It hides by style rather than by blanking `value`. Blanking was tried first and is
  // unusable: the field is the one the user is typing into, so a key pressed during the
  // blank window lands in an empty field — measured in a pane, typing "ZEBRA" left the
  // field holding "Z". `-webkit-text-security` leaves the value and the caret untouched
  // and is the only measured exclusion that does not also drop focus.
  function hideSearchBarText() {
    if (!searchState || searchState.hidden) return;
    searchState.hidden = true;
    searchState.input.style.webkitTextSecurity = "disc";
    searchState.input.placeholder = "";
    searchState.result.style.visibility = "hidden";
  }

  function restoreSearchBarText() {
    if (!searchState?.hidden) return;
    searchState.hidden = false;
    searchState.input.style.webkitTextSecurity = "none";
    searchState.input.placeholder = FIND_PLACEHOLDER;
    searchState.result.style.visibility = "visible";
  }

  // The result event is what normally un-hides the bar. A request that never answers —
  // the document navigated out from under it — would otherwise leave the bar hidden, so
  // the timer is the floor rather than the mechanism.
  function sendFind(query, forward) {
    hideSearchBarText();
    searchPending += 1;
    clearTimeout(searchRestoreTimer);
    searchRestoreTimer = setTimeout(() => {
      searchPending = 0;
      restoreSearchBarText();
      // A result that never came must not leave the bar open on a keypress that asked to
      // close it, so the backstop closes as well as un-hides.
      if (searchState?.closeOnResult) cancelSearch(false);
    }, 700);
    send("find", { query, forward });
  }

  function cancelSearch(clearSelection = true, restoreMode = true) {
    if (!searchState) return;
    clearTimeout(searchRestoreTimer);
    searchPending = 0;
    searchState.host.remove();
    searchState = null;
    send("stop-find", clearSelection ? "clearSelection" : "keepSelection");
    if (restoreMode) normalMode();
  }

  // Chromium's find moves focus to the match it activates, so after the first keystroke
  // the find bar's input is no longer focused and its own keydown listener stops firing.
  // Measured: bar opened → shadow activeElement INPUT; one findInPage later → null, with
  // document.activeElement back on BODY. Refocusing the input after each result was tried
  // and is worse than the disease — it re-anchors Chromium's session, so every follow-up
  // came back at ordinal 1 and the search stopped advancing (measured: y 0, 0, 0 with
  // refocus against 0, 787, 1582 without).
  //
  // So the bar is driven from the document-level handler instead, like the other overlays,
  // and never depends on holding focus. The editing it needs is only what a one-line query
  // field needs; anything richer would mean reimplementing a text field.
  function handleSearchKey(event, key) {
    if (!searchState) return false;
    const { input } = searchState;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === "Escape") {
      cancelSearch(true);
      return true;
    }
    if (key === "Enter") {
      if (input.value) {
        lastSearch = input.value;
        // Same query, live session: this advances to the next match rather than restarting
        // at the first, which is what Enter does in Chrome's find bar.
        sendFind(lastSearch, !event.shiftKey);
        // Closing has to wait for the result. `stopFindInPage` issued in the same tick as
        // a request that opens a new session cancels it outright — measured, a fresh
        // request followed immediately by stop left scrollY 0 and no selection, while the
        // same pair with the result awaited in between landed the match and kept it.
        searchState.closeOnResult = true;
      }
      return true;
    }
    if (key === "Backspace") {
      input.value = input.value.slice(0, -1);
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      input.value += key;
    } else {
      return true;
    }
    lastSearch = input.value;
    searchState.result.textContent = "";
    if (lastSearch) sendFind(lastSearch, true);
    else send("stop-find", "clearSelection");
    return true;
  }

  // `n`/`N` step without a bar, so nothing closes the session afterwards and the match would
  // stay a compositor-only highlight the page cannot show as a selection. Ending each step
  // with `keepSelection` is what makes the match visible, the same way Enter does.
  function stepSearch(forward) {
    stepSearchPending = true;
    send("find", { query: lastSearch, forward });
  }

  function showSearch() {
    cancelTransient(false);
    // An `n` step whose result has not landed yet must not close the session the bar is
    // about to open: its `keepSelection` would arrive during the first typed request and
    // cancel it, which is the same race that made Enter lose its match.
    stepSearchPending = false;
    // Opening the bar clears whatever the last search left behind. Without this, a second
    // search whose first request opens a new session while a kept selection from the
    // previous one is still live loses that selection when the bar closes: measured over
    // three open/search/close cycles, the first kept "ZEBRA" and every later one came back
    // empty, and the same three cycles with this stop all kept it.
    send("stop-find", "clearSelection");
    // Clearing the preload-side query too: if a prior session ended, `lastSearch` still
    // holds its text, and reopening the bar with `/` then pressing Enter without retyping
    // would send it as a continuation of a session that no longer exists. The bar
    // should open into a fresh state, same as the first ever open — no query, no match.
    if (!searchState || !searchState.result.textContent) lastSearch = "";
    const host = document.createElement("div");
    host.id = "__tweb_search__";
    host.style.cssText = "position:fixed;right:8px;top:8px;z-index:2147483646;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    const box = document.createElement("div");
    box.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 7px;border:1px solid #5f6368;border-radius:6px;background:#202124;color:#fff;box-shadow:0 4px 16px #0008;pointer-events:auto";
    const input = document.createElement("input");
    input.type = "text";
    input.value = lastSearch;
    input.placeholder = FIND_PLACEHOLDER;
    input.autocomplete = "off";
    input.style.cssText = "width:min(320px,55vw);padding:4px 6px;border:0;outline:0;background:#303134;color:#fff;font:13px system-ui";
    const result = document.createElement("span");
    result.style.cssText = "min-width:48px;color:#bdc1c6;font:11px ui-monospace,monospace;text-align:right";
    // Typing and Enter/Escape are handled document-level in handleSearchKey, because the
    // input does not keep focus once a search runs. The input stays focusable so the caret
    // sits where the user expects, but nothing depends on it receiving keys.
    box.append(input, result);
    shadow.append(box);
    document.documentElement.append(host);
    paintNow();
    searchState = { host, input, result, hidden: false, closeOnResult: false };
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

  // Close a row without leaving the list; main sends a refreshed model back.
  function closeSelectedTab() {
    const item = tabListState?.items[tabListState.selected];
    if (!item) return;
    tabListRefresh = true;
    send("close-tab", item.tab.index);
  }

  function showTabList() {
    cancelTransient(false);
    setMode("tabs", "…");
    send("list-tabs");
  }

  function renderTabList(model) {
    if (!topFrame || !Array.isArray(model?.tabs)) return;
    // Closing a row re-renders the list; keep the cursor where it was so several
    // tabs can be closed in a row.
    const previousSelected = tabListState?.selected ?? 0;
    cancelTabList(false);
    const host = document.createElement("div");
    host.id = "__tweb_tabs__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:flex-start;justify-content:center;padding-top:8vh;background:#0007;pointer-events:auto";
    const shadow = host.attachShadow({ mode: "open" });
    const panel = document.createElement("div");
    panel.style.cssText = "box-sizing:border-box;width:min(760px,calc(100vw - 32px));max-height:76vh;overflow:auto;padding:8px;border:1px solid #5f6368;border-radius:8px;background:#202124;color:#e8eaed;box-shadow:0 12px 36px #000b;font:13px/1.4 system-ui,-apple-system,sans-serif";
    const title = document.createElement("div");
    title.textContent = `${model.tabs.length} open tabs · j/k move · Enter open · x close · 1-9 jump · Esc`;
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
      tabTitle.textContent = tab.title || "New tab";
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
    paintNow();
    tabListState = { host, items, selected: 0 };
    // A re-render after closing keeps the cursor; a fresh list starts on the
    // active tab.
    selectTabListIndex(tabListRefresh
      ? Math.min(previousSelected, items.length - 1)
      : Math.max(0, Number(model.activeIndex) || 0));
    tabListRefresh = false;
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
    else if (key === "x" || key === "d") closeSelectedTab();
    else if (/^[1-9]$/.test(key) && Number(key) <= tabListState.items.length) {
      selectTabListIndex(Number(key) - 1);
      activateSelectedTab();
    }
    return true;
  }

  // --- history page ---
  //
  // The omnibox is an address bar that happens to read history: ten rows, no times, and
  // you have to know what you are looking for. This is the other view of the same file —
  // every visit, grouped by the day it happened on. Main owns the grouping (history-view.cjs)
  // so day boundaries are decided once, on the side that also does the deleting.

  function cancelHistory(restoreMode = true) {
    historyState?.host.remove();
    historyState = null;
    if (restoreMode) normalMode();
  }

  function historyRows() {
    return historyState?.rows || [];
  }

  function selectHistoryIndex(index) {
    const rows = historyRows();
    if (!historyState || rows.length === 0) {
      setMode("history", historyState ? "0" : "");
      return;
    }
    const count = rows.length;
    historyState.selected = ((index % count) + count) % count;
    for (const [rowIndex, entry] of rows.entries()) {
      const selected = rowIndex === historyState.selected;
      entry.row.style.background = selected ? "#3c4043" : "transparent";
      entry.row.style.outline = selected ? "1px solid #8ab4f8" : "none";
    }
    rows[historyState.selected].row.scrollIntoView({ block: "nearest" });
    setMode("history", `${historyState.selected + 1}/${count}`);
  }

  function openSelectedHistory(newTab) {
    const entry = historyRows()[historyState?.selected];
    if (!entry) return;
    cancelHistory(false);
    send(newTab ? "new-tab" : "navigate", entry.url);
  }

  // Deleting keeps the page open — main sends a fresh model back — so several entries can
  // be cleared in a row without reopening the overlay each time.
  function deleteSelectedHistory() {
    const entry = historyRows()[historyState?.selected];
    if (!entry || !historyState) return;
    historyState.keepSelection = historyState.selected;
    requestHistoryModel([{ url: entry.url, dayStart: entry.dayStart }]);
  }

  // The model is re-requested on every keystroke, so a reply that answers a query the user
  // has already moved on from must not overwrite the current one.
  function requestHistoryModel(rows = null) {
    if (!historyState) return;
    const query = historyState.input.value;
    if (rows) send("history-delete", { rows, query });
    else send("history-model", { query });
  }

  function renderHistoryModel(model) {
    if (!historyState || !model) return;
    if (String(model.query || "") !== historyState.input.value) return;
    const { list } = historyState;
    const rows = [];
    list.replaceChildren();
    for (const day of model.days || []) {
      const heading = document.createElement("div");
      heading.textContent = day.label;
      heading.style.cssText = "position:sticky;top:0;padding:9px 7px 5px;background:#202124;color:#8ab4f8;font-size:12px;font-weight:600";
      list.append(heading);
      for (const entry of day.rows || []) {
        const row = document.createElement("button");
        row.type = "button";
        row.style.cssText = "display:grid;grid-template-columns:5ch minmax(0,1fr);gap:8px;width:100%;padding:6px 7px;border:0;border-radius:5px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer";
        const time = document.createElement("span");
        time.textContent = entry.time;
        time.style.cssText = "color:#9aa0a6;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace";
        const text = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = entry.title || entry.url;
        title.style.cssText = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500";
        const url = document.createElement("small");
        url.textContent = entry.url;
        url.style.cssText = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa0a6";
        text.append(title, url);
        row.append(time, text);
        const index = rows.length;
        row.onmouseenter = () => selectHistoryIndex(index);
        row.onclick = () => { selectHistoryIndex(index); openSelectedHistory(false); };
        list.append(row);
        rows.push({ url: entry.url, dayStart: entry.dayStart, row });
      }
    }
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = model.query ? `No history matches ${model.query}` : "No history yet";
      empty.style.cssText = "padding:14px 7px;color:#9aa0a6";
      list.append(empty);
    }
    historyState.rows = rows;
    // A cap that looks like the whole history is what made the omnibox misleading, so say
    // when there is more behind the one being shown.
    historyState.count.textContent = model.truncated
      ? `${model.shown} of ${model.total}`
      : `${model.total} ${model.total === 1 ? "visit" : "visits"}`;
    // After a delete the row under the cursor is gone; staying at the same offset lands on
    // what took its place, which is what makes repeated deletes usable.
    const resume = historyState.keepSelection;
    historyState.keepSelection = null;
    selectHistoryIndex(resume === null || resume === undefined ? 0 : Math.min(resume, rows.length - 1));
  }

  function showHistory() {
    cancelTransient(false);
    const host = document.createElement("div");
    host.id = "__tweb_history__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:flex-start;justify-content:center;padding-top:6vh;background:#0007;pointer-events:auto";
    const shadow = host.attachShadow({ mode: "open" });
    const panel = document.createElement("div");
    panel.style.cssText = "box-sizing:border-box;display:flex;flex-direction:column;width:min(860px,calc(100vw - 32px));max-height:82vh;padding:8px;border:1px solid #5f6368;border-radius:8px;background:#202124;color:#e8eaed;box-shadow:0 12px 36px #000b;font:13px/1.4 system-ui,-apple-system,sans-serif";
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px;padding:2px 4px 8px";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Search all history";
    input.style.cssText = "flex:1;box-sizing:border-box;min-width:0;padding:7px 9px;border:1px solid #5f6368;border-radius:6px;outline:0;background:#303134;color:#f8f9fa;font:14px/1.3 system-ui,-apple-system,sans-serif";
    const count = document.createElement("span");
    count.style.cssText = "color:#bdc1c6;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap";
    header.append(input, count);
    const hint = document.createElement("div");
    hint.textContent = "↑/↓ move · Enter open · Shift-Enter new tab · Ctrl-D delete · Esc close";
    hint.style.cssText = "padding:0 5px 7px;color:#9aa0a6;font-size:11px";
    const list = document.createElement("div");
    list.setAttribute("role", "listbox");
    list.style.cssText = "flex:1;min-height:0;overflow:auto;padding:0 2px 4px";
    input.addEventListener("input", () => requestHistoryModel());
    input.addEventListener("keydown", (event) => {
      // The overlay owns its keys; letting them reach the page would scroll it behind the
      // panel and typing would fire normal-mode shortcuts.
      event.stopPropagation();
      const rows = historyRows();
      if (event.code === "Escape") {
        event.preventDefault();
        cancelHistory();
      } else if (event.code === "ArrowDown" || event.ctrlKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        if (rows.length) selectHistoryIndex(historyState.selected + 1);
      } else if (event.code === "ArrowUp" || event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (rows.length) selectHistoryIndex(historyState.selected - 1);
      } else if (event.code === "Enter") {
        event.preventDefault();
        openSelectedHistory(event.shiftKey);
      } else if (event.ctrlKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        deleteSelectedHistory();
      }
    });
    panel.append(header, hint, list);
    shadow.append(panel);
    document.documentElement.append(host);
    paintNow();
    historyState = { host, input, list, count, rows: [], selected: 0, keepSelection: null };
    setMode("history", "…");
    requestHistoryModel();
    requestAnimationFrame(() => input.focus());
  }

  // --- downloads page ---
  //
  // Chrome's answer to "where did my file go" is a shelf plus chrome://downloads. The
  // badge is the shelf; this is the list. It reads downloads.jsonl, which main appends to
  // when a transfer settles, so a file downloaded an hour ago is still findable after the
  // badge is long gone.
  //
  // The row's headline is the ABSOLUTE PATH, not the filename. In a GUI "Show in folder"
  // is the useful action; in a terminal the path itself is the useful thing, because the
  // user can act on it with the tools they already have.

  function cancelDownloads(restoreMode = true) {
    downloadsState?.host.remove();
    downloadsState = null;
    if (restoreMode) normalMode();
  }

  function downloadRowsList() {
    return downloadsState?.rows || [];
  }

  function selectDownloadIndex(index) {
    const rows = downloadRowsList();
    if (!downloadsState || rows.length === 0) {
      setMode("downloads", downloadsState ? "0" : "");
      return;
    }
    const count = rows.length;
    downloadsState.selected = ((index % count) + count) % count;
    for (const [rowIndex, entry] of rows.entries()) {
      const selected = rowIndex === downloadsState.selected;
      entry.row.style.background = selected ? "#3c4043" : "transparent";
      entry.row.style.outline = selected ? "1px solid #8ab4f8" : "none";
    }
    rows[downloadsState.selected].row.scrollIntoView({ block: "nearest" });
    setMode("downloads", `${downloadsState.selected + 1}/${count}`);
  }

  // Copying the path is the terminal's "Show in folder": it puts the one thing the user
  // needs onto the clipboard, ready to paste into the shell they are already in.
  function copySelectedDownloadPath() {
    const entry = downloadRowsList()[downloadsState?.selected];
    if (!entry?.path) return;
    send("copy-text", entry.path);
    downloadsState.hint.textContent = `Copied ${entry.path}`;
    paintNow();
  }

  function openSelectedDownload(newTab) {
    const entry = downloadRowsList()[downloadsState?.selected];
    if (!entry?.path) return;
    cancelDownloads(false);
    send(newTab ? "new-tab" : "navigate", `file://${entry.path}`);
  }

  function requestDownloadsModel() {
    if (!downloadsState) return;
    send("downloads-model", { query: downloadsState.input.value });
  }

  function renderDownloadsModel(model) {
    if (!downloadsState || !model) return;
    if (String(model.query || "") !== downloadsState.input.value) return;
    const { list } = downloadsState;
    const rows = [];
    list.replaceChildren();
    for (const entry of model.rows || []) {
      const row = document.createElement("button");
      row.type = "button";
      row.style.cssText = "display:grid;grid-template-columns:8ch minmax(0,1fr);gap:8px;width:100%;padding:6px 7px;border:0;border-radius:5px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer";
      const state = document.createElement("span");
      // A cancelled row is not a failure and must not read as one — the user did that on
      // purpose, and the row exists to explain why there is no file.
      state.textContent = entry.state === "completed" ? (entry.origin === "print" ? "print" : "done")
        : entry.state === "cancelled" ? "cancel"
        : "failed";
      state.style.cssText = `color:${entry.state === "completed" ? "#81c995" : entry.state === "cancelled" ? "#9aa0a6" : "#f28b82"};font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace`;
      const text = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = entry.path || entry.filename;
      title.style.cssText = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500";
      const meta = document.createElement("small");
      meta.textContent = entry.url;
      meta.style.cssText = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa0a6";
      text.append(title, meta);
      row.append(state, text);
      const index = rows.length;
      row.onmouseenter = () => selectDownloadIndex(index);
      row.onclick = () => { selectDownloadIndex(index); copySelectedDownloadPath(); };
      list.append(row);
      rows.push({ path: entry.path, filename: entry.filename, row });
    }
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = model.query ? `No downloads match ${model.query}` : "No downloads yet";
      empty.style.cssText = "padding:14px 7px;color:#9aa0a6";
      list.append(empty);
    }
    downloadsState.rows = rows;
    downloadsState.count.textContent = model.truncated
      ? `${model.shown} of ${model.total}`
      : `${model.total} ${model.total === 1 ? "file" : "files"}`;
    selectDownloadIndex(0);
  }

  function showDownloads() {
    cancelTransient(false);
    const host = document.createElement("div");
    host.id = "__tweb_downloads__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:flex-start;justify-content:center;padding-top:6vh;background:#0007;pointer-events:auto";
    const shadow = host.attachShadow({ mode: "open" });
    const panel = document.createElement("div");
    panel.style.cssText = "box-sizing:border-box;display:flex;flex-direction:column;width:min(860px,calc(100vw - 32px));max-height:82vh;padding:8px;border:1px solid #5f6368;border-radius:8px;background:#202124;color:#e8eaed;box-shadow:0 12px 36px #000b;font:13px/1.4 system-ui,-apple-system,sans-serif";
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px;padding:2px 4px 8px";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Search downloads";
    input.style.cssText = "flex:1;box-sizing:border-box;min-width:0;padding:7px 9px;border:1px solid #5f6368;border-radius:6px;outline:0;background:#303134;color:#f8f9fa;font:14px/1.3 system-ui,-apple-system,sans-serif";
    const count = document.createElement("span");
    count.style.cssText = "color:#bdc1c6;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap";
    header.append(input, count);
    const hint = document.createElement("div");
    hint.textContent = "↑/↓ move · Enter copy path · Shift-Enter open the file · Esc close";
    hint.style.cssText = "padding:0 5px 7px;color:#9aa0a6;font-size:11px";
    const list = document.createElement("div");
    list.setAttribute("role", "listbox");
    list.style.cssText = "flex:1;min-height:0;overflow:auto;padding:0 2px 4px";
    input.addEventListener("input", () => requestDownloadsModel());
    input.addEventListener("keydown", (event) => {
      // The overlay owns its keys, exactly as the history page does: letting them through
      // would scroll the page behind the panel and fire normal-mode shortcuts.
      event.stopPropagation();
      const rows = downloadRowsList();
      if (event.code === "Escape") {
        event.preventDefault();
        cancelDownloads();
      } else if (event.code === "ArrowDown" || event.ctrlKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        if (rows.length) selectDownloadIndex(downloadsState.selected + 1);
      } else if (event.code === "ArrowUp" || event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (rows.length) selectDownloadIndex(downloadsState.selected - 1);
      } else if (event.code === "Enter") {
        event.preventDefault();
        if (event.shiftKey) openSelectedDownload(false);
        else copySelectedDownloadPath();
      }
    });
    panel.append(header, hint, list);
    shadow.append(panel);
    document.documentElement.append(host);
    paintNow();
    downloadsState = { host, input, list, count, hint, rows: [], selected: 0 };
    setMode("downloads", "…");
    requestDownloadsModel();
    requestAnimationFrame(() => input.focus());
  }

  // --- file chooser ---
  //
  // Chrome opens a native picker. A tmux pane cannot draw one, and Chromium's own attempt
  // from an offscreen window produces nothing at all — the button looks alive and does
  // nothing. This is what replaces it: a path prompt with Tab completion.
  //
  // It is not a consolation prize. The terminal user already knows the path — they got
  // there with ls, fd or fzf — so typing it with completion beats clicking through Finder.
  // What genuinely has no terminal equivalent is dragging a file in from Finder, and
  // nothing here pretends otherwise.

  function cancelFileChooser(deliver = true) {
    if (!fileChooserState) return;
    const host = fileChooserState.host;
    fileChooserState = null;
    host.remove();
    // Chromium is waiting for an answer either way. An unanswered chooser leaves the page
    // believing a dialog is still open, which is the state this path exists to avoid.
    if (deliver) send("file-chooser-resolve", { paths: [] });
    normalMode();
  }

  function submitFileChooser() {
    if (!fileChooserState) return;
    // Several paths separated by whitespace is how a shell user says "these files"; a
    // filename containing a space is spelled with a comma instead, which the split honours.
    const raw = fileChooserState.input.value.trim();
    const paths = raw.includes(",")
      ? raw.split(",").map((entry) => entry.trim()).filter(Boolean)
      : raw.split(/\s+/).filter(Boolean);
    if (paths.length === 0) {
      cancelFileChooser();
      return;
    }
    const host = fileChooserState.host;
    fileChooserState = null;
    host.remove();
    send("file-chooser-resolve", { paths });
    normalMode();
  }

  function requestFileChooserCompletion() {
    if (!fileChooserState) return;
    send("file-chooser-completion", {
      value: fileChooserState.input.value,
      accept: fileChooserState.accept,
    });
  }

  function renderFileChooserCompletion(model) {
    if (!fileChooserState || !model) return;
    if (String(model.value || "") !== fileChooserState.input.value) return;
    fileChooserState.completed = String(model.completed || "");
    const { list } = fileChooserState;
    list.replaceChildren();
    for (const item of model.entries || []) {
      const row = document.createElement("div");
      row.textContent = item.directory ? `${item.name}/` : item.name;
      row.style.cssText = `padding:3px 9px;color:${item.directory ? "#8ab4f8" : "#e8eaed"};font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`;
      list.append(row);
    }
    if (model.truncated) {
      const more = document.createElement("div");
      more.textContent = `… ${model.truncated} more`;
      more.style.cssText = "padding:3px 9px;color:#9aa0a6;font:11px ui-monospace,SFMono-Regular,Menlo,monospace";
      list.append(more);
    }
    list.style.display = (model.entries || []).length ? "block" : "none";
    setMode("chooser", (model.entries || []).length ? String(model.total) : "");
    paintNow();
  }

  function showFileChooser(request) {
    // A reopen after a bad path must replace the panel, not stack a second one over it.
    fileChooserState?.host.remove();
    fileChooserState = null;
    cancelTransient(false);
    const host = document.createElement("div");
    host.id = "__tweb_file_chooser__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:flex-start;justify-content:center;padding-top:6vh;background:#0007;pointer-events:auto";
    const shadow = host.attachShadow({ mode: "open" });
    const panel = document.createElement("div");
    panel.style.cssText = "box-sizing:border-box;display:flex;flex-direction:column;width:min(760px,calc(100vw - 32px));max-height:72vh;padding:8px;border:2px solid #f6a723;border-radius:8px;background:#202124;color:#e8eaed;box-shadow:0 12px 36px #000b;font:13px/1.4 system-ui,-apple-system,sans-serif";
    const heading = document.createElement("div");
    // Naming the accept filter matters: a user offered fewer files than they expected
    // should be able to see that the PAGE asked for that, rather than suspect the chooser.
    heading.textContent = request.multiple
      ? `Choose files to upload${request.accept ? ` (${request.accept})` : ""}`
      : `Choose a file to upload${request.accept ? ` (${request.accept})` : ""}`;
    heading.style.cssText = "padding:2px 5px 7px;color:#f6a723;font-size:12px;font-weight:600";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = String(request.start || "");
    input.placeholder = "~/Downloads/photo.png";
    input.style.cssText = "box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid #5f6368;border-radius:6px;outline:0;background:#303134;color:#f8f9fa;font:13px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace";
    const hint = document.createElement("div");
    // A mistyped path is the failure mode a path prompt has and a GUI picker cannot. It
    // must say so rather than close silently, which would be the "looked like it worked"
    // shape this whole prompt exists to avoid.
    hint.textContent = request.error || (request.multiple
      ? "Tab complete · space or comma separates several files · Enter upload · Esc cancel"
      : "Tab complete · Enter upload · Esc cancel");
    hint.style.cssText = `padding:6px 5px 5px;color:${request.error ? "#f28b82" : "#9aa0a6"};font-size:11px`;
    const list = document.createElement("div");
    list.style.cssText = "display:none;flex:1;min-height:0;overflow:auto;padding:2px 0 3px";
    input.addEventListener("input", () => requestFileChooserCompletion());
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.code === "Escape") {
        event.preventDefault();
        cancelFileChooser();
      } else if (event.code === "Tab") {
        event.preventDefault();
        if (fileChooserState?.completed && fileChooserState.completed !== input.value) {
          input.value = fileChooserState.completed;
        }
        requestFileChooserCompletion();
      } else if (event.code === "Enter") {
        event.preventDefault();
        submitFileChooser();
      }
    });
    panel.append(heading, input, hint, list);
    shadow.append(panel);
    document.documentElement.append(host);
    paintNow();
    fileChooserState = { host, input, list, accept: String(request.accept || ""), completed: "" };
    setMode("chooser", "…");
    requestFileChooserCompletion();
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
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

  // The end that just moved, as a rect. Following the whole selection instead
  // would drag the page to the far end of it — a page-wide selection would snap
  // straight to the top the moment `V` made it.
  function focusRect(selection) {
    if (!selection.focusNode) return null;
    const probe = document.createRange();
    try {
      probe.setStart(selection.focusNode, selection.focusOffset);
      probe.setEnd(selection.focusNode, selection.focusOffset);
    } catch (error) {
      return null;
    }
    const rect = probe.getBoundingClientRect();
    return rect.height || rect.width ? rect : null;
  }

  // Selection is per document, so a target inside a frame has to be selected
  // through that frame's own selection — the parent's would silently stay empty.
  function visualDocument() {
    return visualState?.element?.ownerDocument || document;
  }

  function visualSelection() {
    return (visualDocument().defaultView || window).getSelection();
  }

  // Motions can now leave the block they started in, so a selection that runs off
  // the viewport has to be followed.
  function scrollSelectionIntoView(selection) {
    // `V` selects the page; there is no "the selection" to bring into view, and
    // the caret is the only thing worth following once it exists.
    if (visualState?.pageSelection && !visualState.caret) return;
    const rect = focusRect(selection);
    if (!rect) return;
    const margin = 40;
    let top = 0;
    if (rect.top < margin) top = rect.top - margin;
    else if (rect.bottom > innerHeight - margin) top = rect.bottom - (innerHeight - margin);
    if (top) scrollBy({ top, behavior: "instant" });
  }

  // A collapsed range has no width, so the caret needs its own filled bar; the
  // block outline stays put, otherwise `c` reads as "the selection vanished".
  function updateCaretBar(rect) {
    if (!visualState.caretBar) {
      const bar = document.createElement("div");
      bar.style.cssText = ["position:fixed", "width:2px", "background:#fdd663",
        "box-shadow:0 0 0 1px rgba(0,0,0,.55)", "z-index:2147483646", "pointer-events:none"].join(";");
      document.documentElement.append(bar);
      visualState.caretBar = bar;
    }
    const bar = visualState.caretBar;
    bar.style.left = `${rect.left}px`;
    bar.style.top = `${rect.top}px`;
    bar.style.height = `${rect.height || 16}px`;
  }

  function removeCaretBar() {
    visualState?.caretBar?.remove();
    if (visualState) visualState.caretBar = null;
  }

  function updateVisualSelection() {
    if (!visualState?.selectionMade) return;
    const selection = visualSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (visualState.caret) {
      // A collapsed range measures 0x0 when its container is an element rather than a text
      // node, which is the usual case after collapsing to a selection start — so the bar
      // was drawn at the viewport's top-left corner instead of on the caret. Measure the
      // character the caret sits in front of, the same way the terminal cursor does.
      updateCaretBar(rect.width || rect.height ? rect : firstCharacterRect(range) || rect);
      setMode("visual", "caret v·h·j·k·l·w·b·e·{·}");
    } else {
      removeCaretBar();
      if (visualState.pageSelection) {
        updateOutline(visualState.outline, { left: 1, top: 1, width: innerWidth - 2, height: innerHeight - 2 });
      } else if (rect.width || rect.height) {
        updateOutline(visualState.outline, rect);
      }
      setMode("visual", `text ${selection.toString().length} y·c·o·h·j·k·l·w·b·e`);
    }
    scrollSelectionIntoView(selection);
    // Parks the terminal cursor on the caret so IME composition stays visible.
    reportCaret();
  }

  // The caret starts where the selection starts — except when that point is
  // scrolled off, as it is for `V`'s whole-page selection: collapsing there would
  // put the caret out of sight and yank the page to the top. Start at the top of
  // what is actually on screen instead, which is still inside the selection.
  function visibleSelectionStart(range) {
    const fallback = { node: range.startContainer, offset: range.startOffset };
    const owner = range.startContainer?.ownerDocument || document;
    // Both the range and the probe belong to the target's document, and a frame
    // measures points against itself — so shift out of our coordinates first.
    const shift = frameOffset(owner);
    if (range.getBoundingClientRect().top + shift.y >= 0) return fallback;
    if (typeof owner.caretRangeFromPoint !== "function") return fallback;
    for (const y of [8, 40, 80, 140]) {
      const probe = owner.caretRangeFromPoint(8 - shift.x, y - shift.y);
      const node = probe?.startContainer;
      if (node && range.intersectsNode?.(node)) return { node, offset: probe.startOffset };
    }
    return fallback;
  }

  // `c` used to work on text targets only: picking a link or an image left no
  // selection at all, so there was no way to drop into caret mode. Anchor the caret
  // at the nearest text position to that spot instead.
  function firstTextNode(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return null;
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    return walker.nextNode();
  }

  function caretRangeFor(item) {
    const text = firstTextNode(item.element);
    if (text) {
      const range = item.element.ownerDocument.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 0);
      return range;
    }
    // An image carries no text of its own, so probe around it: the nearest caret
    // position is next to it, and the motions can walk from there.
    const rect = item.rect;
    const probes = [
      [rect.left + 1, rect.top + 1],
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left, Math.min(innerHeight - 1, rect.top + rect.height + 4)],
      [rect.left, Math.max(0, rect.top - 4)],
    ];
    const shift = frameOffset(item.element);
    for (const [x, y] of probes) {
      const probe = item.element.ownerDocument.caretRangeFromPoint?.(x - shift.x, y - shift.y);
      if (probe && !ownId(probe.startContainer?.parentElement).startsWith("__tweb_")) return probe;
    }
    return null;
  }

  // Collapsing to the start, not the end: the point of going back to a caret is
  // to pick a new place to start the selection from.
  function enterCaret() {
    const selection = visualSelection();
    if (!visualState || !selection) return;
    if (!visualState.selectionMade) {
      const range = caretRangeFor(visualState);
      if (!range) {
        flash("no caret position");
        return;
      }
      selection.removeAllRanges();
      selection.addRange(range);
      visualState.selectionMade = true;
      visualState.blockRect = visualState.rect;
      visualState.caret = true;
      updateVisualSelection();
      return;
    }
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    // Keep the block the hint picked outlined so the caret has visible context.
    visualState.blockRect = range.getBoundingClientRect();
    const start = visibleSelectionStart(range);
    selection.collapse(start.node, start.offset);
    visualState.caret = true;
    if (!visualState.pageSelection) updateOutline(visualState.outline, visualState.blockRect);
    updateVisualSelection();
  }

  // The caret is already the selection's anchor, so extending from here needs
  // nothing but a mode change.
  function selectFromCaret() {
    if (!visualState?.caret) return;
    visualState.caret = false;
    updateVisualSelection();
  }

  function moveVisualSelection(key) {
    const selection = visualSelection();
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
      // The block the hint picked is rarely the whole of what one wants to copy,
      // so motions are free to leave it; these two step whole blocks at a time.
      "{": ["backward", "paragraph"],
      "}": ["forward", "paragraph"],
    };
    const motion = motions[key];
    if (!motion) return false;
    if (visualState.caret) {
      selection.modify("move", motion[0], motion[1]);
      updateVisualSelection();
      return true;
    }
    const anchorNode = selection.anchorNode;
    const anchorOffset = selection.anchorOffset;
    const focusNode = selection.focusNode;
    const focusOffset = selection.focusOffset;
    selection.collapse(focusNode, focusOffset);
    selection.modify("move", motion[0], motion[1]);
    const nextFocusNode = selection.focusNode;
    const nextFocusOffset = selection.focusOffset;
    selection.collapse(anchorNode, anchorOffset);
    try {
      selection.extend(nextFocusNode, nextFocusOffset);
    } catch (error) {
      // Extending across a shadow boundary throws; keep the selection we had.
      selection.extend(focusNode, focusOffset);
    }
    updateVisualSelection();
    return true;
  }

  function cancelVisual(restoreMode = true) {
    if (!visualState) return;
    const hadCaret = Boolean(visualState.caret);
    removeCaretBar();
    visualState.outline.remove();
    if (visualState.selectionMade) visualSelection()?.removeAllRanges();
    visualState = null;
    // The terminal cursor was parked on the visual caret, and nothing else reports a
    // caret on an ordinary page — so leaving would strand it on the last position.
    if (hadCaret) reportCaret();
    if (restoreMode) normalMode();
  }

  function enterVisual(item) {
    const outline = makeOutline(item.rect, "#fdd663");
    let selectionMade = false;
    if (item.kind === "text") {
      const range = item.element.ownerDocument.createRange();
      range.selectNodeContents(item.element);
      const selection = (item.element.ownerDocument.defaultView || window).getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      selectionMade = true;
    }
    visualState = { ...item, outline, selectionMade };
    if (selectionMade) updateVisualSelection();
    else if (item.kind === "image") setMode("visual", "image y·Y·u·D·o");
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
      imageURL: "",
      pageSelection: true,
    });
  }

  function copyVisual(smart = true) {
    if (!visualState) return;
    const item = visualState;
    // A caret is a text cursor: `y` there means the text, never the image bitmap
    // or the link URL that a smart copy would reach for.
    if (smart && !item.caret && item.kind === "image") {
      send("copy-image", {
        x: Math.max(0, Math.floor(item.rect.left)),
        y: Math.max(0, Math.floor(item.rect.top)),
        width: Math.max(1, Math.ceil(item.rect.width)),
        height: Math.max(1, Math.ceil(item.rect.height)),
      });
    } else if (smart && !item.caret && item.kind === "link" && item.link?.href) {
      send("copy-text", item.link.href);
    } else {
      // A caret selects nothing, so `y` there copies the block it sits in — the
      // same thing `v` then `y` has always done.
      const selectedText = item.selectionMade ? visualSelection()?.toString() || "" : "";
      const text = selectedText || (typeof item.element.value === "string" ? item.element.value
        : item.element.innerText?.trim() || item.image?.getAttribute("alt")
          || item.element.getAttribute("alt") || item.element.getAttribute("aria-label") || "");
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
    else if (key === "c" && !visualState.caret) enterCaret();
    else if (key === "v" && visualState.caret) selectFromCaret();
    else if (key === "y") copyVisual(true);
    else if (key === "Y") copyVisual(false);
    else if (key === "u") {
      const url = visualState.kind === "image" ? visualState.imageURL : visualState.link?.href;
      if (url) {
        send("copy-text", url);
        cancelVisual(false);
        flash("url");
      }
    } else if (key === "D" && visualState.kind === "image" && visualState.imageURL) {
      send("download", visualState.imageURL);
      cancelVisual(false);
      flash("download");
    } else if (key === "o" || key === "O") {
      const url = visualState.kind === "image"
        ? visualState.imageURL || visualState.link?.href
        : visualState.link?.href;
      if (url) {
        cancelVisual();
        send(key === "O" ? "new-tab" : "navigate", url);
      }
    } else if (key === "p" && visualState.kind === "editable") {
      visualState.element.focus();
      send("paste");
      cancelVisual(false);
      flash("pasted");
    } else if (key === "d") {
      const item = visualState;
      cancelVisual(false);
      enterInspect(item);
    }
    return true;
  }

  function cssSelector(element) {
    if (ownId(element)) return `#${CSS.escape(ownId(element))}`;
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
    lastInspectPayload = null;
    if (restoreMode) normalMode();
  }

  function cancelCommandPalette(restoreMode = true) {
    if (!commandPaletteState) return;
    commandPaletteState.host.remove();
    commandPaletteState = null;
    if (restoreMode) normalMode();
  }

  function startCommandPalette() {
    cancelTransient(false);
    const entries = commandPaletteEntries;
    if (entries.length === 0) {
      setMode("command", emptyPickerReason.command);
      setTimeout(normalMode, 1100);
      return;
    }
    const host = document.createElement("div");
    host.id = "__tweb_command_palette__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    const list = document.createElement("div");
    // Bottom-right, above the mode indicator (which sits at bottom:0). The palette
    // is a menu popping up in a corner, not a dialog blocking the page.
    list.style.cssText = [
      "position:fixed", "right:8px", "bottom:24px",
      "min-width:200px", "max-width:min(380px,calc(100vw - 24px))", "max-height:30vh", "overflow:auto",
      "padding:2px 0", "border:1px solid #5f6368", "border-radius:6px", "background:#111e",
      "box-shadow:0 4px 16px #000a", "color:#e8eaed", "font:13px/1.4 system-ui,sans-serif",
      "pointer-events:auto",
    ].join(";");
    const items = entries.map((entry) => {
      const row = document.createElement("div");
      row.style.cssText = "padding:5px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      const labelSpan = document.createElement("span");
      labelSpan.textContent = entry.label;
      row.append(labelSpan);
      // A click is a first-class confirmation, the way a context menu works.
      row.addEventListener("click", () => {
        if (!commandPaletteState) return;
        cancelCommandPalette(false);
        entry.action();
      });
      list.append(row);
      return { row, ...entry };
    });
    shadow.append(list);
    document.documentElement.append(host);
    paintNow();
    commandPaletteState = { host, items, selected: 0, typed: "" };
    setMode("command", `${entries.length}`);
  }

  // Moving the selection is a DOM change like any other, and at the idle rate the pane is
  // repainted four times a second — so without a nudge a `j` lands up to 250ms after the key.
  // `startCommandPalette` already paints when the menu goes up; every later change to what the
  // menu LOOKS like has to do the same. `setMode` is not that nudge: it updates the indicator's
  // DOM and returns, so the overlays that only call it are relying on the frame clock.
  function selectCommandPaletteIndex(index) {
    const items = commandPaletteState.items;
    items[commandPaletteState.selected].row.style.background = "";
    commandPaletteState.selected = Math.min(items.length - 1, Math.max(0, index));
    items[commandPaletteState.selected].row.style.background = "#1a3a5e";
    items[commandPaletteState.selected].row.scrollIntoView({ block: "nearest" });
    paintNow();
  }

  function handleCommandPaletteKey(event, key) {
    if (!commandPaletteState) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const items = commandPaletteState.items;
    if (key === "Escape") {
      cancelCommandPalette(false);
      // The menu coming DOWN is a change to the pane too, and the cancel path has no paint of
      // its own — Escape looked ignored for the same quarter second the moves did.
      paintNow();
    } else if (key === "Enter") {
      const entry = items[commandPaletteState.selected];
      cancelCommandPalette(false);
      entry.action();
      paintNow();
    } else if (key === "j" || key === "ArrowDown") {
      selectCommandPaletteIndex(commandPaletteState.selected + 1);
    } else if (key === "k" || key === "ArrowUp") {
      selectCommandPaletteIndex(commandPaletteState.selected - 1);
    } else if (key.length === 1 && /[a-z]/i.test(key)) {
      // Fuzzy search: filter by typed characters against label. If exactly one
      // entry matches, run it immediately and close — the palette is a menu,
      // not a mode, so there is no "confirm" step when the filter is unambiguous.
      commandPaletteState.typed += key.toLowerCase();
      const matches = items.filter((item) =>
        item.label.toLowerCase().includes(commandPaletteState.typed));
      if (matches.length === 1) {
        cancelCommandPalette(false);
        matches[0].action();
        paintNow();
      } else if (matches.length > 0) {
        selectCommandPaletteIndex(items.indexOf(matches[0]));
      } else {
        // A key that matches nothing still consumed a keystroke. Without a paint the pane is
        // identical to the frame before it, which reads as the palette having missed the key —
        // the typed buffer has changed, and the next letter filters against it.
        commandPaletteState.typed = commandPaletteState.typed.slice(0, -1);
      }
    }
    return true;
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
      "y selector · h HTML · t text · Esc",
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
    else if (key === "y" || key === "h" || key === "t") {
      // Clipboard stays — a person at the terminal can still paste. The agent gets the
      // same context as an Orca design-mode attachment: the selector, the HTML, the text,
      // and the element's box, all in one message, so it does not have to re-fetch what the
      // user already picked. Which of the three the agent leans on is its call; it gets all
      // three rather than just the one the key selected.
      const payload = {
        selector: item.selector,
        html: item.element.outerHTML,
        text: item.element.innerText || item.element.textContent || "",
        rect: { width: Math.round(item.rect.width), height: Math.round(item.rect.height),
                left: Math.round(item.rect.left), top: Math.round(item.rect.top) },
        url: location.href,
        tag: item.element.localName,
      };
      if (key === "y") send("copy-text", item.selector);
      else if (key === "h") send("copy-text", item.element.outerHTML);
      else if (key === "t") send("copy-text", item.element.innerText || item.element.textContent || "");
      // The agent sees this only if it asked for it — `tweb-agent-inspect` is a preload
      // listener an agent registers by calling the `inspect-element` MCP tool once, so a
      // pane with no agent driving it pays nothing.
      window.dispatchEvent(new CustomEvent("tweb-agent-inspect", { detail: payload }));
      cancelInspect(false);
      flash(key === "y" ? "selector" : key === "h" ? "html" : "text");
    }
    return true;
  }

  function closeBrowserContextMenu(action = null) {
    const host = document.getElementById("__tweb_context_menu__");
    if (!host) return;
    host.remove();
    const returnFocus = contextMenuReturnFocus;
    contextMenuReturnFocus = null;
    returnFocus?.focus?.({ preventScroll: true });
    send(action ? "context-menu-command" : "context-menu-dismiss", action);
    if (isEditable(activeElement())) setMode("insert");
    else normalMode();
  }

  function showBrowserContextMenu(model) {
    if (!topFrame || !model?.items?.length) return;
    // Main has already replaced the one-shot command state with this menu. Remove
    // the old DOM without dismissing that new state, but restore the focus the old
    // menu borrowed before remembering where this one should return it.
    const previousMenu = document.getElementById("__tweb_context_menu__");
    if (previousMenu) {
      previousMenu.remove();
      contextMenuReturnFocus?.focus?.({ preventScroll: true });
      contextMenuReturnFocus = null;
    }
    cancelTransient(false);
    contextMenuReturnFocus = activeElement();
    const host = document.createElement("div");
    host.id = "__tweb_context_menu__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const shadow = host.attachShadow({ mode: "closed" });
    const backdrop = document.createElement("div");
    backdrop.style.cssText = "position:fixed;inset:0;pointer-events:auto";
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.tabIndex = -1;
    menu.style.cssText = [
      "position:fixed", "box-sizing:border-box", "min-width:240px", "max-width:min(360px,calc(100vw - 8px))",
      "padding:5px", "border:1px solid #5f6368", "border-radius:8px", "outline:0",
      "background:#202124", "color:#f1f3f4", "box-shadow:0 10px 30px #000a",
      "font:13px/1.35 system-ui,-apple-system,sans-serif", "pointer-events:auto",
    ].join(";");
    const buttons = [];
    let selected = -1;
    const select = (index) => {
      if (!buttons.length) return;
      if (selected >= 0) buttons[selected].style.background = "transparent";
      selected = (index + buttons.length) % buttons.length;
      buttons[selected].style.background = "#3c4043";
      buttons[selected].focus({ preventScroll: true });
    };
    for (const item of model.items) {
      if (item.separator) {
        const separator = document.createElement("div");
        separator.setAttribute("role", "separator");
        separator.style.cssText = "height:1px;margin:4px 3px;background:#5f6368";
        menu.append(separator);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = item.label;
      button.disabled = !item.enabled;
      button.style.cssText = "display:block;box-sizing:border-box;width:100%;padding:6px 10px;border:0;border-radius:4px;outline:0;background:transparent;color:inherit;text-align:left;font:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      if (button.disabled) button.style.opacity = ".42";
      else {
        const index = buttons.length;
        buttons.push(button);
        button.onmouseenter = () => select(index);
        button.onmouseleave = () => {
          if (selected === index) button.style.background = "transparent";
        };
        button.onclick = () => closeBrowserContextMenu(item.action);
      }
      menu.append(button);
    }
    menu.onkeydown = (event) => {
      if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (event.key === "ArrowDown") select(selected + 1);
      else if (event.key === "ArrowUp") select(selected - 1);
      else if (event.key === "Home") select(0);
      else if (event.key === "End") select(buttons.length - 1);
      else if (["Enter", " "].includes(event.key) && selected >= 0) buttons[selected].click();
      else if (event.key === "Escape") closeBrowserContextMenu();
    };
    backdrop.onclick = () => closeBrowserContextMenu();
    backdrop.oncontextmenu = (event) => {
      event.preventDefault();
      closeBrowserContextMenu();
    };
    shadow.append(backdrop, menu);
    document.documentElement.append(host);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(Number(model.x) || 0, innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(Number(model.y) || 0, innerHeight - rect.height - 4))}px`;
    paintNow();
    requestAnimationFrame(() => {
      menu.focus({ preventScroll: true });
      select(0);
    });
  }

  function contextTarget(point) {
    if (!topFrame || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
    const element = document.elementFromPoint(point.x, point.y);
    const rect = element && visibleRect(element);
    if (!element || !rect) return null;
    const link = element.closest?.("a[href]") || null;
    const image = element.matches?.("img,picture,canvas,svg,video,[role=img]")
      ? element.querySelector?.("img,canvas,svg,video") || element
      : null;
    return { element, rect, link, image, imageURL: imageSource(image) };
  }

  function inspectContextPoint(point) {
    const item = contextTarget(point);
    if (!item) return;
    cancelTransient(false);
    enterInspect(item);
  }

  function copyContextImage(point) {
    const item = contextTarget(point);
    if (!item?.image) return;
    send("copy-image", {
      x: Math.max(0, Math.floor(item.rect.left)),
      y: Math.max(0, Math.floor(item.rect.top)),
      width: Math.max(1, Math.ceil(item.rect.width)),
      height: Math.max(1, Math.ceil(item.rect.height)),
    });
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
    cancelCommandPalette(false);
    cancelPrompt(false);
    cancelSearch(true, false);
    cancelVisual(false);
    cancelInspect(false);
    cancelTabList(false);
    cancelHistory(false);
    cancelDownloads(false);
    cancelFileChooser();
    cancelHelp(false);
    let restoredContextFocus = false;
    const contextMenu = document.getElementById("__tweb_context_menu__");
    if (contextMenu) {
      contextMenu.remove();
      const returnFocus = contextMenuReturnFocus;
      contextMenuReturnFocus = null;
      returnFocus?.focus?.({ preventScroll: true });
      restoredContextFocus = true;
      send("context-menu-dismiss");
    }
    resetPendingG();
    resetPendingZ();
    if (restoreMode) {
      if (restoredContextFocus && isEditable(activeElement())) setMode("insert");
      else normalMode();
    }
  }

  // `Ctrl-;` flips the whole tmux/browser input plumbing, which is the right tool
  // for a long session inside a web app. Insert mode is the cheap counterpart:
  // a page-local pause of TWeb's own keys so a site's shortcuts (j/k on a feed,
  // f on a player) work, with Escape to come straight back.
  function enterInsertMode() {
    insertMode = true;
    cancelTransient(false);
    // setMode tells the engine to deliver keys natively. A page's own shortcuts
    // (m to mute, j/k on a feed) ignore synthetic events, so routing them
    // through the renderer would make insert mode look like it does nothing.
    setMode("insert", "Esc");
  }

  function leaveInsertMode() {
    if (!insertMode) return;
    insertMode = false;
    // normalMode picks the mode that fits the current focus, and setMode tells
    // the engine whether keys still need to go out natively.
    normalMode();
  }

  function hasTransientMode() {
    return Boolean(pickerState || promptHost || searchState || visualState || inspectState || tabListState || historyState || downloadsState || fileChooserState || helpHost || pendingG || pendingZ || document.getElementById("__tweb_context_menu__"));
  }

  function handleNormalKey(event) {
    if (!vimiumEnabled || !shortcutFrame) return;
    const key = physicalKey(event);

    // The Escape we asked the main process to deliver belongs to the page. Let
    // it run, then take focus back so the next key is a TWeb command again.
    if (key === "Escape" && passThroughEscape) {
      passThroughEscape = false;
      clearTimeout(passThroughEscapeTimer);
      setTimeout(() => {
        activeElement()?.blur?.();
        normalMode();
      }, 0);
      return;
    }

    // Escape is handled before defaultPrevented/isComposing/editable checks so one
    // physical press always cancels the current TWeb mode.
    if (key === "Escape" && hasTransientMode()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelTransient();
      return;
    }

    // Insert mode hands every key to the page so its own shortcuts work; Escape
    // is the one key TWeb keeps, otherwise there would be no way back.
    if (insertMode) {
      if (key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      leaveInsertMode();
      return;
    }

    // An offscreen window never gets Chromium's own fullscreen Escape handling,
    // so the page would stay fullscreen until a click or a resize broke it.
    if (key === "Escape" && document.fullscreenElement) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void document.exitFullscreen?.();
      return;
    }

    if (handleHelpKey(event, key)) return;
    if (handlePickerKey(event, key)) return;
    if (handleCommandPaletteKey(event, key)) return;
    if (handleVisualKey(event, key)) return;
    if (handleInspectKey(event, key)) return;
    if (handleTabListKey(event, key)) return;
    if (handleSearchKey(event, key)) return;
    if (commandPaletteState) return;
    if (searchState || promptHost || historyState || downloadsState || fileChooserState) return;

    // The keys a Chrome refugee's hands already know. `H`/`L` do the same thing and are
    // what a vim user reaches for, but nobody arrives with that reflex — they arrive with
    // this one, and finding it dead is a small silent failure on every mistyped step.
    //
    // Alt-arrow rather than Cmd-[: a terminal cannot deliver Cmd combinations to the page
    // without the bypass mode being on, so binding it here would work only sometimes,
    // which is worse than not binding it.
    //
    // BOTH are bound only when nothing editable has focus, and for the same reason: in a
    // text field Chrome gives these keys to the field, not to history — Backspace deletes
    // a character and Alt-arrow moves the caret one word. Measured here without the
    // editable guard on the Alt-arrow branch: with the caret in an input, `M-Left`
    // navigated away from the page and took the typed text with it. Losing a half-filled
    // form to a caret-movement keystroke is exactly the destroy-work case the Backspace
    // guard already existed to prevent; the two keys need the same guard.
    if (event.altKey && !event.ctrlKey && !event.metaKey
      && (key === "ArrowLeft" || key === "ArrowRight")
      && !eventIsEditable(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send(key === "ArrowLeft" ? "history-back" : "history-forward");
      return;
    }
    if (key === "Backspace" && !event.ctrlKey && !event.metaKey && !event.altKey
      && !eventIsEditable(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send("history-back");
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (eventIsEditable(event)) {
      if (key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        // Hand the page a real Escape first: a suggestion panel closes from the
        // focused field, and blurring first would make the key meaningless.
        dismissPageOverlay();
      } else {
        setMode("insert");
      }
      return;
    }

    if (pendingG) {
      resetPendingG();
      if (key === "g") scrollSurfaceTo(0);
      else if (key === "h") showHistory();
      else if (key === "d") showDownloads();
      // Paper is a chord, not Ctrl-P: Ctrl-P keeps meaning save-as-PDF, which is the case
      // almost every press wants, and silently promoting it to a paper job would surprise
      // someone who wanted the file.
      else if (key === "p") send("print-paper");
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
      case "?": showHelp(); break;
      case "i": enterInsertMode(); break;
      case "f": startHints(false); break;
      case "F": startHints(true); break;
      case "v": startVisual(); break;
      case "V": selectPageText(); break;
      case "b": showTabList(); break;
      case "I": startInspect(); break;
      case "/": showSearch(); break;
      case "n": if (lastSearch) stepSearch(true); else handled = false; break;
      case "N": if (lastSearch) stepSearch(false); else handled = false; break;
      case "h": scrollSurfaceBy(-90, 0); break;
      case "j": scrollSurfaceBy(0, 90); break;
      case "k": scrollSurfaceBy(0, -90); break;
      case "l": scrollSurfaceBy(90, 0); break;
      case "d": scrollSurfaceBy(0, scrollSurfaceHeight() * 0.5); break;
      case "u": scrollSurfaceBy(0, -scrollSurfaceHeight() * 0.5); break;
      case "s": startScrollPicker(); break;
      case "m": send("reclaim-audio"); flash("audio"); break;
      case "G": scrollSurfaceTo(scrollSurfaceEnd()); break;
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
      case "y": send("copy-url"); flash("URL"); break;
      case "r": send("reload"); break;
      case "w": send("toggle-float"); break;
      case "c": startCommandPalette(); break;
      case "Escape":
        // Release a picked scroll or pan surface before bothering the page.
        if (scrollSurface() || panSurface()) {
          scrollTarget = null;
          panTarget = null;
          normalMode();
        } else {
          handled = dismissPageOverlay();
        }
        break;
      default: handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  ipcRenderer.on("tweb-shortcuts-mode", (_event, mode) => {
    const next = mode || {};
    vimiumEnabled = Boolean(next.vimium);
    bypassEnabled = Boolean(next.bypass);
    const root = document.documentElement;
    if (root) {
      root.dataset.twebInputMode = modeIndicator();
      root.dataset.twebBypass = bypassEnabled ? "on" : "off";
    }
    // The global toggle supersedes the page-local one; leaving both on would
    // make Escape mean two different things.
    insertMode = false;
    // The engine clears its own native-key mirror whenever it broadcasts this,
    // so drop the dedupe cache — otherwise a focused input would never re-arm
    // native delivery and its arrow keys would go back to being ignored.
    engineNativeKeys = false;
    if (!vimiumEnabled) cancelTransient(false);
    normalMode();
  });

  // Cell size in CSS pixels. Only main knows it — it owns the pane geometry and the
  // zoom factor — and it changes on every resize and zoom step.
  ipcRenderer.on("tweb-cell-metrics", (_event, metrics) => {
    const next = metrics && metrics.width > 0 && metrics.height > 0 ? metrics : null;
    const same = Boolean(next) === Boolean(cellMetrics) && (!next || (next.width === cellMetrics.width
      && next.height === cellMetrics.height && next.columns === cellMetrics.columns));
    cellMetrics = next;
    if (same) return;
    // The surface moved even though the caret did not, so the deduped report has to go.
    lastCaretReport = "";
    reportCaret();
  });

  ipcRenderer.on("tweb-find-result", (_event, result) => {
    if (stepSearchPending) {
      stepSearchPending = false;
      send("stop-find", "keepSelection");
    }
    if (!searchState) return;
    // Only the last outstanding request un-hides the bar: typing faster than the search
    // answers would otherwise put the query back into the document mid-search, and the
    // next result would count the bar again.
    searchPending = Math.max(0, searchPending - 1);
    if (searchPending === 0) {
      clearTimeout(searchRestoreTimer);
      restoreSearchBarText();
      // Enter asked to close once the match it requested had actually landed.
      if (searchState.closeOnResult) {
        cancelSearch(false);
        return;
      }
    }
    searchState.result.textContent = result?.matches ? `${result.activeMatchOrdinal}/${result.matches}` : "0/0";
    setMode("search", searchState.result.textContent);
  });

  ipcRenderer.on("tweb-audio-state", (_event, state) => {
    audioState = { muted: Boolean(state?.muted), owner: state?.owner || null };
    renderIndicator();
  });

  ipcRenderer.on("tweb-select-all", () => {
    if (!frameOwnsCaret()) return;
    const active = activeElement();
    if (isTag(active, "input") || isTag(active, "textarea")) {
      active.select();
    } else {
      document.execCommand("selectAll");
    }
  });

  // Cmd motions are driven directly rather than dispatched as key events, for the same
  // reason `tweb-select-all` is: a `meta` modifier goes down the native path, and a
  // synthetic native key carries no default editing behaviour with it. Here the renderer
  // already knows the selection and the focused field, which is all these need.
  ipcRenderer.on("tweb-caret-motion", (_event, motion) => {
    if (!frameOwnsCaret()) return;
    const active = activeElement();
    const key = motion?.key;
    const extend = Boolean(motion?.extend);
    if (moveTextControlCaret(active, key, extend)) return;
    if (active?.isContentEditable) moveContentEditableCaret(key, extend);
  });

  ipcRenderer.on("tweb-tabs", (_event, model) => {
    renderTabList(model);
  });

  ipcRenderer.on("tweb-history", (_event, model) => {
    renderHistoryModel(model);
  });

  ipcRenderer.on("tweb-downloads", (_event, model) => {
    renderDownloadsModel(model);
  });

  ipcRenderer.on("tweb-file-chooser", (_event, request) => {
    showFileChooser(request || {});
  });

  ipcRenderer.on("tweb-file-chooser-completion", (_event, model) => {
    renderFileChooserCompletion(model);
  });

  ipcRenderer.on("tweb-transfer", (_event, summary) => {
    transferState = summary || null;
    renderIndicator();
    // A transfer badge that waits for the frame clock can miss the completion entirely on
    // an idle page — the one moment the badge exists to cover.
    paintNow();
  });

  // Paper printing rides the transfer badge rather than `flash`: the outcome of a job the
  // user cannot see in any queue window needs to outlast 650ms, and "no printer configured"
  // is the answer they are most likely to get and least able to guess.
  //
  // It deliberately overwrites the "✓ file.pdf" the save already posted. The PDF is on disk
  // either way and `gd` still lists it; what changes is whether the paper the user asked
  // for is coming, and that is the newer and more surprising fact.
  ipcRenderer.on("tweb-print-paper", (_event, result) => {
    if (!result) return;
    transferState = {
      text: result.ok ? `⎙ ${result.filename} queued for printer` : `✕ ${result.message}`,
      tone: result.ok ? "done" : "failed",
      state: "completed",
      path: result.message,
    };
    renderIndicator();
    paintNow();
    // Long enough to read a sentence, since it is the only report of the job there will be.
    setTimeout(() => {
      if (transferState && transferState.path === result.message) {
        transferState = null;
        renderIndicator();
        paintNow();
      }
    }, 6000);
  });

  ipcRenderer.on("tweb-tab-state", (_event, model) => {
    updateTabState(model);
  });

  ipcRenderer.on("tweb-context-menu", (_event, model) => {
    showBrowserContextMenu(model);
  });

  ipcRenderer.on("tweb-context-inspect", (_event, point) => {
    inspectContextPoint(point);
  });

  ipcRenderer.on("tweb-context-copy-image", (_event, point) => {
    copyContextImage(point);
  });

  // Only the top frame answers agent requests; subframe refs would collide.
  ipcRenderer.on("tweb-agent-request", (_event, request) => {
    if (!topFrame || !request || typeof request.id !== "number") return;
    try {
      ipcRenderer.send("tweb-agent-response", { id: request.id, result: agentDispatch(request) });
    } catch (error) {
      ipcRenderer.send("tweb-agent-response", { id: request.id, error: String(error?.message || error) });
    }
  });

  ipcRenderer.on("tweb-frame-mode", (_event, state) => {
    if (topFrame && state?.mode) setMode(state.mode, state.detail || "");
  });

  ipcRenderer.on("tweb-terminal-text", (_event, text) => {
    if (!vimiumEnabled || insertMode || !shortcutFrame || typeof text !== "string" || [...text].length !== 1) return;
    const mapped = commandKey(text);
    if (!mapped || eventIsEditable({ composedPath: () => [] })) return;
    // Only the frame that owns focus handles terminal text. The main frame
    // yields when an iframe is focused; background subframes ignore it.
    if (topFrame && isTag(document.activeElement, "iframe", "frame")) return;
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

  ipcRenderer.on("tweb-terminal-key", (_event, payload) => {
    if (!payload || typeof payload.key !== "string") return;
    const active = activeElement() || document.body;
    const editable = isEditable(active);
    // Insert mode must not rewrite Korean keys to their Latin command letters —
    // the page is receiving them as text, not as TWeb commands.
    const mapped = vimiumEnabled && shortcutFrame && !editable && !insertMode
      ? commandKey(payload.key, Boolean(payload.shiftKey))
      : payload.key;
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
  });

  addEventListener("keydown", handleNormalKey, true);
  addEventListener("focusin", (event) => {
    if (vimiumEnabled && isEditable(event.target) && !searchState && !promptHost) setMode("insert");
    reportCaret();
  }, true);
  addEventListener("focusout", () => queueMicrotask(() => {
    // BrowserWindow stays hidden for offscreen painting. Once its focused input
    // blurs, Chromium may stop servicing requestAnimationFrame altogether, which
    // used to leave both the IME surface and terminal cursor behind indefinitely.
    // A microtask still runs after the complete focus transition (including the
    // matching focusin), without depending on a visible frame clock.
    if (!hasTransientMode()) normalMode();
    reportCaret();
  }), true);
  for (const event of ["input", "keyup", "click", "selectionchange"]) {
    document.addEventListener(event, reportCaret, true);
  }
  document.addEventListener("scroll", reportCaret, true);
  addEventListener("resize", reportCaret);
  addEventListener("blur", () => {
    cancelPicker(false);
    resetPendingG();
    resetPendingZ();
  });

  // The main-world shim cannot reach IPC, so it announces the request as a DOM event and
  // this listener carries it across. Every frame listens: an iframe's print() is the
  // parent page's print in Chrome too.
  addEventListener("tweb-print-request", () => send("print"));

  const initializeDocument = () => {
    document.documentElement.dataset.twebInputMode = modeIndicator();
    if (shortcutFrame) {
      ensureIndicator();
      normalMode();
      reportCaret();
    }
  };
  if (document.documentElement) initializeDocument();
  else addEventListener("DOMContentLoaded", initializeDocument, { once: true });

  // How a preload that is alive but unregistered gets itself back on the books.
  //
  // The engine drops a key when the frame it would go to is not in its ready set, and after
  // a renderer crash and reload that set can end up empty while this preload is running
  // perfectly well — the page paints, the mode badge is there, and every shortcut is
  // silently discarded. The engine pings on a dropped key; answering with the same
  // registration it would have sent at startup is the whole repair.
  //
  // Safe to answer more than once: `tweb-preload-ready` is idempotent on the engine side —
  // it sets membership in two sets by frame key rather than accumulating anything.
  ipcRenderer.on("tweb-are-you-there", () => {
    ipcRenderer.send("tweb-preload-ready", { shortcutFrame });
  });

  // Register only after every listener above is installed. Main then targets
  // this frame for IPC broadcasts without racing preload initialization.
  // Report whether this frame can run TWeb shortcuts. A cross-origin subframe
  // cannot, and main needs to know so it does not hand keys to a frame that
  // will silently drop them.
  ipcRenderer.send("tweb-preload-ready", { shortcutFrame });
}
