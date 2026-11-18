"use strict";

// tweb's keys follow Vimium's: a key Vimium binds does what Vimium does with it (or tweb's nearest
// equivalent), or nothing at all; a tweb-only action lives only on a key Vimium leaves free. This
// file is the list that rule is held to, so a later change cannot quietly give a Vimium key a
// different meaning.
//
// Source: Vimium 2.1.x defaults — `defaultKeyMappings` in background_scripts/commands.js, and the
// visual-mode table in content_scripts/mode_visual.js. Only keys whose default binding is certain
// are listed; zoom (`zi`/`zo`) is left out on purpose.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

// Vimium single-key normal-mode defaults → what tweb must do with the key. `null` means tweb has
// no equivalent and must leave the key unbound rather than give it another meaning.
const VIMIUM_NORMAL_KEYS = {
  "?": /showHelp\(\)/, // showHelp
  j: /scrollSurfaceBy\(0, 90\)/, // scrollDown
  k: /scrollSurfaceBy\(0, -90\)/, // scrollUp
  h: /scrollSurfaceBy\(-90, 0\)/, // scrollLeft
  l: /scrollSurfaceBy\(90, 0\)/, // scrollRight
  G: /scrollSurfaceTo\(scrollSurfaceEnd\(\)\)/, // scrollToBottom
  d: /scrollSurfacePage\(0\.5\)/, // scrollPageDown (half a page)
  u: /scrollSurfacePage\(-0\.5\)/, // scrollPageUp
  r: /send\("reload"\)/, // reload
  R: /send\("reload-hard"\)/, // hardReload
  p: /pasteOrOpen\(false\)/, // openCopiedUrlInCurrentTab
  P: /pasteOrOpen\(true\)/, // openCopiedUrlInNewTab
  i: /enterInsertMode\(\)/, // enterInsertMode
  v: /startVisualRound\(\)/, // enterVisualMode
  V: /selectPageText\(\)/, // enterVisualLineMode
  f: /startHints\(false\)/, // LinkHints.activateMode
  F: /startHints\(true\)/, // LinkHints.activateModeToOpenInNewTab
  "/": /showSearch\(\)/, // enterFindMode
  n: /stepSearch\(true\)/, // performFind
  N: /stepSearch\(false\)/, // performBackwardsFind
  o: /showPrompt\(false\)/, // Vomnibar.activate
  O: /showPrompt\(true\)/, // Vomnibar.activateInNewTab
  T: /showTabList\(\)/, // Vomnibar.activateTabSelection
  b: /showBookmarks\(false\)/, // Vomnibar.activateBookmarks
  B: /showBookmarks\(true\)/, // Vomnibar.activateBookmarksInNewTab
  m: null, // Marks.activateCreateMode — no marks
  "`": null, // Marks.activateGotoMode
  H: /send\("history-back"\)/, // goBack
  L: /send\("history-forward"\)/, // goForward
  J: /send\("previous-tab"\)/, // previousTab
  K: /send\("next-tab"\)/, // nextTab
  "^": /send\("previous-visited-tab"\)/, // visitPreviousTab
  W: /send\("toggle-float"\)/, // moveTabToNewWindow ≈ float the page into a desktop window
  t: /showPrompt\(true\)/, // createTab (tweb's new tab opens on the omnibox)
  x: /send\("close-tab"\)/, // removeTab
  X: /send\("restore-tab"\)/, // restoreTab
  y: /startCopyMenu\(\)/, // the `y` prefix (yy, yt, yf below)
};

