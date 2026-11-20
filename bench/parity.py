#!/usr/bin/env python3
"""The same input on every engine, judged the same way.

tweb drives Electron, Chrome and WebKit tabs through one main.cjs, and a fix written and checked on
one engine can still be wrong on another: Electron's frame box routing ran on Chrome too and sent
every click on claude.ai's share menu into the iframe under it (#278). This runs each scenario on
each engine and prints one verdict per pair, so a change that holds on one engine only shows up.

Each scenario writes real mouse bytes into the pane (`tmux send-keys`, the path a terminal's
mouse report takes) and reads back what the page saw from a log the fixture keeps. `tweb click`
is no substitute: it targets an element, so it never asks which frame is under a point.

  popover       click a button the parent draws over a cross-site iframe.
                ok = the button got the click and the frame got no pointer event
  frame-click   click the iframe beside the popover. ok = the frame got pointerdown and pointerup
  frame-drag    press in the iframe, move, release there.
                ok = the frame got the press, the moves with the button held, and the release
  page-drag     the same drag on the parent's header, no frame involved
  zoom-out-click / zoom-in-click
                the pane zoomed two steps away from the default, then four clicks on the parent's
                Share button. ok = every press and release landed on the button at the same point
                and the button took each click. Chrome read mouse coordinates at its own scale or
                the zoomed tab's from one event to the next, so a release could land at 1/1.44 of
                the press and no click happened (`zoomLayout` in electron/cdp/engine.cjs)
  canvas-hints  `f` on canvas-targets.html, three nodes drawn on one <canvas> that answers tweb's
                `tweb:targets` event. ok = the page was asked, a badge sits on each node, typing
                node b's label clicks node b and node c's double-clicks node c

A pane runs in a private tmux server with a pixel-sized client attached (feel.py's `Pane`), so it
is visible and its input takes the shipping path. A new scenario is a function in SCENARIOS that
returns (ok, detail); add one with each engine-specific input or frame fix.

Usage:
  python3 bench/parity.py [--engine electron|chrome|webkit|both|all] [--tweb PATH] [--runs N]
                          [--scenario NAME ...]

Set TWEB_ELECTRON_DIR=$PWD/electron to run this checkout's app code with an installed tweb.
Exits non-zero when any scenario fails on any engine, KNOWN_GAPS excepted.
"""

import argparse
import json
import subprocess
import sys
import tempfile
import time

from feel import REPO, Pane, reap_orphan_chromes, serve_fixtures

SIZE = (160, 50, 1280, 800)

# A failure that is already understood and tracked, reported as "known" instead of failing the run.
# Each entry says what happens, so the day it changes is noticed too.
KNOWN_GAPS = {}


class Page:
    """The pane's page in terms of terminal cells, and its event log."""

    def __init__(self, pane):
        self.pane = pane
        self.measure()

    def measure(self):
        """CSS pixels per cell, which a zoom changes."""
        view = self.eval("[innerWidth, innerHeight]")
        self.col_px = view[0] / SIZE[0]
        self.row_px = view[1] / SIZE[1]

    def eval(self, script):
        code, out, err = self.pane.agent("eval", f"JSON.stringify({script})", timeout=10)
        if code != 0:
            raise RuntimeError(f"eval failed: {err or out}")
        value = json.loads(out)
        return json.loads(value) if isinstance(value, str) else value

    def rect(self, selector):
        return self.eval(f"(() => {{ const r = document.querySelector({json.dumps(selector)})"
                         ".getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")

    def cell(self, x, y):
        """The 1-based cell whose area holds CSS point (x, y): the page fills the pane."""
        return int(x / self.col_px) + 1, int(y / self.row_px) + 1

    def mouse(self, button, col, row, release=False):
        """One SGR mouse report: 0 = left press, 32 = left-held motion, 35 = motion, no button."""
        report = f"\x1b[<{button};{col};{row}{'m' if release else 'M'}"
        subprocess.run(["tmux", "-L", self.pane.tmux, "send-keys", "-t", "feel", "-l", report], check=True)

    def click(self, col, row):
        self.mouse(35, col, row)
        time.sleep(0.2)
        self.mouse(0, col, row)
        time.sleep(0.08)
        self.mouse(0, col, row, release=True)

    def log(self):
        return self.eval("__log")

    def settle(self, done, timeout=2.0):
        """The log once `done(log)` holds, or as it stands at the timeout."""
        deadline = time.time() + timeout
        while True:
            log = self.log()
            if done(log) or time.time() > deadline:
                return log
            time.sleep(0.1)


