# TWeb feasibility research and detailed-design reinforcement

For the seven validation targets in `DESIGN.md` section 17, this document assesses technical feasibility
from external research and analysis of precedent projects, and reinforces the design where it is thin.
Conclusions and recommendations are collected at the end of each section.

Research date: 2026-07-31. The documents researched are listed under "References" at the end.

## Assessment summary

| # | Validation target | Feasibility | Risk | Key finding |
|---|---|---|---|---|
| 1 | Renderer viability | feasible | medium | The three engines (external Chrome, a custom shell, Electron) form a compound trade-off. **CEF is definitively eliminated because it cannot do extensions** (the user cannot give them up). Electron: ahead on extensions, fidelity, IME and distribution — the same engine as Orca. A custom shell: the differentiation path, with a large maintenance cost. External Chrome: a lighter runtime, weak on frame pacing and IME. |
| 2 | tmux semantics | feasible | low–medium | `switch-client -T` plus the `Any` table are officially supported. If PR #5274's grid-resident Kitty image merges, most of the baseline compatibility cost disappears. The late-attach limitation is covered by TWeb's reconcile. |
| 3 | Input fidelity | conditional | medium | Ghostty handles macOS IME composition natively (#11461 and others). Tier 1 carries committed text only; extending the Tier 3 side channel makes live composition display possible. |
| 4 | Profile compatibility | feasible | low | Implementable with Native Messaging plus the cookies API. Extension reinstallation works on external Chrome, a custom shell and Electron (not on CEF, which is eliminated). The Profile Bridge extension runs in the user's ordinary Chrome and is engine-agnostic. |
| 5 | Profile security | feasible | low | Per-origin permissions, one-shot transfer and the values-unlogged policy are all realizable within the extension permission model. |
| 6 | Agent control | feasible | medium | CDP multi-client is supported in Chrome 63+. cliweb already demonstrates human/agent shared control. |
| 7 | Remote extension | feasible | medium | The same-machine constraint of shared memory is confirmed. Remote needs a hardware video transport. |
| 8 | Browser fidelity (WebAPIs/media/input) | feasible | medium | CEF OSR does not support accelerated compositing (an OSR limitation) → it affects WebGL and hardware video decode. External Chrome (new headless) solves browser fidelity as "everything but the window". No custom shell required. |

The overall judgement: the architecture can hold up. Validations 1 (renderer), 3 (input) and 8 (browser
fidelity) are the structural kill switches, though, and the risk in those areas governs both the overall
schedule and the engine choice.
**The S0 decision (the user's): Engine = Electron.** Rationale: it leads on extensions, IME, fidelity,
frame pacing and distribution alike (proven by Orca's 34k stars). The differentiation is "tmux
pane-native plus a lightweight Electron" (memory mitigation). This reverses DESIGN.md's "Electron is
unsuitable as the core" — the Node/V8 duplication burden is pursued through a memory mitigation strategy
(BrowserWindow reuse, Node integration off, the GPU fast path). CEF is definitively eliminated for lacking
extensions. External Chrome is weak on frame pacing and IME. A custom Chromium shell is the long-term move
if Electron's memory proves untenable.

**The Electron memory mitigation strategy (the S1 validation target)**:
- Node.js in the main process only; renderers are pure Chromium renderers via `nodeIntegration: false` (minimizing V8 duplication).
- BrowserWindow reuse: one main process plus page separation, not a new window per pane.
- The GPU fast path: avoid the CPU `toBitmap()` with `offscreen.useSharedTexture: true` (experimental).
- damage-aware Kitty: `webContents.on('paint')` dirty rect → Kitty `a=t` + `a=p,U=1`.
- The goal: quantify the memory advantage over Orca (standalone Electron). On failure, the long-term move to a custom Chromium shell.

## 1. Renderer viability — the GPU fast path and the damage-aware Kitty path

### 1.1 Research findings

#### Electron SharedTexture (a GPU fast path candidate)

- With `webPreferences.offscreen.useSharedTexture: true`, frames are handed over directly as GPU textures
  without passing through the CPU. The official documentation describes it as "very fast" with
  "zero CPU-GPU transfers".
- The `SharedTexture` API converts a platform-specific handle into a `VideoFrame` and explicitly states it
  "can be transferred across Electron processes". `importSharedTexture`/`sendSharedTexture` are
  main-process only; `setSharedTextureReceiver` is renderer only.
- **Constraints**: the whole API is marked **experimental** with a "could be removed in the future"
  warning. The reference version is v43.2.0. The receiver has to be registered before `sendSharedTexture`
  is called, with a 1000ms timeout. The documentation says nothing explicit about IOSurface backing.
- It is the only GPU fast path candidate currently reachable, in contrast to awrit's frame path
  (`src/paint.ts`) using the `NativeImage.toBitmap()` CPU route.

#### CEF offscreen rendering (the comparison baseline)

- CEF OSR delivers "invalid regions and the updated pixel buffer" via `OnPaint()`. It **provides a CPU
  pixel buffer only** and the documentation never mentions GPU texture sharing, `SharedTextureServices`
  or IOSurface export.
- Decisively, it states it "does not currently support accelerated compositing so performance may suffer
  as compared to a windowed browser". Under OSR the GPU process is not used for rendering output and it
  operates as a software fallback.
- Rust bindings are absent from the official list of external projects (.NET, Delphi, Go, Java and Python only).

#### The Kitty graphics protocol (the basis of the compatibility path)

- damage/partial update: the `x, y, s, v` keys specify a source rectangle, composing a partial frame onto
  a background canvas.
- animation: `a=f` (frame transfer), `a=a` (animation control), the `z` key for gap control. The `c` key
  references a base frame, `X=1` replaces, and the default is alpha blend.
- shared memory: `t=s` for POSIX `shm_open`/Windows named shared memory. The terminal unlinks/closes after
  reading.
- capability query: `a=q` then `ESC[c`, with support decided by whether a response arrives. The terminal
  has to respond immediately without processing other input.
- placement: `a=p,i=<id>` places at the cursor, `U=1` uses a Unicode placeholder, parent-child relative
  placement (`P=`, `Q=`), z-index (`z`).

#### The Ghostty renderer

- Metal + CoreText on macOS, OpenGL on Linux. Dedicated read/write/render threads per terminal.
- It states Kitty graphics protocol support.
- **"Ghostty-only Terminal Control Sequences ❌ not yet implemented"** — with no proprietary extension
  today, a TWeb-enhanced Ghostty's local GPU surface fast path has to be implemented in a fork rather than
  upstream.

### 1.2 Feasibility assessment

DESIGN.md section 6.4 already decided that "putting memory efficiency first means not adopting Electron as
the product core". That decision is sound and the research supports it. The rendering paths and engines
assess as follows.

#### The engine candidates (two, with a custom shell as the last-resort hybrid)

| Engine | frame pacing (validation 1) | browser fidelity (validation 8) | maintenance cost |
|---|---|---|---|
| CEF OSR (prebuilt) | Tier 1 possible (CPU bitmap + dirty rect) | **insufficient** (no accelerated compositing → affects WebGL/hw video decode) | low (a prebuilt binary) |
| **external Chrome + CDP (new headless, Chrome 132+)** | a full-frame ceiling (screenshot-based) | **sufficient** ("everything but the window", GPU compositing, WebGL, hw video decode) | low (Chrome distribution) |
| ~~a custom Chromium shell~~ | the GPU fast path is possible | sufficient | **very high** (maintaining a fork) |

**The key finding (on re-assessment)**: new headless Chrome (Chrome 112+) "creates, but doesn't display,
any platform windows. All other functions, existing and future, are available with no limitations." That
is, **it creates invisible windows and uses the standard `//chrome` rendering pipeline as is**. CEF OSR not
using accelerated compositing is because CEF creates no window surface, not a structural limit of Chromium.
Therefore:

- **Browser fidelity (validation 8) is solved by external Chrome (new headless)**. No custom Chromium shell
  is required.
- **The only remaining ground for a custom Chromium shell is GPU texture export (the Tier 3 fast path)**,
  and even that is unnecessary if Tier 1 suffices.

A custom Chromium shell is meaningful **only as a last-resort hybrid trying to take CEF's cost advantage and
external Chrome's fidelity advantage at once**. As a standalone engine the case is weak. DESIGN.md section
6.4's "if CEF cannot provide GPU handle export, replace it with a custom Chromium shell adapter" is read as
**the last-resort fallback at the point where Tier 1 falls short and the GPU fast path becomes necessary**.

#### The rendering paths

| Path | Feasibility | Rationale |
|---|---|---|
| Tier 1 damage-aware Kitty (vanilla) | feasible, **the first validation target** | The Kitty protocol provides enough damage/composite/animation/shm/capability query. Implementable on both CEF (CPU bitmap) and external Chrome (screenshot). |
| The CEF path (the Tier 1 baseline) | feasible | OSR provides a CPU bitmap plus a dirty rect. Enough for Tier 1, but browser fidelity (validation 8) falls short. |
| external Chrome + CDP (new headless) | feasible | Browser fidelity is sufficient. Being screenshot-based, though, the frame pacing ceiling is low. |
| Tier 3 GPU fast path (IOSurface import) | a fallback candidate if Tier 1 fails | Electron's SharedTexture is experimental and duplicates Node/V8, making it unsuitable. A custom Chromium shell is the alternative for GPU texture export, at a very high maintenance cost. |
| The Electron path | unsuitable as the core | SharedTexture is experimental, and fundamentally it duplicates per pane the very Node/V8 runtime DESIGN.md sets out to remove. awrit/cliweb used Electron for a fast prototype, not for a GPU fast path (awrit's real path is the CPU `toBitmap()`). |

#### The compound trade-off in choosing an engine

**The S0 decision (reflecting user input)**: dependence on vimium, 1Password, developer extensions (React
DevTools and the like) and personalization tools is high, so **extension support cannot be given up**. Even
the minimum line the user set — "it has to at least be installable separately" (unpacked extension loading)
— is impossible on CEF, so **keeping DESIGN.md section 10 definitively eliminates CEF** and compresses the
engine candidates to three (external Chrome, a custom Chromium shell, Electron).

| Dimension | CEF OSR | external Chrome (new headless) | a custom Chromium shell | Electron | Notes |
|---|---|---|---|---|---|
| frame pacing (validation 1) | **ahead** (dirty rect) | behind (full-frame screenshots; both `captureScreenshot` and `startScreencast` are full-frame) | **ahead** (GPU texture export possible) | middling (`webContents.on('paint')` dirty rect, `SharedTexture` experimental) | **Electron is ahead of external Chrome**: an in-process paint event connects naturally to the damage-aware Kitty path. External Chrome has CDP full-frame only → a frame pacing ceiling |
| browser fidelity (validation 8) | behind (no accelerated compositing) | **ahead** (GPU compositing) | **ahead** (a GPU process) | **ahead** (real Chromium) | external Chrome/custom shell/Electron favoured |
| Korean IME (validation 3) | **potentially ahead** (inject the host IME directly) | behind (CDP Input, not a native IME) | **potentially ahead** (inject the host IME directly) | **ahead** (an embedded BrowserWindow does native composition via macOS `NSTextInputClient`) | **Electron is ahead of external Chrome**: native IME composition shows live in the browser field. External Chrome uses CDP `Input.insertText` (composed text only) and never shows the composition steps |
| extensions (validation 4) | **effectively impossible** (#4011, #4187) | **ahead** (`--load-extension`) | **ahead** (a real Chromium embed) | **ahead** (proven by Orca) | **CEF definitively eliminated** |
| distribution dependency | **ahead** (a prebuilt bundle) | behind (depends on the system Chrome) | behind (a Chromium build bundle) | **ahead** (Electron distribution) | CEF/Electron favoured |
| control stability | **ahead** (an embed API) | behind (CDP experimental) | **ahead** (an embed API) | middling (the Electron API) | CEF/custom shell favoured |
| memory baseline | **potentially ahead** | behind (all of Chrome) | **potentially ahead** | behind (Node/V8 duplication) | CEF/custom shell favoured |
| maintenance cost | low (prebuilt) | low (Chrome distribution) | **very high** (a fork) | low (Electron distribution) | only the custom shell is at the maximum |
| differentiation from Orca | — | **ahead** (a lighter runtime) | **ahead** (memory and performance) | behind (the same engine as Orca) | external Chrome/custom shell favoured |
| GPU fast path (Tier 3) | impossible | impossible | **possible** | possible (SharedTexture, experimental) | only the custom shell is stable |

The key insights:
- **Extension support is something the user cannot give up, so CEF is definitively eliminated.** The engine
  candidates are external Chrome, a custom Chromium shell and Electron.
- **Electron (the Orca path)** leads on extensions, fidelity, IME and distribution, but being the same engine
  as Orca it leaves TWeb's differentiation as tmux pane-native plus terminal graphics rendering alone, with a
  memory compromise.
- **A custom Chromium shell** is the only route that avoids Electron while taking all the benefits of embedded
  Chromium (extensions, fidelity, IME, the GPU fast path), at a very high maintenance cost. For the case where
  TWeb wants to differentiate from Orca.
- **External Chrome** gives the lightest runtime plus extensions and fidelity, at the cost of a frame pacing
  ceiling and weak Korean IME.

The key insight: **external Chrome is not "ahead on everything but performance."** It is clearly ahead on
browser fidelity (WebGL/media/extensions), but **CEF is ahead — or potentially ahead — on Korean IME input,
distribution dependency, control stability and the memory baseline.**

**Korean IME (validation 3)** and **extensions (validation 4)** in particular are the areas the user stressed.
External Chrome is weak on the Korean composition path because CDP `Input.insertText`/`dispatchKeyEvent`
perform no native IME conversion, but it supports extensions via `--load-extension`. Electron and a custom
Chromium shell favour Korean composition through direct host IME injection and support extensions too.

**The S0 decision: extensions cannot be given up, so CEF is definitively eliminated.** The engine candidates
are the three (external Chrome, a custom Chromium shell, Electron), and the choice happens at the
intersection of validations 1, 3 and 8 and of whether to differentiate from Orca. The possible outcomes:

- **Accept Electron (the Orca path)**: ahead on extensions, fidelity, IME and distribution. The fastest route
  to market. Being the same engine as Orca, though, TWeb's differentiation is tmux pane-native plus terminal
  graphics rendering alone, with a memory compromise. DESIGN.md's "Electron is unsuitable as the core" needs
  revisiting.
- **Release on external Chrome**: ahead on browser fidelity and extensions, with a lighter runtime. But
  accepting a frame pacing ceiling, weak Korean IME and a distribution dependency.
- **A custom Chromium shell**: the only route that avoids Electron while taking all the benefits of embedded
  Chromium (extensions, fidelity, IME, the GPU fast path). Memory and performance differentiation over Orca.
  At a very high maintenance cost (S2).
- **A hybrid (external Chrome by default plus a custom shell for the GPU fast path)**: very complex.

### 1.3 Risk and recommendations

**Risk: medium.** The experimental/fork risk of the GPU fast path is avoidable if Tier 1 suffices. The grounds
for lowering the risk from high to medium are the finding that the Kitty graphics protocol supports
damage/composite/animation sufficiently at the protocol level. The engine choice trade-off (CEF vs external
Chrome) is a separate risk.

**Recommendations**:

- **In S1, compare CEF OSR and external Chrome (new headless) across three dimensions (validations 1, 3, 8).**
  Measure frame pacing, Korean IME input and browser fidelity on each engine, then decide the choice or a
  hybrid that fits TWeb's use case. Keep a custom Chromium shell only as the last-resort hybrid for when none
  of the three works.
- **Include Korean IME input (validation 3) as a primary dimension of the engine choice.** A CEF embed makes
  it easier to inject host IME composition into Chromium directly, whereas external Chrome's CDP Input is not
  a native IME and the Korean composition path is weak. For a TWeb where Korean input matters, this dimension
  can be a meaningful obstacle to choosing external Chrome.
- **Make the Tier 1 damage-aware Kitty path the first validation target.** Implement damage-aware Kitty
  transfer from CEF OSR's CPU bitmap plus dirty rect and measure the target frame pacing. Electron is
  unnecessary at this stage.
- **Measure browser fidelity (validation 8) on external Chrome (new headless).** CEF's lack of accelerated
  compositing is an OSR limitation, so where WebGL/hw video decode is needed the external Chrome path is the
  answer. A custom shell is not needed for browser fidelity.
- **If Tier 1 meets the targets and the browser fidelity constraints are tolerable, release on CEF.** It has
  the lowest maintenance cost (a prebuilt binary).
- **Examine a custom Chromium shell only once the GPU fast path becomes necessary and external Chrome's frame
  pacing ceiling proves untenable.** That is the last-resort hybrid, and whether the Chromium fork maintenance
  cost (S2) is survivable needs a separate judgement.
- **Try upstream contributions before a Ghostty fork.** The "Ghostty-only Terminal Control Sequences ❌" mark
  is room for contribution that could reduce the fork burden. Take on the fork cost only on failure.

### 1.4 Design reinforcement: the frame path validation protocol

This makes DESIGN.md section 7.7's release gate concrete as validatable stages. The order is changed: Tier 1
first, two engines measured in parallel, and the GPU fast path as the last-resort fallback.

```text
Phase A — validating the Tier 1 damage-aware Kitty path (two engines in parallel)
    A-CEF:    CEF OSR CPU bitmap + dirty rect → a persistent shm ring → Kitty graphics
    A-Chrome: external Chrome (new headless) screenshot → an shm ring → Kitty graphics

    Measured in both:
    1. Write the CPU bitmap/screenshot into a persistent shared-memory ring (never shm_open per paint)
    2. dirty rect or change detection → adaptive tile mapping, transferring only changed tiles as Kitty graphics
    3. Measure 0 frame transfers while a static page is idle
    4. Measure 60Hz frame pacing during a 1080p continuous scroll
    5. Measure 0 stale image/shm objects after 10 minutes of animation
    6. After a resize, only the new generation displayed within 2 display frames

Phase A outcomes:
    CEF meets frame pacing + the browser fidelity constraints are tolerable → release on CEF, done
    external Chrome carries frame pacing + meets browser fidelity → release on external Chrome, done
    neither is tenable → on to Phase B/C for the GPU fast path (the last-resort hybrid)

Phase B — validating custom Chromium shell GPU texture export (the last-resort fallback)
    1. Export the GPU compositor output from a Chromium embed as an IOSurface/DMA-BUF
    2. Pass the handle over authenticated local IPC
    3. Measure 0 CPU full-frame copies
    4. (Only as a comparison baseline) the same measurements on Electron SharedTexture

Phase C — importing the handle into Ghostty
    1. Ghostty imports the received IOSurface handle as an MTLTexture
    2. Composite it to the pane geometry
    3. Swap generations on resize, never displaying a stale frame
    4. If this stage fails, it resolves to Tier 1 plus a future NativeSurfaceTransport
```

Phase A validates two engines in parallel with no Ghostty fork. If Tier 1 plus browser fidelity holds on
either one, the whole architecture is settled on the lightest path and can ship with no dependency on
Electron or a custom shell.

## 2. tmux semantics — the image cache, visibility, resize and kill

### 2.1 Research findings

- `switch-client -T <key-table>`: officially supported. "sets the client's key table; the next key will be
  looked up using key-table. After that key, the client is returned to its default key table."
- The `Any` special key: "A command bound to the `Any` key will execute for all keys which do not have a more
  specific binding." DESIGN.md section 9.2's Browser mode implementation works on this combination.
- `allow-passthrough`: not explicitly described in the man page, but cliweb and casty both require
  `set -g allow-passthrough all`/`on`. cliweb states tmux 3.3+ as required and 3.6+ as recommended.
- mouse: the `{mouse}` token identifies the pane an event occurred in. `send-keys -M` passes mouse events
  through. Separating pane interior mouse events from border resize events has to be implemented at the
  binding level.

#### tmux PR #5274: grid-resident Kitty image support (the heart of the changed judgement)

- **PR #5274** (open, 2026-06-25, author meisbokai, branch `ta/kitty-img`): "kitty images: render via unicode
  placeholders (grid-resident)". This is exactly the "tmux pane-aware Kitty implementation" the user intuited.
- **The approach**: tmux intercepts the Kitty APC and transmits the image data once to each kitty client with
  `a=t` (transmit-only, no placement). It then defines the render rectangle as a virtual placement via
  `a=p,U=1`. `U+10EEEE` placeholder cells fill the pane grid `cols × rows`, with the image id encoded in the
  foreground colour and the row in a combining diacritic. The image becomes an **ordinary grid cell**.
- **The pane-aware behaviour**: images "clip to their pane, scroll with the text, and coexist — none of which
  the overlay approach could do." Grid operations handle images themselves.
  - clip: automatically clipped to the pane boundary.
  - scroll: scrolls with the text.
  - resize: scaled by the same ratio on both axes, preserving aspect. The problem where `GRID_LINE_WRAPPED`
    reflow joined image lines and left ghosts is fixed by terminating with a real newline.
  - split: "produces no duplicated/ghost images" (verified by an automated test).
  - kill/scroll-off: an `image_store` (the same as sixel's) gives a per-screen image list ownership of the
    lifetime. A global image cap bounds memory. The bug where the cap released only one image via `==` is
    fixed.
- **The difference from passthrough**: being grid-resident rather than an overlay (floating above the grid),
  scroll/clip/clear/reflow work with no special handling.
- **An explicit limitation**: "image data is transmitted to clients attached at the time the image is
  captured." A late-attaching client cannot see existing images. "per-client transmit tracking on redraw" is
  needed. mgrant0's `4902-image-support` branch aims to generalize kitty+sixel and handle multiple attached
  terminals.
- **The upstream outlook**: nicm says it "will probably happen with it at some point", mgrant0 that it is
  "on my radar due next few weeks", and ThomasAdam will "happily review the final patch set". It is ready.

### 2.2 Feasibility assessment

This **updates** DESIGN.md section 7.4's judgement. The premise that stock tmux does not understand image
objects is being changed by PR #5274.

| Approach | Image location | pane clip | scroll | resize | kill/ghost | stale placement | TWeb's responsibility |
|---|---|---|---|---|---|---|---|
| passthrough overlay (the current baseline) | floating above the grid | no | no | ghosts | ghosting and cleanup cost | TWeb's reconcile | high |
| **grid-resident (#5274)** | **a grid cell** | **yes** | **yes** | aspect preserved | **no ghosts** | **tmux itself** | **low** |

- **Most of the baseline compatibility cost disappears.** The pane visibility, repaint reconciliation,
  deterministic delete and stale placement recovery TWeb was responsible for become tmux grid operations.
- **The enhanced tmux branch can be promoted from an optional tier to a default path candidate.** The odds of
  an upstream merge rose on nicm's and mgrant0's comments.
- Grid-resident uses **the standard Kitty graphics path (`a=t` + `a=p,U=1`)**, so it is fully compatible with
  the Tier 1 damage-aware Kitty path. TWeb's damage tile transfer integrates naturally with the tmux grid.
- **The limitation**: a late-attaching client cannot see existing images. That can be covered by TWeb
  redrawing the whole image on pane re-attach as a reconcile, and DESIGN.md section 8's "browserd reconciles
  the full state after reconnecting" structure applies directly.
- The Tier 3 GPU fast path's side channel travels over the browserd↔Ghostty local channel independently of
  tmux (DESIGN.md section 7.4, final paragraph), so it does not conflict with grid-resident.

The combination of `switch-client -T tweb-browser` plus `Any send-keys` plus returning on the reserved toggle
is confirmed as official tmux functionality, so the Browser mode input model holds up structurally.

### 2.3 Risk and recommendations

**Risk: medium → low (after grid-resident merges) / medium (before).** Once PR #5274 merges, the
visibility/reconcile burden shifts to tmux. Until then the existing baseline cost stands.

**Recommendations**:

- **Track PR #5274's merge actively and contribute if possible.** Once it merges, most of DESIGN.md section
  7.4's baseline compatibility cost disappears. Contributing late-attach per-client transmit tracking or
  stronger automated tests also improves the upstream relationship.
- **Reposition the enhanced tmux branch from "an optional tier" to "a default path candidate".** Examine a
  design revision that promotes DESIGN.md section 7.4's "optional enhanced tmux branch" to a default
  supported path on the basis of PR #5274. Keep the stock tmux passthrough fallback until it merges, though.
- **Cover the late-attach limitation with TWeb's reconcile.** The structure where browserd redraws the whole
  image on pane re-attach (section 8) already exists, so TWeb covers grid-resident's per-client transmit
  limitation naturally.
- **Settle the per-tmux-version conformance tests.** Mark `switch-client -T` `Any` forwarding, key-up/repeat,
  extended keys and mouse behaviour as "supported" only on versions where they work.
- **Keep stale image recovery as an idempotent reconcile.** Grid-resident handles most of it, but recovery
  from an abnormal exit is still TWeb's responsibility. Include the integration test in the baseline.

### 2.4 Design reinforcement: the tmux path matrix

```text
stock tmux passthrough (the Tier 1 baseline, before the merge)
    TWeb's responsibility: pane visibility, repaint reconcile, deterministic delete, stale placement recovery
    limitations: a floating overlay, with ghosts possible

grid-resident tmux (after #5274 merges, a Tier 1 promotion candidate)
    tmux's responsibility: clip, scroll, resize scale, split ghost prevention, kill/scroll-off lifetime
    TWeb covers: late-attach redraw reconcile (reusing the section 8 structure)
    the benefit: most of the baseline compatibility cost is removed

the enhanced tmux branch (the generalization direction of mgrant0's 4902-image-support)
    kitty + sixel unified, per-client tracking for multiple attached terminals
    upstream contribution first; a fork as the last resort
```

```text
tmux version compatibility

tmux 3.3   allow-passthrough introduced. The minimum supported (the passthrough baseline).
tmux 3.6   cliweb's recommended version. Any-key forwarding stability needs confirming.
tmux HEAD  PR #5274 grid-resident kitty image. Pre-merge. Validate on the integration branch.
```

Support is declared not as a version number but as "this capability was validated in this combination"
(consistent with DESIGN.md section 15's policy).

## 3. Input fidelity — Browser mode, the Korean IME, the mouse

### 3.1 Research findings

#### Ghostty handles IME composition natively on macOS

This corrects an earlier judgement. Intermediate Korean IME composition state is not a "structural limit of
the terminal protocol". Ghostty receives IME composition (preedit/marked text) natively via macOS
`NSTextInputClient`. The Korean IME issues confirm it.

- **#11461** (closed/fixed, 2026-04, milestone 1.3.2): "Korean IME preedit cancelled when pressing arrow
  keys". Fixed so that pressing an arrow key or delete commits the preedit rather than cancelling it
  (PR #12447), matching Apple Terminal.app.
- **#12547** (merged, 2026-05, milestone 1.4.0): "avoid replaying keys that commit preedit".
- **#13235** (open, 2026-07): "Korean IME: Initial syllable composition fails on first input".
- **#4634** (fixed, 1.1.0): fixed so modifier keys preserve the preedit.

The terms `preedit`, `commit` and `marked text` are used consistently, showing that Ghostty implements macOS
IME integration at the `NSTextInputClient` level. Ghostty already knows the intermediate composition state,
in other words, and what remains is **by which path that composition event reaches tweb __pane and Chromium**.

#### The delivery path determines the fidelity

| Path | Intermediate composition state | Rationale |
|---|---|---|
| PTY + the Kitty keyboard protocol | unsupported, committed text only | The PTY is a byte stream and the Kitty keyboard protocol does not deal with the composition lifecycle. This path's limit is real. |
| a native side channel (enhanced Ghostty) | **supportable** | Ghostty receives macOS IME composition natively. Forward it to tweb __pane over an authenticated local IPC side channel. This extends DESIGN.md section 7.2's "the roles of the PTY and the side channel" to input. |
| direct injection by the Chromium embed host | **supportable** | Chromium accepts injected composition from a host through the `TextInputClient`/`setMarkedText`/`insertText` family. The CEF API documentation is empty so this is unconfirmed, but `iced-cef` putting an input adapter on its roadmap points the same way. |

#### The limits of the CDP path

- CDP `Input.insertText`: can deliver CJK composed text straight into a focused editable. But since CDP
  performs no native IME conversion, the composition sequence has to be simulated with
  `Input.dispatchKeyEvent`.
- casty's finding that Google login works when `Runtime.enable` is off shows CDP settings can affect
  authentication flows.
- The CDP path is for agent automation, not for human IME input. Human Korean input has to go the
  Ghostty native IME → side channel → Chromium host injection route for fidelity to be guaranteed.

### 3.2 Feasibility assessment

**Risk: medium.** Lowered from the earlier high assessment, because a path that can carry the intermediate
composition state (a native side channel) is confirmed.

- **Tier 1 (vanilla Ghostty + tmux)**: committed text only. The PTY byte stream limit means the intermediate
  composition state cannot show live in the browser field. That is not "Korean input does not work" but "the
  composition steps do not show live in the browser field; the final characters are entered correctly".
- **Tier 3 (enhanced Ghostty)**: the intermediate composition state can show live. DESIGN.md section 7.2's
  side channel was meant for GPU handles/fences, but **carrying input composition events over that same side
  channel** is all it takes. This is a new finding: Tier 3 is needed **not only for rendering performance but
  for Korean input fidelity too**.
- If the host injects composition on the Chromium embed side via `setMarkedText`/`insertText`, the characters
  being composed show live in the browser input field.

DESIGN.md section 9.4's policy — "where the composition lifecycle cannot be carried, support committed-text
input and state the constraint" — remains valid as **the Tier 1 fallback policy**. It must not be taken as the
whole product's Korean input policy, though. Live composition display has to be the goal at Tier 3.

The principle of not working around this with global key event interception is sound. Using the native IME path
while carrying it over a side channel does not undermine the Browser mode input ownership split (section 9.1) —
the side channel is a composition event delivery path, not an input ownership path.

### 3.3 Recommendations

- **Design Korean input in two stages.** Tier 1 is committed text; Tier 3 is live display of the intermediate
  composition state. Frame Tier 1 as "Korean input support" and Tier 3 as "Korean input fidelity".
- **Extend DESIGN.md section 7.2's side channel to input composition events.** Add `setMarkedText`/
  `insertText`/`unmarkText` events to the side channel that originally carried only GPU handles/fences. The PTY
  still owns pane identity, placement, frame tokens, focus and visibility.
- **Make Tier 3 a validation target from the Korean input fidelity angle too.** DESIGN.md originally treated
  Tier 3 purely as an optional rendering performance tier, but for Korean users live composition display is
  important at the level of a basic feature. Include Tier 3 composition delivery in validation 3's (input
  fidelity) pass criteria.
- **Validate the path where the Chromium embed host injects composition.** Confirm whether
  `setMarkedText`/`insertText` work through CEF's `CefBrowserHost` IME API or a custom Chromium shell's
  `TextInputClient`. `iced-cef`'s input adapter roadmap points the same way.
- **Manage input fidelity as its own conformance area.** Test Korean composition, bracketed paste, the OSC 52
  clipboard, browser selection copy and file drop independently. Measure Korean composition separately for
  Tier 1 (committed) and Tier 3 (composition).
- **Keep stating that `NativeSurfaceTransport` does not solve the PTY input limits.** It is a rendering
  fallback; as long as input goes through the PTY it does not solve the IME composition limit. The side
  channel extension, though, is an input-path solution separate from `NativeSurfaceTransport`.

### 3.4 Design reinforcement: the input path and composition delivery

```text
Korean input fidelity per path

Tier 1 (vanilla Ghostty + tmux, PTY only)
    macOS IME → Ghostty NSTextInputClient → commit → the PTY byte stream
              → tweb __pane → Chromium insertText (committed only)
    Korean input: works (the final characters)
    live composition display: no

Tier 3 (enhanced Ghostty, PTY + a side channel)
    macOS IME → Ghostty NSTextInputClient
              ├─ commit → the PTY byte stream (unchanged)
              └─ preedit/marked text → the side channel → tweb __pane
                                       → the Chromium host's setMarkedText/insertText
    Korean input: works
    live composition display: yes

Agent automation (CDP)
    CDP Input.insertText (composed text) or a dispatchKeyEvent simulation
    Korean input: works (composed text)
    live composition display: not applicable (an automation path)
```

```text
the side channel composition event schema (conceptual)

CompositionEvent
├── kind: markedText | insertText | unmarkText
├── pageID
├── text
├── selectedRange
└── generation
```

The PTY keeps pane identity, placement, frame tokens, focus and visibility. The side channel carries GPU
handles/fences and composition events together, while input ownership (Browser mode) belongs to the tmux key
table on the PTY path.

## 4. Profile compatibility — Chrome extensions, bookmarks, site state

### 4.1 Research findings

- The Chrome Native Messaging host manifest locations are clear per platform.
  - macOS system: `/Library/Google/Chrome/NativeMessagingHosts/`
  - macOS user: `~/Library/Application Support/.../NativeMessagingHosts/`
  - Linux: `/etc/opt/chrome/native-messaging-hosts/` or `~/.config/...`
  - Windows: a registry-based manifest path
- Communication is stdin/stdout JSON with a 32-bit length prefix. host→Chrome is capped at 1 MB,
  Chrome→host at 64 MiB.
- `allowed_origins` whitelists extension IDs exactly (no wildcards).
- The host cannot reach cookies or tabs directly; the extension has to pass them explicitly.
- `runtime.connectNative()` is a persistent port; `runtime.sendNativeMessage()` is one-shot.

### 4.2 Feasibility assessment

DESIGN.md section 10's Chrome Profile Bridge design is realizable on the Native Messaging plus cookies API
combination, but **it depends on which engine it runs in.** Two extension roles have to be distinguished.

#### The two extension roles

| Role | Where it runs | CEF | external Chrome |
|---|---|---|---|
| The Profile Bridge extension (cookies/bootstrap) | **the user's ordinary Google Chrome** | not applicable (engine-agnostic) | not applicable (engine-agnostic) |
| Reinstalling the user's extensions (1Password, uBlock and so on) | **inside the TWeb embedded browser** | **effectively impossible** | **possible** (real Chrome) |

The Profile Bridge extension runs in the user's ordinary Chrome for the purpose of reading cookies, so it is
independent of the TWeb embedded browser engine (CEF/external Chrome). It is unaffected by the engine choice.

**What the engine choice does affect is the second role.** DESIGN.md section 10.5 deals with "reading the
extension metadata from the Chrome profile and reinstalling by Web Store ID". For a user's Chrome extensions
to work inside the TWeb browser too, in other words, **the embedded browser has to support extensions.**

#### CEF makes extensions inside the embedded browser effectively impossible

The research:
- CEF's official documentation (General Usage) never mentions extensions at all.
- **#4011** "Extension tab API is not working for OSR" — **Not planned/skipped** (2025-10). CEF officially
  decided not to fix the extension tab API under OSR mode. TWeb defaults to OSR, so this hits directly.
- **#4187** "feat: add new Extensions API for Alloy and Chrome runtimes" — **abandoned** (2026-06). The attempt
  to add an extension API was dropped.
- Even Electron (the same Chromium embed) supports only a "subset" of extensions and explicitly states that
  being "perfectly compatible is non-goal". No Web Store extensions, unpacked only, no `.crx`, a reload every
  time, and no `storage.sync`/`storage.managed`. CEF is more restricted still.

**Reinstalling and running a user's extensions (1Password, uBlock, the Okta Browser Plugin and so on) inside a
CEF embedded browser is therefore effectively impossible.** DESIGN.md section 10.5's extension synchronization
does not work on CEF.

#### Extensions do work on external Chrome (new headless)

External Chrome is real Chrome, so every extension works. The extension loading approach under new headless
(`--load-extension` or `--disable-extensions-except`) and profile-based extension persistence do need separate
validation in S1, though.

### 4.3 Risk and recommendations

**Risk: medium.** (Raised from the earlier low assessment, since CEF's inability to do extensions is decisive
for the engine choice.)

- **First decide whether DESIGN.md section 10 (extensions/profile bootstrap) stays a core product feature.**
  Keeping it effectively eliminates CEF from the engine candidates and leaves external Chrome as the only
  engine. Demoting section 10 to a non-goal, or working around it as "extensions only via the external Chrome
  handoff", brings CEF back as a candidate.
- **State in the documentation that the Profile Bridge extension is engine-agnostic.** This extension runs in
  the user's ordinary Chrome, so cookie bootstrap works even on CEF. There is room for confusion here.
- **Implement the Native Messaging host in Rust.** It is consistent with the core language policy, and
  stdin/stdout JSON framing is simple in Rust. Since Chrome spawns the host, though, the host binary path has
  to be fixed in the manifest.
- **Validate external Chrome new headless's extension loading approach in S1.** Whether `--load-extension`,
  `--disable-extensions-except` and profile-based extension persistence work under new headless.
- **Manage extension compatibility results in a per-version registry.** Accumulate probe results as the grounds
  for classifying 1Password and the Okta Browser Plugin as `managed-chrome-only`.

### 4.4 Design reinforcement: the per-engine extension path matrix

```text
The Profile Bridge extension (cookies/bootstrap)
    runs in: the user's ordinary Google Chrome
    engine-agnostic (not applicable to any engine)
    path: a Chrome Native Messaging host (Rust) ↔ the extension ↔ twebd
    limitation: no effect on the engine choice. Cookie import works over this path even on CEF.

Reinstalling the user's extensions (1Password, uBlock, the Okta Plugin and so on)
    inside a CEF embedded browser:
        effectively impossible (#4011 OSR not planned, #4187 abandoned)
        → the user has to be told plainly that "extensions do not work in TWeb"
    inside external Chrome (new headless):
        possible (real Chrome, --load-extension)
        but: the new headless extension loading approach needs S1 validation
    a custom Chromium shell:
        possible (a real Chromium embed, with extension API access)
        but: a very high maintenance cost
    Electron:
        possible (proven by Orca, with Web Store installs supported too)
        but: the same engine as Orca plus a memory compromise

DESIGN.md section 10.5's extension synchronization policy
    CEF: does not work → make section 10.5 a non-goal or replace it with the workaround path (4.5)
    external Chrome/a custom shell/Electron: works → section 10.5 realizable as written
```

### 4.5 The extension workaround: can CEF be brought back as a conditional candidate?

When the user said "it has to at least be installable separately", the nuance was **wanting to use their
existing extensions as they are**, but a workaround is also possible: "cookie import plus TWeb providing
vimium-like shortcuts itself would do." If that workaround satisfies the requirement, CEF returns as a
candidate.

#### cookie import — possible on CEF too (engine-agnostic)

- The Profile Bridge extension runs in the user's ordinary Chrome and reads the cookies (section 4.2).
- A Native Messaging host (Rust) receives the cookie values and injects them programmatically into the TWeb
  embedded browser.
- CEF can inject them via `CefCookieManager` plus the cookie set API (present in the headers).
- **Cookie import therefore works on CEF too.** It has to use the Profile Bridge extension path, though, not a
  direct read of Chrome's Cookies SQLite (forbidden by section 10.2).

#### Bundling vimium — partly possible, not wholly

Researching vimium's features splits them into two groups:

| Feature | Needs an extension API? | Workable around on CEF? |
|---|---|---|
| scrolling (`j`/`k`), find (`/`), link hints (`f`), visual mode (`v`) | no (pure DOM) | **yes** — via JS injection |
| tab create/close/restore (`t`/`x`/`X`), history (`H`/`L`), windows (`W`) | yes (`chrome.tabs`/`windows`) | **TWeb can implement it per tmux pane** — which suits tmux-native better anyway |
| bookmarks/history (`o`/`O`/`b`/`B`) | yes (`chrome.bookmarks`/`history`) | **hard** — TWeb would need its own bookmark/history store |
| chrome.storage (settings) | yes | replaceable by TWeb's own config |
| clipboard (`yy`) | partly (`navigator.clipboard.writeText`) | possible from JS over HTTPS |

**Vimium's core navigation (link hints, scroll, find) can therefore be bundled on CEF via JS injection**, and
**implementing tab/window management per tmux pane in TWeb** actually gives a natural TWeb-specific path
distinct from Orca/Chrome. Only bookmark/history access needs a separate store.

#### Other extensions are hard or impossible to work around

Vimium can be reimplemented, but:
- **1Password**: needs the browser extension API plus native messaging plus secure enclave access. TWeb cannot
  reimplement it. Using the existing extension as is requires an extension-capable engine.
- **uBlock**: content scripts plus the webRequest API plus managing a vast set of ad-blocking rules.
  Reimplementation is effectively impossible.
- **React DevTools**: the DevTools extension API. CEF's DevTools extension support is uncertain.

#### Judging the workaround

| The user's requirement | Workable around on CEF? |
|---|---|
| "I want to install and use my existing Chrome extensions as they are" (vimium, 1Password, uBlock, React DevTools and so on) | **no** — CEF stays eliminated |
| "cookie import plus TWeb providing vimium-like shortcuts itself would do" | **yes** — CEF returns as a candidate. But 1Password/uBlock/React DevTools are given up or handed off to external Chrome |
| "vimium alone is enough; other extensions can be built into TWeb or handed off" | **yes** — CEF returns as a candidate |

**The workaround can therefore bring CEF back as a conditional candidate**, but if the user wants to use
existing extensions such as 1Password/uBlock/React DevTools as they are, CEF stays eliminated. This judgement
is an open item in S0.

## 5. Profile security — origin-scoped one-shot cookie transfer

### 5.1 Feasibility assessment

- Per-origin runtime permission requests, one-shot transfer and the values-unlogged policy are all realizable
  within the extension permission model.
- Preserving `HttpOnly`, `Secure` and partitioned cookies is possible, since the `cookies` API returns the
  attributes along with them.
- Applying the organization/IdP denylist on the extension side first is implementable.
- The requirement to pass a threat model and a separate security review (section 16) is already stated.

**Risk: low.** Recommendations:

- **Validate by test the rule that the cookie transfer audit records only the domain, the count, the
  source/target and the time.** Establish with a redaction test that no value is ever exposed in a log.
- **Enforce in code, not in config, the policy that blocks lifting the sensitive-domain denylist unless
  organization policy explicitly approves it.** If user configuration can lift it, there is a policy-bypass
  risk.

## 6. Agent control — a human and an agent sharing one page

### 6.1 Research findings

- CDP has supported multi-client since Chrome 63. Several clients can attach to the same page.
- Opening the built-in DevTools frontend does detach an existing CDP connection with
  `replaced_with_devtools`, though → sharing works as long as the scenario is not a human opening Chromium's
  DevTools directly.
- cliweb already implements human/agent shared control. Codex and a human share the same Chromium instance,
  with the human driving directly in a browser split and Codex automating via `cliwebctl`. "A human can
  interact between any two commands; Codex should simply inspect the new state before continuing."
- cliweb exposes neither cookie values, the password store nor arbitrary page JavaScript in the control
  protocol.

### 6.2 Feasibility assessment

- Because the human drives through TWeb's terminal frontend rather than Chromium's UI directly, the DevTools
  frontend detach issue does not apply to the TWeb scenario.
- Human input and agent CDP commands can reach the same page simultaneously, and cliweb has already proven it.
- DESIGN.md section 12.1's policy of "suspending the agent lease once a human starts giving the browser input"
  points the same way as cliweb's "inspect new state before continuing" pattern.

**Risk: medium.** Recommendations:

- **State the interleaving of the agent command queue and human input as a lease model.** Borrow the contract
  from cliweb's pattern: once a human starts typing, suspend the agent lease, and after the human input ends
  the agent takes a new snapshot.
- **Make sure agents cannot bypass the confirmation right before an external submit, purchase, message send,
  upload or delete (section 12.1).** That has to be enforced at the capability level, never left to the agent
  prompt alone.

### 6.3 Design reinforcement: the lease state machine

```text
IDLE        the page exists with no active controller
HUMAN       a human is typing. Agent commands wait, or the lease is suspended
AGENT       an agent holds the control lease. Human input switches it to HUMAN
CONTENDED   a human and an agent try to type at once. Coordinated with the user against the last snapshot
```

Not using arbitrary last-write-wins in the `CONTENDED` state but showing the user an explicit coordination UI
is consistent with section 10.3's "never arbitrary last-write-wins on a conflict".

## 7. Remote extension — swapping the transport

### 7.1 Research findings

- cliweb: "The terminal emulator, tmux server, and cliweb process must run on the same machine because
  rendered frames use POSIX shared memory." → a shared memory locality constraint.
- casty: works over SSH/headless on CDP screenshots. But full-frame JPEG/PNG, ~20fps, base64 encode/decode and
  inline 4096-byte chunks give it a clearly low performance ceiling. casty's author also positions it as a
  low-framerate fallback/static snapshot backend rather than an interactive primary renderer.
- The Kitty graphics protocol's `t=s` shared memory presumes the same machine. The protocol does not support
  cross-host transfer.

### 7.2 Feasibility assessment

- DESIGN.md section 7.6's remote path, "→ hardware video transport", matches the research. Shared memory being
  confined to one host, remote needs a video encode/decode path.
- The design that separates resource identity from storage location via `tweb://resource/<id>` (section 12.12)
  supports cross-host materialization.
- The policy (section 18) of keeping a casty-style CDP screenshot path as a low-framerate fallback where
  `RemoteVideoTransport` is unavailable is sound.

#### Separating remote after choosing Electron (process location vs rendering surface)

**The remote case becomes clearer after the S0 decision (Engine = Electron).** The key is DESIGN.md section
7.6's structure, which **separates the browser process's location (BrowserRuntime) from how frames are
delivered (FrameTransport)**:

```text
the local case: tmux, Ghostty, tweb and Electron all on the same machine
    Electron webContents paint → SHM/Kitty graphics → the local Ghostty (simple)

the remote case: the tmux server and Electron remote, Ghostty and the user local
    remote Electron webContents paint → video encode → the network →
    the local tweb __pane decodes → the local Ghostty Kitty graphics
    input: the local Ghostty → SSH/tmux → the remote tweb __pane → the remote Electron
```

- **frames**: the remote Electron's `webContents.on('paint')` → video encode via `RemoteVideoTransport` →
  decode locally → Kitty graphics. Matches DESIGN.md section 7.6's `RemoteVideoTransport`.
- **input**: it originates locally, so it travels to the remote over SSH/tmux.
- **resources**: `tweb://resource/<id>` is a global identity, and the ResourceBroker decides the transfer
  mechanism from locality (hostID, storageKind) (section 12.12).

#### The extra difficulty of the Korean IME in the remote case

**The local case** is solved by the Electron BrowserWindow receiving native composition via macOS
`NSTextInputClient`. In **the remote case**, though:
- The Electron BrowserWindow is remote, so it uses the **remote macOS IME**.
- The user's local IME state and the remote IME state differ.
- **Tier 1**: send only committed text to the remote (after the local IME composition finishes) — little
  affected by network latency.
- **Tier 3**: inject local composition events into the remote Electron over the side channel — but network
  latency may make live composition display hard.

**Live Korean IME composition display is therefore harder in the remote case than the local one.** That means
validation 3 (input fidelity) has to measure local and remote separately.

**Risk: medium.** Recommendations:

- **Do not validate the remote transport in the first release gate; treat it as an extension area after
  validations 1–3 pass.** Section 17's order already does this. Remote is a structure that swaps only the
  transport while keeping identity/APIs, so deferring it until the local path holds does not break the
  architecture.
- **Solve the local case completely first and handle remote as a separate phase.** Once Electron's native IME
  plus the damage-aware Kitty path hold locally, adding `RemoteVideoTransport` still leaves
  `BrowserPageID`/profile/automation APIs unchanged.
- **Make the remote Korean IME its own validation.** Locally, Electron's native IME makes live composition
  display possible; remotely, network latency plus IME state synchronization make it harder. A committed-text
  fallback may be the realistic answer remotely.
- **State the performance ceiling of the casty-style screenshot fallback in the documentation.** Apply the same
  policy of not hiding "this is not an interactive primary renderer" from the user (section 7.3) to the remote
  fallback too.

## 8. Browser fidelity — guaranteeing WebAPIs, media and input handling at shipping-browser level

### 8.1 Problem statement

DESIGN.md stresses "a real Chromium browser" repeatedly but never treats which WebAPIs/media work at
shipping-browser level as its own validation area. As the user raised, an experience inside the terminal that
"looks like a browser but where parts don't actually work" damages product trust directly. This area is added
as validation 8 and connected to the engine choice.

### 8.2 Research findings

#### The key finding: "no accelerated compositing" is an OSR limit, not a Chromium limit

- CEF OSR not using accelerated compositing is **because CEF creates no window surface**.
- **new headless Chrome (Chrome 112+)** "creates, but doesn't display, any platform windows. All other
  functions, existing and future, are available with no limitations." That is, **it creates invisible windows
  and uses the standard `//chrome` rendering pipeline as is**. GPU compositing, WebGL and hardware video decode
  all work.
- **Browser fidelity (validation 8) is therefore solved by external Chrome (new headless)** and no custom
  Chromium shell is required.

#### WebAPI/media support per engine (two, with a custom shell as the last-resort hybrid)

| Feature | CEF OSR | external Chrome + CDP (new headless) |
|---|---|---|
| WebGL / 3D CSS | **affected** (no accelerated compositing) | **supported** (a window exists, GPU compositing) |
| Hardware video decode | **affected** | **possible** |
| Canvas 2D | a software path | works |
| WebRTC (camera/mic) | documented as "supported" | works, though device access is separate |
| Audio playback | **needs separate device routing** | system audio directly |
| Autoplay policy | the Chromium default | the Chromium default |
| Codecs (H.264/AAC/AV1) | depends on the Chromium build | the same |
| WebCodecs | depends on the Chromium build | the same |
| WebAuthn / credentials | works | works |

(A custom Chromium shell has the same fidelity as external Chrome but a very high maintenance cost, so it is a
last-resort hybrid only and is left out of the table.)

#### The structural peculiarity of the audio pipeline

- Chromium audio is **pull-based**, with the sound card driving the clock. With no audio device, the system
  clock drives video decode/render.
- Because of the sandbox, a renderer process cannot open an audio device directly; the browser process opens it
  on its behalf. Avoiding audio output in an embedded Chromium requires a design in which the browser process
  either opens the audio device or **intercepts the audio output and routes it elsewhere**.
- casty requiring a separate PulseAudio install on a headless server is a concrete instance of this limit.
- TWeb runs on the user's machine so system audio exists, but **how the audio of several browser panes is
  mixed/routed** is the design point. Per-pane mute, volume and audio routing are needed.
- With external Chrome (new headless), the browser process opens the system audio device directly, so the audio
  routing burden is smaller than CEF's. Per-pane mute/volume still needs its own design.

#### The new headless Chrome premise

- Chrome 132+'s new headless is used. The old headless shell was split into a separate binary
  (`chrome-headless-shell`), which Puppeteer's `headless:'shell'` points at. TWeb uses new headless only.
- The external Chrome + CDP path shares one browser process and separates only pages, respecting DESIGN.md's
  "never duplicate the runtime per pane" principle. The absence of a GPU fast path (full-frame screenshots) is
  measured separately as validation 1's frame pacing ceiling.

#### CEF OSR's constraints (the browser fidelity dimension)

- No accelerated compositing → WebGL, 3D CSS and hardware video decode degrade to a software fallback or fail.
- Even if the Tier 1 damage-aware Kitty path meets frame pacing, failing to reach shipping-browser level on
  WebGL/video means failing the browser fidelity validation.
- If TWeb's main use cases (dev server previews, dashboards, form entry) do not require WebGL/hw video decode,
  though, CEF's constraints are tolerable.

### 8.3 Feasibility assessment

**Risk: medium.** Lowered from high, since browser fidelity is solved by external Chrome (new headless). The
remaining risk is how to choose between, or combine, CEF's and external Chrome's directly opposed trade-off
(frame pacing vs browser fidelity).

| Engine | frame pacing (validation 1) | browser fidelity (validation 8) | maintenance cost |
|---|---|---|---|
| CEF OSR | Tier 1 possible | **insufficient** (affects WebGL/hw video decode) | low |
| **external Chrome + CDP (new headless)** | a full-frame ceiling | **sufficient** | low |
| a custom Chromium shell (the last-resort hybrid) | the GPU fast path is possible | sufficient | very high |

Validations 1 and 8 **point at different engines**, in other words. CEF has good frame pacing but insufficient
browser fidelity; external Chrome has good browser fidelity but a low frame pacing ceiling. Resolving that
trade-off is the essence of S1, and the possible outcomes are:

- **Release on CEF and accept stated browser fidelity constraints**: if WebGL/hw video decode is not essential
  to TWeb's use cases.
- **Release on external Chrome and accept the frame pacing ceiling**: if full-frame screenshots fall short of
  60fps but most pages are static or a low framerate is acceptable.
- **A hybrid (CEF for Tier 1 + external Chrome by per-page routing)**: ordinary pages on CEF,
  media-heavy pages on external Chrome. The complexity of running two engines at once.
- **The last-resort hybrid, a custom Chromium shell**: only when none of the three works. A very high
  maintenance cost.

### 8.4 Recommendations

- **Measure browser fidelity (validation 8) on external Chrome (new headless).** CEF's lack of accelerated
  compositing is an OSR limitation, so where WebGL/hw video decode is needed the external Chrome path is the
  answer. A custom Chromium shell is not needed for browser fidelity.
- **Judge the CEF vs external Chrome trade-off in S1.** Measure validation 1 (frame pacing) and validation 8
  (browser fidelity) on each engine, then decide the choice or a hybrid that fits TWeb's use case.
- **State WebGL/canvas/hw video decode/WebRTC/audio as browser fidelity conformance items.** Measure each per
  engine and never hide a shortfall against shipping Chrome in the documentation (extending section 7.3's
  policy).
- **Design audio routing per pane.** The browser process controls mute/volume/routing per pane, and where no
  system audio device exists (a headless server, remote) there is a policy of omitting audio or routing it to a
  separate sink.
- **State new headless Chrome (Chrome 132+) as a premise of the external Chrome path.** The old headless shell
  has WebAPI shortfalls and is not used.
- **Validate input handling (section 3) and media together.** Korean IME composition (the Tier 3 side channel)
  and audio/video/WebRTC have to work simultaneously in the same pane. Confirm the input path does not
  interfere with the media pipeline.

### 8.5 Design reinforcement: the browser fidelity conformance items

```text
WebAPI/media conformance (measured per engine, against shipping Chrome)

Rendering
├── WebGL 1/2 — hardware accelerated, plus software fallback performance
├── Canvas 2D — works correctly
├── 3D CSS transforms — whether GPU accelerated
└── WebGPU (future) — whether supported

Media
├── H.264/AV1/VP9 video decode — hardware vs software
├── Audio playback — system audio routing, per-pane mute/volume
├── Autoplay policy — respecting the Chromium default
├── WebRTC — camera/mic access, getDisplayMedia
├── The Media Session API — media keys, metadata
└── WebCodecs — encode/decode support

Input (integrated with validation 3)
├── Korean IME composition (the Tier 3 side channel)
├── clipboard (OSC 52 / browser selection)
├── drag-and-drop files
├── WebAuthn / credentials
└── gamepad / sensors (optional)

Identity/security
├── Service Workers / PWAs
├── cookies / storage / partitioned cookies
├── Content Security Policy
└── the Permissions API (camera/mic/notifications)
```

Each item is classified as "identical to shipping Chrome / constrained / unsupported", and the constrained and
unsupported ones are stated to the user (extending section 7.3's policy).

## 9. Summary of the precedent project analysis

### awrit (archived 2026-04-25)

- "I no longer have time to maintain my hobby projects and with the rising number of security issues" — the
  burden of security updates is the direct reason maintenance stopped.
- That suggests DESIGN.md goal 11, "adopt Chromium security updates continuously and quickly", is not a mere
  non-functional requirement but a survival condition.
- awrit's `NativeImage.toBitmap()` CPU path, its unused dirty rectangle and its repeated
  `shm_open`/`ftruncate`/`mmap` match exactly the bottlenecks DESIGN.md section 7.1 already diagnosed.
- The proposed successor, cmux, is not an awrit fork but a separate macOS app built on libghostty + WebKit. Not
  being a successor to a Chromium-based terminal browser, it is excluded from TWeb's reference models.

### cliweb (an awrit fork)

- It already implements the same-machine premise (shared memory), an Electron base, the `cliwebctl`
  authenticated Unix socket, semantic refs (`d1-n13`) and human/agent shared control.
- The research confirms both what DESIGN.md adopts (tmux pane discovery, a persistent profile, semantic refs,
  shared control) and what it replaces (treating passthrough visibility hooks as a normal path, the
  same-machine coupling).
- 1 star, 0 forks — a niche tool, but with architectural reference value.

### casty

- Raw CDP over WebSocket (~1200 JS lines), no Playwright/Puppeteer, a low-res screencast mixed with hi-res
  captures, adaptive JPEG/PNG, `CSI 14t` pixel size and DPR awareness.
- The finding that Google login works when `Runtime.enable` is off shows how sensitive CDP settings are.
- The research confirms both what DESIGN.md adopts (the minimal CDP domains, the terminal pixel query, the
  low-resolution change-detection signal, pinned image ID dedup) and what it replaces (full-frame JPEG/PNG,
  ~20fps, base64, inline chunks, `--no-sandbox`, stealth scripts).

### iced-cef (for reference, early stage)

- A standalone crate integrating CEF OSR into the Rust GUI framework `iced`. The same trajectory as TWeb's
  Rust core + CEF direction.
- **State**: architecture scaffolding only (5 commits, 0 stars). No CEF adapter implemented, an input adapter
  on the roadmap, and rendering envisioned as zero-copy (DMA-BUF/wgpu) plus a CPU fallback. Linux Wayland only,
  no macOS, no mention of IME.
- Reference value: an instance validating the Rust + CEF OSR + zero-copy GPU path combination, confirming TWeb's
  implementation direction is not a lone attempt. It does not deal with the macOS Korean IME or tmux
  integration, though, so TWeb has to solve those itself.

### Orca (the closest goal, **Electron + embedded Chromium**)

- **Stack confirmed**: an `electron.vite.config.ts` present, pnpm, TypeScript/React, no `Cargo.toml` →
  **Electron + TypeScript/React**. "real Chromium window" = the Chromium Electron embeds. 33,952 stars, 7,652
  commits, cross-platform (macOS/Windows/Linux) plus mobile.
- "real Chromium window — address bar, history, devtools — embedded in a pane." An embedded Chromium instance
  per worktree. Tabs/scroll positions are scoped to the worktree.
- The agent shares the same browser via the `orca snapshot/click/fill` CLI. "same browser you interact with,
  same tabs" — not a separate headless session. The same shared-control model as TWeb section 12.
- Design Mode: clicking an element attaches HTML/CSS/a cropped screenshot/the source map to the agent. The same
  as TWeb section 12.7's ElementContextBundle.
- Cookie import: one-click from Chrome/Edge. Viewport emulation via CDP device emulation.
- **The engine decision**: **Electron** (embedded Chromium). Extensions, fidelity and agents all secured on
  Electron rather than CEF. None of the six precedents used CEF, and Orca — the closest goal among them —
  achieved it on Electron.
- **TWeb's dilemma**: with Orca having already achieved the same functionality on Electron, one of TWeb's
  reasons to exist weakens. For TWeb to build a lighter runtime with a Rust core plus a custom embed, it has to
  prove a **substantive advantage over Orca (Electron) in memory, performance or terminal-native rendering**.
  Otherwise the answer is "just use Orca". At the same time, Orca being Electron is strong evidence that
  **the embedded Chromium path really works**, and for TWeb to take the benefits of embedded Chromium while
  avoiding Electron, **a custom Chromium shell** becomes the Orca alternative. That is the point where the case
  for a custom Chromium shell comes back to life in S1.

### cmux (macOS native, WebKit + libghostty)

- A native macOS app (Swift/AppKit). Terminal rendering GPU-accelerated via libghostty. The browser is WebKit
  (macOS native). It ports the scriptable API of agent-browser (Vercel Labs).
- Cookie/session import: from Chrome, Firefox, Arc and 20+ browsers.
- **The engine decision**: **WebKit**, not Chromium. It gets the macOS native IME naturally (side-stepping the
  Korean input problem). But it is Safari-extension level rather than Chrome-extension compatible, and it is
  not cross-platform (macOS only).
- Reference value: the implication that **securing a native Korean IME favours a platform-native engine**. If
  TWeb targets cross-platform, cmux's path is not directly applicable, but it does show the advantage of the
  WebKit/native route on the IME dimension.

### agent-browser (external Chrome + CDP, the source cmux ported)

- Vercel Labs' browser automation CLI. **Chrome for Testing + CDP**. "No Playwright or Node.js required for the
  daemon." A Rust CLI plus a Rust daemon, direct CDP.
- Extension support: `--extension <path>`. A plugin system (a stdio JSON protocol with
  credential.read/browser.provider/launch.mutate/command.run capabilities).
- **The engine decision**: external Chrome + CDP. Extensions and fidelity secured, at a frame pacing ceiling
  (screenshot-based).
- Reference value: a concrete instance of how the external Chrome path achieves extensions and agent
  automation. cmux porting it also supports the validity of the external Chrome direction.

### Engine decisions compared

| Project | Engine | Extensions | Input/IME | Agent integration | TWeb reference |
|---|---|---|---|---|---|
| Orca | **Electron** (embedded Chromium) | supported (real Chromium) | native (an embedded window) | CLI snapshot/click/fill, a shared browser | **the closest; achieved on Electron** |
| cmux | WebKit (macOS native) | Safari-extension level | native (macOS) | a scriptable API | ahead on the macOS IME, not cross-platform |
| agent-browser | external Chrome + CDP | `--extension` supported | CDP Input | a Rust daemon, direct CDP | a concrete external Chrome instance |
| awrit (archived) | Electron | the Electron subset | Electron input | none | a fast prototype, no GPU fast path |
| cliweb (an awrit fork) | Electron | the Electron subset | Electron input | cliwebctl | a fast prototype |
| casty | external Chrome + CDP | `--disable-extensions` (off) | CDP Input | raw CDP | SSH/headless, extensions given up |

**The key patterns**:
1. **Nobody used CEF** — a strong signal that CEF's extension/accelerated-compositing limits are a genuinely
   known constraint.
2. **Orca (the closest goal) used Electron** — securing extensions, fidelity and agents on embedded Chromium.
   Market-validated at 34k stars. It conflicts with DESIGN.md's "Electron is unsuitable as the core", though.
3. **external Chrome + CDP is proven by agent-browser/casty** — extension support is possible too.
4. **WebKit favours the macOS native IME** but is not cross-platform.

### How TWeb's reason to exist entangles with the engine choice

With Orca having already achieved the same functionality on Electron, TWeb's engine choice becomes bound up
with its **reason to exist**:

- **If TWeb uses Electron**: the same engine and the same functionality as Orca. TWeb's differentiation is
  **tmux pane-native** (Orca is a standalone app outside tmux) and **terminal graphics rendering** (Kitty/Ghostty
  integration) alone. No engine-level advantage over Orca.
- **If TWeb uses external Chrome + CDP**: a lighter runtime than Orca (sharing a Chrome process), at a frame
  pacing ceiling plus weak Korean IME.
- **If TWeb uses a custom Chromium shell**: a possible memory and performance advantage over Orca (Electron),
  at a very high maintenance cost. **That is the only route by which TWeb takes the benefits of embedded
  Chromium while avoiding Electron.**
- **If TWeb uses CEF**: no extensions → giving up DESIGN.md section 10. No precedent.

**For TWeb to differentiate from Orca — to become more than "Orca inside tmux" — the engine choice is the
crux**, and a custom Chromium shell is the only route that can give a substantive advantage over Orca. The
maintenance cost being very high, whether that advantage justifies the cost is the essential question of S1/S2.

## 10. Overall recommendations

1. **In S1, compare CEF OSR and external Chrome (new headless) across four dimensions (frame pacing, Korean
   IME, extensions, browser fidelity).** CEF in particular cannot effectively do extensions (#4011/#4187), so
   keeping DESIGN.md section 10 as a core product feature leaves external Chrome as effectively the only
   engine. CEF is a candidate only if section 10 is demoted to a non-goal. Keep a custom Chromium shell only as
   the last-resort hybrid for when none of the three works.
2. **First decide whether DESIGN.md section 10 (extensions/profile bootstrap) is a core product feature.** That
   is the prerequisite decision for the engine choice. Keeping it means external Chrome; making it a
   non-goal or working around it brings CEF back as a candidate.
3. **Make the Tier 1 damage-aware Kitty path the first validation target.** It is implementable on both CEF
   OSR's CPU bitmap plus dirty rect and external Chrome's screenshot, and Electron is unnecessary at this
   stage. This keeps DESIGN.md section 6.4's decision not to adopt Electron as the product core.
4. **Design Korean input in two stages.** Tier 1 is committed text; Tier 3 shows the intermediate composition
   state live over the side channel. Since Ghostty handles macOS IME composition natively, extending DESIGN.md
   section 7.2's side channel to input composition events is all it takes. Validate in S1, though, that
   external Chrome's CDP Input is not a native IME and its Korean composition path is weak.
5. **State that `NativeSurfaceTransport` does not solve the PTY input limits, while stating alongside it that
   the side channel extension is a separate input-path solution.** Keep the rendering fallback and the input
   solution distinct.
6. **Implement the Chrome Profile Bridge as a Rust Native Messaging host plus an extension.** It is consistent
   with the no-direct-profile-DB-access policy. State that the Profile Bridge extension is engine-agnostic,
   since it runs in the user's ordinary Chrome.
7. **Design the agent/human lease as an explicit state machine (`IDLE`/`HUMAN`/`AGENT`/`CONTENDED`).** It is
   consistent with the policy of not using last-write-wins on `CONTENDED`.
8. **Treat the remote transport as an extension area after validations 1–3, 4/5 and 8 pass.** Keep section 17's
   order.
9. **Treat the Chromium security update response system as a product survival condition.** awrit's reason for
   ceasing maintenance suggests as much. CEF and external Chrome carry a small burden thanks to
   prebuilt/distributed binaries; the burden is maximal only with a custom Chromium shell.
10. **Track and contribute to tmux PR #5274 (the grid-resident Kitty image) actively.** Once it merges, most of
    DESIGN.md section 7.4's baseline compatibility cost disappears and the enhanced tmux branch is promoted
    from an optional tier to a default path candidate. The late-attach limitation is covered by TWeb's
    reconcile (section 8).
11. **Measure browser fidelity (validation 8) on external Chrome (new headless).** CEF's lack of accelerated
    compositing is an OSR limitation, so where WebGL/hw video decode is needed the external Chrome path is the
    answer. Measure WebGL/canvas/WebRTC/audio as conformance items and never hide the constrained and
    unsupported ones from the user.
12. **Design audio routing per pane.** The browser process controls mute/volume/routing per pane, and where no
    system audio device exists, audio is omitted or routed to a separate sink.
13. **State new headless Chrome (Chrome 132+) as a premise of the external Chrome path.** The old headless
    shell has WebAPI shortfalls and is not used. Validate new headless's extension loading approach
    (`--load-extension`, profile persistence) in S1.

## References

- Electron offscreen rendering — https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering
- Electron SharedTexture — https://www.electronjs.org/docs/latest/api/shared-texture
- Kitty graphics protocol — https://sw.kovidgoyal.net/kitty/graphics-protocol/
- tmux manual — https://man.openbsd.org/tmux
- CEF General Usage (OSR) — https://chromiumembedded.github.io/cef/general_usage
- awrit — https://github.com/chase/awrit (archived 2026-04-25)
- cliweb — https://github.com/atomashevic/cliweb
- casty — https://github.com/sanohiro/casty
- cmux — https://github.com/manaflow-ai/cmux
- Ghostty — https://github.com/ghostty-org/ghostty
- Chrome Native Messaging — https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- Chrome DevTools Protocol — https://chromedevtools.github.io/devtools-protocol/
- Page.startScreencast — https://chromedevtools.github.io/devtools-protocol/tot/Page/
- iced-cef — https://github.com/bnema/iced-cef
- Ghostty Korean IME issue #11461 — https://github.com/ghostty-org/ghostty/issues/11461
- tmux PR #5274 (grid-resident Kitty image) — https://github.com/tmux/tmux/pull/5274
- tmux issue #4302 (passthrough control mode) — https://github.com/tmux/tmux/issues/4302
- Chrome headless (new headless, Chrome 132+) — https://developer.chrome.com/docs/chromium/headless
- Chromium media pipeline — https://www.chromium.org/developers/design-documents/video/
- CEF issue #4011 (extension tab API OSR not planned) — https://github.com/chromiumembedded/cef/issues/4011
- CEF PR #4187 (Extensions API abandoned) — https://github.com/chromiumembedded/cef/pull/4187
- Electron extensions support — https://www.electronjs.org/docs/latest/api/extensions
- Orca per-worktree browser — https://www.onorca.dev/docs/browser/overview
- Orca Design Mode — https://www.onorca.dev/docs/browser/design-mode
- agent-browser (Vercel Labs) — https://github.com/vercel-labs/agent-browser
