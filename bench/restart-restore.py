#!/usr/bin/env python3
"""Does a pane come back from `tweb daemon restart` on the tab it was on?

A pane reattaching after a restart carries the URL it was first opened with. Treated as a fresh
request, that URL took the active tab (or was appended as a new one), so every pane came back on its
first page. This opens A, adds B and C, activates B, restarts a daemon of the pane's own (a private
runtime directory, never the one in use), and compares the tab list.

  python3 bench/restart-restore.py [--tweb PATH]

Set TWEB_ELECTRON_DIR=$PWD/electron to run this checkout's app code. Exits non-zero on a mismatch.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

from feel import REPO, Pane, serve_fixtures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tweb", default=str(REPO / "target" / "release" / "tweb"))
    args = parser.parse_args()
    server, base = serve_fixtures()
    a, b, c = (f"{base}/{name}" for name in ("text.html", "hints.html", "mixed.html"))
    pane = Pane(args.tweb, "electron", a, tempfile.gettempdir(), (160, 50, 1280, 800), tmux=True, daemon=True)
    env = dict(os.environ, **pane.cli_env)
    pane_id = None

    def tweb(*argv, timeout=20):
        target = [] if argv[0] == "daemon" else ["--pane", pane_id]
        return subprocess.run([args.tweb, *argv, *target], capture_output=True, text=True, timeout=timeout, env=env)

    def tabs():
        listed = json.loads(tweb("tab", "list", "--json").stdout)["tabs"]
        return [("*" if tab.get("active") else "") + tab["url"].rsplit("/", 1)[1] for tab in listed]

    def settle():
        for _ in range(60):
            try:
                if tabs():
                    return
            except (ValueError, KeyError):
                pass
            time.sleep(0.5)

    try:
        pane_id = subprocess.run(["tmux", "-L", pane.tmux, "display", "-p", "-t", "feel", "#{pane_id}"],
                                 capture_output=True, text=True).stdout.strip()
        settle()
        tweb("tab", "new", b)
        tweb("tab", "new", c)
        time.sleep(1)
        tweb("tab", "switch", "1")
        time.sleep(1.5)  # past the session save's debounce
        before = tabs()
        tweb("daemon", "restart", timeout=60)
        time.sleep(1)
        settle()
        time.sleep(2)
        after = tabs()
        print(f"before restart  {before}\nafter restart   {after}")
        ok = before == after
        print("ok" if ok else "FAIL: the pane did not come back as it was")
        return 0 if ok else 1
    finally:
        try:
            tweb("daemon", "stop")
        except Exception:  # noqa: BLE001 - best effort; the pane's close ends the rest
            pass
        pane.close()
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
