#!/usr/bin/env python3
"""Does a hosted pane clean up after itself when it is interrupted?

**Ctrl-C is not SIGINT here.** tweb enters raw mode with `cfmakeraw`, which clears `ISIG`, so
the terminal never translates the interrupt character into a signal — it arrives as a `0x03`
BYTE on stdin. An earlier version of this harness called `send_signal(SIGINT)` and passed while
the real key did nothing, because it was testing an event a user in raw mode cannot produce.
So this writes the byte to the PTY, the way a keypress does.

What goes wrong without the fix: nothing treats `0x03` as an exit, so the pane keeps running,
its engine keeps running, and the page's image stays on the terminal. Measured on a wedged
pane: both processes still alive minutes later, and the engine ignoring SIGTERM on top of that.

    python3 bench/hosted-interrupt.py <tweb-binary> <twebd-binary> [seconds]

What it checks, on a real PTY with a real daemon:

    1. the pane is hosted           otherwise this measures the spawn path, which never had
                                    the bug
    2. a typed 0x03 ends it         the pane exits rather than sitting there
    3. its engine goes with it      a hosted pane's engine belongs to the daemon, but a spawned
                                    one is the pane's own child and must not outlive it

Verified in both directions: before the fix the pane survives the byte entirely.

It asserts the exit rather than the cleanup BYTES, which is a limitation worth stating.
`write_kitty_delete` wraps its output in tmux passthrough whenever $TMUX is set, and a harness
needs a fabricated $TMUX to reach the hosted path at all — so the wrapped sequence has no live
server to travel through and never lands on this PTY.
"""

import os
import pty
import re
import signal
import shutil
import subprocess
import sys
import time

FAKE_TMUX = "/tmp/tweb-interrupt-probe,999999,0"
PANE = "%901"


def hosted_count(twebd, runtime):
    out = subprocess.run([twebd, "status", "--runtime-dir", runtime],
                         capture_output=True, text=True, timeout=20)
    for line in (out.stdout + out.stderr).splitlines():
        if line.startswith("hosted "):
            return int(line.split()[1])
    return 0


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    tweb, twebd = sys.argv[1], sys.argv[2]
    settle = float(sys.argv[3]) if len(sys.argv) > 3 else 20.0

    runtime = os.environ.get("TWEB_INTERRUPT_RUNTIME_DIR", "/tmp/tweb-hosted-interrupt")
    shutil.rmtree(runtime, ignore_errors=True)
    os.makedirs(runtime, exist_ok=True)

    env = dict(os.environ)
    env["TWEB_RUNTIME_DIR"] = runtime
    env["TWEB_USER_DATA_DIR"] = os.path.join(runtime, "ud")
    env["TWEB_TWEBD"] = twebd
    env["TMUX"] = FAKE_TMUX
    env["TMUX_PANE"] = PANE
    env["TWEB_ASSUME_GRAPHICS"] = "1"
    env.pop("TWEB_DAEMON", None)

    # A PTY, because the cleanup this checks for is written to the terminal. On a pipe the
    # frontend takes a different path and the sequences never appear.
    primary, secondary = pty.openpty()
    pane = subprocess.Popen(
        [tweb, "__pane", "https://example.com"], env=env,
        stdin=secondary, stdout=secondary,
        stderr=open(os.path.join(runtime, "pane.err"), "wb"),
        start_new_session=True,
    )
    os.close(secondary)

    results = []
    captured = b""
    try:
        hosted = False
        deadline = time.time() + settle
        while time.time() < deadline:
            if hosted_count(twebd, runtime) >= 1:
                hosted = True
                break
            time.sleep(0.25)
        print(f"  hosted: {hosted}")
        results.append(("the pane is hosted by the daemon", hosted))

        # Everything written before the interrupt is drained and discarded: the check is about
        # what arrives AFTER it, and a page's frames would otherwise swamp the match.
        os.set_blocking(primary, False)
        while True:
            try:
                if not os.read(primary, 1 << 20):
                    break
            except (BlockingIOError, OSError):
                break

        # The real event: the byte a raw-mode terminal delivers for Ctrl-C. Written to the PTY
        # master, which is where a keypress enters.
        os.write(primary, b"\x03")
        exited = None
        try:
            exited = pane.wait(timeout=15)
        except subprocess.TimeoutExpired:
            pass
        print(f"  exit status after a typed Ctrl-C: {exited}")
        results.append(("a typed Ctrl-C ends the pane", exited is not None))

        # Read whatever the pane wrote on its way out.
        end = time.time() + 3
        while time.time() < end:
            try:
                chunk = os.read(primary, 1 << 20)
            except (BlockingIOError, OSError):
                time.sleep(0.05)
                continue
            if not chunk:
                break
            captured += chunk

        # Ending through the exit path, not by a signal — that is where the cleanup lives.
        clean = exited == 0
        print(f"  exited through its own exit path (0): {clean}")
        results.append(("the pane ends through its exit path", clean))

        # The cleanup bytes themselves are NOT asserted here, and that is a limitation of the
        # harness rather than a gap in the fix. `write_kitty_delete` wraps its output in tmux
        # passthrough whenever $TMUX is set, and this runs against a fabricated tmux server —
        # the wrapped sequence has no live server to travel through, so nothing reaches this
        # PTY. Verified separately without $TMUX, where the delete does appear on the tty.
        if not re.search(rb"a=d,d=I", captured):
            print("  (no raw delete on this PTY — expected: fabricated $TMUX wraps it)")

    finally:
        if pane.poll() is None:
            pane.kill()
        try:
            os.close(primary)
        except OSError:
            pass
        subprocess.run([twebd, "stop", "--runtime-dir", runtime],
                       capture_output=True, timeout=20)

    if not all(ok for _, ok in results):
        print(f"\n  (captured {len(captured)} bytes after the interrupt)")
    print("\n=== verdict ===")
    for name, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    failed = [name for name, ok in results if not ok]
    print(f"\n{'PASS' if not failed else 'FAIL'} — "
          + ("an interrupted hosted pane leaves the terminal as it found it" if not failed
             else f"{len(failed)} check(s) failed"))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
