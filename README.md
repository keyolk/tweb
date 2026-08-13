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
- **Terminal graphics-native**: a Ghostty GPU surface fast path plus a standard Kitty graphics fallback.
- **Browser mode**: input ownership is split between tmux shortcuts and browser shortcuts, per client mode.
- **Shared browser profile**: browser pages in the same tmux session share a persistent Chromium profile.
- **Agent resource exchange**: screenshots, DOM/CSS context, downloads and console/network traces are handed to agents in the same tmux window as typed attachments.
- **Chrome profile bootstrap**: extensions, bookmarks and general site state are imported policy-aware.
- **Managed Chrome boundary**: URLs that need Okta Device Trust or enterprise-managed Chrome are handed off to real Google Chrome.

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

# Manage browser resources
tweb resource list --window @1
tweb resource send r_01K... --to-pane %1

# Chrome profile bootstrap
tweb profile bootstrap chrome

# Diagnose the environment
tweb doctor

# Install the Ghostty Cmd passthrough and tmux CSI-u/mouse settings as a separate include file
tweb doctor --fix
```

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

- **Electron**: built on Chromium offscreen paint. Provides all current TWeb browser features — Vimium-style modes, tabs/omnibox, visual/inspect, smart copy, detached DevTools.
- **Tauri (macOS experimental)**: sends native snapshots of the system `WKWebView` as Kitty PNG frames, so there is no separate Electron/Chromium startup cost. Supports resize, UTF-8/CSI-u/navigation keys, SGR mouse, adaptive frame transfer and terminal lifecycle. It shares the same preload as Electron, so Vimium-style modal shortcuts, hint/visual/inspect, the tab list, omnibox and multi-tab, find-in-page, zoom, smart copy/paste, and the browser shortcut ↔ web passthrough toggle all work too. DevTools opens as the Safari Web Inspector, and the Chromium-only `inspectElement` coordinate targeting has limited support.

Electron and Tauri both persist the open tab URLs, the active tab and each tab's zoom per tmux window.
Omitting the URL — plain `tweb open` — restores the last state, while naming a URL ignores the stored
state, starts fresh on that single URL and updates the stored state to match. Electron does not store
`about:blank` or its internal loading/notice pages, so a valid previous session is never overwritten.
With no URL to restore it shows an address prompt rather than a black screen. The Electron persistence
key uses the tmux socket, the session name and the window index, so the same slot is restored across a
tmux server restart. Renaming the session or changing the window index is treated as separate state.

`--frame-rate N` is the maximum frame rate during the active window right after user input or a resize,
in the range 1–60. Adaptive mode, the default, uses the maximum for 700ms after terminal input or a
resize and then drops to 1fps. Continuous painting from video or animation alone does not extend the
active window, so long playback never saturates terminal output. PNG frames travel over a local file
transport, leaving only a small Kitty graphics command on the tmux/Ghostty stream, and when the writer
falls behind, intermediate frames are dropped and only the latest is kept. `--no-adaptive-frame-rate`
pins the given value; `--adaptive-frame-rate` states the default policy explicitly.

On the same 80×24 tmux pane with a local fixture and debug builds, the median time to first Kitty frame
(3 runs) was 6.084s for Electron and 1.834s for Tauri. Those are comparative numbers from the current
development environment and will differ with release builds, real sites and WebKit cache state.

## Browser input modes

The modal shortcuts and mode indicator below behave identically on the Electron and Tauri engines,
which share the same preload runtime. The only per-engine difference is DevTools: Electron opens
detached Chromium DevTools, Tauri opens the Safari Web Inspector.

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
`H` hint, `/` search, `V` visual, `I` inspect, `T` tab list, `O` omnibox, `?` shortcut help,
`P` web passthrough. Only what matters — a target count, the kind of selection — is appended briefly
beside it.

IME composition (Korean and the like) is drawn by the terminal emulator in its own layer. Putting the
Kitty placement above the text (`z >= 0`) hides that layer behind the page image and the syllable being
composed becomes invisible, so the image goes **below** the text (`z=-1`) — tmux's default background
cells that fill the pane are transparent, so the page still shows through. With an input element
focused, the terminal cursor moves to the web caret position; otherwise it is hidden. If some terminal
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
| `/`, `n`, `N` | Find in page (`Enter` confirms) / next / previous match |
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
| `Esc` | Cancel hint/search/visual/inspect/omnibox · clear input focus · leave fullscreen |
| `Esc` (normal) | Close site autocomplete and popups as an outside click |

Each TWeb pane shows a `current/total` tab badge in the bottom right, separate from the mode indicator.
The second of five tabs reads `N  2/5`. Hovering or clicking the badge opens that pane's list of tab
titles, and clicking a title switches to that tab. Tab state is per-pane and is never published to the
pane title in the tmux status line.

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
tweb                 The CLI and the tmux pane frontend
twebd                The Chromium/profile/page/resource daemon
TWeb Profile Bridge  The extension for Chrome profile bootstrap and managed Chrome handoff
```

The published package uses `@keyolk/tweb` to avoid an unscoped name collision.

## Implementation languages

```text
Rust              tweb, twebd, protocol, profile/resource/agent core
C++               CEF/Chromium embedding and the GPU surface export adapter
Objective-C++     The minimal boundary of the macOS IOSurface/Mach/Metal bridge
Zig               Ghostty upstream renderer/protocol changes
TypeScript        The TWeb Profile Bridge Chrome extension
```

Rust is the core choice, but the memory savings come less from the language itself than from not
duplicating an Electron/Node/V8 runtime per pane: one Chromium process manages many pages and keeps
GPU/frame/resource buffers under bounded ownership.

## Status

Currently at the architecture/design stage. See [DESIGN.md](DESIGN.md) for the detailed design.

The main things to validate:

1. The Ghostty GPU surface fast path
2. The damage-aware Kitty graphics fallback
3. tmux-native image lifecycle
4. Browser mode and Korean IME/input fidelity
5. Chrome extension/profile bootstrap compatibility
6. tmux window-scoped agent resource exchange
7. Remote Chromium/video transport scalability

## Reference projects

- [awrit](https://github.com/chase/awrit)
- [cliweb](https://github.com/atomashevic/cliweb)
- [casty](https://github.com/sanohiro/casty)
- [Orca](https://www.onorca.dev/docs)
- [Ghostty](https://github.com/ghostty-org/ghostty)
- [tmux](https://github.com/tmux/tmux)
