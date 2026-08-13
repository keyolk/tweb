import os
def gfx(h):
    raw = f"\x1b_G{h}\x1b\\"
    if os.environ.get("TMUX"): raw = "\x1bPtmux;" + raw.replace("\x1b","\x1b\x1b") + "\x1b\\"
    os.write(1, raw.encode())
gfx("a=d,d=I,i=9311,q=2"); gfx("a=d,d=I,i=9310,q=2")
