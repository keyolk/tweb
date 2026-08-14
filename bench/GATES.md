# DESIGN.md 6.5 / 7.7 gates — measured (2026-08-14, task-3)

One machine, one afternoon: M-series mac, Electron 43.2.0, a 1440x900 pane at
`deviceScaleFactor: 2` (a 2880x1800 frame, 5.18MB raw at the *rendered* size the
engine actually sends), adaptive 4-30fps unless stated. Every number below is
reproducible with `bench/gate-harness.py <scenario>`; the raw JSON each run
printed is quoted rather than paraphrased.

## How these were measured, and why not through a tmux pane

The only tmux client on this box is attached to a session none of the work panes
live in, so **every pane an agent can create here reports `terminalVisible=false`
permanently**, and no agent may move a client (session policy). A pane is
therefore stuck in one of the two states the gates need to compare.

`bench/gate-harness.py` spawns the engine exactly as
`crates/tweb-pane/src/lib.rs` does — same argv, same env, stdin as the control
channel — and then *is* the frontend, pushing `VIS` lines to drive the pane
between visible and hidden on demand. stdout is a pipe rather than a tty, so
graphics bytes are counted instead of drawn, which is the only place "0 frame
transfers" can be weighed as a number.

What that costs: nothing that touches the terminal is measured this way — the
patch overlay path never fires (no terminal to place onto), and terminal-side
texture bytes are out of reach. Those gates are marked accordingly below.

## The one defect found and fixed

**A static idle page produced ~1 whole frame every second, forever.**

```text
                          before fix        after fix
20s idle window           21 whole frames   1 whole frame
                          4515 stdout B     215 stdout B
120s idle window          126 frames        1 frame
                          (whole 4 -> 130)  (whole 1 -> 2)
disk written              ~5.2 MB/s         ~0
RSS over the 120s         402-471MB, noisy  368 -> 319MB, falling
```

Isolated in `bench/idle-paint.cjs` (settled static page, 8s windows, same
runtime):

```text
touch nothing                       0 paints
setFrameRate(the same value) 1/s    0 paints
startPainting() 1/s                 7 paints   (0.88/s)
```

`startPainting()` on a webContents that is *already* painting provokes a paint.
`enforceHiddenWindows` reconciles once a second and called it unconditionally.
Every other line in that reconciler reads before it writes; this one did not.

Fix: `paintingTransition(want, isPainting)` in `electron/surface-policy.cjs` —
the same shape as the `surfaceResizeNeeded` that sits beside it — plus the
read-before-write call in `updatePaintingState`. 5 new pure-policy tests.

## The gate tables

### DESIGN.md 6.5 — memory ownership and budgets

