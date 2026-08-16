# TWeb pre-development plan

> **A dated planning document, superseded by what was actually built.** Research date 2026-07-31;
> sixteen PRs of runtime have landed since and the plan diverged. For what runs today — and what is
> broken, missing or deliberately not attempted — see [README.md's Status
> section](README.md#status). Kept as a record of the reasoning that set the critical path.

Building on `DESIGN.md` and `FEASIBILITY.md`, this document lays out the **Spikes** (research that
removes uncertainty), **Prototypes** (minimal component validation) and **Architecture decisions**
(settling the design) that have to happen before development actually starts. Items are ordered by
dependency, and the critical path is called out.

Research date: 2026-07-31.

## The dependency graph and the critical path

```text
S0 — Engine = Electron settled (a user decision)
    rationale: extensions, IME, fidelity, frame pacing and distribution all favour it (proven by Orca's 34k stars)
    differentiation: tmux pane-native + a lightweight Electron (memory mitigation)
    reverses DESIGN.md's "Electron is unsuitable as the core"

Spike S1 — Electron memory mitigation + tmux integration validation (critical path)
    │
    ├─→ Prototype P1 — the damage-aware Kitty path (Electron webContents paint → Kitty graphics)
    │       └─→ validation 1 (renderer viability)
    │
    ├─→ Prototype P2 — browser fidelity conformance (WebGL/audio/WebRTC)
    │       └─→ validation 8 (browser fidelity)
    │
    ├─→ Prototype P3 — Korean IME native composition (BrowserWindow NSTextInputClient)
    │       └─→ validation 3 (input fidelity)
    │
    └─→ Prototype P6 — extension loading (session.loadExtension) + cookie transfer
            └─→ validations 4/5 (profile compatibility/security)

(A1 judges from the S1/P1/P2/P3/P6 results whether the memory mitigation succeeded. On failure, S2 → the long-term custom shell move)

Spike S2 — Chromium build/maintenance cost (conditional on the long-term move; only if Electron's memory is untenable)
    └─→ A1 (justifying the custom shell cost)

Spike S3 — Whether Ghostty can export IME events (complements P3; unnecessary if Electron's native IME suffices)
    └─→ P3 (if needed)

Spike S4 — The merge outlook and API of tmux PR #5274
    └─→ Prototype P4 — grid-resident image integration (or the passthrough fallback)
            └─→ validation 2 (tmux semantics)

Spike S5 — agent/human shared control (the Electron in-process API + CDP)
    └─→ Prototype P5 — the agent/human lease state machine
            └─→ validation 6 (agent control)

Independent: Prototype P7 — the twebd core (IPC, PageRegistry, ProfileManager)
Independent: Prototype P8 — ResourceBroker + AgentBridge
```

**Critical path**: S0 (Electron settled) → S1 (memory mitigation + tmux integration validation) →
P1 + P2 + P3 + P6 → A1. S1 is not about comparing engines; the point is proving how light Electron can
be made. If the memory is untenable, S2 → the long-term move to a custom Chromium shell. S3 is
unnecessary if Electron's native IME suffices.

## Phase 0 — Spikes (research that removes uncertainty, 2–4 weeks estimated)

Each Spike writes almost no code and answers "does this path hold up?" from external documents, sources
and experiments. The result is a go/no-go decision.

### S0 — The prerequisite decision (settled by user input)

**Engine = Electron, settled.** The user's decision: the goal is to "start with Electron and implement
the full in-tmux browser experience as lightly as possible."

Rationale:
1. **Extensions cannot be given up** (the user depends on vimium, 1Password, developer extensions and
   personalization tools) → CEF is definitively out.
2. **Electron leads on extensions, Korean IME, browser fidelity, frame pacing and distribution alike**
   (proven by Orca's 34k stars). External Chrome caps frame pacing and is weak on Korean IME. A custom
   shell carries a very large maintenance cost.
3. **The same engine as Orca, but the differentiation is "tmux pane-native + a lightweight Electron"**.
   Orca is a standalone app; TWeb lives inside tmux. Proving it is lighter than Orca through memory
   mitigation is the point.

**Reversing DESIGN.md's "Electron is unsuitable as the core"**: the grounds are (a) Orca achieved the
same functionality on Electron, (b) the user cannot give up extensions or IME, and (c) "lightweight" is
pursued as a memory mitigation strategy. The Node/V8 duplication burden is handled by the mitigation
strategy (S1/P1).

**Result**: engine = Electron. S1 narrows from comparing engines to **validating Electron memory
mitigation plus tmux integration**. A custom Chromium shell is deferred as the long-term
differentiation path (after Phase 2).

### S1 — Electron memory mitigation + tmux integration validation (critical path)

**Question**: how light can Electron be made while serving as a full browser inside a tmux pane? Can a
memory advantage over Orca (standalone Electron) be demonstrated?

**Research/validation items**:
- **BrowserWindow reuse**: save memory with one main process plus page separation rather than a new
  BrowserWindow per pane. Compare against Orca creating a BrowserWindow per worktree.
- **Node.js in the main process only**: turn Node integration off in renderer processes
  (`nodeIntegration: false`). Pages are pure Chromium renderers. Minimize V8 duplication.
- **GPU fast path**: avoid the CPU `toBitmap()` via `offscreen.useSharedTexture: true` (experimental).
  Assess SharedTexture stability and the risk of colliding with Chromium security updates.
- **damage-aware Kitty path**: send the dirty rect from `webContents.on('paint')` as Kitty graphics
  `a=t` + `a=p,U=1`. Target zero full-frame copies.
- **tmux pane frontend**: `tweb __pane` receives Electron's frames and displays them as Kitty graphics.
  The PTY owns pane identity/placement/visibility; Electron owns the browser content.
- **Korean IME**: the BrowserWindow does native composition via macOS `NSTextInputClient`. Confirm
  whether live composition display is possible without the Tier 3 side channel.
- **extension loading**: install vimium, 1Password and React DevTools via `session.loadExtension()`.
  The limits of Web Store installs and the user UX of unpacked loading.
- **memory measurement**: RSS, private dirty and PSS at 1/2/4 panes, against Orca. Judged against
  DESIGN.md section 6.5's budget classes.

**Deliverable**: an "Electron memory mitigation model" — quantifying the memory and frame-pacing
advantage over Orca from BrowserWindow reuse, Node integration off, the GPU fast path and the
damage-aware Kitty path. Passing means releasing on Electron; if the memory proves untenable, examine
the long-term move to a custom Chromium shell.

**Depends on**: S0 (Electron settled).
**Blocks**: P1, P2, P3, P6. A1 judges from the results whether the memory mitigation succeeded.

### S2 — Making the Chromium build/maintenance cost concrete (the long-term differentiation path, conditional)

**Question**: what does maintenance cost on a long-term move to a custom Chromium shell? (Entered only
if Electron's memory mitigation proves untenable and the custom shell move becomes necessary.)

**Research findings (partial)**:
- Chromium build: 16GB RAM recommended, 100GB disk, a full build in ~15–30 minutes (a high-end
  16-core). GN/Ninja. `symbol_level=1` and `is_component_build=true` speed up dev builds.
- Maintaining a fork: track upstream via `git rebase-update` + `gclient sync`. There is no official
  guide for long-lived forks → in practice a rebase is needed on every Chromium stable (roughly a
  4-week cycle).
- CEF avoids this cost with prebuilt binaries. A custom Chromium shell takes the cost on directly.

**Additional research items**:
- The frequency and patch size of Chromium stable channel security updates (monthly average).
- How much the patch surface shrinks when a custom shell uses only the `content/public/browser` API.
- The stability of the Rust→C++ FFI boundary (the `cxx` crate or a hand-written C ABI).

**Deliverable**: a "custom Chromium shell maintenance cost model" — people, time, rebase cadence and the
security update response procedure. Contrasted against awrit's archival reason ("rising security
issues").

**Depends on**: entered if S1 selects a custom Chromium shell as the differentiation path over Orca.
**Blocks**: A1 (the cost justification if a custom shell is chosen).

### S3 — Whether Ghostty can export IME events

**Question**: can Ghostty forward the IME composition events it receives via macOS `NSTextInputClient`
to an external process? (Whether the side channel's input path holds up at all.)

**Research findings (partial)**:
- Ghostty has `main_c.zig` and can be embedded as a C library (libghostty). IME handling lives in the
  `input/` and `os/` modules. There is no plugin/extension mechanism.
- Korean IME issues (#11461 and others) deal with preedit/commit/marked text → IME composition is known
  internally. Whether an API exposes it externally is unconfirmed.

**Additional research items**:
- Read the source to see where composition events are routed inside Ghostty's `input/` module.
- Whether the libghostty C API has an IME event callback or hook.
- If not, the size of a patch on a Ghostty fork that exports composition events over local IPC.
- The prospect of contributing upstream (adding an IME event export API).

**Deliverable**: the "Ghostty IME event export path" — a native callback, a fork patch, or impossible.
If impossible, revisit the alternatives for the Tier 3 input path.

**Depends on**: parallel with S1. P3 depends on both S1 (the engine's IME injection path) and S3
(Ghostty IME export).
**Blocks**: P3.

### S4 — The merge outlook and API of tmux PR #5274

**Question**: when, and in what API shape, does tmux's grid-resident Kitty image (PR #5274) get merged?

**Research findings (partial)**:
- PR #5274 (open, 2026-06-25, the `ta/kitty-img` branch). A grid-resident `U+10EEEE` placeholder. tmux
  handles clip/scroll/resize/split/kill itself. A late-attach limitation (per-client transmit).
- nicm: "will probably happen"; mgrant0: "on my radar due next few weeks"; the `4902-image-support`
  branch generalizes kitty+sixel.

**Additional research items**:
- Check the PR review progress periodically (to estimate the merge point).
- Build the `ta/kitty-img` branch directly and test compatibility with TWeb's Kitty transfer.
- Design the API for how TWeb compensates for late-attach per-client transmit tracking.
- The criteria for how long the passthrough fallback is kept.

**Deliverable**: a "tmux image path strategy" — #5274-based by default / a passthrough fallback /
supporting both. An estimated merge point and TWeb's supported-version policy.

**Depends on**: nothing. Parallel with S1.
**Blocks**: P4.

### S5 — CDP multi-client + human input interleaving

**Question**: can a CDP client (an agent) and human input coexist on the same page without races?

**Research findings (partial)**:
- CDP multi-client is supported in Chrome 63+. The forced DevTools frontend detach only applies when a
  human opens Chromium DevTools directly → not applicable in TWeb's scenario.
- cliweb already demonstrates human/agent shared control.

**Additional research items**:
- The ordering when CDP `Input.dispatchKeyEvent` and human terminal input arrive simultaneously.
- How to pause/resume the agent command queue once a human starts typing.
- Mapping the lease state machine's (`IDLE`/`HUMAN`/`AGENT`/`CONTENDED`) transition triggers onto CDP
  events.

**Deliverable**: an "agent/human interleaving contract" — the lease transition conditions and the CDP
command queueing rules.

**Depends on**: nothing.
**Blocks**: P5.

### S6 — The Chrome Profile Bridge extension permission flow + embedded browser extension support

**Question**: does per-origin one-shot cookie transfer work exactly as intended within the extension
permission model? And how does reinstalling the user's extensions (1Password, uBlock and the like)
inside the embedded browser behave per engine?

**Research findings (partial)**:
- The Profile Bridge extension: the `cookies` permission plus a per-origin host permission. A
  `runtime.connectNative()` persistent port. A Native Messaging host (Rust) over stdin/stdout JSON.
  This extension runs in the user's ordinary Chrome, so it is **engine-agnostic**.
- Extensions inside the embedded browser: effectively impossible on CEF (#4011 OSR not planned, #4187
  abandoned). External Chrome (new headless) is real Chrome so it works, but the
  `--load-extension`/profile-persistence approach needs validating in S1.

**Additional research items**:
- The UX flow of requesting per-origin permissions at runtime via `optional_permissions`.
- Whether `cookies.set()` supports preserving `HttpOnly`/`Secure`/partitioned cookies.
- Safeguards ensuring cookie values are not exposed in logs when the extension reads them and sends
  them to the Native Messaging host.
- Whether `--load-extension`, `--disable-extensions-except` and profile-based extension persistence
  work in external Chrome's new headless (in cooperation with S1).
- A final confirmation that CEF truly cannot do extensions at all (the possibility of loading unpacked
  extensions outside the Web Store).

**Deliverable**: a "Profile Bridge permission flow specification" plus an "embedded browser extension
support matrix" (per engine).

**Depends on**: S1 (in cooperation with the engine extension support dimension).
**Blocks**: P6.

## Phase 1 — Prototypes (minimal component validation, 4–8 weeks estimated)

Each Prototype is throwaway or minimal-feature code whose goal is passing one validation. Not
production code quality — proof that "this path works".

### P1 — The damage-aware Kitty path (critical path, Electron)

**Goal**: pass validation 1 (renderer viability). Write the dirty rect from Electron's
`webContents.on('paint')` into a persistent shared-memory ring, map it to adaptive tiles, and transfer
Kitty graphics.

**Steps**:
1. Obtain the dirty rect plus the bitmap from Electron's
   `webContents.on('paint', (event, dirty, image) => ...)`.
2. Preallocate a persistent POSIX shared-memory ring (never shm_open per paint).
3. Map the dirty rect onto a 256×256 adaptive tile grid and transfer only the changed tiles as Kitty
   `a=t` + `a=p,U=1`.
4. Measure 0 frame transfers while a static page is idle.
5. Measure 60Hz frame pacing during a 1080p continuous scroll.
6. Measure 0 stale image/shm objects after 10 minutes of animation.
7. After a resize, only the new generation is displayed within 2 display frames.
8. (Optional) Validate the GPU fast path via `offscreen.useSharedTexture: true` — 0 CPU copies.

**Depends on**: S1 (Electron memory mitigation validation).
**Success criteria**: meets the main-path items of DESIGN.md section 7.7's release gate. The memory
advantage over Orca is quantified.

### P2 — Browser fidelity conformance (critical path, can run parallel to P1)

**Goal**: pass validation 8 (browser fidelity). Measure whether Electron supports
WebGL/canvas/WebRTC/audio at the level of a shipping browser. (Electron being real Chromium, most of it
is expected to pass by default.)

**Steps**:
1. Run the `webgl.org` conformance suite.
2. Confirm H.264/AV1/VP9 video playback and hardware vs software decode.
3. Test WebRTC camera/mic access (`getUserMedia`).
4. Audio playback — validate the design of per-pane mute/volume routing.
5. Canvas 2D / 3D CSS transforms / WebGPU (in future) support.
6. Record every shortfall against shipping Chrome, per conformance item.

**Depends on**: A1. Can be done on the same engine as P1.
**Success criteria**: FEASIBILITY.md section 8.5's conformance items are classified as "identical
behaviour / constrained / unsupported", and the constrained and unsupported ones can be stated to the
user.

### P3 — Korean IME native composition (Electron, local and remote measured separately)

**Goal**: pass validation 3 (input fidelity). The Electron BrowserWindow receives native composition via
macOS `NSTextInputClient` and shows it live in the browser input field. **Measure local and remote
separately.**

**Steps (the local case)**:
1. Confirm the Electron BrowserWindow (`nodeIntegration: false`) receives macOS IME composition natively.
2. Confirm that typing `안녕` on a Korean 2-set IME shows the composition steps
   (`ㅇ`→`아`→`안`→`안ㄴ`→`안녕`) live in the browser input field.
3. Confirm commit-then-act behaviour on arrow keys/delete (same as the Ghostty #11461 fix).
4. The Tier 3 side channel (Ghostty IME export) is unnecessary if Electron's native IME suffices. Should
   the `tweb __pane` frontend need to intercept IME events, though, validate S3.

**Steps (the remote case, a separate phase)**:
1. The problem of synchronizing local and remote IME state when the Electron browser process runs
   remotely.
2. Tier 1: send only committed text to the remote (after the local IME composition finishes) — little
   affected by network latency.
3. Tier 3: inject local composition events into the remote Electron over the side channel — network
   latency may make live composition display hard. Needs measuring.
4. The remote case is handled as a separate phase once the local case holds (FEASIBILITY.md section 7.2).

**Depends on**: S1 (Electron), S3 (Ghostty IME export, only if needed).
**Success criteria**: in the local case, intermediate Korean composition state shows live in the browser
field. The remote case is judged on the measured latency of the committed-text fallback or side-channel
injection.

### P4 — Grid-resident image integration (or the passthrough fallback)

**Goal**: pass validation 2 (tmux semantics). Browser images behave pane-aware via tmux's grid-resident
Kitty image (#5274) or the passthrough path.

**Steps**:
1. Build the `ta/kitty-img` branch (or stock tmux after the merge).
2. Whether TWeb's damage-aware Kitty transfer (`a=t` + `a=p,U=1`) is compatible with the grid-resident
   placeholder.
3. Confirm the image lifecycle on pane split/resize/kill/scroll-off (no ghosts, nothing stale).
4. Whether TWeb's reconcile compensates with a redraw when a late-attaching client cannot see existing
   images.
5. Whether the passthrough fallback provides the same functionality (the pre-merge baseline).

**Depends on**: S4, P1 (reusing P1's Kitty transfer code).
**Success criteria**: pane-aware clip/scroll/resize/kill is handled by tmux without TWeb's involvement.
TWeb compensates for the late-attach limitation only.

### P5 — The agent/human lease state machine

**Goal**: pass validation 6 (agent control). The `IDLE`/`HUMAN`/`AGENT`/`CONTENDED` state machine plus
CDP command queueing.

**Steps**:
1. Attach an agent over CDP multi-client.
2. Detect human input starting → transition the lease from `AGENT` to `HUMAN` and suspend the agent
   command queue.
3. Human input ends → the agent takes a new snapshot and returns to `AGENT`.
4. On `CONTENDED`, an explicit coordination UI for the user (never arbitrary last-write-wins).
5. Enforce, by capability, that the agent cannot bypass the confirmation right before an external
   submit/purchase/message send/upload/delete.

**Depends on**: S5.
**Success criteria**: a human and an agent share one page without races. The user coordinates on
`CONTENDED`.

### P6 — Extension loading + per-origin cookie transfer (Electron)

**Goal**: pass validations 4/5 (profile compatibility/security). Install the user's extensions (vimium,
1Password, React DevTools) via Electron's `session.loadExtension()`, plus cookie transfer via the Chrome
Profile Bridge extension.

**Steps (extension loading)**:
1. Install unpacked extensions via Electron's `session.loadExtension()` (vimium, React DevTools).
2. Confirm the Native Messaging host connection for native messaging extensions such as 1Password.
3. Assess the limits of Web Store installs and the user UX of unpacked loading.
4. Confirm the extensions work correctly inside a TWeb browser pane.

**Steps (cookie transfer)**:
1. The Chrome Profile Bridge extension manifest (`nativeMessaging` plus the `cookies` optional
   permission), running in the user's ordinary Chrome.
2. A Rust Native Messaging host (stdin/stdout JSON, a 32-bit length prefix).
3. The user picks an origin → a runtime permission request → cookie transfer (one-shot) → injection into
   the TWeb profile via Electron's `session.cookies.set()`.
4. Preserve `HttpOnly`/`Secure`/partitioned cookies.
5. Record only the domain, the count, the source/target and the time in the audit (values unlogged).
6. Enforce the sensitive-domain denylist (`*.okta.com` and the like) in code, not overridable by user
   configuration.

**Depends on**: S1 (Electron), S6.
**Success criteria**: vimium/1Password/React DevTools work in a TWeb pane, and origin-scoped one-shot
cookie transfer respects the policy boundary with no values exposed in logs.

### P7 — The twebd core (independent, can run in parallel)

**Goal**: validate the daemon-based structure. One Electron main process manages several
BrowserWindows/pages, and the `twebd` Rust daemon maps tmux pane identities to pages. No Electron
runtime duplicated per pane.

**Steps**:
1. The `twebd` Rust daemon — an authenticated Unix socket with a peer credential check.
2. A minimal `PageRegistry` and `ProfileManager`.
3. Collect the tmux pane identity (`$TMUX`/`$TMUX_PANE`) and map it to a page.
4. IPC between the Electron main process and `twebd` — pane create/close/navigation requests.
5. The `tweb __pane` frontend attaches to `twebd`.
6. Browser process crash recovery — restoring the profile plus the URL/history.

**Depends on**: nothing. Parallel with P1.
**Success criteria**: the browser runtime/Node/V8 are not duplicated in proportion to the pane count.

### P8 — ResourceBroker + AgentBridge (independent, can run in parallel)

**Goal**: the resource exchange part of validation 6. Resources created in the browser are handed to
agents in the same tmux window as typed attachments.

**Steps**:
1. `ResourceBroker` — an immutable resource store with scope (window/session), TTL and quota.
2. A `ResourceDescriptor` metadata index (opaque IDs, no values).
3. `AgentBridge` — ClaudeCodeBridge / GenericTerminalAgentBridge.
4. Validate `tweb screenshot --pane %3 --send-to %1`.
5. Deliver large payloads as object-store references rather than putting them in tmux options,
   environment variables or escape sequences.

**Depends on**: nothing. Cooperates with P5 but can be implemented independently.
**Success criteria**: browser → agent attachments work as `tweb://resource/<id>` references.

## Phase 2 — Architecture decisions (settling the design, from the Phase 1 results)

### A1 — Settling the engine (critical path, from the S0 + S1 + S2 + P1/P2/P3/P6 results)

**Decision**: settle on one of external Chrome (new headless) / a custom Chromium shell / Electron as
the product engine. (CEF was definitively eliminated in S0.) Keep the `BrowserEngineAdapter` boundary
but fix the default adapter to one.

**Criteria**:
- The intersection of validations 1 (frame pacing), 3 (Korean IME) and 8 (browser fidelity). All three
  candidates support extensions.
- **Whether TWeb differentiates from Orca** (Electron, 34k stars, the same functionality) — using
  Electron leaves the differentiation as tmux pane-native plus terminal graphics rendering alone, with
  no engine advantage. Differentiating means a custom shell or external Chrome.
- Maintenance cost at a survivable level (awrit's archival lesson). External Chrome and Electron are
  cheap thanks to distributed binaries; a custom shell is the most expensive.
- The memory goal (no runtime duplicated per pane). External Chrome and a custom shell both satisfy it,
  sharing one browser process and separating only pages. Electron can partly satisfy it through
  BrowserWindow reuse but fundamentally carries the Node/V8 duplication burden.

**Possible outcomes**:
- **Accept Electron**: the Orca path. The fastest route to market, but with no engine advantage over
  Orca plus a memory compromise. DESIGN.md's "Electron is unsuitable as the core" may need revisiting.
- **External Chrome (new headless)**: browser fidelity plus extensions, weak on frame pacing, Korean IME
  and distribution. A lighter runtime than Orca.
- **A custom Chromium shell**: a memory and performance advantage over Orca plus extensions, fidelity,
  IME and the GPU fast path. The maintenance cost is very large, though (S2). TWeb's differentiation
  path. **The only route that avoids Electron while taking the benefits of embedded Chromium.**
- **A hybrid**: external Chrome by default plus a custom shell for the GPU fast path. Very complex.

### A2 — Settling the tier strategy (from the P1+P3+P4 results)

**Decision**: settle the support scope and fallback policy of Tier 1 (vanilla) and Tier 3 (enhanced).

**Criteria**:
- Can Tier 1 carry frame pacing, committed text and browser fidelity (with the constraints stated)?
- How much does Tier 3 (enhanced Ghostty + tmux #5274) need live composition display and the GPU fast
  path?
- Reflect the importance of Korean input (which the user stressed) in the Tier 3 priority.

### A3 — Settling the tmux support policy (from the P4 + S4 results)

**Decision**: the support policy before and after PR #5274 merges.

**Criteria**:
- Before the merge: the passthrough fallback as the baseline, with the #5274 branch as an integration
  test target.
- After the merge: promote grid-resident to the default path, with passthrough as the fallback for older
  versions.
- Settle the API for how TWeb compensates for late-attach per-client tracking.

### A4 — Settling the input model (from the P3 results)

**Decision**: settle the two stages of Korean input (Tier 1 committed / Tier 3 composition) as product
policy.

**Criteria**:
- If the Tier 3 side channel holds up, make live composition display a supported feature.
- State the Tier 1 committed text path as the fallback.
- Document that `NativeSurfaceTransport` does not solve the input limitations.

## Phase 3 — Getting ready to start (after A1–A4)

Once A1–A4 are settled, have the following in place and start development:

1. **CI foundation**: platform-neutral Rust unit/property/fuzz tests, per-OS IPC/handle/path integration
   tests, and e2e tests per terminal/tmux combination (DESIGN.md section 6.6).
2. **Build system**: a build pipeline for the Rust core plus the C++/Obj-C++ platform shim plus Zig
   (optional) plus TypeScript (the extension).
3. **A Chromium security update procedure**: tracking the update cadence per engine, the rebase/patch
   procedure, and an emergency update path (DESIGN.md goal 11, FEASIBILITY.md recommendation 8).
4. **A conformance test harness**: conformance suites for browser fidelity (validation 8), input
   fidelity (validation 3) and tmux semantics (validation 2).
5. **A performance measurement foundation**: automating FEASIBILITY.md section 1.4's Phase A measurement
   items.

## Priority summary

| Priority | Item | Why |
|---|---|---|
| 0 (prerequisite) | S0: whether section 10 is core + whether to differentiate from Orca | Prerequisite to settling the engine candidates. Keeping section 10 → CEF is out. Differentiating from Orca → promote a custom shell; otherwise accepting Electron is pragmatic. |
| 1 (critical) | S1 → P1 + P2 + P3 + P6 → A1 | Compares the four engines (CEF, external Chrome, a custom shell, Electron) in parallel across four dimensions. |
| 1b (conditional) | S2 → A1 | Entered if S1 selects a custom shell. Judges the maintenance cost. |
| 2 (high) | S3 → P3 | The importance of Korean input (stressed by the user). Whether the Tier 3 side channel holds up. Entangled with S1. |
| 3 (high) | S4 → P4 | A tmux #5274 merge removes the baseline cost. Worth tracking and contributing to. |
| 4 (medium) | S5 → P5 | agent/human interleaving. Low risk, being an area cliweb already proved. |
| 5 (medium) | S6 → P6 | The profile bridge plus embedded extensions. Entangled with S1. |
| 6 (parallel) | P7, P8 | The twebd core and ResourceBroker. Independently implementable; parallelize if the schedule allows. |

## Risks and responses

| Risk | Response |
|---|---|
| Keeping section 10 in S0 eliminates CEF, since it cannot do extensions | External Chrome or a custom shell become the candidates, giving up CEF's advantage in frame pacing, Korean IME and distribution. Alternatively decide to bring CEF back as a candidate by making section 10 a non-goal or working around it. |
| Giving up Orca differentiation in S0 makes accepting Electron pragmatic | TWeb's differentiation shrinks to tmux pane-native plus terminal graphics rendering alone. No engine advantage plus a memory compromise. DESIGN.md's "Electron is unsuitable as the core" needs revisiting. A fast-to-market vs long-term differentiation trade-off. |
| S1 finds external Chrome's weak frame pacing/Korean IME untenable | Move to a custom Chromium shell (judging the cost in S2). Or accept Electron (the Orca path). |
| S2 finds the custom Chromium shell maintenance cost unaffordable | Accept external Chrome's frame pacing cap, or accept Electron (the Orca path, with a memory compromise). Drop the custom shell. |
| S3 finds Ghostty IME event export impossible | Drop the Tier 3 input path and limit Korean input to Tier 1 committed text. State live composition display as a non-goal. |
| #5274 does not merge for a long time in S4 | Keep the passthrough fallback and accept the reconcile responsibility in TWeb. If the fork cost is acceptable, a TWeb-enhanced tmux branch. |
| External Chrome new headless extension loading does not work as expected | Validate `--load-extension`/profile persistence in S1/S6. If it does not work, secure extensions via a custom Chromium shell or Electron. |
| Chromium security updates squeeze engine maintenance | awrit's archival lesson. CEF/external Chrome/Electron carry a small burden thanks to prebuilt/distributed binaries; only a custom shell carries the maximum. Staff the security update response as a product survival condition. |

## References

- Chromium build instructions — https://chromium.googlesource.com/chromium/src/+/main/docs/linux/build_instructions.md
- CEF automated builds (prebuilt) — https://cef-builds.spotifycdn.com/index.html
- CEF tutorial — https://chromiumembedded.github.io/cef/tutorial/
- Ghostty source structure — https://github.com/ghostty-org/ghostty/tree/main/src
- tmux PR #5274 — https://github.com/tmux/tmux/pull/5274
- CEF issue #4011 (extension tab API OSR not planned) — https://github.com/chromiumembedded/cef/issues/4011
- CEF PR #4187 (Extensions API abandoned) — https://github.com/chromiumembedded/cef/pull/4187
- Electron extensions support — https://www.electronjs.org/docs/latest/api/extensions
- Orca per-worktree browser — https://www.onorca.dev/docs/browser/overview
- Orca Design Mode — https://www.onorca.dev/docs/browser/design-mode
- agent-browser (Vercel Labs) — https://github.com/vercel-labs/agent-browser
- FEASIBILITY.md — this repository
- DESIGN.md — this repository
