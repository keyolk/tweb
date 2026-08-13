# TWeb Browser Runtime design

## 1. Problem statement

It has to be possible to use a real Chromium browser inside a tmux pane while continuing to use
Ghostty and tmux as they are. The browser must not be a mere preview image but a persistent runtime a
human can drive directly and an agent can automate on the same page.

The core experience is this:

```text
Ghostty
└── tmux session: project-a
    ├── window @1: agent workflow
    │   ├── pane %1: shell / agent
    │   ├── pane %2: dev server
    │   └── pane %3: browser page
    └── window @2: another workflow
        ├── pane %4: agent
        └── pane %5: browser page
```

It builds on the terminal graphics model `awrit` proved and the tmux/agent shared-control model
`cliweb` extended, while solving the following from the start:

- support tmux/Ghostty as a first-class target rather than a compatibility hack
- split shortcut ownership out into an explicit Browser mode
- damage-aware rendering that avoids full-frame CPU copies
- separate the browser process/profile from the pane frontend so several panes can share it
- import a Google Chrome profile's extensions and general browsing state safely and easily
- hand off Okta/Device Trust URLs that need enterprise-managed Chrome to real Chrome
- a structure that can gain remote transports and native GPU presentation later

## 2. Goals

1. Treat one browser page as one tmux pane.
2. `split-window`, `resize-pane`, `swap-pane`, `join-pane`, `break-pane`, `kill-pane` and zoom apply to
   the browser as they do to anything else.
3. A browser pane resize is reflected in the Chromium viewport and CSS reflow immediately.
4. A human and an agent share the same page/profile, with control authority managed explicitly.
5. tmux shortcuts and browser shortcuts are separated completely by mode.
6. Browser pages in the same tmux session share cookies and site data by default.
7. Chrome profile bootstrap is a core product feature.
8. No cookie value or credential is exposed in the CLI, in logs or in tmux options.
9. The renderer and the profile provider are separable, so it extends to Ghostty, Kitty, remote and
   native presentation.
10. Resources created or observed in the browser are handed to agents in the same tmux window as typed
    attachments, and to other panes/windows/hosts only under explicit scope and capability.
11. Browser/Chromium security updates must be adoptable continuously and quickly.

## 3. Non-goals

- Do not imitate Google Chrome by spoofing the User-Agent.
- Do not share a running Chrome profile directory with Chromium concurrently.
- Do not replicate Okta session cookies automatically or continuously.
- Do not build a pane/layout tree separate from tmux's.
- Do not bind the initial structure permanently to Electron or to a particular terminal implementation.
- Do not promise to force-reproduce the whole of a browser chrome that terminal graphics cannot express.
- Do not grant agents unlimited automation authority over an entire managed Chrome profile.

## 4. Core invariants

```text
browser page identity     = BrowserPageID
browser page placement    = tmux pane ID
default browser profile scope = tmux server + session ID
default agent workflow scope  = tmux window ID
default resource scope        = tmux window ID
layout authority          = tmux
input authority           = either tmux mode or Browser mode
```

The browser runtime and the presentation are independent.

```text
BrowserRuntime
├── EmbeddedChromiumRuntime
├── RemoteChromiumRuntime
└── ManagedChromeExternalRuntime

FrameTransport
├── KittyGraphicsTransport
├── NativeSurfaceTransport
└── RemoteVideoTransport
```

### 4.1 Names and the command contract

```text
product name           TWeb
official executable    tweb
optional short alias   twb
runtime daemon         twebd
Chrome extension       TWeb Profile Bridge
resource URI scheme    tweb://
tmux key table         tweb-browser
```

`TWeb` is the human-readable product name and `tweb` the stable command used in scripts and shells.
`twb` is only a symlink/alias for `tweb` and never creates a separate command or config namespace.
Documentation and error messages always print `tweb` as the canonical command.

The unscoped npm `tweb` is already a reserved package and `twb` belongs to another package. The
published package therefore uses an organization scope, `@keyolk/tweb`, and only the installed
executables are `tweb`/`twb`. GitHub also has an unrelated project named `tweb`, so the repository
identity uses the organization-qualified `keyolk/tweb` as the canonical URL.

`tweb` is a single multi-call executable. The subcommand always comes before the action and target
selectors after (`tweb snapshot --pane %3`). Two syntaxes mixing global and per-subcommand selectors
are never supported at once.

```text
tweb open [URL]             run the browser frontend in the current terminal/pane
tweb split [URL]            create a browser pane in the current tmux window
tweb navigate URL           navigate the resolved browser page
tweb snapshot --pane %3     drive a browser page
tweb resource ...           inspect, hand off and materialize resources
tweb profile ...            bootstrap and manage profiles
tweb chrome ...             manage the managed Chrome handoff and bridge
tweb doctor [--fix]         diagnose terminal/tmux/Ghostty capabilities and manage the settings
```

The pane frontend's internal invocation is kept apart from the user-facing contract.

```text
tweb __pane --page <opaque-id>
```

`__pane` is an internal subcommand tmux launches and is not a documented automation API. Because it is
the same binary, there is no separate `tweb-browser` install and no version skew.

`TWEB_CONFIG_HOME`, `TWEB_DATA_HOME` and `TWEB_RUNTIME_DIR` override the paths. The defaults follow
platform convention.

```text
Linux config   $XDG_CONFIG_HOME/tweb
Linux data     $XDG_DATA_HOME/tweb
Linux runtime  $XDG_RUNTIME_DIR/tweb
macOS config   ~/Library/Application Support/TWeb
macOS data     ~/Library/Application Support/TWeb
macOS runtime  $TMPDIR/tweb-$UID (0700)
```

The runtime socket and the GPU handle broker are never created outside the runtime directory. Profiles,
resource objects and caches each have their own subdirectory and quota.

## 5. Process structure

```text
Host
├── tmux server
│   └── pane %3
│       └── tweb __pane
│           ├── terminal capability negotiation
│           ├── keyboard/mouse decoding
│           ├── SIGWINCH handling
│           └── the frame transport frontend
│
├── twebd
│   ├── Chromium process manager
│   ├── ProfileManager
│   ├── PageRegistry
│   ├── FrameProducer
│   ├── ResourceBroker
│   ├── AutomationController
│   └── authenticated local IPC
│
├── tweb CLI (short-lived)
│   ├── tmux/browser lifecycle
│   ├── agent automation
│   ├── resource exchange
│   └── profile bootstrap
│
└── Google Chrome
    └── the optional tweb Profile Bridge extension
```

### 5.1 `twebd`

One daemon per host by default. A full Electron runtime is never started per pane.

Responsibilities:

- the Chromium browser process and crash recovery
- a persistent profile/context per session
- page creation, closing, navigation and history
- extension lifecycle
- frame generation and backpressure
- semantic accessibility/DOM snapshots
- serializing agent actions
- the human/agent control lease
- profile import/export policy

The daemon socket lives in a user-private runtime directory and peer credentials are checked. Requests
use opaque IDs only, and no API ever returns a cookie/token value.

### 5.2 The `tweb __pane` frontend

The actual foreground process of every tmux browser pane.

Responsibilities:

- register pane identity using `$TMUX` and `$TMUX_PANE`
- collect the stable tmux server/session/window/pane IDs
- detect the terminal's Kitty graphics, keyboard and mouse capabilities
- manage raw terminal mode and restore it on exit
- turn `SIGWINCH` into a pixel viewport resize
- attach to a browserd page and display frames
- forward keyboard/mouse to browserd
- forward the pane visibility/focus lifecycle
- show a text fallback when the terminal does not support graphics

### 5.3 The `tweb` CLI

Examples:

```sh
tweb open https://localhost:5173
tweb split -h https://example.com
tweb status --pane %3
tweb snapshot --pane %3
tweb click --pane %3 --ref d1-n13
tweb fill --pane %3 --ref d1-n18 --value hello
tweb profile bootstrap chrome
```

When an agent omits the pane, it finds the primary browser in the same tmux window from its own
`$TMUX_PANE`. With several candidates it demands an explicit target rather than choosing arbitrarily.

## 6. The browser runtime

### 6.1 Choosing the engine

The first implementation line uses Chromium. Electron makes it fast to reuse `awrit`/`cliweb` and the
extension tooling, but the domain API must not end up bound to Electron.

```text
BrowserEngineAdapter
├── ElectronChromiumAdapter
└── ChromiumShellAdapter
```

The long-term criteria:

- Chrome Extension API compatibility
- offscreen GPU shared texture support
- security update cadence
- the process sandbox
- IME, clipboard and WebAuthn support
- the cost of implementing a custom browser chrome

If Electron is used, the CPU `NativeImage.toBitmap()` path is not the default renderer;
`offscreen.useSharedTexture` is validated first. The version used is pinned at or above a release that
includes the known shared-texture security fixes.

### 6.2 The profile model

```text
BrowserProfile
├── id
├── displayName
├── storageRoot
├── source
│   ├── fresh
│   ├── chrome-bootstrap
│   └── imported-bundle
├── extensionSet
├── routingPolicy
└── auditMetadata
```

The default profile key combines:

```text
hash(tmux server identity, tmux session ID)
```

Renaming a session or reordering windows must not change the profile identity.

### 6.3 Implementation languages

TWeb's primary implementation language is **Rust**. Rust is chosen for memory efficiency, but the larger
effect comes from removing Electron/Node/V8 from the daemon and the pane frontend and controlling buffer
ownership explicitly.

```text
Rust
├── the tweb CLI
├── the tweb __pane frontend
├── twebd orchestration
├── the tmux/terminal protocol
├── the CDP/control protocol
├── ProfileManager
├── ResourceBroker
├── AgentBridge
├── frame scheduling/backpressure
└── remote transport

C++
├── the CEF/Chromium embedding adapter
├── Chromium GPU surface export
└── extension/browser host integration

Rust platform modules
├── macOS IOSurface/Mach/XPC/Metal synchronization
├── Linux DMA-BUF/Unix descriptor passing
├── Windows DXGI/shared handles/named pipes
└── the platform credential store and the Chrome Native Messaging host

An Objective-C++/C++ platform shim
└── covers only the narrow OS/browser ABIs a Rust crate cannot express directly

Zig
└── the optional TWeb-enhanced Ghostty fork and upstream contributions to the standard Kitty protocol

TypeScript
└── the TWeb Profile Bridge Chrome extension
```

Language boundaries are limited to a process or a narrow C ABI. Rust and Zig never split the same domain
logic between them or co-own the same object lifetime.

#### Why Rust is the core

- Ownership/RAII is well suited to enforcing the reclamation of frames, shared-memory mappings, GPU
  handles and resource leases.
- The ecosystem for a daemon's async IPC, multi-client backpressure and encrypted remote transport is
  mature.
- It provides memory-safe defaults for terminal parsers and untrusted protocols.
- The SQLite/object store, serialization, observability and fuzzing tooling is sufficient.
- macOS, Linux and eventually Windows are easy to support from one core.
- `tweb` and `twebd` can ship as small native executables with no Node/V8 runtime.

Rust does not make memory efficiency automatic. Allowing unbounded `Arc`, clones, channels, `Vec<u8>`
and JSON materialization can use more memory than Zig or C++ would. The following rules apply.

- Never copy a frame payload into a Rust heap `Vec<u8>`; pass a borrowed/native handle.
- Use bounded channels only and make the queue capacity part of the protocol contract.
- Pass resource bodies as streams/file descriptors and never load a whole body into memory.
- Use metadata JSON on the control plane only; the frame/input hot path uses a binary protocol.
- Use `Bytes`/slices and scatter-gather I/O, and forbid unnecessary `String` conversions.
- Do not create an independent buffer per task; use a bounded pool per profile/page.
- For release builds, decide `panic = "abort"` and LTO by measurement, and keep debug allocators out of
  production.
- Decide on replacing the global allocator only after obtaining a real fragmentation profile.

#### Why Zig is not the core

Zig's explicit allocators, small runtime and C interop are attractive. But the hard part of TWeb's core
is less buffer conversion than a long-lived daemon's concurrency, cancellation, IPC, remote transport,
resource capabilities and crash recovery. In that territory Rust's type/ownership/concurrency ecosystem
is the advantage, both for memory safety and for development stability.

Zig fits better in the following scope:

- the renderer and local-surface protocol of the optional TWeb-enhanced Ghostty fork
- upstream Ghostty contributions for standard Kitty animation/composition support
- image/surface conversion helpers with a small ABI
- standalone benchmarks and probes

Splitting the core evenly between Rust and Zig complicates allocator ownership, the async runtime,
building and debugging enough that the maintenance cost exceeds the memory saved.

### 6.4 Choosing the Chromium adapter

Putting memory efficiency first means not adopting Electron as the product core.

```text
validate first
    Rust twebd + a CEF/custom Chromium adapter

comparison baseline
    the Electron offscreen shared texture adapter

compatibility fallback
    an external Chrome/CDP screenshot adapter
```

The goals of a CEF/custom Chromium adapter:

- remove the Node/V8 main process
- one browser process manages the session/profile context and many pages
- create only Chromium pages/WebContents instead of a separate Electron `BrowserWindow` per page
- export the GPU surface without converting it to a CPU bitmap
- keep the Chromium sandbox and process isolation
- validate the extension API through a capability registry

If CEF cannot provide the needed extension API or GPU handle export, it is replaced by a custom Chromium
shell adapter maintained with a narrow patch. That change happens behind `BrowserEngineAdapter` and does
not alter the profile/page/resource API.

### 6.5 Memory ownership and budgets

The memory budget is never judged by `RSS` alone. Because of Chromium's shared libraries and shared GPU
resources, the sum of per-process RSS can overstate the real physical memory. At minimum the following
are measured separately.

```text
private dirty / PSS
shared code pages
the Chromium JS/DOM heap
GPU process memory
IOSurface/DMA-BUF bytes
Kitty SHM ring bytes
terminal texture bytes
ResourceBroker object/cache bytes
```

Frame memory is predicted with this formula:

```text
surface bytes = width × height × 4 × surface count
```

For example:

```text
1920×1080 RGBA
  1 surface  ≈ 7.9 MiB
  2 surfaces ≈ 15.8 MiB
  3 surfaces ≈ 23.7 MiB

3840×2160 RGBA
  1 surface  ≈ 31.6 MiB
  2 surfaces ≈ 63.3 MiB
  3 surfaces ≈ 94.9 MiB
```

Triple buffering is therefore not unconditional.

