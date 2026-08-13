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
| `damage.cjs` | How large the `paint` dirty rect actually is while typing, scrolling and hovering |
| `worker-encode.cjs` | Whether moving the PNG encode to a worker thread helps (it does not) |
| `gfxprobe.py` | Whether the terminal really reads a `t=s` shm transfer, and whether a patch image can be placed over a base and deleted independently |
| `stacking.py` | Whether a patch placed after a base actually draws *on top* of it (judged by eye — the protocol only reports lifetime) |

`gfxprobe.py` is the odd one out: it talks to a terminal, not to Electron, and **must run on a bare
tty**. Graphics responses do not come back through tmux DCS passthrough — which is why the shipping
code sends everything `q=2` — so inside tmux every probe reads as a timeout. Give it its own window:

```sh
open -na /Applications/Ghostty.app --args \
  -e /bin/sh -c "python3 bench/gfxprobe.py /tmp/gfxprobe.txt; sleep 2"
```

`stacking.py` is the opposite: it belongs *inside* tmux, since drawing order is exactly what
passthrough might disturb. It leaves a red base with a green patch on it and returns; look at the
pane, then run `stacking-cleanup.py` on the same tty to delete both images.

The fixture pages fill their canvases with deterministic pseudo-random noise, so a compressor cannot
find structure that a real page would not have. `photo` is the adversarial case: a full viewport of
incompressible pixels.

Two caveats when reading a run:

- **Wait for the page to settle.** Chromium paints an empty frame before it commits, and encoding
  that measures nothing. Each script waits and encodes the last frame; `encode.cjs` also writes the
  frame it measured to `shot-<profile>.png` so you can confirm it is not blank.
- **These are one machine's numbers.** The ratios between the paths are the durable result; the
  absolute milliseconds are not.
