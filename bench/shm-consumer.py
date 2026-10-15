#!/usr/bin/env python3
"""The engine's half of `t=s`, checked without a terminal: this harness IS the terminal.

`bench/shm-frames.py` needs a real Ghostty window, because only a terminal drawing the pane reads
the objects. This one checks everything up to that point on a bare PTY: it runs `tweb open` with
shared-memory frames forced on, reads the escape stream the engine writes, and for every `t=s`
transmit opens the named object the way a terminal would — checks it exists, that its size is
exactly `s * v * 4`, that its pixels are not garbage — and unlinks it, as Ghostty does after reading.

    python3 bench/shm-consumer.py --tweb target/debug/tweb --page fullpaint    # whole frames
    python3 bench/shm-consumer.py --tweb target/debug/tweb --page smallpaint   # patches
    python3 bench/shm-consumer.py --tweb target/debug/tweb --tmux              # through passthrough

Exits non-zero when any transmit names a missing or wrongly sized object, or when nothing went
through shared memory at all. It cannot judge drawing order or what is on screen; that is
shm-frames.py's job on a real terminal.
"""

import argparse
import base64
import ctypes
import ctypes.util
import fcntl
import json
import mmap
import os
import pty
import re
import select
import shlex
import signal
import subprocess
import struct
import sys
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
libc.shm_open.restype = ctypes.c_int
libc.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
libc.shm_unlink.restype = ctypes.c_int
libc.shm_unlink.argtypes = [ctypes.c_char_p]

