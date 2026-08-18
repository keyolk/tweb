# TWeb as a daily browser: the gap against Chrome

Run `s1786972005513-4`, started on branch `main` at HEAD `469c58c`.
During the run the project operator split, opened and merged ergonomics as **#32**
(commit `4c7eafd`) while extension work remained uncommitted; the local checkout
was left on `feat/chrome-muscle-memory-paper-print` so task-1's shared
`main.cjs` hunk was not overwritten. Previous run `s1786880826401-2` measured
§1 at HEAD `947891b`; its working tree merged as **#30**, and **#31** moved three
more verdicts.

**Final state of this run.** The remaining work has since merged: the paper-print
result hold as **#33**, extension support as **#34**, and the find-bar reopen
residue as **#35**. `main` is at `57d4f41`. **Every item §7 ever listed is now
closed by a merged PR or dispositioned with the condition that would reopen it** —
see §7 "Disposition of this list". Two limits stand and are stated rather than
hidden: the PDF viewer's own toolbar is unreachable, and extension support covers
the measured classes only.

**The standard for this document.** The project owner intends to browse with TWeb
instead of Chrome, daily. So the question for every capability below is not "is
this implemented" but "does a person who switched from Chrome hit this, and what
happens when they do".

**The evidence rule.** Every row carries how the verdict was reached. A capability
that was only grepped is recorded as *claimed, not exercised* — it is never
promoted to a clean verdict. This document is worth something only if it is true;
a row that says "we did not measure this" is more useful than a row that quietly
implies we did.

**Two states, both currently true.** §1's evidence column records what was
measured at HEAD `947891b` in run `s1786880826401-2`. Since then #30 merged that
run's working tree and #31 landed three more fixes, so seven rows now carry a
second verdict; §6.6 is the ledger of which moved, when, and on what evidence.
Rows are not silently re-dated — the original measurement stays visible next to
the thing that superseded it.

