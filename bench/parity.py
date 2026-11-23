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
  file-isolation
                pages/file-isolation/probe.html opened as file://. ok = fetch and XHR of a sibling
                file and of /etc/hosts are refused, the same-folder iframe's DOM is unreadable, and
                the page's relative <img> still loads. Electron needs its file-privilege fuse off,
                which the `tweb` binary under test turns off before the engine starts
  zoom-out-click / zoom-in-click
                the pane zoomed two steps away from the default, then four clicks on the parent's
                Share button. ok = every press and release landed on the button at the same point
                and the button took each click. Chrome read mouse coordinates at its own scale or
                the zoomed tab's from one event to the next, so a release could land at 1/1.44 of
                the press and no click happened (`zoomLayout` in electron/cdp/engine.cjs)
  host-zoom-click
                Chrome only, on zoom-frame.html (a header and a same-origin iframe over the rest, as
                platform-portal is laid out): the engine Chrome's own zoom set to 50%, as a zoom saved
                for a site in its profile is, then a click on each of two buttons in the iframe and
                one in the header, all away from the origin. ok = each took its click. With 50% saved
                for platform-portal every mouse click there landed at half its point while `f` still
                worked: the pane's point was made CSS pixels with tweb's zoom alone. Other engines: n/a
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


def chrome_debug_port(pane):
    """The debugging port of the pane's own engine Chrome, from its command line."""
    profile = str(pane.dir / "userData" / "chrome-profile")
    ps = subprocess.run(["ps", "-Ao", "command="], capture_output=True, text=True).stdout
    for line in ps.splitlines():
        if f"--user-data-dir={profile}" in line and "--type=" not in line:
            for arg in line.split():
                if arg.startswith("--remote-debugging-port="):
                    return int(arg.split("=", 1)[1])
    return None


def set_chrome_default_zoom(port, factor):
    """Chrome's default page zoom, set the way its settings page does, in a background target that
    is closed again. The engine adopts only http(s) targets it did not open, so it leaves this one."""
    script = r"""
const [port, factor] = process.argv.slice(1);
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}, sessionId) => new Promise((r) => { const n = ++id; pending.set(n, r);
  ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { result: { targetId } } = await send("Target.createTarget", { url: "chrome://settings/appearance", background: true, newWindow: true });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
let out = null;
for (let i = 0; i < 50; i++) {
  const m = await send("Runtime.evaluate", { expression: `typeof chrome.settingsPrivate?.setDefaultZoom === "function"`, returnByValue: true }, sessionId);
  if (m.result?.result?.value === true) break;
  await new Promise((r) => setTimeout(r, 100));
}
out = await send("Runtime.evaluate", { expression: `new Promise((r) => chrome.settingsPrivate.setDefaultZoom(${Number(factor)}, r)).then(() => true)`, awaitPromise: true, returnByValue: true }, sessionId);
await send("Target.closeTarget", { targetId });
ws.close();
console.log(JSON.stringify(out.result?.result?.value ?? out.error ?? null));
"""
    out = subprocess.run(["node", "--input-type=module", "-e", script, "--", str(port), str(factor)],
                         capture_output=True, text=True, timeout=30)
    if out.returncode != 0 or "true" not in out.stdout:
        raise RuntimeError(f"setting Chrome's zoom failed: {out.stdout.strip()} {out.stderr.strip()[:300]}")


def zoom_frame_targets(page):
    """Each target's centre in the top page's CSS pixels: two buttons in the iframe, one in the header."""
    return page.eval("(() => { const f = frame.getBoundingClientRect(); const at = (el, dx, dy) => {"
                     " const r = el.getBoundingClientRect(); return [dx + r.x + r.width / 2, dy + r.y + r.height / 2]; };"
                     " const d = frame.contentDocument; return {b1: at(d.getElementById('b1'), f.x, f.y),"
                     " b2: at(d.getElementById('b2'), f.x, f.y), top: at(document.getElementById('top'), 0, 0)}; })()")


def host_zoom_click(page):
    if page.pane.engine != "chrome":
        return True, "n/a: only the Chrome engine has a zoom of its own"
    port = chrome_debug_port(page.pane)
    if not port:
        return False, "no engine Chrome found for this pane"
    set_chrome_default_zoom(port, 0.5)
    try:
        time.sleep(1.0)
        page.measure()
        detail = {"dpr": page.eval("devicePixelRatio"), "clicks": {}}
        ok = True
        for name, (x, y) in zoom_frame_targets(page).items():
            want = f"frame:click {name}" if name != "top" else "top:click top"
            page.eval("(() => { __log.length = 0; return 1; })()")
            page.click(*page.cell(x, y))
            log = page.settle(lambda log: any(":click" in entry for entry in log))
            detail["clicks"][name] = log
            ok &= want in log
        return ok, detail
    finally:
        set_chrome_default_zoom(port, 1)
        time.sleep(1.0)
        page.measure()


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


def file_isolation(page):
    """A file:// page reads no other local file, as Chrome refuses it too."""
    deadline = time.time() + 8
    probe = {}
    while time.time() < deadline and not probe.get("done"):
        time.sleep(0.25)
        probe = page.eval("window.__probe || {}")
    refused = all(str(probe.get(key, "")).startswith("blocked")
                  for key in ("fetchSibling", "fetchOutside", "xhrSibling", "xhrOutside"))
    frame_closed = not str(probe.get("iframeDom", "")).startswith("READ FRAME-DOM")
    return bool(probe.get("done")) and refused and frame_closed and probe.get("img") == "loaded", probe


SCENARIOS = {"popover": popover, "frame-click": frame_click, "frame-drag": frame_drag, "page-drag": page_drag,
             "zoom-out-click": zoomed_click(2), "zoom-in-click": zoomed_click(-2), "host-zoom-click": host_zoom_click,
             "canvas-hints": canvas_hints,
             "file-isolation": file_isolation}
# The fixture each scenario runs on, when not the frame overlay. A `file:` entry is opened from disk,
# not through the fixture server: the scenario is about what a local page can read.
FIXTURES = {"canvas-hints": "canvas-targets.html", "host-zoom-click": "zoom-frame.html",
            "file-isolation": "file:" + str(REPO / "bench" / "pages" / "file-isolation" / "probe.html")}


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
                    target = ("file://" + fixture[len("file:"):] if fixture.startswith("file:")
                              else base.replace("127.0.0.1", "localhost") + "/" + fixture)
                    code, _, err = pane.agent("navigate", target, timeout=20)
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
