# Frame pipeline benchmarks

The measurements behind [DETAIL.md](../DETAIL.md) section 8.1. Each script drives a real offscreen
`BrowserWindow` over a fixture page in `pages/` and reports the cost of one step of the frame
pipeline.

Run them against the Electron runtime TWeb already caches:

```sh
E=~/.cache/tweb/electron-<version>/dist/Electron.app/Contents/MacOS/Electron
BP=mixed $E bench/encode.cjs
```

`BP` picks the page profile (`text`, `mixed`, `photo`); `BW`/`BH`/`BD` override the pane size and
device scale factor. Set `NOGPU=1` to add `disable-gpu-compositing` — leave it unset to match the
shipping configuration, which does not set that switch.

| script | what it answers |
|---|---|
| `encode.cjs` | What a whole-frame encode costs, against a cropped one and against a raw tile |
| `whole-frame.cjs` | What the main thread pays per whole frame, PNG against raw pixels |
| `damage.cjs` | How large the `paint` dirty rect actually is while typing, scrolling and hovering |
| `worker-encode.cjs` | Whether moving the PNG encode to a worker thread helps (it does not) |
| `gfxprobe.py` | Whether the terminal really reads a `t=s` shm transfer, and whether a patch image can be placed over a base and deleted independently |
| `stacking.py` | Whether a patch placed after a base actually draws *on top* of it (judged by eye — the protocol only reports lifetime) |
| `shm-through-tmux.py` | Whether `t=s` survives tmux passthrough, with a temp-file transfer as the control |
| `raw-render.py` | Whether `f=32` raw pixels render correctly over the file medium (judged by eye) |
| `convert-bench.cjs` | How the gfx worker's per-frame time splits between the BGRA→RGBA swap and the 20MB write |
| `convert-bench.rs` | What that swap costs in Rust, against a bare memcpy of the same bytes |
| `gate-harness.py` | Whether the DESIGN.md 6.5/7.7 release gates hold, per pane state — see [GATES.md](GATES.md) |
| `idle-paint.cjs` | Whether `startPainting()`/`setFrameRate()` provoke a paint on a page that is not changing |
| `scroll-pacing.cjs` | How many frames Chromium's own offscreen producer delivers under a continuous scroll |

`gfxprobe.py` is the odd one out: it talks to a terminal, not to Electron, and **must run on a bare
tty**. Graphics responses do not come back through tmux DCS passthrough — which is why the shipping
code sends everything `q=2` — so inside tmux every probe reads as a timeout. Give it its own window:

```sh
open -na /Applications/Ghostty.app --args \
  -e /bin/sh -c "python3 bench/gfxprobe.py /tmp/gfxprobe.txt; sleep 2"
```

The other three belong *inside* tmux, since passthrough and pane geometry are exactly what they test.
They take the tty of a **visible** pane — `tmux display-message -p '#{pane_tty}'` — and that matters
more than it sounds: Ghostty does not read an image for a pane it is not drawing, so in a hidden pane
nothing is transferred and every probe looks like a protocol failure when it is only a visibility
one. `shm-through-tmux.py` sends a temp-file transfer alongside the shm one for exactly that reason;
read the control first.

`stacking.py` and `raw-render.py` leave an image on screen to be looked at, and each has a
`-cleanup.py` companion that removes it.

The two `convert-bench` files are the odd pair: they need neither Electron nor a terminal, since a
channel swap over a fixed buffer is the whole measurement. They are what settled section 8.4 —
whether the swap was worth a native module — and they stay so the next person to propose one has to
beat these numbers rather than re-derive them. The `.rs` reproduces the deleted `tweb-native` loop
verbatim rather than calling it, which is why it outlived the crate.

```sh
node bench/convert-bench.cjs
rustc -O -o /tmp/tweb-convert-bench bench/convert-bench.rs && /tmp/tweb-convert-bench
```

The fixture pages fill their canvases with deterministic pseudo-random noise, so a compressor cannot
find structure that a real page would not have. `photo` is the adversarial case: a full viewport of
incompressible pixels.

Two caveats when reading a run:

- **Wait for the page to settle.** Chromium paints an empty frame before it commits, and encoding
  that measures nothing. Each script waits and encodes the last frame; `encode.cjs` also writes the
  frame it measured to `shot-<profile>.png` so you can confirm it is not blank.
- **These are one machine's numbers.** The ratios between the paths are the durable result; the
  absolute milliseconds are not.

## The gate harness

`gate-harness.py` is the odd one out among the Electron scripts: it does not build its own
`BrowserWindow`, it spawns the **shipping engine** the way `crates/tweb-pane/src/lib.rs`
does — same argv, same env, stdin as the control channel — and then plays the frontend,
pushing `VIS` lines to move the pane between visible and hidden.

```sh
python3 bench/gate-harness.py hidden --seconds 15
python3 bench/gate-harness.py scroll --seconds 15 --frame-rate 60
python3 bench/gate-harness.py multipane --seconds 30
```

Scenarios: `idle`, `hidden`, `multitab`, `scroll`, `animation`, `reopen`, `multipane`,
`resize`, `crash`. Each prints one JSON object; [GATES.md](GATES.md) is what those objects
were read as.

Driving visibility over the control channel rather than through tmux is not a shortcut —
it is the only way in. A pane's visibility is decided by which tmux **client** is showing
its window, and an agent on this machine cannot attach or move one. So a measurement that
waits for a real tmux client to reveal a pane waits forever, and reads the permanent hidden
state as a result about the code.

What it therefore cannot measure: anything past stdout. There is no terminal on the other
end, so the patch-overlay path never fires and terminal-side texture bytes are out of
reach. `gfxprobe.py` and friends above are where that half lives.
