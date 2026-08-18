#!/usr/bin/env python3
"""Does ONE hosted engine render N panes at once, each its own image, without crossing them?

This is the question §6.5's gate turns on, and the one `bench/t1-host-harness.py` does not
answer: that harness attaches a single pane and proves the hosted path renders at all. Sharing
is only worth anything if N panes coexist — and the specific hazard is not "does it paint" but
"does pane A's image land in pane B's rectangle", which no unit test reaches and which one
attached pane cannot exhibit.

Measured against per-pane engines on real pages (DESIGN.md 5.1's table is ~600B pages, so it
understates the win): five panes cost 2504MB over 25 processes as separate engines, of which the
duplicated Node/V8 main term alone was 841MB — larger than the 765MB of renderers, i.e. more
memory went to duplicated runtime than to the pages themselves.

    python3 bench/host-multipane.py <electron-binary> <app-dir> [panes] [seconds]

What it checks, in the order that matters:

    1. every pane gets frames                 a pane that attaches and never paints is the
                                              failure the gate exists to prevent
    2. each frame carries its OWN image id    the crossing hazard: an addressed event whose
                                              payload names another pane's id would draw one
                                              page over another
    3. no pane starves another                a shared engine with one frame queue would let a
                                              busy pane monopolise it; the spread across panes
                                              is what shows that
    4. one process tree, not N                the whole point — reported as procs and RSS

Exit status is 0 only if every pane rendered and no frame carried the wrong id.
"""

import os
import subprocess
import sys
import time

# Distinct ids, spaced the way `paneFrameFileNames` expects them, so a crossed frame is
# unambiguous rather than an off-by-one.
IMAGE_ID_BASE = 4242
IMAGE_ID_STRIDE = 1000


def attach_line(pane, image_id, url, left):
    # task-2's wire literal, seq 16:
    #   @%N ATTACH <server> <gen> <imageId> <rate> <adaptive> <restore>
    #              <cols> <rows> <width> <height> <left> <top> <tty> <url>
    # Each pane gets its own origin so a frame drawn at the wrong offset is visible in the
    # geometry too, not only in the id.
    return (f"@{pane} ATTACH - 1 {image_id} 30 1 0 80 24 800 480 {left} 0 - {url}\n")


def input_line(pane, hex_bytes):
    return f"@{pane} INPUT {hex_bytes}\n".encode()


def visible_line(pane, window, tty):
    # The frontend's tmux client listing, not a boolean: line 0 is the pane's own placement and
    # the rest are clients. One client viewing this pane's window is what uncollapses the
    # surface; `VIS 1` would leave it collapsed and the run would measure silence.
    #
    # Each pane gets its OWN window and its own client tty, which is the realistic shape and the
    # one that can expose shared state: every pane in one window on one tty makes N pushes that
    # happen to agree, so a placement or tty set held once per process instead of once per pane
    # would look correct. Panes in different windows disagree, which is the point.
    payload = (f"harness\t{window}\t{pane}\n"
               f"{tty}\tharness\t{window}\t0\t{pane}\troot")
    return f"@{pane} VIS {payload.encode('utf8').hex()}\n"


def agent_call(sock_path, method, params=None):
    """One request over a pane's own agent socket, or None if it cannot be reached."""
    import json
    import socket as socketmod
    try:
        with socketmod.socket(socketmod.AF_UNIX, socketmod.SOCK_STREAM) as sock:
            sock.settimeout(3.0)
            sock.connect(sock_path)
            request = {"id": 1, "method": method, "params": params or {}}
            sock.sendall(json.dumps(request).encode() + b"\n")
            buf = b""
            while b"\n" not in buf:
                chunk = sock.recv(1 << 16)
                if not chunk:
                    break
                buf += chunk
            return json.loads(buf.split(b"\n", 1)[0]).get("result")
    except Exception:
        return None


def ask_diag(sock_path):
    return agent_call(sock_path, "diag")


# Installed in each pane so the page records what it actually received. Reading it back per pane is
# how input crossing is measured rather than inferred: a key one pane was sent must not appear in
# another pane's log.
KEY_RECORDER = (
    "(() => { if (!window.__twebKeys) { window.__twebKeys = [];"
    " window.addEventListener('keydown', (e) => window.__twebKeys.push(e.key), true); }"
    " return window.__twebKeys.length; })()"
)
KEY_READBACK = "(window.__twebKeys || []).join('')"


