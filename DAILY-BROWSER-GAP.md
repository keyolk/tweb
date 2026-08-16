# TWeb as a daily browser: the gap against Chrome

Run `s1786880826401-2`, branch `main`, HEAD `947891b`.

**The standard for this document.** The project owner intends to browse with TWeb
instead of Chrome, daily. So the question for every capability below is not "is
this implemented" but "does a person who switched from Chrome hit this, and what
happens when they do".

**The evidence rule.** Every row carries how the verdict was reached. A capability
that was only grepped is recorded as *claimed, not exercised* — it is never
promoted to a clean verdict. This document is worth something only if it is true;
a row that says "we did not measure this" is more useful than a row that quietly
implies we did.

**Two states, both currently true.** §1 describes HEAD `947891b`. The working
tree contains uncommitted fixes that move four of those verdicts (§6.6), and the
owner's installed `~/.local/bin/tweb` runs an even older embedded build — so a
row can be honestly `broken` at HEAD and `works` in the tree at the same time.
Where that applies the row says so.

Verdicts are drawn from exactly four words:

| verdict | meaning |
| --- | --- |
| `works` | a person coming from Chrome does this and it does what they expect |
| `worse-than-Chrome` | it happens, but the Chrome user pays something for it |
| `broken` | the feature is present enough to be reached and then fails |
| `missing` | absent, and absent honestly — nothing pretends it is there |

One thing this document deliberately does **not** cover: the Tauri engine. The
README claims parity for it by shared-preload construction, and nobody exercised
it this run. Every verdict below is Electron.

---

## 1. Inventory

Every row below was exercised by a peer in a real pane at HEAD `947891b`. Where
a peer could not exercise something, or exercised only part of it, the row says
so in the last column instead of rounding up to a clean verdict.

Three capabilities from the assignment's list are split into more than one row,
because a single word would have hidden the finding: downloads separate the
transfer (works) from telling the user (worse), and session restore separates
one pane per window (works) from two (silent data loss).

