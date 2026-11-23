#!/usr/bin/env python3
"""Do panes survive `tweb daemon restart` when the shell that ran it is cleaned up afterwards?

An agent's shell tool runs each command in a process group of its own and signals that group when
it is done with it. A daemon `tweb daemon restart` starts inside that group goes down with it, and on
2026-11-23 every pane hosted by it (14) was gone 22 seconds after a restart run that way.

This opens PANES panes on one private daemon (a private tmux server and runtime directory, never the
one in use), gives each a few tabs and an active one, runs `tweb daemon restart` the way a shell tool
does (a process group of its own), then signals that group, as the tool's cleanup does. It then waits
and compares every pane's tab list with the one before.

  python3 bench/restart-detach.py [--tweb PATH] [--panes N]

Set TWEB_ELECTRON_DIR=$PWD/electron to run this checkout's app code. Exits non-zero on a mismatch.
"""

import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import time

from feel import REPO, Pane, serve_fixtures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tweb", default=str(REPO / "target" / "release" / "tweb"))
    parser.add_argument("--panes", type=int, default=3)
    parser.add_argument("--cleanup-after", type=float, default=3.0,
                        help="seconds between the restart returning and its group being signalled")
    args = parser.parse_args()
    server, base = serve_fixtures()
    pages = [f"{base}/{name}" for name in ("text.html", "hints.html", "mixed.html")]
    first = Pane(args.tweb, "electron", pages[0], tempfile.gettempdir(), (160, 50, 1280, 800), tmux=True, daemon=True)
    env = dict(os.environ, **first.cli_env)
    base_tmux = ["tmux", "-L", first.tmux]
    panes = []

    def tweb(*argv, pane=None, timeout=20):
        target = ["--pane", pane] if pane else []
        return subprocess.run([args.tweb, *argv, *target], capture_output=True, text=True, timeout=timeout, env=env)

    def tabs(pane):
        try:
            listed = json.loads(tweb("tab", "list", "--json", pane=pane).stdout)
        except ValueError:
            return None
        return [("*" if tab.get("active") else "") + tab["url"].rsplit("/", 1)[1] for tab in listed.get("tabs", [])]

    def alive():
        out = subprocess.run(base_tmux + ["list-panes", "-a", "-F", "#{pane_id} #{pane_current_command}"],
                             capture_output=True, text=True).stdout.split("\n")
        return {line.split()[0]: line.split()[1] for line in out if line.strip()}

    def daemon():
        out = tweb("daemon", "status").stdout
        for line in out.splitlines():
            if line.startswith("pid "):
                pid = int(line.split()[1])
                try:
                    return f"{pid} pgid={os.getpgid(pid)}"
                except ProcessLookupError:
                    return f"{pid} (gone)"
        return "none"

    def settle(pane, deadline=40):
        end = time.time() + deadline
        while time.time() < end:
            if tabs(pane):
                return True
            time.sleep(0.5)
        return False

    try:
        panes.append(subprocess.run(base_tmux + ["display", "-p", "-t", "feel", "#{pane_id}"],
                                    capture_output=True, text=True).stdout.strip())
        command = " ".join(f"{k}={shlex.quote(v)}" for k, v in first.cli_env.items())
        for index in range(1, args.panes):
            created = subprocess.run(base_tmux + ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "feel",
                                                  f"{command} exec {shlex.quote(args.tweb)} open {shlex.quote(pages[index % 3])}"],
                                     capture_output=True, text=True, env=env)
            panes.append(created.stdout.strip())
        for pane in panes:
            if not settle(pane):
                print(f"FAIL: {pane} never came up")
                return 1
        # Each pane gets the other two pages and an active tab that is neither its first nor last.
        for index, pane in enumerate(panes):
            for other in (pages[(index + 1) % 3], pages[(index + 2) % 3]):
                tweb("tab", "new", other, "--new", pane=pane)
            tweb("tab", "switch", "1", pane=pane)
        time.sleep(1.5)  # past the session save's debounce
        before = {pane: tabs(pane) for pane in panes}

        # The shell tool's way: a process group of its own, then a signal to that group.
        shell = subprocess.Popen(["/bin/sh", "-c", f"{shlex.quote(args.tweb)} daemon restart"],
                                 env=env, start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        said = shell.communicate(timeout=60)[0].strip()
        time.sleep(args.cleanup_after)
        restarted = daemon()
        try:
            os.killpg(shell.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass  # nothing left in the group: the daemon is somewhere else
        time.sleep(1)
        cleaned = daemon()
        time.sleep(29)
        for pane in panes:
            settle(pane, deadline=20)
        after = {pane: tabs(pane) for pane in panes}
        running = alive()
        print(f"restart said: {said}")
        print(f"shell group {shell.pid}; daemon after restart {restarted}; after the group's cleanup {cleaned}; at the end {daemon()}")
        # Panes on current code recover even from a killed daemon (they start a new one), so the tab
        # lists alone do not show the defect: the daemon the restart started must still be running.
        survived = restarted.split()[0] == cleaned.split()[0] and "gone" not in cleaned
        print(f"daemon the restart started {'survived' if survived else 'DIED with'} its caller's cleanup")
        panes_ok = True
        for pane in panes:
            state = running.get(pane, "gone")
            same = before[pane] == after[pane]
            panes_ok = panes_ok and same
            print(f"{pane:5} {state:6} before {before[pane]}\n{'':12} after  {after[pane]}{'' if same else '   <- differs'}")
        if not survived:
            print("FAIL: the restarted daemon died with the shell that ran the restart")
        if not panes_ok:
            print("FAIL: a pane did not come back as it was")
        ok = survived and panes_ok
        if ok:
            print("ok")
        return 0 if ok else 1
    finally:
        try:
            tweb("daemon", "stop")
        except Exception:  # noqa: BLE001 - best effort; the pane's close ends the rest
            pass
        first.close()
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
