# Which frame-egress wiring ships, and the primitive that makes it correct

Measured 2026-08-14 on macOS 25.6.0 (Darwin), tmux 3.5a, on the tree at `7fec514`.
Everything below is an experiment, not an inference from the source.

`bench/measurements/twebd-frame-transport-findings.md` settled two things by experiment and
this file does not re-litigate them: a process owning no pty **can** write Kitty graphics to a
pane tty and tmux forwards them byte-identically, and **a pty write is not atomic at any
size**, so two concurrent writers to one pane tty tear frames. What was left open is which
wiring ships, and what serialising it actually costs.

**Decision: frames go daemon → per-pane frontend → the frontend's own pty. The loser is
daemon → pane tty directly.** The direct route is 5.5µs/frame faster and loses on a number
1550× larger than its win: keeping a pane tty's identity honest costs a direct writer **8.5ms
per frame**, or a whole invalidation protocol, where the relay gets it for nothing.

The primitive that enforces the invariant on the chosen path is
`crates/tweb-pane/src/pane_writer.rs`.

---

## What was measured

`bench/frame-egress.py`, inlined at the bottom. 500 samples per route after 50 warmups, on a
raw pty whose master is continuously drained. The relay is a real forked child that does the
pty write **itself** and acks afterwards, so the clock only stops once the bytes reached the
pty — a parent that stopped the clock on its socket write would be measuring a socket.

Payloads are the frame shapes that actually ship: the 202 bytes the default file transport
puts on the tty (the 20.7MB of pixels go through a file and cross neither route), the 420-byte
caret-damage patch, and the 14KB line patch.

Four routes, because the honest comparison is not direct-vs-relay:

| route | what it is |
| --- | --- |
| `direct` | one `write()` to the pane tty. Fast and **wrong** — two writers per pane. |
| `direct+flock` | the same write inside `flock(LOCK_EX)` on a per-pane lock file. This is what the direct route would actually have to ship. |
| `direct+flock (contended)` | the same, with a second **process** taking that lock to write a caret — which `electron/main.cjs` does after every frame. |
| `relay` | socketpair to a forked child that owns the pty write, with an ack round trip. |
| `relay + caret` | the relay where the child also writes the caret. No lock: it is the only writer that exists. |

---

## Deliverable 1 — latency, syscalls, copies

### 202-byte file-transport frame — the shipping default

| route | p50 | p90 | p99 | syscalls/frame | payload copies |
| --- | --- | --- | --- | --- | --- |
| direct | **1.08µs** | 8.58µs | 27.17µs | 1 | 1 |
| direct+flock | 2.44µs | 8.62µs | 34.50µs | 3 | 1 |
| direct+flock (contended) | 3.00µs | 12.00µs | 39.96µs | 3 | 1 |
| relay | 6.54µs | **8.42µs** | **16.58µs** | 5 | 3 |
| relay + caret | 7.33µs | 13.08µs | 20.25µs | 6 | 3 |

The contended run is instrumented: the contender got **277 caret writes** through during the
500 frames, so the lock was genuinely fought over. An uninstrumented "contended" run whose
contender never ran is the failure mode that looks like a result — an earlier draft of this
harness had exactly that (a blocking stop-pipe read parked the child after one caret) and
reported flock as free.

Note the p90/p99 columns: **the relay is faster in the tail** (8.42/16.58 vs 8.58/27.17). The
ack round trip absorbs the pty's own jitter rather than adding to it. The relay's cost is a
median cost, not a tail cost.

### The other frame shapes

| shape | direct p50 | +flock | +flock contended | relay | relay+caret |
| --- | --- | --- | --- | --- | --- |
| patch 30×30 caret, 420 B | 1.58µs | 3.10µs | 5.69µs (361 contender writes) | 14.73µs | 11.88µs |
| patch 1440×120, 14 KB | 62.06µs | 64.48µs | 78.38µs (1117) | 82.67µs | 88.88µs |

At 14KB the pty write dominates and the routes converge — 62µs vs 83µs, where both are ~0.2%
of a 30fps budget. The discriminator lives at the small frame, which is the one that ships.

### Syscalls and copies, counted by construction

Traced counts are unavailable here (dtruss needs SIP off), so the harness issues every syscall
itself and the table is exact rather than sampled. Per-pane setup — the lock-file open, the
socketpair — is once per pane and is not in these numbers.

