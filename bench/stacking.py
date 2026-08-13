#!/usr/bin/env python3
"""Leave a base image with a patch placed over it on screen, so the stacking order
can be judged by eye. Nothing here is destructive: both image ids are deleted by
cleanup.py."""
import os, base64, time
def gfx(header, payload=""):
    raw = f"\x1b_G{header}" + (f";{payload}" if payload else "") + "\x1b\\"
    if os.environ.get("TMUX"):
        raw = "\x1bPtmux;" + raw.replace("\x1b", "\x1b\x1b") + "\x1b\\"
    os.write(1, raw.encode())
b64 = lambda b: base64.b64encode(b).decode()
red   = bytes([220, 40, 40, 255]) * (64 * 64)
green = bytes([40, 200, 80, 255]) * (16 * 16)

os.write(1, b"\n" * 14 + b"\x1b[14A")
gfx("a=T,f=32,s=64,v=64,t=d,z=-1,C=1,c=20,r=10,i=9310,q=2", b64(red))
time.sleep(0.5)
os.write(1, b"\x1b[s\x1b[4B\x1b[6C")
gfx("a=T,f=32,s=16,v=16,t=d,z=-1,C=1,c=4,r=2,i=9311,q=2", b64(green))
os.write(1, b"\x1b[u")
os.write(1, b"\x1b[12B\r\n")
