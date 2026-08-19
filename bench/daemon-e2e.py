#!/usr/bin/env python3
"""Does the REAL daemon host real panes in one real engine?

`bench/host-multipane.py` speaks the engine's control protocol directly, which proves the engine
serves N panes but not that `twebd` will let it. Those are different claims, and the gap between
them is exactly where this project has been burned: an engine that declares itself ready before it
can paint makes the daemon stop refusing, which takes away the frontend's fallback and leaves a
blank pane with no diagnostic anywhere.

So this uses no fakes on either side. It starts `twebd serve` and sends `host` requests over its
unix socket the way `tweb __pane` does, and the daemon spawns the engine itself:

    python3 bench/daemon-e2e.py <twebd-binary> <electron-binary> <app-dir> [panes] [seconds]

What it checks:

    1. the daemon ACCEPTS the engine        `Hosted` rather than `HostRefused` — the READY
                                           handshake succeeded and the versions agreed
    2. every pane's frames come back        addressed to that pane, over that pane's own
                                           connection, carrying that pane's image id
    3. no frame carries another pane's id   the crossing hazard, through the daemon this time
    4. one engine for all of them           `status` reports one engine and N hosted panes

Exit status is 0 only if every pane was hosted and rendered its own image.
"""

import json
import os
import socket
import subprocess
import sys
import time

# Spaced the way the frontend allocates them: a pane owns `image_id + 1 ..= image_id + 8` for its
# damage patches, so a stride below 9 would make a crossing look like an off-by-one.
IMAGE_ID_BASE = 7000
IMAGE_ID_STRIDE = 1000
PROTOCOL = 2
TMUX_SERVER = "e2e-server"


def host_request(pane, image_id, url, left, tty, electron, app_dir):
    """The `host` request `tweb __pane` sends, with this pane's own geometry and image id."""
    return {
        "kind": "host",
        "pane": pane,
        "tmux_server": TMUX_SERVER,
        "pid": os.getpid(),
        "protocol": PROTOCOL,
        "image_id": image_id,
        "geometry": {"cols": 80, "rows": 24, "width": 800, "height": 480, "origin": [left, 0]},
        # Sent, not omitted. It is diagnostics only — the daemon does not write pane ttys, it
        # returns the bytes and the frontend writes them — but "the engine must not use this" is
        # exactly the kind of claim a harness has to exercise. Passing `None` here for months is
        # what let the engine treat the PATH as a file descriptor: `writeSync` rejected every frame
        # for every hosted pane, and the null branch this took hid it completely.
        "tty": tty,
        "engine_executable": electron,
        "engine_app_dir": app_dir,
        "url": url,
        # Per-pane, not per-process: a host serves panes whose frontends were launched with
        # different `--tweb-frame-rate` settings, and the adaptive tiers are decided by counting
        # THAT pane's paints.
        "frame_rate": 30,
        "adaptive_frame_rate": True,
        "restore_session": False,
    }


def visibility_request(pane, generation, window, tty):
    """The client listing that uncollapses the pane's surface, as a `control` request.

    A pane starts hidden and is revealed by its frontend's push, so without this the run measures
    silence. The daemon forwards `body` to the engine verbatim (`engine.control`), which is the same
    `VIS <hex>` line `bench/host-multipane.py` writes on stdin — so this exercises the routing the
    daemon adds rather than a second protocol.

    Each pane gets its own window and client tty: panes in one tmux window on one tty make N pushes
    that agree, which is how shared placement state looks correct when it is not.

    The generation comes from the `Hosted` response. A control line carrying a stale one is dropped,
    because tmux reuses pane ids and a dead predecessor's `RESIZE` would otherwise resize whatever
    page took its place.
    """
    payload = (f"e2e\t{window}\t{pane}\n"
               f"{tty}\te2e\t{window}\t0\t{pane}\troot")
    return {
        "kind": "control",
        "pane": pane,
        "tmux_server": TMUX_SERVER,
        "generation": generation,
        "body": f"VIS {payload.encode('utf8').hex()}",
    }


