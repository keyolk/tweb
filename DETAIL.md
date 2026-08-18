# TWeb detailed design — the P1 damage-aware Kitty path (shipped) + the twebd/Electron integration (target)

This document designs the first stage of `PREDEV.md`'s critical path (P1) and the twebd/Electron
integration structure down to implementation depth. It assumes Engine = Electron is settled (S0).

Research date: 2026-07-31.

> **[README.md's Status section](README.md#status) is the authority on what actually runs.** It is
> built from measurements against real panes; this document is built from intent, and the sections
> below mark where the two diverge.
>
> **Read sections 1-7 as the target design, not as a description of the running system.** They were
> written before implementation and are in the present indicative throughout; several of their
> central claims are the opposite of what ships. Specifically:
>
> - **One whole Electron process runs per tmux pane on the shipping path.**
>   `crates/tweb-pane/src/lib.rs` spawns one from every `tweb __pane`, and the `BrowserWindow`s
>   inside it are *tabs of that pane*, never other panes. §4.2's "add a BrowserWindow per pane, not
>   a new Electron process" is now **built behind a closed gate**: the page host exists, renders a
>   hosted pane under `TWEB_HOST_PREVIEW=1`, and refuses a second pane — so §4.1's topology is still
>   what ships. See DESIGN.md §5.1 for the gate and what has to be true before it opens.
> - **`twebd` routes nothing on the shipping path.** The supervisor exists and `crates/tweb-pane`
>   now references it — `hosted.rs` attaches to a daemon-held page and writes the frames it gets
>   back — but only under `TWEB_DAEMON=1`, and every attach is **refused** today because no engine
>   declares host capability (DESIGN.md §5.1). So what actually carries `RESIZE` / `VIS` / `INPUT`
>   is still newline-framed lines on the engine's **stdin**, written directly by the Rust frontend.
>   Every arrow through `twebd` in §4.3, §4.4, §5.3, §6.1 and §6.3 remains target state.
> - **The Rust native module / SHM transport named in §4.3 was deleted** — see §8.4, which records
>   the deletion but does not go back and correct §4.3. Frames go `paint` → `gfx-worker.cjs` → file →
>   Kitty `t=f` on the inherited stdout.
> - **No extension is loaded.** Nothing calls `session.loadExtension` (§7); the vimium-like behaviour
>   ships as TWeb's own `electron/preload.cjs`.
>
> Sections **8.1-8.4 are dated, measured addenda** and do describe reality. Where a section below has
> been superseded by a measurement, it now says so inline. DESIGN.md §5.1 carries the decision on
> where the process boundary actually goes, argued from the marginal-cost measurement.

## 1. Securing the Electron offscreen rendering API

### 1.1 What the paint event actually means

```js
win.webContents.on('paint', (event, dirty, image) => { ... })
```

- `dirty` (`Rectangle`): the repainted area. Note that `image` carries the **whole frame**.
- `image` (`NativeImage`): the entire viewport. `.toBitmap()` yields raw pixels (BGRA on macOS).
- **awrit ignores `_dirty` and always retransmits the whole image** — one of the bottlenecks DESIGN.md
  section 7.1 diagnosed. TWeb makes active use of the dirty rect.
- `event.texture` (`OffscreenSharedTexture`): exists only with `useSharedTexture: true` (experimental).
  Requires an explicit `texture.release()`. "Only a limited number of textures can exist at the
  same time."

### 1.2 dirty-only subscription

```js
win.webContents.beginFrameSubscription(true, (image, dirty) => { ... })
```

With `onlyDirty: true`, the callback's `image` carries **only the repainted area**. It must not be used
together with the paint event, though — pick one or the other.

### 1.3 Frame rate control

```js
win.webContents.setFrameRate(60)  // max 240; beyond that it is "performance losses only"
```

### 1.4 The two GPU paths

| mode | `useSharedTexture` | output | CPU copy | notes |
|---|---|---|---|---|
| shared memory bitmap | `false` (default) | `NativeImage` `.toBitmap()` (BGRA) | yes | Supports WebGL/3D CSS. The path awrit used. |
| shared texture | `true` | `event.texture` (`OffscreenSharedTexture`) | no | experimental, needs a native module, limited texture count. |
| software output | `app.disableHardwareAcceleration()` | `NativeImage` (fast to produce) | yes | Gives up WebGL. Frame production itself is fast. |

TWeb's default path: **shared memory bitmap** plus active dirty rect use. The GPU fast path (shared
texture) is an optional Tier 3 after S1 validation.

## 2. Memory pipeline design (avoiding awrit's bottlenecks)

### 2.1 awrit's bottlenecks (confirmed by research)

1. Every `paint` builds the whole frame in CPU memory via `image.toBitmap()`.
2. **`_dirty` is ignored and the whole frame is copied**.
3. The Rust bridge repeats `shm_open`, `ftruncate`, `mmap`, `munmap` on every `paint`.
4. BGRA→RGBA conversion runs over the whole frame (no conversion code is visible in awrit's
   `paint.ts`, but Kitty requires RGBA, so it happens somewhere).
5. Redundant copies through Browser→Node→Rust→shared memory.

### 2.2 What TWeb improves

```text
Electron main process (Node.js)
│
├── BrowserWindow (offscreen, a single main process, pages separated rather than a window per pane)
│   └── webContents.on('paint', (event, dirty, image) => ...)
│         │
│         ├── extract the dirty rect (awrit ignores it, TWeb uses it actively)
│         ├── image.toBitmap() → BGRA raw pixels (whole frame)
│         └── hand off to a Rust native module (like awrit-native-rs)
│               │
│               ├── a persistent POSIX SHM ring (never shm_open per paint)
│               │   ├── preallocate 2–3 mapped buffers when the page is created
│               │   ├── swap buffers only on resize
│               │   └── reuse the buffer pool (never mint names/image IDs without limit)
│               │
│               ├── dirty rect → adaptive tile mapping
│               │   ├── a 256×256 tile grid
│               │   ├── update only the tiles a dirty rect overlaps
│               │   ├── fold into a full-frame/stripe when the changed area is large, as in a scroll
│               │   └── produce no frame or command for a static page
│               │
│               ├── BGRA→RGBA conversion (SIMD, changed tiles only)
│               │   └── never the whole frame, only the dirty tiles
│               │
│               └── Kitty graphics transfer
│                   ├── t=s (shared memory) + a=t (transmit-only) + a=p,U=1 (virtual placement)
│                   ├── stable tile image IDs updated in place (a=p,i=<id> replace)
│                   └── never reuse the same transfer buffer before the terminal ACKs
│
└── twebd IPC — tmux pane identity ↔ BrowserWindow/page mapping
```

### 2.3 The core optimization principles

1. **Never shm_open per paint**: preallocate 2–3 persistent mapped buffers when the page is created and
   swap them only on resize.
2. **Remove the redundant Browser→Node→Rust→SHM copies**: the Rust native module writes the
   `toBitmap()` result straight into the destination SHM buffer. No round trip through a Node `Buffer`.
3. **Convert/transfer dirty tiles only**: never convert the whole frame BGRA→RGBA; SIMD-convert the
   dirty tiles alone.
4. **Zero transfer for static pages**: with no damage, produce neither a frame nor a terminal command.
5. **Bounded pools**: reuse SHM names and image IDs from a bounded pool rather than minting them
   without limit.
6. **Backpressure**: when the queue falls behind, drop intermediate generations and keep only the
   latest complete frame.

## 3. Tile strategy in detail

### 3.1 Choosing the tile size

```text
small tiles (128×128) → more commands/images and higher placement cost
large tiles (512×512) → more unnecessary pixel copies and texture uploads
starting candidate 256×256, adjusted in the 128–512 range by workload
```

The tile size is not a fixed constant but a measured choice. What to measure:
- Kitty command bytes per tile
- texture upload time per tile
- the average number of dirty tiles (scroll vs static vs animation)

### 3.2 damage → tile mapping

```text
paint event
    ↓
dirty rect (x, y, width, height)
    ↓
compute the set of overlapping tiles
    ↓
union the damage events of one display interval
    ↓
judge the changed area:
    small (≤ 20% of the viewport) → per-tile Kitty transfer
    large (> 20% of the viewport) → fold into a full-frame or a stripe
    ↓
on detecting a scroll event → a full-frame/stripe instead of hundreds of small commands
```

### 3.3 Strategy per Kitty capability

```text
load + animation frame + composite supported
    → composite the damage frame onto the base image (a=f, c=<base>)

independent image placement + replace supported
    → update stable tile image IDs in place (a=p, i=<id>, X=1 replace)

basic transfer/display only
    → a coalesced full-frame fallback plus a lower frame cap
    → surface the restricted state in the UI (never hide it)
```

Capabilities are decided by a graphics query (`a=q` + `ESC[c`), never guessed from the terminal name.

## 4. The twebd + Electron integration structure

> **Target state.** What ships is one Electron process per pane, with no `twebd` in the path at all.
> The topology below is the decided target — see DESIGN.md §5.1 for why the boundary sits where it
> does and what the marginal-cost measurement says it is worth.

### 4.1 Process topology