| gate | verdict | evidence |
|---|---|---|
| The browser runtime/Node/V8 are not duplicated in proportion to the pane count | **UNMET** | Two engines at once: pane B adds a complete 4-process stack, +447.8MB RSS, its own gpu process. Combined 874.3MB / 8 processes against one pane's 441.7MB / 4. This is the duplication DESIGN.md 5.1's daemon exists to remove and is explicitly out of this run's scope. |
| An idle pane frontend that has added no visible page owns no frame-sized buffer | **UNMEASURED** | The frontend is `tweb __pane`, which the harness replaces. Frames do not pass through it at all (5.2's own divergence note), so the claim is structural rather than measurable here. |
| A hidden page's GPU/SHM surface bytes converge to 0 | **MET** | Surface collapses 1440x900 -> 720x1. gpu-process phys_footprint 278 -> 49MB, IOSurface 18.0 -> 4.8MB, 0 frames and 0 stdout bytes over a 15s hidden window. Not literal zero: 4.8MB IOSurface and a 49MB gpu process remain, but `surface-policy.cjs` records a 91MB floor for *zero* windows, so what is left is below the empty-compositor baseline. |
| Queues and the resource cache have hard upper bounds | **MET (frame queue only)** | The frame queue is one-deep by construction and reports its overflow: `droppedByBackpressure` reached 21 over 3 minutes of animation while frame files on disk stayed at exactly 1. The resource cache is a different subsystem and was not measured. |
| After a page close ... resource counts and private bytes return to baseline | **MET** | 3 extra tabs: 4 -> 7 processes, 1 -> 4 renderers, 450.9 -> 754.3MB. After closing back to one: 4 processes, 1 renderer, 424.0MB — below the 450.9MB baseline. |
| After a renderer crash ... resource counts and private bytes return to baseline | **MET for bytes, UNMET for the page** | `SIGKILL` the renderer: 4 -> 3 processes, 0 renderers, IOSurface 18.0 -> 0.0MB, RSS 451.1 -> 356.3MB. Bytes return. But the page does **not** come back on its own — `eval` times out afterwards, and only an explicit `reload` restores it (verified: reload -> page answers, 4 processes, 1 renderer, IOSurface 11.0MB). There is no `render-process-gone` handler in `electron/main.cjs`. Reported, not fixed: it is a lifecycle defect rather than a resource-release one, and outside the scope this task was given. |
| After a client detach ... return to baseline | **MET** | This is the hidden transition, measured in the row above: a detached client is a pane with no visible tty. |

### DESIGN.md 7.7 — the performance release gate

| gate | verdict | evidence |
|---|---|---|
| 0 CPU full-frame copies of browser pixels on the GPU fast path | **N/A — path does not ship** | The Ghostty GPU fast path (7.2) is unimplemented. On the shipping path a full-frame copy is the design: `toBitmap` at ~1.4ms main-thread (DETAIL.md 8.3), measured here at p50 0.43ms / max 12.28ms. |
| 0 frame transfers while a static page is idle | **MET (was UNMET; fixed this run)** | 21 frames / 20s before, 1 frame / 20s after. 126 frames / 120s before, 1 after. That remaining 1 is the tail of the load settling, not a rate: over the 120s run `whole` had already reached 2 by the t=15s sample and was still 2 at t=124.7s, so the last ~110 seconds transferred exactly nothing. See the defect section. |
| 0 frame production in a hidden tmux window | **MET** | 15s hidden: `whole` delta 0, `patches` delta 0, 0 stdout bytes. |
| Queue depth never exceeding the configured surface ring size | **MET** | The queue is one-deep and overflow is counted rather than grown: `droppedByBackpressure` 0/1/21 across idle/scroll/animation runs, with 1 frame file on disk throughout. |
| Only the new generation displayed within 2 display frames after a resize | **UNMET (correct, but slower than the gate)** | Four resizes: 79.5 / 104.1 / 78.1 / 78.5ms to a frame at the new size = 4.7 / 6.2 / 4.7 / 4.7 display frames at 60Hz, against a gate of 2 (33ms). The *correctness* half holds exactly: 6 stale frames were refused with `frame dropped got=1440x900 want=1280x792`, so nothing from the old generation is ever displayed. It is a latency miss, not a tearing one. |
| Sustainable frame pacing at a 60Hz display during a 1080p continuous scroll | **MET** | At the shipping 30fps cap: 28.3 frames/s over 15s, 1 dropped. At `--frame-rate 60`: 55.5 frames/s over 15s, 0 dropped. Chromium's own producer delivers exactly 30.0 paints/s with p50 33ms gaps (`bench/scroll-pacing.cjs`), so the pipeline is carrying ~94% of what the compositor offers at 30 and ~92% at 60. |
| No unbounded memory growth with two visible browser panes | **MET for growth, see 6.5 for the floor** | Two panes over a 30s window: combined RSS 874.3 -> 744.7MB, i.e. -129.6MB. No growth. The *floor* is the problem (+447.8MB for the second pane), which is the 6.5 duplication row, not this one. |
| 0 stale images, surfaces or shared-memory objects after 10 minutes of animation/video | **MET at 3 minutes, extrapolated by construction** | Real rAF animation (a full-viewport canvas repainting every frame), 3 minutes, 5,380 whole frames: frame files on disk stayed at **1** throughout, `patchesPlaced` 0, image id constant at 16038. The paths are fixed by construction — one `.rgba` path and one `.png` path per process, a bounded 8-id patch pool — so the count cannot grow with time. 10 minutes was not run; 3 was, at a rate of 28 frames/s. |
| Surface handles reclaimed even when the producer, a tmux client or Ghostty crashes | **PARTIAL** | tmux-client crash = the hidden transition, measured: surfaces released. Producer crash measured as the renderer kill: IOSurface 18.0 -> 0.0MB. A Ghostty crash is unmeasurable through a pipe — there is no terminal in this harness to crash. |

### The measurement items DESIGN.md 7.7 lists but this run could not reach

`input -> Chromium event dispatch`, `frame available -> Ghostty present`,
`input -> visible response end to end`, and `terminal command bytes per frame`
all need a terminal on the other end of stdout. The harness has a pipe, by
necessity (see the first section). `GPU/CPU copy bytes per frame` is known from
DETAIL.md 8.3 rather than re-measured. `frame drop/coalesce count` is the
`droppedByBackpressure` column above.

## What is inconclusive and was deliberately not acted on

**RSS across repeated collapse/restore cycles.** Before the fix, five cycles
read 438 -> 455 -> 470 -> 487 -> 510MB, which looks like a leak. Two things
argue against reading it that way: the 120s idle series over the same build
oscillated 402 <-> 471MB with no trend, and the 3-minute animation run swung
673 <-> 2153MB in both directions. Chromium's allocator returns memory on its own
schedule, and a 5-sample rising run inside that much noise is not evidence.
After the fix the same five cycles read 465 -> 500 -> 522 -> 522 -> 462MB — still
noisy, no longer monotone. Reported as inconclusive; nothing was changed for it.

**`imageTransferred` is never reset after a stale-generation `d=I`.**
`handleGfxWorkerReady` frees the base image's *data* when the finished frame
belongs to an old generation, but `imageTransferred` (set true in two places,
never false) still claims the terminal holds it — so `replacePlacement`/`sendPatch`
can in principle place over freed data.

The branch itself reproduces: a 20-40 resize storm on a photo page with
`TWEB_FRAME_TRANSPORT=direct TWEB_RAW_FRAMES=0` yields 1-2 stale deletes per run.
The visible consequence does not. Across every run there were **0 patches** over a
freed base, and the single `a=p` observed was immediately followed by `a=T i=1`,
so the terminal had the data back before anything could draw wrong. Real in the
code, empirically self-closing. Left alone under the "fix only what has a runnable
repro" bar, and recorded here so it is not rediscovered as new.

## Traps that cost this run time, so they do not cost the next one

- **`bench/pages/mixed.html` bottoms out at scrollY 2137 in about a second.** A
  scroll test against it reads ~2 frames/s and looks like a catastrophic pacing
  failure. It is a short page. Force `document.body.style.minHeight='400000px'`
  first — with it, the same test reads 28.3 frames/s.
- **A blocking `read(n)` on the engine's stdout reports zero bytes** for a slow
  trickle of graphics commands, because it waits for all n. Use `os.read`.
- **`footprint(1)` prints `Footprint: 1760 KB` in its header**, not the
  `phys_footprint:` key `vmmap` uses. A parser written against the latter finds
  nothing and silently reports null.
- **The agent `eval` method takes `script`, not `expression`.** A wrong key
  returns `{}` rather than an error, which reads as "the page has no scrollY".

## Files changed

```text
electron/surface-policy.cjs        + paintingTransition
electron/surface-policy.test.cjs   + 5 tests
electron/main.cjs                  read-before-write in updatePaintingState,
                                   + readIsPainting
bench/gate-harness.py              new — the 9 scenarios above
bench/idle-paint.cjs               new — the startPainting isolation
bench/scroll-pacing.cjs            new — Chromium's own paint rate under scroll
```

The gate numbers above were measured against this fix alone. They shipped
alongside five other defect fixes in the same commit, and `make check` on that
combination reads rc=0 with 214 Electron tests and the full Rust workspace.
