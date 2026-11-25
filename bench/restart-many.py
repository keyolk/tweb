#!/usr/bin/env python3
"""Does a pane keep going back to the daemon however many times it is restarted?

A pane's reattach budget was spent over its whole life: each `tweb daemon restart` used one attempt,
and after six a restart left the pane on an engine of its own, running the app embedded in the
pane's binary rather than the one just installed. This opens one hosted pane on a daemon of its own
(a private runtime directory, never the one in use), restarts that daemon RESTARTS times, and after
each one checks the daemon hosts the pane again.

  python3 bench/restart-many.py [--tweb PATH] [--restarts N] [--hold S]

`--hold` is how long each session runs before the next restart; the budget resets only after a
session that ran 30s, so the default holds past that. Exits non-zero when the pane falls back.
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
    parser.add_argument("--restarts", type=int, default=8)
    parser.add_argument("--hold", type=float, default=32.0)
    args = parser.parse_args()
    server, base = serve_fixtures()
    pane = Pane(args.tweb, "electron", f"{base}/text.html", tempfile.gettempdir(), (160, 50, 1280, 800),
                tmux=True, daemon=True)
    env = dict(os.environ, **pane.cli_env)

    def daemon(*argv, timeout=60):
        return subprocess.run([args.tweb, "daemon", *argv], capture_output=True, text=True, timeout=timeout, env=env)

    def hosted_panes():
        out = daemon("status").stdout
        for line in out.splitlines():
            if line.startswith("panes "):
                return int(line.split()[1])
        return 0

    def wait_hosted(seconds=30):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if hosted_panes() >= 1:
                return True
            time.sleep(0.5)
        return False

    failed = None
    try:
        if not wait_hosted(60):
            print("the pane was never hosted")
            return 2
        for restart in range(1, args.restarts + 1):
            time.sleep(args.hold)
            daemon("restart")
            ok = wait_hosted()
            print(f"restart {restart}: {'hosted again' if ok else 'NOT hosted (fell back)'}", flush=True)
            if not ok:
                failed = restart
                break
        print("ok" if failed is None else f"FAIL: fell back at restart {failed}")
        return 0 if failed is None else 1
    finally:
        try:
            daemon("stop")
        except Exception:  # noqa: BLE001 - best effort; the pane's close ends the rest
            pass
        pane.close()
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
