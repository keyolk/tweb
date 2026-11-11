#!/usr/bin/env python3
"""Window-switch stale-image harness for the hosted engine. No tmux server.

The engine runs hosted (as under twebd): its pane's frames come back as `@%N FRAME <hex>` lines
on stdout, and the direct delete for a client that stopped showing the pane goes to the client
tty named in the VIS push. That tty is the slave of a pty this script owns, so both streams are
captured. They are merged by arrival time into the byte order a terminal would see.

A "window switch" is what the frontend would push on its next tick: the same client, now on
another window (away) or back on the pane's window (back). Each trial ends on "away", waits,
and replays the merged stream through a minimal Kitty placement model: any id still placed
is a page left drawn over the other window.

The replay is done at several frame-path delays. 0 is the order the engine emitted bytes in. A
delay > 0 models frames still queued between the engine and the terminal (daemon -> frontend
pty -> tmux -> client) while the direct client-tty delete skips that queue. The in-band delete
travels the frame path, so it is delayed with the frames, which is the property under test.

    python3 bench/window-switch.py --electron <Electron> --app electron --tag x \
        --url file://$PWD/bench/pages/animated-counter.html [--trials 50]

Measured on 2026-11-11 (2880x1800 pane, 50 trials, 188 switches, checked 3s after the switch):

    frame-path delay        0ms   50ms  150ms  300ms
    stale, before the fix     0      3     11     27
    stale, after the fix      0      0      0      0
"""
import argparse, json, os, pty, random, re, subprocess, sys, threading, time

ap = argparse.ArgumentParser()
ap.add_argument("--electron", required=True)
ap.add_argument("--app", required=True)
ap.add_argument("--tag", required=True)
ap.add_argument("--trials", type=int, default=50)
ap.add_argument("--dwell", type=float, default=1.0)
ap.add_argument("--late", type=float, default=3.0)
ap.add_argument("--seed", type=int, default=1)
ap.add_argument("--url", required=True)
args = ap.parse_args()

run = os.path.join(os.environ.get("TWEB_RUNTIME_DIR", "/tmp/window-switch"), f"run-{args.tag}")
os.makedirs(run, exist_ok=True)

PANE, IMAGE_ID, SERVER = "%91", 7300, "switchharness"
master, slave = pty.openpty()
client_tty = os.ttyname(slave)

env = dict(os.environ)
env.update(TWEB_MULTIPANE="1", TWEB_SUPERVISOR_PID=str(os.getpid()),
           TWEB_RUNTIME_DIR=os.path.join(run, "rt"), TWEB_USER_DATA_DIR=os.path.join(run, "ud"))
for k in ("TMUX", "TMUX_PANE", "TWEB_URL", "TWEB_VIEWPORT", "TWEB_IMAGE_ID", "TWEB_PANE_ORIGIN",
          "TWEB_FRONTEND_PID"):
    env.pop(k, None)
os.makedirs(env["TWEB_RUNTIME_DIR"], exist_ok=True)

events = []  # (t, source, bytes)
lock = threading.Lock()

def tty_reader():
    while True:
        try:
            data = os.read(master, 65536)
        except OSError:
            return
        if not data:
            return
        with lock:
            events.append((time.monotonic(), "tty", data))

def vis(window):
    payload = f"{SERVER}\t@1\t{PANE}\n{client_tty}\t{SERVER}\t{window}\t0\t{PANE}\troot"
    return f"@{PANE} VIS {payload.encode().hex()}\n".encode()

DELAYS = [0.0, 0.05, 0.15, 0.3]
APC = re.compile(rb"\x1b_G([^;\x1b]*)(?:;[^\x1b]*)?\x1b\\")

def commands(upto, delay=0.0):
    """Commands the terminal has seen by `upto`, with the frame path `delay` slower than the
    direct tty write. 0 is engine emit order; >0 models frames still queued in the
    daemon -> frontend pty -> tmux -> client path that the direct delete does not go through."""
    with lock:
        evs = [(t + (delay if src == "frame" else 0.0), src, d) for t, src, d in events]
    evs = sorted((e for e in evs if e[0] <= upto), key=lambda e: e[0])
    out = []
    for t, src, data in evs:
        # tmux passthrough doubles ESC; the engine is not in tmux here, but undo it anyway.
        data = data.replace(b"\x1b\x1b", b"\x1b")
        for m in APC.finditer(data):
            kv = dict(p.split(b"=", 1) for p in m.group(1).split(b",") if b"=" in p)
            out.append((t, src, kv))
    return out

