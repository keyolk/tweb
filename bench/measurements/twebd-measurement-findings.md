# Where the twebd process boundary goes — the measurement

**Taken:** 2026-08-14, macOS 25.6 (arm64), Electron 43.2.0 (the repo's own
`electron/node_modules`), Chrome 151.0.7922.138.
**Metric:** sum of `phys_footprint` (`footprint -p`, macOS's PSS-equivalent) over
every process in the tree. RSS is reported alongside **only** to tie back to the
prior 296 MB / 2.58 GB notes — it double-counts shared Chromium pages and runs
~2.2x the footprint here, so no claim below rests on it.
**Harness:** throwaway, `/tmp/tweb-mem-harness/` (outside the repo; the working tree
was not modified for this measurement). `electron/main.cjs` and `crates/tweb-pane/`
were read but not touched.

---

## 1. The headline

Same four URLs, same order, on both paths, so page weight cancels per step.
Every window is offscreen 1200x800 device px at `deviceScaleFactor: 2`, with the
same `webPreferences` the shipping engine uses for a tab (`offscreen`,
`backgroundThrottling: false`, `show: false`, `paintWhenInitiallyHidden: true`),
painting at 30 fps. Measured 30 s after `did-finish-load`.

| panes | (b) N windows, ONE Electron | | | (c) N SEPARATE Electrons | | | shared saves |
|---|---|---|---|---|---|---|---|
| | procs | footprint | Δ | procs | footprint | Δ | |
| 0 (runtime floor) | 3 | 43.0 MB | — | — | — | — | — |
| 1 — Wikipedia | 4 | 154.4 MB | +111.4 | 4 | 155.3 MB | +155.3 | 0.6% |
| 2 — MDN | 6 | 297.0 MB | +142.6 | 9 | 361.5 MB | +206.2 | 17.8% |
| 3 — rust-lang.org | 7 | 357.0 MB | +60.0 | 13 | 473.0 MB | +111.5 | 24.5% |
| 4 — gnu.org | 8 | **386.0 MB** | +29.0 | 17 | **563.8 MB** | +90.8 | **31.5%** |

**Derived per-pane marginal (panes 2→4, mean):**

| path | footprint / extra pane | processes / extra pane |
|---|---|---|
| shared Electron | **77.2 MB** | **1.33** |
| separate Electron | **136.2 MB** | **4.33** |

At one pane the two paths are identical (154.4 vs 155.3 MB, 0.6% apart) — which is
the control that says the harness is measuring the same thing on both sides. The
divergence is entirely in what the 2nd, 3rd and 4th pane cost.

### The floor run — the same number with content held constant

The real-page marginals wobble (+142.6, +60.0, +29.0) because the four pages differ
in weight. Repeating with four near-identical trivial pages
(`example.com` / `.org` / `.net` / `info.cern.ch`, ~600 B each) isolates the runtime
term, and it comes out flat to within 4 MB:

| panes | shared: procs / footprint / Δ | separate: procs / footprint / Δ |
|---|---|---|
| 1 | 4 / 98.4 MB / — | 4 / 98.4 MB / — |
| 2 | 5 / 132.4 MB / **+34.0** | 8 / 196.9 MB / **+98.5** |
| 3 | 6 / 170.6 MB / **+38.2** | 12 / 290.1 MB / **+93.2** |
| 4 | 7 / 208.7 MB / **+38.1** | 16 / 387.4 MB / **+97.3** |

**A pane costs 38 MB inside an existing Electron and 96 MB as its own Electron —
a 2.5x ratio, and 1 extra process instead of 4.** That is the number the
architecture turns on. Note the first row is *bit-identical* (98.4 MB both) — one
Electron with one window IS one Electron instance; the paths only differ from the
second pane onward.

### Where the difference lives (real pages, 4 panes)

| component | shared | separate | ratio |
|---|---|---|---|
| renderers | 199.0 MB | 200.0 MB | **1.00x** |
| main process (Node + V8 + Electron app) | 58.0 MB | 158.0 MB | 2.72x |
| GPU process | 117.0 MB | 171.0 MB | 1.46x |
| utility processes | 12.0 MB | 34.8 MB | 2.90x |
| **total** | **386.0 MB** | **563.8 MB** | 1.46x |

The renderer term is identical to within 1 MB. That is the honest framing of the
whole result: **a renderer IS the page, and sharing a process cannot make a page
cheaper.** What sharing removes is the per-pane duplication of the *runtime* —
main process, GPU process, utility processes — which is exactly and only what
DESIGN 6.5 gates on.

Comparability cross-check: both paths ran **5 renderers for 4 pages** (MDN spawns
one cross-origin subframe renderer), and separate-4 decomposes exactly as
`4 x (main + gpu + utility) + 5 renderers = 17` processes. The two paths really are
rendering the same content.

---

## 2. Secondary: CDP-driven Chromium, no Electron

Headless Chrome (`--headless=new`), one browser, four pages opened as CDP targets,
same four URLs, same 20 s settle, extensions and component-extension background
pages disabled (see caveat below).

| pages | procs | footprint | Δ | RSS |
|---|---|---|---|---|
| 0 (browser floor) | 8 | 386.0 MB | — | 847.1 MB |
| 1 | 9 | 494.0 MB | +108.0 | 981.9 MB |
| 2 | 11 | 647.0 MB | +153.0 | 1300.9 MB |
| 3 | 12 | 708.0 MB | +61.0 | 1458.3 MB |
| 4 | 13 | **830.0 MB** | +122.0 | 1469.3 MB |

**CDP-no-Electron does not beat shared Electron — it loses to it, badly: 830 MB vs
386 MB at four pages (2.15x), on 13 processes vs 8.** The marginal per page is
comparable (mean 112 MB over pages 2→4 vs shared Electron's 77.2 MB, both dominated
by the renderer), but the *floor* is not: a stock Chrome browser process costs
386 MB before it has loaded anything, against Electron's 43 MB, because it carries
a full browser's services — network service, storage service, an alerts helper, a
speech/optimization utility, and a GPU process configured for on-screen compositing.

Two caveats, stated plainly:
- This is **Google Chrome, not a minimal Chromium build**. A CDP daemon built on
  bare Chromium with services trimmed would land lower than 386 MB. Nothing here
  measures that, and no minimal Chromium was available on this machine — the claim
  is only that *the readily-available CDP path* loses.
- The first CDP run was invalid: even with a fresh `--user-data-dir`, this machine's
  Chrome force-installs extensions, which added 6 processes and ~330 MB to the
  floor (14 procs / 717 MB). The numbers above are the rerun with
  `--disable-extensions --disable-component-extensions-with-background-pages`.
  Anyone rerunning on a managed Mac must keep those flags or they will measure the
  extensions.

Second-order evidence pointing the same way, from the primary runs: the shared
Electron's main process holds at 58 MB across 4 panes (43 → 48 → 57 → 58) — the
Node/V8 term is already flat once the process exists. Removing Electron therefore
buys at most that ~58 MB back, and the CDP floor spends 343 MB more than that to
get it.

---

## 3. Exact commands to rerun

Harness files (throwaway, outside the repo): `/tmp/tweb-mem-harness/`
— `shared.cjs` (N BrowserWindows in one Electron, driven step-by-step over
stdin/stdout so an outside shell decides when a measurement is taken),
`measure.sh` (tree walk → per-pid `footprint`), `measure-by-marker.sh` (selects by
`--user-data-dir` marker; needed because a tree walk cannot separate the user's own
Chrome helpers), and the three drivers.

```bash
URLS="https://en.wikipedia.org/wiki/Terminal_emulator,\
https://developer.mozilla.org/en-US/docs/Web/CSS/flex,\
https://www.rust-lang.org/,https://www.gnu.org/"

# (a) + (b): one Electron, 4 BrowserWindows
cd /tmp/tweb-mem-harness
HARNESS_URLS="$URLS" SETTLE=30 ./run-shared.sh   /tmp/out-shared.txt

# (c): four CONCURRENT separate Electron instances, one window each
pkill -f shared.cjs
HARNESS_URLS="$URLS" SETTLE=30 ./run-separate.sh /tmp/out-separate.txt

# floor run: same drivers, four trivial pages
FLOOR="https://example.com/,https://example.org/,https://example.net/,https://info.cern.ch/"
HARNESS_URLS="$FLOOR" SETTLE=20 ./run-shared.sh   /tmp/out-shared-floor.txt
HARNESS_URLS="$FLOOR" SETTLE=20 ./run-separate.sh /tmp/out-separate-floor.txt

# secondary: CDP headless Chrome
HARNESS_URLS="$URLS" SETTLE=20 ./run-cdp.sh /tmp/out-cdp.txt
```

The single measurement primitive, if you want to check one number by hand:

```bash
footprint -p <pid> | awk '/phys_footprint:/ && !/peak/ {print $2, $3; exit}'
```

Two mechanics that materially change the answer and must be kept:

- **Each Electron instance in (c) gets its own `userData`**
  (`app.setPath("userData", mkdtempSync(...))`). Concurrent instances sharing one
  profile contend on Chromium's singleton and cache locks, and the second instance
  stops behaving like the first.
- **Settle before measuring.** A first pass with no settle reported 454 MB for
  4 shared windows against the 386 MB above, because the GPU process allocates
  transient buffers around a fresh window (measured spike: 187 MB → 64 MB over the
  following seconds) and an immediate reading records that spike as steady state.
  30 s was used for the real-page runs, 20 s for the floor and CDP runs.

---

## 4. Verdict

**The measurement supports one Electron hosting N panes with twebd as the Rust
supervisor — not DESIGN 5.1 as written, and not CDP-no-Electron.** With content
held constant a pane costs **38 MB and 1 process inside an existing Electron
against 96 MB and 4 processes as its own Electron**, a 2.5x ratio that grows with
pane count (31.5% and 9 fewer processes at just four real pages), and the entire
saving is the runtime term — main process 2.7x, utility 2.9x, GPU 1.5x — while the
renderer term is identical to within 1 MB on both paths. That is precisely the
shape DESIGN 6.5 gates on: the browser runtime and Node/V8 stop being duplicated
in proportion to pane count, and what remains proportional is the renderer, which
*is* the page and cannot be shared away. DESIGN 5.1's stronger claim — that twebd
should own Chromium directly, with no Electron — is not supported: the only
no-Electron path measurable here costs 386 MB before loading a page against
Electron's 43 MB floor and ends at 830 MB where shared Electron sits at 386 MB, and
the main process that dropping Electron would eliminate is worth just 58 MB flat
across all four panes. Two honest limits on this verdict: sharing does **not**
collapse total memory — at four real pages it is a 31.5% saving, not an order of
magnitude, and anyone writing "a full Electron runtime is never started per pane"
should say what that is worth (~58 MB of runtime per pane avoided, plus 3 processes)
rather than implying panes become cheap; and the CDP number is Google Chrome, not a
trimmed Chromium build, so it rules out the *available* CDP path rather than the
theoretical one.

---

## Appendix — the harness, inlined
The harness lived in `/tmp/tweb-mem-harness/` and is not part of the repo. `/tmp` is
volatile, so the sources are reproduced here in full: recreate the directory, write
these six files into it, `chmod +x *.sh`, and the commands in section 3 run as written.

### `shared.cjs`

```javascript
"use strict";

// THROWAWAY measurement harness — path (a) + (b).
//
// Opens N offscreen BrowserWindows in ONE Electron process, mirroring the window
// options that electron/main.cjs uses for a tab, and pauses after each load so an
// outside shell can walk the process tree. It prints protocol lines to stdout and
// waits for a line on stdin before opening the next window, so the shell driving it
// decides when a measurement is taken rather than a timer inside here.

const { app, BrowserWindow } = require("electron");
const { mkdtempSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const URLS = process.env.HARNESS_URLS.split(",");
const VIEWPORT_W = Number(process.env.HARNESS_VIEWPORT_W || 1200);
const VIEWPORT_H = Number(process.env.HARNESS_VIEWPORT_H || 800);
const SCALE = Number(process.env.HARNESS_SCALE || 2);

// A separate profile per Electron process. Concurrent instances that share one
// userData contend on Chromium's singleton/cache locks and the later instance does
// not behave like the first, which would poison path (c).
app.setPath("userData", mkdtempSync(path.join(os.tmpdir(), "tweb-mem-profile-")));

const windows = [];

function windowOptions() {
  return {
    width: Math.round(VIEWPORT_W / SCALE),
    height: Math.round(VIEWPORT_H / SCALE),
    useContentSize: true,
    x: -10_000,
    y: -10_000,
    show: false,
    opacity: 0,
    paintWhenInitiallyHidden: true,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: { deviceScaleFactor: SCALE },
      backgroundThrottling: false,
      devTools: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      contextIsolation: true,
    },
  };
}

function openWindow(url) {
  return new Promise((resolve) => {
    const win = new BrowserWindow(windowOptions());
    windows.push(win);
    // The shipping engine keeps the active tab painting; a window that never paints
    // never allocates its compositor buffers, which would understate the marginal.
    win.webContents.setFrameRate(30);
    let paints = 0;
    win.webContents.on("paint", () => { paints += 1; });
    win.webContents.once("did-finish-load", () => {
      win.webContents.invalidate();
      setTimeout(() => resolve(paints), 3000);
    });
    void win.loadURL(url).catch((error) => {
      console.error(`harness: load failed ${url}: ${error.message}`);
      resolve(paints);
    });
  });
}

function waitForLine() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });
}

app.whenReady().then(async () => {
  console.log(`PID ${process.pid}`);
  console.log("READY");
  await waitForLine();
  for (let i = 0; i < URLS.length; i += 1) {
    const paints = await openWindow(URLS[i]);
    console.log(`LOADED ${i + 1} ${URLS[i]} paints=${paints}`);
    await waitForLine();
  }
  console.log("DONE");
  await waitForLine();
  app.quit();
});

app.on("window-all-closed", () => {});
```

### `measure.sh`

```bash
#!/usr/bin/env bash
# THROWAWAY: report process count, summed phys_footprint and summed RSS for the
# process tree(s) rooted at the given pids.
#
# usage: measure.sh <label> <rootpid> [rootpid...]
set -uo pipefail

label="$1"; shift

# Collect every descendant of the root pids.
pids=""
frontier="$*"
while [ -n "$frontier" ]; do
  pids="$pids $frontier"
  next=""
  for p in $frontier; do
    kids=$(pgrep -P "$p" 2>/dev/null | tr '\n' ' ')
    next="$next $kids"
  done
  frontier=$(echo "$next" | tr -s ' ' | sed 's/^ //;s/ $//')
done
pids=$(echo "$pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -un)

count=0
fp_total=0
rss_total=0
echo "### $label"
printf '%-8s %12s %12s  %s\n' PID FOOTPRINT_KB RSS_KB COMMAND
for p in $pids; do
  fp=$(footprint -p "$p" 2>/dev/null | awk '/phys_footprint:/ && !/peak/ {print $2, $3; exit}')
  [ -z "$fp" ] && continue
  val=$(echo "$fp" | awk '{print $1}')
  unit=$(echo "$fp" | awk '{print $2}')
  case "$unit" in
    KB) kb=$(echo "$val" | awk '{printf "%.0f", $1}') ;;
    MB) kb=$(echo "$val" | awk '{printf "%.0f", $1*1024}') ;;
    GB) kb=$(echo "$val" | awk '{printf "%.0f", $1*1024*1024}') ;;
    B)  kb=$(echo "$val" | awk '{printf "%.0f", $1/1024}') ;;
    *)  continue ;;
  esac
  rss=$(ps -o rss= -p "$p" 2>/dev/null | tr -d ' ')
  [ -z "$rss" ] && rss=0
  cmd=$(ps -o comm= -p "$p" 2>/dev/null | sed 's|.*/||' | cut -c1-40)
  # Chromium names every helper the same; the type switch is what distinguishes them.
  typ=$(ps -o args= -p "$p" 2>/dev/null | grep -oE '\-\-type=[a-zA-Z-]+' | head -1)
  printf '%-8s %12s %12s  %s %s\n' "$p" "$kb" "$rss" "$cmd" "$typ"
  count=$((count + 1))
  fp_total=$((fp_total + kb))
  rss_total=$((rss_total + rss))
done
printf 'TOTAL %s procs=%d footprint_kb=%d footprint_mb=%.1f rss_kb=%d rss_mb=%.1f\n' \
  "$label" "$count" "$fp_total" "$(echo "$fp_total" | awk '{print $1/1024}')" \
  "$rss_total" "$(echo "$rss_total" | awk '{print $1/1024}')"
echo
```

### `measure-by-marker.sh`

```bash
#!/usr/bin/env bash
# THROWAWAY: like measure.sh, but selects processes by a marker string in their argv
# instead of by process tree. The user's own Chrome is running on this machine and a
# tree walk cannot tell its helpers apart from a harness-launched browser's.
#
# usage: measure-by-marker.sh <label> <marker>
set -uo pipefail

label="$1"
marker="$2"

pids=$(pgrep -f "$marker" 2>/dev/null | sort -un)

count=0
fp_total=0
rss_total=0
echo "### $label"
printf '%-8s %12s %12s  %s\n' PID FOOTPRINT_KB RSS_KB COMMAND
for p in $pids; do
  fp=$(footprint -p "$p" 2>/dev/null | awk '/phys_footprint:/ && !/peak/ {print $2, $3; exit}')
  [ -z "$fp" ] && continue
  val=$(echo "$fp" | awk '{print $1}')
  unit=$(echo "$fp" | awk '{print $2}')
  case "$unit" in
    KB) kb=$(echo "$val" | awk '{printf "%.0f", $1}') ;;
    MB) kb=$(echo "$val" | awk '{printf "%.0f", $1*1024}') ;;
    GB) kb=$(echo "$val" | awk '{printf "%.0f", $1*1024*1024}') ;;
    B)  kb=$(echo "$val" | awk '{printf "%.0f", $1/1024}') ;;
    *)  continue ;;
  esac
  rss=$(ps -o rss= -p "$p" 2>/dev/null | tr -d ' ')
  [ -z "$rss" ] && rss=0
  cmd=$(ps -o comm= -p "$p" 2>/dev/null | sed 's|.*/||' | cut -c1-40)
  typ=$(ps -o args= -p "$p" 2>/dev/null | grep -oE '\-\-type=[a-zA-Z-]+' | head -1)
  printf '%-8s %12s %12s  %s %s\n' "$p" "$kb" "$rss" "$cmd" "$typ"
  count=$((count + 1))
  fp_total=$((fp_total + kb))
  rss_total=$((rss_total + rss))
done
printf 'TOTAL %s procs=%d footprint_kb=%d footprint_mb=%.1f rss_kb=%d rss_mb=%.1f\n' \
  "$label" "$count" "$fp_total" "$(echo "$fp_total" | awk '{print $1/1024}')" \
  "$rss_total" "$(echo "$rss_total" | awk '{print $1/1024}')"
echo
```

### `run-shared.sh`

```bash
#!/usr/bin/env bash
# THROWAWAY driver for path (a)+(b): one Electron process, N BrowserWindows.
# Measures after app-ready (engine floor), then after each window's page settles.
set -uo pipefail
cd "$(dirname "$0")"

ELECTRON="${ELECTRON:-/Users/gavin.jeong/src/keyolk/tweb/electron/node_modules/.bin/electron}"
OUT="${1:-/tmp/tweb-mem-harness/shared-run.txt}"
SETTLE="${SETTLE:-30}"
: "${HARNESS_URLS:?set HARNESS_URLS}"

work=$(mktemp -d /tmp/tweb-mem-harness/shared.XXXX)
mkfifo "$work/in" "$work/out"
: > "$OUT"

exec 9<>"$work/in"
exec 8<>"$work/out"

HARNESS_URLS="$HARNESS_URLS" "$ELECTRON" ./shared.cjs \
  < "$work/in" > "$work/out" 2> "$work/err" &
electron_pid=$!

root=""
while IFS= read -r line <&8; do
  echo "harness: $line"
  case "$line" in
    "PID "*) root="${line#PID }" ;;
    READY)
      sleep "$SETTLE"
      ./measure.sh "shared-ready-0-windows" "$root" >> "$OUT"
      echo step >&9 ;;
    LOADED*)
      n=$(echo "$line" | awk '{print $2}')
      # The GPU process allocates transient buffers around a fresh window and its
      # footprint falls back over the following seconds; measuring immediately
      # records that spike as if it were the pane's steady-state cost.
      sleep "$SETTLE"
      ./measure.sh "shared-${n}-windows | $line" "$root" >> "$OUT"
      echo step >&9 ;;
    DONE)
      echo step >&9
      break ;;
  esac
done

wait $electron_pid 2>/dev/null
exec 9>&- 8>&-
echo "--- stderr ---"; cat "$work/err"
rm -rf "$work"
echo "=== $OUT ==="
cat "$OUT"
```

### `run-separate.sh`

```bash
#!/usr/bin/env bash
# THROWAWAY driver for path (c): N CONCURRENT separate Electron processes, each with
# ONE BrowserWindow, in the same URL order as the shared run. Shipping today does this
# once per tmux pane.
set -uo pipefail
cd "$(dirname "$0")"

ELECTRON="${ELECTRON:-/Users/gavin.jeong/src/keyolk/tweb/electron/node_modules/.bin/electron}"
OUT="${1:-/tmp/tweb-mem-harness/separate-run.txt}"
SETTLE="${SETTLE:-30}"
: "${HARNESS_URLS:?set HARNESS_URLS}"

: > "$OUT"
roots=""
work=$(mktemp -d /tmp/tweb-mem-harness/sep.XXXX)

i=0
IFS=, read -ra urls <<< "$HARNESS_URLS"
for url in "${urls[@]}"; do
  i=$((i + 1))
  mkfifo "$work/in$i" "$work/out$i"
  exec {inf}<>"$work/in$i"
  exec {outf}<>"$work/out$i"
  eval "in_$i=$inf; out_$i=$outf"

  HARNESS_URLS="$url" "$ELECTRON" ./shared.cjs \
    < "$work/in$i" > "$work/out$i" 2> "$work/err$i" &

  # Drive this instance to exactly one loaded window, then leave it alive.
  root=""
  while IFS= read -r line <&$outf; do
    echo "instance$i: $line"
    case "$line" in
      "PID "*) root="${line#PID }" ;;
      READY) echo step >&$inf ;;
      LOADED*) break ;;
    esac
  done
  roots="$roots $root"
  # The GPU process allocates transient buffers around a fresh window and its
  # footprint falls back over the following seconds; measuring immediately
  # records that spike as if it were the instance's steady-state cost.
  sleep "$SETTLE"
  # shellcheck disable=SC2086
  ./measure.sh "separate-${i}-instances | $url" $roots >> "$OUT"
done

echo "=== $OUT ==="
cat "$OUT"

# shellcheck disable=SC2086
kill $roots 2>/dev/null
sleep 2
rm -rf "$work"
```

### `run-cdp.sh`

```bash
#!/usr/bin/env bash
# THROWAWAY: secondary check — headless Chrome driven over CDP, no Electron at all.
# One browser, N targets (pages), same URL order as the primary runs.
#
# Selection is by --user-data-dir marker, not by process tree: the user's own Chrome
# is running and every helper shares the same executable and parent shape, so a tree
# walk from the launched pid picks up unrelated helpers.
set -uo pipefail
cd "$(dirname "$0")"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT="${1:-/tmp/tweb-mem-harness/cdp-run.txt}"
SETTLE="${SETTLE:-20}"
: "${HARNESS_URLS:?set HARNESS_URLS}"

profile=/tmp/tweb-mem-harness/cdp-profile-marker
rm -rf "$profile"; mkdir -p "$profile"
: > "$OUT"

"$CHROME" --headless=new --remote-debugging-port=9333 \
  --user-data-dir="$profile" --no-first-run --no-default-browser-check --disable-extensions --disable-component-extensions-with-background-pages --disable-features=Translate,OptimizationHints \
  --window-size=1200,800 --force-device-scale-factor=2 \
  about:blank > "$profile/chrome.log" 2>&1 &

for _ in $(seq 30); do
  curl -sf http://127.0.0.1:9333/json/version > /dev/null && break
  sleep 1
done

sleep "$SETTLE"
./measure-by-marker.sh "cdp-ready-0-pages" "$profile" >> "$OUT"

i=0
IFS=, read -ra urls <<< "$HARNESS_URLS"
for url in "${urls[@]}"; do
  i=$((i + 1))
  curl -sf "http://127.0.0.1:9333/json/new?$url" -X PUT > /dev/null
  sleep "$SETTLE"
  ./measure-by-marker.sh "cdp-${i}-pages | $url" "$profile" >> "$OUT"
done

echo "=== $OUT ==="
cat "$OUT"
pkill -f "$profile" 2>/dev/null
sleep 2
rm -rf "$profile"
```