A caveat that has **not** been re-established this run: the owner's installed
`~/.local/bin/tweb` resolves an extracted embedded build rather than this tree
(see §1's note on engine app resolution). The owner's verifications cited below
were done on clean merged `main`, not through that installed binary, so whether
`~/.local/bin/tweb` carries #30 and #31 is **unmeasured** either way.

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

Every original row below was exercised by a peer in a real pane at HEAD
`947891b` during run `s1786880826401-2`. Rows moved by #30, #31 or this run keep
that original evidence and add the later verdict **with its own provenance**.
Where a peer could not exercise something, or exercised only part of it, the row
says so in the last column instead of rounding up to a clean verdict.

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
| PDF | `broken` at HEAD `947891b` — renders beautifully, then traps you on page 1; **partially fixed in #31**: the document scrolls, the viewer's own toolbar is still unreachable (§6.6) | task-2, pane `%541`, `http://127.0.0.1:8731/doc.pdf` (real 5-page PDF, 156203 bytes). The grep survey's `PDF: none` is **wrong**: Chromium's full PDF viewer is present and paints correctly. `/tmp/t2/shot-pdf.png`, opened, shows the complete Chrome PDF viewer — dark toolbar, filename, page indicator `1 / 5`, zoom `81%`, -/+ buttons, fit/rotate/annotate/undo/redo, download and print icons, kebab menu, thumbnail sidebar with page 1 highlighted, document body crisp. Title resolves to `doc.pdf`. Visually indistinguishable from Chrome — and completely inert. Rendered bytes stay identical (md5 `94c52430cb16f33b890a381ecc5ffb67`) across `send-keys j` ×1 and ×5, `send-keys Down` ×3, and `tweb press PageDown` (which returns `true`) — both the real key path and the agent socket. Control case through the same harness: on the HTML fixture, same pane, same `window.visible=false`, `send-keys j` moved `scrollY` 0 → 90, so the harness and key path are live and visibility is not the confound. `tweb errors --pane %541` → `no errors`. Cause: the viewer lives in a separate PDF extension frame the preload does not reach — `tweb snapshot` returns an empty title and zero refs (it lists refs fine on HTML), `tweb eval` sees `BODY children=0`. **What #31 changed:** keys are translated into viewport moves against that extension frame (`electron/pdf-frame.cjs`, new). The project owner verified this personally on clean merged `main`: three PageDown presses give three distinct md5s and the document visibly scrolls. **What #31 explicitly did not change, stated in the commit itself:** the viewer's own toolbar — its download and print buttons, its page box, its own find — remains unreachable. | HEAD `947891b` state measured by task-2; the fix **not re-measured this run** — owner's clean-`main` verification, cited as reported |
| Login / forms | `works` | task-2, pane `%541`, using a **public demo** credential printed on the page itself (`the-internet.herokuapp.com/login`, `tomsmith` / `SuperSecretPassword!`) — no real credential was touched. Snapshot enumerated the fields correctly (`@s textbox "Username"`, `@f textbox "Password"`, `@g button "Login"`), `tweb fill` set both, click submitted, URL moved `/login` → `/secure`. `/tmp/t2/login-success.png`, opened: the green `You logged into a secure area!` banner and the Secure Area page. | measured |
| Password / credential autofill | `missing` — honestly absent, not half-built | task-2. Nothing offered to save the password after a successful login: no prompt in the screenshot, `tmux capture-pane -p -t %541` returns zero non-blank lines, engine stderr carries no credential line. Nothing autofilled on revisit: after logging out and returning to `/login`, reading the fields directly gives `user="" pass=""`, and `/tmp/t2/login-revisit.png` (opened) shows both boxes empty — and the form uses proper `autocomplete=username` / `current-password`, so this is not the page's fault. The store does not exist at all: the profile at `~/Library/Application Support/tweb-electron` (1.0 GB) has Cookies, Local Storage, IndexedDB and Service Worker but **no `Login Data` and no `Web Data`** — the Chromium files that hold saved passwords and autofill data. Because cookies do persist, existing sessions survive; the gap bites only at a fresh login. | measured |
| Print — save as PDF | `broken` at HEAD `947891b` — wedges the renderer; `works` since #30 | task-2's original reproduction at HEAD is retained below: no print handler existed, so `window.print()` fell through to Chromium's invisible native dialog and wedged the renderer. #30 intercepts it in the top frame and dynamically created iframes, writes a real PDF to `~/Downloads`, and labels the action honestly as save-as-PDF. Full before/after evidence is §6.2–§6.3. | HEAD defect measured twice by task-2 and independently replicated by task-4; #30 fix measured in real panes before merge |
| Print — actual paper via `lpr` | `works` in this run's working tree **for the measured queue hand-off**; physical paper output **not observed and not claimed** | task-2 added opt-in normal-mode chord `gp`; Ctrl-P and page `window.print()` stay unchanged as save-as-PDF. `gp` runs the same `printToPDF` path, writes and reports the PDF **first**, then asynchronously `execFile("lpr", [absolutePdfPath], {timeout:15000})` — no shell, paths with spaces remain one argv item, a hung queue becomes an explicit failure. **Control:** real pane `%630`, Ctrl-P → `~/Downloads/PAGE ONE.pdf`, no CUPS job. **No-printer shape:** panes `%630`/`%632`, real macOS `lpr` with `PRINTER=tweb-no-such-printer` → PDF lands first, then red `no printer configured · PDF in ~/Downloads`; `lpstat -o` empty before/after; screenshot opened and badge fits. **Successful hand-off:** pane `%631`, fake `lpr` at the *final boundary* records exactly one argv line `/Users/gavin.jeong/Downloads/PAGE ONE (3).pdf`; file existed at callback time, 55,777 bytes, mode 0600; engine log order is shortcut → download completed → queued; screenshot opened with green sent-to-printer badge. **Real CUPS acceptance, explicitly not TWeb evidence:** task-2 used `lp -H hold` for a tiny probe, got Canon request id 21, then cancelled it without printing — this proves the machine's queue accepts jobs, not that TWeb produced paper. | measured by task-2 in real panes, engine app verified as workspace tree, real tmux key path. Successful final `lpr` boundary substituted to avoid printing on the owner's printer. Physical ink/paper **unmeasured**; a machine with literally no CUPS subsystem unavailable; ENOENT unit-tested, no-usable-default measured with real `lpr` by overriding `PRINTER` |
| Extensions | `missing` at HEAD `947891b`; **merged in #34** — partially works, and passes real-pane acceptance for uBlock Origin Lite on both a causal local fixture and a remote ad-block test page | At HEAD: no load path, empty repo-root directory, false doctor claim. **Current engine boundary:** MV3 workers/content scripts/dNR work; static rulesets do not auto-enable; MV2 `webRequest` is absent; popup-only has neither toolbar nor `chrome.action`. **Local real-pane causal test:** uBOL pane `%640`, both ad URLs absent from origin, `ad1=0 ad2=0`, control image 300; empty-extension control `%626`, both ads reach origin/render 300. Both screenshots opened. **Remote corroboration:** `https://canyoublockit.com/extreme-test/`, control `%641` → 99 resources / 7 iframes / 54 scripts; uBOL `%642` → 67 / 1 / 51: 32 fewer loads (32.3%), 6/7 iframes removed (85.7%), screenshots opened and non-blank. Local remains stronger causal evidence because its exact expected pattern was derived from EasyList and the server proves which URLs never arrived. **Partial limits:** cosmetic/scriptlets unmeasured and `userScripts` absent; popup/dashboard unreachable; concurrent worker ownership constrains updates. | task-1, actual `tweb __pane` harness, workspace app confirmed, hidden/offscreen/no chrome. Unmodified uBOL source; adapter is versioned runtime copy, source sha256 unchanged. Earlier "profile-level blocker" retracted: full copy of owner's profile blocks; actual causes were bounded-startup race and cross-process scope ownership. Live profile read-only; destructive isolation on copies only. Full evidence §6.7 |
| Bookmarks | `missing` in code — and the shipped CLI command for it is `broken` | task-2. `bookmark` appears nowhere in `electron/` or `crates/`; the only two mentions are documents making promises (`README.md:20` "Chrome profile bootstrap: extensions, bookmarks and general site state are imported policy-aware", `DESIGN.md:1346` `\| Bookmarks \| imported \| a snapshot import \|`). task-2 **ran** the command the README points at, against the owner's real Chrome profile (`~/Library/Application Support/Google/Chrome/Default/Bookmarks` exists on this machine): `tweb profile bootstrap ~/Library/Application\ Support/Google/Chrome/Default` → `Error: command not yet implemented: Profile { action: Bootstrap { source: "…" } }`. Likewise `tweb profile list` → `Error: command not yet implemented: Profile { action: List }`. The subcommand is shipped in the CLI, appears in `tweb --help`, accepts its argument, and then admits it does nothing. Same shape elsewhere: `tweb resource list` → `command not yet implemented`. | measured — run against the real profile path, exact error captured |
| History | `works` — end to end, and arguably better than Chrome | task-1, pane `%543`, real key path. `g` then `h` → `diag page.mode='history' detail='1/343'`: a real store of 343 visits accumulated from this machine's actual use, not a stub. `/tmp/t1web/history.png`, opened: *Search all history* box, `343 visits`, a `Today` day-group header, per-row timestamp + title + full URL, keyboard legend `↑/↓ move · Enter open · Shift-Enter new tab · Ctrl-D delete · Esc close`, scrollbar. Search works: typing `third` narrowed to `1 visit`, detail `1/343` → `1/1`, showing only `…/pages/third.html`. Open works: Enter on that row → `location.pathname='/pages/third.html'`, `h1='THIRD PAGE'`, overlay closed. Filtering is server-side over the whole file by design (`main.cjs:2636`), so search covers all 343 rather than a rendered slice. | measured |
| Find-in-page | `broken` at HEAD `947891b` — the bar opened, accepted typing, and found nothing; **fixed in #31**, with one named residual path (§6.6) | task-1, live pane `%543`, engine app `/Users/gavin.jeong/src/keyolk/tweb/electron`, keys via `tmux send-keys`. What looked right: `/` renders a Chrome-styled *Find in page* bar top-right (`/tmp/t1web/find-visible.png`, opened — the bar is there with the query in it), `diag` shows `page.mode=search`, and the engine log shows `tweb: native shortcut find` once per keystroke, so preload→main IPC is intact and `contents.findInPage(query, …)` at `electron/main.cjs:2660` is genuinely called. What was broken: the `found-in-page` event registered at `electron/main.cjs:3476` never fired. Proof rather than inference — preload's handler (`electron/preload.cjs:3200`) writes `0/0` into the result span on *any* result including zero matches; polling that span once a second for 8 seconds with a query that is on the page gives `{t:1,res:""}` … `{t:8,res:""}`: stays empty, never even `0/0`. Consequences, all measured: no match counter, nothing highlighted (`getSelection()` stays `''`), and Enter closed the bar without scrolling to the match (`ZQXWVU-NEEDLE-9271` placed 3000px down: `scrollY` 0 before, 0 after, bar gone, selection empty). Control case ruled out both the harness and the text: `window.find('UNIQUEMARKERALPHA')` in the same pane at the same moment returns `{"windowFind":true,"sel":"UNIQUEMARKERALPHA"}`. **What #31 changed, and the cause was not the one this row inferred:** it was never offscreen focus. Electron's `FindInPageOptions.findNext` means "this request continues an open session", not "go to the next match", so every fresh query went out as a follow-up and Chromium emitted no `found-in-page` at all. Session state now lives in `electron/find-session.cjs`. The project owner verified this personally on clean merged `main`: a word appearing twice shows the counter `1/2`, the active match in orange and the rest in yellow, and on a tall page Enter advances and scrolls (`scrollY` 19 → 2043). **Residual, named in #31 itself, and closed in #35:** reopening the bar with `/` and pressing Enter *without retyping* used to lose the highlight; the stale query is now cleared when no result has landed, so the reopen keeps the match and a genuinely absent term reports absent. | HEAD `947891b` state measured by task-1; the fix **not re-measured this run** — owner's clean-`main` verification, cited as reported |
| Back / forward | `works` (with a caveat that is not the same as broken) at HEAD `947891b`; **`M-Left` / `M-Right` / `BSpace` bound in this run's working tree, and the binding is safe in a text field only after task-2 found and fixed a defect in it** (§6.7) | task-1, live pane `%543`, engine app `/Users/gavin.jeong/src/keyolk/tweb/electron`, driven by `tmux send-keys` (the real key path, not the agent socket). `H`: `/pages/second.html` → `/pages/index.html`. `L`: `/pages/index.html` → `/pages/second.html`. Both fire, and fast. `BSpace`, `M-Left`, `M-Right`: URL unchanged — unbound, and they failed **silently** (no beep, no toast, no hint). **What this run changed:** the project owner wrote a preload-only binding and verified it on pane `%622` (the keys were reaching the preload all along and were being dropped by its `if (event.ctrlKey \|\| event.metaKey \|\| event.altKey) return;` modifier guard; the new block sits above it). **The defect task-2 then found, by verifying independently rather than confirming:** `Backspace` carried a `!eventIsEditable(event)` guard and **`M-Left`/`M-Right` did not.** Measured on pane `%624`, reproduced twice, focus taken by the real key path — with the caret in a field holding `KEEPTHIS`, `M-Left` navigated away and the typed text was gone. That is the same destroy-work case the Backspace guard exists for, and it is Chrome's actual behaviour rather than defensive extra: in Chrome, Alt-arrow inside a field moves the caret one word, it does not navigate. task-2 added the guard to the Alt-arrow branch. **After the fix, all measured on the real key path:** nothing focused → `M-Left` `/second.html`→`/index.html`, `M-Right` `/index.html`→`/second.html`, `BSpace` `/second.html`→`/index.html`, with `H`/`L` as the control in the same pane; field focused → `M-Left` and `M-Right` leave the URL and the value untouched, and `BSpace` deletes a character (`KEEPTHIS`→`KEEPTHI`, selection 8→7) without navigating. task-2 opened the screenshot and confirms a real page, not a blank one. **Caveat task-2 states and does not paper over:** `M-Left` in a field is now *inert* rather than *useful* — `selectionStart` stayed 0, so Chrome's word-left caret motion is **not** implemented and is not being claimed. Not-destructive is what was verified. | HEAD state measured by task-1 (previous run); the binding measured by the project owner on pane `%622`, where author and verifier were the same person; the missing-guard defect and the post-fix behaviour measured **independently** by task-2 on pane `%624`, engine app verified as the workspace tree, control (`H`/`L`) run first through the same harness |
| Middle-click | `worse-than-Chrome` at HEAD `947891b` — it opens a tab, then steals your place; `works` in the working tree (§6.6) | task-1, pane `%543`, **real mouse path**: genuine SGR-1006 mouse bytes injected with `tmux send-keys -H`, exactly what a physical click produces (not `tweb click`, not the agent socket). Middle press/release (`cb=1`) on `GO TO SECOND`: tabs before `1`, after `[(0, active=False, '…/index.html'), (1, active=True, '…/second.html')]`. A new tab is created — and it is **active**, deactivating the one you were reading. Chrome's middle-click opens in the background, which is the entire point of the gesture: middle-click six links off a results page, keep reading, work through them later. Here the first click yanks you off the page, so clicks two through six land on the wrong document. Cause: `main.cjs:3443` `setWindowOpenHandler` calls `createTab(target, true)` — the second arg is *activate* — and middle-click shares that path with `window.open`. Electron supplies `details.disposition === 'background-tab'`, which Chrome uses to differentiate. | measured |
| Right-click / context menu | `works` — fully, and context-aware | task-1, pane `%543`, real SGR-1006 mouse bytes via `tmux send-keys -H` (`cb=2` press + release), surface held open. `/tmp/t1web/ctxmenu.png`, opened: a Chrome-looking dark menu rendered **at the pointer** with Chrome's own grouping and order — `Copy`, `Search for "GO TO SECOND"` (picking up the link text, quoted), separator, `Open link in new tab`, `Open link in this tab`, `Save link as`, `Copy link address`. Not a coordinates-only stub: it is built from Chromium's own context-menu params (`main.cjs:3453` → `showBrowserContextMenu` at `3340`, built in `context-menu.cjs`), so editable fields get Undo/Redo/Cut/Copy/Paste/Paste-without-formatting/Select-all, a selection gets Copy + Search, images get their own group. The items execute: a real left click on `Open link in new tab` took tabs from `1` to `[(0, active=False, '…/index.html'), (1, active=True, '…/second.html')]`. Backdrop dismissal verified — a click outside removed the menu and did nothing else. | measured |
| Copy image | `worse-than-Chrome` — it is a region capture, not an image copy | task-1, pane `%543`, real SGR mouse, surface held. The happy case works: right-clicking a 120×120 red PNG gives the image-specific menu (`/tmp/t1web/ctx-img2.png`, opened: `Open image in new tab / Save image as / Copy image / Copy image address`, then `Back / Forward` with Forward correctly greyed); `Copy image` puts a genuine multi-format bitmap on the **system** pasteboard — `osascript 'clipboard info'` → `«class PNGf» 3672, TIFF picture 153180, «class BMP », GIF, JPEG…`, with a text sentinel placed beforehand gone, so the write really happened. Writing `«class PNGf»` to `/tmp/t1web/clip2.png` gives a valid 120×120 PNG which task-1 opened: clean solid red square. The caveat, hit by accident before the success case: `main.cjs:2677` `copy-image` takes x/y/width/height and calls `contents.capturePage(rect)` — it re-renders the pixels under the element rather than copying the decoded resource (comment at `:2688`: *in offscreen Chromium `copyImageAt` may not update the pasteboard*). The first attempt captured `/tmp/t1web/clip.png` at 240×208 containing the red square **plus** surrounding white page **plus** the top of a text input below, because the image was only partly scrolled into view. So an image taller than the viewport, or partly scrolled off, copies clipped and contaminated, silently; the copy is at rendered rather than natural size (a 4000px photo shown at 300px copies as 300px); an animated GIF copies as one frame; a transparent PNG copies composited over the page background. | measured |
| Korean IME | `works` (one caveat, stated) | task-1, pane `%543`, `tmux send-keys` (real key path). Text lands byte-exact: `안녕하세요` → `input.value='안녕하세요' len=5 codepoints=[c548,b155,d558,c138,c694]` — no mojibake, no doubling, no dropped syllable. Mixed script `한글 렌더 테스트 abc123` round-trips identically with ASCII and spaces preserved. It renders: `/tmp/t1web/korean2.png`, opened — the string is drawn correctly with the caret after `3`, no tofu, no clipped glyphs, and the wider hangul cells did not break the grid. ASCII control through the same harness: `hello` → `hello` with per-key KEYDOWN+INPUT. The absent `compositionupdate` events are **correct**, not a defect: macOS composes hangul in the terminal emulator, so TWeb receives already-committed UTF-8 and there are no intermediate jamo to observe. **Caveat task-1 states honestly:** they injected finished UTF-8; a live macOS 2-set hangul IME with per-jamo backspace inside an open composition was **not** exercised. This row validates the README's previously-unvalidated claim only to the extent measured. | measured, with one named unmeasured sub-case |
| Popups / `window.open` | `works` for ordinary popups; `worse-than-Chrome` for opener-coupled auth | task-1, pane `%543`. `window.open('…/popup.html','_blank','width=400,height=300')` from page JS: tabs before `1 ['…/index.html']`, after `2 [(0, active=False, '…/index.html'), (1, active=True, '…/popup.html')]`. `/tmp/t1web/popup.png`, opened: `POPUP WINDOW OPENED` rendered, indicator bottom-right `2/2`. The popup becomes a real TWeb tab and is focused — `main.cjs:3443` `setWindowOpenHandler` denies the native window and calls `createTab(target, true)`, deliberately, because Electron would otherwise surface the macOS OffScreenView placeholder as a real OS window floating outside the terminal. **The caveat, measured:** `window.open()` returns `null` and the child's `window.opener` is `null`, forced by `action:'deny'`. So OAuth/SSO popup flows that `postMessage` back to `window.opener` or that poll the returned handle will hang — the popup authenticates and the parent never learns it succeeded — `window.close()` from the child cannot be coordinated, and any `if (!win) …` check shows a false "popup blocked" warning even though the tab did open. | measured |
| Video with sound | `works` — and the cross-pane audio arbitration is better than Chrome | task-1, two independent panes `%543` and `%544`, each its own `tweb __pane` + Electron, playing a real 30s VP8+Opus webm (ffmpeg sine 440 Hz + testsrc) served locally. Video plays: `t=4.45` → `t=7.48` over three seconds, `paused=false`, `readyState=4`, `duration=30.008`. Audio is real, not just unmuted flags: `diag audio` → `{audible:true, muted:false, mutedByOther:false, owner:'%543'}`; a genuine AudioService child process pid 26199 with PPID 55459 = task-1's engine, so the OS-level audio pipeline is open; engine log `tweb: media playing audible=true muted=false`; claim file `/tmp/tweb-502/audio-owner.json` → `{"pane":"%543","pid":55459,…}`. **Honest limit task-1 states:** they could not verify sound left the physical speakers. What is measured is that Chromium reports the contents as currently audible — decoded output reaching the audio service, not merely a flag. | measured, except physical speaker output |
| Session survival across restart | `works` single-pane-per-window; `broken` at HEAD `947891b` — silent tab loss — with two browser panes in one tmux window; **fixed in #31** by a per-window slot (§6.6) | task-1, both halves measured. **Happy path:** 4 tabs open in `%543` (index/second/third/`https://example.com`, active=3); on disk before the kill, `~/Library/Application Support/tweb-electron/window-sessions/476884a38cd209a6abd0df13.json` = `{"version":1,"activeIndex":3,"tabs":[{index.html,zoom:0.8},{second.html,…},{third.html,…},{example.com,…}]}`. `tmux kill-pane %543` → engine pid 55459 gone (confirmed by `ps`). Respawned in the same tmux window with **no URL** — which is what sets restore (`options=PaneOptions{… restore_session: true}`; passing a URL skips restore, `cli/lib.rs:609 restore_session: url.is_none()`). All four tabs came back, in order, tab 3 active, and `https://example.com` had really loaded (`title='Example Domain'`, `bodyLen=126`). Per-tab zoom persisted. **The defect, which bit task-1 for real and unprompted during that run:** the session key was `sha256('v2', tmux socket, session name, WINDOW INDEX)` (`window-session.cjs windowSessionKeys()`) — **the pane id was not in the key**. task-2 was driving its own pane in the same tmux window `@19`; on task-1's second respawn the same file had been overwritten to `{"version":1,"activeIndex":0,"tabs":[{"url":"http://127.0.0.1:8731/","zoom":0.8}]}` — task-2's page. Four tabs gone, and the restored pane came up showing a stranger's tab. task-1 then **proved the key structurally rather than leaving it inferred**: recomputing `sha256('v2' \0 socket \0 session \0 window_index)[:24]` in a standalone script reproduces the filenames on disk — `projects` window 8 → `476884a38cd209a6abd0df13`, `dashboard` window 2 → `1899904e0561d156bb1c9a34`, `dashboard` window 6 → `01f02a4500b7ebbf9b747d4e`. **What #31 changed:** the key carries a per-window *slot* — each engine claims the lowest slot no live engine holds, which survives a respawn (unlike a pane id, which tmux reassigns and reuses) and is distinct between concurrent panes. The project owner checked the migration question against the real profile: **slot 0 hashes byte-for-byte as the old key**, and `dashboard@2`, `dashboard@6`, `projects@8` all reproduce their existing filenames, so nothing on disk needs migrating. Only a second concurrent pane in a window gets a new file. | HEAD `947891b` state measured by task-1, both halves, plus independent derivation of the key; the fix **not re-measured this run** — owner's clean-`main` verification against the real profile, cited as reported |
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

That measurement was made in run `s1786880826401-2`; the hash of today's
installed binary was **not** re-established. The rule that survives is narrower:
a fix in workspace `electron/` is live immediately in a workspace-launched pane,
and reaches `~/.local/bin/tweb` only after an install that embeds it. Whether the
owner has reinstalled since #30/#31 is **unmeasured either way**.

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

Six things on this board were broken rather than absent at HEAD `947891b`. They
are listed in severity order, by what a Chrome refugee hits and how bad it is
when they do. **Five of the six are now closed** — four merged as #30, and
find-in-page, the PDF frame and the session-key collision in #31 (the PDF one
partially). Each carries a note saying so, and each is kept rather than deleted,
because the *shape* of the failures is the argument this section is making, and
because a reader arriving from an older build needs to recognise what they are
looking at.

