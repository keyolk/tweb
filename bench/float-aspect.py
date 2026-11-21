#!/usr/bin/env python3
"""Does a floating page keep its viewer's shape when the pane changes size?

The viewer draws each frame over its whole window, so a frame of any other shape comes out
stretched. The once-a-second surface reconciler sized a float that was not fullscreen from the
pane, so a viewer the user had resized, or a pane resized underneath it, left the page laid out at
the pane's shape. This floats a pane (a real OS window opens for a few seconds), resizes the pane,
waits past two reconciler ticks, and compares the page's size with the size it floated at.

  python3 bench/float-aspect.py [--tweb PATH]

Set TWEB_ELECTRON_DIR=$PWD/electron to run this checkout's app code. Exits non-zero on a mismatch.
"""

import argparse
import fcntl
import json
import struct
import sys
import tempfile
import termios
import time

from feel import REPO, Pane, serve_fixtures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tweb", default=str(REPO / "target" / "release" / "tweb"))
    args = parser.parse_args()
    server, base = serve_fixtures()
    pane = Pane(args.tweb, "electron", f"{base}/text.html", tempfile.gettempdir(), (160, 50, 1280, 800), tmux=True)

    def size():
        code, out, err = pane.agent("eval", "JSON.stringify([outerWidth, outerHeight])")
        if code != 0:
            raise RuntimeError(err)
        return tuple(json.loads(json.loads(out) if out.startswith('"') else out))

    try:
        if not pane.wait_ready():
            print("FAIL: pane never became ready")
            return 1
        pinned = size()
        pane.agent("float")
        time.sleep(2.5)
        floated = size()
        # A pane half as wide and taller: a different shape from the viewer that opened.
        fcntl.ioctl(pane.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 80, 640, 1000))
        time.sleep(3)
        after = size()
        pane.agent("pin")
        time.sleep(2)
        repinned = size()
        print(f"pinned {pinned}  floating {floated}  pane resized while floating {after}  pinned again {repinned}")
        ok = after == floated and repinned != floated
        print("ok" if ok else "FAIL: the floating page took the pane's shape, not its viewer's")
        return 0 if ok else 1
    finally:
        pane.close()
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