class PaneConn:
    """One frontend's connection: it sends `host` and then reads that pane's frames back."""

    def __init__(self, socket_path, pane, image_id):
        self.pane = pane
        self.image_id = image_id
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(10.0)
        self.sock.connect(socket_path)
        self.buf = b""
        self.frames = []
        self.rendered = 0
        self.crossed = []
        self.hosted = None
        self.refusal = None

    def send(self, request):
        self.sock.sendall(json.dumps(request).encode() + b"\n")

    def drain(self, others):
        """Reads whatever is pending, classifying responses. Non-blocking."""
        self.sock.setblocking(False)
        try:
            while True:
                try:
                    chunk = self.sock.recv(1 << 20)
                except (BlockingIOError, socket.error):
                    break
                if not chunk:
                    break
                self.buf += chunk
        finally:
            self.sock.setblocking(True)
            self.sock.settimeout(10.0)
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except ValueError:
                continue
            kind = message.get("kind")
            if kind == "hosted":
                self.hosted = message
            elif kind == "host_refused":
                self.refusal = message
            elif kind == "error":
                # The daemon answers a bad request rather than disconnecting, so a missing field
                # reads as "no reply" unless it is surfaced here. Measured: an early version of this
                # harness omitted `frame_rate` and every pane looked refused with no reason.
                self.refusal = {"reason": "malformed", "detail": message.get("message")}
            elif kind == "attached":
                # Registered but NOT hosted: the frontend would spawn its own engine here, so for
                # this harness it is a refusal by another name.
                self.refusal = {"reason": "attached-not-hosted", "detail": json.dumps(message)}
            elif kind == "frame":
                payload = message.get("payload", "")
                try:
                    decoded = bytes.fromhex(payload)
                except ValueError:
                    self.crossed.append("undecodable payload")
                    continue
                self.frames.append(len(decoded))
                # A frame carrying THIS pane's image id is the only thing that proves a page was
                # drawn. Counting frame events instead passed a run where every VIS was silently
                # dropped: the one frame each pane received was an 11-byte cursor-hide sequence
                # (`ESC [ ?25l ESC [ 0 q`), which is a frame event and not a picture.
                if f"i={self.image_id}".encode() in decoded:
                    self.rendered += 1
                # The crossing check, now through the daemon: a frame delivered on THIS pane's
                # connection must not carry another pane's image id.
                for other_id, other_pane in others:
                    if other_id != self.image_id and f"i={other_id}".encode() in decoded:
                        self.crossed.append(f"carries i={other_id} of {other_pane}")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def daemon_status(twebd, runtime):
    out = subprocess.run([twebd, "status", "--runtime-dir", runtime],
                         capture_output=True, text=True, timeout=20)
    return (out.stdout + out.stderr).strip()


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 2
    twebd, electron, app_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    count = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    seconds = float(sys.argv[5]) if len(sys.argv) > 5 else 30.0

    urls = [
        "https://example.com",
        "https://news.ycombinator.com",
        "https://www.rust-lang.org",
        "https://doc.rust-lang.org/book/",
        "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
    ]
    # Real pane ids from a namespace no live tmux server issues, under an explicit tmux server name
    # — the registry keys on both halves, so this cannot collide with the user's own panes.
    panes = [(f"%{500 + i}", IMAGE_ID_BASE + i * IMAGE_ID_STRIDE, urls[i % len(urls)], i * 810)
             for i in range(count)]
    # A plausible tty path per pane. It is never opened by anything here — that is the point: the
    # engine must not open it either, and a harness that omits the field cannot say so.
    ttys_of = {pane: f"/dev/ttys{700 + i}" for i, (pane, _, _, _) in enumerate(panes)}

    runtime = os.environ.get("TWEB_E2E_RUNTIME_DIR", "/tmp/tweb-daemon-e2e")
    os.makedirs(runtime, exist_ok=True)
    socket_path = os.path.join(runtime, "twebd.sock")
    for stale in (socket_path, os.path.join(runtime, "twebd.lock")):
        try:
            os.unlink(stale)
        except OSError:
            pass

    env = dict(os.environ)
    env["TWEB_RUNTIME_DIR"] = runtime
    env["TWEB_USER_DATA_DIR"] = os.path.join(runtime, "ud")
    # The daemon must not inherit a pane identity: it spawns the engine, and an engine that derived
    # anything per-pane from its own environment would be deriving it from the daemon's.
    for name in ("TMUX", "TMUX_PANE", "TWEB_URL", "TWEB_VIEWPORT", "TWEB_IMAGE_ID",
                 "TWEB_PANE_ORIGIN", "TWEB_FRONTEND_PID", "TWEB_MULTIPANE"):
        env.pop(name, None)

    daemon_log = open(os.path.join(runtime, "twebd.err"), "wb")
    daemon = subprocess.Popen([twebd, "serve", "--runtime-dir", runtime], env=env,
                              stdout=daemon_log, stderr=subprocess.STDOUT)

    conns = []
    try:
        for _ in range(60):
            if os.path.exists(socket_path):
                break
            if daemon.poll() is not None:
                print(f"FAIL — twebd exited before binding its socket (rc={daemon.returncode})")
                return 1
            time.sleep(0.25)
        else:
            print("FAIL — twebd never bound its socket")
            return 1

        others = [(image_id, pane) for pane, image_id, _, _ in panes]
        for pane, image_id, url, left in panes:
            conn = PaneConn(socket_path, pane, image_id)
            conn.send(host_request(pane, image_id, url, left, ttys_of[pane], electron, app_dir))
            conns.append(conn)
            # The engine is spawned on the first host request and the READY handshake has a 10s
            # budget, so the first response can take seconds. Reading here rather than after the
            # loop keeps each connection's buffer from growing unread.
            time.sleep(0.5)
            for c in conns:
                c.drain(others)

        # Reveal each pane once it is hosted.
        deadline = time.time() + seconds
        revealed = set()
        while time.time() < deadline:
            for conn in conns:
                conn.drain(others)
                if conn.hosted and conn.pane not in revealed:
                    revealed.add(conn.pane)
                    index = [p for p, _, _, _ in panes].index(conn.pane)
                    conn.send(visibility_request(conn.pane, conn.hosted.get("generation"),
                                                 f"@{index + 1}", f"/dev/ttys{800 + index}"))
            time.sleep(0.2)
        for conn in conns:
            conn.drain(others)

        status = daemon_status(twebd, runtime)
    finally:
        for conn in conns:
            conn.close()
        try:
            daemon.terminate()
            daemon.wait(timeout=10)
        except Exception:
            daemon.kill()
        daemon_log.close()

    print(f"=== real twebd, real engine, {count} panes, {seconds:.0f}s ===\n")
    hosted = 0
    painted = 0
    crossed = []
    for conn in conns:
        state = "hosted" if conn.hosted else f"REFUSED {conn.refusal}"
        if conn.hosted:
            hosted += 1
        if conn.rendered:
            painted += 1
        crossed.extend(f"{conn.pane}: {why}" for why in conn.crossed)
        print(f"  {conn.pane:6s} i={conn.image_id:<6d} {len(conn.frames):4d} frames,"
              f" {conn.rendered:3d} with its own image  {sum(conn.frames)/1e6:6.1f}MB  {state}")

    print(f"\n  hosted            {hosted}/{count}")
    print(f"  rendered          {painted}/{count}  (frames carrying the pane's own image id)")
    print(f"  protocol          {conns[0].hosted.get('protocol') if conns[0].hosted else 'n/a'}")
    print(f"\n  twebd status: {status}")
    if crossed:
        print("\n  CROSSED FRAMES — a pane received another pane's image:")
        for why in crossed[:8]:
            print(f"    {why}")

    ok = hosted == count and painted == count and not crossed
    reasons = []
    if hosted != count:
        reasons.append(f"{count - hosted} pane(s) refused by the daemon")
    if painted != count:
        reasons.append(f"{count - painted} pane(s) never sent a frame carrying their own image id")
    if crossed:
        reasons.append(f"{len(crossed)} crossed frame(s)")
    print(f"\n{'PASS' if ok else 'FAIL'} — "
          + ("the daemon hosted every pane in one engine, each rendering its own image" if ok
             else ", ".join(reasons)))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