| route | write | flock | send/recv | total | payload copies |
| --- | --- | --- | --- | --- | --- |
| direct | 1 | 0 | 0 | 1 | 1 |
| direct+flock | 1 | 2 | 0 | 3 | 1 |
| relay | 1 | 0 | 4 | 5 | 3 |
| relay + caret | 2 | 0 | 4 | 6 | 3 |

The relay's two extra copies are 202 bytes each: **12 KB/s at 30fps**. Not a cost anyone can
find in a profile.

### What the relay costs at the three adaptive frame-rate tiers

`electron/frame-rate-policy.cjs`: adaptive gives idle 4fps and pins playback and active to the
configured maximum (default 30, ceiling 60). Relay minus direct at the 202-byte frame is
+5.46µs.

| tier | fps | relay overhead | % of frame budget |
| --- | --- | --- | --- |
| idle | 4 | 21.8 µs/s | 0.0022% |
| playback / active | 30 | 163.8 µs/s | 0.0164% |
| active, 60fps cap | 60 | 327.6 µs/s | 0.0328% |

For comparison, the flock the direct route needs costs 1.92µs of that 5.46µs back immediately
(7.7 / 57.6 / 115.2 µs/s at the three tiers). The genuine gap between the two shippable
designs — relay vs direct+flock-contended — is **3.54µs**, or 0.0106% of a 30fps budget.

At the highest tier the relay costs three ten-thousandths of one percent of the frame budget.
There is no tier at which this is the constraint.

---

## Deliverable 2 — the number that actually decided it

**A tty path is not a stable identity.** Recorded in the prior findings: pane `%452` held
`/dev/ttys072`, that pane died, and an unrelated later window came back on the **same**
`/dev/ttys072`. A daemon caching a tty per pane will eventually write one pane's page into
another pane.

A direct-writing daemon therefore has to re-resolve `#{pane_tty}`, or build an invalidation
protocol on the pane-died hook. Measured, 30 samples, `tmux display-message -p -t %304
"#{pane_tty}"`:

```json
{"p50_us": 8535.52, "p90_us": 10981.63, "p99_us": 12864.04, "tty": "/dev/ttys026"}
```

**8.5ms.** That is 25.6% of a 30fps frame budget and 51.2% of a 60fps one — **1550× the 5.5µs
the relay costs**. Per frame, the direct route is either paying that, or it is caching a tty
and is one pane death away from drawing a page into a stranger's pane.

The relay never has the problem. The frontend **is** the pty owner; there is nothing to
resolve and nothing to invalidate.

**The obvious rebuttal, and why it does not rescue the direct route.** That 8.5ms is dominated
by spawning a `tmux` child; a daemon holding a `tmux -C` control-mode connection would resolve
a pane tty for far less. True, and it does not change the verdict — it converts the cost from
a per-frame latency into a *fifth mechanism*: a long-lived control connection with its own
lifecycle, an event subscription to keep the mapping current, and reconnection handling, all
so a daemon can maintain a cache of state the frontend simply *is*. The argument does not rest
on the 8.5ms alone; the 8.5ms is what it costs to skip the mechanism.

---

## Deliverable 3 — the tearing, re-measured on this harness

