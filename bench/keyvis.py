#!/usr/bin/env python3
"""Key to visible change: how long after a key the terminal holds pixels that show it.

`feel.py` times a key to the next frame the engine writes. On a page that is already painting
(a spinner, a video beside a form) the next frame comes regardless of the key, so that number
says nothing about when the typed character is on screen. This harness looks at the pixels.

It runs `tweb open` on bench/pages/keyvis.html in a bare PTY and plays the terminal: it answers
the queries Ghostty answers, reads every whole frame and patch the engine sends (shm, file or
inline), and keeps the colour the terminal would show at one point — the centre of the page's
marker block. Each key turns that block the next colour of a fixed cycle, so the latency of a
key is its write to the PTY -> the first frame or patch that puts its colour at that point.

That is the engine's half. Ghostty's upload and draw come after it and are the same for any
engine, so they are left out, as is the display's own scan-out.

  python3 bench/keyvis.py [--busy none|corner|full] [--keys N] [--gap S] [--json OUT]

`TWEB_ELECTRON_DIR` picks the engine to measure, as for every bench here; `--tweb` the binary.
"""

import argparse
import base64
import fcntl
import functools
import http.server
import json
import mmap
import os
import pty
import re
import select
import socketserver
import statistics
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import zlib
from pathlib import Path

try:
    import _posixshmem
except ImportError:  # Linux builds without it fall back to /dev/shm
    _posixshmem = None

REPO = Path(__file__).resolve().parent.parent
COLS, ROWS, PX_W, PX_H = 360, 100, 2880, 1800
CELL_W, CELL_H = PX_W // COLS, PX_H // ROWS
# keyvis.html's #marker is 40,120 120x60 CSS px; at DPR 2 its centre is here. tweb renders at the
# display's scale factor with TWEB_DEFAULT_ZOOM=1, so one CSS px is two device px on a Retina Mac.
SAMPLE = (200, 300)
COLOURS = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (255, 0, 255), (0, 255, 255)]

QUERIES = [
    (re.compile(rb"\x1b\[0?c"), lambda m: b"\x1b[?62;22;52c"),
    (re.compile(rb"\x1b\[>0?c"), lambda m: b"\x1b[>1;10;0c"),
    (re.compile(rb"\x1b\[>0?q"), lambda m: b"\x1bP>|ghostty 1.4.0\x1b\\"),
    (re.compile(rb"\x1b\[14t"), lambda m: f"\x1b[4;{PX_H};{PX_W}t".encode()),
    (re.compile(rb"\x1b\[16t"), lambda m: f"\x1b[6;{CELL_H};{CELL_W}t".encode()),
    (re.compile(rb"\x1b\[18t"), lambda m: f"\x1b[8;{ROWS};{COLS}t".encode()),
    (re.compile(rb"\x1b\[\?u"), lambda m: b"\x1b[?0u"),
    (re.compile(rb"\x1b\[6n"), lambda m: b"\x1b[1;1R"),
    (re.compile(rb"\x1b\[\?(\d+)\$p"), lambda m: b"\x1b[?" + m.group(1) + b";2$y"),
    (re.compile(rb"\x1b\](1[01]);\?(\x07|\x1b\\)"), lambda m: b"\x1b]" + m.group(1) + b";rgb:2020/2020/2020\x1b\\"),
    (re.compile(rb"\x1bP\+q([0-9a-fA-F;]*)\x1b\\"), lambda m: b"\x1bP0+r\x1b\\"),
    (re.compile(rb"\x1b\[\?1004h"), lambda m: b"\x1b[I"),
]
# Graphics commands and absolute cursor moves, in stream order: an absolute patch is placed at
# the cursor, which the engine moves just before it.
STREAM = re.compile(rb"\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\|\x1b\[(\d+);(\d+)H", re.S)


def nearest(rgb):
    return min(range(len(COLOURS)), key=lambda i: sum((a - b) ** 2 for a, b in zip(rgb, COLOURS[i])))


