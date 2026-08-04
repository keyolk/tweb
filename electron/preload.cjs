const { ipcRenderer } = require("electron");

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
  let shortcutsEnabled = true;
  let insertMode = false;
  let mediaHoverTimer = null;
  let mediaHoverNudge = 0;
  let passThroughEscape = false;
  let passThroughEscapeTimer = null;
  let scrollTarget = null;
  let tabListRefresh = false;
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
  let helpHost = null;
  let indicatorHost = null;
  let indicatorLabel = null;
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
    help: "?",
    passthrough: "P",
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
    else if (insertMode) setMode("insert", "Esc");
    else if (isEditable(activeElement())) setMode("insert");
    else setMode("normal", scrollSurface() ? "scroll" : "");
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

  const interactiveSelector = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary", "label[for]",
    "audio", "video", "canvas", "[contenteditable=true]", "[onclick]",
    "[jsaction]:not([jsaction=''])", "[aria-haspopup]", "[aria-controls]",
    "[role=button]", "[role=link]", "[role=menuitem]", "[role=menuitemcheckbox]", "[role=menuitemradio]",
    "[role=option]", "[role=tab]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=treeitem]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function hasPointerIntent(element) {
    if (!(element instanceof Element) || element.id.startsWith("__tweb_")) return false;
    const style = getComputedStyle(element);
    if (style.pointerEvents === "none") return false;
    if (element.matches(interactiveSelector) || typeof element.onclick === "function") return true;
    if ([...element.attributes].some((attribute) => /^on(?:click|mouse|pointer|touch|key)/i.test(attribute.name))) return true;
    if (style.cursor !== "pointer") return false;
    const root = element.getRootNode();
    const parent = element.parentElement || root instanceof ShadowRoot && root.host || null;
    return !(parent instanceof Element) || getComputedStyle(parent).cursor !== "pointer";
  }

  function clickableAncestor(element) {
    let current = element;
    while (current instanceof Element) {
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
      const host = root === document ? null : root.host;
      const bounds = host instanceof Element ? visibleRect(host) : null;
      if (host && !bounds) continue;
      for (const [x, y] of probes) {
        if (bounds && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom)) {
          continue;
        }
        const hits = typeof root.elementsFromPoint === "function" ? root.elementsFromPoint(x, y) : [];
        const target = hits.map(clickableAncestor).find(Boolean);
        if (target) found.add(target);
      }
    }
    return [...found];
  }

  const mediaControlPresentation = {
    play: { label: "재생/일시정지" },
    mute: { label: "음소거" },
    fullscreen: { label: "전체화면" },
    menu: { label: "메뉴" },
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
    const controls = media instanceof HTMLVideoElement
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
      .filter((element) => !element.id?.startsWith("__tweb_") && hasPointerIntent(element));
  }

  function interactiveTargets() {
    const roots = collectRoots();
    const semantic = roots.flatMap((root) => [...root.querySelectorAll(interactiveSelector)]);
    const media = semantic.filter((element) => element.matches("video,audio"));
    const elements = [
      ...semantic.filter((element) => !element.matches("video,audio")),
      ...pointerIntentTargets(roots),
    ];
    const targets = uniqueVisibleTargets(hitTestTargets(elements), (element) => ({
      nativeSurface: element instanceof HTMLCanvasElement,
    })).filter((item) => !item.element.matches("video,audio,iframe"));
    return [...targets, ...media.flatMap(mediaControlTargets)]
      .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
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

  // Comment panels, sidebars and chat logs scroll independently of the page and
  // only react to a wheel while the pointer is over them, so `j`/`k` on the
  // document does nothing. Let the user pick which surface the scroll keys drive.
  function scrollableTargets() {
    const scrollable = collectRoots()
      .flatMap((root) => [...root.querySelectorAll("*")])
      .filter((element) => {
        if (element.id?.startsWith("__tweb_")) return false;
        const overflow = getComputedStyle(element);
        if (!/auto|scroll|overlay/.test(`${overflow.overflowY} ${overflow.overflowX}`)) return false;
        return element.scrollHeight > element.clientHeight + 8
          || element.scrollWidth > element.clientWidth + 8;
      })
      .slice(0, 200);

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
    // Innermost first: that is usually the one under discussion.
    return targets.sort((left, right) =>
      right.element.compareDocumentPosition(left.element) & Node.DOCUMENT_POSITION_CONTAINED_BY
        ? -1
        : left.rect.top - right.rect.top || left.rect.left - right.rect.left);
  }

  function scrollSurface() {
    if (scrollTarget?.isConnected && visibleRect(scrollTarget)) return scrollTarget;
    scrollTarget = null;
    return null;
  }

  function scrollSurfaceBy(left, top) {
    const target = scrollSurface();
    if (target) target.scrollBy({ left, top, behavior: "instant" });
    else scrollBy({ left, top, behavior: "instant" });
  }

  function scrollSurfaceTo(top) {
    const target = scrollSurface();
    if (target) target.scrollTo({ top, behavior: "instant" });
    else scrollTo({ top, behavior: "instant" });
  }

  function scrollSurfaceHeight() {
    return scrollSurface()?.clientHeight || innerHeight;
  }

  function scrollSurfaceEnd() {
    return scrollSurface()?.scrollHeight ?? document.documentElement.scrollHeight;
  }

  function startScrollPicker() {
    startPicker(scrollableTargets(), "scroll", (item) => {
      scrollTarget = item.element;
      // Some panels also gate their wheel handling on hover, so move the pointer.
      send("native-hover", hintClickPoint(item));
      normalMode();
    });
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
    if (!(media instanceof HTMLMediaElement)) return false;
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
        if (!(frame instanceof Element)) break;
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
  let caretCanvas = null;
  let lastCaretReport = "";

  function caretPoint() {
    const element = activeElement();
    if (!isEditable(element) || element instanceof HTMLSelectElement) return null;
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height || box.bottom <= 0 || box.top >= innerHeight) return null;

    const computed = getComputedStyle(element);
    let x = box.left + (parseFloat(computed.paddingLeft) || 0) + 1;
    let y = box.top + (parseFloat(computed.paddingTop) || 0) + 1;
    let height = Math.max(12, parseFloat(computed.lineHeight)
      || (parseFloat(computed.fontSize) || 13) * 1.25);

    try {
      if (element instanceof HTMLInputElement) {
        caretCanvas = caretCanvas || document.createElement("canvas").getContext("2d");
        caretCanvas.font = computed.font || `${computed.fontSize} ${computed.fontFamily}`;
        const before = element.value.slice(0, element.selectionStart ?? element.value.length);
        x += caretCanvas.measureText(before).width - element.scrollLeft;
        y = box.top + Math.max(1, (box.height - height) / 2);
      } else if (element instanceof HTMLTextAreaElement) {
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

  function reportCaret() {
    if (!topFrame && !document.hasFocus()) return;
    const caret = caretPoint();
    const point = caret ? topViewportPoint(caret) : null;
    const report = point ? `${Math.round(point.x)},${Math.round(point.y)},${Math.round(caret.height)}` : "";
    if (report === lastCaretReport) return;
    lastCaretReport = report;
    send("caret", point ? { ...point, height: caret.height } : null);
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
    const forLabel = element.id
      ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.innerText
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
    if (element instanceof HTMLSelectElement) return element.value;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.type === "password" ? "" : element.value;
    }
    return element.isContentEditable ? (element.innerText || "").slice(0, 200) : undefined;
  }

  function agentState(element) {
    const state = {};
    if (element.disabled) state.disabled = true;
    if (element instanceof HTMLInputElement && /^(checkbox|radio)$/.test(element.type)) {
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
        if (!(element instanceof HTMLSelectElement)) throw new Error(`@${ref} is not a <select>`);
        const option = [...element.options].find((candidate) =>
          candidate.value === value || candidate.label === value || candidate.text === value);
        if (!option) throw new Error(`option ${JSON.stringify(value)} not found in @${ref}`);
        element.value = option.value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { value: element.value };
      }
      case "check":
      case "uncheck": {
        if (!(element instanceof HTMLInputElement)) throw new Error(`@${ref} is not checkable`);
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
      default: throw new Error(`unknown agent method ${JSON.stringify(request.method)}`);
    }
  }

  const shortcutHelpSections = [
    ["이동", [
      ["h · j · k · l", "왼쪽 · 아래 · 위 · 오른쪽 스크롤"],
      ["d · u", "반 페이지 아래 · 위"],
      ["gg · G", "페이지 맨 위 · 맨 아래"],
      ["H · L", "history 뒤로 · 앞으로"],
    ]],
    ["열기와 탭", [
      ["f · F", "hint로 열기 · 새 탭에서 열기"],
      ["o · O / t", "현재 탭 · 새 탭 omnibox"],
      ["b", "열린 탭 목록"],
      ["J · K", "이전 · 다음 탭"],
      ["x · X", "탭 닫기 · 최근 탭 복원"],
      ["r · gi", "새로고침 · 첫 입력 요소 focus"],
      ["s", "스크롤할 내부 영역 선택 (Esc로 페이지 복귀)"],
    ]],
    ["검색과 선택", [
      ["/ · n · N", "검색 · 다음 · 이전 결과"],
      ["v · V", "visual picker · 페이지 전체 선택"],
      ["h/l · b/w/e · j/k · 0/$", "visual 선택 범위 조정"],
      ["y · Y · u", "smart copy · text copy · URL copy"],
      ["o/O · p · d", "링크 열기 · 붙여넣기 · inspect"],
      ["I", "inspect picker"],
    ]],
    ["Browser와 mode", [
      ["zi · zo · zz", "확대 · 축소 · 기본 배율"],
      ["Ctrl + / - / 0", "browser zoom"],
      ["Ctrl-Tab / PgUp / PgDn", "browser tab 전환"],
      ["Ctrl-W", "현재 browser tab 닫기"],
      ["i", "insert mode — 페이지 자체 단축키 사용, Esc로 복귀"],
      ["Ctrl-;", "Shortcuts ↔ web passthrough"],
      ["Ctrl-C", "Shortcuts mode에서 TWeb 종료"],
      ["Esc", "현재 mode · 전체화면 · 입력 focus 해제"],
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
    heading.innerHTML = '<strong style="display:block;font-size:19px;color:#fff">TWeb shortcuts</strong><span style="color:#9aa0a6">Shortcuts mode · <kbd>?</kbd> 또는 <kbd>Esc</kbd>로 닫기</span>';
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "닫기  Esc";
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
    setMode("help", "?·Esc 닫기");
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
    input.placeholder = newTab ? "새 탭에서 URL 또는 검색어 열기" : "URL 또는 검색어 열기";
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
    paintNow();
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
    title.textContent = `열린 탭 ${model.tabs.length}개 · j/k 이동 · Enter 열기 · x 닫기 · 1-9 바로 열기 · Esc`;
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
      const item = visualState;
      cancelVisual(false);
      enterInspect(item);
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
    cancelHelp(false);
    document.getElementById("__tweb_context_menu__")?.remove();
    resetPendingG();
    resetPendingZ();
    if (restoreMode) normalMode();
  }

  // `Ctrl-;` flips the whole tmux/browser input plumbing, which is the right tool
  // for a long session inside a web app. Insert mode is the cheap counterpart:
  // a page-local pause of TWeb's own keys so a site's shortcuts (j/k on a feed,
  // f on a player) work, with Escape to come straight back.
  function enterInsertMode() {
    insertMode = true;
    cancelTransient(false);
    // Tell the main process to deliver keys natively. A page's own shortcuts
    // (m to mute, j/k on a feed) ignore synthetic events, so routing them
    // through the renderer would make insert mode look like it does nothing.
    send("insert-mode", true);
    setMode("insert", "Esc");
  }

  function leaveInsertMode() {
    if (!insertMode) return;
    insertMode = false;
    send("insert-mode", false);
    normalMode();
  }

  function hasTransientMode() {
    return Boolean(pickerState || promptHost || searchState || visualState || inspectState || tabListState || helpHost || pendingG || pendingZ || document.getElementById("__tweb_context_menu__"));
  }

  function handleNormalKey(event) {
    if (!shortcutsEnabled || !shortcutFrame) return;
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
    if (handleVisualKey(event, key)) return;
    if (handleInspectKey(event, key)) return;
    if (handleTabListKey(event, key)) return;
    if (searchState || promptHost) return;
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
      case "n": if (lastSearch) send("find", { query: lastSearch, forward: true, findNext: true }); else handled = false; break;
      case "N": if (lastSearch) send("find", { query: lastSearch, forward: false, findNext: true }); else handled = false; break;
      case "h": scrollSurfaceBy(-90, 0); break;
      case "j": scrollSurfaceBy(0, 90); break;
      case "k": scrollSurfaceBy(0, -90); break;
      case "l": scrollSurfaceBy(90, 0); break;
      case "d": scrollSurfaceBy(0, scrollSurfaceHeight() * 0.5); break;
      case "u": scrollSurfaceBy(0, -scrollSurfaceHeight() * 0.5); break;
      case "s": startScrollPicker(); break;
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
      case "Escape":
        // Release a picked scroll surface before bothering the page.
        if (scrollSurface()) {
          scrollTarget = null;
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

  ipcRenderer.on("tweb-shortcuts-enabled", (_event, enabled) => {
    shortcutsEnabled = Boolean(enabled);
    const root = document.documentElement;
    if (root) root.dataset.twebInputMode = shortcutsEnabled ? "shortcuts" : "passthrough";
    // The global toggle supersedes the page-local one; leaving both on would
    // make Escape mean two different things.
    insertMode = false;
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
    const active = activeElement();
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      active.select();
    } else {
      document.execCommand("selectAll");
    }
  });

  ipcRenderer.on("tweb-tabs", (_event, model) => {
    renderTabList(model);
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
    if (!shortcutsEnabled || insertMode || !shortcutFrame || typeof text !== "string" || [...text].length !== 1) return;
    const mapped = commandKey(text);
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

  ipcRenderer.on("tweb-terminal-key", (_event, payload) => {
    if (!payload || typeof payload.key !== "string") return;
    const active = activeElement() || document.body;
    const editable = isEditable(active);
    // Insert mode must not rewrite Korean keys to their Latin command letters —
    // the page is receiving them as text, not as TWeb commands.
    const mapped = shortcutsEnabled && shortcutFrame && !editable && !insertMode
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
    if (shortcutsEnabled && isEditable(event.target) && !searchState && !promptHost) setMode("insert");
    reportCaret();
  }, true);
  addEventListener("focusout", () => requestAnimationFrame(() => {
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

  const initializeDocument = () => {
    document.documentElement.dataset.twebInputMode = shortcutsEnabled ? "shortcuts" : "passthrough";
    if (shortcutFrame) {
      ensureIndicator();
      normalMode();
      reportCaret();
    }
  };
  if (document.documentElement) initializeDocument();
  else addEventListener("DOMContentLoaded", initializeDocument, { once: true });

  // Register only after every listener above is installed. Main then targets
  // this frame for IPC broadcasts without racing preload initialization.
  // Report whether this frame can run TWeb shortcuts. A cross-origin subframe
  // cannot, and main needs to know so it does not hand keys to a frame that
  // will silently drop them.
  ipcRenderer.send("tweb-preload-ready", { shortcutFrame });
}