### 2.1 `window.print()` wedges the renderer — permanently, and silently

> **Fixed and merged as #30.** Verified before merge by driving task-2's exact
> sequence, in the top frame *and* in a dynamically created iframe. The verdict
> below describes HEAD `947891b`.


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

> **Built and merged as #30** — a path-entry chooser with tab completion,
> verified before merge by reading the uploaded bytes back byte-identical from
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

> **Fixed and merged as #31**, and verified by the project owner personally on
> clean merged `main`: a word appearing twice shows `1/2` with the active match
> in orange, and Enter advances and scrolls. One path is still broken and is
> named in #31 itself — reopening the bar with `/` and pressing Enter without
> retyping loses the highlight. The verdict below describes HEAD `947891b`.
>
> **The diagnosis in this section was wrong**, and that matters more than the
> fix. It reads below as another offscreen-focus instance; the actual cause was
> an inverted flag — `findNext` means "continues an open session", not "next
> match" — and it would have failed identically in a normal window. It is left
> standing rather than rewritten because a plausible-but-wrong root cause that
> survived a whole run of measurement is worth being able to recognise again.

Cmd+F is muscle memory a dozen times a day. Here `/` opens a Chrome-styled bar,
the query goes in, `contents.findInPage()` is genuinely called — and the
`found-in-page` event never fires, so there is no counter, no highlight, and
Enter closes the bar without scrolling to the match. Every visible sign says it
is working. task-1's control (`window.find()` succeeds on the same text in the
same pane at the same moment) rules out both the harness and the page.

