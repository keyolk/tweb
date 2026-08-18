#!/usr/bin/env python3
"""Track a live tweb pane's frame pipeline over time, and say when something is actually wrong.

Written for a session that shipped `o=z` whole-frame compression (DETAIL.md 8.6) and wanted to
know whether it holds up on the owner's real browsing rather than on a synthetic churn page.

What it watches, and why each one:

    droppedByBackpressure   the number that matters. Frames discarded because the worker was
                            still busy. 8.5 measured ~244 per 30s at 2880x1800 before the fix.
    wholeCompressed/whole   whether the sampling threshold is engaging. A sudden 0 on text
                            content means compression silently stopped, and drops follow.
    whole, patches          which path the damage took. Patches climbing with whole flat is
                            normal typing; whole climbing is scroll or video.
    rate/rateKind           the engine's own throttle. `idle` at rate 4 means the page has
                            nothing to show, so zero drops there proves nothing.
    rss                     this pane's own process tree, to catch a leak no frame counter
                            shows. Scoped to the pid `diag` reports, not to every tweb on the
                            box: two unrelated instances measured 1174MB and 76MB, and a sum
                            of both moves when someone opens a pane you are not watching.

Deltas are reported per interval, not as totals, because a total that stopped growing and a
total that never grew look identical.

    python3 bench/track-pane.py %565 --interval 30 --out /tmp/track.jsonl

Every sample is appended as JSON so a long run can be re-read after the fact. Lines flagged
`ALERT` are the ones worth looking at; everything else is the pane behaving.
"""
import argparse
import json
import subprocess
import sys
import time

TWEB = "/Users/gavin.jeong/src/keyolk/tweb/target/release/tweb"


def diag(pane):
    try:
        out = subprocess.run([TWEB, "diag", "--pane", pane, "--json"],
                             capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return None


def process_table():
    """(pid, ppid, rss) for every process, so a tree can be walked without another ps call."""
    out = subprocess.run(["ps", "-eo", "pid=,ppid=,rss="], capture_output=True, text=True).stdout
    rows = []
    for line in out.strip().splitlines():
        parts = line.split()
        if len(parts) >= 3 and all(p.isdigit() for p in parts[:3]):
            rows.append((int(parts[0]), int(parts[1]), int(parts[2])))
    return rows


def engine_root(data):
    """The engine pid for the pane being tracked, straight from `tweb diag`.

    `diag` reports `pid` for the pane it was asked about, so there is nothing to infer. An
    earlier version of this guessed — summing every `tweb __pane` and `Electron Helper` on the
    box, then picking the newest by pid — and both guesses were wrong in ways that looked like
    real numbers: the sum reported 1197MB across two unrelated instances, and pgrep returns
    ascending pids, so "newest" selected an idle 76MB pane while the one under test was playing
    video at 1174MB.
    """
    pid = data.get("pid")
    return pid if isinstance(pid, int) and pid > 0 else None


def engine_rss(root):
    """Resident memory of one pane's whole process tree, in MB.

    The tree, not the parent: `tweb __pane` is a few MB while the Electron renderer and GPU
    helpers hold the frames, and reporting only the parent showed a 4MB browser. A live pane
    playing video measured 1174MB across 8 processes.
    """
    if root is None:
        return 0.0
    rows = process_table()
    children = {}
    own = 0
    for pid, ppid, rss in rows:
        children.setdefault(ppid, []).append((pid, rss))
        if pid == root:
            own = rss
    total, stack, seen = own, [root], {root}
    while stack:
        for pid, rss in children.get(stack.pop(), []):
            if pid in seen:
                continue
            seen.add(pid)
            total += rss
            stack.append(pid)
    return total / 1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pane")
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--out", default="/tmp/tweb-track.jsonl")
    parser.add_argument("--samples", type=int, default=0, help="0 runs until the pane is gone")
    args = parser.parse_args()

    previous = None
    taken = 0
    print(f"tracking {args.pane} every {args.interval}s -> {args.out}", flush=True)
    print(f"{'time':8s} {'whole':>7s} {'+':>5s} {'z%':>5s} {'patch':>6s} "
          f"{'drop':>5s} {'+':>4s} {'rate':>10s} {'rss':>8s}", flush=True)

    while args.samples == 0 or taken < args.samples:
        data = diag(args.pane)
        if data is None:
            print(f"{time.strftime('%H:%M:%S')} pane gone or unreadable — stopping", flush=True)
            return 0
        frames = data.get("frames", {})
        rss = engine_rss(engine_root(data))
        sample = {
            "t": time.time(),
            "whole": frames.get("whole", 0),
            "compressed": frames.get("wholeCompressed", 0),
            "patches": frames.get("patches", 0),
            "dropped": frames.get("droppedByBackpressure", 0),
            "rate": frames.get("rate"),
            "rateKind": frames.get("rateKind"),
            "size": frames.get("lastSize"),
            "rssMB": round(rss, 1),
        }

        alerts = []
        if previous:
            dWhole = sample["whole"] - previous["whole"]
            dDrop = sample["dropped"] - previous["dropped"]
            dComp = sample["compressed"] - previous["compressed"]
            sample["dWhole"], sample["dDropped"], sample["dCompressed"] = dWhole, dDrop, dComp

            # The one that means the fix stopped working.
            if dDrop > 0:
                alerts.append(f"dropped +{dDrop} over {dWhole} whole frames")
            # Compression disengaging entirely while frames flow. Video legitimately does this,
            # so it is only worth flagging alongside drops or a sustained run.
            if dWhole >= 30 and dComp == 0 and dDrop > 0:
                alerts.append("compression not engaging while dropping")
            # A leak shows as a floor that keeps rising, not as a spike.
            if rss > previous["rssMB"] * 1.5 and rss - previous["rssMB"] > 200:
                alerts.append(f"rss {previous['rssMB']:.0f} -> {rss:.0f}MB")
            sample["alerts"] = alerts

            ratio = f"{100 * dComp // dWhole}%" if dWhole else "-"
            print(f"{time.strftime('%H:%M:%S')} {sample['whole']:7d} {dWhole:+5d} {ratio:>5s} "
                  f"{sample['patches']:6d} {sample['dropped']:5d} {dDrop:+4d} "
                  f"{str(sample['rateKind']):>10s} {rss:7.0f}M"
                  + (f"   ALERT: {'; '.join(alerts)}" if alerts else ""), flush=True)

        with open(args.out, "a") as handle:
            handle.write(json.dumps(sample) + "\n")
        previous = sample
        taken += 1
        time.sleep(args.interval)
    return 0


if __name__ == "__main__":
    sys.exit(main())
