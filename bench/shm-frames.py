#!/usr/bin/env python3
"""Whole frames through shared memory (`t=s`) against the frame file (`t=f`), on a real Ghostty.

What it answers: with the shm addon shipped, does a Retina-size pane playing a page that repaints
every pixel every frame still drop whole frames, and does the terminal really consume (unlink)
every object the engine created?

Why a real terminal window: Ghostty does not read an image for a pane it is not drawing, so a bare
PTY or a hidden tmux pane never consumes `t=s` objects — the leak check would always fail and the
drop counts would mean nothing (memory: tweb-graphics-probe-needs-bare-tty). This opens its own
Ghostty window per arm, outside tmux, and closes it afterwards.

    python3 bench/shm-frames.py --tweb target/debug/tweb            # both arms, 20s each
    python3 bench/shm-frames.py --tweb ... --arms file,default,file,default --seconds 30

Arms: `file` forces the frame-file medium, `shm` forces shared memory, `default` sets nothing.

Each arm runs a per-pane engine (TWEB_DAEMON=0, so the build under test is what runs) with the
rate pinned at 30fps, waits for the pane to settle, then reads `tweb diag` twice, `--seconds`
apart, and reports deltas: whole frames sent, frames dropped to backpressure, how many went
through shm. After the window closes it checks that none of the arm's ring objects still exist.
"""

import argparse
import ctypes
import ctypes.util
import json
import os
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGE = (ROOT / "bench" / "pages" / "fullpaint.html").as_uri()
GHOSTTY = "/Applications/Ghostty.app"
RING = 4

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
libc.shm_open.restype = ctypes.c_int
libc.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int]


def shm_exists(name):
    fd = libc.shm_open(name.encode(), os.O_RDONLY)
    if fd >= 0:
        os.close(fd)
        return True
    return False


# Its own runtime directory, so the arm's agent socket is the only one there. Under /tmp because a
# unix socket path is capped at 104 bytes and a scratch path is often longer.
RUNTIME = Path("/tmp/twb-shm-bench")


def agent_sockets():
    RUNTIME.mkdir(exist_ok=True)
    return {str(path) for path in RUNTIME.glob("agent-*.sock")}


def diag(tweb, socket):
    env = dict(os.environ, TWEB_AGENT_SOCKET=socket)
    out = subprocess.run([tweb, "diag"], capture_output=True, text=True, env=env, timeout=20)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip())
    return json.loads(out.stdout)


def frames_of(report):
    frames = report.get("frames") or report.get("result", {}).get("frames") or {}
    return frames


def run_arm(args, arm):
    before = agent_sockets()
    env_prefix = [
        # `open` hands the caller's environment to the new Ghostty, so a harness run from inside
        # tmux would make the engine believe it is the caller's tmux pane — and stop drawing,
        # since that pane is not the window on screen.
        "env", "-u", "TMUX", "-u", "TMUX_PANE", "TWEB_DAEMON=0", # `default` sets nothing, so the engine decides from the terminal's name as it ships.
        *([] if arm == "default" else [f"TWEB_SHM_FRAMES={'1' if arm == 'shm' else '0'}"]),
        "TWEB_ASSUME_GRAPHICS=1", f"TWEB_RUNTIME_DIR={RUNTIME}",
    ]
    command = env_prefix + [args.tweb, "open", "--frame-rate", "30", "--no-adaptive-frame-rate", PAGE]
    ghostty = subprocess.Popen([
        "open", "-na", GHOSTTY, "--args",
        f"--window-width={args.cols}", f"--window-height={args.rows}",
        # Without this a macOS Ghostty instance outlives its window, and every arm would leave one.
        "--confirm-close-surface=false", "--quit-after-last-window-closed=true",
        # One `--command=` argument, not `-e <argv>`: LaunchServices reads a bare executable path
        # among `open --args` as a document to open, and Ghostty then opens a second tab running it,
        # which comes to the front and hides — so stops drawing — the pane under test.
        "--command=" + shlex.join(command),
    ])
    ghostty.wait()
    socket = None
    deadline = time.time() + 60
    while time.time() < deadline and not socket:
        time.sleep(1)
        fresh = agent_sockets() - before
        if fresh:
            socket = sorted(fresh)[0]
    if not socket:
        raise RuntimeError("no agent socket appeared for the arm's engine")
    time.sleep(args.settle)
    report = diag(args.tweb, socket)
    engine_pid = report.get("pid") or report.get("result", {}).get("pid")
    first = frames_of(report)
    time.sleep(args.seconds)
    second = frames_of(diag(args.tweb, socket))
    image_id = second.get("imageId") or first.get("imageId")

    def delta(key):
        return (second.get(key) or 0) - (first.get(key) or 0)

    result = {
        "arm": arm,
        "size": second.get("lastSize") or second.get("expected"),
        "medium": second.get("wholeMedium"),
        "shmReason": second.get("shmReason"),
        "shmError": second.get("shmError"),
        "whole": delta("whole"),
        "wholeShm": delta("wholeShm"),
        "dropped": delta("droppedByBackpressure"),
        "seconds": args.seconds,
    }
    result["fps"] = round(result["whole"] / args.seconds, 1)
    # Closing the engine closes the window: Ghostty exits a surface whose command ended.
    os.kill(engine_pid, signal.SIGTERM)
    time.sleep(3)
    # Belt and braces for the instance: match it by this arm's own runtime directory, never by name,
    # so the user's own Ghostty is never touched.
    subprocess.run(["pkill", "-f", f"Ghostty.app/Contents/MacOS/ghostty .*{RUNTIME}"], check=False)
    if image_id is not None:
        names = [f"/twb.{engine_pid}.{image_id}.{slot}" for slot in range(RING)]
        result["leftoverShm"] = [name for name in names if shm_exists(name)]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tweb", required=True, help="the tweb binary under test")
    parser.add_argument("--arms", default="file,shm")
    parser.add_argument("--seconds", type=float, default=20)
    parser.add_argument("--settle", type=float, default=8)
    parser.add_argument("--cols", type=int, default=360)
    parser.add_argument("--rows", type=int, default=100)
    args = parser.parse_args()
    args.tweb = str(Path(args.tweb).resolve())
    results = [run_arm(args, arm.strip()) for arm in args.arms.split(",") if arm.strip()]
    json.dump(results, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