### 2.4 PDF: a perfect Chrome viewer you cannot scroll

> **Partially fixed and merged as #31.** The document scrolls — the owner
> verified three PageDown presses producing three distinct md5s on clean merged
> `main`. **The viewer's own toolbar is still unreachable**: its download and
> print buttons, its page box and its own find. So "trapped on page 1" below is
> no longer true; "the toolbar is drawn and inert" still is.

Chromium's full PDF viewer is present and paints beautifully — toolbar, `1 / 5`
page indicator, thumbnail sidebar, download and print icons. None of it is
reachable. Both input paths leave the rendered bytes identical. A user opens a
bank statement, reads page one, and cannot get to page two of five. The toolbar
advertising download, print, and page navigation is fully drawn and entirely
inert. Note this contradicts the grep survey's `PDF: none` — present-but-broken
is a different and worse statement than absent.

### 2.5 Session loss when two browser panes share a tmux window

> **Fixed and merged as #31**, by keying on a per-window *slot* rather than the
> pane id. The owner checked the migration question against the real profile:
> slot 0 hashes byte-for-byte as the old key, so nothing on disk was abandoned.
> The verdict below describes HEAD `947891b`.

The session store is keyed by tmux **window index**, with the pane id absent
from the key — task-1 proved this by recomputing the hash and matching the
filenames on disk, so it is structural rather than a race. Two TWeb panes in one
window share one session slot and the last to exit silently erases the other's
tabs. This project's entire pitch encourages side-by-side panes, so the
configuration that triggers it is the one the tool is for. task-1 lost four tabs
to it during run `s1786880826401-2` without trying to.

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

**All four are now closed** — print and the file chooser in #30, find-in-page
and the PDF frame in #31 — but the hypothesis they were closed by was **half
wrong, and the half that was wrong is the more instructive one.**

- Print, the file chooser and the PDF frame did fit the class, and were closed
  the way it predicted: intercept the path before Chromium's handler runs, in the
  world where the page actually lives.
- **Find-in-page did not.** #31 found the cause was an inverted flag —
  `FindInPageOptions.findNext` means "this request continues an open session",
  not "go to the next match", so every fresh query went out as a follow-up and
  Chromium emitted no event at all. It would have failed identically in a normal
  visible window. Offscreen rendering had nothing to do with it.

That is worth keeping rather than tidying away. A unifying explanation that fits
three out of four cases is exactly the kind that survives a run of careful
measurement and then sends the next person looking in the wrong place. The
document asserted the class strongly enough that §7 recommended "finish the
class" — and the fix for the top item was somewhere else entirely.

---

## 3. Policy decision log

Every user-visible policy decision made during these runs, with its reasoning.
Decisions are stated here rather than picked silently in a diff. Decisions 1–8
are task-2's and 9–14 task-4's, both from run `s1786880826401-2`; 15 onward are
from this run, `s1786972005513-4`.

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

### 3.3 Decisions from this run (`s1786972005513-4`)

15. **`M-Left` / `M-Right` / `BSpace` are bound; `Cmd+[` / `Cmd+]` are not, and
    that is permanent rather than pending.** A terminal cannot deliver `Cmd` to
    the page unless bypass mode is on, so the binding would work *sometimes* —
    which is worse than not existing, because an intermittent shortcut teaches
    the wrong reflex. The regression test asserts `Cmd` is **absent**, so nobody
    "completes the set" later without reading this.
16. **Backspace-navigates-back ships only with the editable guard, and the test
    pins the two together.** Backspace is the one Chrome reflex on this board
    that can destroy work: pressed inside a half-filled form it leaves the page
    and takes what was typed with it. The binding is guarded by
    `!eventIsEditable(event)`, and the regression test asserts the binding *and*
    the guard in one assertion rather than two, because an edit that keeps one
    and drops the other is the failure mode the test exists for. The assertion
    lives in the Electron-only tests rather than the shared `assertPreload`,
    because the Tauri preload is a separate file that does not carry these
    bindings. task-2's independent verification then found the same guard was
    missing from the Alt-arrow branch — a separate test now pins that because
    the binding survived while the guard was absent.
17. **Paper printing is opt-in `gp`; Ctrl-P and page `window.print()` remain
    save-as-PDF.** Save-as-PDF is the common case and #30 labels it honestly.
    Paper is an extra tier, never a surprising side effect of an existing print
    call. The PDF is written and reported first; then `lpr` runs asynchronously,
    with a 15-second timeout and an explicit green/red result. A failed queue can
    never take away the PDF. `execFile` receives the absolute path as one argv
    item — no shell — because filenames with spaces are ordinary here.
18. **A printer error is classified only as specifically as the real message
    permits.** task-2 captured macOS CUPS failures rather than writing regexes
    from docs. `lpr -P nonexistent` says only `No such file or directory`; an
    early classifier would have called that "unknown destination" and lied.
    Messages that actually say `destination that does not exist` become
    `no printer configured`; the ambiguous bare message is quoted as-is, with
    `PDF saved`, rather than guessed.

19. **Extension provenance: a TWeb-managed source directory of unpacked
    extensions. Never load from the Chrome profile in place; do not make CRX
    download part of this first product.** Default source is
    `<userData>/extensions`, overrideable by `TWEB_EXTENSIONS_DIR` for controlled
    runs. The owner's Chrome profile is another application's live mutable
    database; loading from it creates cross-process ownership, update races, and
    a real chance of damaging the browser TWeb is meant to replace. CRX download
    adds store protocol, signature/update and provenance policy before the
    measured runtime boundary is stable, and Chrome Web Store CRXs are MV3 now
    anyway — it would not rescue permanently impossible **webRequest-based**
    MV2 blockers. Unpacked
    source makes every byte inspectable and lets the user decide what enters the
    browser. **uBO Lite source is still treated as read-only:** the compatibility
    adapter writes a versioned runtime copy under `.tweb-runtime`; source sha256
    before and after the acceptance run was identical (`cmp rc=0`).
20. **Extension load order is deterministic.** Immediate child directories with
    a `manifest.json` are sorted before load, because dNR priority ties can be
    decided by extension load order; filesystem whim would make blocking
    irreproducible.
21. **A worker-start failure never unloads the extension.** It has two measured
    meanings Electron does not distinguish: the worker genuinely failed, or a
    different engine sharing the profile owns the scope while its dNR rules
    already apply here. task-1 measured the second engine still blocking with no
    worker listed. Removing on that signal disarms a blocker that is working.
    Keep it loaded, surface the ambiguity in the engine log, and tell the user to
    restart all panes together if blocking is inactive.

*(The misleading empty repo-root `extension/` directory was removed; §6.7
records why there is intentionally no Git deletion.)*

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
7. **Full Chrome extension API support.** Electron supports a subset, and "full
   extension support" is not achievable and should not be promised.

   **Correction — this row previously said `declarativeNetRequest` works, "which
   is what an ad blocker needs". That sentence was assumed, and the truth is
   narrower and stranger than either it or the first attempt to correct it.**
   The measurement went through three states in this run, all recorded because
   the sequence is the lesson:

   1. *Blanket negative (owner, radio seq 2).* MV3 dNR and MV2 `webRequest` both
     let a blocked URL through. **Superseded** — the probe had a
     rejection-handling bug that produced false `ALLOWED` readings.
   2. *Narrower negative (owner, seq 3).* Re-run cleanly: extensions load, MV3
     service workers run, content scripts inject and modify the DOM offscreen —
     but requests still passed, in an offscreen window *and* a normal
     `BrowserWindow`. Control: Electron's own
     `session.webRequest.onBeforeRequest` with `cancel: true` blocked correctly,
     so the harness was sound. **Also superseded** — it stopped at "traffic
     passes" and concluded the capability was absent.
   3. *What is actually true (owner seq 13, and task-1 independently, seq 12).*
     **The dNR enforcement path works. Manifest-declared static rulesets never
     arm.** Asked from the extension's own service worker,
     `getEnabledRulesets()` returns `[]` on load. Install the same rule at
     runtime — `updateDynamicRules`, or `updateEnabledRulesets` — and the request
     is genuinely blocked, with the same server-hit signature as Electron's own
     cancel.

   The permanent-limitation entry that survives is therefore **not** "blocking is
   impossible", and it is not even "static rulesets are inert". It is: an
   extension that ships its filters as a static ruleset will **not arm them by
   the manifest alone** — Electron 43 ignores the
   `declarative_net_request.rule_resources` key — so it depends entirely on the
   extension calling `updateEnabledRulesets` itself during init, which requires
   its service worker to survive startup on an API surface that is missing
   several things Chrome provides. When that fails, the result is an extension
   that loads, reports healthy and blocks nothing: the silent-failure shape this
   project refuses to ship. When it succeeds — task-1 got real uBlock Origin Lite
   to this state with a small stub shim — blocking genuinely works. §7
   Recommendation 1 carries what is measured and what is not.

   Separately and more permanently: **`chrome.webRequest` is not exposed to
   extensions at all** under Electron 43. Two independent measurements agree, and
   both went past the symptom to the cause: task-1 enumerated the API surface
   from inside a service worker (`chrome.webRequest = false`,
   `chrome.webNavigation = false`), and the owner asked an MV2 extension's own
   background page (`apiPresent: false`, and the
   `chrome.webRequest.onBeforeRequest.addListener(…)` call throws on load, so the
   listener never registers). Note the asymmetry, which is easy to misread:
   Electron's **own** `session.webRequest` works — that was the control that
   blocked correctly. The main process has it; extensions do not. Every MV2
   blocker is built on it, so **uBlock Origin proper cannot work here by any
   amount of loader cleverness** — this is not a bug to route around.

   *Provenance: the owner's own measurements across eight probes, each state
   superseding the last (radio seq 2 → 3 → 13 → 15), handed to task-1 for
   independent re-run precisely because a negative result deserves a second pair
   of hands. task-1 reproduced the static-ruleset failure, the dynamic-rule
   success and the absent `webRequest` on its own harness with server-side hit
   counts as the primary signal. The two agree. What each real blocker does is in
   §1's extensions row and §6.7.*

   **The method that produced both corrections is worth more than either
   finding.** Twice in one run a traffic test said "blocking does not work" and
   twice the real answer was somewhere else, with opposite fixes: a static
   ruleset that never registered, and an API that was never exposed. What
   separated them was asking the component what state it believed it was in —
   `getEnabledRulesets()` → `[]`, `apiPresent` → `false` — before concluding the
   capability was absent.

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

