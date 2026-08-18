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


def visible_line(pane):
    # The frontend's tmux client listing, not a boolean: line 0 is the pane's own placement and
    # the rest are clients. One client viewing this pane's window is what uncollapses the
    # surface; `VIS 1` would leave it collapsed and the run would measure silence.
    payload = (f"harness\t@1\t{pane}\n"
               f"/dev/ttys999\tharness\t@1\t0\t{pane}\troot")
    return f"@{pane} VIS {payload.encode('utf8').hex()}\n"


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

    frames = {pane: [] for pane, _, _, _ in panes}
    crossed = []
    others = []
    attached = False
    attach_at = time.time() + 3.0
    deadline = time.time() + seconds
    peak_procs, peak_rss = 0, 0.0
    os.set_blocking(engine.stdout.fileno(), False)
    buffered = b""

    def send_all():
        for pane, image_id, url, left in panes:
            engine.stdin.write(attach_line(pane, image_id, url, left).encode())
            engine.stdin.write(visible_line(pane).encode())
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
            if engine.poll() is not None:
                break
            procs, rss = process_tree(engine.pid)
            peak_procs, peak_rss = max(peak_procs, procs), max(peak_rss, rss)
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
        print(f"  {pane:5s} i={image_id:<6d} {len(got):4d} frames  {total:6.1f}MB  {host}")

    print(f"\n  panes painted     {painted}/{count}")
    print(f"  process tree      {peak_procs} procs, {peak_rss:.0f}MB peak")
    if painted:
        print(f"  per pane          {peak_rss/painted:.0f}MB, {peak_procs/painted:.1f} procs")
    print("\n  measured as separate engines (5 real pages): 501MB and 5.0 procs per pane")

    if crossed:
        print("\n  CROSSED FRAMES — a pane received another pane's image:")
        for pane, why in crossed[:8]:
            print(f"    {pane}: {why}")
    if others:
        print(f"\n  engine said: {others[:4]}")

    ok = painted == count and not crossed
    print(f"\n{'PASS' if ok else 'FAIL'} — "
          + ("every pane rendered its own image in one engine" if ok
             else f"{count - painted} pane(s) silent, {len(crossed)} crossed"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
