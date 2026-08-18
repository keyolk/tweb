#!/usr/bin/env python3
"""Drives a hosted engine the way twebd would, and reports what came back.

The engine's stdout is the supervisor's control pipe, so this speaks that protocol directly:
it writes task-2's ATTACH line on stdin and reads the addressed events back. What it is for is
the one question the gate turns on — does a HOSTED pane actually render — which no unit test can
answer and which `frames.whole` does not answer either (it counts hand-offs to the graphics
worker, not bytes that reached a terminal).

Usage: t1-host-harness.py <electron-binary> <app-dir> [seconds]
"""

import os
import subprocess
import sys
import time

PANE = "%3"
IMAGE_ID = 4242
# task-2's wire literal, seq 16, verbatim:
#   @%N ATTACH <server> <gen> <imageId> <rate> <adaptive> <restore>
#              <cols> <rows> <width> <height> <left> <top> <tty> <url>
ATTACH = (
    f"@{PANE} ATTACH - 1 {IMAGE_ID} 30 1 0 100 30 1000 600 0 0 - https://example.com\n"
)
# The visibility push is the frontend's tmux client listing, not a boolean: line 0 is the pane's
# own placement, the rest are the clients. One client viewing this pane's window is what makes the
# pane visible — anything else and the surface stays collapsed, which is correct but paints
# nothing, so a harness that sent `VIS 1` would measure silence and call it a failure.
_VIS_PAYLOAD = (
    "harness\t@1\t" + PANE + "\n"
    "/dev/ttys999\tharness\t@1\t0\t" + PANE + "\troot"
)
VISIBLE = f"@{PANE} VIS {_VIS_PAYLOAD.encode('utf8').hex()}\n"


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    electron, app_dir = sys.argv[1], sys.argv[2]
    seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0

    runtime = os.environ.get("TWEB_RUNTIME_DIR", "/tmp/t1harness")
    os.makedirs(runtime, exist_ok=True)
    env = dict(os.environ)
    env["TWEB_MULTIPANE"] = "1"
    env["TWEB_SUPERVISOR_PID"] = str(os.getpid())
    env["TWEB_RUNTIME_DIR"] = runtime
    env["TWEB_USER_DATA_DIR"] = os.path.join(runtime, "ud")
    # A hosted engine must not inherit any pane's identity from the environment.
    for name in ("TMUX", "TMUX_PANE", "TWEB_URL", "TWEB_VIEWPORT", "TWEB_IMAGE_ID",
                 "TWEB_PANE_ORIGIN", "TWEB_FRONTEND_PID"):
        env.pop(name, None)

    stderr = open(os.path.join(runtime, "engine.err"), "wb")
    engine = subprocess.Popen(
        [electron, "."], cwd=app_dir, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
    )

    events = []
    attached = False
    # READY now arrives (the gate is open), and the attach is sent as soon as it does — see the
    # stdout loop. The timer stays as a fallback so this harness still measures rendering against a
    # build whose gate is shut, which is the state every earlier run of it recorded.
    attach_at = time.time() + 3.0
    deadline = time.time() + seconds
    os.set_blocking(engine.stdout.fileno(), False)
    buffered = b""
    try:
        while time.time() < deadline:
            # A blocking read reports zero bytes for a slow trickle of graphics commands, so the
            # descriptor is non-blocking and read with os.read.
            try:
                chunk = os.read(engine.stdout.fileno(), 65536)
            except BlockingIOError:
                chunk = b""
            if chunk:
                buffered += chunk
                while b"\n" in buffered:
                    line, buffered = buffered.split(b"\n", 1)
                    text = line.decode("utf8", "replace").strip()
                    if not text:
                        continue
                    events.append(text)
                    # The attach only goes out once the engine has declared itself, exactly as
                    # the supervisor does — an engine that never says READY never gets one.
                    if (text.startswith("READY ") or text.startswith("@")) and not attached:
                        attached = True
                        engine.stdin.write(ATTACH.encode())
                        engine.stdin.write(VISIBLE.encode())
                        engine.stdin.flush()
            else:
                time.sleep(0.05)
            if not attached and time.time() > attach_at:
                attached = True
                engine.stdin.write(ATTACH.encode())
                engine.stdin.write(VISIBLE.encode())
                engine.stdin.flush()
            if engine.poll() is not None:
                break
    finally:
        try:
            engine.terminate()
            engine.wait(timeout=5)
        except Exception:
            engine.kill()
        stderr.close()

    ready = [e for e in events if e.startswith("READY ")]
    frames = [e for e in events if e.startswith(f"@{PANE} FRAME ")]
    agent = [e for e in events if e.startswith(f"@{PANE} AGENT ")]
    other = [e for e in events if e not in ready and e not in frames and e not in agent]

    print(f"READY:  {ready or 'NONE — the engine did not declare itself a host'}")
    if ready:
        print("        the daemon accepts exactly this version; anything else and it kills the"
              " engine and the pane falls back")
    print(f"AGENT:  {agent or 'none'}")
    print(f"FRAME:  {len(frames)} event(s)")
    for event in frames[:2]:
        payload = event.split(" ", 2)[2] if event.count(" ") >= 2 else ""
        try:
            decoded = bytes.fromhex(payload)
        except ValueError:
            print("  UNDECODABLE HEX — a frame that cannot be decoded whole must not be delivered")
            continue
        print(f"  {len(payload)//2} bytes: {decoded[:110]!r}")
        # The one thing that proves it is this pane's frame and not another's.
        if f"i={IMAGE_ID}".encode() in decoded:
            print(f"  carries i={IMAGE_ID} — the image id from the ATTACH, not from the process")
    if other:
        print(f"OTHER:  {other[:6]}")
    print(f"exit:   {engine.returncode}")
    return 0 if frames else 1


if __name__ == "__main__":
    sys.exit(main())
