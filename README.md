# TWeb

TWeb is a terminal-native browser runtime that runs Chromium (Electron) or macOS WebKit (Tauri) pages as pane processes on top of Ghostty/Kitty and tmux.

```text
Ghostty / Kitty
└── tmux
    ├── agent pane
    ├── server pane
    └── TWeb browser pane
```

## Core principles

- **tmux-native**: tmux is the authority for sessions, windows, panes, resize, focus and lifecycle.
- **Terminal graphics-native**: Kitty graphics on stock Ghostty/Kitty, with no terminal fork required.
- **Browser mode**: input ownership is split between tmux shortcuts and browser shortcuts, per client mode.
- **Shared browser profile**: every browser pane shares one persistent Chromium profile — cookies, storage and history are the same across panes and across restarts.
- **Agent control on the user's own screen**: an agent drives the very page the user is looking at, over a per-pane unix socket, with no separate headless session.

Read the [Status](#status) section before switching to TWeb as a daily browser. It states what runs,
what is broken today, and which Chrome behaviours are deliberately not attempted.

## Installation

```sh
make install              # ~/.local/bin/tweb
make install PREFIX=/usr/local
make uninstall
```

Only the binary gets installed. The Electron app code (`main.cjs`, `preload.cjs` and friends, 198KB)
is embedded in the binary and unpacked into `~/.cache/tweb/app-<hash>` on first run. The directory
name is a content hash, so the binary and the preload can never drift apart.

The Electron **runtime** is 295MB and is not embedded. When missing, it is fetched once on first run
(into `~/.cache/tweb/electron-<version>`, verified against `SHASUMS256.txt`) and used from the cache
thereafter. Running inside the workspace prefers `electron/node_modules`, and a system `electron`
takes precedence over the download. Set `TWEB_NO_AUTO_INSTALL=1` to block the automatic install, or
`TWEB_ELECTRON=<binary>` to point at one yourself. `TWEB_CACHE_DIR` changes the cache location.

## Commands

The official executable is `tweb`. `twb` is an optional alias.

```sh
# Open in the current pane. With no arguments this behaves like open and restores the previous state
tweb

# Use the explicit subcommand when passing a URL or any open option
tweb open https://localhost:5173

# Create a tmux browser pane (default: Electron, adaptive 4–30fps)
tweb split https://localhost:5173

# Open on the macOS Tauri/WebKit engine
tweb split --engine tauri https://localhost:5173

# Tune the active maximum frame rate
# adaptive uses the given value while active and drops to at most 4fps when idle
tweb open --frame-rate 24 --adaptive-frame-rate https://localhost:5173

# Pin the given frame rate instead
tweb open --frame-rate 15 --no-adaptive-frame-rate https://localhost:5173

# Drive a specific pane's browser from an agent or the CLI
tweb panes
tweb snapshot --pane %3
tweb click a --pane %3
tweb screenshot shot.png --pane %3

# Diagnose the environment
tweb doctor

# Install the Ghostty Cmd passthrough and tmux CSI-u/mouse settings as a separate include file
tweb doctor --fix
```

`tweb --help` also lists `resource`, `profile` and `chrome`. Those are **placeholders for unbuilt
subsystems** — each one parses its arguments and then exits with
`command not yet implemented`. They are listed here so nobody discovers it mid-migration; see
[Status](#status).

## Agent control (CLI · MCP)

Finishing frontend work in the terminal means agents have to be able to drive the same browser. A
running browser pane opens a unix socket in the runtime directory (`agent-%3.sock`), and both the
`tweb` CLI and `tweb mcp` attach to it over line-delimited JSON-RPC. No separate headless session is
started, so **the screen the agent operates is the screen the user is looking at**.

The refs are the same values the `f` hints draw as labels. When an agent clicks `@a`, the user watches
the very element that carried the `a` badge get pressed, and a human looking at the screen can say
"press a". There is no separate coordinate space and no translation step.

```bash
tweb panes                       # browser panes available to drive
tweb snapshot                    # interactive elements + refs (--text for a reading snapshot)
tweb click a                     # trusted native click (isTrusted=true)
tweb fill s "agent@example.com"  # framework-safe value assignment
tweb select d Green
tweb press Enter --mod shift
tweb wait --selector "#result" --timeout 5000
tweb errors                      # console errors only
tweb eval "location.pathname"
tweb tab new https://localhost:5173
tweb diag                        # pane geometry, zoom, frame and input state
tweb engine-log --limit 40       # engine debug lines (resize and frame accounting)
```

Output defaults to a human-readable summary; `--json` returns the raw form. `--pane` can be omitted —
with one pane it picks that one, and with several it uses **panes in the same tmux window**. Browsers
in other windows are never candidates, so you can keep a browser open per window without looking up
a pane id every time.

When the problem is the pane rather than the page, look at `diag`. It returns the pane cell/pixel
size, the window content size, zoom, the last frame's size against the expected size, the frame rate
and the input mode all at once, which turns a screen-only symptom like "it isn't keeping up with
resize" into numbers — if the frame size differs from the expected size, those frames are being
dropped. `engine-log` returns the engine lines behind that judgement (`resize generation=…`,
`frame dropped got=… want=…`). Those used to go only to the pane's stderr, so observing them
previously meant relaunching the pane under a separate harness.

`diag`'s `page` is the shortcut runtime's own state — the current mode and its detail, the kind of
picker open with its candidate count and the label being typed, the visual/caret state, the scroll
surface currently held (including which frame it is in), and how many targets `f`/`s`/`v` would find
right now. The preload runs in an isolated world and cannot be reached via `eval`, so this path is
the only window into it. If `targets.frames` is 1 but `visual` is 0, for instance, the frame was
recognized but there is nothing inside it to pick.

`snapshot` returns roles, accessible names, values, CSS selectors and screen coordinates together, so
an element an agent verified can be carried straight into test code as a selector. `console`/`errors`
read a buffer accumulated since the page started, so asking after the fact is not too late.

Register it with an MCP client as a stdio server.

```json
{ "mcpServers": { "tweb": { "command": "tweb", "args": ["mcp"] } } }
```

The agent socket is currently provided by the Electron engine. The Tauri engine supports the
human-operated paths only.

## Browser engines and frame policy

`open` and `split` both accept `--engine electron|tauri`. The default is `electron`, which provides
every existing feature.

- **Electron**: built on Chromium offscreen paint. Provides all current TWeb browser features — Vimium-style modes, tabs/omnibox, visual/inspect, smart copy, detached DevTools. This is the engine every measurement in [Status](#status) was taken on.
- **Tauri (macOS experimental)**: sends native snapshots of the system `WKWebView` as Kitty PNG frames, so there is no separate Electron/Chromium startup cost. Supports resize, UTF-8/CSI-u/navigation keys, SGR mouse, adaptive frame transfer and terminal lifecycle. It shares the same preload as Electron, so Vimium-style modal shortcuts, hint/visual/inspect, the tab list, omnibox and multi-tab, find-in-page, zoom, smart copy/paste, and the browser shortcut ↔ web passthrough toggle all work too. DevTools opens as the Safari Web Inspector, and the Chromium-only `inspectElement` coordinate targeting has limited support.

> The Tauri parity list above is **claimed by construction — a shared preload — and was not exercised
> in the capability audit behind [Status](#status).** Every measured verdict in this README is
> Electron. Treat Tauri as unvalidated until somebody drives it the same way.


Electron and Tauri both persist the open tab URLs, the active tab and each tab's zoom per tmux window.
Omitting the URL — plain `tweb open` — restores the last state, while naming a URL ignores the stored
state, starts fresh on that single URL and updates the stored state to match. Electron does not store
`about:blank` or its internal loading/notice pages, so a valid previous session is never overwritten.
With no URL to restore it shows an address prompt rather than a black screen. The Electron persistence
key uses the tmux socket, the session name and the window index, so the same slot is restored across a
tmux server restart. Renaming the session or changing the window index is treated as separate state.

> **The persistence key does not include the pane id, so two browser panes in one tmux window share
> one session slot and the last to exit silently overwrites the other's tabs.** Measured this run:
> four tabs in one pane were replaced by a second pane's single tab, and the key was independently
> re-derived from `sha256('v2', socket, session, window index)` to confirm the collision is
> structural rather than a race. Until it is fixed, keep one browser pane per tmux window if you
> care about the restore.


`--frame-rate N` is the maximum frame rate during the active window right after user input or a resize,
in the range 1–60. Adaptive mode, the default, uses the maximum for 700ms after terminal input or a
resize, then settles by what the page is doing: it **keeps the full rate while the page is still
painting on its own** — video, an animation, a canvas — and drops to 4fps once it stops. Playback is detected by counting paints over
a window rather than by watching for a keystroke, so a video holds a watchable rate without anyone
touching the keyboard, and a page that merely finished loading still falls all the way to idle.

Playback held a lower cap when this tier was introduced, on the theory that it is the one workload
running unbounded. Measured on YouTube, the pipeline carries 28fps against a 30fps cap with nothing
dropped, so the cap was only ever a worse picture; the saving comes from the idle rate instead. Frames
travel over a local file transport, leaving only a small Kitty graphics command on the tmux/Ghostty
stream, and when the writer falls behind, intermediate frames are dropped and only the latest is kept.
`--no-adaptive-frame-rate` pins the given value, holding it even on a still page;
`--adaptive-frame-rate` states the default policy explicitly. `tweb diag` reports which tier is
in force as `frames.rateKind`.

On the same 80×24 tmux pane with a local fixture and debug builds, the median time to first Kitty frame
(3 runs) was 6.084s for Electron and 1.834s for Tauri. Those are comparative numbers from the current
development environment and will differ with release builds, real sites and WebKit cache state.

## Browser input modes

The modal shortcuts and mode indicator below behave identically on the Electron and Tauri engines,
which share the same preload runtime. The only per-engine difference is DevTools: Electron opens
detached Chromium DevTools, Tauri opens the Safari Web Inspector. Everything described here was
measured on Electron; see the Tauri note above.

`Ctrl-;` and `Ctrl-/` are two independent toggles.

- **`Ctrl-;` — bypass**: decides whether `Cmd` combinations go to the page. When on, tmux switches the client viewing this pane to the `tweb-pass` table, bypassing tmux prefix/root bindings and delivering keys, modifiers and mouse events to the page.
- **`Ctrl-/` — vimium**: turns Vimium-style normal mode and the TWeb browser shortcuts on and off. With no input element focused, `f`/`j`/`k` and friends work; while typing they are not intercepted and `Esc` clears the focus.

Because the two toggles are independent, their combination is the mode:

| vimium \| bypass | bypass on | bypass off |
|---|---|---|
| **vimium on** | N (normal) | shortcuts only |
| **vimium off** | P (passthrough) | web only |

Normal-mode keys keep working with bypass on as long as vimium is on — the engine delivers `Cmd`
natively regardless of mode, so it does not depend on the tmux table. The passthrough table is armed
only when vimium is off.

With bypass on, `Ctrl-C` goes to the page, so quitting TWeb means turning vimium on with `Ctrl-/` or
bypass off with `Ctrl-;` first, then pressing `Ctrl-C`. Leaving the TWeb pane or ending the process
restores that client's previous tmux key table.

To use a page's own shortcuts briefly — `j`/`k` in a feed, `m` in a player — enter **insert mode** with
`i` from normal mode. Every key except `Esc` reaches the page as a real engine-generated key event, so
shortcuts on sites that check `isTrusted` work and Korean keys are not converted into command
characters. `Esc` returns to normal mode immediately, and the tmux configuration is left untouched.

When focus moves into a cross-origin iframe (an ad or an embed), that frame's preload does not handle
shortcuts. TWeb tracks which frames can handle shortcuts and sends keys to the main frame in that case,
so `?` and `f` keep working even after clicking an iframe.

Application shortcuts that macOS or the terminal emulator consumes before the PTY cannot reach the web
without extra configuration. `tweb doctor` diagnoses conflicts like Ghostty's `Cmd-K` along with the
tmux CSI-u/mouse/passthrough settings. `tweb doctor --fix` backs up the existing file and installs only
a single marker-delimited include line into the user's Ghostty/tmux config, keeping the actual TWeb
settings in `${XDG_CONFIG_HOME:-~/.config}/tweb/ghostty.conf` and `tmux.conf`. Older inline doctor
blocks and identifiable legacy TWeb bindings are migrated automatically. On a change it also sends a
reload signal to running Ghostty processes.

Ghostty **produces no PTY encoding at all** for `Cmd` combinations — a key probe confirmed that
`Cmd-K`/`Cmd-A` send not a single byte in plain, modifyOtherKeys or Kitty-flag mode. So they are
**carried as private sequences**, the same way `Ctrl-;` is. doctor's `CMD_PASSTHROUGH_KEYS` is the
single definition, and all four layers have to line up for one key to arrive.

1. `keybind = super+k=text:\x1b[5020~` — Ghostty emits the sequence.
2. tmux `user-keys[120]` plus the root/`tweb-pass` bindings — without them tmux re-encodes the leading ESC of a sequence it does not recognise, turning `ESC[5020~` into `ESC[91;3u5020~`.
3. the engine's `CMD_PRIVATE_KEYS` — turns the code back into the original `Cmd` key event.
4. the engine's private sequence parser — it has to recognise this code range.

The bindings live at the **Ghostty root**, not inside a key table. A table can only be entered by
pressing its binding — no action, IPC or escape sequence activates one from outside — so a
table-scoped binding leaves a freshly opened pane unable to deliver `Cmd` until `Ctrl-;` is pressed.
A root binding instead costs the key across all of Ghostty, so the list is limited to shortcuts whose
terminal meaning is expendable. `Cmd-K` only clears the screen, and `Ctrl-L` still does that. `Cmd-A`
selects the scrollback, which is only useful for copying it — and a tweb pane draws a webpage there,
so there is nothing to select.

`Cmd-V` works without being on that list, because it takes a different path. Ghostty's
`paste_from_clipboard` writes the clipboard straight into the PTY, and since the pane turns on
`DECSET 2004` (bracketed paste) that content arrives wrapped in `ESC[200~ … ESC[201~`. On the opening
bracket the engine collects every byte up to the closing one and handles it as a single paste
(`electron/paste-state.cjs`). The body is arbitrary bytes including ESC and arrives across several read
chunks, so it cannot go through the key sequence parser and gets its own state machine. When the
content matches the clipboard, `webContents.paste()` is used so a real paste event fires — pages like
Slack read that event to handle formatting and attachments. Without the bracketing the clipboard is
typed one character at a time, and newlines go out as `Enter`, sending a message midway through a
multi-line paste.

`Cmd-V` alone is **never bound at the root.** Doing that once killed pasting across all of Ghostty, and
there is nothing to gain since the path above already works. A test enforces this.

`Cmd-C`/`Cmd-X` are passed through. `super+x` has no Ghostty default binding at all, so it costs
nothing, and the `copy_to_clipboard` that `Cmd-C` takes is mostly redundant because **`copy-on-select`
defaults to `true` on macOS** — selecting text in the terminal already puts it on the clipboard.
Inside a page, meanwhile, there is no way to copy while typing without `Cmd-C`. For anyone who turned
`copy-on-select` off this trade is a loss, so doctor warns about it under `Ghostty terminal copy`; in
that case bind `copy_to_clipboard` to `super+shift+c` directly.

`Cmd` combinations are always delivered as native key events, regardless of mode. The reason to press
them is the web app's own handler, and those handlers are exactly the ones checking `isTrusted`. To add
a new combination, add one line to `CMD_PASSTHROUGH_KEYS` and one to the engine's `CMD_PRIVATE_KEYS`;
a test catches a layer that falls out of step.

> Ghostty sometimes does not reparse its config even after receiving a reload signal. If a new `Cmd`
> binding does not respond after `doctor --fix`, quit Ghostty entirely (`Cmd-Q`) and start it again.

### Mode indicator

The current mode shows as a single character in the lower right: `N` normal, `E` editable/insert,
`H` hint, `/` search, `V` visual, `I` inspect, `T` tab list, `O` omnibox, `?` shortcut help. Only what
matters — a target count, the kind of selection — is appended briefly beside it.

The two input toggles are a separate badge beside it, not a mode, because they are settings rather
than something the keyboard is doing: with a mode label reporting them, focusing an input showed the
toggle state instead of `E`. The badge appears **only when a toggle is away from its default** — one
that is always lit says nothing — and reads `⌘` when Cmd combinations go to the page, or `web` when
TWeb's shortcuts are off. With both off there is a single `web` badge rather than two, since the pane
is then simply out of the way.

IME composition (Korean and the like) is drawn by the terminal emulator in its own layer. Putting the
Kitty placement above the text (`z >= 0`) hides that layer behind the page image and the syllable being
composed becomes invisible, so the image goes **below** the text (`z=-1`) — tmux's default background
cells that fill the pane are transparent, so the page still shows through. The terminal cursor follows
the web caret — a focused input, or the caret in visual caret mode — and is hidden whenever there is
no caret to sit on, including at startup: a pane inherits the shell's cursor, and left in the corner it
reads as a caret that started in the wrong place. If some terminal
paints those cells opaque, `TWEB_IMAGE_Z=0` returns to the old layering.

The first tab shows a placeholder until the real page commits. Chromium paints nothing until the page
commits, and on a real site that takes seconds — google.com measured 5.5s. The placeholder commits
within 0.5s, and paint holding then keeps that screen up until the real page is ready. The second tab
onward is unaffected, since the previous page is still on screen.

The pane frontend runs on the alternate screen. `tweb open` starts inside the pane the user was already
working in, so the shell prompt and output left there would show through beneath the image; exiting
brings the original screen back untouched.

The price of moving the image below the text is that Chromium's own stderr output, previously hidden
behind the image, now shows on top of the page. Engine stderr therefore goes to
`~/.cache/tweb/logs/engine-<pane>.log`. Diagnostic lines always accumulate in a ring buffer inside the
engine as well, so `tweb engine-log` reads them, and `TWEB_DEBUG=1` inherits stderr directly and lets
it flow to the terminal too.

On a Korean 2-set layout, physical keys and a jamo `langmap` are used, so the normal/hint/visual/inspect
commands behave exactly as on an English layout. In `E` mode, with an input element focused, Korean is
inserted as typed without conversion.

IME composition is handled by the terminal emulator rather than the browser, and the syllable being
composed is drawn at the **terminal cursor position**. The terminal and the page use different fonts and
coordinate spaces, and preedit text is never delivered over the PTY, so the two cannot be overlaid as
if they were the same glyph. Instead TWeb reserves a composition area — 3 cells by default — starting
right after the web caret and parks the terminal cursor on its first cell. That area finds the nearest
opaque background color from the input element and uses it semi-transparently, drawing no boundary and
no shadow, so it reads as natural padding in the input field rather than as a separate box covering page
text. The width is configurable via `TWEB_IME_SLOT_CELLS`.

The cursor is requested as a bar (`DECSCUSR 6`) rather than a block. A block covers its own cell and
hides the page's input cursor along with the character next to it. The composition area is aligned to
cell boundaries, and the row uses the cell nearest the caret. When there is not enough room to the
right, it moves to the adjacent terminal row rather than covering earlier characters on the same line.
Cell size is computed from the pane geometry and the browser zoom, so the area and cursor position are
recomputed after zoom, pane resize and tab switches.

Since it is the emulator that draws the terminal cursor and the composition preview, the font size and
color follow the terminal settings rather than the page. It will not match the page font exactly, but
the composition preview never overlays existing page glyphs directly. When input focus goes away, the
composition area and the terminal cursor are removed with it.

### Shortcuts mode keys

| Key | Action |
| --- | --- |
| `?` | Open the supported-shortcut help (`?` or `Esc` closes it) |
| `f` / `F` | Hint the clickable elements on screen / open the link in a new tab |
| `/`, `n`, `N` | Find in page (`Enter` confirms) / next / previous match — **broken, see [Status](#status): the bar opens and accepts typing but matches nothing** |
| `v` / `V` | Pick a target with the visual picker / open the whole page's text as a Visual selection (inside visual, `c` enters caret mode; from caret, `v` selects from that point) |
| `b` | The open browser tab list (`j`/`k`, `1`–`9`, `Enter`, `x` closes, `Esc`) |
| `I` | inspect picker: check element info and selectors |
| `s` | Pick an inner area to scroll — with an inner area held, the mode indicator gains a `⇅`, and `Esc` or `s`'s first candidate (the page) returns |
| `h` / `l` | Scroll left / right |
| `j` / `k` | Scroll down / up |
| `d` / `u` | Scroll half a page down / up |
| `gg` / `G` | Top / bottom of the page |
| `gi` | Focus the first input element |
| `H` / `L` | History back / forward |
| `J` / `K` | Previous / next browser tab |
| `t`, `O` | Open the new-tab fuzzy omnibox (open tabs plus the full visit history) |
| `o` | Open the current-tab fuzzy omnibox (prefilled with the current URL) |
| `x` / `X` | Close the current tab / restore the most recently closed tab |
| `y` | Copy the current page URL |
| `r` | Reload |
| `zi` / `zo` / `zz` | Zoom in / out / reset |
| `i` | insert mode: use the page's own shortcuts (`Esc` returns) |
| `m` | Take audio back for this pane (only one TWeb pane is audible at a time) |
| `Esc` | Cancel hint/search/visual/inspect/omnibox · clear input focus · leave fullscreen |
| `Esc` (normal) | Close site autocomplete and popups as an outside click |

Each TWeb pane shows a `current/total` tab badge in the bottom right, separate from the mode indicator.
The second of five tabs reads `N  2/5`. Hovering or clicking the badge opens that pane's list of tab
titles, and clicking a title switches to that tab. Tab state is per-pane and is never published to the
pane title in the tmux status line.

### Audio

Only one TWeb pane is audible at a time. When a page starts making noise, that pane claims the
speakers and every other pane mutes — muted, not paused, so a video keeps playing and keeps its
position. A muted pane shows a `🔇 %<pane>` badge next to its mode indicator naming the pane that
owns audio; `m` takes it back, which mutes the previous owner instead.

Ownership is a claim file in the runtime directory (`audio-owner.json`), refreshed by the owner and
re-read by every pane a few times a second. A pane that is killed rather than closed therefore does
not leave the others muted: the claim stops being refreshed and its pid stops existing, and the next
pane to notice clears it. `tweb diag --json` reports the whole state under `audio`.

After picking a text target in Visual, or selecting the whole page's text with `V` from normal mode,
`h`/`l` adjust the active edge by character, `b`/`w`/`e` by word, `k`/`j` by line, `0`/`$` by line
boundary and `{`/`}` by paragraph, while `o` switches which selection endpoint is being adjusted. Over
that adjusted range, `y`/`Y` copy the selected text. On an image target, `y` copies the displayed
bitmap, `Y` the alt text, `u` the image URL actually being displayed (`currentSrc`), `D` downloads the
image and `o`/`O` open it in the current/a new tab. On link/editable targets, `y` smart-copies the link
URL or the text/value, `u` gives the link URL, `o`/`O` open the link and `p` pastes the clipboard.
`d` inspects the target.

To move the selection's **start**, drop into caret mode with `c`. The selection collapses to a single
caret and the motions above move the caret instead of extending a selection, so pressing `v` at the
point you want restarts the selection from there — the flow for grabbing a single word in the middle
of a paragraph. Motions are not confined to the block picked by the hint, so `}` or `j` can carry the
selection into the next text block, and the view scrolls along when the selection leaves the screen. In
caret mode, `y` copies the whole block the caret sits in.

After picking a target in Inspect, `y` copies the CSS selector, `h` the outer HTML and `t` the text,
while `d` opens DevTools. Electron selects that element directly in detached Chromium DevTools; Tauri
opens the Safari Web Inspector and attempts element selection only where possible.

The omnibox's visit history is appended to a per-profile file, so it is shared across panes and
restarts. `o` prefills the current URL, so it opens filtered to that URL; use `t`/`O` to start from an
empty list.

`f` hints cover more than plain links and buttons: ARIA roles, `jsaction`, `contenteditable`, pointer
cursors and delegated click areas, and interactive elements in open shadow DOM. The chosen target gets
a brief outline/ripple feedback. Cross-origin iframes and ad frames are not made hint targets as outer
frames themselves, to avoid focus getting stuck.

A video's control bar is hidden behind hover, so before collecting hints the pointer is moved over the
largest video to bring up **the controls the site draws itself**, and the hints attach to those real
buttons. On a site with its own controls, like YouTube, the hints point at the same positions and
shapes as the controls you normally see. A separate proxy is used only for the browser's built-in
controls (`<video controls>`), which are unreachable from script.

If input locks up completely, `Ctrl-Shift-;` safely detaches just the current tmux client, and
`tmux attach` brings you back. The tmux server and other clients survive. Inside tmux, TWeb uses the
`modifyOtherKeys` that tmux tracks: `pane_key_mode=Ext 2` while running, restored to `VT10x` on exit.
The protocol mismatch where Kitty keyboard mode remained only in Ghostty while tmux stayed on `VT10x`
was the cause of the earlier input lockups.

## Components

```text
tweb          The CLI and the tmux pane frontend. One multi-call Rust binary.
electron/     The engine: an Electron main process plus the preload that carries
              the modal shortcuts, hints, omnibox, history and tab runtime.
twebd         A Rust supervisor. Built, and it owns pane identity and lifecycle —
              but it hosts no page today. See the note below.
```

`twebd` is the seam for one Electron process hosting N panes instead of one Electron per pane. That
saves a measured ≈58 MB of duplicated Node/V8 per additional pane (DESIGN.md §5.1). The seams exist —
registry, protocol, frame writer, identity — but **the engine deliberately withdraws its host
declaration rather than accepting an attach it cannot serve**, so the shipping path is still one
Electron per `tweb __pane`. That withholding is intentional and load-bearing; it is what keeps a pane
from attaching to a host that would render nothing.

The published package uses `@keyolk/tweb` to avoid an unscoped name collision.

## Implementation languages

```text
Rust              tweb, twebd, the tmux/terminal protocol, the frame and input path
JavaScript (CJS)  the Electron main process and the page preload runtime
```

Rust is the core choice. The memory argument for it is narrower than it looks: the saving comes from
keeping Node/V8 out of the daemon and the pane frontend, not from the language. The engine is still
Electron, and removing it was measured and rejected — stock headless Chrome over CDP cost 830 MB for
four pages against shared Electron's 386 MB (DESIGN.md §5.1).

> DESIGN.md §6.3 additionally names C++, Objective-C++, Zig and TypeScript. **None of those exist in
> this repository** — there is not one `.cc`, `.cpp`, `.mm`, `.zig` or `.ts` file outside
> `node_modules`. They belong to the design's long-term shape, not to what ships.


## Status

TWeb is a working browser, not a design document. Sixteen merged PRs (#14–#29) of runtime ship the
Electron → Kitty graphics pipeline, the modal input runtime, tabs/omnibox/history/session restore, and
the agent socket.

It is **not yet a safe replacement for Chrome as a daily browser.** The capability verdicts below were
measured on 2026-08-16 against HEAD `947891b` by driving real panes on the Electron engine. The
sections above this one describe the implementation as built; they stand where the audit did not
contradict them, but most of their mechanics were not re-exercised.

### What works

| Capability | Note |
|---|---|
| Page rendering, resize, zoom | The default path is damage-aware Kitty graphics on stock Ghostty/Kitty. |
| Modal shortcuts (`f`/`v`/`I`/`s`/`b`/`o`…) | TWeb's own preload, not a Vimium extension. |
| Back / forward (`H`/`L`) | Measured, and fast. But `Alt-Left`, `Alt-Right` and `Backspace` — the keys a Chrome user's hands already know, and all three deliverable through tmux — are simply unbound and fail silently. The capability is there; only the muscle memory is missing. |
| History (`gh`) | Measured: 343 real visits, live incremental search, `Enter` opens, `Ctrl-D` deletes. |
| Tabs, close and reopen (`x`/`X`) | Measured: `X` restores the tab at its original strip position. |
| Session restore across a pane kill | Measured: four tabs, order, active index and per-tab zoom all came back. One pane per window only — see the caveat above. |
| Right-click context menu | Measured: built from Chromium's own params, varies by target, and the items execute. |
| Downloads (the transfer) | Measured: lands in `~/Downloads`, the same directory Chrome uses. Collision handling is exact Chrome parity — the original is kept and the new file gets ` (1)`. A 156 KB PDF was byte-identical to its source. |
| Login forms | Measured: fill and submit work; cookies persist, so existing sessions survive restarts. |
| `mailto:` links | Measured twice: hands off to the OS default mail client, exactly as Chrome does, and leaves no orphan `about:blank` tab. |
| Popups / `window.open` | Measured: becomes a TWeb tab rather than a floating OS window. See the `opener` caveat below. |
| Video with sound | Measured: real decode, a live `AudioService` child process, `audible=true`. |
| Korean IME | **Validated this run**, and this README previously listed it as unvalidated. `안녕하세요` and `한글 렌더 테스트 abc123` land byte-exact (`U+C548 U+B155 U+D558 U+C138 U+C694`, no mojibake, no doubling) and render correctly with the caret in the right place. Two honest limits: a live macOS 2-set IME with per-jamo backspace mid-composition was **not** driven, and typing hangul with no field focused flips the mode indicator to `insert` cosmetically — the keys still work and `Esc` clears it. |
| Agent control (CLI · MCP) | Measured throughout the audit; it is how most of this table was driven. |

### What is broken today

These are ordered by what a Chrome user hits and how badly. Every one of them **fails silently** — no
error, no beep, no toast — which is what makes them worse than an honest absence.

1. **`window.print()` wedges the renderer.** There is no print handler anywhere, so `window.print()`
   falls through to Chromium's native print dialog, which cannot draw from an offscreen `show:false`
   window. The renderer never returns. Reproduced twice with a control before each: `eval` and
   `page-diag` time out afterwards, the real key path is dead too, and **the pane keeps painting the
   page perfectly**, so it looks healthy. Recovery by navigate or reload failed on the second
   reproduction. Killing the tmux pane afterwards left an orphaned `tweb __pane` at PPID 1 still
   holding its Electron. Sites call `window.print()` from their own Print button, so this is reachable
   without ever pressing `Ctrl-P`.
2. **File uploads do nothing.** The page draws a normal `Choose File` button, `tweb snapshot`
   enumerates it, `tweb click` reports `ok`, a DOM click event fires — and no chooser opens, no native
   window appears, no error is raised. `dialog` is not imported in `electron/main.cjs` and there is no
   file-chooser handler at all. `tweb fill` cannot work around it; Chromium forbids setting a file
   input's value from script. This costs every attachment: Gmail, Slack, GitHub, any upload form.
3. **Find in page finds nothing.** `/` opens a Chrome-styled find bar, accepts typing, and
   `contents.findInPage()` is genuinely called — but the `found-in-page` event never fires. Measured:
   the result span stays empty for 8 seconds against a query that is on the page, nothing highlights,
   and `Enter` closes the bar without scrolling to the match. Control: `window.find()` on the same
   text in the same pane at the same moment returns true and selects it. The text is findable;
   `findInPage` is what does not deliver.
4. **PDFs are inert after page one.** Chromium's full PDF viewer is present and paints beautifully —
   toolbar, thumbnail sidebar, `1 / 5` page indicator, download and print icons. None of it responds.
   `j`, `Down` and `PageDown` all leave the rendered bytes identical, on both the real key path and
   the agent socket, while the same keys scroll an HTML page in the same pane. The viewer lives in a
   separate extension frame the preload does not reach: `snapshot` returns zero refs and an empty
   title. You can read page one of a bank statement and nothing else.
5. **Nothing tells you a download happened.** The transfer works, but the pane is unchanged,
   `capture-pane` shows nothing, and the only record is a line in the engine's retained log that a
   user would have to know to run `tweb engine-log` and read out of a raw JSON array. No progress for
   a large file, no completion signal, no `chrome://downloads` equivalent. A user who thinks nothing
   happened clicks again and gets `file (1)`.
6. **Middle-click foregrounds the new tab.** It does open a tab, but it activates it, which defeats
   the entire point of the gesture — middle-click six links off a results page and the second click
   lands on the wrong document. `setWindowOpenHandler` calls `createTab(target, true)` for both
   `window.open` and middle-click; Chrome differentiates the two.
7. **Two browser panes in one tmux window destroy each other's session.** Described above under frame
   policy. Silent tab loss.
8. **`window.opener` is null in popups.** Forced by `action: 'deny'`. OAuth and SSO popup flows that
   `postMessage` back to the opener — the classic "Sign in with Google" pattern — will authenticate
   and then hang, because the parent never learns it succeeded. Ordinary `target=_blank` links are
   unaffected.
9. **Copying an image is a region capture, not an image copy.** `Cmd`-menu → Copy image calls
   `capturePage(rect)` rather than copying the decoded resource, because `copyImageAt` does not update
   the pasteboard offscreen. An image that is partly scrolled off copies clipped and contaminated with
   surrounding page; a 4000px photo shown at 300px copies at 300px; a transparent PNG copies
   composited. It works for the ordinary small, fully-visible image, and fails silently otherwise.

**These are one bug, not nine.** Items 1–4 are the same class: a Chromium path that expects a native
window or a focused `webContents`, with no offscreen workaround written. `electron/main.cjs` already
carries that workaround for two paths somebody did hit — the context menu at `:3854` and copy-image at
`:2688` — and both of those work.

### What is missing

Honestly absent, with no code pretending otherwise:

- **Extensions.** Zero hits for `loadExtension`, `session.extensions` or `chrome.runtime` anywhere.
  The `extension/` directory at the repo root is empty. This costs uBlock Origin — and in a terminal
  browser ad blocking is not only comfort, since every animated ad is pixels re-encoded and pushed
  through Kitty graphics — plus 1Password, devtools extensions and anything corporate-mandated.
  Electron supports only a subset of Chrome's extension API, so **full extension support is not
  achievable here** and should not be promised.
- **Saved passwords and autofill.** No `Login Data`, no `Web Data` in the profile. Nothing offers to
  save a password and nothing autofills on revisit. This is deliberate: **TWeb should not build its
  own credential store.** A homegrown one is a security liability and would be strictly worse than the
  1Password the owner already runs. The correct target is the extension path, which fixes both.
- **Bookmarks, and any Chrome profile import.** `tweb profile bootstrap` and `tweb profile list` both
  exit with `command not yet implemented` — run against a real Chrome profile to confirm. Nothing
  reads Chrome's bookmarks, extensions or site state. The *import* is the migration blocker, more than
  the bookmarks bar itself.
- **The managed Chrome handoff.** `tweb chrome open` and `tweb chrome status` both exit with
  `command not yet implemented`. `BrowserRoutingPolicy` exists in `crates/tweb-core/src/routing.rs`
  with an `*.okta.com` denylist, but nothing calls it — it is a dead type. **A URL that needs Okta
  Device Trust or enterprise-managed Chrome is not handed off; it simply loads in TWeb and fails
  however that site fails.**
- **Agent resource exchange as a broker.** `tweb resource list` exits with `command not yet
  implemented` and `ResourceBrokerImpl` is 38 lines. What does work is the agent socket:
  `snapshot`, `screenshot`, `console`, `errors` and `eval` genuinely hand page context to an agent.
- **The Ghostty GPU surface fast path.** No TWeb-enhanced Ghostty build exists and nothing in the tree
  exports an `IOSurface`. Everything runs on the standard Kitty path, which is the point — TWeb works
  on official Ghostty and stock Kitty with no fork.

### Deliberately not attempted

A terminal cannot do these, and TWeb is not going to pretend otherwise. Nobody should build something
that merely looks like them:

- **Drag and drop from Finder onto a page.** There is no path from a GUI file manager into a tmux
  pane. This is a permanent delta for uploads, not a to-do.
- **Chrome's native file chooser** — previews, sidebar favourites, search. The honest terminal answer
  is a path prompt with completion, which is *faster* than a Finder dialog for anyone who lives in a
  shell. It does not exist yet, so uploads are broken today, but the GUI chooser is not the target.
- **Chrome's print preview GUI** — paper size, margins, scaling, page range, a live preview, the macOS
  print dialog. The honest split is save-as-PDF via `printToPDF()` for the common case and `lpr` for
  actual paper.
- **Chrome's autofill dropdown** anchored to a field, and its Touch ID / keychain confirmation. Those
  are OS-level surfaces. A terminal port of autofill should be *more* explicit than Chrome's, not
  less — silent autofill without a visible origin confirmation is a phishing risk.
- **`Cmd` chords the way Chrome receives them.** Ghostty emits no PTY bytes at all for `Cmd`
  combinations, so each one has to be carried as a private sequence through four cooperating layers
  (see the input-modes section). The ones on that list work; an arbitrary `Cmd` chord does not, and
  `Cmd+[` for back can never work.
- **A live IME pre-edit underline inside the page.** Composition is drawn by the terminal emulator in
  its own layer and pre-edit text never crosses the PTY. TWeb reserves a composition area next to the
  web caret instead. Arguably an improvement: the page never sees half-formed state.

### Where TWeb beats Chrome

Not consolation prizes — these are things Chrome cannot do because it owns its own windows:

- **tmux owns window management.** `split-window`, `resize-pane`, `swap-pane`, `join-pane`,
  `break-pane` and zoom apply to a browser page like anything else. A browser pane sits beside the
  server log and the agent, in a layout that survives detach and reattach, on the same keys as the
  rest of the terminal. Chrome's window management is Chrome's; here it is yours.
- **Exclusive audio across panes.** Exactly one TWeb pane holds the speakers. Takeover is automatic,
  the loser is told *why* (`mutedByOther` distinguishes "I muted this" from "something took it"), and
  `m` takes it back with one keystroke. And an autoplaying ad **cannot** steal your audio — a page
  starting playback is not treated as consent. Chrome gives you N tabs shouting at once and a small
  speaker icon to hunt for.
- **History as a keyboard overlay.** `gh` opens a searchable overlay on the page you are already on,
  filtered live as you type, over the whole store rather than a visible slice. Chrome makes you spend
  a tab and navigate to it.
- **Popups become tabs.** No chromeless window floating over your work.
- **Session restore is on by default and per window.** Chrome only reopens tabs if you turned
  "Continue where you left off" on, and it does so per profile.
- **A download's absolute path beats "Show in folder".** A path in a terminal is directly actionable
  by your own tools; a Finder window is not. This is the right shape, once TWeb actually prints it.
- **Modal shortcuts are native.** The Vimium-style layer is TWeb's own preload rather than an
  extension, so it survives the extension gap entirely.

### What still needs validating

1. The damage-aware Kitty path's frame pacing against the release gate in DESIGN.md §7.7
2. Chrome extension/profile bootstrap compatibility — nothing is built, so nothing is validated
3. tmux window-scoped agent resource exchange, beyond the agent socket that ships
4. Remote Chromium/video transport scalability
5. The Tauri engine, which no measurement in this README covers
6. A live macOS 2-set hangul IME with per-jamo backspace mid-composition

See [DESIGN.md](DESIGN.md) for the design and [DETAIL.md](DETAIL.md) for the implementation-depth
design. Both are design documents that predate most of this runtime and mark their unbuilt sections
inline; this Status section is the authority on what runs.

## Reference projects

- [awrit](https://github.com/chase/awrit)
- [cliweb](https://github.com/atomashevic/cliweb)
- [casty](https://github.com/sanohiro/casty)
- [Orca](https://www.onorca.dev/docs)
- [Ghostty](https://github.com/ghostty-org/ghostty)
- [tmux](https://github.com/tmux/tmux)