def process_tree(root):
    """(procs, rss_mb) for root and everything under it."""
    rows = []
    out = subprocess.run(["ps", "-eo", "pid=,ppid=,rss="], capture_output=True, text=True).stdout
    for line in out.strip().splitlines():
        parts = line.split()
        if len(parts) >= 3 and all(p.isdigit() for p in parts[:3]):
            rows.append((int(parts[0]), int(parts[1]), int(parts[2])))
    children, rss_of = {}, {}
    for pid, ppid, rss in rows:
        children.setdefault(ppid, []).append(pid)
        rss_of[pid] = rss
    stack, seen = [root], {root}
    while stack:
        for child in children.get(stack.pop(), []):
            if child not in seen:
                seen.add(child)
                stack.append(child)
    return len(seen), sum(rss_of.get(p, 0) for p in seen) / 1024


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    electron, app_dir = sys.argv[1], sys.argv[2]
    count = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    seconds = float(sys.argv[4]) if len(sys.argv) > 4 else 25.0

    # Real pages rather than about:blank: the renderer term is the honest part of the cost, and
    # an empty page hides both the memory and the frame sizes that make sharing worth measuring.
    urls = [
        "https://github.com/keyolk/tweb",
        "https://news.ycombinator.com",
        "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
        "https://doc.rust-lang.org/book/",
        "https://www.electronjs.org/docs/latest/api/web-contents",
        "https://example.com",
        "https://www.rust-lang.org",
        "https://nodejs.org/en/docs",
    ]
    panes = [(f"%{10 + i}", IMAGE_ID_BASE + i * IMAGE_ID_STRIDE, urls[i % len(urls)], i * 810)
             for i in range(count)]
    # Pane i lives in window @(i+1), viewed by its own client tty.
    windows = {pane: f"@{i + 1}" for i, (pane, _, _, _) in enumerate(panes)}
    ttys_of = {pane: f"/dev/ttys{900 + i}" for i, (pane, _, _, _) in enumerate(panes)}

    runtime = os.environ.get("TWEB_RUNTIME_DIR", "/tmp/host-multipane")
    os.makedirs(runtime, exist_ok=True)
    env = dict(os.environ)
    env["TWEB_MULTIPANE"] = "1"
    # Runs the host for real without declaring the protocol, so `twebd` keeps refusing and no
    # shipping path can reach it while this is being measured.
    env["TWEB_HOST_PREVIEW"] = "1"
    env["TWEB_SUPERVISOR_PID"] = str(os.getpid())
    env["TWEB_RUNTIME_DIR"] = runtime
    env["TWEB_USER_DATA_DIR"] = os.path.join(runtime, "ud")
    for name in ("TMUX", "TMUX_PANE", "TWEB_URL", "TWEB_VIEWPORT", "TWEB_IMAGE_ID",
                 "TWEB_PANE_ORIGIN", "TWEB_FRONTEND_PID"):
        env.pop(name, None)

    stderr = open(os.path.join(runtime, "engine.err"), "wb")
    engine = subprocess.Popen(
        [electron, "."], cwd=app_dir, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
    )

    started = time.time()
    frames = {pane: [] for pane, _, _, _ in panes}
    # Each pane announces its own agent socket, which is how `diag` is asked per pane below.
    sockets = {}
    crossed = []
    others = []
    attached = False
    attach_at = time.time() + 3.0
    repush_at = None
    frames_at_repush = {}
    input_probed = False
    probe_at = None
    detach_at = None
    detached = None
    recorder_installed = {}
    deadline = time.time() + seconds
    peak_procs, peak_rss = 0, 0.0
    sampled_at = 0.0
    os.set_blocking(engine.stdout.fileno(), False)
    buffered = b""

    def send_all():
        for pane, image_id, url, left in panes:
            engine.stdin.write(attach_line(pane, image_id, url, left).encode())
            engine.stdin.write(visible_line(pane, windows[pane], ttys_of[pane]).encode())
        engine.stdin.flush()

    def interleave_input():
        """Send pane A a partial escape sequence, then send pane B ordinary text.

        This is the crossing that a single parse buffer produces. `ESC [` is incomplete, so the
        parser keeps it and waits for the final byte; the next INPUT line appends to that same
        buffer. Delivered in pane B's scope, pane A's two leftover bytes are parsed as the start of
        pane B's sequence — so B's first characters are eaten, or worse, `ESC [ A` (cursor up) is
        synthesised in B out of bytes A sent. Each pane records what its page actually received,
        which is what the `keys` check below reads back.
        """
        a, b = panes[0][0], panes[-1][0]
        engine.stdin.write(input_line(a, "1b5b"))       # ESC [ — deliberately incomplete
        engine.stdin.write(input_line(b, "5b5b5b"))     # [[[ in the OTHER pane
        engine.stdin.flush()
        print(f"  [probe] t={time.time() - started:.1f}s partial escape to {a}, [[[ to {b}",
              flush=True)

    def detach_middle():
        """DETACH the middle pane and leave the rest running.

        Two failures this catches. The engine must not quit — one pane running out of tabs used to
        call `app.quit()`, which for a host is every other pane's page gone too. And the detached
        pane's windows must actually stop: they are per-pane now, so a `closePane` that forgets them
        leaves offscreen windows painting frames for a pane the registry no longer has.
        """
        pane = panes[len(panes) // 2][0]
        engine.stdin.write(f"@{pane} DETACH\n".encode())
        engine.stdin.flush()
        return pane

    def repush_first():
        """Re-assert the FIRST pane's visibility after every other pane has pushed its own.

        This is the ordering that catches per-process state standing in for per-pane state. The
        push is diffed against the tty set the engine believes this pane's clients are, so a set
        held once per process holds the LAST pane's clients — and every one of this pane's own
        clients then reads as "stopped showing this pane", which sends a Kitty delete to a terminal
        that is still displaying it. The pane goes blank while still being watched.

        The pane not painting afterwards is NOT the signal: an identical push is not a transition,
        so `becameVisible` is false and a static page correctly has nothing to redraw. The signal is
        the delete, which the engine logs.
        """
        pane = panes[0][0]
        engine.stdin.write(visible_line(pane, windows[pane], ttys_of[pane]).encode())
        engine.stdin.flush()

    try:
        while time.time() < deadline:
            try:
                chunk = os.read(engine.stdout.fileno(), 1 << 20)
            except BlockingIOError:
                chunk = b""
            if chunk:
                buffered += chunk
                while b"\n" in buffered:
                    line, buffered = buffered.split(b"\n", 1)
                    text = line.decode("utf8", "replace").strip()
                    if not text:
                        continue
                    if (text.startswith("READY ") or text.startswith("@")) and not attached:
                        attached = True
                        send_all()
                        repush_at = time.time() + (seconds - 3.0) * 0.6
                        probe_at = time.time() + (seconds - 3.0) * 0.3
                    for pane, _, _, _ in panes:
                        if text.startswith(f"@{pane} AGENT "):
                            sockets[pane] = text.split(" ", 2)[2]
                    matched = False
                    for pane, image_id, _, _ in panes:
                        if text.startswith(f"@{pane} FRAME "):
                            matched = True
                            payload = text.split(" ", 2)[2]
                            try:
                                decoded = bytes.fromhex(payload)
                            except ValueError:
                                crossed.append((pane, "undecodable hex"))
                                break
                            frames[pane].append(len(decoded))
                            # The crossing check: a frame addressed to this pane must not name
                            # another pane's image id. This is the failure that draws one page
                            # into another's rectangle, and it is silent without this assertion.
                            for other, other_id, _, _ in panes:
                                if other != pane and f"i={other_id}".encode() in decoded:
                                    crossed.append((pane, f"carries i={other_id} of {other}"))
                            break
                    if not matched and not text.startswith("@"):
                        others.append(text)
            else:
                time.sleep(0.02)
            if not attached and time.time() > attach_at:
                attached = True
                send_all()
                repush_at = time.time() + (seconds - 3.0) * 0.6
                probe_at = time.time() + (seconds - 3.0) * 0.3
            if detach_at is not None and time.time() > detach_at:
                detach_at = None
                detached = detach_middle()
            if repush_at is not None and time.time() > repush_at:
                repush_at = None
                frames_at_repush = {pane: len(frames[pane]) for pane, _, _, _ in panes}
                repush_first()
            # The input probe runs on its own tick, well before the end: it makes one agent call per
            # pane, and riding the re-push tick left the engine shutting down before the INPUT lines
            # were parsed — measured 1 of 5 delivered.
            if probe_at is not None and time.time() > probe_at and len(sockets) == len(panes):
                probe_at = None
                for pane_, path_ in sockets.items():
                    recorder_installed[pane_] = agent_call(path_, "eval", {"script": KEY_RECORDER})
                interleave_input()
                input_probed = True
                detach_at = time.time() + 4.0
            if engine.poll() is not None:
                break
            # `ps -eo` over every process on the box, once per loop iteration, made the loop the
            # slowest thing in the run: a 35s deadline took 94s of wall clock, and control lines
            # written at t=16.7s were still unparsed when it ended. Sampled once a second instead —
            # this is a peak-RSS measurement, and Electron does not allocate 500MB between samples.
            if time.time() - sampled_at >= 1.0:
                sampled_at = time.time()
                procs, rss = process_tree(engine.pid)
                peak_procs, peak_rss = max(peak_procs, procs), max(peak_rss, rss)
        # While the engine is still up: every pane it could not name from the ambient scope fell
        # back to the first pane. Painting can be 5/5 while an unbound entry point still routes one
        # pane's input or session state into another's, and that failure is invisible from out here
        # — the engine is the only thing that can see it, so ask it.
        diags = {pane: ask_diag(path) for pane, path in sockets.items()}
        keys = {pane: agent_call(path, "eval", {"script": KEY_READBACK})
                for pane, path in sockets.items()} if input_probed else {}
        # Whether the listener is still installed at readback. A page that navigated after the
        # recorder was installed loses it, and an empty key log then means nothing.
        alive = {pane: agent_call(path, "eval", {"script": "!!window.__twebKeys"})
                 for pane, path in sockets.items()} if input_probed else {}
    finally:
        try:
            engine.terminate()
            engine.wait(timeout=5)
        except Exception:
            engine.kill()
        stderr.close()

    print(f"=== one hosted engine, {count} panes, {seconds:.0f}s ===\n")
    painted = 0
    for pane, image_id, url, _ in panes:
        got = frames[pane]
        total = sum(got) / 1e6
        if got:
            painted += 1
        host = url.split("/")[2]
        after = len(got) - frames_at_repush.get(pane, len(got))
        print(f"  {pane:5s} i={image_id:<6d} {len(got):4d} frames  {total:6.1f}MB"
              + f"  {after:3d} after re-push  {host}")

    print(f"\n  panes painted     {painted}/{count}")
    print(f"  process tree      {peak_procs} procs, {peak_rss:.0f}MB peak")
    if painted:
        print(f"  per pane          {peak_rss/painted:.0f}MB, {peak_procs/painted:.1f} procs")
    print("\n  measured as separate engines (5 real pages): 501MB and 5.0 procs per pane")

    # A count above zero names a real defect even when every pane painted: some entry point resolved
    # its pane by falling back to the first one.
    first_pane = panes[0][0]
    try:
        log = open(os.path.join(runtime, "engine.err"), "r", errors="replace").read()
    except OSError:
        log = ""

    # Each pane pushed its own window and its own client tty, so each pane's own `diag` must report
    # its own back. State held once per process reports whichever pane pushed last for every pane,
    # which is a pane believing it lives in another pane's window — the placement its frames are
    # addressed by and the tty its image is deleted from.
    misplaced = []
    for pane, _, _, _ in panes:
        report = diags.get(pane)
        if not report:
            continue
        state = report.get("input", {}) or {}
        placement = state.get("tmuxPlacement") or {}
        ttys = state.get("visibleClientTtys") or []
        if placement.get("windowId") != windows[pane]:
            misplaced.append(f"{pane} in window {placement.get('windowId')}, pushed {windows[pane]}")
        elif ttys != [ttys_of[pane]]:
            misplaced.append(f"{pane} sees clients {ttys}, pushed [{ttys_of[pane]}]")

    # The engine logs every image it takes off a client tty. Every client in this run keeps watching
    # its pane for the whole run, so a legitimate eviction is impossible: any eviction at all is a
    # pane deleting an image off a terminal that is still displaying it.
    #
    # The pane and the tty in the line are what name the defect. Measured with visibility state
    # shared per process: `image evicted from /dev/ttys900 for %11` — pane %11 deleting the image on
    # %10's client, because it read %10's tty set as its own and every entry looked like a client
    # that had gone away.
    evicted = []
    for line in log.splitlines():
        if "image evicted from" in line:
            evicted.append(line.split("tweb: ", 1)[-1].strip())

    # Pane B was sent `[[[` and pane A two bytes of an incomplete escape (`ESC [`). One parse buffer
    # for N panes puts A's leftovers at the front of B's, so B sees a synthesised Escape instead of
    # its own brackets — measured before the fix: `%11 received '[Escape'`. And A, which typed
    # nothing complete, must have received nothing at all.
    crossed_input = []
    if input_probed and len(panes) >= 2:
        a, b = panes[0][0], panes[-1][0]
        got_a = (keys.get(a) or {}).get("value") if isinstance(keys.get(a), dict) else keys.get(a)
        got_b = (keys.get(b) or {}).get("value") if isinstance(keys.get(b), dict) else keys.get(b)
        if got_b != "[[[":
            crossed_input.append(f"{b} received {got_b!r}, was sent '[[['")
        # Pane A correctly ends up with `[Escape`: an ESC-prefixed sequence that never completes is a
        # real Escape key, so after the 35ms disambiguation window the parser delivers `[` and then
        # the Escape — to A, which is the pane that sent those bytes. What must not appear in A is a
        # bracket B typed, and A's own two bytes account for exactly the one it has.
        if got_a not in ("", "[Escape"):
            crossed_input.append(f"{a} received {got_a!r}, was sent only a partial escape")

    # After a DETACH: the other panes must still be painting, and the detached one must have stopped.
    # A survivor with nothing to redraw sends no frames, and these are static pages — so silence is
    # not the signal. What must not happen is the detached pane still painting into a pane the
    # registry no longer holds; that the survivors are still alive is what the `unreachable` check
    # covers, by excluding only the detached one.
    detach_problems = []
    if detached:
        # The engine's own log is the clock: everything before `closed <pane>` was in flight while
        # the DETACH sat unparsed, which is ordinary. A FRAME after it is a window still painting for
        # a pane the registry has dropped.
        closed_at = None
        for index, line in enumerate(log.splitlines()):
            if f"closed {detached}:" in line:
                closed_at = index
                break
        if closed_at is None:
            detach_problems.append(f"engine never reported closing {detached}")
        else:
            after = sum(1 for line in log.splitlines()[closed_at + 1:]
                        if "frame sent" in line or "patch sent" in line)
            if after > 0:
                detach_problems.append(f"frames still sent after {detached} closed ({after})")

    unscoped = 0
    unreachable = [pane for pane, _, _, _ in panes
                   if pane != detached and not diags.get(pane)]
    for report in diags.values():
        if report:
            unscoped = max(unscoped, int(report.get("panes", {}).get("unscopedResolutions", 0)))
    if input_probed:
        probed = [panes[0][0], panes[-1][0]]
        print(f"  input keys        "
              + ", ".join(f"{pane}={(keys.get(pane) or {}).get('value', keys.get(pane))!r}"
                          for pane in probed))
    if detached:
        print(f"  detach            {detached} closed, "
              + ("no frames after" if not detach_problems else detach_problems[0]))
    print(f"  evictions         {len(evicted)}"
          + (f"  — {evicted[0]}" if evicted else "  (no client stopped watching)"))
    print(f"  own placement     {count - len(misplaced)}/{count} panes"
          + (f"  — {misplaced[0]}" if misplaced else ""))
    print(f"  unscoped panes    {unscoped}"
          + (f"  ({len(unreachable)} pane(s) did not answer diag)" if unreachable else ""))

    if crossed:
        print("\n  CROSSED FRAMES — a pane received another pane's image:")
        for pane, why in crossed[:8]:
            print(f"    {pane}: {why}")
    if others:
        print(f"\n  engine said: {others[:4]}")

    ok = (painted == count and not crossed and unscoped == 0 and not unreachable
          and not misplaced and not evicted and not crossed_input and not detach_problems)
    reasons = []
    if painted != count:
        reasons.append(f"{count - painted} pane(s) silent")
    if crossed:
        reasons.append(f"{len(crossed)} crossed")
    if unscoped:
        reasons.append(f"{unscoped} unscoped pane resolution(s)")
    if unreachable:
        reasons.append(f"{len(unreachable)} pane(s) unreachable over their agent socket")
    if misplaced:
        reasons.append(f"{len(misplaced)} pane(s) hold another pane's tmux placement")
    if evicted:
        reasons.append(f"{len(evicted)} image(s) deleted off a client still watching the pane")
    if crossed_input:
        reasons.append(f"input crossed panes ({crossed_input[0]})")
    if detach_problems:
        reasons.append(detach_problems[0])
    print(f"\n{'PASS' if ok else 'FAIL'} — "
          + ("every pane rendered its own image in one engine, none resolved by fallback" if ok
             else ", ".join(reasons)))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
