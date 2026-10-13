#!/usr/bin/env python3
"""How a keypress feels, measured: `f` that shows nothing, and keys that lag.

Runs `tweb open` in a bare PTY — no tmux, so the pane is always visible and the key path is
the shipping one — writes real key bytes into it, and reads back what the engine did from the
`TWEB_INPUT_TRACE` file (see electron/input-trace.cjs). `tweb press` and `tweb eval` cannot do
this: press goes through `sendInputEvent`, not the preload, and eval holds the surface.

Per scenario and engine it reports p50/p95/max latency from the key's arrival to the step that
matters, and every failed attempt with the trace lines around it.

  f-open    `f`, then Escape.          ok = a round with targets drew; latency in->space
  f-pick    `f`, type the first label. ok = the pick ran; latency first label key -> pick
  f-rapid   `f` Escape `f` ... fast.   ok = every `f` drew; catches rounds that stay open
  j-scroll  `j`.                       latency in->first frame after it
  reload-f  reload, then `f` at once.  ok = it drew; catches the main frame not yet ready

Usage:
  python3 bench/feel.py [--engine electron|chrome|both] [--tweb PATH] [--runs N]
                        [--scenario NAME ...] [--url URL ...] [--json OUT]

Defaults to the fixtures in bench/pages served on localhost. `--url` adds real sites; they are
noisier, which is the point when a bug only shows on one of them.

The PTY is 2880x1800 pixels like DETAIL 8.x, because frame size is the PTY pixel size and a
smaller one makes every cost look negligible. The PTY must be drained continuously or the
engine blocks on its graphics writes — a thread does that and counts graphics escapes.
"""

import argparse
import fcntl
import functools
import http.server
import json
import os
import pty
import shutil
import select
import signal
import socketserver
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
COLS, ROWS, PX_W, PX_H = 360, 100, 2880, 1800
HINT_ALPHABET = "asdfghjklqwertyuiopzxcvbnm"  # electron/hint-labels.cjs


def first_label(total):
    """Label 0 of a round: the first letter, repeated to the round's width (hintLabel)."""
    width = 1
    while len(HINT_ALPHABET) ** width < max(1, total):
        width += 1
    return HINT_ALPHABET[0] * width


def serve_fixtures():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    handler = functools.partial(Quiet, directory=str(REPO / "bench" / "pages"))
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


class Pane:
    """One `tweb open` in its own PTY, its own user data, its own agent socket and trace."""

    def __init__(self, tweb, engine, url, workdir, size=(COLS, ROWS, PX_W, PX_H)):
        self.dir = Path(tempfile.mkdtemp(prefix=f"feel-{engine}-", dir=workdir))
        self.trace_path = self.dir / "trace.jsonl"
        # A unix socket path is capped at 104 bytes on macOS, and a scratch workdir is often longer.
        self.socket = tempfile.mktemp(prefix="feel-", suffix=".sock", dir="/tmp")
        self.tweb = tweb
        env = {k: v for k, v in os.environ.items() if not k.startswith("TMUX")}
        env.update({
            "TWEB_ASSUME_GRAPHICS": "1",   # the capability probe cannot answer from a bare PTY
            "TWEB_DAEMON": "0",            # this build's app code, not the installed daemon's
            "TWEB_USER_DATA_DIR": str(self.dir / "userData"),
            "TWEB_AGENT_SOCKET": self.socket,
            "TWEB_INPUT_TRACE": str(self.trace_path),
            "TERM": "xterm-ghostty",
        })
        args = [tweb, "open", url]
        if engine == "chrome":
            args[2:2] = ["--engine", "chrome"]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execve(tweb, args, env)
        cols, rows, width, height = size
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, width, height))
        self.graphics = 0
        self.alive = True
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        tail = b""
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
            data = tail + chunk
            self.graphics += data.count(b"\x1b_G")
            tail = data[-2:]

    def key(self, data):
        os.write(self.fd, data.encode() if isinstance(data, str) else data)

    def agent(self, *args, timeout=15):
        env = dict(os.environ, TWEB_AGENT_SOCKET=self.socket)
        out = subprocess.run([self.tweb, *args], env=env, capture_output=True, text=True, timeout=timeout)
        return out.returncode, out.stdout.strip(), out.stderr.strip()

    def trace(self):
        try:
            lines = self.trace_path.read_text().splitlines()
        except FileNotFoundError:
            return []
        rows = []
        for line in lines:
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
        return rows

    def wait_ready(self, timeout=40):
        deadline = time.time() + timeout
        while time.time() < deadline:
            # Loaded is not enough: a key sent before the preload registers reaches the engine and
            # goes nowhere, which reads as a lost key. `shortcutFrames` counts registered frames.
            code, out, _ = self.agent("eval", "document.readyState", timeout=5)
            if code == 0 and "complete" in out and self.shortcut_frames() > 0:
                time.sleep(0.3)  # first paints settle
                return True
            time.sleep(0.5)
        return False

    def shortcut_frames(self):
        code, out, _ = self.agent("diag", "--json", timeout=5)
        if code != 0:
            return 0
        try:
            return int(json.loads(out).get("input", {}).get("shortcutFrames") or 0)
        except ValueError:
            return 0

    def close(self):
        self.alive = False
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                done, _ = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                break
            if done:
                break
            time.sleep(0.1)
        else:
            os.kill(self.pid, signal.SIGKILL)
        os.close(self.fd)
        # Each pane leaves a Chrome profile and its frame files behind, tens of MB a run; a long
        # session of runs once filled the disk. TWEB_FEEL_KEEP=1 keeps them for a post-mortem.
        if not os.environ.get("TWEB_FEEL_KEEP"):
            shutil.rmtree(self.dir, ignore_errors=True)
            Path(self.socket).unlink(missing_ok=True)


