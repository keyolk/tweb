#!/usr/bin/env python3
"""Drive a real engine through the visibility states DESIGN.md 6.5/7.7 gate on.

Not a unit test and not `tweb open`: it spawns the engine exactly as
`crates/tweb-pane/src/lib.rs` does — same argv, same env, stdin as the control
channel — and then *is* the frontend, pushing `VIS` lines to move the pane
between visible and hidden on demand. That is the only way to reach the hidden
state from an agent process, because the tmux client that decides visibility is
attached to somebody else's session and cannot be moved (and must not be).

stdout is a pipe here rather than the terminal, so Kitty graphics bytes are
counted instead of drawn. Counting them is the point: "0 frame transfers while a
static page is idle" is a statement about bytes on that channel, and a pipe is
the only place to weigh them.

Usage:
  python3 bench/gate-harness.py <scenario> [--url URL] [--seconds N]

Scenarios: idle, hidden, multitab, scroll, animation, reopen,
           multipane, resize, crash
"""

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ELECTRON_DIR = REPO / "electron"

# Same pane geometry the DETAIL.md 8.1/8.3 numbers were taken at, so the frame
# sizes here are comparable to the ones already recorded.
COLS, ROWS = 180, 50
CELL_W, CELL_H = 8, 18
PANE_W, PANE_H = COLS * CELL_W, ROWS * CELL_H

FAKE_PANE = "%9901"
FAKE_SESSION = "gate"
FAKE_WINDOW = "@990"
FAKE_TTY = "/dev/ttys999"


def electron_binary():
    local = ELECTRON_DIR / "node_modules" / "electron" / "dist" / "Electron.app" / "Contents" / "MacOS" / "Electron"
    if local.exists():
        return str(local)
    cache = Path.home() / ".cache" / "tweb"
    for entry in sorted(cache.glob("electron-*")):
        candidate = entry / "dist" / "Electron.app" / "Contents" / "MacOS" / "Electron"
        if candidate.exists():
            return str(candidate)
    raise SystemExit("no Electron runtime found")


def vis_line(visible):
    """A frontend visibility push. Hidden = the placement line with no clients,
    which is what `tmux list-clients` yields when no client shows this window."""
    payload = f"{FAKE_SESSION}\t{FAKE_WINDOW}\t{FAKE_PANE}"
    if visible:
        payload += f"\n{FAKE_TTY}\t{FAKE_SESSION}\t{FAKE_WINDOW}\t0\t{FAKE_PANE}\troot"
    return "VIS " + payload.encode().hex() + "\n"