Two writers on one raw pty: one emitting whole Kitty graphics commands, the other emitting the
caret reassert `main.cjs` fires after every frame. A tear is the caret's bytes landing between
`ESC _G` and its terminating `ESC \`. 1500 rounds each.

| bytes per write | torn / 1500, two writers | torn / 1500, one serialising writer |
| --- | --- | --- |
| 202 (file transport, as shipped) | 28 | **0** |
| 420 (caret patch) | 82 | **0** |
| 3072 (`GFX_CHUNK`) | 345 | **0** |
| 14000 (line patch) | 232 | **0** |

Consistent with the earlier run (2/1500 at 110B under lighter contention — one frame in 750).
Zero at every size when serialised, non-zero at every size when not. Serialisation, not size.

---

## The decision, stated plainly

**Ships: daemon → frontend → the frontend's own pty.**

**Loses: daemon → pane tty directly.** It measured 5.46µs/frame faster and lost anyway,
because that win has to buy back four things the relay has by construction:

1. **One writer per pane tty.** The direct route structurally has two — the daemon's frames
   and the frontend's own caret, cursor-shape and teardown-delete writes, which
   `crates/tweb-pane/src/lib.rs` (`write_kitty_delete`) and `electron/main.cjs` both issue
   today. A cross-process `flock` on every writer costs 1.92µs of the 5.46µs immediately, and
   only works if *every* writer participates.
2. **Honest tty identity**: 8.5ms per re-resolution, or an invalidation protocol.
3. **The visibility gate in the process that knows.** Under this machine's
   `allow-passthrough all`, tmux forwards a *hidden* pane's payload to whatever window the
   client is viewing, so the gate is load-bearing, not an optimisation. In a daemon it is a
   cache of someone else's state.
4. **`O_NOCTTY` discipline**, or the first pane's SIGHUP kills the process serving every other
   pane.

Four mechanisms, for 5.46µs — 1/6000th of a 30fps frame interval, and the relay is *faster*
in the tail anyway.

### What the direct route would still be worth

Nothing here rules it out as a later optimisation for a specific case (a full-screen pane, a
single-pane session) where the frontend hop is provably the bottleneck. It is not, at any
tier: 0.0328% of budget at 60fps.

### Not measured

Pty backpressure. If one pane's terminal stalls, a direct-writing daemon blocks in `write()`
and stalls every other pane it serves, whereas the relay confines that block to the per-pane
frontend. This points the same way but is untested; it is a hypothesis, not evidence.

---

## The writer primitive

`crates/tweb-pane/src/pane_writer.rs` — new file. The only edit outside it is one line in
`crates/tweb-pane/src/lib.rs` (`pub mod pane_writer;`).

```rust
PaneWriters::new()
PaneWriters::writer_for(pane, tty_path, open) -> io::Result<Arc<PaneWriter>>
PaneWriters::release(pane)