- The GPU fast path uses a 2-surface mailbox by default and extends to 3 only on a measured stall.
- On the enhanced Ghostty path, the same IOSurface is imported directly so producer and consumer never duplicate pixel memory.
- On the vanilla Ghostty/Kitty path the SHM ring and the terminal texture do duplicate, so the per-visible-page budget is set lower.
- A hidden page releases its present surface and SHM tile pool, optionally keeping only a compressed thumbnail.
- A background page can have its Chromium lifecycle state moved to frozen/discarded.
- The resource cache and the browser HTTP cache are managed under separate quotas.
- Screenshots/PDFs/HARs stream to the object store rather than into a memory buffer.
- Each profile has a page/renderer process ceiling, but pages with active media/WebRTC are never discarded arbitrarily.

The initial budget classes:

```text
CoreBudget
    the tweb pane frontend's private memory
    twebd's private memory (excluding Chromium)

VisiblePageBudget
    JS/DOM plus the renderer's private memory
    GPU surfaces
    transport buffers

HiddenPageBudget
    frozen page state
    an optional thumbnail

ProfileBudget
    the cache/resource/object-store quota
```

Concrete MiB ceilings are settled after measuring the CEF/Chromium baseline on reference hardware. The
following, though, are architecture release gates.

- The browser runtime/Node/V8 are not duplicated in proportion to the `tweb` pane count.
- An idle pane frontend that has added no visible page owns no frame-sized buffer.
- A hidden page's GPU/SHM surface bytes converge to 0.
- Queues and the resource cache have hard upper bounds.
- After a page close, a renderer crash or a client detach, resource counts and private bytes return to baseline.

### 6.6 Platform abstraction

macOS is the first implementation and performance reference platform, but the core types and protocols
never expose macOS APIs.

```text
Platform-neutral Rust core
├── BrowserEngineAdapter
├── SurfaceTransport
├── LocalIpcTransport
├── TerminalCapabilityProvider
├── CredentialStore
├── ProcessSupervisor
├── FileTransferProvider
└── PlatformPaths
```

#### Shared surfaces

```rust
trait SharedSurface: Send + Sync {
    fn id(&self) -> SurfaceId;
    fn size(&self) -> PixelSize;
    fn format(&self) -> PixelFormat;
    fn color_space(&self) -> ColorSpace;
    fn synchronization(&self) -> SyncPrimitive;
}
```

Platform handles never become a shared integer/pointer in the wire schema.

```text
macOS    IOSurface + a Mach port/shared event
Linux    a DMA-BUF fd + a sync file/explicit fence
Windows  a DXGI shared handle + a D3D11/D3D12 fence
```

Each handle is interpreted only inside its platform adapter. On the remote path, shared surface handles
are not sent at all; it switches to a video frame transport.

#### The platform service matrix

| Service | macOS | Linux | Windows |
|---|---|---|---|
| Local IPC | Unix socket/XPC + peer audit | Unix socket + peer credentials | Named pipe + ACL |
| Handle transfer | Mach port/XPC | `SCM_RIGHTS` | `DuplicateHandle`/shared handle |
| GPU surface | IOSurface/Metal | DMA-BUF/Vulkan·EGL | DXGI/D3D11·D3D12 |
| Credential store | Keychain | Secret Service/KWallet | Credential Manager/DPAPI |
| Browser discovery | Chrome app bundle | desktop entry/PATH | registry/App Paths |
| Native messaging | Chrome macOS manifest | Chrome Linux manifest | Chrome registry manifest |
| Runtime supervision | a launchd-compatible child | a systemd-compatible child | a Job Object/service-compatible child |
| Paths | `~/Library/...` | XDG directories | Known Folders/LocalAppData |

#### Terminal/tmux topology

On macOS and Linux, the default arrangement has the tmux server and `twebd` on the same host. On Windows,
tmux may not be a native Windows process, so where things run is separated explicitly.

```text
Windows terminal client
├── WSL2 tmux + WSL2 twebd
├── SSH remote tmux + remote twebd
└── a Windows-local browser runtime + a WSL/remote pane association
```

Core identity never uses OS paths or PIDs alone.

```text
HostID + TmuxServerID + SessionID + WindowID + PaneID
```

Do not assume WSL and the Windows host can share file paths. The ResourceBroker owns materialization and
transfer between Windows paths, WSL paths and remote paths.

#### Support order and the contract

```text
primary implementation   macOS + vanilla Ghostty + stock tmux
second platform          Linux + Ghostty/Kitty + stock tmux
third platform           a Windows client + WSL/SSH tmux
optional optimized tier  a per-platform enhanced terminal adapter
```

A per-platform optimization must never introduce new feature semantics into the core API. Without the
DXGI fast path on Windows, for instance, pages/profiles/resources/Browser mode still behave identically
and only the frame transport falls back.

CI separates at least the following:

- platform-neutral Rust unit/property/fuzz tests
- per-OS IPC/handle/path integration tests
- browser engine adapter conformance tests
- per-terminal/tmux-combination end-to-end tests
- cross-host resource transfer tests

## 7. Rendering architecture

TWeb guarantees vanilla terminal compatibility as the product baseline and uses an enhanced fork only as
an optional performance tier.

```text
Tier 1 — vanilla baseline (required)
    vanilla Ghostty or Kitty
    stock tmux
    standard Kitty graphics plus tmux passthrough where needed

Tier 2 — standards enhanced (optional)
    upstream Ghostty's Kitty animation/composition support
    upstream tmux's native Kitty image lifecycle support

Tier 3 — TWeb enhanced (optional)
    the TWeb-enhanced Ghostty fork
    a TWeb-enhanced tmux branch where needed
    the local GPU surface fast path
```

Release and conformance tests must pass on Tier 1. Even with Tier 3 absent or its negotiation failing,
the browser page, profile, agent resource and shortcut functionality must all keep working. The tier
difference must be rendering performance and some visual fidelity, nothing more.

### 7.1 `awrit`'s performance gap

`awrit`'s bottleneck is not Kitty graphics alone but the whole frame pipeline.

```text
Chromium GPU compositor
    ↓ GPU → CPU readback
Electron NativeImage
    ↓ toBitmap()
Node Buffer
    ↓ BGRA → RGBA conversion + copy
POSIX shared memory
    ↓ Kitty graphics transfer
terminal image cache
    ↓ texture upload/composite
GPU
```

The costs visible in the current implementation:

1. Every paint builds the whole frame in CPU memory via `NativeImage.toBitmap()`.
2. The dirty rectangle is received but the renderer does not use it, copying the whole frame instead.
3. The Rust bridge repeats `shm_open`, `ftruncate`, `mmap` and `munmap` on every paint.
4. The BGRA→RGBA conversion runs over the whole frame.
5. There are redundant memory copies between Browser→Node→Rust→shared memory.
6. The Ghostty fallback transfers/displays the image repeatedly, producing GPU upload and placement churn.
7. tmux passthrough does not own image visibility or lifetime, producing repaint, ghosting and cleanup costs.

A 32-bit 1920×1080 frame is about 7.9 MiB, and copying it whole at 60fps is about 475 MiB/s. A Retina
3840×2160 frame is about 31.6 MiB, about 1.85 GiB/s at 60fps. On top of the protocol payload, those
figures each gain a readback, a color conversion, a shared-memory copy and a terminal texture upload.