def wait_for(pane, since, predicate, timeout):
    """The first trace row after index `since` satisfying predicate, or None."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = pane.trace()[since:]
        for row in rows:
            if predicate(row):
                return row
        time.sleep(0.01)
    return None


def last_in(rows, hex_byte):
    for row in reversed(rows):
        if row["step"] == "in" and hex_byte in row.get("hex", ""):
            return row
    return None


def attempt_f(pane, pick):
    """One `f`. Returns (ok, latency_ms, detail)."""
    start = len(pane.trace())
    pane.key("f")
    space = wait_for(pane, start, lambda r: r["step"] == "space" or (r["step"] == "round" and r.get("id") is None), 2.0)
    rows = pane.trace()[start:]
    arrived = last_in(rows, "66")
    if space is None or space["step"] == "round":
        pane.key("\x1b")
        time.sleep(0.15)
        why = "no frame was ready to ask" if space else "the round never closed"
        return False, None, {"why": why, "trace": rows}
    if not arrived:
        return False, None, {"why": "the key never reached the engine", "trace": rows}
    latency = space["t"] - arrived["t"]
    if space["total"] == 0:
        time.sleep(0.15)
        return False, latency, {"why": f"round closed with 0 targets ({space['answered']}/{space['asked']} frames answered)", "trace": rows}
    if not pick:
        mark = len(pane.trace())
        pane.key("\x1b")
        ended = wait_for(pane, mark, lambda r: r["step"] == "end", 1.0)
        if ended is None:
            return False, latency, {"why": "Escape did not end the round", "trace": pane.trace()[start:]}
        return True, latency, None
    # Every label in a round has the same width; type label 0 whole, as a user would.
    mark = len(pane.trace())
    pane.key(first_label(space["total"]))
    done = wait_for(pane, mark, lambda r: r["step"] in ("pick", "end"), 1.5)
    rows = pane.trace()[start:]
    if done is None:
        pane.key("\x1b")
        return False, None, {"why": "typing a label neither picked nor ended the round", "trace": rows}
    if done["step"] != "pick":
        return False, None, {"why": f"the round ended without a pick ({done.get('reason')})", "trace": rows}
    keyed = [r for r in rows if r["step"] == "hint-key"]
    first = keyed[0]["t"] if keyed else None
    if first is None:
        return False, None, {"why": "the label keys never reached the round", "trace": rows}
    # A pick usually navigates; give the page a moment before the next attempt.
    time.sleep(0.8)
    return True, done["t"] - first, None


def attempt_j(pane):
    start = len(pane.trace())
    pane.key("j")
    frame = wait_for(pane, start, lambda r: r["step"] == "frame", 1.0)
    rows = pane.trace()[start:]
    arrived = last_in(rows, "6a")
    if not arrived:
        return False, None, {"why": "the key never reached the engine", "trace": rows}
    if frame is None:
        return False, None, {"why": "no frame followed within 1s", "trace": rows}
    time.sleep(0.12)
    return True, frame["t"] - arrived["t"], None


def run_scenario(pane, scenario, runs, url):
    results = []
    for index in range(runs):
        if scenario == "f-open":
            outcome = attempt_f(pane, pick=False)
        elif scenario == "f-pick":
            outcome = attempt_f(pane, pick=True)
            # A pick on a link leaves the fixture; come back so every run starts alike.
            pane.agent("navigate", url, timeout=20)
            pane.wait_ready(20)
        elif scenario == "f-rapid":
            outcome = attempt_f(pane, pick=False)
            time.sleep(0.02)
        elif scenario == "j-scroll":
            outcome = attempt_j(pane)
            if index % 10 == 9:
                pane.key("gg")
                time.sleep(0.3)
        elif scenario == "reload-f":
            pane.agent("reload", timeout=20)
            time.sleep(0.05)
            outcome = attempt_f(pane, pick=False)
            pane.wait_ready(20)
        else:
            raise SystemExit(f"unknown scenario {scenario}")
        results.append(outcome)
        if scenario not in ("f-rapid",):
            time.sleep(0.25)
    return results


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(len(ordered) * q))], 1)


def summarise(results):
    latencies = [lat for ok, lat, _ in results if ok and lat is not None]
    failures = [detail for ok, _, detail in results if not ok]
    return {
        "runs": len(results),
        "failed": len(failures),
        "p50": percentile(latencies, 0.5),
        "p95": percentile(latencies, 0.95),
        "max": percentile(latencies, 1.0),
        "failures": failures,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", default="both", choices=["electron", "chrome", "both"])
    parser.add_argument("--tweb", default=str(REPO / "target" / "release" / "tweb"))
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--scenario", nargs="*", default=["f-open", "f-pick", "f-rapid", "j-scroll", "reload-f"])
    parser.add_argument("--url", nargs="*", default=None)
    parser.add_argument("--json", default=None)
    parser.add_argument("--workdir", default=None)
    parser.add_argument("--size", default=f"{COLS}x{ROWS}@{PX_W}x{PX_H}",
                        help="cols x rows @ pixel width x height, e.g. 180x100@1440x1800 for half a Retina screen")
    args = parser.parse_args()

    server, base = serve_fixtures()
    urls = args.url or [f"{base}/hints.html"]
    engines = ["electron", "chrome"] if args.engine == "both" else [args.engine]
    workdir = args.workdir or tempfile.gettempdir()
    report = []
    for engine in engines:
        for url in urls:
            cells, pixels = args.size.split("@")
            size = tuple(int(v) for v in cells.split("x")) + tuple(int(v) for v in pixels.split("x"))
            pane = Pane(args.tweb, engine, url, workdir, size)
            try:
                if not pane.wait_ready():
                    report.append({"engine": engine, "url": url, "error": "page never became ready"})
                    print(f"{engine:8} {url}: page never became ready", flush=True)
                    continue
                for scenario in args.scenario:
                    summary = summarise(run_scenario(pane, scenario, args.runs, url))
                    report.append({"engine": engine, "url": url, "scenario": scenario, **summary})
                    print(f"{engine:8} {scenario:9} {url.rsplit('/', 1)[-1][:28]:28} "
                          f"fail {summary['failed']:>2}/{summary['runs']:<3} "
                          f"p50 {summary['p50']}ms p95 {summary['p95']}ms max {summary['max']}ms", flush=True)
                    for failure in summary["failures"][:3]:
                        print(f"           ! {failure['why']}", flush=True)
            finally:
                pane.close()
    server.shutdown()
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=1))
    sys.exit(1 if any(entry.get("failed") or entry.get("error") for entry in report) else 0)


if __name__ == "__main__":
    main()
