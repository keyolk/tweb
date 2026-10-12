#!/usr/bin/env python3
"""How a playing video reaches the pane, measured on both engines.

Opens bench/pages/video.html (a looping 30fps test pattern) in a bare PTY, like bench/feel.py,
and for a window of seconds counts the frames the engine sent to the terminal (from the
`TWEB_INPUT_TRACE` `frame` rows) and the CPU the engine's process tree spent. Then it resizes the
PTY — after a resize Chrome's screencast can arrive at CSS-pixel size only, which is drawn by
captures instead — and measures again.

  python3 bench/playback.py [--engine electron|chrome|both] [--seconds N] [--size ...]

The test video is generated with ffmpeg on first run (bench/pages/media is not committed).
"""

import argparse
import re
import select
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import feel  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
VIDEO = REPO / "bench" / "pages" / "media" / "testsrc.webm"


def ensure_video():
    if VIDEO.exists():
        return
    VIDEO.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi",
                    "-i", "testsrc2=size=1280x720:rate=30", "-t", "20",
                    "-c:v", "libvpx-vp9", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "8",
                    str(VIDEO)], check=True)


def tree(pid):
    """pid and every descendant, from one `ps` snapshot."""
    out = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True).stdout
    children = {}
    for line in out.split("\n"):
        parts = line.split()
        if len(parts) == 2:
            children.setdefault(int(parts[1]), []).append(int(parts[0]))
    found, stack = [], [pid]
    while stack:
        p = stack.pop()
        found.append(p)
        stack.extend(children.get(p, []))
    return found


def cpu_seconds(pids):
    """Total CPU time (user+sys) of these processes so far."""
    out = subprocess.run(["ps", "-o", "time=", "-p", ",".join(map(str, pids))],
                         capture_output=True, text=True).stdout
    total = 0.0
    for value in out.split():
        minutes, _, seconds = value.partition(":")
        total += int(minutes) * 60 + float(seconds)
    return total


def chrome_pids(user_data):
    """The engine Chrome is launched by the engine, not as its child: found by its profile dir."""
    out = subprocess.run(["pgrep", "-f", str(user_data)], capture_output=True, text=True).stdout
    return [int(p) for p in out.split()]


def window(pane, seconds):
    pids = sorted(set(tree(pane.pid)) | set(chrome_pids(pane.dir)))
    start_rows = len(pane.trace())
    cpu0, t0 = cpu_seconds(pids), time.time()
    time.sleep(seconds)
    elapsed = time.time() - t0
    cpu = cpu_seconds(pids) - cpu0
    rows = [r for r in pane.trace()[start_rows:] if r["step"] == "frame"]
    whole = sum(1 for r in rows if r.get("kind") == "whole")
    patch = len(rows) - whole
    code, out, _ = pane.agent("diag", "--json", timeout=5)
    size = None
    if code == 0:
        try:
            size = feel.json.loads(out)["frames"].get("lastSize")
        except (ValueError, KeyError):
            pass
    return {
        "fps": round(len(rows) / elapsed, 1),
        "whole": whole,
        "patch": patch,
        "cpu": round(100 * cpu / elapsed),
        "procs": len(pids),
        "size": f"{size['width']}x{size['height']}" if size else "?",
    }


class LoggedPane(feel.Pane):
    """A pane whose PTY text — the engine's stderr under TWEB_DEBUG — is kept, graphics stripped."""

    def _drain(self):
        log = open(self.dir / "pty.log", "wb")
        graphics = re.compile(rb"\x1b_G.*?\x1b\\", re.S)
        pending = b""
        while self.alive:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.2)
                if not ready:
                    continue
                chunk = os.read(self.fd, 1 << 20)
            except OSError:
                return
            if not chunk:
                return
            self.graphics += chunk.count(b"\x1b_G")
            pending += chunk
            cut = pending.rfind(b"\x1b_G")
            keep = pending[cut:] if cut >= 0 and b"\x1b\\" not in pending[cut:] else b""
            log.write(graphics.sub(b"", pending[:len(pending) - len(keep)]))
            log.flush()
            pending = keep


def resize(pane, cols, rows, width, height):
    feel.fcntl.ioctl(pane.fd, feel.termios.TIOCSWINSZ, feel.struct.pack("HHHH", rows, cols, width, height))
    try:
        feel.os.kill(pane.pid, feel.signal.SIGWINCH)
    except ProcessLookupError:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", default="both", choices=["electron", "chrome", "both"])
    parser.add_argument("--tweb", default=str(REPO / "target" / "release" / "tweb"))
    parser.add_argument("--seconds", type=float, default=8)
    parser.add_argument("--size", default="180x100@1440x1800")
    parser.add_argument("--resize", default="150x84@1200x1512", help="the size to resize to mid-play")
    parser.add_argument("--url", default=None)
    args = parser.parse_args()

    ensure_video()
    server, base = feel.serve_fixtures()
    url = args.url or f"{base}/video.html"

    def parse(spec):
        cells, pixels = spec.split("@")
        return tuple(int(v) for v in cells.split("x")) + tuple(int(v) for v in pixels.split("x"))

    engines = ["electron", "chrome"] if args.engine == "both" else [args.engine]
    for engine in engines:
        pane = LoggedPane(args.tweb, engine, url, feel.tempfile.gettempdir(), parse(args.size))
        try:
            if not pane.wait_ready():
                print(f"{engine:8} page never became ready", flush=True)
                continue
            time.sleep(2)  # the frame rate settles into its playback tier
            for label in ("start", "resized"):
                if label == "resized":
                    resize(pane, *parse(args.resize))
                    time.sleep(2)
                r = window(pane, args.seconds)
                print(f"{engine:8} {label:8} {r['size']:>10}  {r['fps']:5} frames/s "
                      f"(whole {r['whole']}, patch {r['patch']})  cpu {r['cpu']}% over {r['procs']} procs",
                      flush=True)
        finally:
            print(f"{engine:8} log {pane.dir / 'pty.log'}", flush=True)
            pane.close()
    server.shutdown()


if __name__ == "__main__":
    main()
