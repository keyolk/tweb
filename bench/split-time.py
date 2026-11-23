#!/usr/bin/env python3
"""How long `tweb split` takes to get the pane's frontend running, and what runs in the pane.

Splits the calling pane N times with `tweb split URL`, one pane at a time. Each pane is closed with
a typed Ctrl-C after a moment. The timing comes from the pane's own launch.log line (`started_at`,
written when it ends; see crates/tweb-pane/src/launch_timeline.rs): split called -> frontend
started. That is the part launch.log cannot see by itself. Before keyolk/tweb#302 it included
`default-shell -c`, which was 177-253ms of fish here, and 28-35ms after.

Runs against the daemon the calling shell would use. Every pane it opens is its own, in the calling
pane's window, and is closed before the next. Run it from inside tmux:

  python3 bench/split-time.py [--tweb PATH] [-n 3] [URL]

Two guards, both from a run on 2026-11-23:
- A split that fails (the window has no room: "no space for a new pane") prints no pane id. The
  Ctrl-C used to go to `tmux send-keys -t ''`, and an empty target is the CALLING pane: it went to
  the agent session that ran this. Now a split without a pane id stops the run before any key is
  sent.
- Each split takes half the calling pane, and closing it gives the columns to the neighbour, so the
  calling pane shrank each round until no split fitted. Its width is put back after every close.
"""

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True).stdout.strip()


def pane_id(text):
    """The pane id `tweb split` printed, or None. Only `%N` counts: anything else (an empty line,
    an error) must never reach `send-keys -t`, where an empty target means the calling pane."""
    text = text.strip()
    return text if text.startswith("%") and text[1:].isdigit() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tweb", default=shutil.which("tweb") or "tweb")
    parser.add_argument("-n", type=int, default=3)
    parser.add_argument("url", nargs="?", default="about:blank")
    args = parser.parse_args()

    me = os.environ.get("TMUX_PANE")
    if not me:
        sys.exit("run this inside tmux: it splits the calling pane")
    width = tmux("display-message", "-p", "-t", me, "#{pane_width}")
    # Where launch.log goes, by the rule of `twebd::paths::logs_dir_for`.
    if os.environ.get("TWEB_RUNTIME_DIR"):
        log = Path(os.environ["TWEB_RUNTIME_DIR"]) / "logs" / "launch.log"
    elif os.environ.get("TWEB_CACHE_DIR"):
        log = Path(os.environ["TWEB_CACHE_DIR"]) / "logs" / "launch.log"
    else:
        log = Path.home() / ".cache/tweb/logs/launch.log"

    for round_ in range(args.n):
        before = log.read_text().count("\n") if log.exists() else 0
        start = time.time()
        out = subprocess.run([args.tweb, "split", args.url], capture_output=True, text=True)
        pane = pane_id(out.stdout)
        if pane is None:
            sys.exit(f"split {round_} gave no pane id (stdout {out.stdout!r}, stderr "
                     f"{out.stderr.strip()!r}); stopping before any key is sent")
        time.sleep(1.5)
        process = tmux("display-message", "-p", "-t", pane, "#{pane_pid}")
        command = subprocess.run(["ps", "-o", "comm=", "-p", process], capture_output=True,
                                 text=True).stdout.strip()
        parent = subprocess.run(["ps", "-o", "ppid=", "-p", process], capture_output=True,
                                text=True).stdout.strip()
        parent_command = subprocess.run(["ps", "-o", "comm=", "-p", parent], capture_output=True,
                                        text=True).stdout.strip()
        # A hidden pane gets no frames, so its line is written when it ends.
        tmux("send-keys", "-t", pane, "C-c")
        line = None
        deadline = time.time() + 15
        while time.time() < deadline and line is None:
            lines = log.read_text().splitlines() if log.exists() else []
            line = next((each for each in lines[before:] if f" pane={pane} " in each), None)
            time.sleep(0.05)
        started = float(line.split()[0]) if line else None
        gap = f"{(started - start) * 1000:.0f}ms" if started else "?"
        print(f"{round_}: pane={pane} split_to_frontend={gap} "
              f"pane_process={os.path.basename(command)} parent={os.path.basename(parent_command)}")
        if line:
            print("   ", line[:220])
        tmux("resize-pane", "-t", me, "-x", width)
        time.sleep(1)


if __name__ == "__main__":
    main()