class Engine:
    def __init__(self, url, frame_rate=None, adaptive=True):
        # The gate text says 60Hz; the shipping default cap is 30. `--frame-rate`
        # is what lets one run answer the gate as written and another answer it
        # as configured.
        frame_rate = int(frame_rate or os.environ.get("GATE_FRAME_RATE") or 30)
        self.dir = Path(tempfile.mkdtemp(prefix="tweb-gate-"))
        self.socket_path = str(self.dir / "a.sock")
        self.stdout_bytes = 0
        self._marks = []
        env = dict(os.environ)
        env.update({
            "TMUX_PANE": FAKE_PANE,
            "TWEB_FRONTEND_PID": str(os.getpid()),
            "TWEB_IMAGE_ID": str(os.getpid() % 60000 + 1000),
            "TWEB_RESTORE_SESSION": "0",
            "TWEB_URL": url,
            "TWEB_VIEWPORT": f"{COLS},{ROWS},{PANE_W},{PANE_H}",
            "TWEB_PANE_ORIGIN": "0,0",
            "TWEB_AGENT_SOCKET": self.socket_path,
            "TWEB_DEBUG": "1",
            # A userData of its own: the frame files land there and this run must
            # not share a frame path with a pane the user is actually watching.
            "TWEB_GATE_DATA": str(self.dir / "userData"),
        })
        # TMUX is deliberately cleared. The engine only shells out to tmux when
        # it thinks it is inside one, and the whole point here is that the
        # frontend (this process) pushes visibility instead.
        env.pop("TMUX", None)
        self.proc = subprocess.Popen(
            [electron_binary(), ".",
             "--tweb-frame-rate", str(frame_rate),
             "--tweb-adaptive-frame-rate", "1" if adaptive else "0",
             f"--user-data-dir={self.dir / 'userData'}",
             url],
            cwd=str(ELECTRON_DIR),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self._stop = threading.Event()
        self._reader = threading.Thread(target=self._drain_stdout, daemon=True)
        self._reader.start()
        self._errlines = []
        self._errthread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._errthread.start()

    def _drain_stdout(self):
        # os.read on the raw fd, not BufferedReader.read(n): the latter blocks
        # until it has all n bytes, so a slow trickle of graphics commands reads
        # as zero bytes for the whole window.
        fd = self.proc.stdout.fileno()
        while not self._stop.is_set():
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self.stdout_bytes += len(chunk)

    def _drain_stderr(self):
        for line in self.proc.stderr:
            self._errlines.append(line.decode("utf8", "replace").rstrip())

    def mark(self):
        """Byte counter snapshot. Frame transfers are measured as the delta."""
        return self.stdout_bytes

    def control(self, line):
        self.proc.stdin.write(line.encode())
        self.proc.stdin.flush()

    def visible(self, yes):
        self.control(vis_line(yes))

    def resize(self, cols, rows, width, height):
        self.control(f"RESIZE {cols} {rows} {width} {height} 0 0\n")

    def input_bytes(self, raw):
        self.control("INPUT " + raw.hex() + "\n")

    def rpc(self, method, params=None, timeout=20.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if os.path.exists(self.socket_path):
                break
            time.sleep(0.05)
        else:
            raise TimeoutError(f"agent socket never appeared at {self.socket_path}")
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(self.socket_path)
        s.sendall((json.dumps({"id": 1, "method": method,
                               "params": params or {}}) + "\n").encode())
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        s.close()
        reply = json.loads(buf.split(b"\n")[0])
        if "error" in reply and reply["error"]:
            raise RuntimeError(reply["error"])
        return reply.get("result")

    def errlines(self, pattern=None):
        lines = list(self._errlines)
        if pattern:
            rx = re.compile(pattern)
            lines = [l for l in lines if rx.search(l)]
        return lines

    def wait_ready(self, timeout=30.0):
        self.rpc("status", timeout=timeout)

    def pids(self):
        """The engine and every descendant. `pgrep -P` per level rather than a
        name match: the operator note records that a name match scores zero for a
        process ps reports as `(tmux)`."""
        found, frontier = [], [self.proc.pid]
        while frontier:
            pid = frontier.pop()
            found.append(pid)
            out = subprocess.run(["pgrep", "-P", str(pid)],
                                 capture_output=True, text=True).stdout.split()
            frontier.extend(int(p) for p in out)
        return found

    def memory(self):
        """RSS per process plus the gpu process's phys_footprint, which is the
        number surface-policy.cjs was written against."""
        pids = self.pids()
        rows = []
        for pid in pids:
            out = subprocess.run(["ps", "-o", "rss=,command=", "-p", str(pid)],
                                 capture_output=True, text=True).stdout.strip()
            if not out:
                continue
            rss_kb, _, cmd = out.partition(" ")
            try:
                rss_kb = int(rss_kb)
            except ValueError:
                continue
            kind = "gpu" if "--type=gpu-process" in cmd else \
                   "renderer" if "--type=renderer" in cmd else \
                   "utility" if "--type=utility" in cmd else "main"
            rows.append({"pid": pid, "kind": kind, "rss_mb": round(rss_kb / 1024, 1),
                         "footprint_mb": footprint_mb(pid),
                         "iosurface_mb": iosurface_mb(pid)})
        return rows

    def close(self):
        self._stop.set()
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.send_signal(signal.SIGTERM)
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        shutil.rmtree(self.dir, ignore_errors=True)


def footprint_mb(pid):
    """phys_footprint via footprint(1). The surface-policy.cjs comment's numbers
    are footprints, so RSS alone cannot be compared against them.

    The header line is `<name> [pid]: 64-bit    Footprint: 1760 KB` — not the
    `phys_footprint:` key vmmap uses, which is why this parses the header."""
    if not shutil.which("footprint"):
        return None
    out = subprocess.run(["footprint", "-p", str(pid)],
                         capture_output=True, text=True).stdout
    m = re.search(r"Footprint:\s*([\d,.]+)\s*([KMG])B", out)
    if not m:
        return None
    scale = {"K": 1 / 1024, "M": 1.0, "G": 1024.0}[m.group(2)]
    return round(float(m.group(1).replace(",", "")) * scale, 1)


def iosurface_mb(pid):
    """IOSurface bytes, which is where an offscreen compositor surface lives and
    exactly what DESIGN.md 6.5 lists as its own budget line. RSS does not
    separate it; footprint(1) does, by category."""
    if not shutil.which("footprint"):
        return None
    out = subprocess.run(["footprint", "-p", str(pid)],
                         capture_output=True, text=True).stdout
    total_mb = 0.0
    found = False
    for line in out.splitlines():
        if "IOSurface" not in line:
            continue
        m = re.match(r"\s*([\d,.]+)\s*([KMG]?)B?\s", line)
        if not m:
            continue
        found = True
        scale = {"K": 1 / 1024, "M": 1.0, "G": 1024.0, "": 1 / (1024 * 1024)}[m.group(2)]
        total_mb += float(m.group(1).replace(",", "")) * scale
    return round(total_mb, 1) if found else None


def total(rows, key="rss_mb"):
    return round(sum(r[key] or 0 for r in rows), 1)


def gpu_row(rows):
    return next((r for r in rows if r["kind"] == "gpu"), None)


def summary(rows):
    """One line per state, in the terms the gates are phrased in. The gpu process
    is kept separate because that is where the compositor surface sits, and
    IOSurface is broken out because 6.5 budgets it on its own line."""
    return {
        "rss_total_mb": total(rows),
        "footprint_total_mb": total(rows, "footprint_mb"),
        "iosurface_total_mb": total(rows, "iosurface_mb"),
        "process_count": len(rows),
        "renderers": sum(1 for r in rows if r["kind"] == "renderer"),
        "gpu": gpu_row(rows),
    }


def emit(name, obj):
    print(f"### {name}")
    print(json.dumps(obj, indent=2, sort_keys=True))
    print()


def diag_frames(engine):
    d = engine.rpc("diag")
    return d


# --- scenarios ---------------------------------------------------------------

def scenario_idle(url, seconds):
    """7.7: '0 frame transfers while a static page is idle'. Measured as bytes
    on the graphics channel over a window in which nothing touches the page."""
    e = Engine(url)
    try:
        e.wait_ready()
        e.visible(True)
        time.sleep(3)  # let the load settle; the load itself of course paints
        before = e.mark()
        d0 = diag_frames(e)
        time.sleep(seconds)
        after = e.mark()
        d1 = diag_frames(e)
        emit("idle", {
            "window_s": seconds,
            "stdout_bytes_during_window": after - before,
            "whole_frames_delta": d1["frames"]["whole"] - d0["frames"]["whole"],
            "patch_frames_delta": d1["frames"]["patches"] - d0["frames"]["patches"],
            "rate_kind": d1["frames"]["rateKind"],
            "rate": d1["frames"]["rate"],
            "tiers": d1["frames"]["tiers"],
            "dropped": d1["frames"]["droppedByBackpressure"],
        })
    finally:
        e.close()


def scenario_hidden(url, seconds):
    """6.5 'a hidden page's GPU/SHM surface bytes converge to 0' and 7.7 '0 frame
    production in a hidden tmux window'."""
    e = Engine(url)
    try:
        e.wait_ready()
        e.visible(True)
        time.sleep(3)
        vis_mem = e.memory()
        vis_diag = diag_frames(e)
        e.visible(False)
        time.sleep(2)  # the collapse plus one reconcile tick
        hid_mem = e.memory()
        hid_diag = diag_frames(e)
        before = e.mark()
        d0 = diag_frames(e)
        time.sleep(seconds)
        after = e.mark()
        d1 = diag_frames(e)
        e.visible(True)
        time.sleep(2)
        re_mem = e.memory()
        re_diag = diag_frames(e)
        emit("hidden", {
            "visible": {"size": vis_diag["window"]["contentSize"], **summary(vis_mem)},
            "hidden": {"size": hid_diag["window"]["contentSize"], **summary(hid_mem),
                       "rate_kind": hid_diag["frames"]["rateKind"],
                       "rate": hid_diag["frames"]["rate"]},
            "hidden_window_s": seconds,
            "hidden_stdout_bytes": after - before,
            "hidden_whole_delta": d1["frames"]["whole"] - d0["frames"]["whole"],
            "hidden_patch_delta": d1["frames"]["patches"] - d0["frames"]["patches"],
            "reopened": {"size": re_diag["window"]["contentSize"], **summary(re_mem),
                         "last_frame_size": re_diag["frames"]["lastSize"],
                         "expected": re_diag["frames"]["expected"]},
        })
    finally:
        e.close()


def scenario_multitab(url, seconds):
    """6.5 'after a page close ... resource counts and private bytes return to
    baseline'. Opens tabs, measures, closes them, measures again."""
    e = Engine(url)
    try:
        e.wait_ready()
        e.visible(True)
        time.sleep(3)
        base_mem, base_diag = e.memory(), diag_frames(e)
        for _ in range(3):
            e.rpc("tab-new", {"url": url})
            time.sleep(2)
        open_mem, open_diag = e.memory(), diag_frames(e)
        tabs = e.rpc("tabs")
        # Close back down to one. Tab indices shift, so always close the last.
        while True:
            listing = e.rpc("tabs")
            items = listing if isinstance(listing, list) else listing.get("tabs", [])
            if len(items) <= 1:
                break
            e.rpc("tab-close", {"index": len(items) - 1})
            time.sleep(1)
        time.sleep(seconds)  # let Chromium reap the renderers
        closed_mem, closed_diag = e.memory(), diag_frames(e)
        emit("multitab", {
            "baseline": {**summary(base_mem), "tabs": base_diag["tabs"]},
            "three_extra_tabs": {**summary(open_mem), "tabs": open_diag["tabs"]},
            "after_close": {**summary(closed_mem), "tabs": closed_diag["tabs"]},
            "settle_s": seconds,
            "tabs_listing_sample": tabs,
        })
    finally:
        e.close()


def scenario_scroll(url, seconds):
    """7.7 'sustainable frame pacing at 60Hz during a 1080p continuous scroll'
    and 'queue depth never exceeding the surface ring size' (droppedByBackpressure
    is the one-deep queue's overflow counter)."""
    e = Engine(url)
    try:
        e.wait_ready()
        e.visible(True)
        time.sleep(3)
        # A document tall enough that 15s of wheel never reaches the bottom.
        # Without this the fixture bottoms out after about a second and the rest
        # of the window measures an idle page — which reads as a pacing failure
        # when it is only a short page.
        e.rpc("eval", {"script": "document.body.style.minHeight='400000px';"
                                 "window.scrollTo(0,0);1"})
        time.sleep(1)
        # The control for the whole scenario: if scrollY does not move, the frame
        # count below is measuring an idle page and says nothing about pacing.
        y0 = e.rpc("eval", {"script": "window.scrollY"}).get("value")
        d0 = diag_frames(e)
        b0 = e.mark()
        t0 = time.time()
        # Scroll wheel events through the raw input channel: SGR mouse wheel-down
        # at the pane centre, which is what a terminal sends.
        wheel = f"\x1b[<65;{COLS // 2};{ROWS // 2}M".encode()
        end = t0 + seconds
        sent = 0
        while time.time() < end:
            e.input_bytes(wheel)
            sent += 1
            time.sleep(1 / 60)
        elapsed = time.time() - t0
        time.sleep(0.5)
        y1 = e.rpc("eval", {"script": "window.scrollY"}).get("value")
        d1 = diag_frames(e)
        b1 = e.mark()
        # Every reason a paint can fail to reach the terminal, counted from the
        # engine's own log. Without this the frame count says a rate but not why.
        dropped_log = e.errlines(r"frame dropped")
        emit("scroll", {
            "seconds": round(elapsed, 2),
            "wheel_events_sent": sent,
            "scroll_y_before": y0,
            "scroll_y_after": y1,
            "whole_delta": d1["frames"]["whole"] - d0["frames"]["whole"],
            "patch_delta": d1["frames"]["patches"] - d0["frames"]["patches"],
            "frames_per_s": round((d1["frames"]["whole"] - d0["frames"]["whole"]
                                   + d1["frames"]["patches"] - d0["frames"]["patches"]) / elapsed, 2),
            "dropped_delta": d1["frames"]["droppedByBackpressure"] - d0["frames"]["droppedByBackpressure"],
            "dropped_total": d1["frames"]["droppedByBackpressure"],
            "stdout_bytes": b1 - b0,
            "rate_kind": d1["frames"]["rateKind"],
            "rate": d1["frames"]["rate"],
            "whole_format": d1["frames"]["wholeFormat"],
            "size_mismatch_drops": len(dropped_log),
            "size_mismatch_sample": dropped_log[:3],
            "frame_sent_log": len(e.errlines(r"frame sent")),
        })
    finally:
        e.close()


def scenario_animation(url, seconds):
    """7.7 '0 stale images, surfaces or shared-memory objects after 10 minutes of
    animation/video'. Counts the frame files left on disk and the live patch
    placements, which are the two things that can accumulate."""
    e = Engine(url)
    try:
        e.wait_ready()
        e.visible(True)
        time.sleep(3)
        d0 = diag_frames(e)
        t0 = time.time()
        samples = []
        while time.time() - t0 < seconds:
            time.sleep(min(15, seconds / 6))
            d = diag_frames(e)
            files = list((e.dir / "userData").glob("tweb-frame-*"))
            samples.append({
                "t_s": round(time.time() - t0, 1),
                "whole": d["frames"]["whole"],
                "patches": d["frames"]["patches"],
                "patches_placed": d["frames"]["patchesPlaced"],
                "dropped": d["frames"]["droppedByBackpressure"],
                "frame_files": len(files),
                "frame_bytes": sum(f.stat().st_size for f in files if f.exists()),
                "rate_kind": d["frames"]["rateKind"],
                "rss_mb": total(e.memory()),
            })
        emit("animation", {"seconds": seconds, "start": d0["frames"], "samples": samples})
    finally:
        e.close()


def scenario_reopen(url, seconds):
    """The collapse/restore cycle, repeated. A leak in the restore path shows as
    a footprint that climbs cycle over cycle rather than returning."""
    e = Engine(url)
    try:
        e.wait_ready()
        e.visible(True)
        time.sleep(3)
        cycles = []
        for i in range(5):
            e.visible(False)
            time.sleep(1.5)
            hid = e.memory()
            hid_d = diag_frames(e)
            e.visible(True)
            time.sleep(1.5)
            vis = e.memory()
            vis_d = diag_frames(e)
            cycles.append({
                "cycle": i,
                "hidden": {"size": hid_d["window"]["contentSize"], **summary(hid)},
                "visible": {"size": vis_d["window"]["contentSize"], **summary(vis)},
                "visible_last_frame": vis_d["frames"]["lastSize"],
                "expected": vis_d["frames"]["expected"],
                "whole": vis_d["frames"]["whole"],
                "patches_placed": vis_d["frames"]["patchesPlaced"],
            })
        emit("reopen", {"cycles": cycles})
    finally:
        e.close()



def scenario_multipane(url, seconds):
    """7.7 'no unbounded memory growth with two visible browser panes' and 6.5
    'the browser runtime/Node/V8 are not duplicated in proportion to the pane
    count'. Two engines at once is the only way to read either: the second
    instance's cost against the first is the duplication, and the drift over the
    window is the growth."""
    a = Engine(url)
    b = None
    try:
        a.wait_ready()
        a.visible(True)
        time.sleep(3)
        one = summary(a.memory())
        b = Engine(url)
        b.wait_ready()
        b.visible(True)
        time.sleep(3)
        two_a, two_b = summary(a.memory()), summary(b.memory())
        d0a, d0b = diag_frames(a), diag_frames(b)
        time.sleep(seconds)
        end_a, end_b = summary(a.memory()), summary(b.memory())
        d1a, d1b = diag_frames(a), diag_frames(b)
        emit("multipane", {
            "one_pane": one,
            "two_panes": {"pane_a": two_a, "pane_b": two_b,
                          "combined_rss_mb": round(two_a["rss_total_mb"] + two_b["rss_total_mb"], 1),
                          "combined_procs": two_a["process_count"] + two_b["process_count"]},
            "second_pane_marginal_rss_mb": round(two_b["rss_total_mb"], 1),
            "window_s": seconds,
            "after_window": {"pane_a": end_a, "pane_b": end_b,
                             "combined_rss_mb": round(end_a["rss_total_mb"] + end_b["rss_total_mb"], 1)},
            "growth_rss_mb": round(end_a["rss_total_mb"] + end_b["rss_total_mb"]
                                   - two_a["rss_total_mb"] - two_b["rss_total_mb"], 1),
            "frames_a": {"whole": d1a["frames"]["whole"] - d0a["frames"]["whole"],
                         "dropped": d1a["frames"]["droppedByBackpressure"]},
            "frames_b": {"whole": d1b["frames"]["whole"] - d0b["frames"]["whole"],
                         "dropped": d1b["frames"]["droppedByBackpressure"]},
            "distinct_image_ids": [d1a["frames"]["imageId"], d1b["frames"]["imageId"]],
        })
    finally:
        if b:
            b.close()
        a.close()


def scenario_resize(url, seconds):
    """7.7 'only the new generation displayed within 2 display frames after a
    resize'. The engine drops any frame whose size does not match the current
    viewport (`frame dropped got= want=`), so the gate is measured as: how long
    until a frame at the NEW size is sent, and does anything at the old size get
    through after the bump."""
    e = Engine(url)
    try:
        e.wait_ready()
        e.visible(True)
        time.sleep(3)
        results = []
        sizes = [(160, 44), (180, 50), (120, 30), (180, 50)]
        for cols, rows in sizes:
            before = diag_frames(e)
            t0 = time.time()
            e.resize(cols, rows, cols * CELL_W, rows * CELL_H)
            deadline = t0 + 5
            settled = None
            while time.time() < deadline:
                d = diag_frames(e)
                last, want = d["frames"]["lastSize"], d["frames"]["expected"]
                if (d["frames"]["generation"] != before["frames"]["generation"]
                        and last and want and last == want):
                    settled = d
                    break
                time.sleep(0.02)
            elapsed_ms = round((time.time() - t0) * 1000, 1)
            results.append({
                "cols_rows": [cols, rows],
                "generation_before": before["frames"]["generation"],
                "generation_after": (settled or diag_frames(e))["frames"]["generation"],
                "settled": settled is not None,
                "ms_to_new_generation_frame": elapsed_ms,
                "display_frames_at_60hz": round(elapsed_ms / 16.67, 2),
                "last_size": (settled or diag_frames(e))["frames"]["lastSize"],
                "expected": (settled or diag_frames(e))["frames"]["expected"],
            })
            time.sleep(1)
        emit("resize", {
            "steps": results,
            # A dropped frame here is the mechanism working, not a fault: it is
            # the old generation being refused. Counted so the gate's "only the
            # new generation displayed" half has evidence rather than assertion.
            "stale_generation_frames_refused": len(e.errlines(r"frame dropped")),
            "refused_sample": e.errlines(r"frame dropped")[:4],
        })
    finally:
        e.close()


def scenario_crash(url, seconds):
    """6.5 'after a page close, a renderer crash or a client detach, resource
    counts and private bytes return to baseline'. The renderer is killed outright
    and the pane is measured on the way back."""
    e = Engine(url)
    try:
        e.wait_ready()
        e.visible(True)
        time.sleep(3)
        base = summary(e.memory())
        renderers = [r for r in e.memory() if r["kind"] == "renderer"]
        killed = []
        for r in renderers:
            try:
                os.kill(r["pid"], signal.SIGKILL)
                killed.append(r["pid"])
            except ProcessLookupError:
                pass
        time.sleep(seconds)
        after = summary(e.memory())
        # Three separate questions, because they have different answers: is the
        # engine still answering at all (`diag` never reaches the renderer), does
        # the page respond, and does an explicit reload bring it back.
        diag, page, after_reload = None, None, None
        try:
            diag = diag_frames(e)
        except Exception as error:
            diag = f"engine unreachable: {error}"
        try:
            page = e.rpc("eval", {"script": "document.body ? 1 : 0"}, timeout=8).get("value")
        except Exception as error:
            page = f"page unreachable: {error}"
        try:
            e.rpc("reload", timeout=8)
            time.sleep(5)
            after_reload = e.rpc("eval", {"script": "document.body ? 1 : 0"},
                                 timeout=8).get("value")
        except Exception as error:
            after_reload = f"still unreachable after reload: {error}"
        recovered = page
        procs_after_reload = summary(e.memory())
        emit("crash", {
            "killed_renderer_pids": killed,
            "baseline": base,
            "after_kill": after,
            "settle_s": seconds,
            "rss_delta_mb": round(after["rss_total_mb"] - base["rss_total_mb"], 1),
            "page_reachable_after": recovered,
            "page_reachable_after_explicit_reload": after_reload,
            "after_reload": procs_after_reload,
            "frames_after": diag["frames"] if isinstance(diag, dict) else diag,
            "crash_log": e.errlines(r"crash|render-process-gone|unresponsive")[:5],
        })
    finally:
        e.close()


SCENARIOS = {
    "idle": scenario_idle,
    "hidden": scenario_hidden,
    "multitab": scenario_multitab,
    "scroll": scenario_scroll,
    "animation": scenario_animation,
    "reopen": scenario_reopen,
    "multipane": scenario_multipane,
    "resize": scenario_resize,
    "crash": scenario_crash,
}


def main():
    args = sys.argv[1:]
    if not args or args[0] not in SCENARIOS:
        raise SystemExit(f"usage: {sys.argv[0]} <{'|'.join(SCENARIOS)}> [--url U] [--seconds N]")
    name = args[0]
    url = f"file://{REPO}/bench/pages/mixed.html"
    seconds = 10
    for i, a in enumerate(args):
        if a == "--url":
            url = args[i + 1]
        if a == "--seconds":
            seconds = float(args[i + 1])
        if a == "--frame-rate":
            os.environ["GATE_FRAME_RATE"] = args[i + 1]
    SCENARIOS[name](url, seconds)


if __name__ == "__main__":
    main()