APC = re.compile(rb"\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\")


def consume(name, width, height):
    """Read and unlink one object as a terminal would. Returns (ok, detail)."""
    fd = libc.shm_open(name.encode(), os.O_RDONLY)
    if fd < 0:
        return False, f"{name}: missing (errno {ctypes.get_errno()})"
    try:
        size = os.fstat(fd).st_size
        expected = width * height * 4
        # macOS rounds a shm object up to the page size, so the object may be larger than the frame;
        # smaller is the bug that yields garbage pixels instead of an error (DETAIL.md 8.2).
        if size < expected:
            return False, f"{name}: {size} bytes, needs {expected}"
        with mmap.mmap(fd, expected, prot=mmap.PROT_READ) as view:
            data = bytes(view)
        pixels = [data[i:i + 4] for i in range(0, min(len(data), 4 * 200000), 4)]
        opaque = sum(1 for p in pixels if p[3] == 255) / max(1, len(pixels))
        colours = {
            "red": sum(1 for p in pixels if p[:3] == b"\xff\x00\x00"),
            "green": sum(1 for p in pixels if p[:3] == b"\x00\xff\x00"),
            "blue": sum(1 for p in pixels if p[:3] == b"\x00\x00\xff"),
        }
        counts = {}
        for p in pixels:
            counts[p[:3]] = counts.get(p[:3], 0) + 1
        top = [f"{rgb.hex()}x{n}" for rgb, n in sorted(counts.items(), key=lambda kv: -kv[1])[:3]]
        return True, {"name": name, "size": [width, height], "opaque": round(opaque, 3), "colours": colours, "top": top}
    finally:
        os.close(fd)
        libc.shm_unlink(name.encode())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tweb", required=True)
    parser.add_argument("--page", default="fullpaint")
    parser.add_argument("--seconds", type=float, default=12)
    parser.add_argument("--pixels", default="1440x900", help="PTY pixel size, WxH")
    parser.add_argument("--cells", default="180x50", help="PTY cell size, COLSxROWS")
    parser.add_argument("--tmux", action="store_true", help="run tweb in a private tmux server and read its client")
    args = parser.parse_args()
    width, height = (int(v) for v in args.pixels.split("x"))
    cols, rows = (int(v) for v in args.cells.split("x"))
    page = (ROOT / "bench" / "pages" / f"{args.page}.html").as_uri()
    env = {k: v for k, v in os.environ.items() if not k.startswith("TMUX")}
    env.update(TWEB_DAEMON="0", TWEB_SHM_FRAMES="1", TWEB_ASSUME_GRAPHICS="1",
               TWEB_RUNTIME_DIR="/tmp/twb-shm-consumer", TERM="xterm-ghostty")
    Path("/tmp/twb-shm-consumer").mkdir(exist_ok=True)
    tweb = str(Path(args.tweb).resolve())
    command = [tweb, "open", "--frame-rate", "30", "--no-adaptive-frame-rate", page]
    socket = "twb-shm-consumer"
    if args.tmux:
        # The harness is the terminal tmux's client draws on: a private server whose one window runs
        # tweb, a client attached on this PTY. Graphics reach the harness only through passthrough,
        # and only while that window is the one the client shows — exactly the shipping path.
        subprocess.run(["tmux", "-L", socket, "kill-server"], capture_output=True)
        exports = " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items() if k.startswith("TWEB_"))
        subprocess.run(["tmux", "-L", socket, "-f", "/dev/null", "new-session", "-d", "-x", str(cols),
                        "-y", str(rows), f"env {exports} {shlex.join(command)}"], check=True, env=env)
        subprocess.run(["tmux", "-L", socket, "set", "-g", "allow-passthrough", "on"], check=True)
    pid, fd = pty.fork()
    if pid == 0:
        if args.tmux:
            os.execvpe("tmux", ["tmux", "-L", socket, "attach"], env)
        os.execve(tweb, command, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, width, height))
    buffer = b""
    seen = {"whole": [], "patch": [], "errors": [], "inline_png_patches": 0}
    deadline = time.time() + args.seconds
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 1 << 16)
        except OSError:
            break
        if not chunk:
            break
        buffer += chunk
        last = 0
        for match in APC.finditer(buffer):
            last = match.end()
            keys = dict(part.split("=", 1) for part in match.group(1).decode().split(",") if "=" in part)
            if keys.get("a") == "T" and keys.get("f") == "100":
                seen["inline_png_patches"] += 1
            if keys.get("t") != "s":
                continue
            name = base64.b64decode(match.group(2) or b"").decode()
            ok, detail = consume(name, int(keys["s"]), int(keys["v"]))
            kind = "patch" if ".p" in name.rsplit(".", 1)[-1] or name.rsplit(".", 1)[-1].startswith("p") else "whole"
            (seen[kind] if ok else seen["errors"]).append(detail)
        buffer = buffer[last:] if last else buffer[-65536:]
    if args.tmux:
        subprocess.run(["tmux", "-L", socket, "kill-server"], capture_output=True)
    os.kill(pid, signal.SIGTERM)
    time.sleep(2)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    summary = {
        "page": args.page,
        "whole_shm": len(seen["whole"]),
        "patch_shm": len(seen["patch"]),
        "inline_png_patches": seen["inline_png_patches"],
        "errors": seen["errors"][:5],
        "error_count": len(seen["errors"]),
        "examples": (seen["whole"][:1] + seen["patch"][:2]),
        "blue_pixels": 0, "red_or_green_pixels": 0,
    }
    # The smallpaint page never paints pure blue; seeing it means red and blue were not swapped.
    summary["blue_pixels"] = sum(d["colours"]["blue"] for d in seen["whole"] + seen["patch"])
    summary["red_or_green_pixels"] = sum(d["colours"]["red"] + d["colours"]["green"] for d in seen["whole"] + seen["patch"])
    if args.page == "smallpaint" and (summary["blue_pixels"] or not summary["red_or_green_pixels"]):
        summary["errors"].append("channel order: blue present or no red/green")
        summary["error_count"] += 1
    json.dump(summary, sys.stdout, indent=2)
    print()
    if summary["error_count"] or not (summary["whole_shm"] or summary["patch_shm"]):
        sys.exit(1)


if __name__ == "__main__":
    main()