PaneWriter::write_sequence(&self, &[u8]) -> io::Result<()>
PaneWriter::write_batch(&self, &[&[u8]]) -> io::Result<()>
pane_writer::open_tty(path) -> io::Result<File>          // O_WRONLY | O_NOCTTY
pane_writer::count_torn_commands(&[u8]) -> usize
```

Four properties, each of which is a measured constraint rather than a design preference:

- **The sink is injected** (`Box<dyn Write + Send>`), and the tty open is a separate free
  function. That is what makes the invariant testable against a sink that tears on purpose.
- **The registry is keyed on pane id and validated against the tty path.** A changed tty drops
  the stale writer; two panes on one recycled path do not share one. Both directions of the
  `%452`/`ttys072` reuse are covered by a test.
- **`write_batch` is not a convenience.** `writeDirect` in `electron/gfx-worker.cjs` splits a
  base64 frame into hundreds of `ESC _G` commands chained with `m=1`. Every chunk is
  individually intact, but a *foreign graphics command* between two chunks corrupts the
  terminal's transfer state as thoroughly as a tear inside one. A multi-part transfer is one
  unit and must be one call.
- **A poisoned lock is recovered, not propagated.** A writer that panicked mid-sequence has
  already left a partial escape on the tty; refusing every subsequent write turns that into a
  pane that never draws again.

### The tearing regression test

The defect is a race that needs ~1500 writes to show once. Porting that into `cargo test`
would give a test that fails one run in a few hundred and proves nothing on any single run.

The first attempt at determinism was a `Barrier` releasing two threads together onto a sink
that writes one byte at a time with a yield between bytes. **It flaked ~50% of 20 runs** — the
barrier gets both threads to the starting line but does nothing to make them alternate, so the
frame thread routinely finished before the caret thread was scheduled and the test that must
observe a tear observed none. A test that fails intermittently *in the failing direction*, in
the file whose subject is determinism, is worse than no test.

What ships instead is a `LockstepSink` that forces the two writers to alternate through a
condvar, with a per-writer chunk size — 8 bytes for the caret (it lands whole, as a real one
does) and 16 for the frame (the kernel splits it, as a real one is). A writer that finishes
early marks itself done so the other cannot deadlock waiting for a turn. **100 consecutive
runs, zero flakes.**

The one-sided direction keeps the yielding sink: "no tears" cannot pass by luck, and the
lockstep sink would deadlock against a writer correctly holding a lock across a whole
sequence — which is the property under test.

Three tests carry the regression, and they only mean something together:

- `a_spliced_caret_reads_as_a_torn_command` — the detector fires on a hand-built tear and does
  *not* fire on a caret written legitimately between two commands. Without this the other two
  pass vacuously.
- `two_unserialised_writers_tear_frames` — two threads at the lockstep sink directly: tears >
  0, deterministically. This is the half that proves the test would have caught the 1-in-750.
- `one_serialising_writer_never_tears` — the same two threads through one `PaneWriter`: zero
  tears, and all 40 frames present, so serialisation dropped nothing either.

`a_chunked_transfer_admits_nothing_between_its_chunks` covers the `m=1` case: 20 eight-chunk
transfers against an intruding frame writer, asserting the whole transfer's byte string
appears 20 times contiguously.

Nine tests. `cargo fmt` clean, `cargo clippy -p tweb-pane --all-targets -D warnings` clean.

---

## Reproduction

```bash
python3 bench/frame-egress.py             # everything
python3 bench/frame-egress.py routes      # route latency, syscalls, tier arithmetic
python3 bench/frame-egress.py tear        # the tearing probe
python3 bench/frame-egress.py resolve %N  # cost of re-resolving #{pane_tty}
cargo test -p tweb-pane pane_writer       # the primitive and the regression
```

Traps this harness handles, each of which silently ruins the numbers:

- **The pty master must be drained.** With nobody reading, the kernel buffer fills after a few
  KB and every percentile past that measures the stall, not the route.
- **Fork before starting the drain thread.** A drain thread makes the process multi-threaded,
  and `os.fork()` from a multi-threaded Python deadlocks in the child. The first version of
  this harness produced a full JSON result with a deadlocked contender inside it.
- **Instrument the contender.** A "contended" run whose contender never ran reports flock as
  nearly free, which is a plausible number and a wrong one.
- **The relay child must write the pty itself and ack afterwards**, or the measurement is of a
  socketpair.
- **Join the pty reader's chunks before parsing.** A graphics command straddling two `read()`
  results manufactures a tear at every chunk boundary.

`bench/frame-egress.py` in this repo is the source of truth and is runnable as-is. It is
reproduced below so this file stands on its own, matching the two findings files beside it.

```python
#!/usr/bin/env python3
"""What each frame-egress wiring costs, and what serialising it costs on top.

`bench/measurements/twebd-frame-transport-findings.md` already settled two things by
experiment, and this harness does not re-litigate them: a process owning no pty CAN write
Kitty graphics to a pane tty and tmux forwards them byte-identically, and a pty write is not
atomic at any size, so two concurrent writers to one pane tty tear frames.

What was left unpriced is the thing that decides the wiring. The direct route
(daemon -> pane tty) is faster per frame, but it structurally has two writers per pane — the
daemon's frames and the frontend's own caret / cursor-shape / teardown-delete writes — so it
only becomes correct with a cross-process lock around every writer. Nobody had measured that
lock. This harness prices it, against the relay route (daemon -> frontend -> frontend's own
pty), whose single writer is free.

Four routes, same 202-byte payload the shipping file transport puts on the tty:

    direct              one write() to the pane tty. Fast and WRONG under two writers.
    direct+flock        the same write, wrapped in flock(LOCK_EX) on a per-pane lock file.
                        This is what the direct route actually has to ship.
    direct+flock (hot)  the same, with a second process contending for that lock — a caret
                        writer firing after every frame, which electron/main.cjs does today.
    relay               socketpair to a forked child that owns the pty write, with an ack
                        round trip so the clock only stops once the bytes reached the pty.

Every syscall is issued by this harness, so the syscall table is counted by construction
rather than traced (dtruss needs SIP off here).

    python3 bench/frame-egress.py            # everything
    python3 bench/frame-egress.py routes     # route latency only
    python3 bench/frame-egress.py tear       # the tearing probe only
    python3 bench/frame-egress.py resolve    # cost of re-resolving #{pane_tty}

Traps this harness handles, each of which silently ruins the numbers:

  * The pty master MUST be drained. With nobody reading, the kernel buffer fills after a few
    KB and every percentile past that measures the stall, not the route.
  * The relay child must write the pty ITSELF and ack afterwards. A parent that stops the
    clock on the socket write measures a socket, not a frame reaching a terminal.
  * flock uncontended is nearly free and says nothing. The number that matters is contended,
    because contention is the entire reason the lock exists.
"""

import fcntl
import json
import os
import pty
import statistics
import subprocess
import sys
import termios
import threading
import time
import tty as ttymod

ESC = "\x1b"

