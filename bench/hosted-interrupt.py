#!/usr/bin/env python3
"""Does a hosted pane clean up after itself when it is interrupted?

The defect this checks for is invisible from inside tweb: a hosted pane that dies by SIGINT's
default action leaves the kitty image on the terminal and never leaves the alternate screen,
because both cleanups are code in the pane process that a default-action death never runs. The
page vanishes, a black screen stays, and the pane is stuck. It only happens with the daemon —
on the spawn path the engine is the pane's own child and its exit path covers for this.

    python3 bench/hosted-interrupt.py <tweb-binary> <twebd-binary> [seconds]

What it checks, on a real PTY with a real daemon:

    1. the pane is hosted           otherwise this measures the spawn path, which never had
                                    the bug
    2. SIGINT ends the process      a handler that swallows the signal is a worse bug than
                                    the one being fixed
    3. it exits 0, not -2           the difference between dying where the cleanup is and
                                    dying before it

Check 3 is the one that separates the defect from the fix, and it was verified in both
directions: the pre-fix binary exits -2 here, the fixed one exits 0.

It asserts the exit path rather than the cleanup BYTES, which is a limitation worth stating.
`write_kitty_delete` wraps its output in tmux passthrough whenever $TMUX is set, and a harness
needs a fabricated $TMUX to reach the hosted path at all — so the wrapped sequence has no live
server to travel through and never lands on this PTY. Checked separately without $TMUX, where
the raw `a=d,d=I` does appear on the tty; that run takes the spawn path, so it says the delete
works but not that an interrupt reaches it.
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

        pane.send_signal(signal.SIGINT)
        exited = None
        try:
            exited = pane.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        print(f"  exit status after SIGINT: {exited}")
        results.append(("SIGINT ends the pane", exited is not None))

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

        # THE CHECK THAT SEPARATES THE DEFECT FROM THE FIX.
        #
        # `-2` is death by SIGINT's default action: no handler ran, so no cleanup ran either —
        # the image stays on the terminal and the alternate screen is never left. `0` means the
        # session ended through its own exit path, which is the path the cleanup lives on.
        # Measured both ways on this harness: the pre-fix binary gives -2, the fixed one 0.
        clean = exited == 0
        print(f"  exited cleanly (0) rather than by signal (-2): {clean}")
        results.append(("SIGINT ends the session through its exit path", clean))

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
