#!/usr/bin/env python3
"""Does a pane actually take the daemon path now that it is the default?

Everything else in `bench/` starts the engine or the daemon directly, which proves those pieces
work and proves nothing about the decision in front of them. This drives `tweb __pane` — the real
frontend, on a real PTY — and asks the question the default switch turns on: with no daemon running
and no flag set, does the pane start one and get hosted, or does it quietly spawn its own engine?

The distinction is invisible from outside: a pane that fell back renders exactly the same page. So
this reads the answer from the daemon rather than from the pane, which is the only side that knows.

    python3 bench/daemon-default.py <tweb-binary> <twebd-binary> [seconds]

What it checks:

    1. no flag, no daemon      -> a daemon appears and the pane is hosted
    2. a second pane           -> joins the SAME daemon rather than starting another
    3. TWEB_DAEMON=0           -> no daemon is consulted and none is started
    4. a SIGKILLed daemon      -> the socket file it leaves behind does not stop the next pane
                                  starting a fresh one; only a connect() tells them apart
    5. the daemon outlives     -> it is setsid-detached, so the pane exiting does not take it
       the pane that started it    down with every other pane it serves

Exit status is 0 only if every one of those holds.
"""

import os
import pty
import shutil
import signal
import subprocess
import sys
import time

# A tmux server identity that no live server issues, with a socket path shape `server_identity_from`
# accepts (`<socket>,<pid>,<session>`). The pane ids are equally out of the way: the registry keys on
# both halves, so nothing here can collide with the user's own panes.
FAKE_TMUX = "/tmp/tweb-daemon-default-probe,999999,0"


def daemon_pid(twebd, runtime):
    """The running daemon's pid, or None. Read from `twebd status`, not from `pgrep`."""
    out = subprocess.run([twebd, "status", "--runtime-dir", runtime],
                         capture_output=True, text=True, timeout=20)
    for line in (out.stdout + out.stderr).splitlines():
        if line.startswith("pid "):
            return int(line.split()[1])
    return None


def hosted_count(twebd, runtime):
    out = subprocess.run([twebd, "status", "--runtime-dir", runtime],
                         capture_output=True, text=True, timeout=20)
    for line in (out.stdout + out.stderr).splitlines():
        if line.startswith("hosted "):
            return int(line.split()[1])
    return 0


def start_pane(tweb, runtime, pane_id, url, flag=None):
    """`url=None` runs a bare `tweb open`, which asks for the tmux window session back."""
    """`tweb __pane` on a real PTY, as a tmux pane would run it.

    A PTY and not a pipe: the frontend probes for graphics support by reading the terminal, enters
    the alternate screen and puts the tty in raw mode. On a pipe it takes a different path, which
    would make this measure something other than what a pane does.
    """
    env = dict(os.environ)
    env["TWEB_RUNTIME_DIR"] = runtime
    env["TWEB_USER_DATA_DIR"] = os.path.join(runtime, "ud")
    env["TMUX"] = FAKE_TMUX
    env["TMUX_PANE"] = pane_id
    # The pane cannot ask a real terminal whether it speaks Kitty graphics, and a refusal here would
    # end the run before the routing decision is reached.
    env["TWEB_ASSUME_GRAPHICS"] = "1"
    if flag is None:
        env.pop("TWEB_DAEMON", None)
    else:
        env["TWEB_DAEMON"] = flag

    argv = [tweb, "__pane"] + ([url] if url is not None else [])
    primary, secondary = pty.openpty()
    process = subprocess.Popen(
        argv, env=env,
        stdin=secondary, stdout=secondary, stderr=open(os.path.join(runtime, f"pane{pane_id[1:]}.err"), "wb"),
        start_new_session=True,
    )
    os.close(secondary)
    return process, primary