| Capability | Verdict | Evidence | Measured or assumed |
| --- | --- | --- | --- |
| Downloads — the transfer | `works` | task-2, pane `%541`, app dir confirmed `/Users/gavin.jeong/src/keyolk/tweb/electron` by `lsof` cwd on Electron child pid 42891 (workspace source, not the stale cache). Anchor `download` attr → `tweb: download completed /Users/gavin.jeong/Downloads/sample.txt`, 59 bytes on disk, contents correct. `Content-Disposition: attachment` → `/Users/gavin.jeong/Downloads/data.csv`, 12 bytes, contents `a,b,c\n1,2,3`. Landing dir is `app.getPath('downloads')` = `~/Downloads` — the same dir Chrome uses. Collision handling is Chrome-shaped: `availableDownloadPath()` at `electron/main.cjs:3268` appends ` (1)`, ` (2)`. | measured (driven twice, bytes read off disk) |
| Downloads — telling the user | `worse-than-Chrome` at HEAD `947891b`; addressed in the working tree by task-4 (§6.2) | task-2: **nothing whatsoever** signals a completed download. Screenshots before the click (`/tmp/t2/shot-fixture.png`) and after completion (`/tmp/t2/shot-after-dl.png`) are byte-identical — md5 `f13128f7a62dbe209d98198db53963b2` for both, and task-2 opened both. `tmux capture-pane -p -t %541` after the download returns zero non-blank lines: no status line, no shelf, no toast. The record is *recoverable* but not *pushed*: `main.cjs:234-240` wraps `console.error` into a 400-line retained `engineLog` ring (the comment at `main.cjs:230` says this was a deliberate fix for exactly this class of problem), and on a fresh pane `%547` launched **without** `TWEB_DEBUG` — the normal case — `tweb engine-log --pane %547` returned verbatim `{"at":1786883022439,"line":"tweb: download completed /Users/gavin.jeong/Downloads/sample (1).txt"}`. Raw stderr genuinely tells you nothing: the redirect file `/tmp/t2/p3.err` on that pane held 3 Rust tracing lines and not one engine line. So the verdict stands — `tweb engine-log` is a debug command dumping a raw JSON array of every engine line (frame drops, zoom, keyboard-mode restores) that the user must know to run and then read by eye, and a busy pane evicts the download line from a 400-entry ring within minutes. Chrome pushes the information at you; here nothing in the pane changes at download time. The Rust side has no download awareness at all: grep for `download` across `crates/` hits only the Electron-runtime installer and the Tauri engine — no IPC message, no `pane_writer` status. | measured (task-2 corrected its own earlier post, seq 8 → seq 28, after finding `engine-log`) |
| Downloads — collision handling | `works` — exact Chrome parity | task-2, driven rather than read (this was `assumed` in their first post and was **upgraded** to measured). With `~/Downloads/sample.txt` already present, clicking the same link again on fresh pane `%547`: before `sample.txt` (59 bytes, 20:56); after `sample.txt` (59 bytes, 20:56) **and** `sample (1).txt` (59 bytes, 21:23); engine-log `tweb: download completed /Users/gavin.jeong/Downloads/sample (1).txt`. The original was not overwritten and the suffix format is Chrome's own ` (1)`. | measured |
| Uploads / file chooser | `broken` — **not** missing — at HEAD `947891b`; `works` in the working tree after task-4 built the chooser (§6.2, verified seven ways including reading the bytes back byte-identical) | task-2, pane `%541`. The page renders a real, normal-looking `Choose File` control (`/tmp/t2/shot-snapfail.png`, opened: the macOS-styled `Choose File \| No file chosen` is right there), TWeb's own snapshot enumerates it as interactive (`@s file ""`), `tweb click` reports `ok`, and nothing happens. Instrumented proof the click lands: a click listener installed via `eval` then a click gives `clicks=1 files=0` — the DOM event fired, no chooser opened, no file selected. No native window opened (`osascript … first process whose unix id is 42891 … count of windows` → `0`). No error anywhere (`tweb errors --pane %541` → `no errors`; engine stderr silent; post-click screenshot byte-identical, md5 `f13128f7a62dbe209d98198db53963b2`). Root cause read **after** measuring: `electron/main.cjs:9` imports `{ app, BrowserWindow, clipboard, ipcMain, nativeImage, screen, session }` — `dialog` is not imported at all, and there is no file-chooser handler anywhere in `electron/`. Chromium's default chooser cannot draw because the window is offscreen (`main.cjs:1610 offscreen: {…}`, `main.cjs:1600 show: false`), so the request dies silently. `tweb fill` is not a workaround: it returns `Failed to set the 'value' property on 'HTMLInputElement': This input element accepts a filename, which may only be programmatically set to the empty string` — Chromium security, not a TWeb bug. | measured |
| PDF | `broken` — renders beautifully, then traps you on page 1 | task-2, pane `%541`, `http://127.0.0.1:8731/doc.pdf` (real 5-page PDF, 156203 bytes). The grep survey's `PDF: none` is **wrong**: Chromium's full PDF viewer is present and paints correctly. `/tmp/t2/shot-pdf.png`, opened, shows the complete Chrome PDF viewer — dark toolbar, filename, page indicator `1 / 5`, zoom `81%`, -/+ buttons, fit/rotate/annotate/undo/redo, download and print icons, kebab menu, thumbnail sidebar with page 1 highlighted, document body crisp. Title resolves to `doc.pdf`. Visually indistinguishable from Chrome — and completely inert. Rendered bytes stay identical (md5 `94c52430cb16f33b890a381ecc5ffb67`) across `send-keys j` ×1 and ×5, `send-keys Down` ×3, and `tweb press PageDown` (which returns `true`) — both the real key path and the agent socket. Control case through the same harness: on the HTML fixture, same pane, same `window.visible=false`, `send-keys j` moved `scrollY` 0 → 90, so the harness and key path are live and visibility is not the confound. `tweb errors --pane %541` → `no errors`. Cause: the viewer lives in a separate PDF extension frame the preload does not reach — `tweb snapshot` returns an empty title and zero refs (it lists refs fine on HTML), `tweb eval` sees `BODY children=0`. | measured |
| Login / forms | `works` | task-2, pane `%541`, using a **public demo** credential printed on the page itself (`the-internet.herokuapp.com/login`, `tomsmith` / `SuperSecretPassword!`) — no real credential was touched. Snapshot enumerated the fields correctly (`@s textbox "Username"`, `@f textbox "Password"`, `@g button "Login"`), `tweb fill` set both, click submitted, URL moved `/login` → `/secure`. `/tmp/t2/login-success.png`, opened: the green `You logged into a secure area!` banner and the Secure Area page. | measured |
| Password / credential autofill | `missing` — honestly absent, not half-built | task-2. Nothing offered to save the password after a successful login: no prompt in the screenshot, `tmux capture-pane -p -t %541` returns zero non-blank lines, engine stderr carries no credential line. Nothing autofilled on revisit: after logging out and returning to `/login`, reading the fields directly gives `user="" pass=""`, and `/tmp/t2/login-revisit.png` (opened) shows both boxes empty — and the form uses proper `autocomplete=username` / `current-password`, so this is not the page's fault. The store does not exist at all: the profile at `~/Library/Application Support/tweb-electron` (1.0 GB) has Cookies, Local Storage, IndexedDB and Service Worker but **no `Login Data` and no `Web Data`** — the Chromium files that hold saved passwords and autofill data. Because cookies do persist, existing sessions survive; the gap bites only at a fresh login. | measured |
| Print | `broken` at HEAD `947891b` — and it does not merely fail, **it wedges the renderer**; `works` in the working tree after task-4's fix (§6.2) | task-2. The grep survey's "print: some references" is wrong: grepping `electron/main.cjs`, `electron/preload.cjs` and `crates/tweb-cli` for print/`printToPDF`/`webContents.print` (excluding `println!`/`eprintln!`/`fingerprint`/`sprint`) returns exactly one hit, `crates/tweb-cli/src/agent.rs:341: print!(…)`, which is stdout formatting. There is no print handler anywhere, so `window.print()` falls through to Chromium's default, which tries to open a native print dialog from an offscreen `show:false` window; it never appears and the renderer never returns. Reproduced cleanly, control-first, on plain `https://example.com`: control `tweb eval %541 "'control ok'"` → `control ok`; then `tweb eval %541 "window.print(); 'returned'"` → no output, times out; then `tweb eval %541 "'post-print ok'"` → no output, times out. `tweb diag --pane %541 --json` reports `page: {"error": "page did not answer page-diag within 3000ms"}` while `window.visible` and the process are fine (`ps` shows pid 42891 state `S+`). **The pane still paints**: `/tmp/t2/shot-print-wedged.png`, opened, renders example.com perfectly — heading, body, `Learn more` link, status badge — so the user sees a healthy browser that no longer responds. The real key path is dead too, not just the agent socket: `tmux send-keys -t %541 j` afterwards leaves the screenshot byte-identical (md5 `3c3046b07a14cd4931ecb866907c3b8b` before and after). Recovery is unreliable: navigating away worked once; the second time navigate reported success and `tweb panes` showed the new URL, yet eval and page-diag still timed out, and an explicit `tweb reload` (returning `true`) did not restore it. Engine stderr shows `surface restore produced no frame in time` and `agent surface hold expired with 2 outstanding`. `tweb errors` → `no errors` throughout. First occurrence was on a local fixture, so it is not page-specific. | measured, reproduced twice with a control before each |
| Extensions | `missing` in code — but the README advertises it, so the **user-facing** story is `broken` | task-2. Grep extended beyond the survey: `loadExtension`, `session.extensions`, `chrome.runtime`, `manifest_version` across all of `electron/*.cjs` and all of `crates/` (excluding node_modules and tests) return **zero** hits. There is an empty `extension/` directory at the repo root (`ls -la extension/` shows only `.` and `..`), so a reader who sees the directory assumes something is there. `tweb doctor --help` describes itself as *Diagnose and configure terminal/tmux/GPU/extension capabilities*, but running `tweb doctor` prints no line mentioning extensions. | doctor output and the empty directory measured; **the absence itself is by grep** — task-2 notes there is no UI through which to attempt an install, so there is nothing to drive |
| Bookmarks | `missing` in code — and the shipped CLI command for it is `broken` | task-2. `bookmark` appears nowhere in `electron/` or `crates/`; the only two mentions are documents making promises (`README.md:20` "Chrome profile bootstrap: extensions, bookmarks and general site state are imported policy-aware", `DESIGN.md:1346` `\| Bookmarks \| imported \| a snapshot import \|`). task-2 **ran** the command the README points at, against the owner's real Chrome profile (`~/Library/Application Support/Google/Chrome/Default/Bookmarks` exists on this machine): `tweb profile bootstrap ~/Library/Application\ Support/Google/Chrome/Default` → `Error: command not yet implemented: Profile { action: Bootstrap { source: "…" } }`. Likewise `tweb profile list` → `Error: command not yet implemented: Profile { action: List }`. The subcommand is shipped in the CLI, appears in `tweb --help`, accepts its argument, and then admits it does nothing. Same shape elsewhere: `tweb resource list` → `command not yet implemented`. | measured — run against the real profile path, exact error captured |
| History | `works` — end to end, and arguably better than Chrome | task-1, pane `%543`, real key path. `g` then `h` → `diag page.mode='history' detail='1/343'`: a real store of 343 visits accumulated from this machine's actual use, not a stub. `/tmp/t1web/history.png`, opened: *Search all history* box, `343 visits`, a `Today` day-group header, per-row timestamp + title + full URL, keyboard legend `↑/↓ move · Enter open · Shift-Enter new tab · Ctrl-D delete · Esc close`, scrollbar. Search works: typing `third` narrowed to `1 visit`, detail `1/343` → `1/1`, showing only `…/pages/third.html`. Open works: Enter on that row → `location.pathname='/pages/third.html'`, `h1='THIRD PAGE'`, overlay closed. Filtering is server-side over the whole file by design (`main.cjs:2636`), so search covers all 343 rather than a rendered slice. | measured |
| Find-in-page | `broken` — the bar opens, accepts typing, and finds nothing | task-1, live pane `%543`, engine app `/Users/gavin.jeong/src/keyolk/tweb/electron`, keys via `tmux send-keys`. What looks right: `/` renders a Chrome-styled *Find in page* bar top-right (`/tmp/t1web/find-visible.png`, opened — the bar is there with the query in it), `diag` shows `page.mode=search`, and the engine log shows `tweb: native shortcut find` once per keystroke, so preload→main IPC is intact and `contents.findInPage(query, …)` at `electron/main.cjs:2660` is genuinely called. What is broken: the `found-in-page` event registered at `electron/main.cjs:3476` never fires. Proof rather than inference — preload's handler (`electron/preload.cjs:3200`) writes `0/0` into the result span on *any* result including zero matches; polling that span once a second for 8 seconds with a query that is on the page gives `{t:1,res:""}` … `{t:8,res:""}`: stays empty, never even `0/0`. Consequences, all measured: no match counter, nothing highlighted (`getSelection()` stays `''`), and Enter closes the bar without scrolling to the match (`ZQXWVU-NEEDLE-9271` placed 3000px down: `scrollY` 0 before, 0 after, bar gone, selection empty). Control case rules out both the harness and the text: `window.find('UNIQUEMARKERALPHA')` in the same pane at the same moment returns `{"windowFind":true,"sel":"UNIQUEMARKERALPHA"}`. Surface collapse ruled out by re-running with the surface held open (`contentSize` 685×1 → 685×162 in diag) — identical result. | measured |
| Back / forward | `works` (with a caveat that is not the same as broken) | task-1, live pane `%543`, engine app `/Users/gavin.jeong/src/keyolk/tweb/electron`, driven by `tmux send-keys` (the real key path, not the agent socket). `H`: `/pages/second.html` → `/pages/index.html`. `L`: `/pages/index.html` → `/pages/second.html`. Both fire, and fast. `BSpace`, `M-Left`, `M-Right`: URL unchanged — unbound, and they fail **silently** (no beep, no toast, no hint). | measured |
| Middle-click | `worse-than-Chrome` at HEAD `947891b` — it opens a tab, then steals your place; `works` in the working tree (§6.6) | task-1, pane `%543`, **real mouse path**: genuine SGR-1006 mouse bytes injected with `tmux send-keys -H`, exactly what a physical click produces (not `tweb click`, not the agent socket). Middle press/release (`cb=1`) on `GO TO SECOND`: tabs before `1`, after `[(0, active=False, '…/index.html'), (1, active=True, '…/second.html')]`. A new tab is created — and it is **active**, deactivating the one you were reading. Chrome's middle-click opens in the background, which is the entire point of the gesture: middle-click six links off a results page, keep reading, work through them later. Here the first click yanks you off the page, so clicks two through six land on the wrong document. Cause: `main.cjs:3443` `setWindowOpenHandler` calls `createTab(target, true)` — the second arg is *activate* — and middle-click shares that path with `window.open`. Electron supplies `details.disposition === 'background-tab'`, which Chrome uses to differentiate. | measured |
| Right-click / context menu | `works` — fully, and context-aware | task-1, pane `%543`, real SGR-1006 mouse bytes via `tmux send-keys -H` (`cb=2` press + release), surface held open. `/tmp/t1web/ctxmenu.png`, opened: a Chrome-looking dark menu rendered **at the pointer** with Chrome's own grouping and order — `Copy`, `Search for "GO TO SECOND"` (picking up the link text, quoted), separator, `Open link in new tab`, `Open link in this tab`, `Save link as`, `Copy link address`. Not a coordinates-only stub: it is built from Chromium's own context-menu params (`main.cjs:3453` → `showBrowserContextMenu` at `3340`, built in `context-menu.cjs`), so editable fields get Undo/Redo/Cut/Copy/Paste/Paste-without-formatting/Select-all, a selection gets Copy + Search, images get their own group. The items execute: a real left click on `Open link in new tab` took tabs from `1` to `[(0, active=False, '…/index.html'), (1, active=True, '…/second.html')]`. Backdrop dismissal verified — a click outside removed the menu and did nothing else. | measured |
| Copy image | `worse-than-Chrome` — it is a region capture, not an image copy | task-1, pane `%543`, real SGR mouse, surface held. The happy case works: right-clicking a 120×120 red PNG gives the image-specific menu (`/tmp/t1web/ctx-img2.png`, opened: `Open image in new tab / Save image as / Copy image / Copy image address`, then `Back / Forward` with Forward correctly greyed); `Copy image` puts a genuine multi-format bitmap on the **system** pasteboard — `osascript 'clipboard info'` → `«class PNGf» 3672, TIFF picture 153180, «class BMP », GIF, JPEG…`, with a text sentinel placed beforehand gone, so the write really happened. Writing `«class PNGf»` to `/tmp/t1web/clip2.png` gives a valid 120×120 PNG which task-1 opened: clean solid red square. The caveat, hit by accident before the success case: `main.cjs:2677` `copy-image` takes x/y/width/height and calls `contents.capturePage(rect)` — it re-renders the pixels under the element rather than copying the decoded resource (comment at `:2688`: *in offscreen Chromium `copyImageAt` may not update the pasteboard*). The first attempt captured `/tmp/t1web/clip.png` at 240×208 containing the red square **plus** surrounding white page **plus** the top of a text input below, because the image was only partly scrolled into view. So an image taller than the viewport, or partly scrolled off, copies clipped and contaminated, silently; the copy is at rendered rather than natural size (a 4000px photo shown at 300px copies as 300px); an animated GIF copies as one frame; a transparent PNG copies composited over the page background. | measured |
| Korean IME | `works` (one caveat, stated) | task-1, pane `%543`, `tmux send-keys` (real key path). Text lands byte-exact: `안녕하세요` → `input.value='안녕하세요' len=5 codepoints=[c548,b155,d558,c138,c694]` — no mojibake, no doubling, no dropped syllable. Mixed script `한글 렌더 테스트 abc123` round-trips identically with ASCII and spaces preserved. It renders: `/tmp/t1web/korean2.png`, opened — the string is drawn correctly with the caret after `3`, no tofu, no clipped glyphs, and the wider hangul cells did not break the grid. ASCII control through the same harness: `hello` → `hello` with per-key KEYDOWN+INPUT. The absent `compositionupdate` events are **correct**, not a defect: macOS composes hangul in the terminal emulator, so TWeb receives already-committed UTF-8 and there are no intermediate jamo to observe. **Caveat task-1 states honestly:** they injected finished UTF-8; a live macOS 2-set hangul IME with per-jamo backspace inside an open composition was **not** exercised. This row validates the README's previously-unvalidated claim only to the extent measured. | measured, with one named unmeasured sub-case |
| Popups / `window.open` | `works` for ordinary popups; `worse-than-Chrome` for opener-coupled auth | task-1, pane `%543`. `window.open('…/popup.html','_blank','width=400,height=300')` from page JS: tabs before `1 ['…/index.html']`, after `2 [(0, active=False, '…/index.html'), (1, active=True, '…/popup.html')]`. `/tmp/t1web/popup.png`, opened: `POPUP WINDOW OPENED` rendered, indicator bottom-right `2/2`. The popup becomes a real TWeb tab and is focused — `main.cjs:3443` `setWindowOpenHandler` denies the native window and calls `createTab(target, true)`, deliberately, because Electron would otherwise surface the macOS OffScreenView placeholder as a real OS window floating outside the terminal. **The caveat, measured:** `window.open()` returns `null` and the child's `window.opener` is `null`, forced by `action:'deny'`. So OAuth/SSO popup flows that `postMessage` back to `window.opener` or that poll the returned handle will hang — the popup authenticates and the parent never learns it succeeded — `window.close()` from the child cannot be coordinated, and any `if (!win) …` check shows a false "popup blocked" warning even though the tab did open. | measured |
| Video with sound | `works` — and the cross-pane audio arbitration is better than Chrome | task-1, two independent panes `%543` and `%544`, each its own `tweb __pane` + Electron, playing a real 30s VP8+Opus webm (ffmpeg sine 440 Hz + testsrc) served locally. Video plays: `t=4.45` → `t=7.48` over three seconds, `paused=false`, `readyState=4`, `duration=30.008`. Audio is real, not just unmuted flags: `diag audio` → `{audible:true, muted:false, mutedByOther:false, owner:'%543'}`; a genuine AudioService child process pid 26199 with PPID 55459 = task-1's engine, so the OS-level audio pipeline is open; engine log `tweb: media playing audible=true muted=false`; claim file `/tmp/tweb-502/audio-owner.json` → `{"pane":"%543","pid":55459,…}`. **Honest limit task-1 states:** they could not verify sound left the physical speakers. What is measured is that Chromium reports the contents as currently audible — decoded output reaching the audio service, not merely a flag. | measured, except physical speaker output |
| Session survival across restart | `works` single-pane-per-window; `broken` — silent tab loss — with two browser panes in one tmux window | task-1, both halves measured. **Happy path:** 4 tabs open in `%543` (index/second/third/`https://example.com`, active=3); on disk before the kill, `~/Library/Application Support/tweb-electron/window-sessions/476884a38cd209a6abd0df13.json` = `{"version":1,"activeIndex":3,"tabs":[{index.html,zoom:0.8},{second.html,…},{third.html,…},{example.com,…}]}`. `tmux kill-pane %543` → engine pid 55459 gone (confirmed by `ps`). Respawned in the same tmux window with **no URL** — which is what sets restore (`options=PaneOptions{… restore_session: true}`; passing a URL skips restore, `cli/lib.rs:609 restore_session: url.is_none()`). All four tabs came back, in order, tab 3 active, and `https://example.com` had really loaded (`title='Example Domain'`, `bodyLen=126`). Per-tab zoom persisted. **The defect, which bit task-1 for real and unprompted during this run:** the session key is `sha256('v2', tmux socket, session name, WINDOW INDEX)` (`window-session.cjs windowSessionKeys()`) — **the pane id is not in the key**. task-2 was driving its own pane in the same tmux window `@19`; on task-1's second respawn the same file had been overwritten to `{"version":1,"activeIndex":0,"tabs":[{"url":"http://127.0.0.1:8731/","zoom":0.8}]}` — task-2's page. Four tabs gone, and the restored pane came up showing a stranger's tab. Last writer wins; every pane in a tmux window shares one session slot, so whichever exits last silently erases the other's session, with no error and no recovery. task-1 then **proved the key structurally rather than leaving it inferred**: recomputing `sha256('v2' \0 socket \0 session \0 window_index)[:24]` in a standalone script reproduces the filenames on disk — `projects` window 8 → `476884a38cd209a6abd0df13` (the file that was overwritten), `dashboard` window 2 → `1899904e0561d156bb1c9a34`, `dashboard` window 6 → `01f02a4500b7ebbf9b747d4e`. So the collision is structural and permanent, not a race that happened to be lost. | measured, both halves, plus independent derivation of the key |
| Close / reopen closed tab (Chrome's Cmd+Shift+T) | `works` — Chrome parity | task-1, pane `%548`, real key path. Start `[(0,False,'…/index.html'), (1,True,'…/second.html')]`; `x` → `[(0,True,'…/index.html')]` (tab closed); `X` → `[(0,False,'…/index.html'), (1,True,'…/second.html')]` — the tab is back at the same index and re-activated. It restores position in the tab strip, not just the URL. | measured |
| `mailto:` | `works` (parity with Chrome) | task-2, pane `%541`, measured twice with Mail.app force-quit in between so the second launch could not be a leftover. Trial 1: `tweb click --pane %541 d` on `<a href="mailto:nobody@example.com?subject=tweb%20test">` → Mail.app launched, `ps -o lstart` `STARTED Sun Aug 16 21:04:56`, seconds after the click, and Mail was absent from the earlier process enumeration. Trial 2 after quitting (`pgrep -x Mail` → not running): click → pid 74521, `STARTED Sun Aug 16 21:06:13`. Correct non-effects all verified: pane URL unchanged (`http://127.0.0.1:8731/`), no new tab created, `tweb errors` → `no errors` — no hijacked page, no dead `about:blank` left behind. Mechanism read after measuring: `main.cjs:3443` `setWindowOpenHandler` denies the popup and re-routes to `createTab`; the `mailto:` itself goes through Chromium's external-protocol path to the macOS default client via LaunchServices. **Caveat task-2 states:** they could not confirm the compose window opened *pre-filled* with address and subject — the AppleScript window query hung on a cold Mail launch and was killed. What is certain is the correct external app launched and browser state stayed clean. | measured; the pre-filled compose window specifically is unconfirmed |

### Prior grep survey (NOT evidence)

The run prompt carried a rough grep survey as a starting point. It is recorded
here only so a reader can see what was assumed before anyone drove a pane, and
so that a later row disagreeing with it is visibly a correction rather than a
contradiction:

```
downloads     `will-download` exists in main.cjs, depth unknown
extensions    no loadExtension anywhere
bookmarks     nothing
passwords     nothing
PDF           nothing
uploads       nothing
find-in-page  present
history       present
print         some references
```

None of the above is a verdict. Each line is a hypothesis that the inventory
table above either confirms by use or overturns.

### How to read the evidence: which engine code was running

A verdict is only about the build it was measured on, and on this repo that is
not obvious. task-1 established the resolution order by running a pane and
reading `--app-path` off the live renderer, correcting the dispatch's own
description of it (radio `environment` seq 4, superseded by seq 6):

`crates/tweb-pane/src/lib.rs:812` `workspace_electron_dirs()` checks, in order,
`current_exe()/../../../electron`, `./electron`, `../electron`, and only then
falls back to `engine_app::extracted_app_dir()` — the `~/.cache/tweb/app-<tag>`
unpack of the `include_str!`-embedded `electron/*.cjs`. So both the executable's
location and the cwd matter, and `TWEB_ELECTRON_DIR` overrides both.

The consequence for every row below:

- `/Users/gavin.jeong/src/keyolk/tweb/target/debug/tweb` loads the **live**
  `electron/` source tree. Confirmed on task-1's pane `%543`:
  `--app-path=/Users/gavin.jeong/src/keyolk/tweb/electron`. No rebuild is needed
  for `.cjs` edits.
- The owner's own `~/.local/bin/tweb` has no workspace above it, so it runs the
  extracted `app-0953a5b104ec3c15` — an **Aug 14** build. The current tree
  hashes to `app-d73818dab4489aea`.

So a fix landing in `electron/` during this run is *not* in the owner's live
browser until he reinstalls. Where that distinction changes a verdict, the row
says which build it was measured on.

### Two measurement artefacts that are NOT defects

Both were hit during this run and both cost time before they were caught. They
are recorded because a future reader looking at these panes will hit them too,
and because filing either as a bug would put a false row in this table.

- **`tweb screenshot` lags one paint.** task-1 took three consecutive
  screenshots 3 seconds apart that were byte-identical (md5
  `2dc53830b42cd4c8786c7dcb06ab61fd`) while the DOM had already changed — proven
  by setting `document.body.style.background='#00ff00'` and reading it back
  through `eval` (`bg='rgb(0, 255, 0)'`) while the PNG still showed the old
  frame. This is exactly how a run measures a stale page for an hour. Take a
  throwaway shot first and confirm state through `eval` as well as the image.
- **A hidden pane cannot be clicked, and that is correct.** In a tmux window
  nobody is viewing, `window.visible=false` and `contentSize` collapses to
  685×1 (`surface-policy.cjs`). Mouse events still arrive — mousedown, mouseup
  and click all fire, and task-1 logged them — but hit-testing resolves to
  `HTML` instead of the link, so the click silently does nothing. Holding the
  surface open (`contentSize` 685×1 → 685×162) makes the identical click
  navigate. A click that "does nothing" in a background pane is an artefact of
  the measurement, not a defect.

One reported finding was **retracted** on this basis: task-1 initially observed
a restored engine exiting by itself ~35s later with `Ok(0)` and flagged it
`OBSERVED-ONCE-NOT-REPRODUCED`. task-2's cleanup list showed `%546` was among
the panes it killed; the clean `Ok(0)` is exactly right for a frontend that
received SIGTERM. Retracted in full — there is no unexplained engine exit, and
it does not appear in the table. (Two agents unable to tell their panes apart in
a shared tmux window is itself an illustration of §2.5.)

---

## 2. Broken outranks missing

The ranking exists because this project has already learned the lesson twice: a
blank pane behind a green `make check`, and an ATTACH path that would have
accepted a connection and rendered nothing. Both times the correct call was to
withhold rather than half-ship. A feature that is absent costs the user a
decision before they commit; a feature that is present and fails costs them the
work they had already done.

Six things on this board are broken rather than absent. They are listed in
severity order, by what a Chrome refugee hits and how bad it is when they do.
Four of the six were closed in the working tree during this run — each carries a
note saying so, and each is kept rather than deleted, because the fixes are
uncommitted and because the *shape* of the failures is the argument this section
is making.

### 2.1 `window.print()` wedges the renderer — permanently, and silently

> **Fixed in the working tree by task-4 (§6.2, §6.3)**, verified by driving
> task-2's exact sequence, in the top frame *and* in a dynamically created
> iframe. The verdict below describes HEAD `947891b`, which is what the owner's
> installed `~/.local/bin/tweb` still runs.

The only defect on this board shaped like data loss. `window.print()` hangs the
renderer, and it does not come back: `tweb reload` returns `true` and does not
restore it, navigating away worked once and failed the second time. Meanwhile
**the pane keeps painting** — task-2's `/tmp/t2/shot-print-wedged.png` renders
example.com perfectly — so a user sees a healthy browser that no longer answers
anything. The real key path is dead too, not just the agent socket.

Three things make this worse than a missing print feature:

- Sites call `window.print()` from their own Print button, so the user reaches it
  without ever pressing Ctrl-P — typically with a receipt, a boarding pass or a
  filled-in form in front of them.
- `tweb errors` reports `no errors` throughout. There is no signal at all.
- It **leaks a process**. After the wedge, `tmux kill-pane -t %541` left
  `tweb __pane` pid 42841 reparented to PPID 1, still holding its Electron child
  42891, with the tmux pane gone. The operator notes name "zero ppid=1 Electrons"
  as a known-good property; the wedge violates it. task-2's clean panes exited
  cleanly, so the wedge specifically causes it.

**Independently replicated.** task-4 reproduced the whole sequence on its own
harness before changing a line — different pane (`%549`), different fixture
(port 8751), engine app verified via `tweb diag --json`: control eval returns
`'control ok tweb t4 flows'`, `window.print()` times out `rc=124`, the following
eval times out `rc=124`, `diag` reports `page did not answer page-diag within
3000ms` while `window.visible`/`contentSize` still read fine. The orphan
replicated too: `tmux kill-pane -t %549` left pid 10513 at PPID 1 holding
Electron child 10580. Two independent harnesses, same result — not a measurement
artefact.

task-4 added one diagnostic detail nobody else had: **the engine process is not
hung.** `engine-log` still answers after the wedge and keeps logging frames
(`frame generation=0 1370x20`). It is the *renderer's* main thread blocked inside
Chromium's print path, which is why the pane keeps painting its last frame and
looks alive — and which is consistent with the fix being an interception in the
page's main world, before Chromium's handler ever runs.

### 2.2 Uploads: the control is there, the click reports `ok`, nothing happens

> **Built in the working tree by task-4 (§6.2)** — a path-entry chooser with tab
> completion, verified by reading the uploaded bytes back byte-identical from
> page JS. The verdict below describes HEAD `947891b`. Drag and drop from Finder
> remains permanently impossible (§4) and the chooser does not change that.

The worst shape a gap can take. The page draws a normal `Choose File` button,
TWeb's own snapshot enumerates it as interactive, `tweb click` returns `ok`, an
instrumented listener confirms the DOM click fired (`clicks=1 files=0`) — and no
chooser opens, no native window appears, no error surfaces anywhere. The user
finds out mid-task with a composed email in front of them. This costs every
attachment: Gmail, Slack, a screenshot dragged into a GitHub issue, a profile
photo, any "upload your CSV" admin form.

### 2.3 Find-in-page: the bar opens, accepts typing, and finds nothing

Cmd+F is muscle memory a dozen times a day. Here `/` opens a Chrome-styled bar,
the query goes in, `contents.findInPage()` is genuinely called — and the
`found-in-page` event never fires, so there is no counter, no highlight, and
Enter closes the bar without scrolling to the match. Every visible sign says it
is working. task-1's control (`window.find()` succeeds on the same text in the
same pane at the same moment) rules out both the harness and the page.