class Terminal:
    """Plays the terminal for one PTY and remembers the colour shown at SAMPLE over time."""

    def __init__(self, fd):
        self.fd = fd
        self.buf = b""
        self.inline = {}
        self.cursor = (0, 0)  # 0-based col, row
        self.changes = []  # (monotonic time, rgb, kind)
        self.frames = {"whole": 0, "patch": 0, "covering_patch": 0}
        self.lock = threading.Lock()
        self.alive = True

    def write(self, data):
        os.write(self.fd, data)

    def pixel(self, medium, payload, keys, width, origin):
        """RGB at SAMPLE from one transmit, or None when it does not cover SAMPLE."""
        x, y = SAMPLE[0] - origin[0], SAMPLE[1] - origin[1]
        if not (0 <= x < width and 0 <= y < int(keys.get("v", "0") or 0)):
            return None
        offset = (y * width + x) * 4
        compressed = keys.get("o") == "z"
        if medium == "s":
            name = "/" + base64.b64decode(payload + b"==").decode(errors="replace").lstrip("/")
            try:
                fd = _posixshmem.shm_open(name, os.O_RDONLY, 0)
            except (OSError, AttributeError):
                return None
            try:
                size = os.fstat(fd).st_size
                with mmap.mmap(fd, size, prot=mmap.PROT_READ) as m:
                    px = m[offset:offset + 3]
            finally:
                os.close(fd)
            return tuple(px) if len(px) == 3 else None
        if medium in ("f", "t"):
            path = base64.b64decode(payload + b"==").decode(errors="replace")
            try:
                with open(path, "rb") as fh:
                    fh.seek(int(keys.get("O", "0") or 0))
                    data = fh.read()
            except OSError:
                return None
            if compressed:
                data = zlib.decompress(data)
            return tuple(data[offset:offset + 3]) if len(data) >= offset + 3 else None
        return None

    def unlink(self, medium, payload):
        # The terminal's job for t=s (and t=t): the engine counts on it.
        if medium == "s" and _posixshmem:
            name = "/" + base64.b64decode(payload + b"==").decode(errors="replace").lstrip("/")
            try:
                _posixshmem.shm_unlink(name)
            except OSError:
                pass
        elif medium == "t":
            try:
                os.unlink(base64.b64decode(payload + b"==").decode(errors="replace"))
            except OSError:
                pass

    def on_graphics(self, ctrl, payload):
        keys = dict(kv.split("=", 1) for kv in ctrl.split(",") if "=" in kv)
        action = keys.get("a", "t")
        ident = keys.get("i") or keys.get("I")
        if action == "q":
            self.write(f"\x1b_Gi={keys.get('i', '0')};OK\x1b\\".encode())
            return
        if ident and keys.get("q", "0") not in ("1", "2") and action in ("t", "T", "f", "p"):
            self.write(f"\x1b_Gi={ident};OK\x1b\\".encode())
        if action not in ("t", "T", "f"):
            return
        medium = keys.get("t", "d")
        if medium == "d":
            # Inline frames are PNG patches over tmux-less links; this harness reads raw ones only.
            self.inline.setdefault(ident or "_", []).append(payload)
            if keys.get("m") == "1":
                return
            self.inline.pop(ident or "_", None)
            return
        width = int(keys.get("s", "0") or 0)
        height = int(keys.get("v", "0") or 0)
        if keys.get("f", "32") != "32" or not width or not height:
            self.unlink(medium, payload)
            return
        whole = width == PX_W and height == PX_H
        if whole:
            origin = (0, 0)
        elif "H" in keys or "V" in keys:
            origin = (int(keys.get("H", "0")) * CELL_W, int(keys.get("V", "0")) * CELL_H)
        else:
            origin = (self.cursor[0] * CELL_W, self.cursor[1] * CELL_H)
        rgb = self.pixel(medium, payload, keys, width, origin)
        self.unlink(medium, payload)
        kind = "whole" if whole else "patch"
        with self.lock:
            self.frames[kind] += 1
            if rgb is not None:
                if not whole:
                    self.frames["covering_patch"] += 1
                self.changes.append((time.monotonic(), rgb, kind))

    def pump(self):
        while self.alive:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.05)
                if not ready:
                    continue
                chunk = os.read(self.fd, 1 << 20)
            except OSError:
                return
            if not chunk:
                return
            self.buf += chunk
            last = 0
            for m in STREAM.finditer(self.buf):
                if m.group(3):
                    self.cursor = (int(m.group(4)) - 1, int(m.group(3)) - 1)
                else:
                    self.on_graphics(m.group(1).decode(errors="replace"), m.group(2) or b"")
                last = m.end()
            text, rest = self.buf[:last], self.buf[last:]
            scan = STREAM.sub(b"", text) + rest
            for rx, reply in QUERIES:
                for m in rx.finditer(scan):
                    self.write(reply(m))
            open_at = rest.rfind(b"\x1b_G")
            self.buf = rest[open_at:] if open_at != -1 and b"\x1b\\" not in rest[open_at:] else b""

    def shown(self):
        with self.lock:
            return self.changes[-1] if self.changes else None