def stop(process, primary):
    try:
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=10)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass
    try:
        os.close(primary)
    except OSError:
        pass


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    tweb, twebd = sys.argv[1], sys.argv[2]
    settle = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0

    runtime = os.environ.get("TWEB_DEFAULT_RUNTIME_DIR", "/tmp/tweb-daemon-default")
    shutil.rmtree(runtime, ignore_errors=True)
    os.makedirs(runtime, exist_ok=True)
    # `twebd` has to be findable the way a pane finds it: beside the `tweb` that is running.
    os.environ["TWEB_TWEBD"] = twebd

    results = []
    panes = []
    try:
        print("=== 0. how long until a pane is hosted and painting? ===")
        # What the user feels. A pane that is hosted, fails, and falls back pays a whole engine
        # startup before it starts the one that works — so this number is the difference between
        # the daemon being a saving and being a tax.
        cold = time.time()
        warm_pane, warm_pty = start_pane(tweb, runtime, "%600", "https://example.com")
        panes.append((warm_pane, warm_pty))
        hosted_at = None
        while time.time() - cold < 30:
            if hosted_count(twebd, runtime) >= 1:
                hosted_at = time.time() - cold
                break
            time.sleep(0.25)
        print(f"  first pane hosted after {hosted_at if hosted_at else '>30'}s (cold: daemon start too)")
        results.append(("a cold pane is hosted within 15s", hosted_at is not None and hosted_at < 15))

        second_cold = time.time()
        warm2, warm2_pty = start_pane(tweb, runtime, "%605", "https://example.com")
        panes.append((warm2, warm2_pty))
        warm_at = None
        while time.time() - second_cold < 30:
            if hosted_count(twebd, runtime) >= 2:
                warm_at = time.time() - second_cold
                break
            time.sleep(0.25)
        print(f"  second pane hosted after {warm_at if warm_at else '>30'}s (warm: engine up)")
        results.append(("a warm pane is hosted within 5s", warm_at is not None and warm_at < 5))
        for handle in (panes.pop(), panes.pop()):
            stop(*handle)
        time.sleep(2)

        print("\n=== 1. no flag, no daemon: does the pane start one? ===")

        first, first_pty = start_pane(tweb, runtime, "%601", "https://example.com")
        panes.append((first, first_pty))
        time.sleep(settle)
        pid_after = daemon_pid(twebd, runtime)
        hosted_after = hosted_count(twebd, runtime)
        print(f"  daemon pid   {pid_after}")
        print(f"  hosted panes {hosted_after}")
        results.append(("a pane starts a daemon and is hosted",
                        pid_after is not None and hosted_after == 1))

        print("\n=== 2. a second pane joins the same daemon ===")
        second, second_pty = start_pane(tweb, runtime, "%602", "https://www.rust-lang.org")
        panes.append((second, second_pty))
        time.sleep(settle)
        pid_now = daemon_pid(twebd, runtime)
        hosted_now = hosted_count(twebd, runtime)
        print(f"  daemon pid   {pid_now} (was {pid_after})")
        print(f"  hosted panes {hosted_now}")
        results.append(("a second pane joins rather than starting another daemon",
                        pid_now == pid_after and hosted_now == 2))

        print("\n=== 3. TWEB_DAEMON=0 opts out ===")
        before = hosted_count(twebd, runtime)
        third, third_pty = start_pane(tweb, runtime, "%603", "https://example.com", flag="0")
        panes.append((third, third_pty))
        time.sleep(settle)
        after = hosted_count(twebd, runtime)
        print(f"  hosted panes {before} -> {after}")
        results.append(("an explicit off is not hosted", after == before))

        print("\n=== 4. a pane started after a SIGKILLed daemon starts a fresh one ===")
        # The stale-socket case, produced honestly rather than simulated: killing the daemon leaves
        # its socket file behind, so a check for the FILE would see a daemon that is not there and
        # every pane afterwards would fall back forever. Only a `connect()` separates the two.
        killed = daemon_pid(twebd, runtime)
        os.kill(killed, signal.SIGKILL)
        time.sleep(1.0)
        socket_file = os.path.join(runtime, "twebd.sock")
        print(f"  socket file left behind: {os.path.exists(socket_file)}")
        fourth, fourth_pty = start_pane(tweb, runtime, "%604", "https://example.com")
        panes.append((fourth, fourth_pty))
        time.sleep(settle)
        revived = daemon_pid(twebd, runtime)
        print(f"  daemon pid   {revived} (the killed one was {killed})")
        results.append(("a stale socket does not stop a pane starting a daemon",
                        revived is not None and revived != killed))

        print("\n=== 5. a bare `tweb open` is NOT hosted ===")
        # It asks for the tmux window session back, which a host cannot give: the session is keyed
        # on the tmux identity of the process owning the pane, and a host has N panes and one
        # identity. Hosting it opened `about:blank` and sat there — no error, no page, and a user
        # reported it as a hang. Falling back is the honest answer while that is true.
        before_bare = hosted_count(twebd, runtime)
        bare, bare_pty = start_pane(tweb, runtime, "%606", None)
        panes.append((bare, bare_pty))
        time.sleep(settle)
        after_bare = hosted_count(twebd, runtime)
        print(f"  hosted panes {before_bare} -> {after_bare}")
        results.append(("a session-restoring pane uses its own engine",
                        after_bare == before_bare))

        print("\n=== 6. the daemon outlives the pane that started it ===")
        stop(*panes[-2])
        panes[-2] = (None, None)
        time.sleep(3)
        alive = daemon_pid(twebd, runtime)
        print(f"  daemon pid   {alive} after the starting pane exited")
        results.append(("the daemon survives its starting pane", alive == revived))

    finally:
        for process, primary in panes:
            if process is not None:
                stop(process, primary)
        subprocess.run([twebd, "stop", "--runtime-dir", runtime],
                       capture_output=True, timeout=20)

    print("\n=== verdict ===")
    for name, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    failed = [name for name, ok in results if not ok]
    print(f"\n{'PASS' if not failed else 'FAIL'} — "
          + ("the daemon is the default path and the opt-out works" if not failed
             else f"{len(failed)} check(s) failed"))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