# The frame shapes that actually ship, from bench/measurements/twebd-frame-transport-findings.md.
# `file` is the default whole-frame transport: 20.7MB of pixels go through a file, and only a
# path crosses the tty. The patch sizes are what electron/main.cjs emits for damage.
SHAPES = [
    ("file whole frame", 202),
    ("patch 30x30 caret", 420),
    ("patch 1440x120", 14000),
]

SAMPLES = 500
WARMUP = 50

# electron/frame-rate-policy.cjs: adaptive gives idle 4fps and pins playback/active to the
# configured maximum, default 30, ceiling 60.
TIERS = [("idle", 4), ("playback/active", 30), ("active, 60fps cap", 60)]


def graphics_frame(nbytes):
    """A whole Kitty graphics command padded to `nbytes`, shaped like the shipping one."""
    head = f"{ESC}_Ga=T,i=9911,C=1,c=84,r=27,f=32,s=800,v=540,t=f,q=2;"
    tail = f"{ESC}\\"
    pad = nbytes - len(head) - len(tail)
    if pad < 1:
        raise ValueError(f"{nbytes} is smaller than an empty graphics command")
    return (head + "A" * pad + tail).encode()


# The caret reassert electron/main.cjs fires after EVERY frame. This is the second writer.
CARET = f"{ESC}[10;20H".encode()


def open_pty():
    """A raw pty. The master is NOT yet drained — see `start_drain`."""
    master, slave = pty.openpty()
    ttymod.setraw(slave, termios.TCSANOW)
    return master, slave


def start_drain(master, slave):
    """Drain the master continuously, and hand back a closer.

    Called only AFTER any fork. A drain thread makes the process multi-threaded, and forking
    a multi-threaded process is how this harness deadlocks in the child.
    """
    stop = threading.Event()

    def drain():
        while not stop.is_set():
            try:
                if not os.read(master, 1 << 16):
                    return
            except OSError:
                return

    thread = threading.Thread(target=drain, daemon=True)
    thread.start()

    def close():
        stop.set()
        os.close(slave)
        os.close(master)
        thread.join(timeout=1.0)

    return close


def percentiles(samples):
    ordered = sorted(samples)
    return {
        "p50_us": round(statistics.median(ordered) * 1e6, 2),
        "p90_us": round(ordered[int(len(ordered) * 0.90)] * 1e6, 2),
        "p99_us": round(ordered[int(len(ordered) * 0.99)] * 1e6, 2),
    }


# --- route: direct -----------------------------------------------------------------------


def route_direct(payload, n):
    master, fd = open_pty()
    close = start_drain(master, fd)
    try:
        for _ in range(WARMUP):
            os.write(fd, payload)
        out = []
        for _ in range(n):
            t0 = time.perf_counter()
            os.write(fd, payload)
            out.append(time.perf_counter() - t0)
        return out, 0
    finally:
        close()


# --- route: direct + cross-process flock -------------------------------------------------


def route_direct_flock(payload, n, contend):
    """The direct route as it would have to ship: every writer holds a per-pane-tty lock.

    `contend` forks a second process that takes the same lock to write the caret after every
    frame — the frontend writer the direct route cannot get rid of.
    """
    master, fd = open_pty()
    lock_path = f"/tmp/tweb-egress-lock-{os.getpid()}"
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    child = None
    stop_r, stop_w = os.pipe()
    # The contender reports how many carets it actually got through. A "contended" run whose
    # contender wrote nothing is the failure mode that looks like a result.
    count_r, count_w = os.pipe()
    close = None
    contender_writes = 0
    try:
        if contend:
            child = os.fork()
            if child == 0:
                # A separate process, so the lock is genuinely cross-process rather than a
                # thread mutex wearing a lock file's clothes.
                os.close(stop_w)
                # Non-blocking, or the child parks on the stop pipe after its first caret
                # and the "contended" run silently measures no contention at all.
                os.set_blocking(stop_r, False)
                clock = os.open(lock_path, os.O_RDWR)
                carets = 0
                try:
                    while True:
                        fcntl.flock(clock, fcntl.LOCK_EX)
                        os.write(fd, CARET)
                        fcntl.flock(clock, fcntl.LOCK_UN)
                        carets += 1
                        try:
                            if os.read(stop_r, 1):
                                break
                        except BlockingIOError:
                            pass
                finally:
                    os.write(count_w, str(carets).encode())
                    os._exit(0)
            os.close(stop_r)
            os.set_blocking(stop_w, False)

        close = start_drain(master, fd)
        for _ in range(WARMUP):
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            os.write(fd, payload)
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        out = []
        for _ in range(n):
            t0 = time.perf_counter()
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            os.write(fd, payload)
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            out.append(time.perf_counter() - t0)
        if child:
            os.write(stop_w, b"x")
            os.close(count_w)
            count_w = None
            reported = os.read(count_r, 32)
            contender_writes = int(reported or b"0")
            os.waitpid(child, 0)
            child = None
        return out, contender_writes
    finally:
        if child:
            try:
                os.kill(child, 9)
                os.waitpid(child, 0)
            except OSError:
                pass
        for handle in (stop_r if not contend else None, stop_w, count_r, count_w):
            if handle is not None:
                try:
                    os.close(handle)
                except OSError:
                    pass
        os.close(lock_fd)
        os.unlink(lock_path)
        if close:
            close()
        else:
            os.close(fd)
            os.close(master)


