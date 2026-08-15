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