Damage tiling alone may therefore not be enough. Optimize the standard Kitty path for vanilla
Ghostty/Kitty first, and offer an optional TWeb-enhanced Ghostty GPU surface fast path on the same
runtime.

### 7.2 The optional TWeb-enhanced Ghostty GPU surface fast path

This path activates only when a separate TWeb-enhanced Ghostty build exists. Vanilla Ghostty support and
TWeb's functional correctness never depend on it.

```text
Chromium GPU compositor
    ↓ authenticated local handle transfer
Ghostty renderer
    ↓ direct texture import
Metal / OpenGL texture composition
```

On this path pixels are never read back to the CPU. The PTY carries frame ordering, placement, visibility
and resize generation rather than a pixel payload. The actual GPU handle travels over user-private local
IPC.

The conceptual frame descriptor:

```text
GpuFrameDescriptor
├── pageID
├── frameToken
├── generation
├── size
├── pixelFormat
├── colorSpace
├── damageRects
├── surfaceHandle
└── synchronizationFence
```

The macOS implementation:

1. Receive an `IOSurface`-backed frame from the Chromium/Electron offscreen shared texture.
2. A native bridge exports the `IOSurface` as a handle transferable over Mach/XPC.
3. Ghostty validates the handle and imports it as an `MTLTexture`.
4. The BGRA/RGBA difference is handled by shader sampling, not a CPU swizzle.
5. Ghostty sends a release acknowledgement after presenting or dropping the frame.

Electron's shared-texture handle is confined to the receiving process, so a JavaScript `Buffer`'s pointer
value must never be passed to another process. A native bridge has to own the OS's proper cross-process
resource transfer and lifetime. If that API fails to meet the stability and performance criteria, it is
replaced by a Chromium shell adapter that provides the same contract directly.

The Linux implementation uses DMA-BUF and explicit synchronization. On GPUs/drivers where import is
impossible, it falls back to the standard Kitty backend.

#### Frame lifetime and backpressure

- 2–3 surfaces cycle per visible page.
- The producer never overwrites a surface before Ghostty releases it.
- When the queue falls behind, intermediate frames not yet presented are dropped and only the latest complete frame is kept.
- Damage rects are used for the rendering clip, but the surface contents are treated as a complete frame.
- The generation is bumped on every resize and frames of an earlier size/generation are never displayed.
- A hidden page stops the compositor's begin-frame and keeps only the last surface.
- On a GPU process crash or a handle import failure, it switches to the Kitty backend per page.

#### The roles of the PTY and the side channel

```text
PTY/tmux
    → pane identity, placement, frame tokens, focus, visibility, delete

the local GPU channel
    → texture handles, fences, release acknowledgements
```

Vendor extensions are never sent unconditionally. They are used only once the browser frontend, tmux and
Ghostty have confirmed the same local-surface protocol version through capability negotiation. Other
terminals never receive a handle they cannot understand; they receive standard Kitty frames.

### 7.3 The default local path: damage-aware Kitty graphics on vanilla Ghostty/Kitty

This path is the baseline for both installation and functional correctness. TWeb has to run on official
Ghostty releases and stock Kitty with no fork. Even with no enhanced capability, browser resize, input,
profile sharing and agent resource exchange all work.

```text
Chromium compositor
    ↓ damage metadata
native frame bridge
    ↓ changed tiles/rectangles
a persistent POSIX shared-memory ring
    ↓ Kitty graphics commands
Ghostty / Kitty
```

Even on terminals without the GPU fast path, it reduces copies and syscalls compared to `awrit`.

#### The memory pipeline

- Do not open and map shared memory per paint.
- Preallocate 2–3 persistent mapped buffers when the page is created and swap them only on resize.
- Do not round-trip a browser frame through a JavaScript `Buffer`; the native bridge writes into the destination buffer.
- With a GPU source, use asynchronous readback and never wait on the main/UI thread.
- When conversion is needed for standard Kitty's RGBA requirement, SIMD-convert only the changed area.
- Never reuse the same transfer buffer before the terminal acknowledges it.
- Reuse shared-memory names and image IDs from a bounded pool rather than minting them without limit.

#### The damage and tile strategy

- Preserve Chromium's/Electron's dirty rectangle.
- Divide the screen into adaptive tiles. The starting candidate is 256×256, adjusted in the 128–512 range by workload.
- Update only the tiles a dirty rect overlaps.
- Union the several damage events within one display interval.
- Fold frames with a large changed area, such as a scroll, into a full frame or a large stripe instead of hundreds of small commands.
- For a static page with no damage, produce neither a frame nor a terminal command.
- Apply different frame pacing to text/content updates than to animation/video.
- When the output queue falls behind, drop intermediate generations.

The tile size is not a fixed constant but a choice measured against these costs:

```text
smaller tiles → more commands/images and higher placement cost
larger tiles  → more unnecessary pixel copies and texture uploads
```

#### Strategy per Kitty capability

```text
load + animation frame + composite
    → composite the damage frame onto the base image

independent image placement + replace
    → update stable tile image IDs in place

basic transfer/display only
    → a coalesced full-frame fallback plus a lower frame cap
```

Capabilities are decided by a graphics query, never guessed from the terminal name. The basic fallback is
never marketed as a normal performance path, and the restricted state is surfaced in the UI.

### 7.4 tmux support tiers

#### The stock tmux baseline

On stock tmux, standard Kitty sequences travel through passthrough.

```tmux
set -g mouse on
set -g focus-events on
set -g allow-passthrough all
```

What TWeb is directly responsible for on stock tmux:

- the pane size and the `SIGWINCH`-driven viewport
- the image ID namespace
- selected-window visibility and repaint reconciliation
- a deterministic delete before the pane exits
- recovering stale placements after an abnormal exit
- the Browser mode key table

As long as stock tmux does not understand image objects, visibility hooks or repaint reconciliation may be
needed. That is a compatibility cost the baseline has to carry, and it must never lead to a failed install
or data loss.

#### The optional enhanced tmux branch

For the highest performance tier, a branch is envisioned in which tmux manages the following lifecycle
natively:

- parsing/caching Kitty images and local GPU frame-token sequences
- pane-relative placement
- displaying images only in the selected window
- updating placement on pane resize and zoom
- deterministic image deletion when a pane/window ends
- managing image capability and visibility per tmux client
- correcting for the pane offset
- carrying frame generations and release acknowledgements
- keeping the latest frame per client so a slow client does not apply unbounded backpressure to the browser producer

tmux never needs to open a GPU handle itself. It manages the resource token's pane/window lifecycle and its
delivery to outer clients, while the actual handle travels over an authenticated local channel between
browserd and Ghostty.

Where native Kitty image support in current tmux is not yet stable, a separate integration branch is
maintained with upstreaming as the goal. In compatibility mode the following settings can be used.

```tmux
set -g mouse on
set -g focus-events on
set -g allow-passthrough all
```

Visibility hooks and stale-image cleanup are not regarded as normal paths in the final architecture, though.

### 7.5 Ghostty native integration

The goals on the Ghostty side:

- Kitty image load/display/delete
- animation frames and frame composition
- persistent shared-memory transfer
- a local `IOSurface`/DMA-BUF frame import extension
- explicit synchronization and release acknowledgements
- Unicode placeholder/placement semantics
- an image memory budget and deterministic eviction
- coordinate and visibility handling through tmux
- the extended keyboard protocol
- SGR pixel mouse coordinates

