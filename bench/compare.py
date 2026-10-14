#!/usr/bin/env python3
"""Electron, Chrome and WebKit side by side: startup, frames, CPU and memory.

Each engine runs in a bare PTY like bench/feel.py, one engine at a time, through the shipping key,
frame and agent paths. Per engine:

  startup   spawn -> the engine's first frame, and -> the page answering `readyState`
  idle      a static text page for N seconds, after --settle seconds: frames sent, CPU, memory
  video     bench/pages/video.html (a looping 30fps pattern): frames sent, CPU, memory
  tabs      memory after opening K more tabs of the text page

  python3 bench/compare.py [--engine electron|chrome|webkit|all] [--seconds N] [--tabs K] [--size ...]

What counts as an engine's cost differs by engine, and each is attributed explicitly:

  electron  the `tweb` process tree (Electron and its helpers)
  chrome    that tree plus the engine Chrome, which is launched apart from it: found by its
            profile directory, then its own process tree
  webkit    that tree plus WebKit's XPC services (WebContent, GPU, Networking). launchd starts
            those, not the host, so they are attributed by appearing once the pane started: the
            WebKit processes present before it are excluded. Another WebKit app starting during a
            run would be counted too — the run prints how many it attributed.

The settle matters for Chrome. Each run gets a fresh profile, and a fresh Chrome profile spends its
first seconds on its own work — measured outside tweb, the same Chrome on the same page used 16% CPU
five seconds in and 0% at forty-five, with or without a screencast. Measured at once, that start-up
cost read as Chrome's idle cost. A profile in real use is not fresh, so it pays it once.

Memory is `footprint`'s total for the set — dirty memory, with what the processes share counted
once — not a sum of RSS, which counts every shared page in every process.
"""
import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import feel  # noqa: E402
import playback  # noqa: E402

WEBKIT_SERVICE = "com.apple.WebKit."


def webkit_services():
    out = subprocess.run(["pgrep", "-f", WEBKIT_SERVICE], capture_output=True, text=True).stdout
    return {int(p) for p in out.split()}


def chrome_tree(user_data):
    pids = set()
    for pid in playback.chrome_pids(user_data):
        pids.update(playback.tree(pid))
    return pids


def engine_pids(pane, engine, baseline):
    pids = set(playback.tree(pane.pid))
    if engine == "chrome":
        pids |= chrome_tree(pane.dir)
    if engine == "webkit":
        pids |= webkit_services() - baseline
    return sorted(pids)


def footprint_mb(pids):
    with tempfile.NamedTemporaryFile(suffix=".json") as out:
        args = ["footprint", "-j", out.name]
        for pid in pids:
            args += ["-p", str(pid)]
        subprocess.run(args, capture_output=True)
        try:
            data = json.load(open(out.name))
        except (ValueError, OSError):
            return None
    return round(data.get("total footprint", 0) / (1 << 20))


def measure(pane, engine, baseline, seconds):
    pids = engine_pids(pane, engine, baseline)
    start_rows = len(pane.trace())
    cpu0, t0 = playback.cpu_seconds(pids), time.time()
    time.sleep(seconds)
    elapsed = time.time() - t0
    cpu = playback.cpu_seconds(pids) - cpu0
    frames = sum(1 for r in pane.trace()[start_rows:] if r["step"] == "frame")
    return {
        "fps": round(frames / elapsed, 1),
        "cpu": round(100 * cpu / elapsed),
        "mem": footprint_mb(pids),
        "procs": len(pids),
    }


def run_engine(args, engine, base, size):
    baseline = webkit_services()
    t0 = time.time()
    pane = feel.Pane(args.tweb, engine, f"{base}/text.html", tempfile.gettempdir(), size)
    result = {"engine": engine}
    try:
        # The first frame the engine sent, from its trace — not the first graphics escape on the
        # PTY, which is the image delete every engine writes when it starts.
        first = None
        while first is None and time.time() - t0 < 40:
            if any(r["step"] == "frame" for r in pane.trace()):
                first = time.time() - t0
            else:
                time.sleep(0.02)
        result["first_frame_s"] = round(first, 2) if first is not None else None
        if not pane.wait_ready():
            result["error"] = "page never became ready"
            return result
        result["ready_s"] = round(time.time() - t0, 2)
        time.sleep(args.settle)
        result["idle"] = measure(pane, engine, baseline, args.seconds)
        pane.agent("navigate", f"{base}/video.html")
        time.sleep(3)  # the frame rate settles into its playback tier
        result["video"] = measure(pane, engine, baseline, args.seconds)
        pane.agent("navigate", f"{base}/text.html")
        for _ in range(args.tabs):
            pane.agent("tab", "new", f"{base}/text.html")
            time.sleep(1.5)
        time.sleep(2)
        pids = engine_pids(pane, engine, baseline)
        result["tabs"] = {"count": args.tabs + 1, "mem": footprint_mb(pids), "procs": len(pids)}
    finally:
        pane.close()
        time.sleep(2)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", default="all", choices=["electron", "chrome", "webkit", "all"])
    parser.add_argument("--tweb", default=str(feel.REPO / "target" / "release" / "tweb"))
    parser.add_argument("--seconds", type=float, default=8)
    parser.add_argument("--tabs", type=int, default=4)
    parser.add_argument("--settle", type=float, default=45,
                        help="seconds between the page being ready and the idle window")
    parser.add_argument("--size", default=f"{feel.COLS}x{feel.ROWS}@{feel.PX_W}x{feel.PX_H}")
    parser.add_argument("--json", default=None)
    args = parser.parse_args()

    playback.ensure_video()
    server, base = feel.serve_fixtures()
    cells, pixels = args.size.split("@")
    size = tuple(int(v) for v in cells.split("x")) + tuple(int(v) for v in pixels.split("x"))
    engines = ["electron", "chrome", "webkit"] if args.engine == "all" else [args.engine]
    report = []
    for engine in engines:
        r = run_engine(args, engine, base, size)
        report.append(r)
        if "error" in r:
            print(f"{engine:8} {r['error']}", flush=True)
            continue
        i, v, t = r["idle"], r["video"], r["tabs"]
        print(f"{engine:8} first frame {r['first_frame_s']}s ready {r['ready_s']}s | "
              f"idle {i['fps']}fps cpu {i['cpu']}% {i['mem']}MB | "
              f"video {v['fps']}fps cpu {v['cpu']}% {v['mem']}MB | "
              f"{t['count']} tabs {t['mem']}MB over {t['procs']} procs", flush=True)
    server.shutdown()
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
