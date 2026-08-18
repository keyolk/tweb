#!/usr/bin/env python3
"""Does Ghostty accept `o=z` — deflate-compressed pixel payloads?

`bench/payload-shrink.cjs` measures that deflating a whole frame takes the file write from 164%
of the 30fps budget down to 29%: 20.7MB becomes ~0.5MB and the write's p99 falls from 54.7ms to
9.6ms. DETAIL 8.5 measured that the file write is the *only* source of dropped frames, so if the
terminal really decompresses `o=z`, the drop problem is solved with zlib and no native code.

Nothing in this repository had probed `o=z`, so it was an assumption. This asks the terminal.

Must run on a bare tty, for the reason `bench/gfxprobe.py` gives: graphics responses do not
travel back through tmux DCS passthrough, so inside tmux every probe reads as a timeout. Launch
it in its own window:

    open -na /Applications/Ghostty.app --args \\
      -e /bin/sh -c "python3 bench/gfx-deflate.py /tmp/oz.txt; sleep 2"

Results go to argv[1]. Each case is judged by the terminal's own answer, not by eye:

    A  uncompressed, file medium     the control — proves the transfer path works at all
    B  o=z deflated, file medium     the test
    C  o=z with CORRUPT deflate data the negative — an OK here would mean the terminal
                                     never decompressed anything and B proves nothing
    D  o=z over the direct medium    whether compression is medium-independent

A real `o=z` implementation must accept B and reject C. Any other combination is reported as
inconclusive rather than as a pass.
"""
import base64, os, select, sys, termios, time, tty, zlib

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/oz.txt"
log = []

W = H = 64
PIXELS = bytes([220, 40, 200, 255]) * (W * H)          # magenta, so a channel error is visible too


def drain(t=1.0):
    buf = b""
    end = time.time() + t
    while time.time() < end:
        if not select.select([0], [], [], max(0, end - time.time()))[0]:
            break
        chunk = os.read(0, 65536)
        if not chunk:
            break
        buf += chunk
        if buf.endswith(b"\x1b\\"):
            time.sleep(0.04)
    return buf


def send(s):
    os.write(1, s.encode())


def b64(b):
    return base64.b64encode(b).decode()


def ok(r):
    return b";OK" in r


def note(k, v):
    log.append(f"{k}: {v}")


def temp_with(data, tag):
    path = f"/tmp/tweb-oz-{os.getpid()}-{tag}.bin"
    with open(path, "wb") as handle:
        handle.write(data)
    return path


old = termios.tcgetattr(0)
results = {}
try:
    tty.setraw(0)
    send("\x1b[2J\x1b[H")

    packed = zlib.compress(PIXELS, 1)

    # --- A. control: the same pixels, uncompressed, over the medium the engine uses.
    path_a = temp_with(PIXELS, "plain")
    send(f"\x1b_Ga=T,f=32,s={W},v={H},t=f,z=-1,C=1,c=20,r=10,i=9201;{b64(path_a.encode())}\x1b\\")
    r = drain()
    results["A"] = ok(r)
    note("A. uncompressed, t=f", f"{r!r} -> {'OK' if ok(r) else 'FAILED'}")

    # --- B. the test: identical pixels, deflated, declared o=z.
    path_b = temp_with(packed, "z")
    send(f"\x1b_Ga=T,f=32,o=z,s={W},v={H},t=f,z=-1,C=1,c=20,r=10,i=9202;{b64(path_b.encode())}\x1b\\")
    r = drain()
    results["B"] = ok(r)
    note("B. o=z deflated, t=f",
         f"{r!r} -> {'OK' if ok(r) else 'FAILED'} ({len(PIXELS)}B -> {len(packed)}B)")

    # --- C. the negative: o=z declared, but the bytes are not a valid deflate stream.
    # A terminal that answers OK here never decompressed anything, which would void B.
    path_c = temp_with(b"\x00\xff" * (len(packed) // 2), "bogus")
    send(f"\x1b_Ga=T,f=32,o=z,s={W},v={H},t=f,z=-1,C=1,c=20,r=10,i=9203;{b64(path_c.encode())}\x1b\\")
    r = drain()
    results["C"] = ok(r)
    note("C. o=z with corrupt data",
         f"{r!r} -> {'ACCEPTED (bad: no decompression happened)' if ok(r) else 'REJECTED (good)'}")

    # --- D. is compression independent of the transfer medium?
    send(f"\x1b_Ga=T,f=32,o=z,s={W},v={H},t=d,z=-1,C=1,c=20,r=10,i=9204;{b64(packed)}\x1b\\")
    r = drain()
    results["D"] = ok(r)
    note("D. o=z over t=d (direct)", f"{r!r} -> {'OK' if ok(r) else 'FAILED'}")

    for i in (9201, 9202, 9203, 9204):
        send(f"\x1b_Ga=d,d=I,i={i},q=2\x1b\\")
    for path in (path_a, path_b, path_c):
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, old)

if not results.get("A"):
    verdict = "INCONCLUSIVE - the uncompressed control failed; nothing else can be trusted"
elif results.get("B") and not results.get("C"):
    verdict = ("PASS - o=z is supported and really decompressed "
               "(valid stream accepted, corrupt stream rejected)")
elif results.get("B") and results.get("C"):
    verdict = ("INCONCLUSIVE - both the valid and the corrupt stream were accepted, "
               "so the terminal is not decompressing and o=z means nothing here")
else:
    verdict = "FAIL - o=z was rejected while the uncompressed control succeeded"

log.append("")
log.append(verdict)
if results.get("B"):
    log.append(f"medium independence: t=d {'also works' if results.get('D') else 'does NOT work'}")

open(OUT, "w").write("\n".join(log) + "\n")