The Ghostty renderer composites the browser texture as a separate image/surface layer rather than copying it
into the terminal cell texture atlas. Only the clip and transform are updated to the pane geometry,
avoiding unnecessary texture reallocation mid-resize.

Protocol behaviour missing in Ghostty is solved by an upstream implementation rather than by piling up more
per-terminal-name workarounds.

### 7.6 Choosing the performance path

```text
Ghostty local-surface + tmux local-token support
    → the zero-readback GPU fast path

standard Kitty shared memory + damage/composite support
    → the optimized compatibility path

basic Kitty image only
    → a bounded full-frame fallback

a remote browser
    → hardware video transport
```

The choice can be made independently per browser page, but when several clients display the same page each
gets its own transport. The producer is never blocked by the slowest client.

### 7.7 The performance release gate

The main path is not marked `performance-ready` until it meets the following criteria.

- 0 CPU full-frame copies of browser pixels on the GPU fast path
- 0 frame transfers while a static page is idle
- 0 frame production in a hidden tmux window
- queue depth never exceeding the configured surface ring size
- only the new generation displayed within 2 display frames after a resize
- sustainable frame pacing at a 60Hz display during a 1080p continuous scroll
- no unbounded memory growth with two visible browser panes
- 0 stale images, surfaces or shared-memory objects after 10 minutes of animation/video
- surface handles reclaimed even when the producer, a tmux client or Ghostty crashes

Latency and frame figures are quantified after fixing the reference hardware. The minimum measurement items:

```text
input → Chromium event dispatch
Chromium commit → frame available
frame available → Ghostty present
input → visible response, end to end
GPU/CPU copy bytes per frame
terminal command bytes per frame
frame drop/coalesce count
surface acquire/release latency
```

If the standard Kitty path fails a workload's target, that is not hidden. The Ghostty GPU fast path remains
the main path and the Kitty path's capability/performance grade is stated.

### 7.8 Future backends

```text
NativeSurfaceTransport
    a Chromium shared GPU texture → the tweb native compositor

RemoteVideoTransport
    remote Chromium → hardware encode → client decode
```

Adding either backend leaves `BrowserPageID`, the profile, the automation API and the tmux lifecycle
unchanged.

## 8. Resize and visibility

```text
pane resize
    ↓ SIGWINCH
terminal pixel query
    ↓
bump the viewport generation
    ↓
Chromium viewport resize
    ↓
CSS resize / ResizeObserver
    ↓
display the new-generation frame
```

- Do not use a 100ms debounce.
- Use coalescing per display frame only.
- Compute the browser toolbar and the content viewport sizes separately.
- Obtain the cell size, terminal padding and Retina scale from a capability query.
- When the pixel size is unknown, use a cell-based estimate but surface that state.

Window/session changes are handled by client visibility notifications where possible rather than tmux hooks.
Compatibility hooks must be idempotent, and browserd reconciles the full state after reconnecting.

## 9. The shortcut and input model

### 9.1 Principles

Shortcuts are never interpreted concurrently.

```text
TMUX mode
    every key → the tmux key table

BROWSER mode
    the reserved toggle → tmux mode
    every other key → the browser pane
```

The mode is per-tmux-client state. It never affects other clients attached to the same session. A new
attach, a session switch and error recovery all start in TMUX mode.

### 9.2 The tmux key table

Pane options identify a browser surface.

```text
@tweb_surface=browser
@tweb_page_id=<opaque-id>
```

Entering Browser mode switches the client to a custom key table.

```tmux
switch-client -T tweb-browser
```

What the `tweb-browser` table does:

- the reserved toggle returns to the `root` table
- `Any` sends the real key to the pane and re-arms the `tweb-browser` table
- mouse border events are used by tmux for resize
- pane interior mouse events go to the browser process

The conceptual configuration:

```tmux
bind-key -n C-g if-shell -F '#{==:#{@tweb_surface},browser}' \
  'switch-client -T tweb-browser' \
  'send-keys C-g'

bind-key -T tweb-browser C-g switch-client -T root
bind-key -T tweb-browser Any send-keys \; switch-client -T tweb-browser
```

The exact behaviour of `Any` forwarding, key-up/repeat, extended keys and mouse is settled by conformance
tests per supported tmux version. Versions where it does not work are never marked as supported.

The default toggle is proposed as `C-g` but is configurable. In other panes the original `C-g` passes
through as before. A separate binding is provided for sending a literal `C-g` to the browser.

### 9.3 Surfacing Browser mode

The mode must always be visible.

```text
[TMUX]    the pane-manipulation state
[BROWSER] the Chromium direct-input state
[AGENT]   an agent holds the control lease
```

Where it appears:

- the terminal title/OSC
- tmux's pane-border-format
- a browser toolbar badge

When `client_key_table` and the real browser focus disagree, input is not forwarded and it recovers to
TMUX mode.

### 9.4 IME and clipboard

These must be treated as their own conformance area.

- Korean intermediate composition state and committed text
- Kitty keyboard protocol key-down/repeat/key-up
- bracketed paste
- OSC 52 clipboard
- browser selection copy
- file path drop and upload

Where the terminal protocol cannot carry the composition lifecycle, committed-text input is supported and
the constraint is stated. Global key event interception is never added to hide it.

## 10. Chrome profile bootstrap and synchronization

### 10.1 Goal

A user has to be able to reconstruct their existing Chrome environment quickly.

```text
pick a Chrome profile
    ↓
a profile inventory preview
    ↓
the user approves items and sites
    ↓
tweb profile bootstrap
```

The supported items are split by security level.

| Data | Default policy | Mechanism |
|---|---|---|
| The extension list | imported | inventory the IDs/versions/manifests, then reinstall |
| Bookmarks | imported | a snapshot import |
| History | optionally imported | imported with credentials stripped |
| General settings | allowlisted | homepage, locale and the like |
| Cookies | explicit per-origin approval | a one-shot transfer through the Chrome Bridge |
| Local storage | explicit per-origin approval | an adapter, for supportable sites only |
| Extension storage | excluded by default | a per-extension migration adapter |
| Passwords/passkeys | excluded | re-authenticate with the original provider |
| Okta/IdP sessions | excluded | the actual managed Chrome handoff |

### 10.2 No direct profile DB access

The following are never used.

- reading a running Chrome's `Cookies` SQLite directly
- extracting the Chrome Safe Storage key
- a live copy of the profile directory
- reusing the default Chrome profile as Chromium's `user-data-dir`
- printing cookie values to the CLI/stdout/logs

Instead, a least-privilege Chrome Profile Bridge extension and a Native Messaging host are used.

### 10.3 The Chrome Profile Bridge

The default permissions:

```text
nativeMessaging
management
bookmarks (optional)
history (optional)
cookies + a per-origin host permission (only when requested)
```

The principles:

- The cookie permission is an optional permission.
- A runtime permission is requested only for the origins the user selected.
- A transfer is one-shot, never a background continuous sync.
- The Native Messaging channel carries a request ID, the target profile, the origin and an expiry.
- Cookie values pass only through process memory and encrypted local IPC, leaving no stored log.
- Import results show counts and attributes only, never values.
- The organization denylist and the IdP denylist are applied first.
- `HttpOnly`, `Secure` and partitioned cookies preserve their policy and browser support.
- On a conflict, never arbitrary last-write-wins; request a preview/replace policy.