```text
Host
├── tmux server
│   └── pane %3
│       └── tweb __pane (a Rust binary; the foreground process tmux launches)
│           ├── terminal capability negotiation (Kitty graphics query)
│           ├── keyboard/mouse decoding (raw terminal mode)
│           ├── SIGWINCH → pixel viewport resize
│           └── frame display (receives Kitty graphics and shows them in Ghostty)
│
├── Electron main process (Node.js, single)
│   ├── BrowserWindow #1 (offscreen, page = pane %3)
│   │   └── webContents.on('paint') → gfx-worker.cjs → frame file → Kitty t=f on the pane's tty
│   ├── BrowserWindow #2 (offscreen, page = pane %5)
│   │   └── ...
│   ├── session.loadExtension() — vimium, 1Password and the like
│   ├── session.cookies — injects the cookies received from the Profile Bridge
│   └── IPC server — talks to twebd
│
├── twebd (a Rust daemon)
│   ├── an authenticated Unix socket (peer credential check)
│   ├── PageRegistry — (tmux server, pane id) + generation ↔ page mapping
│   ├── ProfileManager — a persistent profile per session
│   ├── ResourceBroker — resource store, scope, TTL
│   ├── AutomationController — serializes agent actions
│   └── tmux integration — pane lifecycle, hooks
│
└── Google Chrome (the user's ordinary Chrome, with the Profile Bridge extension)
    └── The TWeb Profile Bridge extension (cookie transfer, engine-agnostic)
```

Two lines above are target-only and worth naming because they read as shipped: nothing calls
`session.loadExtension` (§7), and the Electron side has no IPC server — today the Rust frontend
writes control lines to the engine's stdin.

### 4.2 The BrowserWindow reuse strategy (the heart of the memory mitigation)

> **This is the mitigation that has not been built.** Today each pane is its own Electron process, so
> the Node/V8 main process and the GPU process are duplicated per pane — exactly what this section
> says they are not. The measurement of what the shared shape saves is in DESIGN.md §6.5.

Orca creates a BrowserWindow per worktree. TWeb instead:

```text
Electron main process (single, one Node.js runtime)
├── BrowserWindow A (offscreen)
│   └── webContents page = pane %3
├── BrowserWindow B (offscreen)
│   └── webContents page = pane %5
└── ...

The memory-saving principles:
- one Node.js runtime in the main process (one process, period)
- add a BrowserWindow per pane, not a new Electron process
- renderer processes stay Chromium's business (page isolation)
- nodeIntegration: false → renderers are pure Chromium, with no duplicated Node.js
- offscreen windows are frameless and never displayed → minimal GPU surface
```