# --- route: relay ------------------------------------------------------------------------


def route_relay(payload, n, caret_after_frame):
    """daemon -> frontend -> frontend's own pty, with an ack so the frame provably landed.

    `caret_after_frame` makes the child ALSO write the caret after each frame — the same
    second write the contended flock case pays for, except here it needs no lock because the
    child is the only writer that exists.
    """
    master, fd = open_pty()
    import socket

    parent_sock, child_sock = socket.socketpair()
    child = os.fork()
    if child == 0:
        parent_sock.close()
        try:
            while True:
                data = child_sock.recv(1 << 16)
                if not data:
                    break
                os.write(fd, data)
                if caret_after_frame:
                    os.write(fd, CARET)
                child_sock.send(b"\x01")
        finally:
            os._exit(0)
    child_sock.close()
    close = start_drain(master, fd)
    try:
        for _ in range(WARMUP):
            parent_sock.send(payload)
            parent_sock.recv(1)
        out = []
        for _ in range(n):
            t0 = time.perf_counter()
            parent_sock.send(payload)
            parent_sock.recv(1)
            out.append(time.perf_counter() - t0)
        return out, 0
    finally:
        parent_sock.close()
        try:
            os.waitpid(child, 0)
        except OSError:
            pass
        close()


# Syscalls per frame, counted by construction from the loop bodies above. The lock file fd
# and the socketpair are opened once per pane, not per frame, so they do not appear here.
SYSCALLS = {
    "direct": {"write": 1, "flock": 0, "recv": 0, "send": 0, "total": 1},
    "direct+flock": {"write": 1, "flock": 2, "recv": 0, "send": 0, "total": 3},
    "direct+flock (contended)": {"write": 1, "flock": 2, "recv": 0, "send": 0, "total": 3},
    "relay": {"write": 1, "flock": 0, "recv": 2, "send": 2, "total": 5},
    "relay + caret": {"write": 2, "flock": 0, "recv": 2, "send": 2, "total": 6},
}

# Bytes copied user<->kernel per frame, counted the same way. The direct route copies the
# payload once. The relay copies it into the socket, out of the socket, then to the pty.
COPIES = {
    "direct": 1,
    "direct+flock": 1,
    "direct+flock (contended)": 1,
    "relay": 3,
    "relay + caret": 3,
}


def measure_routes():
    results = []
    for label, size in SHAPES:
        payload = graphics_frame(size)
        row = {"shape": label, "bytes": size, "routes": {}}
        for name, fn in [
            ("direct", lambda p: route_direct(p, SAMPLES)),
            ("direct+flock", lambda p: route_direct_flock(p, SAMPLES, contend=False)),
            (
                "direct+flock (contended)",
                lambda p: route_direct_flock(p, SAMPLES, contend=True),
            ),
            ("relay", lambda p: route_relay(p, SAMPLES, caret_after_frame=False)),
            ("relay + caret", lambda p: route_relay(p, SAMPLES, caret_after_frame=True)),
        ]:
            samples, contender_writes = fn(payload)
            stats = percentiles(samples)
            stats["syscalls"] = SYSCALLS[name]["total"]
            stats["payload_copies"] = COPIES[name]
            if contender_writes:
                stats["contender_writes"] = contender_writes
            row["routes"][name] = stats
        results.append(row)
    return results


# --- the tearing probe -------------------------------------------------------------------