> **§6.1 to §6.5 are history.** They describe the working tree of run
> `s1786880826401-2`, which has since been reviewed and merged as **#30**. They
> are kept because the *how it was verified* is the part worth reusing, and
> because §6.3's sandboxed-preload lesson is the single most transferable thing
> either run produced. **§6.6 is the live ledger** of which verdicts moved and
> when, and **§6.7 is this run's working tree** — the part that is still
> uncommitted and is this run's deliverable.

Nothing was committed, pushed, or opened as a PR in either run.
`crates/tweb-cli/src/doctor.rs` and `crates/tweb-pane/src/resize.rs` have been
modified by a different session throughout both runs and no peer has touched
either file.

### 6.1 task-3 — documents only, no code *(run `s1786880826401-2`, merged as #30)*

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

### 6.2 task-4 — runtime *(run `s1786880826401-2`, merged as #30)*

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

### 6.4 `make check` *(run `s1786880826401-2`, pre-merge)*

**End of that run: `rc=0`.** Confirmed twice against the combined tree — once by
task-4 after its final edit, and once by that run's synthesis worker afterwards,
so the figure below is not a peer's word for the state of a tree they were still
editing. This run's own `make check` is in §6.7.

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

### 6.5 Working tree, file by file *(run `s1786880826401-2`, merged as #30)*

What that run's reviewer saw in the diff, kept for provenance. This run's
working tree is §6.7.

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

Four rows in §1 described HEAD `947891b` and were superseded by the working tree
of run `s1786880826401-2`, now merged as #30. They are kept rather than silently
rewritten because the original measurements are the evidence for the defects,
and because a reader on an older embedded build needs to recognise them. Whether
the owner's current `~/.local/bin/tweb` predates #30 is **unmeasured** (§1's note
on engine app resolution).

| Capability | At HEAD `947891b` | In the working tree |
| --- | --- | --- |
| Print | `broken` (wedges the renderer) | `works` — save-as-PDF only, honestly labelled; not paper, not a preview |
| Uploads / file chooser | `broken` (looks present, does nothing) | `works` — drag-and-drop from Finder remains permanently impossible (§4) |
| Downloads — telling the user | `worse-than-Chrome` | `works` — badge with percentage, completion, failure, cancellation; `gd` list; absolute path |
| Middle-click | `worse-than-Chrome` (steals focus) | `works` — background tab, from task-1's diagnosis, verified with real SGR bytes; `window.open` still activates, control case checked |

Rows that did **not** move during that run: find-in-page, PDF frame inertness,
the per-window session-key collision, extensions, password manager, bookmarks.

**All three of the first group moved in #31**, which shipped after this section
was written. Recorded here rather than rewritten above, because the rows above
describe the state each was measured in:

| Capability | Before #31 | After #31 |
| --- | --- | --- |
| Find-in-page | `broken` — bar opens, finds nothing | `works` — counter, highlight, Enter advances and scrolls. One named residual: reopening with `/` and pressing Enter without retyping loses the highlight |
| PDF viewer | `broken` — renders, then ignores every key | `partially fixed` — the document scrolls on both key paths; the viewer's own toolbar stays unreachable |
| Session-key collision | `broken` — two panes in one window overwrite each other | `works` — per-window slot, and slot 0 hashes byte-for-byte as the old key, so nothing on disk needed migrating |

Still `missing`, and honestly so: password manager, bookmarks.

**Moved during this run (`s1786972005513-4`):**

| Capability | Before | After |
| --- | --- | --- |
| Back / forward muscle memory | `M-Left` / `M-Right` / `BSpace` unbound and silent | `works` — bound, and safe in a text field only after task-2 found the missing editable guard. Alt-arrow in a field is inert, not Chrome's word-left |
| Paper printing | `missing` — save-as-PDF only | `works` for the measured `lpr` queue hand-off under `gp`; **physical paper output unobserved and unclaimed** |
| `page.mode` hangul indicator | filed as "the indicator lies" | **not reproduced** — the indicator is accurate; restated as a discoverability gap, with the older observation left unreconciled |
| Extensions | `missing` in code | `partially works` — real uBlock Origin Lite blocks in a real hidden pane; MV2 **webRequest-based blockers** permanently impossible; content-script-only MV2 allowed; named limits remain (§6.7) |

### 6.7 This run: ergonomics merged as #32; extensions uncommitted *at the time of writing, merged as #34 since*