### 10.4 Sensitive domain policy

Examples denied by default:

```text
*.okta.com
the organization's Okta tenant
organization-managed sensitive routes such as AWS SSO/Teleport
password manager and identity provider domains
```

These domains open in real managed Google Chrome instead of syncing cookies.

```text
the embedded browser
    ↓ detects a sensitive route
the managed Chrome handoff
    ↓
show an [opened in Chrome] state and a focus-return action
```

The denylist is never overridable by user configuration unless organization policy explicitly approves it.

### 10.5 Extension synchronization

Extensions fall into three classes.

```text
compatible
    can be reinstalled automatically

needs-adapter
    needs host support such as native messaging, a toolbar or a side panel

managed-chrome-only
    depends on Device Trust, enterprise policy or Chrome identity
```

The import process:

1. Read only the extension metadata from the Chrome profile.
2. Preserve the Web Store ID and signing identity, and reinstall.
3. Check the supported Chrome Extension API capabilities via the manifest and a runtime probe.
4. Show the user the required permissions and the compatibility state.
5. Extension storage is never copied automatically; use extension-native sync or an adapter.
6. Items such as 1Password and the Okta Browser Plugin are `managed-chrome-only` until validated.

Extension compatibility results are managed in a per-version registry, never guessed.

## 11. The managed Chrome handoff

URLs that need real Google Chrome are handled by a separate trusted provider.

```text
BrowserRoutingPolicy
├── embedded
├── managed-chrome
├── remote
└── ask
```

The minimum functionality of the Managed Chrome Bridge:

- opening a URL
- tracking the ID/title/URL of tabs tweb opened
- focusing a tab
- returning focus to tweb
- detecting a tab closing

The basic Bridge is granted no `debugger`, no broad `scripting` and no cookie access. A separate explicit
permission flow is used only when performing a profile bootstrap.

## 12. Agent shared control and resource exchange

### 12.1 The automation loop

The automation API never exposes cookie values.

```text
snapshot → semantic refs
act      → click/fill/press/scroll/navigate
wait     → load/network/selector/text conditions
verify   → a new snapshot/status/screenshot
```

- Refs are tied to a document generation.
- A stale ref after navigation is an explicit error.
- A per-page command queue guarantees ordering.
- Once a human starts giving the browser input, the agent lease can be suspended.
- External submits, purchases, message sends, uploads and deletes are confirmed right before execution.
- A managed Chrome profile is not an agent automation target by default.

### 12.2 Goal

Like Orca's Design Mode, it has to be possible to hand an element context selected in the browser to an
agent as a single attachment. That is generalized through tmux scopes and resource handles rather than
being coupled to a particular agent product or to a shared filesystem.

The directions to support:

```text
Browser → Agent
├── URL/title/selection
├── a DOM/accessibility snapshot
├── element HTML + computed CSS + a cropped screenshot
├── source map locations
├── screenshots/PDFs
├── console/network traces
├── downloads
└── page-generated files/blobs

Agent → Browser
├── navigation/input/actions
├── file uploads
├── clipboard payloads
├── JavaScript/CSS patches (in an approved development mode)
└── workspace file previews
```

### 12.3 ResourceBroker

Large payloads never go directly into tmux options, environment variables, terminal escape sequences or an
agent prompt. A `ResourceBroker` with a lifecycle separate from `twebd` manages immutable resources and live
handles.

```text
BrowserPage
    ↓ publish
ResourceBroker
    ├── a metadata index
    ├── a scoped object store
    ├── a live resource registry
    ├── a materializer
    └── a transfer service
           ↓ deliver
       AgentBridge
           ↓
       an agent pane
```

The resource manifest:

```text
ResourceDescriptor
├── id: ResourceID
├── kind
├── mimeType
├── producer
├── sourcePageID
├── documentGeneration
├── sourceOrigin
├── scope
│   ├── tmuxServerID
│   ├── sessionID
│   ├── windowID
│   └── paneID
├── locality
│   ├── hostID
│   └── storageKind
├── size
├── digest
├── sensitivity
├── createdAt
├── expiresAt
└── capabilities
```

A resource's body is one of these:

```text
inline-small     small JSON/text metadata
object           an immutable binary/text object
file             a managed file on the host filesystem
live             a time-limited handle such as the current document/network stream
bundle           a typed manifest of several resources
```

Resource IDs are opaque and contain neither a path nor a cookie value. The object store uses user-private
permissions and applies encryption, TTLs and quotas per session/window policy.

### 12.4 Resource kinds

```text
BrowserState
    URL, title, favicon, history position, viewport

SemanticSnapshot
    element refs derived from accessibility/DOM

ElementContextBundle
    the element's outer HTML
    part of the surrounding DOM
    computed CSS
    a cropped screenshot
    the source map file/line/column
    the current URL and viewport

VisualCapture
    a viewport screenshot, a full-page screenshot, a PDF, a short recording

TextContext
    a selection, extracted text, Markdown, reader view

DiagnosticTrace
    console entries, page errors, a network summary, a performance trace

NetworkResource
    request/response metadata, an approved body, a HAR

BrowserFile
    a download, a generated Blob, an exported file

WorkspaceFile
    an upload candidate, a file to open in the browser, a source file

ClipboardPayload
    text, HTML, images, file references
```

A live `SemanticSnapshot`'s refs expire when the document generation changes. Materialized resources such as
a screenshot, a PDF or an `ElementContextBundle`, by contrast, are immutable.

### 12.5 Scope and default routing

The profile cookie sharing scope and the resource visibility scope are separated.

```text
default browser profile scope = the tmux session
default resource scope        = the tmux window
default agent target scope    = the tmux window
```

That is, even when browsers in the same session share login state, a screenshot or download from window A is
not automatically exposed to window B's agent.

Pane roles:

```text
@tweb_role=agent
@tweb_role=browser-primary
@tweb_role=browser-docs
@tweb_role=server
```

The default target resolution:

1. Select the same tmux window as the browser that created the resource.
2. If exactly one active agent is registered in that window, select its pane.
3. With several agents, show a selector rather than quietly choosing by role/last-focus.
4. With no agent, hold it in the resource inbox and show a badge.
5. Delivery to another window/session is stated explicitly with `--to-pane`, `--to-window` or `--to-session`.

Examples:

```sh
tweb capture element --pane %3 --ref d8-n14 --send-to %1
tweb screenshot --pane %3 --send-to-window @2
tweb resource share r_01K... --to-pane %7
```

Moving a browser pane with `join-pane` or `break-pane` changes the default window scope of resources created
afterwards. The scope of already-created resources is never changed implicitly.

### 12.6 Agent registration and capability negotiation

The process in an agent pane registers like this:

```text
AgentEndpoint
├── agentID
├── the tmux pane/window/session
├── provider
├── workingDirectory
├── hostID
├── acceptedKinds
├── acceptedMimeTypes
├── maxInlineSize
├── supportsDirectAttachment
└── inboundEndpoint
```

Example `AgentBridge` implementations:

```text
ClaudeCodeBridge
CodexBridge
GenericTerminalAgentBridge
ShellInboxBridge
```

The delivery priority:

1. If the agent offers an attachment RPC, pass the resource manifest/handle directly.
2. If the agent accepts only local file attachments, materialize on the consumer host and pass the path plus metadata.
3. For a generic terminal agent, pass an inbox notification and a short `tweb://resource/<id>` reference.
4. With no adapter, let the user retrieve it via `tweb resource materialize`.

Never paste a large DOM, screenshot or HAR in with `tmux send-keys`. Even when a generic bridge inserts input
into a terminal, it uses only a short shell-safe reference, and it never submits a running prompt on its own
unless the user enabled an auto-delivery policy.

### 12.7 The Browser → Agent attachment flow

Element delivery like Orca's Design Mode:

```text
1. Activate Inspect/Attach mode from Browser mode
2. Hover and select an element
3. browserd builds an ElementContextBundle
4. ResourceBroker stores the immutable bundle
5. Resolve the AgentEndpoint in the same tmux window
6. AgentBridge delivers the attachment
7. Show the delivery state in the browser pane and the agent pane
```

An example bundle manifest:

```json
{
  "kind": "element-context",
  "page": "bpage_01K...",
  "documentGeneration": 18,
  "url": "https://localhost:5173/settings",
  "resources": {
    "screenshot": "r_01K...",
    "html": "r_01K...",
    "computedStyle": "r_01K...",
    "sourceLocation": "r_01K..."
  }
}
```

Where a source map exists, the path relative to the workspace root plus the commit/worktree identity travel
with it. When the path points outside the workspace, or the browser host and the agent host differ, it is
never presented as a plain local path.

### 12.8 The download flow

Downloads never drop straight into some arbitrary `~/Downloads` of the browser daemon.

```text
a browser download
    ↓ quarantine staging
a ResourceBroker BrowserFile
    ↓ checksum, MIME, filename, source URL
the window resource inbox
    ↓ user/agent policy
an atomic materialization into the workspace
```

The policy:

- Do not trust the `Content-Disposition` filename; strip path traversal.
- Never silently overwrite an existing file.
- Never grant the execute bit automatically.
- Preserve the source URL, the final URL, the MIME type, the size and the digest.
- Show it as a live progress resource until the download completes.
- When handing it to an agent, the descriptor may go first rather than the file itself.
- A file received from a remote browser is transferred to the agent host only when needed.

Examples:

```sh
tweb downloads --pane %3
tweb resource materialize r_01K... --to ./fixtures/report.pdf
tweb resource send r_01K... --to-pane %1
```

### 12.9 The upload flow

An upload never mistakes an agent host's path for a browser host's path.

```text
an agent/workspace file
    ↓ publish a WorkspaceFile
ResourceBroker
    ↓ transfer/materialize on the target host
the browser file chooser
```

Examples:

```sh
tweb resource publish ./fixtures/avatar.png
tweb upload --pane %3 --ref d4-n21 --resource r_01K...
```

A file upload discloses local data to an external origin, so the source file, target origin and field are
shown and policy is applied right before execution. An agent never gets to name an arbitrary absolute path
for browserd to read.

### 12.10 Console and network resources

Collection is summary-centric by default.

```text
ConsoleEntry
    level, timestamp, source, message, stack

NetworkEntry
    method, URL, resource type, status, timing, size
```

The following are redacted by default:

- `Authorization`
- `Cookie`, `Set-Cookie`
- proxy credentials
- password field values
- file input local paths
- configured secret query/body fields

Response/request bodies, WebSocket frames and full HARs are collected only in an explicit capture session,
with a resource scope, a TTL and a size budget configured, and never applied to managed Chrome by default.

### 12.11 The clipboard and selected text

The system clipboard is never used as an intermediate transport when handing a browser selection to an agent.

```text
a browser selection
    ↓ a TextContext resource
an agent attachment
```

It is reflected into OSC 52/the system clipboard only when the user explicitly chose copy. Agent → Browser
paste also travels as a resource or as direct input, and the whole clipboard history is never read.

### 12.12 Locality and remote transfer

Resource identity is separated from where it is stored.

| Browser host | Agent host | Delivery |
|---|---|---|
| the same host | the same host | a file descriptor/path or an object-store reference |
| remote | the same remote | a remote-local reference |
| remote | local | an encrypted stream on request, then local materialization |
| local | remote | an encrypted stream after approval, then remote materialization |

`tweb://resource/<id>` points at the same logical resource from any host. When a consumer asks for bytes, the
ResourceBroker looks at locality and capability and transfers. If the remote connection drops, the descriptor
survives but the body state is marked `unavailable`, then resumed and hash-verified on recovery.

### 12.13 The resource inbox and its UI

Every tmux window has a resource inbox.

```text
window @1 resources (4)
├── element-context  settings button       → agent %1 delivered
├── screenshot       checkout error         pending
├── download         report.pdf             ready
└── console-trace    3 errors                → agent %1 delivered
```

Where it surfaces:

- a count badge in tmux's status/pane-border
- `Send to agent` and the inbox in the browser toolbar
- `tweb resource list --window @1`
- OSC notifications

Binary data and large JSON are never printed into the terminal scrollback.

### 12.14 The resource CLI

```sh
tweb resource list --window @1
tweb resource inspect r_01K...
tweb resource materialize r_01K... --to ./artifacts/
tweb resource send r_01K... --to-pane %1
tweb resource promote r_01K... --to-session
tweb resource revoke r_01K...
tweb resource gc --expired
```

CLI output defaults to a human-readable summary, and `--json` returns a versioned schema. A binary body is
never printed to stdout implicitly.

### 12.15 Resource security

Every resource has one of these sensitivities:

```text
public
workspace
internal
sensitive
credential-bearing
```

- Strip password inputs and configured sensitive field values from DOM snapshots.
- A screenshot may contain secrets visible on screen, so treat it as at least `workspace`.
- Cookies/tokens are not an ordinary ResourceBroker resource kind.
- Credential-bearing resources refuse agent delivery and cross-host transfer by default.
- Digest-based dedup never crosses a scope or an encryption boundary.
- Resource access is never granted on an opaque ID alone; the caller's tmux/agent identity and capability are checked.
- After a resource is revoked, new handles are blocked and the locations of materialized copies are recorded in the audit.
- The audit records metadata and delivery outcomes only, never the body.

### 12.16 Differences from Orca

Orca's active-agent attachment experience is kept, but the target and data boundaries are made more explicit.

| Item | The model observed in Orca | The tweb design |
|---|---|---|
| Default scope | worktree/active-agent centric | the tmux window plus an explicit pane |
| Element context | HTML/CSS/cropped screenshot/source map | a typed `ElementContextBundle` |
| Agent delivery | active agent attachment | a capability-negotiated `AgentBridge` |
| Multiple agents | not detailed in the docs | a selector/explicit target on ambiguity |
| Remote locality | implementation details unclear | resource ID separated from host materialization |
| Download/upload | limited in the docs | first-class `BrowserFile`/`WorkspaceFile` |
| Console/network | CLI inspection | deliverable as a scoped resource |
| Security | not detailed in the docs | redaction/sensitivity/TTL/capability stated |

## 13. State recovery

```text
the pane frontend exits
    the page survives for a grace period

the pane re-attaches
    reconnects to the existing BrowserPageID

a tmux client detaches
    the browser process and pages survive

a tmux pane is killed
    the page ends, or is kept in history per policy

browserd crashes
    the profile plus the URL/history are restored; the DOM/JS heap cannot be

the host reboots
    the persistent profile plus the layout metadata are restored
```

