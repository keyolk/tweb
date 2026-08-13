#!/usr/bin/env python3
"""Does f=32 (raw RGBA) render correctly over t=f, the medium the shipping code uses?

This is the premise the whole-frame path rests on: `f=32` is independent of the transfer
medium, so raw pixels can travel over the same file transport a PNG did, and the encode
goes away. Nothing in the protocol reports whether the pixels were interpreted correctly,
so this one is judged by eye.

The image is deliberately asymmetric — a white band over a magenta/yellow split. A channel
swap turns the magenta blue; a stride error shears the split into a diagonal.

    python3 bench/raw-render.py /dev/ttysNNN          # draws it
    python3 bench/raw-render-cleanup.py /dev/ttysNNN  # removes it

argv[1] is the tty of a visible tmux pane (`tmux display-message -p '#{pane_tty}'`). The
image stays up until the cleanup script runs, so there is time to look at it.
"""
import os, sys, base64, tempfile, time
W, H = 1200, 560
tty_path = sys.argv[1]
fd = os.open(tty_path, os.O_WRONLY)

def gfx(header, payload=""):
    raw = f"\x1b_G{header}" + (f";{payload}" if payload else "") + "\x1b\\"
    os.write(fd, ("\x1bPtmux;" + raw.replace("\x1b", "\x1b\x1b") + "\x1b\\").encode())

# Left half magenta, right half yellow, plus a white band across the top third.
# Wrong channel order turns magenta blue; wrong stride shears the split.
row_top = bytes([255, 255, 255, 255]) * W
row_body = bytes([220, 40, 200, 255]) * (W // 2) + bytes([250, 220, 40, 255]) * (W - W // 2)
pixels = row_top * (H // 6) + row_body * (H - H // 6)

path = os.path.join(tempfile.gettempdir(), f"tweb-rawbig-{os.getpid()}.rgba")
open(path, "wb").write(pixels)
os.write(fd, b"\n" * 18 + b"\x1b[18A")
gfx(f"a=T,f=32,s={W},v={H},t=f,z=-1,C=1,c=60,r=16,i=9701,q=2",
    base64.b64encode(path.encode()).decode())
time.sleep(1.0)
os.unlink(path)
print(f"drew {W}x{H} raw RGBA ({len(pixels)/1e6:.1f}MB) as i=9701")