### 2.4 PDF: a perfect Chrome viewer you cannot scroll

Chromium's full PDF viewer is present and paints beautifully — toolbar, `1 / 5`
page indicator, thumbnail sidebar, download and print icons. None of it is
reachable. Both input paths leave the rendered bytes identical. A user opens a
bank statement, reads page one, and cannot get to page two of five. The toolbar
advertising download, print, and page navigation is fully drawn and entirely
inert. Note this contradicts the grep survey's `PDF: none` — present-but-broken
is a different and worse statement than absent.

### 2.5 Session loss when two browser panes share a tmux window

The session store is keyed by tmux **window index**, with the pane id absent
from the key — task-1 proved this by recomputing the hash and matching the
filenames on disk, so it is structural rather than a race. Two TWeb panes in one
window share one session slot and the last to exit silently erases the other's
tabs. This project's entire pitch encourages side-by-side panes, so the
configuration that triggers it is the one the tool is for. task-1 lost four tabs
to it during this run without trying to.

### 2.6 `tweb profile bootstrap` is shipped, documented, and does nothing

The CLI accepts the subcommand, `tweb --help` lists it, it takes its argument —
and then answers `Error: command not yet implemented`. The README points a
migrating user directly at it. This is the shape the operator notes warn about:
a promise a switcher acts on during the exact hour they are most committed and
least able to back out. (`tweb resource list` has the same shape.)