def count_tears(chunks):
    """A tear is a foreign CSI landing between ESC _G and its terminating ESC \\.

    This is the detector the Rust regression test in crates/tweb-pane/src/pane_writer.rs
    reimplements; keeping them the same shape is the point.
    """
    torn = 0
    for chunk in chunks:
        start = 0
        while True:
            begin = chunk.find(b"\x1b_G", start)
            if begin < 0:
                break
            end = chunk.find(b"\x1b\\", begin)
            if end < 0:
                break
            if b"\x1b[" in chunk[begin:end]:
                torn += 1
            start = end + 2
    return torn


def probe_tearing(size, rounds, serialised):
    """Two writers on one pty, with and without a single serialising writer.

    Reads the master back rather than draining it, because the interleaving IS the result.
    """
    master, slave = pty.openpty()
    ttymod.setraw(slave, termios.TCSANOW)
    received = []
    stop = threading.Event()

    def drain():
        while not stop.is_set():
            try:
                data = os.read(master, 1 << 20)
            except OSError:
                return
            if not data:
                return
            received.append(data)

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()

    payload = graphics_frame(size)
    lock = threading.Lock()

    def write(data):
        if serialised:
            with lock:
                os.write(slave, data)
        else:
            os.write(slave, data)

    def frames():
        for _ in range(rounds):
            write(payload)

    def carets():
        for _ in range(rounds):
            write(CARET)

    a = threading.Thread(target=frames)
    b = threading.Thread(target=carets)
    a.start()
    b.start()
    a.join()
    b.join()
    time.sleep(0.3)
    stop.set()
    os.close(slave)
    os.close(master)
    reader.join(timeout=1.0)
    # The reader hands back arbitrary chunks; a command can straddle two of them, so join
    # before parsing or a tear is manufactured at every chunk boundary.
    return count_tears([b"".join(received)])


def measure_tearing():
    rounds = 1500
    out = []
    for label, size in SHAPES + [("direct-PNG chunk", 3072)]:
        out.append(
            {
                "shape": label,
                "bytes": size,
                "rounds": rounds,
                "torn_two_writers": probe_tearing(size, rounds, serialised=False),
                "torn_one_serialising_writer": probe_tearing(size, rounds, serialised=True),
            }
        )
    return out


# --- what the direct route must pay to keep the tty identity honest ----------------------


def measure_tty_resolution(pane_id):
    """`#{pane_tty}` is not a stable identity — a dead pane's tty comes back on a new pane.

    A daemon writing a pane tty directly has to re-resolve it or run an invalidation
    protocol; the relay never has the problem, because the frontend IS the pty owner.
    """
    cmd = ["tmux", "display-message", "-p", "-t", pane_id, "#{pane_tty}"]
    for _ in range(3):
        subprocess.run(cmd, capture_output=True)
    samples = []
    for _ in range(30):
        t0 = time.perf_counter()
        done = subprocess.run(cmd, capture_output=True)
        samples.append(time.perf_counter() - t0)
        if done.returncode != 0:
            return {"error": done.stderr.decode().strip()}
    stats = percentiles(samples)
    stats["tty"] = done.stdout.decode().strip()
    return stats


def tier_cost(delta_us):
    """What a per-frame overhead adds up to at each adaptive frame-rate tier."""
    return {
        name: {
            "fps": fps,
            "us_per_second": round(delta_us * fps, 1),
            "pct_of_frame_budget": round(delta_us / (1e6 / fps) * 100, 4),
        }
        for name, fps in TIERS
    }


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    out = {}
    if which in ("all", "routes"):
        out["routes"] = measure_routes()
        file_frame = out["routes"][0]["routes"]
        direct = file_frame["direct"]["p50_us"]
        out["tier_cost"] = {
            "relay_over_direct": tier_cost(file_frame["relay"]["p50_us"] - direct),
            "flock_contended_over_direct": tier_cost(
                file_frame["direct+flock (contended)"]["p50_us"] - direct
            ),
            "relay_over_flock_contended": tier_cost(
                file_frame["relay"]["p50_us"] - file_frame["direct+flock (contended)"]["p50_us"]
            ),
        }
    if which in ("all", "tear"):
        out["tearing"] = measure_tearing()
    if which in ("all", "resolve") and len(sys.argv) > 2:
        out["tty_resolution"] = measure_tty_resolution(sys.argv[2])
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
```