def frame_point(page):
    """A point inside the iframe, clear of the popover: its lower left."""
    x, y, width, height = page.rect("#frame")
    return page.cell(x + min(80, width / 4), y + height * 0.7)


def popover(page):
    x, y, width, height = page.rect("#inside")
    page.click(*page.cell(x + width / 2, y + height / 2))
    log = page.settle(lambda log: "inside" in log)
    stray = [entry for entry in log if entry.startswith("child:pointer")]
    return "inside" in log and not stray, log


def frame_click(page):
    page.click(*frame_point(page))
    log = page.settle(lambda log: any(entry.startswith("child:pointerup") for entry in log))
    down = any(entry.startswith("child:pointerdown") for entry in log)
    up = any(entry.startswith("child:pointerup") for entry in log)
    return down and up and "inside" not in log, log


def drag(page, col, row, down=True):
    """Press at (col, row), eight held moves right (and down), release 16 columns on.

    `down=False` keeps the drag on one row, for a target only a few rows tall."""
    page.mouse(35, col, row)
    time.sleep(0.2)
    page.mouse(0, col, row)
    time.sleep(0.08)
    for step in range(1, 9):
        page.mouse(32, col + step * 2, row + (step // 2 if down else 0))
        time.sleep(0.03)
    page.mouse(0, col + 16, row + (4 if down else 0), release=True)


def dragged(page, prefix):
    """Whether the log shows a press, held moves and a release, each under `prefix`."""
    log = page.settle(lambda log: any(entry.startswith(prefix + "pointerup") for entry in log))
    down = any(entry.startswith(prefix + "pointerdown") for entry in log)
    ups = [entry for entry in log if entry.startswith(prefix + "pointerup")]
    held = bool(ups) and not ups[-1].startswith(prefix + "pointerup moves=0 ")
    return down and held, log


def frame_drag(page):
    drag(page, *frame_point(page))
    return dragged(page, "child:")


def page_drag(page):
    """The same drag on the parent's header, with no frame involved: tells a frame gap from a drag gap."""
    x, y, width, height = page.rect("header")
    drag(page, *page.cell(x + width * 0.3, y + height / 2), down=False)
    return dragged(page, "")


def zoom_steps(page, steps):
    """Ctrl-wheel `steps` notches (positive zooms out) over the page, then re-measure its cells."""
    code = 81 if steps > 0 else 80
    for _ in range(abs(steps)):
        page.mouse(code, SIZE[0] // 2, SIZE[1] // 2)
        time.sleep(0.6)
    time.sleep(1.0)
    page.measure()


def zoomed_click(steps):
    def scenario(page):
        zoom_steps(page, steps)
        try:
            x, y, width, height = page.rect("#share")
            inside = lambda px, py: x - 1 <= px <= x + width + 1 and y - 1 <= py <= y + height + 1
            results = []
            for _ in range(4):
                # Counted on the button itself: the fixture's `status` is `window.status`, not its span.
                page.eval("(() => { __log.length = 0; if (!window.__shareClicks) { window.__shareClicks = [0];"
                          " share.addEventListener('click', () => __shareClicks[0]++); } __shareClicks[0] = 0;"
                          " return 1; })()")
                page.click(*page.cell(x + width / 2, y + height / 2))
                log = page.settle(lambda log: any(entry.startswith("pointerup") for entry in log))
                points = [tuple(map(int, entry.rsplit(" ", 1)[1].split(","))) for entry in log
                          if entry.startswith(("pointerdown", "pointerup"))]
                clicked = page.eval("__shareClicks[0] === 1")
                ok = clicked and len(points) == 2 and points[0] == points[1] and inside(*points[0])
                results.append((ok, points, clicked))
            return all(ok for ok, _, _ in results), [r[1:] for r in results]
        finally:
            zoom_steps(page, -steps)
    return scenario


def badges(page):
    """The labels of the `f` round now on screen, each with its top-left: the picker is an open shadow root."""
    return page.eval("(() => { const h = document.getElementById('__tweb_picker__');"
                     " if (!h || !h.shadowRoot) return [];"
                     " return [...h.shadowRoot.children].map((b) => [b.textContent,"
                     " parseFloat(b.style.left), parseFloat(b.style.top)]); })()")


def type_keys(page, text):
    subprocess.run(["tmux", "-L", page.pane.tmux, "send-keys", "-t", "feel", "-l", text], check=True)


def canvas_hints(page):
    """Each node a badge, and a pick reaching the node: page-declared targets on a canvas."""
    page.eval("(() => { window.__asked = 0; return 1; })()")
    canvas_box = page.rect("#cv")
    nodes = page.eval("nodes.map((n) => [n.name, n.x - n.r, n.y - n.r])")
    detail = {}
    for name, want in (("b", "click:b"), ("c", "dblclick:c")):
        page.eval("(() => { __log.length = 0; return 1; })()")
        type_keys(page, "f")
        deadline = time.time() + 3
        shown = []
        while time.time() < deadline and not shown:
            time.sleep(0.2)
            shown = badges(page)
        # The badge drawn at a node's box corner is that node's.
        corners = {n: (canvas_box[0] + x, canvas_box[1] + y) for n, x, y in nodes}
        on_node = {n: next((label for label, left, top in shown
                            if abs(left - cx) <= 2 and abs(top - cy) <= 2), None)
                   for n, (cx, cy) in corners.items()}
        detail[name] = {"badges": len(shown), "on_node": on_node}
        if not on_node.get(name):
            type_keys(page, "\x1b")
            return False, detail
        type_keys(page, on_node[name])
        log = page.settle(lambda log: want in log)
        detail[name]["log"] = log
        if want not in log or not all(on_node.values()):
            return False, detail
    detail["asked"] = page.eval("window.__asked")
    return detail["asked"] >= 2, detail


SCENARIOS = {"popover": popover, "frame-click": frame_click, "frame-drag": frame_drag, "page-drag": page_drag,
             "zoom-out-click": zoomed_click(2), "zoom-in-click": zoomed_click(-2), "canvas-hints": canvas_hints}
# The fixture each scenario runs on, when not the frame overlay.
FIXTURES = {"canvas-hints": "canvas-targets.html"}


def prepare(page):
    """Popover open, log empty, nothing held: every attempt starts from the same page."""
    page.eval("(() => { share.click(); __log.length = 0; return 1; })()")
    time.sleep(0.2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", default="all", choices=["electron", "chrome", "webkit", "both", "all"])
    parser.add_argument("--tweb", default=str(REPO / "target" / "release" / "tweb"))
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--scenario", nargs="*", default=list(SCENARIOS))
    parser.add_argument("--workdir", default=None)
    args = parser.parse_args()

    server, base = serve_fixtures()
    # The fixture loads its frame from 127.0.0.1, so the parent must be on another site.
    url = base.replace("127.0.0.1", "localhost") + "/frame-overlay.html"
    engines = {"both": ["electron", "chrome"], "all": ["electron", "chrome", "webkit"]}.get(args.engine, [args.engine])
    workdir = args.workdir or tempfile.gettempdir()
    reaped = reap_orphan_chromes(workdir)
    if reaped:
        print(f"ended {reaped} engine Chrome(s) earlier runs left behind", flush=True)
    failed = False
    for engine in engines:
        pane = Pane(args.tweb, engine, url, workdir, SIZE, tmux=True)
        try:
            if not pane.wait_ready():
                print(f"{engine:8} page never became ready", flush=True)
                failed = True
                continue
            page = Page(pane)
            at = "frame-overlay.html"
            for name in args.scenario:
                fixture = FIXTURES.get(name, "frame-overlay.html")
                if fixture != at:
                    code, _, err = pane.agent("navigate", base.replace("127.0.0.1", "localhost") + "/" + fixture,
                                              timeout=20)
                    if code != 0:
                        raise RuntimeError(f"navigate to {fixture} failed: {err}")
                    time.sleep(1.0)
                    at = fixture
                passes, last_failure = 0, None
                for _ in range(args.runs):
                    if fixture == "frame-overlay.html":
                        prepare(page)
                    ok, log = SCENARIOS[name](page)
                    passes += ok
                    if not ok:
                        last_failure = log
                known = KNOWN_GAPS.get((engine, name))
                verdict = "ok" if passes == args.runs else ("known" if known else "FAIL")
                failed |= verdict == "FAIL"
                print(f"{engine:8} {name:12} {passes}/{args.runs} {verdict}", flush=True)
                if last_failure is not None:
                    print(f"           log: {last_failure}" + (f"\n           known: {known}" if known else ""),
                          flush=True)
        finally:
            pane.close()
    server.shutdown()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
