# TWeb detailed design — the P1 damage-aware Kitty path + twebd/Electron integration

This document designs the first stage of `PREDEV.md`'s critical path (P1) and the twebd/Electron
integration structure down to implementation depth. It assumes Engine = Electron is settled (S0).

Research date: 2026-07-31.

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
│   │   └── webContents.on('paint') → Rust native module → SHM → Kitty graphics
│   ├── BrowserWindow #2 (offscreen, page = pane %5)
│   │   └── ...
│   ├── session.loadExtension() — vimium, 1Password and the like
│   ├── session.cookies — injects the cookies received from the Profile Bridge
│   └── IPC server — talks to twebd
│
├── twebd (a Rust daemon)
│   ├── an authenticated Unix socket (peer credential check)
│   ├── PageRegistry — tmux pane ID ↔ BrowserWindow/page mapping
│   ├── ProfileManager — a persistent profile per session
│   ├── ResourceBroker — resource store, scope, TTL
│   ├── AutomationController — serializes agent actions
│   └── tmux integration — pane lifecycle, hooks
│
└── Google Chrome (the user's ordinary Chrome, with the Profile Bridge extension)
    └── The TWeb Profile Bridge extension (cookie transfer, engine-agnostic)
```

### 4.2 The BrowserWindow reuse strategy (the heart of the memory mitigation)

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
Rust native module
    ↓ SHM write + Kitty graphics transfer
tweb __pane (pane %3's foreground process)
    ↓ receives the Kitty graphics
    ↓ displays them in Ghostty
```

### 4.4 The resize flow

```text
tmux pane resize
    ↓ SIGWINCH
tweb __pane
    ↓ terminal pixel query (CSI 14t)
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

## 5. Frame lifetime and backpressure

### 5.1 The surface ring

```text
2–3 surfaces cycle per visible page (a mailbox)
- GPU fast path: 2 surfaces by default, extended to 3 on a measured stall
- shared memory bitmap: 2 surfaces (a CPU bitmap is lighter than a GPU surface)
- the producer never overwrites a surface before Ghostty releases it
- when the queue falls behind, drop the intermediate frames not yet presented and keep only the latest complete frame
```

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
    ↓ Electron: stop webContents.beginFrameSubscription or setFrameRate(0)
    ↓ release the GPU/SHM surfaces, optionally keeping only a compressed thumbnail
    ↓ reconcile with a full redraw on returning to visible
```

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
   demonstrated. Conclusions 1 and 2 have since been acted on; this one has not, and the tile
   pipeline in `tweb-native` is still unused.

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

The ~9ms channel swap is the one remaining CPU pass over the frame, and the natural place for the
SIMD conversion `tweb-native` already implements — the first piece of that crate with a measured
reason to exist. It is left in JS here because moving it needs a Node↔Rust bridge, which is a larger
change than the one this measurement justifies.

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

## 9. A component and interface structure built for extension

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