A BrowserPageID is never built from the tmux pane ID alone. Against pane ID reuse, the tmux server identity and
an opaque generation are stored alongside it.

## 14. Performance goals and measurement

Exact figures are fixed after a per-hardware baseline measurement, but the following are release gates.

- the latency from input to browser event dispatch
- the latency from event dispatch to a visible frame
- scroll frame pacing at 1080p and Retina viewports
- static page idle CPU
- CPU, memory and GPU with 1/2/4 visible browser panes
- frame drops during resize and whether a stale generation is ever displayed
- the memory upper bound under terminal output backpressure
- image leaks and stale placements per Ghostty/Kitty/tmux combination

The benchmark workloads:

- static documentation
- a large DOM such as GitHub
- Vite HMR
- the Monaco editor
- canvas/WebGL
- a 60fps CSS animation
- video playback
- Korean input and a long clipboard paste

## 15. The conformance matrix

Support is declared by capability and validated combination, not by terminal name.

| Combination | Graphics | Keyboard | Mouse | Mode | State |
|---|---|---|---|---|---|
| Ghostty direct | a Kitty subset | extended keys | pixel/cell | app mode | needs validation |
| Ghostty + tmux | native image the goal | the tmux table | pane mouse | client mode | a core target |
| Kitty direct | full graphics | kitty keys | pixel | app mode | a core target |
| Kitty + tmux | native image the goal | the tmux table | pane mouse | client mode | a core target |
| SSH remote | an inline/video backend | remote input | remote input | client mode | a separate transport |

## 16. Security

- Never disable the Chromium sandbox.
- Separate the browser/renderer/GPU/utility process privileges.
- The browserd socket admits only local user peers.
- Profile directory permissions are restricted to the user alone.
- The Cookie/Profile Bridge has to pass its own threat model and security review.
- The profile sync audit records the domain, the cookie count, the source/target and the time only, never values.
- Verify the update/signing chain of the Chrome extension and the native host.
- Track Electron/Chromium security releases and keep an emergency update path.
- Apply fuzzing to the terminal escape sequence parser.
- Bound the tmux passthrough payload length and the parser boundary.

## 17. A validation order, not an implementation order

Rather than scoping a short-term MVP, whether the architecture holds up is validated first.

1. **Renderer viability**: do the Ghostty GPU fast path and the damage-aware Kitty compatibility path each meet the target frame pacing?
2. **tmux semantics**: can the image cache/visibility/resize/kill be managed deterministically?
3. **Input fidelity**: do Browser mode, modifiers, the Korean IME and the mouse work without loss?
4. **Profile compatibility**: can the main Chrome extensions be reinstalled and made to work?
5. **Profile security**: does origin-scoped one-shot cookie transfer respect the policy boundary?
6. **Agent control**: can a human and an agent share one page without races?
7. **Remote extension**: can the transport alone be swapped while keeping the existing identity and API?

If 1–3 reveal a structural limit in the terminal protocol, the runtime is not discarded;
`NativeSurfaceTransport` is added instead. The tmux pane/process/profile/automation model stays as it is.

## 18. What to adopt from precedent and what to drop

### Adopted from `awrit`

- displaying a real Chromium browser through terminal graphics
- the pane process owning keyboard/mouse/resize
- shared-memory Kitty transfer
- the browser toolbar and content surface

### Replaced from `awrit`

- a heavy runtime per pane
- full-frame `toBitmap()`
- ignoring the dirty rectangle
- ad-hoc per-terminal fallbacks
- editing only the User-Agent to look like Chrome

### Adopted from `cliweb`

- tmux pane discovery and lifecycle
- a persistent profile
- an authenticated local control socket
- a semantic-refs-based agent API
- the human/agent shared-control loop
- the problem statement of visibility and graceful cleanup

### Replaced from `cliweb`

- a structure that treats passthrough and visibility hooks as the final normal path
- a transport coupled to a single POSIX shared memory
- the approach of treating Electron extension compatibility as general Chrome compatibility

### Adopted from `casty`

- a small control client implementing only the needed CDP domains, without Playwright/Puppeteer
- viewport computation that accounts for the terminal pixel query and the DPR
- using a low-resolution screencast purely as a change-detection signal
- the adaptive-quality notion of refining to a lossless frame once the state is static
- pinning image IDs and deduplicating identical frames
- a simple separation of the Chrome process from the CDP page/input lifecycle
- the requirement to work in SSH/headless environments and the audio/media problem statement

### Replaced from `casty`

- a `Page.captureScreenshot`-based full-frame JPEG/PNG renderer
- a capture loop capped at roughly 20fps
- base64 encode/decode plus PNG/JPEG encode/decode
- inline whole-frame transfer in 4096-byte chunks
- a file transport that writes a temporary PNG synchronously every frame
- a structure that handles image lifetime through tmux passthrough alone
- a structure where every process opens the same `~/.casty/profile`, leaving multi-pane ownership unclear
- a cleanup policy that deletes profile data other than cookies/local storage at startup
- `--disable-extensions`, `--disable-sync`, `--password-store=basic`, `--use-mock-keychain`
- a policy of applying `--no-sandbox` by default on Linux
- stealth scripts that manipulate the User-Agent, `window.chrome`, plugins and WebGL information to look like Chrome

`casty`'s screenshot transport uses fewer terminal bytes than raw RGBA and has good SSH compatibility, but as
an interactive primary renderer its ceiling is clearly lower than the GPU fast path's. It is used only as a
low-framerate fallback where `RemoteVideoTransport` is unavailable, or as a static snapshot backend.

## 19. The final product definition

> The TWeb Browser Runtime is a terminal-native browser that runs browser pages as real pane processes on
> top of Ghostty/Kitty and tmux, and lets a human and an agent share the same persistent Chromium profile.
> Resources created or observed in the browser are handed to agents as tmux window-scoped typed attachments.
> Shortcut ownership is split by a per-tmux-client Browser mode, and Chrome profiles are imported through an
> explicit, policy-aware bootstrap. Identity boundaries that require managed Chrome are not worked around but
> handed off to real Chrome.

## References

- [awrit](https://github.com/chase/awrit)
- [awrit frame path](https://github.com/chase/awrit/blob/electron/src/paint.ts)
- [awrit input handling](https://github.com/chase/awrit/blob/electron/src/inputHandler.ts)
- [cliweb](https://github.com/atomashevic/cliweb)
- [cliweb tmux/Ghostty setup](https://github.com/atomashevic/cliweb/blob/electron/docs/SETUP.md)
- [casty](https://github.com/sanohiro/casty)
- [casty CDP capture path](https://github.com/sanohiro/casty/blob/main/lib/browser.js)
- [casty Kitty transport](https://github.com/sanohiro/casty/blob/main/lib/kitty.js)
- [Orca Design Mode](https://www.onorca.dev/docs/browser/design-mode)
- [Orca CLI reference](https://www.onorca.dev/docs/cli/reference)
- [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
- [tmux manual](https://man.openbsd.org/tmux)
- [Ghostty](https://github.com/ghostty-org/ghostty)
- [Electron offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering/)
- [Electron SharedTexture](https://www.electronjs.org/docs/latest/api/shared-texture)
- [Chrome Extensions API](https://developer.chrome.com/docs/extensions/reference/api)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
