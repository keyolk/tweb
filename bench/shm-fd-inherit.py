#!/usr/bin/env python3
"""Can the SHM transfer be built without a native addon? No — and this records exactly why.

DETAIL 8.4 concluded a native module was required because Node cannot call `shm_open`: no
`node:ffi`, zero native dependencies, and on macOS the object lives in a PSXSHM namespace that
plain `open()` cannot reach. That reasoning has an obvious hole, and this script closes it.

The hole: Node does not have to CREATE the object. `crates/tweb-pane` already depends on `libc`
and already spawns the engine, so the Rust parent could create it, keep the fd, and let the child
inherit it — and Node writes to numeric fds happily. If that worked, the whole feature would be an
fd number on the command line plus `fs.writeSync`, and 8.4's cost estimate (napi, node-gyp,
per-platform binaries) would be wrong by an order of magnitude.

It does not work, and the reason is one layer below the fd:

    fd inherits fine          child fstat: size=20742144, mode=2720
    pwrite  -> ESPIPE         a shm object is not seekable
    write   -> ENXIO          a shm object does not support write() at all
    mmap    -> OK             which is the only way in, and Node has no mmap

So the blocker is not "Node cannot name the object" — passing the fd solves that completely. It is
that a POSIX shm object on macOS is a mapping, not a stream, and every route into it goes through
mmap. Nothing in Node's surface reaches mmap, so the bytes cannot get there without native code,
no matter which process opens it.

    python3 bench/shm-fd-inherit.py

Run this before anyone proposes the fd-inheritance shortcut again; it looks correct on paper and
fails only at the last step.
"""
import ctypes, mmap, os, subprocess, sys

MB = 20_736_000                      # 2880x1800x4, the frame size every 8.x measurement uses

libc = ctypes.CDLL("libc.dylib", use_errno=True)
libc.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_ushort]
libc.shm_open.restype = ctypes.c_int
libc.shm_unlink.argtypes = [ctypes.c_char_p]

O_CREAT, O_RDWR, O_EXCL = 0x200, 0x0002, 0x0800
name = f"/tweb-fdtest-{os.getpid()}".encode()

fd = libc.shm_open(name, O_CREAT | O_RDWR | O_EXCL, 0o600)
if fd < 0:
    sys.exit(f"shm_open failed: errno {ctypes.get_errno()}")
os.ftruncate(fd, MB)
os.set_inheritable(fd, True)         # the premise under test: the child must receive it

# --- 1. Does the fd survive into a child, and what can that child do with it?
script = """
const fs = require("node:fs");
const fd = Number(process.argv[1]);
const st = fs.fstatSync(fd);
console.log("inherited: size=" + st.size + " mode=" + st.mode.toString(8));
const buf = Buffer.alloc(4096, 0xa5);
for (const [label, fn] of [
  ["pwrite (offset given)", () => fs.writeSync(fd, buf, 0, buf.length, 0)],
  ["write (sequential)",    () => fs.writeSync(fd, buf, 0, buf.length)],
]) {
  try { fn(); console.log(label + ": OK"); }
  catch (e) { console.log(label + ": " + e.code); }
}
console.log("mmap: unavailable — Node exposes no API that reaches it");
"""
proc = subprocess.run(["node", "-e", script, str(fd)],
                      capture_output=True, text=True, close_fds=False)
print("what a child can do with an inherited shm fd:")
for line in proc.stdout.strip().splitlines():
    print(f"  {line}")
if proc.returncode != 0:
    print(f"  (child exited {proc.returncode}: {proc.stderr.strip().splitlines()[-1:]})")

# --- 2. Prove mmap is the way in, so the failures above are about the API and not the fd.
try:
    m = mmap.mmap(fd, 65536)
    m[0:4] = b"abcd"
    m.flush()
    m.close()
    mmap_ok = True
except OSError as error:
    mmap_ok = False
    print(f"  mmap from the parent also failed: {error}")

print(f"  mmap (from a runtime that has it): {'OK' if mmap_ok else 'FAILED'}")

libc.shm_unlink(name)
os.close(fd)

print("\nCONCLUSION: fd inheritance does not avoid the addon.")
print("A macOS shm object is a mapping, not a stream: write() is ENXIO and pwrite is ESPIPE.")
print("Only mmap reaches it, and Node exposes no mmap — so the bytes need native code")
print("regardless of which process opens the object.")
