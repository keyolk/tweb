#!/usr/bin/env python3
"""Does `tweb screenshot` show the page as it is NOW, on a pane nobody is looking at?

A worker's pane lives in another tmux window, so its surface is collapsed between agent calls and
every call restores it for its own length (`withAgentSurface`). This changes the page, takes a
screenshot at once, and reads one pixel of the PNG: the colour the page was just set to is the
answer, the colour before it is a stale frame.

  eval    set the colour with `tweb eval`, screenshot
  click   flip the colour with a native `tweb click`, screenshot
  reload  `tweb reload`, wait for load, set the colour with eval, screenshot

Usage:
  python3 bench/stale-shot.py --pane %N [--tweb PATH] [--runs N] [--scenario NAME ...] [--settle S]

The pane must be in a tmux window the user is NOT looking at (`diag` shows terminalVisible:false);
on a visible pane the surface is never collapsed and this measures nothing. Exits 1 when any run
was stale. `--settle` waits between the page change and the screenshot, to tell "stale for a
moment" from "stale until something else wakes the pane".
"""

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("stale-shot.py needs Pillow (python3 -m pip install pillow)")

PAGE = """<!doctype html><meta charset=utf-8><title>stale-shot</title>
<body style="margin:0;background:#ff0000;height:100vh">
<button id=b style="position:fixed;left:0;top:0;width:60px;height:30px"
  onclick="document.body.style.background=window.next=(window.next=='#0000ff'?'#ff0000':'#0000ff')">go</button>
"""

COLOURS = {"#ff0000": (255, 0, 0), "#0000ff": (0, 0, 255)}


def tweb(args, pane, tool):
    out = subprocess.run([tool, *args, "--pane", pane], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise SystemExit(f"tweb {' '.join(args)} failed: {out.stderr.strip() or out.stdout.strip()}")
    return out.stdout


def pixel(path):
    image = Image.open(path).convert("RGB")
    # Away from the presence badge (bottom right) and the button (top left).
    return image.getpixel((image.width // 2, image.height // 2))


def near(a, b):
    return all(abs(x - y) < 40 for x, y in zip(a, b))


def snapshot_ref(pane, tool):
    # The button is the only interactive element.
    for line in tweb(["snapshot"], pane, tool).splitlines():
        if line.lstrip().startswith("@") and '"go"' in line:
            return line.split()[0].lstrip("@")
    raise SystemExit("no ref for the go button in the snapshot")


def run_once(scenario, index, pane, tool, shot, settle):
    want = "#0000ff" if index % 2 == 0 else "#ff0000"
    other = "#ff0000" if want == "#0000ff" else "#0000ff"
    # Start every run from `other`, known and rendered, so "stale" is unambiguous.
    tweb(["eval", f"document.body.style.background=window.next='{other}'"], pane, tool)
    time.sleep(0.4)
    if scenario == "eval":
        tweb(["eval", f"document.body.style.background=window.next='{want}'"], pane, tool)
    elif scenario == "click":
        # The button flips to the colour that is not the current one.
        tweb(["eval", f"window.next='{other}'"], pane, tool)
        ref = snapshot_ref(pane, tool)
        tweb(["click", ref], pane, tool)
    elif scenario == "reload":
        tweb(["reload"], pane, tool)
        tweb(["wait", "--load"], pane, tool)
        tweb(["eval", f"document.body.style.background=window.next='{want}'"], pane, tool)
    else:
        raise SystemExit(f"unknown scenario {scenario}")
    if settle:
        time.sleep(settle)
    tweb(["screenshot", str(shot)], pane, tool)
    got = pixel(shot)
    ok = near(got, COLOURS[want])
    if not ok:
        # Tell a stale frame from an action that never reached the page: the DOM answers either way.
        dom = tweb(["eval", "document.body.style.background"], pane, tool).strip()
        print(f"    page background is {dom!r} (want {want})")
    return ok, want, got


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pane", required=True)
    parser.add_argument("--tweb", default="tweb")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--scenario", action="append", choices=["eval", "click", "reload"])
    parser.add_argument("--settle", type=float, default=0.0)
    parser.add_argument("--json")
    args = parser.parse_args()

    diag = json.loads(tweb(["diag", "--json"], args.pane, args.tweb) or "{}")
    if json.dumps(diag).find('"terminalVisible": true') >= 0 or diag.get("input", {}).get("terminalVisible"):
        print("warning: the pane is visible; the surface is never collapsed, so this measures nothing",
              file=sys.stderr)

    work = Path(tempfile.mkdtemp(prefix="stale-shot-"))
    page = work / "page.html"
    page.write_text(PAGE)
    tweb(["navigate", f"file://{page}"], args.pane, args.tweb)
    tweb(["wait", "--load"], args.pane, args.tweb)

    report = {}
    for scenario in args.scenario or ["eval", "click", "reload"]:
        stale = 0
        for index in range(args.runs):
            ok, want, got = run_once(scenario, index, args.pane, args.tweb, work / "shot.png", args.settle)
            if not ok:
                stale += 1
                print(f"  {scenario} #{index}: STALE want {COLOURS[want]} got {got}")
        report[scenario] = {"runs": args.runs, "stale": stale}
        print(f"{scenario}: {stale}/{args.runs} stale")
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2))
    return 1 if any(item["stale"] for item in report.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