// Vimium `g`-chords → what the second key must do in tweb's `pendingG` dispatch; `null` = unbound.
const VIMIUM_G_KEYS = {
  g: /scrollSurfaceTo\(0\)/, // scrollToTop
  i: /document\.querySelector\("input/, // focusInput
  t: /send\("next-tab"\)/, // nextTab
  T: /send\("previous-tab"\)/, // previousTab
  0: /send\("first-tab"\)/, // firstTab
  $: /send\("last-tab"\)/, // lastTab
  u: /goUpUrl\(key === "U"\)/, // goUp
  U: /goUpUrl\(key === "U"\)/, // goToRoot
  e: /showPrompt\(key === "E", true\)/, // Vomnibar.activateEditUrl
  E: /showPrompt\(key === "E", true\)/, // Vomnibar.activateEditUrlInNewTab
  s: null, // toggleViewSource
  f: null, // nextFrame
  F: null, // mainFrame
};

// Vimium's `y`-chords → the copy menu row that must carry that meaning.
const VIMIUM_Y_KEYS = { y: "smart", t: "tab", f: "link" };

function helpTable() {
  const start = preload.indexOf("  const shortcutHelpSections = [");
  const end = preload.indexOf("  function commandHelpSection()");
  return new Function(`${preload.slice(start, end)}\nreturn shortcutHelpSections;`)();
}

function normalBindings() {
  return new Map(helpTable().flatMap(([, entries]) =>
    entries.flatMap(([, , bindings]) => Object.entries(bindings || {}))));
}

function gChord() {
  const from = preload.indexOf("    if (pendingG) {");
  return preload.slice(from, preload.indexOf("    if (pendingZ) {", from));
}

test("every Vimium normal key does Vimium's action in tweb, or nothing", () => {
  const bound = normalBindings();
  for (const [key, expected] of Object.entries(VIMIUM_NORMAL_KEYS)) {
    if (expected === null) {
      assert.ok(!bound.has(key), `${key} is Vimium's and tweb has no equivalent, so it must stay unbound`);
      continue;
    }
    assert.ok(bound.has(key), `${key} is unbound`);
    assert.match(bound.get(key).toString(), expected, `${key} does not do Vimium's action`);
  }
});

test("every Vimium g-chord does Vimium's action in tweb, or nothing", () => {
  const chord = gChord();
  for (const [key, expected] of Object.entries(VIMIUM_G_KEYS)) {
    const literal = key === "$" ? "\\$" : key;
    const line = chord.split("\n").find((text) => new RegExp(`key === "${literal}"`).test(text));
    if (expected === null) {
      assert.equal(line, undefined, `g${key} is Vimium's and tweb has no equivalent, so it must stay unbound`);
      continue;
    }
    assert.ok(line, `g${key} is unbound`);
    assert.match(line, expected, `g${key} does not do Vimium's action`);
  }
});

test("the copy menu's yy, yt and yf mean what they mean in Vimium", () => {
  const kinds = new Function(`${preload.slice(preload.indexOf("  const COPY_MENU_KINDS"), preload.indexOf("  // Rows in the order"))}\nreturn COPY_MENU_KINDS;`)();
  for (const [key, kind] of Object.entries(VIMIUM_Y_KEYS)) assert.equal(kinds[key], kind, `y${key}`);
  const rows = preload.slice(preload.indexOf("  function copyMenuRows(ctx)"), preload.indexOf("  function copyImageRect("));
  // yy with nothing picked is the page URL, selection or not.
  assert.match(rows, /\)\n {6}: "u";/);
  assert.match(rows, /rows\.t = \{ preview: `duplicate this tab · /);
  assert.match(main, /case "duplicate-tab": \{\n\s+const url = contents\.getURL\(\);\n\s+if \(url\) openTabRouted\(tab, url, true\);/);
});

test("tweb-only actions moved off Vimium keys and onto free ones", () => {
  const chord = gChord();
  // `m` is Vimium's set-mark: taking audio back is `ga` now.
  assert.match(chord, /else if \(key === "a"\) \{ send\("reclaim-audio"\);/);
  assert.ok(!normalBindings().has("m"));
  // `b` (bookmarks in Vimium) no longer opens the tab list; `T` does.
  assert.match(normalBindings().get("T").toString(), /showTabList/);
  // The audio badge names the new key.
  assert.match(preload, /press ga to take it back/);
});

test("visual mode: o swaps the selection ends, y yanks a text selection, picks open on t/T and inspect on I", () => {
  const visual = preload.slice(preload.indexOf("function handleVisualKey(event, key)"), preload.indexOf("function cssSelector(element)"));
  assert.match(visual, /else if \(key === "y" && visualTextSelected\(\)\) copyVisualText\(\);\n\s+else if \(key === "y"\) startCopyMenu\(\);/);
  assert.match(visual, /else if \(key === "o"\) reverseVisualSelection\(\);/);
  assert.match(visual, /key === "t" \|\| key === "T"/);
  assert.match(visual, /send\(key === "T" \? "new-tab" : "navigate", url\)/);
  assert.match(visual, /key === "I"\) \{\n\s+const item = visualState;\n\s+cancelVisual\(false\);\n\s+enterInspect\(item\);/);
  // The old meanings are gone: `o`/`O` no longer navigate and `d` no longer inspects.
  assert.doesNotMatch(visual, /key === "o" \|\| key === "O"/);
  assert.doesNotMatch(visual, /key === "d"\)/);
  assert.match(visual, /selection\.setBaseAndExtent\(focusNode, focusOffset, anchorNode, anchorOffset\)/);
});

test("j/k and the other motion keys are untouched", () => {
  const bound = normalBindings();
  for (const [key, source] of [["j", /scrollSurfaceBy\(0, 90\)/], ["k", /scrollSurfaceBy\(0, -90\)/], ["g", /pendingG = true/], ["z", /pendingZ = true/]]) {
    assert.match(bound.get(key).toString(), source, key);
  }
});

test("shifted digits reach the handlers as their symbols, so $ and ^ can be bound", () => {
  const physical = preload.slice(preload.indexOf("  function physicalKey(event)"), preload.indexOf("  // Elements inside a frame belong"));
  assert.match(physical, /return event\.shiftKey \? "\)!@#\$%\^&\*\("\[Number\(digit\)\] : digit;/);
  const symbols = ")!@#$%^&*(";
  assert.equal(symbols[4], "$");
  assert.equal(symbols[6], "^");
  assert.equal(symbols[0], ")");
});

test("gu goes up a level and gU to the root", () => {
  const source = preload.slice(preload.indexOf("  function upUrl(href, root)"), preload.indexOf("  function goUpUrl(root)"));
  const upUrl = new Function(`${source}\nreturn upUrl;`)();
  assert.equal(upUrl("https://a.test/x/y/", false), "https://a.test/x/");
  assert.equal(upUrl("https://a.test/x/y", false), "https://a.test/x/");
  assert.equal(upUrl("https://a.test/x?q=1#h", false), "https://a.test/x");
  assert.equal(upUrl("https://a.test/", false), null);
  assert.equal(upUrl("https://a.test/x/y?q=1", true), "https://a.test/");
  assert.equal(upUrl("about:blank", false), null);
});

test("main carries the Vimium tab actions", () => {
  for (const action of ["first-tab", "last-tab", "previous-visited-tab", "duplicate-tab", "reload-hard"]) {
    assert.match(main, new RegExp(`case "${action}":`), action);
  }
  // `^` needs to know which tab was left.
  assert.match(main, /currentWindows\(\)\.previousTab = leaving;/);
  assert.match(main, /activateTab\(currentWindows\(\)\.tabs\.length - 1\)/);
});

// `?` lists every command `:` and the palette run, generated from the tables they dispatch
// through, so the two can never drift apart.
test("the help lists every command the command line and the palette accept", () => {
  const tables = preload.slice(preload.indexOf("  const commandPaletteEntries = ["), preload.indexOf("  function parseCommandLine(input)"));
  const section = preload.slice(preload.indexOf("  function commandHelpSection()"), preload.indexOf("  const normalKeyActions"));
  const run = new Function(`${tables}\n${section}\nreturn { commandsByName, commandPaletteEntries, helpSections, SCRIPT_PREFIXES };`);
  const shortcutHelpSections = helpTable();
  const { commandsByName, commandPaletteEntries, helpSections, SCRIPT_PREFIXES } = new Function(
    "shortcutHelpSections", `return (${run.toString()})();`,
  )(shortcutHelpSections);
  const sections = helpSections();
  const [title, rows] = sections.at(-1);
  assert.match(title, /^Commands/);
  const keys = rows.map(([key]) => key);
  for (const [name, entry] of commandsByName) {
    const row = rows.find(([key]) => key === `:${name}` || key.startsWith(`:${name} <`) || key.startsWith(`:${name} [`));
    assert.ok(row, `:${name} is missing from the help`);
    if (entry.argument) assert.ok(row[0].includes(`<${entry.argument}>`), `:${name} shows its argument`);
    if (entry.argumentOptional) assert.ok(row[0].includes(`[${entry.argumentOptional}]`), `:${name} shows its optional argument`);
    assert.ok(row[1].trim(), `:${name} has a description`);
  }
  for (const entry of commandPaletteEntries) {
    assert.match(rows.find(([key]) => key === `:${entry.name}` || key.startsWith(`:${entry.name} [`))[1], /also in c$/, `${entry.name} is marked as a palette row`);
  }
  assert.ok(keys.some((key) => key.includes(`:${SCRIPT_PREFIXES[0]} `)), "the script form is listed");
  // The help renders this list, not only the shortcut table.
  const help = preload.slice(preload.indexOf("  function showHelp()"));
  assert.match(help, /for \(const \[title, entries\] of helpSections\(\)\)/);
  // Every command the parser dispatches goes through commandsByName.
  assert.match(preload, /const entry = commandsByName\.get\(parsed\.name\);/);
});