def placed(cmds):
    state = {}
    for _, _, kv in cmds:
        a, i = kv.get(b"a", b"t"), kv.get(b"i")
        if a in (b"T", b"p") and i:
            state[i] = True
        elif a == b"d" and i and kv.get(b"d", b"a") in (b"i", b"I"):
            state[i] = False
    return sorted(i.decode() for i, v in state.items() if v)

def main():
    err = open(os.path.join(run, "engine.err"), "wb")
    global eng
    eng = subprocess.Popen([args.electron, "."], cwd=args.app, env=env, stdin=subprocess.PIPE,
                           stdout=subprocess.PIPE, stderr=err)
    threading.Thread(target=tty_reader, daemon=True).start()
    ready = threading.Event()

    def out_reader():
        buf = b""
        prefix = f"@{PANE} FRAME ".encode()
        while True:
            chunk = eng.stdout.read1(1 << 20)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if line.startswith(b"READY") or line.startswith(b"@"):
                    ready.set()
                if line.startswith(prefix):
                    with lock:
                        events.append((time.monotonic(), "frame", bytes.fromhex(line[len(prefix):].decode())))
    threading.Thread(target=out_reader, daemon=True).start()

    def send(b):
        eng.stdin.write(b)
        eng.stdin.flush()

    ready.wait(timeout=20)
    time.sleep(1)
    send(f"@{PANE} ATTACH {SERVER} 1 {IMAGE_ID} 30 1 0 240 70 2880 1800 0 0 - {args.url}\n".encode())
    send(vis("@1"))
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline and not placed(commands(time.monotonic())):
        time.sleep(0.3)
    if not placed(commands(time.monotonic())):
        print("no frames arrived", file=sys.stderr)
        return 2
    time.sleep(2)

    rng = random.Random(args.seed)
    results, switches = [], 0
    for trial in range(args.trials):
        k = rng.choice([1, 1, 3, 3, 5])
        cur = "@1"
        for _ in range(k):
            cur = "@2" if cur == "@1" else "@1"
            t_last = time.monotonic()
            send(vis(cur))
            switches += 1
            # The frontend ticks at 250ms; fast switching lands a push on most ticks.
            time.sleep(rng.uniform(0.03, 0.3))
        time.sleep(args.dwell + args.late)
        t_check = time.monotonic()
        r = dict(trial=trial, burst=k)
        for delay in DELAYS:
            cmds = commands(t_check, delay)
            after = [(t - t_last, src, kv.get(b"a", b"t")) for t, src, kv in cmds if t >= t_last]
            first_del = min([t for t, src, a in after if a == b"d" and src == "tty"], default=None)
            r[f"d{int(delay*1000)}"] = dict(
                stale=placed(cmds),
                tty_delete_ms=None if first_del is None else round(first_del * 1000),
                places_after_delete_ms=[round(t * 1000) for t, src, a in after
                                        if a in (b"T", b"p") and first_del is not None and t > first_del])
        results.append(r)
        print(json.dumps(r), flush=True)
        send(vis("@1"))
        switches += 1
        time.sleep(rng.uniform(0.6, 1.0))

    parts = []
    for delay in DELAYS:
        key = f"d{int(delay*1000)}"
        st = sum(1 for r in results if r[key]["stale"])
        pad = sum(1 for r in results if r[key]["places_after_delete_ms"])
        parts.append(f"[frame_path_delay={int(delay*1000)}ms stale={st} frame_after_delete={pad}]")
    line = (f"SUMMARY tag={args.tag} trials={len(results)} switches={switches} "
            f"checked_at={args.dwell + args.late}s " + " ".join(parts))
    print(line, flush=True)
    open(os.path.join(run, "summary.txt"), "w").write(
        "\n".join(json.dumps(r) for r in results) + "\n" + line + "\n")
    send(f"@{PANE} DETACH\n".encode())
    time.sleep(1)
    return 0

eng = None
try:
    code = main()
finally:
    if eng is not None and eng.poll() is None:
        eng.terminate()
        try:
            eng.wait(timeout=10)
        except subprocess.TimeoutExpired:
            eng.kill()
sys.exit(code)