*(This section is kept in its original tense because it is the record of what was
true when the work was measured. Everything it describes as uncommitted has since
merged: #33, #34, #35. The measurements below are unchanged.)*

The run began with a no-commit/push/PR rule for **workers**. The project
operator had separate explicit session authorization (`gh_merge=allow`) and used
it to make an outward-facing split while workers continued: ergonomics was
squash-merged as **#32** (`4c7eafd`), so its completed work could ship without
being held by the profile-dependent extension blocker and so a future extension
PR could not look tested merely because unrelated real-pane checks passed.
**task-2 performed no git operation and obeyed its worker rule fully.** The
operator staged task-2's shared-file regions hunk-by-hunk, excluding task-1's
extension region. The local checkout remains on
`feat/chrome-muscle-memory-paper-print` at `4c7eafd`, with task-1's extension
work uncommitted on top, because switching local `main` would overwrite the
shared `main.cjs` hunk and the operator would not stash the protected
`doctor.rs` / `resize.rs` state.

The operator action was authorized but was not radioed before it changed the
shared checkout. That coordination failure produced a false "files disappeared"
alarm from task-3 (radio seq 35), retracted in full as soon as `git log` showed
the commit (seq 37). **No task-2 work was lost or overwritten, and task-2 did not
violate an instruction.** The internal `task-2-ergonomics.md` report was
preserved in the session scratchpad and deliberately not committed, following
the prior-run policy for worker reports.

*(Written by task-3, who wrote no code this run and drove no panes. Every runtime
claim here is a peer's or the project owner's measurement, attributed. Where a
source hedged, it is hedged here.)*

**Ergonomics — back/forward keys (`M-Left` / `M-Right` / `BSpace`): `works`,
after a defect was found in the first version.**

The binding was written by the **project owner**, not by a worker, and appeared
in the tree mid-run before the file-claim board covered it — task-2 found it
unclaimed, stopped rather than measuring against a possibly half-written file,
and asked on the radio. That was the right call and it is why the authorship
here is straight. task-2's contribution is the independent verification and the
fix below.

What independent verification bought, which is the argument for doing it: the
first version guarded `Backspace` with `!eventIsEditable(event)` and **did not
guard the Alt-arrows.** task-2 measured `M-Left` navigating away from a page with
the caret in a field holding `KEEPTHIS` — the page and the typed text gone in one
keystroke, which is exactly the destroy-work case the Backspace guard existed to
prevent. It is also simply wrong against Chrome, where Alt-arrow in a field moves
the caret one word rather than navigating. task-2 added the guard and pinned it
with a test **separate** from the existing Alt-arrow test, on the grounds that
the binding survived while the guard was missing — the shape a single combined
assertion would not have caught. Full measurements are in §1's back/forward row,
including the caveat that `M-Left` in a field is now *inert* rather than
Chrome-equivalent.

**Ergonomics — paper printing via `lpr`: `works` for the measured hand-off;
physical paper output was not observed and is not claimed.**

Task-2 added an opt-in normal-mode chord `gp`. Ctrl-P and page `window.print()`
are unchanged: save a PDF in `~/Downloads` and label it as a PDF. `gp` invokes a
separate `print-paper` action, calls the same `printToPDF` path, writes and
reports the PDF first, then asynchronously runs
`execFile("lpr", [absolutePdfPath], {timeout:15000})`. A queue failure cannot take
the PDF away, there is no shell, paths with spaces stay one argv item, and a hung
queue becomes an explicit failure rather than a forever-wait.

Three real-pane measurements, engine app verified, trigger through real tmux
keys:

1. **Control:** pane `%630`, Ctrl-P → `~/Downloads/PAGE ONE.pdf`, engine log says
   download completed, no CUPS job. Existing save-as-PDF path unchanged.
2. **No usable printer:** panes `%630`/`%632`, real macOS `lpr` with
   `PRINTER=tweb-no-such-printer` (so the owner's real Canon is never touched) →
   PDF lands first, then red `no printer configured · PDF in ~/Downloads`;
   `lpstat -o` empty before/after; screenshot opened and badge fits.
3. **Successful hand-off:** pane `%631`, fake `lpr` at the final boundary records
   exactly one argv line, `/Users/gavin.jeong/Downloads/PAGE ONE (3).pdf`; the
   file existed at callback time, 55,777 bytes, mode 0600; engine log order is
   shortcut → download completed → queued; screenshot opened with the green
   queued-for-printer badge. Everything above the final process boundary is
   production code. The substitution prevented a page from coming out of the
   owner's real printer.

A final review found a timer race after #32: the PDF completion path's older
badge timer could clear the later paper badge around four seconds, before its
own six-second lifetime. task-2's follow-up clears only that existing transfer
timer in the `lpr` callback before posting the paper result, and tightens `sent
to printer` to `queued for printer` — exit 0 proves queue acceptance, never
physical output. The project operator committed that follow-up separately as `b3d984d` (*Keep
paper-print results visible for their full hold*). task-2 reverified on fresh pane
`%639`; the screenshot at **5.8 seconds** still shows the green queued badge.

A separate held-and-cancelled real CUPS probe proves this machine's queue accepts
jobs; it is **not** TWeb evidence and is not used as such. Honest boundary:
physical paper output unmeasured; a machine with literally no CUPS subsystem was
unavailable; ENOENT is unit-tested, and no-usable-default is measured with real
`lpr` by overriding `PRINTER`.

**Ergonomics — the `page.mode` hangul indicator: NOT REPRODUCED, and the row it
was filed under appears to be wrong.**

§7 previously carried this as a cosmetic one-line fix: typing hangul with no
field focused flips the indicator to `insert` and it lies, because the page still
responds to normal-mode keys. task-2 could not reproduce the lying half.

Measured on pane `%624`, engine app verified as the workspace tree, real key path,
three identical trials each carrying **its own in-trial control**: after `ㅑ` the
mode reads `insert` and `jjjj` scrolls `0` → `0`; Escape then the same four `j`
presses through the same harness gives `0` → `360`, every trial. So the indicator
is telling the truth — the page really is in insert mode — and the negative is
not a dead-harness artefact.

task-2 then went past the symptom to the mechanism, which is what makes this
worth writing down rather than just closing: `preload.cjs` carries a
`koreanLangmap` that maps hangul jamo to the Latin letter on the **same physical
key**, deliberately, so a Korean user with the IME on can still drive TWeb. `ㅑ`
is the `i` key, and `i` enters insert mode. It is systematic, not one stray key —
task-2 mapped the row: `ㅐ`→`o` opens the omnibox, `ㅅ`→`t` opens it in new-tab
mode, `ㄴ`→`s` opens the scroll picker, `ㅎ`→`g` starts a pending-`g`, `ㅓ`→`j`
scrolls `0` → `90`. Every one is the correct command for the Latin letter on that
key. task-2 also opened the screenshot rather than trusting `diag`: the badge
names the mode *and* the way out.

**So the finding is not an indicator that lies. It is a discoverability gap** — a
Korean-IME user pressing `ㅑ` enters insert mode without being told that a vowel
was a command — and the fix for that is different and larger than the one-line
change the old text predicted.

**Unreconciled, and left visible rather than deleted:** task-1 filed the original
observation in the previous run, including `jjjj` scrolling `0` → `360` while the
indicator read `insert`. task-2 cannot reproduce it and has offered to re-run
task-1's exact keystrokes verbatim. One measurement does not outrank the other.
The likeliest explanation is that the original predates #31, but **that is a
hypothesis, not a finding** — nobody has tested it.

**Extensions — uBlock Origin Lite passes the real-pane acceptance bar; the
support is explicitly partial.**

Real pane `%640`, `tweb __pane` inside `tmux split-window`, engine app verified as
the workspace tree, hidden/offscreen/no browser chrome. Source: **unmodified**
uBlock Origin Lite 2026.812.1211 unpacked ZIP in the TWeb-managed source
folder.

| | server hits | DOM | screenshot opened |
| --- | --- | --- | --- |
| uBOL pane `%640` | `page.html:1`, `img/plain.svg:1`; **both ad URLs absent** | `ad1=0 ad2=0`, control `ok1=300` | both red ad banners gone; green `CONTROL OK` still drawn |
| empty-extension control `%626` | page + both ad URLs + control URL | `ad1=300 ad2=300 ok1=300` | two red `AD NOT BLOCKED` banners visible |

Engine log identifies the degraded boundary rather than saying only "loaded":
`declarativeNetRequest, scripting (degraded: no userScripts) (TWeb compatibility
adapter)`, six static rulesets, one loaded and zero refused.

**Remote real-page corroboration, same real-pane harness:**
`https://canyoublockit.com/extreme-test/`, screenshots both opened and non-blank.
Control `%641` → 99 performance resources, 7 iframes, 54 scripts, 7 images,
bodyLen 2002. uBOL `%642`, separate clean profile, unmodified source through the
runtime adapter → 67 resources, 1 iframe, 51 scripts, 7 images, bodyLen 1904:
**32 fewer loads (32.3%), 6 of 7 iframes removed (85.7%), 3 fewer scripts.** This
closes the earlier named "no remote site" limit. The local fixture remains the
stronger causal evidence because its server-hit counter proves exact ad URLs
never arrived and the expected resource-type pattern was prederived from real
EasyList rules; the remote delta is independent corroboration, not a substitute.

**Correction to the profile-level blocker reported earlier in this run:** the
conclusion was wrong and is retracted. A complete copy of the owner's 1 GB TWeb
profile blocks correctly — `ad1=0 ad2=0`, ad URLs absent — so accumulated profile
state is **not** the cause and there is no profile corruption. Two real causes
were hiding behind the symptom:

1. **Load/registration race.** `serviceWorkers.startWorkerForScope()` called
   immediately after `loadExtension()` can fail even in a clean profile. Fixed
   with a bounded retry (30 × 100ms), unit-tested with a fake session.
2. **Cross-process scope ownership.** Two engines share one profile. The second
   may not own or list the worker **and still block** because the first process's
   dNR state is in effect. task-1 briefly removed the extension on start failure,
   then measured that doing so would disarm a blocker that is actually working;
   that decision was reversed. The extension now stays loaded and the ambiguity
   is logged rather than guessed.

Safety: the owner's live `~/Library/Application Support/tweb-electron` was never
modified, deleted or cleared. Every destructive isolation experiment ran against
copies under `/tmp/t1ext`.

**What was built:**

- `electron/extension-policy.cjs` — pure classifier, **21 tests after final
  review**. Any missing API causes refusal, even if a content script would run,
  because a Cyberhaven-like security extension partially loading gives false
  protection. The only measured exception is exact uBO Lite identity +
  `userScripts`: that extension feature-detects it, degrades, and real dNR
  blocking is measured. **The end-of-run review caught and removed a blanket
  MV2 ban that exceeded the evidence.** MV2 is not refused merely for being old:
  a content-script-only MV2 extension injects and changes the offscreen DOM. What
  is impossible is MV2's request-blocking model; manifests requesting
  `webRequest`/`webRequestBlocking` are refused with that true specific reason.
  Unsupported manifest versions, generic dNR (auto-enable unproven),
  scripting-only, popup-only, and no-working-capability shapes are likewise
  refused with human reasons.
- `electron/extensions.cjs` — directory scan, load, bounded worker-start retry,
  service-worker warning/error surfacing, and a narrowly identified uBO Lite
  compatibility adapter. 20 tests.
- `electron/main.cjs` — initializes the loader against the same session pages use.
- `crates/tweb-pane/src/engine_app.rs` / `Makefile` — both runtime modules added
  to embed and `electron-check` lists.
- `crates/tweb-cli/src/lib.rs` — false doctor "extension capabilities" claim
  removed.

The provenance policy is settled in §3.3 decision 19. The misleading empty
repo-root `extension/` directory was removed with `rmdir`. It was untracked, so
Git has no deletion record; its absence is intentional. Runtime state belongs
under TWeb's user-data directory, never in the source checkout.

**The false doctor help claim is fixed in this run's working tree.** The claim
lived in `crates/tweb-cli/src/lib.rs`, not `doctor.rs`: *Diagnose and configure
terminal/tmux/GPU/extension capabilities* now says
*terminal/tmux/GPU capabilities*. `doctor.rs` itself remains untouched, as
required, because it carries another session's uncommitted work. This is a
truthfulness fix, not extension diagnostics — `tweb doctor` still reports
nothing about extensions, and now it no longer promises to.

### 6.8 Final `make check` for this run

**`rc=0`, independently rerun by task-3 on the settled combined tree.**

```
fmt / clippy -D warnings: clean
Electron: 462 pass / 0 fail across 31 files
syntax: all embedded runtime modules clean
Rust: 30 + 1 + 16 + 77 + 107 passed, 0 failed
```

The first final run caught one stale integration assertion: after the operator
narrowed the blanket MV2 refusal to the true `requires webRequest` reason,
`extension-policy.test.cjs` passed 21/21 but `extensions.test.cjs:328` still
expected `Manifest V2 is not supported` (`461 pass / 1 fail`). Updating that
integration assertion and rerunning the **whole** command produced the green
result above. The settled combined tree, not each contributor's last local
check, is what had to pass.

---

## 7. What to do next

*(State at the end of run `s1786972005513-4`, updated after #34 and #35 merged.
The previous version of this section led with find-in-page and the PDF frame;
both shipped in #31, so both are gone from the list rather than demoted.
**Every item this section ever listed is now closed or dispositioned** — see
"Disposition of this list" at the end.)*

Ordered by what a daily user feels first. Depth over breadth: two things that
genuinely work beat six that half-work — that is the project's own standard and
it is the reason this list is short.

### The reasoning for the order, and why it now points somewhere else

The severity ranking is not the same as the feature-importance ranking. It is
ranked by **what a Chrome refugee hits, and how bad it is when they do**:

1. Things that destroy work already done.
2. Things that look present and fail at the moment of use.
3. Things that are absent and known to be absent — the user can plan around
   these, and they are cheaper to live with than to discover.

That ordering is why extensions — which this document has called *arguably the
largest feature gap and the one costing the owner most in daily comfort* — was
not at the top for two runs. **Tier 1 is now empty and tier 2 is nearly so.** The
print wedge, the silent upload failure, the download blackout and the
middle-click theft closed in #30; find-in-page, PDF scrolling and the session-key
collision closed in #31, the last of these being the second data-destroying
defect on the board. Nothing that destroys work is known to be open.

So the deferral reason has expired, and extensions is the top item by the
document's own ranking rather than by a change of mind.

### Recommendation 1 — extensions, and specifically the class boundary

**Shipped in #34.** What follows is the reasoning that produced it, kept because
the measurements are the reusable part; the recommendation itself is closed. What
shipped is the class boundary argued for below — a manifest classifier that
refuses with a reason, plus the uBO Lite shim rather than static-to-dynamic
translation, because task-1's result showed the extension arms its own rulesets
once its worker survives.

The gap is real and daily: every page carries the ad tax, and the owner's own
Chrome extensions are the concrete thing being given up by switching. What this
run established is that "do extensions work?" was the wrong question — the answer
splits by *what an extension does*, and the split is sharp and measured.

**The end-of-run acceptance state is `partially works`: real uBlock Origin Lite
blocks in a real hidden pane.** Everything in the class table below was measured
first in a standalone profile; the acceptance result was then repeated through
`tweb __pane` with an empty-extension control, server hits, DOM state and two
screenshots task-1 opened (§6.7). "Partial" is load-bearing: local rule-verified
fixture only, no remote sites, no cosmetic-filter/scriptlet verdict, no popup UI,
and cross-process worker ownership leaves update semantics constrained.

| class | state | evidence |
| --- | --- | --- |
| loads at all | works | extension loads, MV3 service worker runs (`getAllRunning` = 1) — owner seq 3, task-1 independently |
| content scripts (DOM modification) | works, including offscreen | the DOM was genuinely modified — owner seq 3 |
| request blocking, rules installed at runtime | works | `updateDynamicRules` / `updateEnabledRulesets` → the request never reaches the origin, same server-hit signature as Electron's own `cancel` — owner seq 13, task-1 seq 12 |
| MV3 static rulesets from a manifest | **never arm on their own** | `getEnabledRulesets()` returns `[]` on load; Electron 43 ignores `declarative_net_request.rule_resources` — owner seq 13, task-1 seq 12. An extension that calls `updateEnabledRulesets` itself during init recovers, *if* its worker survives |
| toolbar-popup-only extensions | **dead, for two independent reasons** | a popup has nowhere to draw in a tmux pane, **and** `chrome.action` is absent so nothing can trigger one — task-1 seq 22 |
| MV2 `webRequest` blocking | **impossible here** | `chrome.webRequest` is not exposed to extensions under Electron 43 — enumerated from a service worker (task-1) and from an MV2 background page, where the `addListener` call throws on load (owner seq 15) |

The failure mode those rows share is the whole problem: an extension that loads,
reports healthy and protects nothing — the exact "looks-present,
fails-at-the-moment-of-use" shape this project has twice chosen to withhold
rather than ship. A user browsing behind an inert ad blocker is worse off than
one who knows they have none. Note that `loadExtension` resolving and
`getAllExtensions` listing the extension are **not** evidence it works; that is
true whether or not its service worker survived startup.

Concretely, for the two extensions that matter most to this user:

- **uBlock Origin (MV2) cannot work here, full stop.** The API it is built on is
  not exposed to extensions. This is not a bug to route around: there is no
  ruleset to enable and nothing a host can switch on. Electron also warns
  `Permission ... is unknown` at load. It loads cleanly and blocks nothing.
- **uBlock Origin Lite (MV3) blocks requests** — measured by task-1, and this
  reverses the position held for most of the run. It fails on arrival for **two
  stacked reasons**, neither of which is "dNR is broken": (1) `chrome.permissions`
  is absent, so `background.js:881` throws at module top level and the entire
  background module dies before uBOL's own init runs; (2) Electron 43 ignores
  `enabled` on manifest static rulesets — but uBOL calls `updateEnabledRulesets`
  itself during init, so **fixing (1) makes uBOL do (2) for us**. With a small
  `chrome.*` stub shim in place, task-1 measured both ad images dead
  (`naturalWidth` 0), the ad script blocked, and the ad URLs absent from the
  origin's hit log, with the service worker logging no crash.

  **Why that result is trustworthy, and it is the strongest evidence in this
  document:** one probe URL came back `ALLOWED` and that is *correct*. task-1
  chose the fixture URLs by re-implementing Chromium's `urlFilter` syntax and
  searching uBOL's default-enabled rulesets for generic block rules matching a
  `127.0.0.1` URL; exactly two match, and easylist rule 456 carries
  `excludedResourceTypes [main_frame, XMLHTTPREQUEST]`. So a correctly-working
  uBOL **must** block the images and the script tag and **must** let the `fetch`
  through. That is the observed pattern, and the prediction was written down
  before the run. A blanket zero would have been weaker evidence.

  A trap task-1 paid for and recorded: `self.browser` is a **separate object**
  from `chrome` under Electron and also lacks `permissions`. A shim patching only
  one global does nothing.

  **A prediction this falsified, kept because it was reasonable when made:** the
  owner argued (seq 21) that shimming uBOL was a trap in which "the crash moves
  further down" to the next missing API. task-1's run shows the worker surviving
  and rules arming. The prediction was tested and did not hold.

**A disagreement between the two API enumerations was resolved by measuring the
context, not by picking a winner.** The owner had enumerated `chrome.*` in a
manually loaded `_generated_background_page.html`; task-1 enumerated from inside
the actual MV3 service worker. Electron exposes a broader surface to the worker:

| context | `chrome.*` keys measured |
| --- | --- |
| extension background page (owner, probe10) | `declarativeNetRequest`, `extension`, `i18n`, `management`, `runtime`, `tabs` |
| MV3 service worker (task-1, seq 22) | `alarms`, `declarativeNetRequest`, `extension`, `i18n`, `management`, `offscreen`, `runtime`, `scripting`, `storage`, `tabs` |

So `storage`, `scripting` and `alarms` are worker-only here. task-1's surface is
the one relevant to uBOL and is authoritative for that verdict; the smaller
background-page surface remains relevant to MV2 and extension-page
compatibility. The owner's argument that shimming uBOL was a trap because
`storage` was absent is **retracted** — it was built on the wrong execution
context, and task-1's uBOL result had already falsified it empirically.

The policy consequence is broader than this one extension: **`chrome.*` exposure
is context-dependent inside the same extension.** A classifier that checks one
context and generalises to the whole extension will be wrong; a refusal reason
must name the context if it matters.

What follows from that, in order:

1. **Whatever ships must refuse what it cannot serve, with a reason.** Same rule
   as the withheld page-host declaration. An install path that accepts a static-
   ruleset blocker and leaves it silent is not an incomplete feature, it is a
   defect.
2. **Static-to-dynamic translation is one real path, but no longer the only
   one**, and it may not be the best. Enforcement is proven, so translating
   `declarative_net_request.rule_resources` into `updateDynamicRules` at load is
   a translation problem rather than a capability problem. **The ceiling is
   measured** (owner, probe8): the declared constants disagree —
   `MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES` is 5000,
   `MAX_NUMBER_OF_DYNAMIC_RULES` is 30000 — and the *enforced* behaviour follows
   the larger one: 30000 rules were pushed and `getDynamicRules()` returned
   30000, no error. Do not budget against the smaller constant. Above 30000 is
   **unmeasured, not disproven**.

   **But task-1's uBOL result changes the calculus**, because uBOL arms its own
   rulesets once its worker survives. Translation means the host owns and
   re-derives the rules; shimming means the extension does its own job. The
   second is less code and stays current with the extension's own updates; the
   first does not depend on shimming APIs the extension may believe more about
   than is true. **This document does not decide it** — both now have a measured
   basis, which is more than either had at the start of the run.

   Four things the ceiling does **not** establish, named so nobody assumes them:
   - whether an arbitrary extension's rule JSON survives translation. Rules use
     condition fields the toy probes never touched (`regexFilter`, `domainType`,
     `initiatorDomains`, `excludedInitiatorDomains`, `requestDomains`, redirect
     and modifyHeaders actions), and a rule Chrome accepts is not automatically
     one Electron 43 accepts. `updateDynamicRules` is all-or-nothing per call, so
     one malformed rule rejects the whole batch — expect per-rule validation with
     a skip-and-count.
   - whether 30000 registered rules cost anything at page-load time. Registering
     is not the same as living with.
   - whether the translation survives a restart or must be redone every launch.
   - anything above 30000.

   One host-side constraint that decides the shape either way, measured by
   task-1: **there is no host API to arm an extension's rulesets.**
   `session.extensions` exposes only `getAllExtensions`, `getExtension`,
   `loadExtension`, `removeExtension`, `isRegistered`, `isSuspended`,
   `register`/`registerAll`, `setSuspended`, `unregister`/`unregisterAll`.
   `updateEnabledRulesets` is callable only from inside the extension's own
   service worker. So for a static-ruleset extension the host **cannot** switch
   the rules on — the extension must, and it can only do that if its worker
   survives startup.

   A corollary worth building around: `loadExtension` resolves and
   `getAllExtensions` lists the extension **whether or not its worker is alive**.
   The worker's own console error is the only evidence that it died, which is
   precisely why an extension can look installed and healthy while doing nothing.
3. **The shippable claim is a demonstration, not a mechanism.** "We translate uBO
   Lite's rules" is not a finding. "N of M rules armed, and here is a real ad
   gone from a real page in a real pane" is.
4. **If translation does not pan out, content scripts are the honest subset** —
   proven working, including offscreen, and a real capability worth having on its
   own.
5. **Do not promise "extensions work".** Promise the classes measured to work,
   name the ones that do not, and let the user see the class at install time.
   The immediate engineering priority is no longer a profile blocker — that
   diagnosis was retracted — but closing the named partial-support limits:
   remote-page behaviour now has independent corroboration; cosmetic
   filtering/scriptlets and update semantics across concurrent panes remain, one
   measured claim at a time. **#34 shipped exactly this**: `extension-policy.cjs`
   classifies from the manifest and refuses with a stated reason, so a refusal is
   visible at install time instead of an extension sitting loaded and inert. The
   two unmeasured items — cosmetic filtering/scriptlets, and update semantics
   across concurrent panes — are recorded as unmeasured rather than carried as
   open work.

### Recommendation 2 — the ergonomics tail

- **Back/forward muscle memory — done this run**, after task-2 found and fixed the
  destructive focused-field hole in the owner's first version. One caveat
  remains: Alt-arrow in a field is inert rather than moving by word as Chrome
  does.
- **Actual paper printing — done for the measured `lpr` hand-off**, opt-in under
  `gp`, without changing Ctrl-P/save-as-PDF. Physical paper output remains
  unobserved and unclaimed (§6.7).
- **Hangul mode indicator — no fix made, because the premise did not reproduce.**
  The indicator is accurate on task-2's three controlled trials. The real gap is
  discoverability: a jamo was interpreted as the command on its physical Latin
  key. task-1's older contradictory observation remains unreconciled (§6.7).

The tail is therefore closed as far as this run can honestly close it. The
extension-support limits named above were then closed in #34, and the find-bar
reopen residue in #35 — so this recommendation has no open successor either.

### Deliberately not recommended, with reasons

Each entry below is **dispositioned, not pending**: the decision is that no work
is scheduled, and the reason is what would have to change for that to be revisited.
None of them is waiting on effort or on someone getting to it.

- **A password manager.** Recommended *against* — see §3.1 decision 5. The old
  version of this section said extensions would close the password gap "as a side
  effect via 1Password". **That claim is withdrawn as unmeasured**: 1Password's
  browser extension is popup-UI plus native messaging, and neither has been
  exercised here. A popup has nowhere to draw in a tmux pane, and native
  messaging was never tested. Treat the password gap as open and independent
  until someone measures it. *Reopens on:* a measurement of native messaging in
  this engine, not on a decision to try harder.
- **A bookmarks UI.** The *import* is the migration blocker; the bar is a GUI
  affordance. See §3.1 decision 8. The README claims were removed in #30.
  *Reopens on:* someone wanting the import specifically — the bar stays out
  regardless.
- **A disk cache cap.** Explicitly not recommended. `userData` is 1.0 GB, 661 MB
  of it Service Worker CacheStorage for YouTube/Gmail/Meet. Chrome does not prune
  those either, so capping would be a regression under this document's own
  standard — silently dropping a site's offline assets to look tidy. Recorded
  because it was the question that started run `s1786880826401-2`, and the answer
  is "do nothing". *Reopens on:* nothing foreseeable — a cap is a regression by
  the standard the project is measured against.
- **`Cmd`-based shortcuts.** Permanent non-goal, not a backlog item (§4). *Does
  not reopen.*
- **The shared page host (`READY` declaration).** Not a missing feature: the host
  is **built and renders**, behind `TWEB_HOST_PREVIEW=1`, and
  `hostProtocolVersion()` returns `null` on purpose (DESIGN.md §5.1,
  `electron/hosted-runtime.cjs`). The gate is shut because the tab plumbing still
  reaches for a single window context, so a second attach would draw into the
  first pane's window — `handleAttach` refuses it. Declaring `READY 2` today
  would host **one pane per engine**, which buys nothing: the measured saving is
  runtime duplication, and one pane in an otherwise empty Electron duplicates the
  runtime exactly as now, with a daemon added on top. *Reopens on:* N panes
  rendering in one engine — a specific engineering condition, not a schedule.

### Closed since this section was first written, kept so the list is auditable

- Print wedge, uploads, download notification, middle-click background tab — #30.
- Find-in-page, PDF document scrolling, per-window session slot — #31. The PDF
  one is **partial**: the viewer's own toolbar is still unreachable.
- Chrome's back/forward keys (`M-Left`/`M-Right`/`BSpace`, with the editable-field
  guard task-2 found missing) and the opt-in `gp` paper-print tier — #32, with the
  result-hold fix in #33. Physical paper output remains unobserved and unclaimed.
- Extension support, to the measured class boundary — #34. uBO Lite blocks in a
  real pane; uBlock Origin MV2 is permanently impossible here (`chrome.webRequest`
  is not exposed to extensions at all); content-script extensions load and run,
  including offscreen; popup-only, generic-DNR and scripting-only extensions are
  refused *with a reason at install time* rather than loading silently inert.
- The find-bar reopen residue named in the #31 entry above — #35. Reopening with
  `/` and pressing Enter without retyping no longer replays a dead session's
  query, and a genuinely absent term now reports absent.

### Disposition of this list

**Every item in §7 is now either closed by a merged PR or dispositioned above
with the condition that would reopen it. Nothing is left in an undecided state.**

That is the honest end of this list, and it is deliberately not the same claim as
"TWeb is finished". Two named partial limits stand and are recorded rather than
hidden: the PDF viewer's own toolbar is unreachable, and extension support covers
the measured classes only — cosmetic filtering/scriptlets and update semantics
across concurrent panes are unmeasured. Those are the next measurements if this
document is picked up again; they are not open items on a backlog someone forgot.

### Two things to carry forward regardless of what gets built next

**1. `make check` cannot see the failures that matter here.** Three times now —
the `cleanupFrameFiles` ReferenceError, the blank pane behind a green check, and
run `s1786880826401-2`'s sandboxed-preload `require` that killed every shortcut
in every real pane while 366 tests passed — the suite was green and the browser
was broken. Every verdict in this document that says `works` was produced by
driving a real pane and looking at the result. Anything reachable only through a
real run needs a real run, and that should be a condition of merging a change to
`electron/`, not a habit that depends on who is working.

**2. When something does not work, ask the component what state it thinks it is
in before concluding the capability is absent.** This run produced two wrong
verdicts and corrected both by the same move. A traffic test said "extension
request blocking does not work" twice; the real answers were a static ruleset
that never registered (`getEnabledRulesets()` → `[]`) and an API never exposed to
extensions (`apiPresent` → `false`). Same symptom, different causes, opposite
fixes — one is a translation problem worth building around, the other is a
permanent wall. The symptom alone could not tell them apart, and stopping at the
symptom would have thrown away a working capability.

The same shape appeared in #31: find-in-page looked like the offscreen-focus
class this document had built a whole theory around, and was an inverted flag.
Both are instances of a stronger rule than "measure, don't grep" — **measure the
mechanism, not just the outcome**, because an outcome is consistent with several
mechanisms and they do not have the same fix.
