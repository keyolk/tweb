#!/usr/bin/env python3
"""Does t=s survive tmux passthrough? Judged by whether the terminal consumed the object.

Every other t=s probe here runs on a bare tty, because graphics responses do not come back
through passthrough. This one infers the answer instead: a terminal that read an shm object
unlinks it, so the name disappearing is proof it was consumed.

A temp-file transfer goes out alongside as the control, since that is the medium the
shipping code already uses. Read the two together:

    shm consumed, file consumed       -> t=s works through passthrough
    shm not consumed, file consumed   -> passthrough is fine, t=s specifically is not
    neither consumed                  -> says nothing about t=s (see below)

**The pane must be visible.** Ghostty does not read an image for a pane it is not drawing,
so in a hidden pane nothing is consumed — including the control — and the run looks like a
protocol failure when it is only a visibility one.

    python3 bench/shm-through-tmux.py /dev/ttysNNN /tmp/result.txt

argv[1] is the tty of a visible tmux pane (`tmux display-message -p '#{pane_tty}'`); the
result goes to argv[2], since stdout is that pane.
"""
import os, sys, ctypes, ctypes.util, base64, time, mmap, tempfile

W, H = 800, 400
size = W * H * 4
libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
libc.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_ushort]
libc.shm_open.restype = ctypes.c_int
libc.shm_unlink.argtypes = [ctypes.c_char_p]
tty_path, out_path = sys.argv[1], sys.argv[2]
fd_out = os.open(tty_path, os.O_WRONLY)

def gfx(header, payload=""):
    raw = f"\x1b_G{header}" + (f";{payload}" if payload else "") + "\x1b\\"
    raw = "\x1bPtmux;" + raw.replace("\x1b", "\x1b\x1b") + "\x1b\\"
    os.write(fd_out, raw.encode())

pixels = bytes([40, 200, 120, 255]) * (W * H)

# --- t=s
name = f"/tweb-c{os.getpid()}"
fd = libc.shm_open(name.encode(), 0x200 | 0x0002 | 0x0800, 0o600)
os.ftruncate(fd, size)
m = mmap.mmap(fd, size, mmap.MAP_SHARED, mmap.PROT_WRITE); m[:] = pixels; m.flush(); m.close(); os.close(fd)
gfx(f"a=T,f=32,s={W},v={H},t=s,z=-1,C=1,c=30,r=10,i=9601,q=2", base64.b64encode(name.encode()).decode())
time.sleep(1.0)
probe = libc.shm_open(name.encode(), 0x0002, 0o600)
shm_consumed = probe < 0
if probe >= 0: os.close(probe); libc.shm_unlink(name.encode())

# --- t=f control: the terminal deletes a temporary file it read
tmp = os.path.join(tempfile.gettempdir(), f"tweb-probe-{os.getpid()}.rgba")
open(tmp, "wb").write(pixels)
gfx(f"a=T,f=32,s={W},v={H},t=t,z=-1,C=1,c=30,r=10,i=9602,q=2", base64.b64encode(tmp.encode()).decode())
time.sleep(1.0)
file_consumed = not os.path.exists(tmp)
if not file_consumed: os.unlink(tmp)

gfx("a=d,d=I,i=9601,q=2"); gfx("a=d,d=I,i=9602,q=2")
open(out_path, "w").write(
    f"through tmux passthrough:\n  t=s shm consumed: {shm_consumed}\n  t=t temp-file consumed: {file_consumed}\n")
