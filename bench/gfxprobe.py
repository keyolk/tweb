#!/usr/bin/env python3
"""Kitty graphics capability probe — the shm medium and the patch-overlay mechanism.

Instead of looking at the screen, this asks the terminal to prove each step through the
protocol itself: is a shm transfer really read, does a patch placement land, and does
deleting the patch leave the base image alive.

Must run on a bare tty. Graphics responses do not travel back through tmux DCS passthrough
(hence the q=2 everywhere in the shipping code), so inside tmux every probe reads as a
timeout. Launch it in its own terminal window:

    open -na /Applications/Ghostty.app --args \
      -e /bin/sh -c "python3 bench/gfxprobe.py /tmp/gfxprobe.txt; sleep 2"

Results are written to the path given as argv[1]; see DETAIL.md section 8.2.
"""
import os, sys, termios, tty, select, ctypes, ctypes.util, base64, time, mmap

OUT = sys.argv[1]
log = []
libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
libc.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_ushort]
libc.shm_open.restype = ctypes.c_int
libc.shm_unlink.argtypes = [ctypes.c_char_p]

def make_shm(payload, tag):
    name = f"/tweb-q{os.getpid()}-{tag}"
    fd = libc.shm_open(name.encode(), 0x200 | 0x0002 | 0x0800, 0o600)
    if fd < 0: return None
    os.ftruncate(fd, len(payload))
    m = mmap.mmap(fd, len(payload), mmap.MAP_SHARED, mmap.PROT_WRITE)
    m[:] = payload; m.flush(); m.close(); os.close(fd)
    return name

def drain(t=1.0):
    buf = b""; end = time.time() + t
    while time.time() < end:
        if not select.select([0], [], [], max(0, end - time.time()))[0]: break
        c = os.read(0, 65536)
        if not c: break
        buf += c
        if buf.endswith(b"\x1b\\"): time.sleep(0.04)
    return buf

def send(s): os.write(1, s.encode())
def b64(b): return base64.b64encode(b).decode()
def ok(r): return b";OK" in r
def note(k, v): log.append(f"{k}: {v}")

old = termios.tcgetattr(0)
try:
    tty.setraw(0)
    send("\x1b[2J\x1b[H")
    W = H = 64
    red   = bytes([220, 40, 40, 255]) * (W * H)
    green = bytes([40, 200, 80, 255]) * (16 * 16)

    # --- A. Is an UNDERSIZED shm transfer actually rejected on real transfer (a=T)? ---
    # a=q answered OK even when undersized, so a=q never reads the payload. a=T must.
    n_small = make_shm(red[:len(red)//2], "small")
    send(f"\x1b_Ga=T,f=32,s={W},v={H},t=s,i=9102;{b64(n_small.encode())}\x1b\\")
    r = drain()
    note("A. a=T t=s undersized", f"{r!r} -> {'ACCEPTED (terminal did not size-check)' if ok(r) else 'REJECTED (terminal really read the shm)'}")
    libc.shm_unlink(n_small.encode())

    # --- B. Does a=T,t=s consume the shm object? Only a terminal that opened it can unlink it. ---
    n_ok = make_shm(red, "ok")
    send(f"\x1b_Ga=T,f=32,s={W},v={H},t=s,z=-1,C=1,c=20,r=10,i=9101;{b64(n_ok.encode())}\x1b\\")
    note("B1. a=T t=s correct size", repr(drain()))
    time.sleep(0.3)
    fd = libc.shm_open(n_ok.encode(), 0x0002, 0o600)
    consumed = fd < 0
    if fd >= 0: os.close(fd); libc.shm_unlink(n_ok.encode())
    note("B2. shm consumed by terminal", f"{consumed} (kitty spec: the terminal unlinks after reading)")

    # --- C. THE H1 MECHANISM: place a patch over a base, then delete only the patch. ---
    # If the terminal keeps both images independently, a=d,d=i on the patch must leave the base.
    send("\x1b[2J\x1b[H")
    send(f"\x1b_Ga=T,f=32,s={W},v={H},t=d,z=-1,C=1,c=20,r=10,i=9110;{b64(red)}\x1b\\")
    note("C1. base transmit+place", repr(drain()))
    send("\x1b[5;6H")
    send(f"\x1b_Ga=T,f=32,s=16,v=16,t=d,z=-1,C=1,c=4,r=2,i=9111;{b64(green)}\x1b\\")
    note("C2. patch transmit+place over base", repr(drain()))

    # Ask the terminal which image ids it still holds, by re-placing each (a=p) —
    # a=p on a live image answers OK, on an evicted/unknown one it errors (ENOENT).
    send("\x1b_Ga=p,i=9110,C=1,c=20,r=10,q=0\x1b\\")
    r_base = drain(0.8)
    send("\x1b_Ga=p,i=9111,C=1,c=4,r=2,q=0\x1b\\")
    r_patch = drain(0.8)
    note("C3. base id alive after patch", f"{r_base!r} -> {ok(r_base)}")
    note("C4. patch id alive", f"{r_patch!r} -> {ok(r_patch)}")

    # Delete the patch image only.
    send("\x1b_Ga=d,d=I,i=9111,q=0\x1b\\")
    drain(0.5)
    send("\x1b_Ga=p,i=9110,C=1,c=20,r=10,q=0\x1b\\")
    r_base2 = drain(0.8)
    send("\x1b_Ga=p,i=9111,C=1,c=4,r=2,q=0\x1b\\")
    r_patch2 = drain(0.8)
    note("C5. base SURVIVES patch delete", f"{r_base2!r} -> {ok(r_base2)}")
    note("C6. patch gone after delete", f"{r_patch2!r} -> {'still alive (BAD)' if ok(r_patch2) else 'gone (correct)'}")

    # --- D. How many independent image ids can coexist? A patch path mints one per damage. ---
    tiny = bytes([10, 10, 200, 255]) * (8 * 8)
    alive = 0
    for k in range(64):
        send(f"\x1b_Ga=t,f=32,s=8,v=8,t=d,i={9200+k};{b64(tiny)}\x1b\\")
        if ok(drain(0.3)): alive += 1
    note("D. 64 sequential image ids accepted", alive)
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, old)
open(OUT, "w").write("\n".join(log) + "\n")