A renderer process can still appear per BrowserWindow, though (Chromium's process model). Renderer
process reuse is to be examined via `processReuse` or `site isolation` policy. That is an S1
measurement item.

### 4.3 The IPC flow

```text
tweb CLI (short-lived)
    ↓ "open URL in pane %3"
twebd (Unix socket, peer credential)
    ↓ "create page for pane %3, load URL"
Electron main process (IPC)
    ↓ create the BrowserWindow, loadURL
    ↓ webContents.on('paint') starts
gfx-worker.cjs
    ↓ writes the frame file, then the Kitty t=f escape to the pane's tty
the pane's terminal
    ↓ renders the frame at the pane origin
```

> **What ships instead.** There is no CLI → twebd → Electron hop: `tweb __pane` spawns its own
> Electron and writes `RESIZE` / `VIS` / `INPUT` lines to that process's **stdin**. The "Rust native
> module / SHM write" this section used to name was deleted (§8.4); the frame path above is the real
> one, except that today the tty is the engine's *inherited* stdout rather than a tty the writer
> opens. `task-2` measured that a process owning no pty can open a pane tty and write the same bytes
> with the same result — see DESIGN.md §5.1.

### 4.4 The resize flow

```text
tmux pane resize
    ↓ SIGWINCH
tweb __pane
    ↓ tmux pane_width / pane_height / client_cell_width
    ↓ bump the viewport generation
    ↓ request a resize from twebd
twebd
    ↓ forwards the viewport resize to the Electron main process
Electron
    ↓ BrowserWindow.setSize() or webContents.setViewRect()
    ↓ Chromium viewport resize → CSS reflow → ResizeObserver
    ↓ paints frames of the new generation
    ↓ only the new generation is displayed within 2 display frames (old-size frames are dropped)
```

No 100ms debounce. Coalescing per display frame only.

> The pixel source above is corrected from "terminal pixel query (CSI 14t)": inside tmux, CSI 14t
> describes the whole terminal rather than the pane, so the shipping frontend asks tmux
> (`crates/tweb-pane/src/visibility.rs` `probe_args`). The twebd hop is target state — today the
> resize line goes straight to the engine's stdin.

## 5. Frame lifetime and backpressure

### 5.1 The surface ring

```text
2–3 surfaces cycle per visible page (a mailbox)
- GPU fast path: 2 surfaces by default, extended to 3 on a measured stall
- shared memory bitmap: 2 surfaces (a CPU bitmap is lighter than a GPU surface)
- the producer never overwrites a surface before Ghostty releases it
- when the queue falls behind, drop the intermediate frames not yet presented and keep only the latest complete frame
```

> **No ring ships.** The shipping mechanism is a **one-deep** `pendingGfxFrame` slot
> (`electron/main.cjs`) — a newer frame replaces the waiting one — plus a hidden pane collapsing its
> surface to `width × 1` (`electron/surface-policy.cjs`). Same intent (never present a stale frame),
> different mechanism. This matters beyond this section: DESIGN.md §7.7's gate "queue depth never
> exceeding the configured surface ring size" is graded against a ring that does not exist, and is
> restated there against the real queue.

### 5.2 Generation management

```text
the generation is bumped on every resize
- frames from an earlier size/generation are never displayed
- only new-generation frames are displayed, within 2 display frames
- hidden page: stop the compositor's begin-frame and keep only the last surface
- on a GPU process crash, switch to the Kitty backend per page
```

### 5.3 Handling hidden pages

```text
hidden tmux window
    ↓ tweb __pane detects the visibility loss (a tmux hook or client visibility)
    ↓ reports hidden to twebd
    ↓ Electron: setFrameRate(1) + stopPainting()
    ↓ collapse the offscreen surface to width x 1 (the GPU/SHM bytes go with it)
    ↓ reconcile with a full redraw on returning to visible
```

> Two corrections against what ships. `setFrameRate(0)` is not available — Electron's floor is 1, so
> the code pairs `setFrameRate(1)` with `stopPainting()`. And the visibility report does not go
> through `twebd`: the frontend pushes a `VIS` line on the engine's stdin.
>
> **The hidden-pane gate is the runtime's job, not tmux's.** `task-2` measured that with
> `allow-passthrough=all` — the setting on the reference machine — tmux forwards a passthrough
> payload to the client no matter which window that client is viewing, and the payload's absolute
> cursor move then lands the frame on whatever window the user is actually looking at. Under `on`,
> tmux withholds it correctly; under `off` the route is silently dead. So a shared runtime writing
> per-pane ttys must gate on its own `terminalVisible` and must read `allow-passthrough` rather than
> assume tmux protects it.

## 6. Input handling (Browser mode)

### 6.1 The input path

```text
Ghostty (local)
    ↓ keyboard/mouse events (Kitty keyboard protocol, SGR pixel mouse)
tweb __pane (raw terminal mode)
    ↓ decide the tmux mode: TMUX mode or BROWSER mode
    ↓ BROWSER mode: forward the input to twebd
twebd
    ↓ forwards the input event to the Electron main process
Electron
    ↓ webContents.sendInputEvent() (Chromium input injection)
    ↓ Korean IME: the BrowserWindow does native composition via macOS NSTextInputClient
```

### 6.2 Browser mode (DESIGN.md section 9)

```text
TMUX mode: every key → the tmux key table (root)
BROWSER mode: the reserved toggle returns to tmux, every other key goes to the browser pane

entering the mode: switch-client -T tweb-browser
surfacing the mode: terminal title/OSC, tmux pane-border-format, a browser toolbar badge
when client_key_table and the real browser focus disagree, stop forwarding input and recover to TMUX mode
```

### 6.3 Korean IME (the local case)

```text
macOS IME → Ghostty NSTextInputClient → ... → tweb __pane → twebd → Electron
    though, the Electron BrowserWindow being a macOS window, it receives NSTextInputClient directly
    the in-progress composition state shows live in the browser input field (native)
    commit-then-act on arrow keys/delete (same as the Ghostty #11461 fix)
```

**Caution**: whether the macOS IME activates at all when the Electron BrowserWindow is offscreen
(frameless, never displayed) needs confirming. An offscreen window is not the first responder and may
receive no IME events. This is an S1/P3 validation item — does the native IME work in an offscreen
window, or must `setMarkedText`/`insertText` be injected manually through the input injection path?

## 7. Extension loading

> **Nothing here is implemented.** No code in `electron/` calls `loadExtension`, and no extension is
> unpacked or loaded on any run. The vimium-like key handling that ships is TWeb's own preload
> (`electron/preload.cjs`), which is a different mechanism with different limits — it cannot host a
> third-party extension such as 1Password.

### 7.1 The Electron extension API

```js
const { session } = require('electron')

// load an unpacked extension
await session.defaultSession.loadExtension('/path/to/vimium')

// extensions reload on every run (they are not persistent)
// Web Store installs are unsupported; unpacked only
```

### 7.2 TWeb extension management

```text
tweb profile bootstrap chrome
    ↓ read the extension metadata from the user's Chrome profile
    ↓ preserve the Web Store IDs
    ↓ unpack the extensions into the TWeb data dir and store them
    ↓ load them on every run via Electron session.loadExtension()

extension compatibility classes:
    compatible — can be reinstalled automatically
    needs-adapter — needs host support such as native messaging
    managed-chrome-only — depends on Device Trust or enterprise policy (1Password, Okta)
```

### 7.3 Native Messaging hosts (1Password and the like)

```text
Electron extension (1Password)
    ↓ chrome.runtime.connectNative('com.tweb.bridge')
Native Messaging host (a Rust binary, managed by twebd)
    ↓ stdin/stdout JSON, 32-bit length prefix
    ↓ secure enclave / credential store access
```

Extensions for which TWeb would have to implement a Native Messaging host itself (1Password and the
like) are `needs-adapter`. Whether 1Password's existing host binary can be reused needs confirming,
though.

## 8. Measurement items (the S1/P1 release gate)

```text
frame pacing
├── 0 frame transfers while a static page is idle
├── 60Hz frame pacing during a 1080p continuous scroll
├── 0 stale image/shm objects after 10 minutes of animation
├── only the new generation displayed within 2 display frames after a resize
└── 0 CPU full-frame copies (confirming dirty tiles only are transferred)

memory (against Orca)
├── RSS, private dirty and PSS at 1/2/4 panes
├── an idle pane frontend owns no frame-sized buffer
├── a hidden page's GPU/SHM surface bytes converge to 0
└── resource counts and private bytes return to baseline after page close/renderer crash

input
├── the Korean 2-set IME composition shows live (in an offscreen window)
├── commit-then-act on arrow keys/delete
├── bracketed paste, OSC 52 clipboard
└── mouse: pane border resize separated from interior events

extension
├── link hints and scrolling work after installing vimium
├── the panel works after installing React DevTools
└── 1Password native messaging connects
```

### 8.1 Addendum — measured frame costs (2026-08-14)

> **These measurements describe the path as it was before the work they prompted.** The whole-frame
> PNG encode below is no longer what ships: damage now goes out as a cropped patch, and a whole frame
> travels as raw pixels through the worker with PNG as the fallback. Section 8.3 records the path
> that ships. The numbers here are why it changed, and they stay because a later reader needs to know
> what the alternative cost.

Sections 1–3 were designed against research, not measurement. These numbers come from the then-shipping
Electron path on an M-series mac, Electron 43.2.0, a 1440×900 pane at `deviceScaleFactor: 2`
(2880×1800 frame, 20.7MB raw), with **no** `disable-gpu-compositing` — the flag the shipping
`main.cjs` does not set, so this is the production configuration. Three page profiles: `text` (a
code-like document), `mixed` (cards plus noise canvases), `photo` (a full-viewport noise canvas).

```text
whole-frame encode, on the Electron main thread (the path as it then was)
├── image.toPNG()      text 23ms | mixed 28ms | photo 101ms
├── image.toBitmap()   1.4–5.9ms   (the copy, not the encode)
└── image.getBitmap()  1.4–2.0ms   (a view; no copy)

partial encode, after image.crop() — crop itself is 0.00–0.01ms
├── crop   64×32  + toPNG   0.02–0.04ms      0.4–5.2KB
├── crop  400×200 + toPNG   0.15–0.49ms     10–198KB
└── crop 1440×120 + toPNG   0.22–1.02ms     10–426KB

raw RGBA, no PNG (f=32 territory)
├── whole frame, BGRA→RGBA in JS + write   16–37ms      19.8MB
└── one 512×512 tile, same in JS + write   1.5–1.9ms     1.0MB
```

The damage measured during interaction, sampled from the `paint` event's dirty rect:

```text
typing/caret   p50 dirty ≈ 30×30 px          — the frame after it is whole-frame
scroll         p50/p90/max all whole-frame   — no partial damage at all
hover          no frames
```

Three conclusions, each of which changes what section 3's tile strategy should optimize for:

1. **The dominant cost is a whole-frame PNG encode running synchronously on the main thread.** At
   28ms for an ordinary page it already exceeds a 30fps budget on its own, and it blocks input
   handling for that whole time. Section 2.1 attributed awrit's bottleneck to copies and syscalls;
   for TWeb, as shipped, the encode alone outweighs all of them.
2. **`crop` is free and partial encodes are 100–1000× cheaper.** A caret blink costs 0.02ms of
   encode against 28ms today. This is the single largest available win, and it needs nothing outside
   `main.cjs` and `gfx-worker.cjs`.
3. **Damage is bimodal — tiny or whole-frame.** The 256×256 adaptive tile grid in section 3.1 is
   sized for a middle case the measurements do not show. A tiny-damage patch path plus a whole-frame
   path covers what actually happens; the tile grid is an optimization for a workload still to be
   demonstrated. All three conclusions have since been acted on. This one took longest because
   acting on it meant deleting rather than writing: section 8.4 records the measurements that
   settled it and the removal of `tweb-native`/`tweb-transport` that followed.

Two API facts worth recording, both contradicting section 1:

- **`beginFrameSubscription(true, …)` does not honour `onlyDirty` on Electron 43.** The callback
  receives the whole frame with the dirty rect equal to the full size, and measured *slower* than
  the `paint` event (83–100ms vs 23–101ms). Section 1.2's dirty-only subscription is not available.
- **Encoding PNG on a worker thread is a regression, not a fix.** Handing raw pixels to a worker
  costs ~4–5ms of main-thread time (`getBitmap` plus a transferable copy), but a hand-rolled
  zlib PNG encode there takes 60ms (text) to 1256ms (photo) — far worse than Chromium's native
  encoder. The way off the main thread is to encode *less*, not to encode elsewhere.

### 8.2 Addendum — terminal capability probe (Ghostty 1.3.1, 2026-08-14)

Both remaining unknowns were probed against a real Ghostty tty. The probes had to run outside tmux:
graphics responses (`q=0`) do not travel back through DCS passthrough, which is why the shipping code
sends everything with `q=2`. `bench/gfxprobe.py` reproduces them.

**`t=s` shared memory works, and Ghostty really reads it.** An `a=T,f=32,t=s` transfer of a correctly
sized POSIX shm object answers `OK`, and the object is **unlinked afterwards** — reopening it without
`O_CREAT` fails. Only a terminal that opened and consumed the object can do that, so this is a real
transfer, not an acknowledgement of a name it ignored. Section 2.2's SHM ring has a working consumer
on the default terminal.

One caveat for whoever implements it: **Ghostty does not size-check the shm object.** An object at
half the size implied by `s=`/`v=` is still answered `OK` on `a=T` (and `a=q` never reads the payload
at all, so it answers `OK` regardless — `a=q` cannot be used to validate a transfer). The binary does
carry a `shared memory size too small expected= actual=` string, but nothing tripped it here, so do
not rely on it: the producer owns the size contract, and getting it wrong yields garbage pixels
rather than an error.

**The patch-overlay mechanism is supported.** The measured plan for tiny damage — leave the base
frame in place, transmit the damaged region as its own image, place it over the base, and drop it
later — was verified step by step through the protocol:

```text
base transmit + place (i=9110)         OK
patch transmit + place over it (i=9111) OK
re-place base while patch is up         OK   — both images coexist
delete patch only (a=d,d=I,i=9111)
re-place base                           OK   — the base survives the patch delete
re-place patch                          ENOENT: image not found  — the patch is really gone
64 independent image ids in sequence    64/64 accepted
```

The base and the patch are independent images at the same `z=-1`, and deleting one leaves the other
intact — which is what a patch path needs, and it needs no `a=f` composition support.

Those OK responses prove lifetime, not drawing order, so stacking was checked separately by eye: a
red base placed in a tmux pane with a small green patch placed over it afterwards **shows the green
patch on top**. Within one `z`, later placement wins, so base and patch can share `z=-1` and keep the
IME layering that section 9's mode indicator depends on. Should a future terminal order them the
other way, the fix is to split the levels — base at `z=-2`, patch at `z=-1` — which stays below the
text either way. That check also exercised the patch path through tmux passthrough with two image
ids; `replacePlacement()` only ever proved passthrough for re-placing a single id.

Patch geometry — the one piece the terminal probes could not settle — was settled in
implementation instead, and it turned on a unit question section 1.1 leaves unstated: **a
`paint` dirty rect is in the frame's own pixels, not DIP.** A 637x189 DIP window at
`deviceScaleFactor: 2` reports a 1274x378 frame and a whole-frame dirty rect of exactly
1274x378, and `NativeImage.crop` takes the same space. Scaling a dirty rect by the device
scale factor therefore scales it twice, pushing every patch toward the bottom-right of the
pane where it clamps — a failure that reads as "the caret happens to be near the bottom"
rather than as a units bug, and which unit tests will happily confirm if they were written
against the same assumption. `electron/patch-geometry.cjs` works in frame pixels throughout,
and derives the cell size from the frame rather than the pane, since `C=1,c=,r=` already
makes the terminal scale the frame into the cell box.

The other implementation constraint is where a patch is allowed to address. `CUD` stops at
the last row of the **terminal**, not of the pane, so relative motion from the pane origin —
the obvious fit, since `anchorTmuxGraphics` has already parked the cursor there — silently
clamps for any pane low on a tall screen. Observed: a pane at `top=51` asking for row 21
within itself walked to row 73, ran out of screen, and drew a full-width patch across
whatever pane occupied the bottom of the terminal. Patch motion is therefore absolute,
computed as the pane origin plus the patch's own cell and clamped to the pane's grid, so it
can neither walk off the end nor address a cell it does not own. It still cannot use its own
DECSC/DECRC — the terminal's single save slot already belongs to the wrapper — so the cursor
is restored by addressing the origin again.

A patch also has to repaint more than the frame that triggered it. Patches accumulate, and
nothing restores what an earlier one painted outside a later one: typing lays down a wide
patch, backspacing lays down a narrow one, and the deleted character survives in the strip
the new patch does not reach. Each patch therefore covers the union of all damage since the
last whole frame, which the whole-frame path resets.

### 8.3 Addendum — the whole-frame path without PNG (2026-08-14)

Section 8.1 found the whole-frame PNG encode dominating, and section 8.2 confirmed the terminal
reads shared memory. The encode turned out not to need shared memory at all: **`f=32` is
independent of the transfer medium**, so raw pixels travel over the same `t=f` file transport the
shipping code already used, and the encode simply goes away. No native shm module, no ring buffer,
no ACK protocol.

Same pane and page profiles as section 8.1 (2880x1800 frame, 20.7MB raw):

```text
             main thread   worker   on the wire
png   text        23.0ms    0.5ms         576KB
      mixed       28.0ms    0.7ms        1478KB
      photo      100.5ms    3.0ms       12780KB

raw   text         1.3ms   12.5ms       20250KB
      mixed        1.4ms   24.3ms       20250KB
      photo        1.5ms   22.8ms       20250KB
```

Only the main-thread column decides input latency, and it collapses to a constant ~1.4ms — the cost
of `toBitmap`, which is a copy rather than an encode, and so no longer depends on what is on the
page. The worker pays more (a BGRA→RGBA pass plus a 20MB write against a 1.5MB one), but that time
sits behind the one-deep queue that already drops superseded frames, and the wire size never reaches
the terminal as escape-sequence bytes: the file medium sends a path.

The ~9ms channel swap is the one remaining CPU pass over the frame, and it stays in JS. It was
written here as the place `tweb-native`'s SIMD conversion would finally earn its keep; section 8.4
measured that claim and found no SIMD to move and nothing for it to win. The crate is gone.

Two constraints on when raw can be used:

- **It needs the file medium.** 20MB does not fit an escape sequence, and `t=d` is the fallback for
  when a frame file cannot be written — so `TWEB_FRAME_TRANSPORT=direct` keeps PNG. A raw frame has
  no such fallback inside the worker, which holds pixels rather than an encoder, so repeated write
  failures switch raw off for the session and let the PNG path take over.
- **Raw and PNG use separate paths.** The terminal is told the format in the header, not by
  extension, so a stale file of the wrong kind would be read as whatever the header claimed.

What raw costs, and why `t=s` is still worth doing: the wire carries a path, but the disk carries
the whole frame. At 20MB per frame that is ~20MB/s for an idle animation at 1fps and several hundred
MB/s during a scroll — roughly 13x the PNG path's bytes. Shared memory removes that write entirely,
and section 8.2 already established the terminal supports it; what stops it here is that macOS has
no `/dev/shm`, so `shm_open` needs a native module, and the file medium reaches the same
main-thread number without one.

Probed before implementing, since both were assumptions:

- **`t=s` works through tmux passthrough** — the shm object is consumed when the pane is visible.
  The control matters here: in a *hidden* pane neither `t=s` nor a temp-file transfer is consumed,
  because Ghostty never draws it, so a probe run against a hidden pane reads as a protocol failure
  when it is only a visibility one.
- **`f=32` over `t=f` renders correctly**, verified by eye with a deliberately asymmetric test image
  — a white band over a magenta/yellow split, where a channel swap or a stride error is obvious.

### 8.4 Addendum — the tile pipeline was deleted (2026-08-14)

`crates/tweb-native` (damage tiling, BGRA→RGBA conversion, an SHM ring, a Kitty transport) and
`crates/tweb-transport` (which wrapped it) are removed. 1113 lines and 10 tests. This section records
what was measured, since a later reader will find the crates in git history and needs to know why
they are not here.

The obvious alternative was to keep the crate and finally use it: section 8.3 named the ~9ms channel
swap as the one remaining per-frame CPU pass and the place `tweb-native`'s SIMD conversion would earn
its keep. That is the claim that was measured, and it failed on every term.

**There was no SIMD to move.** `simd` appeared twice in the whole repository, both times in a comment
describing code nobody had written. `convert.rs`'s conversion was a scalar `chunks_exact(4)` byte
swap — the same algorithm as the JS loop in `gfx-worker.cjs`, in a different language.

**The swap is memory-bandwidth bound, so SIMD had no headroom to win.** Same 20.7MB frame as 8.1/8.3
(2880×1800 BGRA), 30 iterations after 5 warmup, medians. `bench/convert-bench.rs`, `rustc -O`:

```text
copy only, no swap at all (the memcpy floor)   0.347ms
scalar loop, as tweb-native had it             0.431ms
u32 form, the one that autovectorizes          1.140ms
```

Swapping channels costs 1.24× a bare copy of the same bytes, so the work is already at the floor —
there is nothing between 0.431ms and 0.347ms for a hand-written NEON kernel to take. The third line
is a warning for anyone who tries anyway: the "optimized" u32 shuffle is 2.6× *slower* than the naive
loop, because LLVM already vectorizes `chunks_exact(4)` and the manual form defeats it.

**And the swap was not the expensive half of the worker.** `bench/convert-bench.cjs`, node v25.8.1,
same frame:

```text
swap, bytewise (what ships)      p50  7.43ms    p90  7.93ms
swap, u32 (JS, no bridge)        p50  2.94ms    p90  3.01ms
write 20.7MB + rename            p50 17.69ms    p90 64.72ms
whole worker pass, as it ships   p50 11.58ms
```

**The 17.69ms write above is wrong — see 8.5.** It is a benchmark artifact, not the shipping path's
cost: writes to 20MB files are bimodal and dominated by writeback pressure, so a benchmark measures
whatever disk state it happens to create. Under sustained scroll-like load the figure is p50 6.11ms
with a p99 of 36.92ms. The conclusion below survives the correction — the write is still the larger
term and a Rust bridge still cannot touch it — but do not quote the number.

8.3 attributed the worker's 12.5–24.3ms to "a BGRA→RGBA pass plus a 20MB write" without splitting
them. The write is the larger term, and its p90 alone is 9× the entire swap. A Rust bridge cannot
touch it.

So the arithmetic of wiring it up: 7.43ms → 0.43ms is 7.0ms saved at best, of which ten lines of JS
(the u32 form, which is faster in JS even though it is slower in Rust) get 4.5ms for free. The
bridge's marginal value over doing nothing but editing `gfx-worker.cjs` is 2.5ms — of *worker* time,
which 8.3 already established does not decide input latency, on frames the one-deep queue is
discarding anyway (`droppedByBackpressure` was 358 on the pane measured below). Buying that needs a
napi/node-gyp toolchain this repository does not have, per-platform `.node` binaries, and an entry in
both the `engine_app.rs` embed list and the `electron-check` target. It is a bad trade by about an
order of magnitude.

**The shipping binary had already thrown the crates away.** The measurement that should have been
taken first:

```text
nm -a target/release/tweb | grep -c 'tweb_native\|tweb_transport'      0
strings target/release/tweb | grep -c 'TileGrid\|ShmRing'              0
```

The linker dead-stripped both crates out entirely. They were compiled on every build and discarded.
The two dependency edges that pulled them in — `tweb-transport.workspace = true` in
`crates/tweb-pane/Cargo.toml` and `crates/twebd/Cargo.toml` — were declared and never used; neither
crate's `src/` contained the string `tweb_transport`. Confirmed against a live pane: `tweb diag`
reported `wholeFormat: "raw"`, 23076 whole frames and 252 patches, all through `gfx-worker.cjs`.

The remaining argument was to keep it for the twebd path of DESIGN.md 5.1. It does not survive
reading the code as something a twebd implementer would inherit:

- **`shm.rs` was not shared memory.** `ShmBuffer::create` was `vec![0u8; size]` followed by
  `mem::forget`, with a TODO for the real `shm_open`; `destroy()` was `let _ = self.ptr;` and freed
  nothing, so a ring leaked its whole allocation on every resize and drop — 41MB at the measured
  frame size. `ShmRing::resize` read `self.buffers.len()` *after* `mem::take` emptied it, so the
  replacement count was always 2 and a 3-buffer ring silently became a 2-buffer one.
- **The SHM transfer it existed for was a stub.** The `SharedMemory` arm of `kitty.rs::encode` sent
  an empty payload under `// TODO: include the SHM name in the header`, and `tweb-transport` wrote
  the frame into SHM and then transmitted the whole thing as `KittyMedium::Direct` regardless.
- **Its Kitty writer could not work in tmux.** `write_to_stdout` wrote bare APC sequences with no
  passthrough wrapping anywhere in the crate, and tmux is the primary supported configuration.
- **The tile grid targeted the workload 8.1 measured as absent**, which is where this started.

Inheriting that is not a head start on twebd; it is scaffolding that is wrong about the protocol,
wrong about the workload, and leaking, plus the time to find that out. It is in git at `0f1c3b1`
(last touched in `c6255a6`) for anyone who wants to read it.

What the removal recovered: 41.3MiB of `target/` and 666 object files (`cargo clean -p tweb-native -p
tweb-transport`), and 3.98s of the compile of every clean build. The benchmarks stay under `bench/`,
because the next person to propose a native module for this should have to beat these numbers rather
than re-derive them.

### 8.5 Addendum — the SHM and tile items, reopened and closed again (2026-08-18)

8.4 rejected an SHM transfer and a tile pipeline. Both were reopened to ask what had changed. The
answer is *nothing about the blockers*, but the reopening produced three results 8.4 did not have:
one correction to a number recorded here, one shipped change, and one item that moves from "blocked"
to "priced".

**Correction: the 17.69ms write in 8.4 is not the shipping path's cost.** Trying to beat it produced
29.67ms for the same operation, then 4.67ms, on the same machine within the hour. Interleaving the
variants explains the spread — the write cost is bimodal and dominated by writeback pressure, not by
the call shape. A benchmark that writes a few frames has its writes absorbed by the page cache; one
that writes hundreds of distinct 20MB files does not, and the first version of this measurement was
accumulating 1.5GB of them. That accumulation, not any property of `writeFileSync`, was the 29.67ms.

Under sustained load resembling a scroll — 300 consecutive whole frames, the same 2880×1800 — the
shipping path costs:

```text
write + rename (ships today)          p50  6.11ms   p99  36.92ms
pwrite into preopened, alternating    p50  2.83ms   p99   3.64ms
```

So the honest figure for the shipping write is ~6ms with a 37ms tail, not 17.69ms. **The tail is the
part that matters**: p50 is under a frame budget either way, and what drops frames is the p99.

**The 3.3ms/34ms gap is real but cannot be taken with files.** `rename` is not one of several ways to
avoid a sheared frame; it is the only one available here, and the reason is `open`/`inode` semantics
rather than timing. A terminal that has opened the frame file holds *that inode*: renaming a new file
over the name cannot disturb the bytes it is reading. Writing in place has no such property, and no
amount of path rotation restores it — a 2-deep or N-deep ring only makes the collision rarer, and
"rarer" is not a guarantee when the reader's deadline is unbounded. It is unbounded here: the
sequence is emitted through tmux passthrough with `q=2`, so there is no ACK and no upper bound on
when the terminal reads. Measured variants and their disposition:

```text
open(no O_TRUNC) + write + rename     p50  5.89ms   p99  24.35ms   safe, but not actually different
pwrite preopened + link/unlink swap   p50  3.22ms   p99   8.01ms   unsafe: same inode reused
```

The first looked like a 2× tail win until the runs were interleaved, at which point the sign flipped
(round 3: 30.0ms against 7.8ms, p99 1104ms) — noise, and the machine's 20MB write tail is governed by
system state rather than by call shape. It could not have been anything else: `rename` consumes the
staging name, so every frame necessarily creates a fresh inode. **Within the file medium there is no
variant to find. The p99 tail is the price of the safety guarantee, and it is not negotiable.**

**This prices SHM rather than unblocking it.** 8.4's blocker is intact — verified again: `node:ffi`
is unavailable, `electron/package.json` has zero native dependencies, and macOS has no `/dev/shm`
(`bench/shm-through-tmux.py` reaches `shm_open` only through Python's `ctypes`). What changed is that
the pwrite line above is no longer an unreachable number. A fresh `shm_open` object per frame gives
the same fresh-object guarantee `rename` gives, without the disk, so **~p50 2.8ms / p99 3.6ms is what
SHM would buy: roughly 3ms of p50 and 33ms of p99 tail per whole frame.** That is a real number
against a real cost (a native addon, a napi/node-gyp toolchain, per-platform binaries).

That was as far as microbenchmarks could take it, and it understates the case: measured on the real
pipeline further down, the disk write is not merely slower than SHM would be — it is the **only**
thing discarding frames at the real frame size, and removing it takes `droppedByBackpressure` from
~244 to 0. Read the two together before deciding; the paragraph beginning "At the real payload" has
the numbers that matter.

**Shipped: the u32 swap.** 8.4 measured it (7.43ms → 2.94ms, reproduced here as 6.58ms → 2.90ms) and
left it unapplied, so `rawCommands` was still paying ~3.7ms per whole frame for a change requiring no
new dependency. It is now in `gfx-worker.cjs`, with two guards the benchmark did not need: a
`Uint32Array` view requires 4-byte alignment at both ends and `Buffer.allocUnsafe` under 4KB comes
out of a shared pool at an arbitrary offset, so a misaligned buffer falls back to the byte loop
rather than throwing `RangeError` and losing the frame; and the masks name channels by little-endian
bit positions, so a big-endian host takes the same fallback.

Note the direction reverses between languages, which is why 8.4's Rust table must not be read as
advice for the JS: in Rust the u32 form is 2.6× *slower* (LLVM already vectorizes `chunks_exact(4)`
and the manual shuffle defeats it), while in JS it is 2.3× faster.

Verified two ways, because agreement is not correctness. `gfx-worker.test.cjs` proves `swapU32`
matches `swapBytewise` byte-for-byte over every channel value, and covers the misaligned fallback —
but both could be wrong together if Chromium's bitmap were not the byte order both assume. So
`bench/channel-order.cjs` renders a page of known colours offscreen, runs the real `rawCommands`, and
reads the colours back out of the file it produced:

```text
RED     present=5597px  r/b-swapped=0px      ORANGE  present=2069px  r/b-swapped=0px
BLUE    present=3877px  r/b-swapped=0px      AZURE   present=2646px  r/b-swapped=0px
CYAN    present=2810px  r/b-swapped=0px
```

The `r/b-swapped` column is the verdict: for a band whose R and B differ, a channel error moves every
pixel to the twin colour, so `present>0, swapped=0` is the signature of a correct swap and its exact
reverse is the signature of a broken one. (Bands with R=B — green, white, black, magenta — are
invariant under the swap and report equal counts by construction.) The harness judges by *presence*
rather than by the most common colour, because the bands carry 34px white text and in two of them the
text outnumbers the background (measured `rgb(255,255,255)x2831` against `rgb(255,128,0)x2069`);
ranking by frequency there measures the font weight, not the channel order.

**At a quarter of the real payload the 3.7ms buys nothing.** Measured A/B, same binary, the swap
selected at runtime, rendering a page that repaints whole frames continuously - 30 seconds of steady
state per arm, run in both orders:

```text
u32        839 frames / 30s   28.0fps   droppedByBackpressure 0
bytewise   838 frames / 30s   27.9fps   droppedByBackpressure 0
u32        839 frames / 30s   28.0fps   droppedByBackpressure 0   (order reversed)
bytewise   839 frames / 30s   28.0fps   droppedByBackpressure 0
```

Identical, and nothing was ever dropped. This is 8.3's finding arriving again from the other side:
the worker is not the constraint, so making the worker faster moves no user-visible number. The frame
rate is pinned by the 30fps cap and the engine keeps up either way with ~3ms of headroom to spare.

Keep the u32 form anyway - it is strictly less work for the same result, and it is the headroom that
absorbs a larger surface or a slower machine before either becomes a dropped frame. But **do not
claim it as a speedup.** The honest statement is that a whole frame now costs ~3.7ms less CPU in the
worker and that this is currently invisible downstream.

**At the real payload the picture reverses, and it identifies the bottleneck.** The run above was
5.2MB per frame: the PTY was 1440x900, and a rendered frame is the viewport's own pixel size
(`renderedFrameSize`), not that size again multiplied by a scale factor. Every figure in 8.1/8.3/8.4
is 2880x1800 = 20.7MB. Repeating the same sustained run at that size:

```text
u32        805 frames / 30s   26.8fps   droppedByBackpressure 244
bytewise   806 frames / 30s   26.9fps   droppedByBackpressure 266
u32        805 frames / 30s   26.8fps   droppedByBackpressure 240
bytewise   806 frames / 30s   26.9fps   droppedByBackpressure 192
```

Backpressure is real at the real size - roughly a quarter of frames discarded - and **the swap does
not touch it.** The arms are indistinguishable, and the lowest count of the four belongs to bytewise.
So the conclusion above survives in the form that matters: the channel swap is not the constraint at
either payload size. It is 3.7ms of CPU that no user-visible number is waiting on.

What *is* the constraint was then measured directly, by a probe that skips the frame write and
returns the path as though the frame had reached the terminal for free - which is exactly the term an
SHM transfer removes:

```text
u32 (writes the file)      dropped 244, 240, 134
no write at all            dropped 0, 0
```

**The disk write is the entire source of the drops.**

Why the swap makes no difference to that, stated as budget rather than as a null result
(`bench/frame-budget.cjs`, same 20.7MB frame, against the 33.3ms a 30fps cap allows):

```text
whole rawCommands (ships)      p50   12.69ms   p90   41.85ms   p99   57.44ms      38% / 172% of budget
  of which: swap u32           p50    2.88ms                                       9% of budget
  of which: swap bytewise      p50    6.76ms                                      20% of budget
  of which: write (derived)    p50    9.77ms   p90   38.69ms   p99   54.49ms      29% / 164% of budget
```

The swap is worth 3.9ms, or 12 points of the budget. At p50 that is spare capacity nobody is waiting
on, and in the tail — where frames are actually lost — the write alone is already at 164% of budget,
so removing 12 points still leaves it over. That is the arithmetic behind two arms of an A/B being
indistinguishable: the swap cannot decide a frame that the write has already overrun. It also says
what a fix has to clear. Anything that leaves the write's p99 above 33.3ms keeps dropping frames no
matter what else it improves. That reframes the SHM item one last time. It is
no longer "priced but invisible": at the real frame size, on the real pipeline, the file medium is
the only thing discarding frames, and removing it removes all of them. The blocker is still what 8.4
said - no `node:ffi`, zero native dependencies, no `/dev/shm` on macOS, so it needs a native addon
and the napi/node-gyp toolchain that comes with it - but the thing it would buy is now measured
rather than argued: **~24% of whole frames at 2880x1800/30fps, currently dropped.**

**Superseded by 8.6.** The recommendation above was to build the addon if whole-frame throughput at
Retina size mattered. It stopped being necessary: `o=z` buys the same ~24% back with `zlib`, and 8.6
has the measurements. Read this section for why the write is the bottleneck, and 8.6 for what was
done about it.

Getting this measurement needed a route around the visibility gate: frame emission stops when the
tmux surface is not on screen (`recordVisibility` in `main.cjs`), so `whole` stayed 0 across three
attempts opened from a non-active window. Running on a bare PTY outside tmux avoids it - with no
`tmuxPlacement`, `syncTmuxVisibility` returns immediately and `pane-registry.cjs`'s `visible = true`
default stands. `bench/` has no harness for this; it is a few lines of `pty.fork` plus a
`TIOCSWINSZ` to fix the frame size, and worth rebuilding for any future claim about frame
throughput.

**The tile strategies stay unimplemented, and the damage distribution is why.** DESIGN 7.3 lists
three, with `detect_capability` hardcoding all three to false. Re-sampled today with `bench/damage.cjs`
on all three page profiles, this engine, this Electron:

```text
              scroll                              caret
text     59 frames, dirty p50 400% (2880x1800)   19 frames, dirty p50 0% (15x30, 30x30)
mixed    58 frames, dirty p50 400% (2880x1800)   18 frames, dirty p50 0% (30x30, 36x30)
photo    no frames at all                        18 frames, dirty p50 0% (30x30, 36x30)
```

8.1's finding is unchanged and now confirmed across profiles: damage is **bimodal**. Scrolling is
whole-frame 100% of the time with no partial damage to exploit, and typing is a caret-sized rect two
orders of magnitude below any useful tile. A 256×256 adaptive grid is sized for a middle case that
does not occur, and the shipping code is right to choose between "whole frame" and "crop the damage"
per frame by measured size rather than by terminal capability. Independently, the per-capability
branch could not be reached in the primary configuration anyway: a capability query needs a response,
and responses do not come back through tmux passthrough (DESIGN 7.3), which is why `q=2` is on every
sequence. *Reopens on:* a measured workload with sustained mid-sized damage, or a bare-tty
configuration becoming primary.

### 8.6 Addendum — the frame drops are fixed, and not by SHM (2026-08-18)

8.5 ended with the write identified as the only source of dropped frames and SHM as the way to
remove it, blocked on a native addon. Both halves turned out to be answerable without one. The
drops are gone; the fix is four lines of `zlib` and a decision about when to use them.

**First, the addon shortcut that does not work — recorded so nobody spends a day on it.** 8.4's
reasoning was that Node cannot call `shm_open`. True, but Node does not need to: `crates/tweb-pane`
already depends on `libc` and already spawns the engine, so the Rust parent could create the object
and let the child inherit the fd. Node writes to numeric fds happily. Measured
(`bench/shm-fd-inherit.py`):

```text
fd inherits fine     child fstat: size=20742144, mode=2720
pwrite  -> ESPIPE    a shm object is not seekable
write   -> ENXIO     a shm object does not support write() at all
mmap    -> OK        the only way in, and Node has no mmap
```

So the blocker was never naming the object — passing the fd solves that completely. It is that a
POSIX shm object on macOS is a *mapping, not a stream*, and every route into it goes through `mmap`,
which nothing in Node's surface reaches. The addon requirement is real and one layer deeper than
8.4 stated.

**Second, and this is the fix: the protocol already compresses.** `o=z` declares a deflated payload
and the terminal inflates it before decoding, so what reaches the disk is the compressed bytes. It
had never been probed here, so `bench/gfx-deflate.py` asks Ghostty 1.3.1 directly — on a bare tty,
since responses do not survive tmux passthrough:

```text
A. uncompressed, t=f          OK
B. o=z deflated, t=f          OK          16384B -> 111B
C. o=z with corrupt data      EINVAL: decompression failed
D. o=z over t=d (direct)      OK
```

C is the case that makes B mean something: a terminal that answered OK to a corrupt deflate stream
would not be decompressing at all. This one rejects it by name, so the acceptance in B is real.

**It is not a free win, which is why it ships as a decision rather than a default.** Deflate is
paid in CPU on the frame it saves on disk, and for some content that is a bad trade:

```text
text-like frame     20.7MB -> 0.9MB    deflate ~21ms      worth it
mixed (measured)    20.7MB -> 2.5MB    deflate ~44ms      marginal
photo-like frame    20.7MB -> 10.0MB   deflate ~109ms     3x the whole 33.3ms budget, alone
```

Compressing a photo costs more than writing it. So the choice is made per frame, from a sample —
deflating a few contiguous chunks and letting their ratio stand in for the frame's. That prediction
is good enough for a threshold and cheap enough not to matter:

```text
                sample     full
photo 20.7MB     2.74x     2.08x      correctly below the 4x threshold
text  20.7MB    39.07x    39.22x      correctly above
```

The sampling method is worth stating because the obvious one is wrong. Taking one pixel every
`stride` bytes looks more representative and destroys exactly the local redundancy deflate lives
on — and its error depends on the frame size, so it fails invisibly at some sizes and not others.
Measured on photo pixels that really compress 2.08x, a strided sample reported **14.25x** on a
4.2MB frame and **1.97x** on a 20.7MB one. Contiguous chunks preserve the runs and track the real
ratio at every size.

**Result on a live engine**, same PTY harness and workload 8.5 used — deliberately the worst case,
a canvas repainting random colours, which is the content least friendly to compression:

```text
before (8.5)    805 frames / 30s   droppedByBackpressure 244, 240, 134
after           803 frames / 30s   droppedByBackpressure 0, 1
```

**The drops are gone.** The frame rate is unchanged because it was never the problem — it is pinned
by the 30fps cap, and 8.3's finding that the worker does not decide latency still holds. What
changed is that frames stopped being discarded on the way out.

**What this does to the SHM item: it closes it.** The thing SHM was going to buy — the ~24% of whole
frames the file write was discarding — has been bought without it. A native addon would still make
the write cheaper in absolute terms, but there is no longer a user-visible number waiting on it.
*Reopens on:* a measured workload that drops frames again with `o=z` in place (uncompressible
content at a frame rate above 30, most plausibly), at which point the addon is the next lever and
`bench/shm-fd-inherit.py` records why it has to be a real addon.

## 9. A component and interface structure built for extension

> **The traits below exist as Rust source; almost none of them have an implementation.**
> `crates/tweb-core/` carries `ExtensionHost`, `BrowserRoutingPolicy` and friends as trait and type
> definitions, and grep finds **zero implementors and zero callers** for most of them — the named
> `ElectronExtensionHost` / `ChromeExtensionHost` / `ShellExtensionHost` in §9.3 do not exist in any
> form. What ships routes through concrete code in `crates/tweb-pane/` and `electron/main.cjs`
> without going through these seams.
>
> This section is worth keeping as the intended shape of the extension points. It is not a map of the
> code, and §9.3's implementation matrix in particular reads as an inventory of things that are
> there. They are not there.

DESIGN.md proposed the `BrowserEngineAdapter`, `FrameTransport`, `BrowserRuntime` and `AgentBridge`
traits, but they need making concrete at the level of implementable Rust traits/protocols. The core
principle: **swapping the engine (Electron → a custom shell), swapping the transport (Kitty → video),
extending the agent bridges and extending platforms all happen behind trait boundaries and never
change the core API.**

### 9.1 The trait hierarchy

```text
core (platform- and engine-agnostic)
├── BrowserEngineAdapter    — the browser process abstraction. Electron, ExternalChrome, CustomShell
├── FrameTransport          — the frame delivery abstraction. KittyGraphics, NativeSurface, RemoteVideo
├── SurfaceSource           — the frame production abstraction. paint events, CDP screenshots, GPU textures
├── InputSink               — the input injection abstraction. webContents.sendInputEvent, CDP Input, host IME
├── ExtensionHost           — the extension loading abstraction. session.loadExtension, --load-extension
├── ProfileStore            — the profile abstraction. Electron sessions, Chrome profiles, a CEF user-data-dir
├── AgentBridge             — the agent delivery abstraction. ClaudeCode, Codex, Generic, ShellInbox
├── TerminalCapability      — the terminal capability abstraction. The Kitty query result
├── PlatformService         — the OS abstraction. IPC, handle transfer, credentials, paths
└── ResourceBroker          — the resource store abstraction. local, remote, scoped
```

### 9.2 The Rust trait definitions (the core of it)

```rust
// src/core/engine.rs
/// The browser process abstraction. Implemented separately by Electron/ExternalChrome/CustomShell.
/// The core API deals in pages/profiles/resources/automation and knows nothing of engine internals.
#[async_trait]
pub trait BrowserEngineAdapter: Send + Sync {
    /// Creates a page, tied to a pane identity.
    async fn create_page(&self, pane: PaneId, url: &str) -> Result<PageId>;
    /// Closes a page.
    async fn close_page(&self, page: PageId) -> Result<()>;
    /// navigation.
    async fn navigate(&self, page: PageId, url: &str) -> Result<()>;
    /// The frame production source. Consumed by FrameTransport.
    async fn frame_source(&self, page: PageId) -> Result<Box<dyn SurfaceSource>>;
    /// The input injection sink.
    async fn input_sink(&self, page: PageId) -> Result<Box<dyn InputSink>>;
    /// extension host.
    fn extension_host(&self) -> &dyn ExtensionHost;
    /// profile store.
    fn profile_store(&self) -> &dyn ProfileStore;
    /// A snapshot of the page state (for agent automation).
    async fn snapshot(&self, page: PageId) -> Result<PageSnapshot>;
    /// Executes an agent action (click/fill/press/scroll).
    async fn execute_action(&self, page: PageId, action: &Action) -> Result<()>;
}

// src/core/frame.rs
/// The frame delivery abstraction. Implemented separately by KittyGraphics/NativeSurface/RemoteVideo.
#[async_trait]
pub trait FrameTransport: Send + Sync {
    /// Selects a transport from the terminal capabilities.
    fn supports(&self, caps: &TerminalCapability) -> bool;
    /// Takes frames from a surface source and delivers them to the terminal.
    async fn stream(&self, page: PageId, source: Box<dyn SurfaceSource>) -> Result<()>;
    /// A change in page visibility.
    async fn set_visible(&self, page: PageId, visible: bool) -> Result<()>;
    /// page resize.
    async fn resize(&self, page: PageId, size: PixelSize) -> Result<()>;
    /// cleanup.
    async fn close(&self, page: PageId) -> Result<()>;
}

/// The frame production abstraction, implemented by the engine.
pub trait SurfaceSource: Send {
    /// The next frame or damage event. Backpressure is the implementation's job.
    fn next_frame(&mut self) -> Result<FrameEvent>;
}

pub enum FrameEvent {
    /// Dirty rects plus pixel data (the CPU bitmap path).
    Dirty { rects: Vec<Rect>, pixels: BitmapRef, generation: u64 },
    /// A GPU texture handle (the GPU fast path).
    Gpu { handle: SurfaceHandle, fence: SyncPrimitive, generation: u64 },
    /// The page is idle, no frame.
    Idle,
    /// The page ended.
    End,
}

// src/core/input.rs
/// The input injection abstraction, implemented by the engine.
#[async_trait]
pub trait InputSink: Send + Sync {
    /// Injects a key event.
    async fn send_key(&self, event: KeyEvent) -> Result<()>;
    /// Injects a mouse event.
    async fn send_mouse(&self, event: MouseEvent) -> Result<()>;
    /// Injects an IME composition (Korean).
    async fn send_composition(&self, event: CompositionEvent) -> Result<()>;
    /// Injects committed text.
    async fn insert_text(&self, text: &str) -> Result<()>;
}

pub enum CompositionEvent {
    MarkedText { text: String, range: Option<Range> },
    InsertText { text: String },
    UnmarkText,
}

// src/core/extension.rs
/// The extension loading abstraction, implemented by the engine.
#[async_trait]
pub trait ExtensionHost: Send + Sync {
    /// Loads an unpacked extension.
    async fn load_extension(&self, path: &Path) -> Result<ExtensionId>;
    /// Lists the extensions.
    async fn list_extensions(&self) -> Result<Vec<ExtensionInfo>>;
    /// Removes an extension.
    async fn remove_extension(&self, id: &ExtensionId) -> Result<()>;
    /// Connects to a native messaging host.
    async fn connect_native(&self, name: &str) -> Result<Box<dyn NativeMessagingChannel>>;
}

// src/core/agent.rs
/// The agent delivery abstraction. Implemented separately by ClaudeCode/Codex/Generic/ShellInbox.
#[async_trait]
pub trait AgentBridge: Send + Sync {
    /// Negotiates the resource kinds/mimes the agent can accept.
    fn accepts(&self) -> &AgentCapability;
    /// Delivers a resource.
    async fn deliver(&self, resource: &ResourceDescriptor, broker: &dyn ResourceBroker) -> Result<DeliveryStatus>;
    /// Checks whether the agent is alive.
    async fn is_alive(&self) -> bool;
}

pub struct AgentCapability {
    pub accepted_kinds: Vec<ResourceKind>,
    pub accepted_mime_types: Vec<String>,
    pub max_inline_size: usize,
    pub supports_direct_attachment: bool,
}

// src/core/platform.rs
/// The OS abstraction. Implemented separately per platform.
pub trait PlatformService: Send + Sync {
    fn local_ipc(&self) -> &dyn LocalIpcTransport;
    fn handle_transfer(&self) -> &dyn HandleTransfer;
    fn credential_store(&self) -> &dyn CredentialStore;
    fn browser_discovery(&self) -> &dyn BrowserDiscovery;
    fn paths(&self) -> &dyn PlatformPaths;
    fn process_supervisor(&self) -> &dyn ProcessSupervisor;
}
```

### 9.3 The implementation matrix (the extension points)

```text
BrowserEngineAdapter
├── ElectronAdapter          (src/electron/ — a TypeScript main plus a Rust native module)
├── ExternalChromeAdapter    (src/external/ — Rust, CDP WebSocket)
└── CustomShellAdapter       (src/shell/ — Rust + a C++ Chromium embed, the long-term move)

FrameTransport
├── KittyGraphicsTransport   (src/native/kitty.rs — SHM + Kitty graphics, local)
├── NativeSurfaceTransport   (src/native/surface.rs — IOSurface/DMA-BUF, Tier 3)
└── RemoteVideoTransport     (src/remote/video.rs — H.264/VP8 encode, remote)

InputSink
├── ElectronInputSink        (webContents.sendInputEvent + native IME)
├── CdpInputSink             (CDP Input.dispatchKeyEvent/insertText)
└── ShellInputSink           (Chromium TextInputClient setMarkedText/insertText)

ExtensionHost
├── ElectronExtensionHost    (session.loadExtension)
├── ChromeExtensionHost      (--load-extension)
└── ShellExtensionHost       (the Chromium extension API)

AgentBridge
├── ClaudeCodeBridge         (attachment RPC or a local file)
├── CodexBridge              (attachment RPC or a local file)
├── GenericTerminalAgentBridge (an inbox notification + tweb://resource/<id>)
└── ShellInboxBridge         (a shell inbox + a reference)

PlatformService
├── MacosPlatform            (IOSurface, Mach/XPC, Keychain, launchd)
├── LinuxPlatform            (DMA-BUF, SCM_RIGHTS, Secret Service, systemd)
└── WindowsPlatform          (DXGI, DuplicateHandle, DPAPI, Job Objects)
```

### 9.4 What a swap costs the core API

```text
Electron → CustomShell (long term)
    swap BrowserEngineAdapter
    no change to the core API (create_page/navigate/snapshot/execute_action)
    only the FrameTransport/InputSink/ExtensionHost implementations are swapped
    ProfileStore handles the profile migration

local → remote
    only FrameTransport changes, KittyGraphics → RemoteVideo
    the BrowserPageID/profile/automation APIs stay
    ResourceBroker judges locality and picks the transfer mechanism

extending agents (adding a new one)
    add an AgentBridge implementation
    AgentCapability negotiation adjusts the resource kinds/mimes automatically
    core knows nothing about agent kinds

extending platforms (adding a new OS)
    add a PlatformService implementation
    core knows nothing about the OS
```

### 9.5 The extension-point principles

1. **core knows nothing of engine/transport/agent/platform**: core sees only traits. Implementations
   are swapped behind `BrowserEngineAdapter` and friends.
2. **Adding an implementation changes no existing code**: adding a new `AgentBridge` implementation
   leaves core untouched. Capability negotiation adjusts automatically.
3. **Trait boundaries line up with process/IPC boundaries**: Rust↔TypeScript (Electron) is a C ABI or
   IPC; Rust↔C++ (the custom shell) is a C ABI. Traits live within a single process only.
4. **SurfaceSource/InputSink belong to the engine**: since the engine returns
   `Box<dyn SurfaceSource>`, frame production and input injection are the engine implementation's
   responsibility. core only consumes the traits.
5. **FrameTransport is chosen by capability**: `TerminalCapability` decides Kitty/Native/Remote. The
   transport can be swapped independently of the engine.

## 10. The implementation file structure (proposed)

> **Proposed, and diverged from.** The shipping layout has no TypeScript anywhere — `electron/` is
> plain `.cjs`, there is no `ipc.ts`, and the `native/` crate below was built and then deleted
> (§8.4). Read this as an intent sketch; `crates/` and `electron/` are the real map.

```text
tweb/
├── src/
│   ├── core/               (Rust, the platform/engine-agnostic core — trait definitions plus shared logic)
│   │   ├── mod.rs
│   │   ├── engine.rs       (the BrowserEngineAdapter trait)
│   │   ├── frame.rs        (the FrameTransport, SurfaceSource, FrameEvent traits)
│   │   ├── input.rs        (InputSink, CompositionEvent, KeyEvent, MouseEvent)
│   │   ├── extension.rs    (the ExtensionHost, NativeMessagingChannel traits)
│   │   ├── profile.rs      (the ProfileStore, BrowserProfile traits)
│   │   ├── agent.rs        (the AgentBridge, AgentCapability traits)
│   │   ├── platform.rs     (the PlatformService, LocalIpc, HandleTransfer, CredentialStore traits)
│   │   ├── resource.rs     (the ResourceBroker, ResourceDescriptor traits)
│   │   ├── page.rs         (PageId, PaneId, PageSnapshot — the shared types)
│   │   └── routing.rs      (BrowserRoutingPolicy — embedded/managed-chrome/remote/ask)
│   │
│   ├── twebd/              (Rust, the daemon — orchestrates using the core traits)
│   │   ├── main.rs
│   │   ├── ipc.rs          (Unix socket, peer credentials)
│   │   ├── page_registry.rs (pane ID ↔ page mapping, calls BrowserEngineAdapter)
│   │   ├── profile_manager.rs (uses ProfileStore)
│   │   ├── resource_broker.rs (implements ResourceBroker)
│   │   ├── automation.rs   (calls BrowserEngineAdapter.snapshot/execute_action)
│   │   ├── agent_bridge.rs (manages the AgentBridge implementations, capability negotiation)
│   │   └── tmux.rs         (tmux integration, hooks)
│   │
│   ├── pane/               (Rust, the tweb __pane frontend)
│   │   ├── main.rs
│   │   ├── terminal.rs     (TerminalCapability — the Kitty graphics query, raw mode)
│   │   ├── input.rs        (keyboard/mouse decoding, Browser mode management, calls InputSink)
│   │   ├── resize.rs       (SIGWINCH, pixel query, calls FrameTransport.resize)
│   │   └── display.rs      (consumes FrameTransport.stream, displays in Ghostty)
│   │
│   ├── engine/             (Rust, the BrowserEngineAdapter implementations)
│   │   ├── mod.rs          (engine selection: cfg or a runtime decision)
│   │   ├── electron/       (the Electron adapter — IPC with the TypeScript main)
│   │   │   ├── adapter.rs  (implements BrowserEngineAdapter, calls the TypeScript main over IPC)
│   │   │   ├── frame_source.rs (implements SurfaceSource — receives paint events)
│   │   │   ├── input_sink.rs   (implements InputSink — sendInputEvent + IME)
│   │   │   └── extension.rs    (implements ExtensionHost — session.loadExtension)
│   │   ├── external/       (the External Chrome adapter — CDP WebSocket, a long-term candidate)
│   │   │   ├── adapter.rs
│   │   │   ├── frame_source.rs (SurfaceSource — captureScreenshot)
│   │   │   ├── input_sink.rs   (InputSink — CDP Input)
│   │   │   └── extension.rs    (ExtensionHost — --load-extension)
│   │   └── shell/          (the custom Chromium shell adapter — the long-term move, the final hybrid)
│   │       ├── adapter.rs
│   │       ├── frame_source.rs (SurfaceSource — GPU texture export)
│   │       ├── input_sink.rs   (InputSink — TextInputClient)
│   │       └── extension.rs    (ExtensionHost — the Chromium extension API)
│   │
│   ├── transport/          (Rust, the FrameTransport implementations)
│   │   ├── mod.rs          (transport selection: decided by TerminalCapability)
│   │   ├── kitty.rs        (KittyGraphicsTransport — SHM + Kitty graphics, local)
│   │   ├── surface.rs      (NativeSurfaceTransport — IOSurface/DMA-BUF, Tier 3)
│   │   └── remote.rs       (RemoteVideoTransport — H.264/VP8 encode, remote)
│   │
│   ├── native/             (the Rust native module, shared optimizations — used by transport/engine)
│   │   ├── shm.rs          (the persistent SHM ring, no shm_open per paint)
│   │   ├── tile.rs         (dirty rect → adaptive tile mapping)
│   │   ├── convert.rs      (BGRA→RGBA SIMD, dirty tiles only)
│   │   └── kitty_proto.rs  (Kitty graphics transfer, bounded pools)
│   │
│   ├── platform/           (Rust, the PlatformService implementations)
│   │   ├── mod.rs          (platform selection: cfg(target_os))
│   │   ├── macos.rs        (IOSurface, Mach/XPC, Keychain, launchd)
│   │   ├── linux.rs        (DMA-BUF, SCM_RIGHTS, Secret Service, systemd)
│   │   └── windows.rs      (DXGI, DuplicateHandle, DPAPI, Job Objects)
│   │
│   ├── agent/              (Rust, the AgentBridge implementations)
│   │   ├── mod.rs          (agent registration, capability negotiation)
│   │   ├── claude_code.rs  (ClaudeCodeBridge — attachment RPC or a local file)
│   │   ├── codex.rs        (CodexBridge)
│   │   ├── generic.rs      (GenericTerminalAgentBridge — an inbox + tweb://resource/<id>)
│   │   └── shell_inbox.rs  (ShellInboxBridge)
│   │
│   └── electron/           (TypeScript, the Electron main process — IPC with engine/electron/)
│       ├── main.ts         (BrowserWindow management, the IPC server, loads the Rust native module)
│       ├── paint.ts        (paint event → the Rust native module, passes the dirty rect)
│       ├── extension.ts    (manages session.loadExtension)
│       ├── input.ts        (webContents.sendInputEvent, IME, CompositionEvent)
│       └── ipc.ts          (twebd ↔ Electron main process IPC)
│
├── extension/              (TypeScript, the TWeb Profile Bridge Chrome extension)
│   ├── manifest.json       (nativeMessaging, cookies optional, management)
│   ├── background.ts       (cookie transfer, connects to the native messaging host)
│   └── popup.ts            (the origin selection UI, permission requests)
│
└── tweb/                   (the CLI binary, Rust)
    └── main.rs             (tweb open/split/snapshot/click/profile/doctor)
```

### 10.1 Module dependency direction

```text
core (the trait definitions) ← twebd, pane, engine/*, transport/*, platform/*, agent/*
                               (all of them either implement or consume the core traits)

core knows no implementation at all (it only defines traits)
twebd orchestrates using the core traits (choosing implementations)
engine/* implements BrowserEngineAdapter + InputSink + ExtensionHost
transport/* implements FrameTransport
platform/* implements PlatformService
agent/* implements AgentBridge
native/* holds the optimizations shared by transport/engine (SHM, tile, convert, kitty_proto)
electron/ (TypeScript) does IPC with engine/electron/ and loads the Rust native module
```

### 10.2 What an extension adds or changes

```text
adding an engine (reconsidering CEF, say)
    add src/engine/cef/ (adapter, frame_source, input_sink, extension)
    no core change; only twebd's engine selection logic gains a branch

adding a transport (Sixel, say)
    add src/transport/sixel.rs
    no core change; only transport/mod.rs's selection logic gains a branch

adding an agent
    add src/agent/<name>.rs
    no core change; only agent/mod.rs gains a registration

adding a platform
    add src/platform/<name>.rs
    no core change; only platform/mod.rs's selection logic gains a branch
```

## References

- Electron webContents paint event — https://www.electronjs.org/docs/latest/api/web-contents
- Electron offscreen rendering — https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering
- awrit paint.ts — https://github.com/chase/awrit/blob/electron/src/paint.ts
- Kitty graphics protocol — https://sw.kovidgoyal.net/kitty/graphics-protocol/
- DESIGN.md sections 6.5, 7.1–7.7 — this repository
- FEASIBILITY.md sections 1, 7 — this repository
- PREDEV.md S1, P1 — this repository
