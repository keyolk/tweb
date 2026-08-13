#!/usr/bin/env python3
"""Delete the image raw-render.py left on screen.

    python3 bench/raw-render-cleanup.py /dev/ttysNNN
"""
import os
import sys

fd = os.open(sys.argv[1], os.O_WRONLY)
raw = "\x1b_Ga=d,d=I,i=9701,q=2\x1b\\"
os.write(fd, ("\x1bPtmux;" + raw.replace("\x1b", "\x1b\x1b") + "\x1b\\").encode())