task-3 independently reproduced this and found the same shape on a second
documented promise. Both were run, not grepped:

```
$ ./target/debug/tweb profile bootstrap chrome
Error: command not yet implemented: Profile { action: Bootstrap { source: "chrome" } }   rc=1
$ ./target/debug/tweb chrome open https://sendbird.okta.com
Error: command not yet implemented                                                       rc=1
$ ./target/debug/tweb resource list
Error: command not yet implemented                                                       rc=1
```

The managed-Chrome handoff is the more interesting of the two, because it has
something that *looks* like backing: `crates/tweb-core/src/routing.rs` defines a
`BrowserRoutingPolicy` with an `*.okta.com` default denylist. But grepping for
consumers of `RouteDecision` / `BrowserRoutingPolicy` outside that one file
returns zero — it is a dead type nothing calls. A dead type is not runtime
backing, and a reader who finds it would reasonably conclude otherwise.

### The pattern underneath, which is the actual finding of this run

Four of the six — print, uploads, find-in-page, and the PDF frame — are the
**same root class**: a Chromium path that expects a native window or a focused
`webContents`, reached from an offscreen `show:false` window, with no workaround
written. This is not four unrelated features.

The evidence that it is one class and that it is solvable is in the codebase
already: `main.cjs:3854` carries an explicit workaround for exactly this on the
context-menu path (*"Some offscreen Chromium paths do not raise contextmenu from
a right mouseUp alone"*), and `main.cjs:2688` carries another for copy-image
(*"in offscreen Chromium `copyImageAt` may not update the pasteboard"*). **Both
of those features work.** Somebody hit the class twice, wrote the workaround
twice, and the two paths they covered are the two that pass. Find, print, the
file chooser and the PDF frame are the same class, unwritten.

That reframes the work: this is not "TWeb is missing four browser features," it
is "one known, already-solved-twice pattern has four more instances."

**It stopped being a hypothesis during this run.** task-4 took two of the four —
print and the file chooser — and closed both the same way, by intercepting the
path before Chromium's handler runs, in the world where the page actually lives
(§6.2, §6.3). The pattern now has four worked examples in this codebase and two
instances left, which is why §7 recommends finishing the class rather than
treating find-in-page and the PDF frame as separate features.

---

## 3. Policy decision log

Every user-visible policy decision made during this run, with its reasoning.
Decisions are stated here rather than picked silently in a diff. Decisions 1–8
are task-2's, arrived at during measurement; 9–14 are task-4's, arrived at while
building.

### 3.1 Decisions from measurement (task-2)

1. **Download destination: keep `~/Downloads`, unprompted.** Chrome's
   ask-where-to-save is off by default, so adding a save-as prompt would be a
   regression against Chrome's real behaviour, not an improvement.
   `TWEB_DOWNLOAD_DIR` (`main.cjs:93`) already exists as the equivalent of
   Chrome's setting. This is the decision *not* to be clever.
2. **Download notification: build it — this is the actual gap.** The transfer
   already works and lands where Chrome would; what is missing is that the user
   is never told. Minimum bar: a transient in-pane line naming the file, plus a
   persistent `tweb downloads` list (the `chrome://downloads` equivalent).
   In-flight progress is the second tier.
3. **"Show in folder" becomes: print the absolute path.** Not a workaround.
   Chrome's Finder window is less useful in a terminal than a path is, because a
   path is directly actionable by the user's own tools.
4. **The terminal-native file chooser is a path-entry prompt, not a simulated
   GUI.** The terminal user already has the path — they got there with
   `ls`/`fd`/`fzf`, which is faster than clicking through Finder. It must
   support completion or fuzzy matching and honour the input's `accept` and
   `multiple` attributes. Delivery to the page requires CDP
   `DOM.setFileInputFiles`; there is no supported non-CDP way to set files on an
   offscreen input, and `tweb fill` is blocked by Chromium security by design.
5. **Do not build a password manager.** A homegrown credential store is a
   security liability with a long tail — encryption at rest, keychain
   integration, sync, breach notification — and it would be strictly worse than
   the 1Password the owner already runs. Chrome's own manager is not what he uses
   either. The correct target is the **extension** path, which fixes passwords as
   a side effect. If an interim is wanted, shell out to `op read` on an
   **explicit** keystroke — explicit and never automatic, because silent autofill
   without the origin confirmation Chrome shows is a phishing risk. A terminal
   port of autofill should be *more* explicit than Chrome's, not less.
6. **`mailto:` — leave it alone.** Handing to the OS default handler is exactly
   what Chrome does, and it is already measured working with clean browser state.
   Routing to `mutt`/`neomutt` would be a regression for anyone whose mail lives
   in Mail.app or Gmail. Opt-in config only, never the default. One honest
   difference remains: Chrome can register a *web* app (Gmail) as the `mailto:`
   handler, so a Gmail-in-a-tab user gets Gmail's composer in Chrome and Mail.app
   in TWeb.
7. **Print: intercept `window.print()` first, before designing any print
   feature.** The interception is what stops the wedge and it does not depend on
   deciding what printing means. Then split what Chrome fuses into one dialog:
   save-as-PDF via `printToPDF()` into `~/Downloads` — by far the common case and
   no dialog is needed — and `lpr` for actual paper. Shipping save-as-PDF only is
   acceptable **if it says so**; silently remapping Ctrl-P would surprise someone
   who wanted paper.
8. **Bookmarks: import ≫ bookmarking UI.** Losing years of accumulated bookmarks
   on day one is the migration blocker; the bookmarks *bar* is a GUI affordance
   whose terminal equivalent (a fuzzy-searchable list) is a genuine win but a
   lower priority. Until either exists, the README claim must go.

### 3.2 Decisions from implementation (task-4)

9. **Scope pivot: fix the print wedge before building any feature.** task-4's
   dispatch scoped it to downloads then uploads; it accepted the reordering and
   took the print interception first, on the grounds that broken outranks feature
   work and this is the only data-loss-shaped defect on the board. A consequence
   worth recording: intercepting `window.print()` removes the *cause* of the
   PPID-1 orphan, so task-4 deliberately did **not** write an orphan reaper —
   fixing the cause rather than adding a cleanup path for a symptom.
10. **Do not rebuild what was already proven.** The transfer, the `~/Downloads`
    landing and the ` (1)` collision suffix were measured working by task-2, so
    task-4's download deliverable is purely the layer that *tells* the user:
    in-flight progress, completion with the absolute path, and failure or
    cancellation. Stated so a reviewer does not read the absence of transfer code
    in the diff as an omission.
11. **Explicitly not taken this run**, recorded as untouched rather than left
    ambiguous: find-in-page, PDF frame routing, and the per-window session-key
    collision (which is outside `electron/**` and structurally contentious — the
    obvious fix of adding the pane id to the key is wrong, because pane ids
    change across restarts, which is precisely why window index was chosen).
12. **The terminal-native file chooser is a path-entry prompt with tab
    completion** — task-4's decision, made having built it, agreeing with §3.1
    decision 4 rather than re-deciding it. Tab completes to the **longest common
    prefix** (shell behaviour, which never guesses wrong), a lone directory match
    gains a trailing slash so a second Tab goes inside it, dotfiles stay hidden
    until the prefix starts with a dot, and directories sort first because going
    deeper is the common move.
13. **Save-as-PDF is labelled as what it is, in the product.** Ctrl-P writes a
    PDF to `~/Downloads`; the help text reads `Ctrl-P  save the page as a PDF in
    ~/Downloads (a terminal cannot draw a print dialog)` and the badge shows a
    filename ending in `.pdf`. This is §3.1 decision 7 carried out *including*
    its honesty requirement — a user who wanted paper is told immediately rather
    than discovering it from the absence of a printout.
14. **A mistyped path keeps the chooser open rather than cancelling it.** The
    first build silently cancelled on a bad path, which is a failure mode a path
    prompt has and Chrome's GUI picker structurally cannot. task-4 found it in
    its own work and fixed it: the prompt stays open, keeps the typed text, and
    shows the error in red (§6.3).

*(Outcomes of task-4's work — what landed and what was verified — are in §6.)*

---

## 4. Cannot be reproduced

Chrome behaviours that cannot honestly exist in a terminal. Stated here so they
are not filed as future work implying they might arrive, and so that nobody
builds something that only *looks* like them.

1. **Drag and drop from Finder onto the page.** Does not exist and cannot be made
   to exist. This is a permanent, unfixable delta for uploads — even a perfect
   path-entry chooser does not close it.
2. **Chrome's native file chooser**: previews, sidebar favourites, search.
3. **Chrome's print preview GUI**: paper size, margins, scaling, page range, the
   live preview pane, and the macOS system print dialog.
4. **Chrome's autofill dropdown** anchored to the field, and its Touch ID /
   macOS-keychain confirmation — these are OS-level dialogs.
5. **`Cmd`-based shortcuts.** `Cmd` is not transmissible through a terminal at
   all, so Chrome's `Cmd+[` / `Cmd+F` / `Cmd+P` can never arrive. (Note the
   distinction task-1 drew: `M-Left`, `M-Right` and `BSpace` *are* deliverable
   through tmux and are merely unbound — those are gaps, not impossibilities.)
6. **The IME pre-edit underline.** macOS composes hangul in the terminal
   emulator, so TWeb receives already-committed UTF-8 and can never draw the
   underlined in-progress composition Chrome shows. task-1 argues this is
   arguably an improvement — the page never sees half-formed state.
7. **Full Chrome extension API support.** Electron supports a subset;
   `declarativeNetRequest` works, which is what an ad blocker needs, but "full
   extension support" is not achievable and should not be promised.

---

## 5. Genuinely better

Where TWeb beats Chrome. These are not gaps and are not framed as gaps.

1. **Exclusive audio arbitration across panes.** Measured by task-1: `%543`
   playing alone owns the speakers; `%544` starting playback takes ownership and
   `%543` flips to `muted=true, mutedByOther=true`; pressing `m` on `%543` takes
   it back and mutes `%544`. Exactly one pane holds the speakers, the takeover is
   automatic, the loser is told *why* (`mutedByOther` distinguishes "I muted
   this" from "something took the speakers"), and one keystroke moves it. Chrome
   gives you N tabs shouting at once and a tiny speaker icon to hunt for. The
   design note backing it is deliberate policy Chrome does not have: *"a page
   starting playback is not consent to take the speakers from a pane that is
   already using them. Only `m` does that"* — an autoplaying ad cannot steal your
   audio.
2. **Popups become tabs.** `setWindowOpenHandler` turns a `window.open` into a
   real TWeb tab rather than a chromeless floating window. For a terminal browser
   this is exactly right, and it is nicer than what Chrome throws at you. (The
   `window.opener` consequence is recorded honestly as a gap in §1 — the win and
   the gap are both true.)
3. **History as an overlay, not a tab.** Two keys open a searchable overlay on
   the page you are already reading, with live incremental filtering over the
   whole 343-visit store, Enter to open, Shift-Enter for a new tab, Ctrl-D to
   delete. Chrome makes you navigate to a tab and mouse through it. Fewer
   keystrokes to the same result and no tab spent.
4. **Reporting a download's absolute path** beats "Show in folder" in a terminal,
   because the path is immediately usable by the tools already at hand. As built
   this run: the path is the badge tooltip, the headline of every `gd` row, and
   is copied to the system clipboard on Enter — verified from outside TWeb, the
   macOS pasteboard held `/Users/gavin.jeong/Downloads/sample.txt`. Chrome opens
   a Finder window, which a terminal user then has to translate back into a path.
5. **Session restore is per tmux window and on by default.** When it is not
   colliding (§2.5), this is better than Chrome's default: Chrome reopens tabs
   only if you set "Continue where you left off", and it is per-profile rather
   than per-window. TWeb restores tab order, the active tab, and per-tab zoom.
6. **Native vimium-style keys**, which make the Vimium extension largely moot —
   one of the few extension losses that is already covered.
7. **The retained engine log** (`main.cjs:234-240`, deliberately un-gated with a
   comment explaining why) means a download record survives on a pane launched
   with no debug flags. Half the plumbing for a real downloads list already
   exists.
8. **Exact Chrome parity where it counts, verified rather than assumed**:
   download collision handling preserves the original and appends Chrome's own
   ` (1)` suffix (driven, not read); a 156203-byte PDF downloaded byte-identical
   to source under `cmp`; `mailto:` matches Chrome with *cleaner* state — no
   orphan `about:blank` tab, page URL untouched.

---

## 6. Working-tree summary

Nothing was committed, pushed, or opened as a PR. The working tree is the
deliverable. `crates/tweb-cli/src/doctor.rs` and `crates/tweb-pane/src/resize.rs`
were modified before this run by a different session and no peer touched them.

### 6.1 task-3 — documents only, no code

task-3 edited `.md` files exclusively. The theme is that three README promises
were **verified false by running the commands**, not by grepping, and removed.

**`README.md`** — the migration-facing document, and the largest change:

- *Removed from Core principles*: the "Chrome profile bootstrap … imported
  policy-aware" bullet and the "Managed Chrome boundary … handed off to real
  Google Chrome" bullet. Both were run and both answer `command not yet
  implemented` with `rc=1`.
- *Removed from the Commands block*: `tweb profile bootstrap chrome`,
  `tweb resource list --window @1`, `tweb resource send`. A reader copies
  commands out of that block and all three error. Replaced by one explicit
  paragraph naming `resource`/`profile`/`chrome` as placeholders that parse and
  then exit unimplemented — so nobody discovers it mid-migration.
- *Rewrote* "Terminal graphics-native": the old text advertised "a Ghostty GPU
  surface fast path plus a standard Kitty fallback". There is no GPU fast path;
  Kitty is the only path and is not a fallback.
- *Rewrote* "Shared browser profile": it claimed panes in the same tmux *session*
  share a profile; it is one global `userData` dir across all panes and sessions.
- *Replaced* "Agent resource exchange … typed attachments" with the agent-socket
  description, which is what ships.
- *Rewrote* Components: "TWeb Profile Bridge" deleted (`extension/` is empty).
  `twebd` kept and described honestly — built, owns identity, hosts no page — and
  the withheld host declaration is stated as **intentional and load-bearing**, so
  nobody "fixes" it into accepting an attach it cannot serve.
- *Rewrote* Implementation languages: C++/Objective-C++/Zig/TypeScript deleted
  from the shipping table (zero such files exist outside `node_modules`) and
  moved to a note pointing at DESIGN §6.3 as intent.
- *Added* a frame-policy caveat: the session key omits the pane id, so two panes
  in one tmux window silently overwrite each other's tabs (§2.5).
- *Added* a Tauri honesty note: the parity list is claimed by shared-preload
  construction and was **not exercised** this run; every measured verdict here is
  Electron.
- *Marked* the `/` row in the shortcut table as broken **inline**, because a
  reader reaches that table without reading Status.
- *Replaced* the Status section entirely — "Currently at the architecture/design
  stage", over sixteen merged PRs — with five sections: what works (13 measured
  rows), what is broken today (9 items ranked by what a Chrome refugee hits,
  print wedge first), what is missing, what is deliberately not attempted (each
  stated as permanent rather than pending), and where TWeb beats Chrome. It also
  carries the root-class observation from §2 and points at the two places
  `main.cjs` already solves it.
- IME is recorded as **validated** with task-1's byte-exact codepoints, plus both
  caveats (live 2-set per-jamo backspace unmeasured; the cosmetic mode-indicator
  flip).

**`DESIGN.md`** — a top banner plus five section-head markers, no prose rewrites:
the banner says README Status is the authority on what runs and indexes the
unbuilt sections; §6.3 (only Rust and CJS exist), §7.2 (GPU fast path unbuilt —
every frame ever drawn went through §7.3), §10 (bootstrap entirely unbuilt, with
the `| Bookmarks | imported |` row called out by name as reading like shipped
behaviour), §11 (handoff unbuilt; `BrowserRoutingPolicy` is a dead type with zero
consumers; a URL needing Device Trust just loads and fails), §12.3 (a 38-line
stub, and what ships instead is a *different* mechanism, not a partial one), §17
(where each of seven validation targets actually stands), §19 (which clauses of
the product definition are unbuilt).

**`DETAIL.md`** — banner now points at README Status; §9 gained a marker (the
trait matrix in §9.3 lists implementations that do not exist in any form). §7 and
§10 already had honest markers and were left alone.

**`PREDEV.md` / `FEASIBILITY.md`** — one header note each: dated
pre-implementation documents, superseded, see README Status. No rewrite;
FEASIBILITY's "feasible" verdicts are relabelled as pre-implementation
assessments rather than statements about the running system.

### 6.2 task-4 — runtime

task-4 pivoted from its dispatch scope to the print wedge first (§3.2 decision 9)
and then delivered the download notification layer. Both were verified by use,
not by test.

**Print interception — the wedge is closed for both the top frame and
dynamically created iframes (§6.3), and it produces a real PDF.** task-4 drove
task-2's exact sequence on pane `%551`, engine app confirmed via `diag`:

```
control:  eval "'control ok ' + document.title"   -> 'control ok tweb t4 flows'
the act:  eval "window.print(); 'returned'"       -> 'returned'      rc=0   [was TIMEOUT rc=124]
after:    eval "'post-print ok'"                  -> 'post-print ok' rc=0   [was TIMEOUT rc=124]
```

It is not a no-op: `~/Downloads/'tweb t4 flows.pdf'`, 81805 bytes, `%PDF-1.4`
header, 1 page, trailer ends `%%EOF`. Engine log shows `tweb: native shortcut
print` then `tweb: download completed …/tweb t4 flows.pdf`, and the event is
recorded as `{"state":"completed","filename":"tweb t4 flows.pdf","bytes":81805,
"origin":"print"}` in `downloads.jsonl`.

The mechanism is the part a reviewer should look at closely, and task-4 verified
it by spike rather than assuming: **the shim cannot live in the preload's own
`window`.** With `contextIsolation` the preload's `window` is a different object,
so assigning `window.print` there leaves the page's `print` untouched — task-4's
probe confirmed the isolated world is invisible from the main world and vice
versa. It is installed via `webFrame.executeJavaScript` from the preload, which
runs in the **page's** main world, in every frame that gets a preload (an
iframe's `print()` wedges the same renderer), and it announces through a DOM
`CustomEvent` that the preload bridges to IPC, because the main world has no IPC.

What task-4 claims and does not claim, stated in the product itself rather than
only in a report: Ctrl-P and a site's own Print button now **save a PDF** to
`~/Downloads` and say so. They do not print to paper and there is no preview.
The help text reads `Ctrl-P  save the page as a PDF in ~/Downloads (a terminal
cannot draw a print dialog)` and the badge shows a filename ending in `.pdf` —
this is §3.1 decision 7 carried out including its honesty requirement, rather
than a silent remap of Ctrl-P.

This also removes the **cause** of the PPID-1 orphan (§2.1): the orphan only
appeared after a wedge, and after §6.3 no wedge remains in either the top frame
or a dynamically created iframe. task-4 deliberately did not write an orphan
reaper, on the grounds that fixing the cause beats adding a cleanup path for a
symptom.

**Scope correction, from task-4 against its own claim — kept on the record even
though it was subsequently closed.** task-4 initially reported the wedge fixed in
"every frame that gets a preload", then tested a case it had only reasoned about
and found the hole: a **dynamically created `about:blank` iframe does not get a
preload, so it was not shimmed, and it still wedged exactly as before.** Measured
on pane `%556`, engine app verified:

```
control: eval "'alive'"                                   -> 'alive'
the act: eval "…createElement('iframe')… f.contentWindow.print(); 'returned'"
                                                          -> TIMEOUT rc=124
after:   eval "'post-iframe-print ok'"                    -> TIMEOUT rc=124
```

Killing that pane left a PPID-1 orphan again (pid 89231), so the orphan cause is
not fully removed either.

This is not a corner case. Building a hidden iframe, writing receipt HTML into
it, and calling `print()` on the iframe — so the printout is the receipt rather
than the whole page — is a common real-site pattern, and it is exactly the
daily-browser moment (a receipt after a purchase) where a wedge costs most.
task-4 went back and **closed it** rather than documenting around it; the fix,
and the two further defects that closing it exposed, are in §6.3.

The correction is worth noting on its own terms: it is the same
"looks-fixed, fails-at-the-moment-of-use" shape this run exists to catch, caught
by the person who wrote the code, against their own claim, before it reached the
owner.

**Download notification — both halves, with screenshots task-4 opened:**

- in-flight: `/tmp/t4/dl-inflight.png` shows `⇣ big (3).bin 24%` live in the
  badge row next to `N` and `1/1`
- completion: `/tmp/t4/dl-complete.png` shows `✓ sample.txt` in green
- expiry: `/tmp/t4/dl-done.png`, same pane after the hold, shows the badge
  **gone** — it retires rather than becoming permanent furniture

*(Files claimed by task-4: `electron/main.cjs`, `electron/preload.cjs`,
`electron/download-state.cjs`, `electron/download-state.test.cjs`,
`electron/preload-regression.test.cjs`, `crates/tweb-pane/src/engine_app.rs`,
`Makefile`, `task4-implementation.md`. Full detail is in
`task4-implementation.md`.)*

**Uploads — the file chooser was built, and the test was whether the page can
read the bytes.** task-2 called this the highest-severity item; task-4 delivered
it and verified it seven ways on pane `%553`, engine app confirmed, every
screenshot opened:

1. **The chooser opens.** `tweb click %553 g` on the file input →
   `diag page.mode='chooser' detail='58'`. `/tmp/t4/chooser.png` shows an
   amber-bordered panel, the path prefilled to cwd, and a live directory listing
   with directories in blue first.
2. **Tab completion works on the real key path** (`tmux send-keys`, not the agent
   socket): typing `/tmp/t4www/sam` then Tab produced `/tmp/t4www/sample.txt`
   (`/tmp/t4/chooser-tab.png`).
3. **The file actually arrives** — the test that matters:
   `input.files` → `{"count":1,"name":"sample.txt","size":59,"type":"text/plain"}`,
   and `await input.files[0].text()` returns
   `ecrMNbLKVjKpCB6okB3QhA5Bccl0KMQtzzhdbCzR+HunRSMKb4TkXf6VuC9`, byte-identical
   to `cat /tmp/t4www/sample.txt`. A real `File` object with the right name, size
   and sniffed MIME type, readable by page JS — a genuine upload, not a prompt
   that looks like one.
4. **Multiple**: on a `multiple accept=.txt,.csv` input, two space-separated
   paths → `{"count":2,"names":["sample.txt:59","data.csv:11"]}`.
5. **`accept` is honoured**: `/tmp/t4/chooser-multi.png`, opened in the
   `electron/` directory which is full of `.cjs` files, offers only
   `node_modules/`. The heading names the filter — `Choose files to upload
   (.txt,.csv)` — so a user offered fewer files than expected can see the *page*
   asked for that rather than suspecting the chooser.
6. **Chrome's own label updates**: the same screenshot shows the first input now
   reading `sample.txt` instead of `No file chosen` — Chromium's own rendering of
   the control, so the page's state is genuinely correct, not just the overlay's.
7. **Cancellation**: Esc returns mode to `normal`, the previously chosen file
   survives (`count=1 name=sample.txt` — Chrome does not clear a selection on a
   cancelled reopen either), and the chooser reopens cleanly. An unanswered
   chooser would leave Chromium believing a dialog is open, so cancel still sends
   `setFileInputFiles` with an empty list.

Mechanism, confirming task-2's read: CDP `Page.setInterceptFileChooserDialog` +
`Page.fileChooserOpened`, delivered with `DOM.setFileInputFiles`. `dialog` is
still not imported and should not be — a native dialog cannot draw from an
offscreen window either, so importing it would have produced the same silent
nothing. One thing that cost task-4 a spike and is worth knowing:
`fileChooserOpened` does **not** fire for a click without user activation; a
first spike clicking via `executeJavaScript` with `userGesture=false` got no
event at all.

### 6.3 The iframe print fix, and the two defects closing it exposed

task-4 closed the hole and re-verified with the same three-step sequence. Final
state, panes `%561`/`%562`, engine app verified, all measured:

```
control:                eval "'alive'"                        -> 'alive'          rc=0
TOP FRAME print:        eval "window.print(); 'returned'"     -> 'returned'       rc=0
SAME-TICK IFRAME print: eval "…append(f); f.contentWindow.document.write('receipt');
                              f.contentWindow.print(); 'returned'"
                                                              -> 'returned'       rc=0
after:                  eval "'post-iframe-print ok'"         -> 'post-iframe-print ok'  rc=0
```

Both produced PDFs: `tweb t4 flows.pdf` (81805 bytes) and
`tweb t4 flows (1).pdf` (88445 bytes) — note the collision suffix working on the
print path too. task-4 also drove Ctrl-P through the **real key path**
(`tmux send-keys C-p`), which it had asserted in its report without testing; the
PDF landed and the engine log recorded the completion.

**Why the obvious fix was not enough**, which is the reusable part: Electron's
`frame-created` is **async**. A page that calls `contentWindow.document.write(…)`
and `contentWindow.print()` in one tick wedges the renderer before any shim from
the main process can land — task-4 measured the hook firing correctly and the
shim landing, and the wedge still happened, because the print had already run.
The fix patches the **accessors** the page must go through to reach a child
window (`HTMLIFrameElement.prototype.contentWindow` / `contentDocument`), which
shims the child *synchronously* on the very access that precedes the call.
`frame-created` is kept as a second net for slower shapes.

**The second defect, and the most valuable thing for anyone else touching
`electron/`: the preload is sandboxed.** task-4 first factored the shim into
`download-state.cjs` and required it from `preload.cjs`. `require` there reaches
Electron's builtins and nothing else, so the whole preload died with
`Error: module not found: ./download-state.cjs`. The symptom was not a crash:
the page loaded and painted fine, every screenshot looked normal, and every TWeb
shortcut, overlay and mode was dead in that pane while it looked completely
healthy. task-4 only caught it because `window.print()` started wedging again in
a case that had worked twenty minutes earlier.

The tell is `tweb engine-log --pane %N | grep preload` →
`preload failed … module not found`. **`make check` does not catch it** — 366
tests were green while the preload was dead in every real pane. This is another
instance of the operator note that anything reachable only through a real run
needs a real run, and it belongs next to the `cleanupFrameFiles` precedent. The
preload now carries its own copy of the shim, with a test asserting the two
copies keep the same protections (re-entry guard, configurable/writable, the
accessor patch), since duplication without a check is how they drift.

**A gap in task-4's own upload work, self-reported rather than buried.** A
mistyped path used to *silently cancel* the chooser: `/tmp/t4www/sampl.txt`
(missing an `e`) closed the prompt with no message and `files=0`. That is exactly
the "looked like it worked" shape this run exists to kill — and it is a failure
mode a path prompt *has* and Chrome's GUI picker structurally cannot, so it is
owned rather than inherited. Now the prompt stays open, keeps the typed text, and
shows `No such file: /tmp/t4www/sampl.txt` in red (`/tmp/t4/chooser-typo.png`,
opened); recovery in place was verified — backspace four characters, type
`e.txt`, Enter → `{"count":1,"name":"sample.txt","size":59}`, mode back to
normal.

One further claim task-4 had written but not driven, now driven: `gd` then
Shift-Enter opens the downloaded file — the pane navigated to
`file:///Users/gavin.jeong/Downloads/tweb%20t4%20flows.pdf` and the PDF renders
(`/tmp/t4/gd-open-pdf.png`, opened). That also means downloaded PDFs are readable
in-pane, subject to the inertness caveat in §2.4, which task-4 did not touch.

### 6.4 `make check`

**End of run: `rc=0`.** Confirmed twice against the combined tree — once by
task-4 after its final edit, and once by me (task-5) afterwards, so the figure
below is not a peer's word for the state of a tree they were still editing:

```
MAKE_CHECK_RC=0
electron:  371 pass / 0 fail   (cd electron && bun test)
rust:      30 + 1 + 16 + 77 + 107 passed, 0 failed, full workspace
fmt clean, clippy -D warnings clean
```

The tree that produced it is the one listed in §6.5: task-3's five documents,
task-4's runtime changes, the three investigator reports and this file.

The Electron test count rose from 320 at the start of the run to 371, from
task-4's `download-state.test.cjs` (30 tests), `file-chooser.test.cjs` (21
tests), and the widened preload guard.

A caveat this project has already paid for twice, worth repeating next to any
green check: **`make check` proves less than it looks.** `node --check` only
parses. The `cleanupFrameFiles` ReferenceError once threw on every engine exit
while all 320 tests were green. And during this very run, 366 tests were green
while a `require()` in the sandboxed preload had killed every shortcut, overlay
and mode in every real pane (§6.3). Everything claimed in §6.2 and §6.3 was
therefore verified by driving a real pane, not by the suite.

### 6.5 Working tree, file by file

What a reviewer will see in the diff. Nothing was committed, pushed, or opened
as a PR. `crates/tweb-cli/src/doctor.rs` and `crates/tweb-pane/src/resize.rs`
show as modified in `git status` — that is a different session's pre-existing
work and no peer in this run touched either file.

**task-4 (runtime):**

| File | Change |
| --- | --- |
| `electron/download-state.cjs` | NEW, pure: badge text, percent-vs-bytes fallback, which transfer wins the single badge slot, badge expiry, jsonl record shape, list model, print filename derivation, and the print shim script main injects |
| `electron/download-state.test.cjs` | NEW, 30 tests |
| `electron/file-chooser.cjs` | NEW, pure: completion scope, `~` expansion, `accept` matching, entry filter and ordering, longest-common-prefix completion, single-vs-multiple resolution |
| `electron/file-chooser.test.cjs` | NEW, 21 tests |
| `electron/main.cjs` | `configureDownloads` grows updated/done tracking; new `printPageToPdf`, `cancelTransfer`, downloads jsonl read/write, the CDP file-chooser block, `shimFramePrint` on `frame-created`; Ctrl-P and Ctrl-D in the key path; `setWindowOpenHandler` now honours the `background-tab` disposition |
| `electron/preload.cjs` | main-world print shim including the child-frame accessor patch; transfer badge in the indicator; the `gd` downloads overlay; the file-chooser prompt with its error state; new IPC listeners; help text for `gd` / Ctrl-P / Ctrl-D |
| `electron/preload-regression.test.cjs` | the "every function the preload calls is defined in it" guard now counts a name destructured out of a `require` as defined — the guard fired correctly on the change and needed widening |
| `crates/tweb-pane/src/engine_app.rs` | two entries added to the embed list (test files are not embedded, per the rule) |
| `Makefile` | two `node --check` lines in `electron-check` |
| `task4-implementation.md` | NEW, task-4's report |

**task-3 (documents only):** `README.md`, `DESIGN.md`, `DETAIL.md`, `PREDEV.md`,
`FEASIBILITY.md` — detailed in §6.1.

**Investigator reports:** `task1-inventory-interaction.md`,
`task2-inventory-files.md`, and this file.

### 6.6 Verdicts that moved during the run

Four rows in §1 describe HEAD `947891b` and are superseded by the working tree.
They are kept rather than rewritten, because the owner's installed
`~/.local/bin/tweb` still runs the older embedded build (see §1's note on engine
app resolution) — so both states are currently true of something.

| Capability | At HEAD `947891b` | In the working tree |
| --- | --- | --- |
| Print | `broken` (wedges the renderer) | `works` — save-as-PDF only, honestly labelled; not paper, not a preview |
| Uploads / file chooser | `broken` (looks present, does nothing) | `works` — drag-and-drop from Finder remains permanently impossible (§4) |
| Downloads — telling the user | `worse-than-Chrome` | `works` — badge with percentage, completion, failure, cancellation; `gd` list; absolute path |
| Middle-click | `worse-than-Chrome` (steals focus) | `works` — background tab, from task-1's diagnosis, verified with real SGR bytes; `window.open` still activates, control case checked |

Rows that did **not** move, because nobody touched them: find-in-page (broken),
PDF frame inertness (broken), the per-window session-key collision (broken for
two or more panes in one window), extensions (missing), password manager
(missing), bookmarks (missing).

---

## 7. What to do next

Ordered by what a daily user feels first. Depth over breadth: two things that
genuinely work beat six that half-work — that is the project's own standard and
it is the reason this list is short.

### The reasoning for the order

The severity ranking is not the same as the feature-importance ranking. It is
ranked by **what a Chrome refugee hits, and how bad it is when they do**:

1. Things that destroy work already done (the print wedge, session loss).
2. Things that look present and fail at the moment of use (uploads, find, PDF).
3. Things that are absent and known to be absent (extensions, bookmarks,
   passwords) — the user can plan around these, and they are cheaper to live
   with than to discover.

That ordering is why extensions — which is arguably the *largest* feature gap
and the one costing the owner most in daily comfort — is not at the top. An
absent uBlock is a known tax paid every page. A print button that bricks the tab
is a surprise paid once, at the worst possible moment, and it is much cheaper to
fix.

### The state this list starts from

Four of the six broken items in §2 were closed during this run (§6.6). What
follows is what is left, and it is deliberately short.

### Recommendation 1 — finish the offscreen-window class: find-in-page, then the PDF frame

This was one piece of work with four instances at the start of the run. Two of
them — print and the file chooser — are now closed in the working tree, and both
were closed the same way: intercept the path before Chromium's handler runs, in
the world where the page actually lives. **Two instances remain**, and the
pattern for fixing them is now demonstrated three times over in this codebase
(`main.cjs:3854` contextmenu, `main.cjs:2688` copy-image, and task-4's print
shim and CDP chooser).

1. **Find-in-page.** Now the top item. It is the most frequent gesture left
   broken — Cmd+F is muscle memory a dozen times a day — and the diagnosis is
   already specific: the `found-in-page` event never fires, `document.hasFocus()`
   is false, and Chromium's `findInPage` wants a focused `webContents`. The
   capability is otherwise fully built; the bar renders, the IPC works, the call
   is made. This is the same shape as the two problems task-4 just solved.
2. **PDF frame input routing.** The viewer is already there and already correct;
   this is routing keys into a frame the preload does not reach. Do not build a
   PDF viewer or pipe to `pdftotext` — replacing a working Chromium viewer with a
   text dump would be a regression. This matters slightly more now than it did at
   the start of the run: `gd` + Shift-Enter opens a downloaded PDF in-pane, and
   print produces PDFs, so the number of ways a user arrives at an inert PDF
   viewer has gone up.

Do each one completely before starting the next, and verify by driving a real
pane rather than by the suite — §6.3 is the run's own demonstration of why.

### Recommendation 2 — make two TWeb panes in one tmux window safe

Session loss is the second data-destroying defect, and it triggers in exactly the
configuration this project exists to enable. The user opens two browser panes
side by side — the pitch of the whole tool — and whichever exits last silently
erases the other's tabs, with no error and no recovery.

The naive fix is wrong and should be said out loud: adding the pane id to the key
breaks restore entirely, because pane ids change across restarts, which is
precisely why window index was chosen. The honest shapes are an ordinal within
the window, or N sessions per window keyed by pane creation order. This needs a
decision before it needs code, which is why it is a separate recommendation
rather than an item in the list above.

### Deliberately not recommended yet, with reasons

- **Extensions**, despite being the largest gap. It is a genuinely large build
  (Electron supports only a subset of Chrome's API surface), and everything above
  is smaller and more harmful. It should be next after these two. When it is
  taken, note that it closes the password-manager gap as a side effect via
  1Password — which is why building a password store separately would be waste.
- **A password manager.** Recommended *against* — see §3.1 decision 5.
- **A bookmarks UI.** The *import* is the migration blocker; the bar is a GUI
  affordance. See §3.1 decision 8. In the meantime the README must stop claiming
  the import exists (task-3 is removing it — see §6).
- **A disk cache cap.** Explicitly not recommended. `userData` is 1.0 GB, 661 MB
  of it Service Worker CacheStorage for YouTube/Gmail/Meet. Chrome does not prune
  those either, so capping would be a regression under this run's own standard —
  silently dropping a site's offline assets to look tidy. Recorded here because
  it was the question that started this run, and the answer is "do nothing".

### Cheap wins worth taking alongside, but not instead

- **Middle-click should open in the background.** — **Done this run (§6.6):**
  `setWindowOpenHandler` now honours the `background-tab` disposition, verified
  with real SGR bytes, with `window.open` still activating as it should.
- **Bind `M-Left` / `M-Right` (and `BSpace`) to back/forward.** The capability
  already works under `H`/`L`; this is purely about the muscle memory a Chrome
  refugee arrives with. `Cmd+[` cannot be delivered through a terminal and should
  not be attempted (§4). Still open.
- **Tell the user when a download completes.** — **Done this run (§6.2/§6.6):**
  badge with percentage, completion, failure and cancellation, plus a `gd` list
  and the absolute path.
- **Actual paper printing via `lpr`**, the second tier of §3.1 decision 7. Small,
  and honest: the PDF already exists, so this is handing it to the print queue.
  Not urgent — save-as-PDF is the common case and is now labelled as what it is.
- **The `page.mode` indicator lies after typing hangul with no field focused.**
  It flips to `insert` and stays there until Escape, while the page still
  responds to normal-mode keys. Cosmetic only — task-1 confirmed the user is not
  trapped (`jjjj` scrolled 0→360 while the indicator read `insert`) — but it is a
  one-line fix to an indicator whose whole job is to be trusted. Still open.

### One thing to carry forward regardless of what gets built next

The single most transferable finding of this run is not a feature. It is that
**`make check` cannot see the failures that matter here.** Three times now — the
`cleanupFrameFiles` ReferenceError, the blank pane behind a green check, and this
run's sandboxed-preload `require` that killed every shortcut in every real pane
while 366 tests passed — the suite was green and the browser was broken. Every
verdict in this document that says `works` was produced by driving a real pane
and looking at the result. Anything reachable only through a real run needs a
real run, and that should be a condition of merging a change to `electron/`, not
a habit that depends on who is working.