def serve(root):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    handler = functools.partial(Quiet, directory=str(root))
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--busy", choices=["none", "corner", "full"], default="none")
    parser.add_argument("--keys", type=int, default=30)
    parser.add_argument("--gap", type=float, default=0.15, help="seconds between keys")
    parser.add_argument("--tweb", default=str(Path.home() / ".local/bin/tweb"))
    parser.add_argument("--json")
    args = parser.parse_args()

    server = serve(REPO / "bench/pages")
    query = "" if args.busy == "none" else f"?busy={args.busy}"
    url = f"http://127.0.0.1:{server.server_address[1]}/keyvis.html{query}"
    work = Path(tempfile.mkdtemp(prefix="keyvis-", dir="/tmp"))
    env = {k: v for k, v in os.environ.items() if not k.startswith("TMUX")}
    env.update({
        "TERM": "xterm-ghostty", "TERM_PROGRAM": "ghostty", "TERM_PROGRAM_VERSION": "1.4.0",
        "COLORTERM": "truecolor", "TWEB_DAEMON": "0", "TWEB_SECOND_PANE": "1",
        "TWEB_DEFAULT_ZOOM": "1", "TWEB_USER_DATA_DIR": str(work / "u"),
        "TWEB_AGENT_SOCKET": str(work / "a.sock"),
    })
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(args.tweb, [args.tweb, "open", url], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, PX_W, PX_H))
    term = Terminal(fd)
    threading.Thread(target=term.pump, daemon=True).start()
    result = {"busy": args.busy, "engine": os.environ.get("TWEB_ELECTRON_DIR", "installed")}
    try:
        deadline = time.time() + 40
        while time.time() < deadline and term.frames["whole"] == 0:
            time.sleep(0.1)
        if term.frames["whole"] == 0:
            raise SystemExit("no whole frame within 40s")
        time.sleep(3)  # page loaded and focus settled
        latencies, misses, sent = [], 0, 0
        for index in range(args.keys + 1):
            want = index % len(COLOURS)
            before = len(term.changes)
            at = time.monotonic()
            term.write(b"abcdefghijklmnopqrstuvwxyz"[index % 26:index % 26 + 1])
            sent += 1
            seen = None
            while time.monotonic() - at < 1.5:
                with term.lock:
                    for t, rgb, kind in term.changes[before:]:
                        if nearest(rgb) == want and sum(abs(a - b) for a, b in zip(rgb, COLOURS[want])) < 120:
                            seen = (t, kind)
                            break
                if seen:
                    break
                time.sleep(0.002)
            # The first key proves the page has focus and the marker is where SAMPLE says.
            if index == 0:
                if not seen:
                    raise SystemExit(f"the first key never showed at {SAMPLE}: last={term.shown()}")
            elif seen:
                latencies.append((round((seen[0] - at) * 1000, 1), seen[1]))
            else:
                misses += 1
            time.sleep(args.gap)
        values = sorted(v for v, _ in latencies)

        def pct(q):
            return values[min(len(values) - 1, int(q * (len(values) - 1) + 0.5))] if values else None

        result.update({
            "keys": args.keys, "shown": len(values), "missed": misses,
            "p50_ms": pct(0.5), "p90_ms": pct(0.9), "max_ms": values[-1] if values else None,
            "mean_ms": round(statistics.mean(values), 1) if values else None,
            "via_patch": sum(1 for _, kind in latencies if kind == "patch"),
            "frames": dict(term.frames),
        })
    finally:
        term.alive = False
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
        subprocess.run(["pkill", "-f", str(work / "u")], capture_output=True)
        time.sleep(1)
        subprocess.run(["pkill", "-9", "-f", str(work / "u")], capture_output=True)
        subprocess.run(["rm", "-rf", str(work)])
        server.shutdown()
    print(json.dumps(result), flush=True)
    if args.json:
        with open(args.json, "a") as fh:
            fh.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
