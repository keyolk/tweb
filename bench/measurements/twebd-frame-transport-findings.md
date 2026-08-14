# How frames reach the right pane when one runtime serves many panes

Measured 2026-08-14 on macOS 25.6.0 (Darwin), tmux 3.5a, kitty 0.42.2, Ghostty 1.3.1.
Everything below is an experiment on a live pane, not an inference from the source.

The question this settles: today the engine is started per pane and its stdout **is** that
pane's PTY, which is the only reason Kitty graphics land in the right place. A daemon serving
N panes cannot inherit N PTYs. So either the daemon opens each pane's tty and writes it, or it
hands the frame to the per-pane frontend and lets the frontend write the pty it already owns.

**Answer: A is yes — a non-owner can write a pane tty and the frame renders. B says route the
frames through the frontend anyway.** The direct route is 9–18µs/frame faster and structurally
puts two writers on one pty, which corrupts frames at every write size measured.

---

## Deliverable A — can a process that does not own the pane PTY make it render?

**Yes.** Proven twice with rendered pixels, with and without tmux, from a Python process that
holds no controlling terminal and opens the target tty `O_WRONLY | O_NOCTTY`.

### A.1 Without tmux — bare pty

A kitty window (`TWEBDIRECT`) holds a pty, `/dev/ttys067`, whose only process is `sleep`. A
foreign process wrote 107 bytes:

```
ESC _G a=T,i=7702,C=1,c=40,r=20,f=32,s=400,v=400,t=f,q=2 ; <base64 path> ESC \
```

A 400×400 green raw-RGBA frame rendered in the top-left of that window. Window-scoped capture
before/after: md5 `b7ce1da4…` → `54ee6891…`.

### A.2 With tmux — passthrough into a pane at a non-zero origin

A private tmux server on its own socket (`tmux -L twebd-lab`) inside kitty window `TWEBTMUX`;
pane `%0`, tty `/dev/ttys070`, origin `0,1`. The same foreign process wrote 131 bytes in the
exact shape `electron/gfx-worker.cjs` emits — `wrapTmuxPassthrough` with every ESC doubled,
cursor parked at the pane origin with `ESC 7` / CUP / `ESC 8`:

```
ESC Ptmux; ESC ESC 7 ESC ESC [2;1H ESC ESC _G a=T,…,f=32,s=400,v=400,t=f,q=2 ; <b64> ESC ESC \ ESC ESC 8 ESC \
```

Rendered, correctly anchored below the status line. md5 `58e5feeb…` → `bafc0a65…`.

Both cases used the **raw-pixel file transport that ships today** (`f=32`, `t=f`), so the
20.7MB of pixels never crossed the tty at all — only a path did.

### A.3 The byte stream a real terminal receives is identical to the engine's

A headless tmux client (a Python `pty.fork` running `tmux attach`, capturing everything tmux
sends it) attached to a grouped session viewing the test window. After a foreign write to pane
`%454`'s tty, the client received:

```
ESC 7 ESC [29;1H ESC _G a=T,i=9911,C=1,c=84,r=27,f=32,s=800,v=540,t=f,q=2 ; <b64 path> ESC \ ESC 8
```

tmux unwrapped the passthrough and re-emitted the un-doubled payload — byte-for-byte what a
pane-owning engine produces. The same capture also carried a **live shipping engine's** frame
(`i=23197`, `t=f`, `…/tweb-electron/tweb-frame-23207-23197.rgba`), confirming the harness sees
the real thing and that the two streams are the same shape.

### A.4 Cost at the tty

5.4µs–10.9µs for 107–138 bytes. That is the entire per-frame tty cost of the file transport.

### A.5 What breaks

#### The one that is a correctness bug: `allow-passthrough all` leaks hidden panes

This machine's tmux is set to `allow-passthrough all`, not `on`. Lab server, one client:
window 1 (`%0`) is what the user sees; window 2 (`%1`, `window_active=0`) is genuinely hidden.

| setting | write a red frame to the **hidden** pane `%1` | result |
| --- | --- | --- |
| `on` | md5 `44477507` → `44477507` | tmux withheld it. Correct. |
| `all` | md5 `44477507` → `a16a7deb` | **the visible window turned red.** |

Under `all`, tmux forwards the payload to the client regardless of which window that client is
viewing. The payload contains an absolute CUP to the pane origin — a coordinate in the
*current* window's grid — so a hidden pane's page is drawn over whatever the user is looking at.

Today this never happens because the engine's `terminalVisible` gate stops the write before it
is issued. **The protection lives entirely in `electron/main.cjs`, not in tmux.** Any daemon
design that assumes "tmux will drop it for a hidden pane" is wrong on this machine's default.

#### `allow-passthrough off` kills the route silently

Same lab server set to `off`, same 131-byte write: screen byte-identical (`5778d635` →
`5778d635`). No error, no diagnostic — the frame vanishes. A daemon must read
`tmux show -g allow-passthrough` rather than discover it as a black pane. Values: `off` / `on` / `all`.

#### Interleaving: a pty write is **not** atomic at any size

Two threads on one pty in raw mode (what tmux sets on a pane pty). Writer A emits one whole
graphics command per `write()`; writer B emits `ESC[10;20H` — the frontend's caret reassert,
which `main.cjs` fires after *every* frame. A tear is B's bytes landing between `ESC _G` and
its terminating `ESC \`.

| bytes per write | torn / 1500 (two writers) | torn / 1500 (one writer serialising both) |
| --- | --- | --- |
| 110 (file transport, as shipped) | 2 | **0** |
| 202 | 6 | **0** |
| 420 (caret patch) | 25 | **0** |
| 3072 (`GFX_CHUNK`) | 496 | **0** |
| 14000 (line patch) | 777 | **0** |

There is no safe size. PIPE_BUF atomicity is a *pipe* guarantee; a pty line discipline does not
give it. **Serialisation, not size, is what makes it safe.**

On the direct (`t=d`) transport the damage is gross: a 1.3MB base64 frame chunked at
`CHUNK=3072` into 424 `ESC _G` commands, against a concurrent caret writer, came back with
**107 of 424 torn (25%)**.

#### A tear is user-visible, and worse than a dropped frame

Writing a deliberately torn frame (a caret sequence spliced mid-command) to the live lab pane:
screen unchanged (`fa557fb0` → `fa557fb0`) — the frame was lost. The clean control rendered
(`fa557fb0` → `0e794613`). But the capture after the torn write shows the **entire pane filled
with literal `xxxxxxx…` text**: the terminal, its escape terminated early, fell out of
graphics-parsing state and printed the remaining payload as characters. That garbage persists
until something repaints.

At 2/1500 under this test's contention, one frame in ~750 is corrupted — roughly one pane
every 25 seconds of sustained 30fps painting, each leaving visible junk behind. The rate is
contention-dependent, so treat 25s as the order of magnitude under a caret writer firing after
every frame, not a constant.

#### Cursor: not corrupted, and that is the surprising part

`tmux display-message -p -t %454 "#{cursor_x} #{cursor_y} #{?cursor_flag,visible,hidden}"` read
`0 0 visible` before **and** after every graphics write. tmux does not parse a passthrough
payload, so it cannot be desynced by one.

The converse is the real constraint: because tmux never sees it, tmux also cannot *repair* it.
The `ESC 7` / `ESC 8` in the wrapper is the only thing that restores the outer terminal's
cursor, and the outer terminal is what executes it. Remove it and the cursor is left parked
where the frame was placed, with tmux's model disagreeing, until the next full redraw.

For contrast: **plain text** written to the same foreign tty *does* go through tmux's parser —
it appears in `tmux capture-pane -p -t %454` and advances tmux's cursor (`0,0` → `0,1`). The tty
is fully writable by a non-owner; only passthrough payloads are invisible to tmux's state machine.

#### Permissions: a non-issue, with one mandatory flag

`/dev/ttysNNN` is `crw--w----` owner `:tty`. A daemon running as the same user opens it
`O_WRONLY` with no privilege — no sudo, no ioctl, no `TIOCSTI`.

`O_NOCTTY` is **mandatory**. Without it a daemon that has no controlling terminal acquires the
first pane tty it opens as its own, and a SIGHUP on that one pane then kills the daemon serving
every other pane.

#### Confirmed against a live pane

A real `tweb open https://example.com` in a pane in a window nobody was viewing reported:

```
window.visible      false
frames.whole        0
frames.patches      0
frames.wholeFormat  raw
pane_geometry.origin  {left: 0, top: 18}
```

Zero frames sent. So the engine's own visibility gate — not tmux — is what keeps a hidden
pane's frames off the wire, which is exactly the property a daemon must reproduce.

Note the field name: `tweb diag --pane %N --json` has no `terminalVisible` key; the boolean
lives at `window.visible`.

#### The tty path is not a stable identity

Observed directly: an early split gave pane `%452` on `/dev/ttys072`; that pane died; a later,
unrelated window came back on the **same** `/dev/ttys072`. A daemon caching a tty per pane will
eventually write one pane's page into another pane. Re-resolve `#{pane_tty}` per frame, or
invalidate on the pane-died hook. This is the transport-layer twin of the pane-id reuse that
`crates/twebd/src/page_registry.rs` already models with a generation.

---

## Deliverable B — what each route costs per frame

Realistic frame: the raw-pixel file transport that ships (`f=32`, `t=f`, 2880×1800, 20.7MB of
pixels via the file, **202 bytes on the tty**). The relay is a Unix `socketpair` with a real
forked child doing the read *and* the pty write, with an ack round trip so the frame provably
reached the pty before the clock stops. 400–500 samples, medians of four runs.

| route | wire B | copied B | p50 | p90 |
| --- | --- | --- | --- | --- |
| daemon → pane tty (direct) | 202 | 202 | 0.9–1.0µs | 11–15µs |
| daemon → frontend (prebuilt sequence) | 202 | 404 | 9.5–20µs | 18–44µs |
| daemon → frontend (control message, frontend builds the sequence) | 161 | 363 | 15–39µs | 25–117µs |

**Relay overhead: +9µs to +18µs p50.** Against a 30fps budget of 33,333µs that is 0.03%–0.05%;
against 60fps (16,667µs), 0.06%–0.11%.

**Bytes copied: 404 vs 202** — one extra 202-byte copy per frame, i.e. 6KB/s at 30fps. The
20.7MB of pixels crosses neither transport; both send a path.

The other frame shapes that ship, direct p50 → relay p50:

| case | payload | direct | relay | delta |
| --- | --- | --- | --- | --- |
| patch, 30×30 caret damage | 420 B | 3.2µs | 24.9µs | +21.8µs (0.065% of a 30fps frame) |
| patch, 1440×120 damage | 14 KB | 298.5µs | 289.5µs | ±0 (the pty write dominates) |
| whole frame, direct PNG, text page | 786 KB | 15.9ms | 16.8ms | +0.9ms (5.5%) |
| whole frame, direct PNG, mixed page | 2.0 MB | 40.7ms | 45.3ms | +4.6ms (11%) |

The direct-PNG rows are not a discriminator: at 16–41ms the pty write alone already blows the
frame budget on **both** routes, which is exactly why the shipping default is the file transport.

### Which the numbers favour

**The relay — daemon → frontend, frontend writes its own pty.**

Not because it is faster. It is 9–18µs *slower* per frame. It wins because that 0.03% of a
frame budget buys four things the direct route has to build by hand:

1. **One writer per pty, by construction.** The only configuration that measured correct
   (0/1500 at every size, against 2–777/1500). The daemon-direct route structurally has two
   writers per pane — the daemon's frames and the frontend's own caret, cursor-shape and
   teardown deletes, all of which `crates/tweb-pane/src/lib.rs` and `main.cjs` write today. It
   would need a cross-process lock per pane tty to buy back what the relay gets for free.
2. **The frontend already knows its tty, its pane origin and its visibility.** The daemon would
   otherwise have to track three things that go stale — and `pane_tty` demonstrably does.
3. **The `allow-passthrough all` leak is gated in the only process that knows whether it is
   visible.** In the daemon, that gate is a cache of someone else's state.
4. **No new mechanism.** `crates/tweb-pane` already has the stdin control channel that pushes
   viewport and visibility, and already writes escape sequences to its own pty and to client ttys.

The direct route's sole win is 9–18µs, about 1/2000th of a frame interval, paid for with a
cross-process lock, a tty-invalidation problem, and a visibility gate in the wrong process.

**Not measured:** pty backpressure. If one pane's terminal stalls, a direct-writing daemon
blocks in `write()` and stalls every other pane it serves, whereas the relay confines that block
to the per-pane frontend. This points the same way but is untested; treat it as a hypothesis.

---

## Reproduction

Harness lived in `mktemp -d /tmp/twebd-transport.XXXXXX` and is deleted. The commands:

```bash
# 0. The variable that decides everything.
tmux show -g allow-passthrough          # off | on | all — this machine: all

# 1. A test pane in your own window, held open.
tmux split-window -d -t %<yours> -P -F "#{pane_id} #{pane_tty}" 'exec sleep 100000'
tmux display-message -p -t %N "#{pane_left},#{pane_top} #{pane_width}x#{pane_height}"

# 2. A controllable terminal + tmux server that touches nobody else's session.
kitty --title TWEBTMUX tmux -L twebd-lab new-session -s lab 'tty > /tmp/lab-tty; exec sleep 100000'

# 3. The foreign write. Python, no controlling tty:
#      fd = os.open(tty, os.O_WRONLY | os.O_NOCTTY)
#    emitting exactly what electron/gfx-worker.cjs writeRawFrame + wrapTmuxPassthrough produce:
#      ESC Ptmux; <ESC-doubled: ESC7 CUP(origin) ESC_G a=T,i=,C=1,c=,r=,f=32,s=,v=,t=f,q=2;<b64 path> ESC\ ESC8> ESC \

# 4. Prove the render. Window-scoped so it captures the terminal, not the desktop:
#    CGWindowID via CGWindowListCopyWindowInfo, then
screencapture -x -o -l <CGWindowID> after.png
md5 -q before.png after.png          # differing md5 == the frame drew

# 5. Prove the cursor is untouched.
tmux display-message -p -t %N "#{cursor_x} #{cursor_y} #{?cursor_flag,visible,hidden}"

# 6. Byte-level proof without a GUI: a headless tmux client on a pty you own.
#    pty.fork() -> execvp("tmux", ["tmux","-u","attach","-t",<grouped session>])
#    TERM must be a terminfo entry tmux accepts (xterm-256color; xterm-kitty is rejected).
#    Capture everything tmux sends and diff it against the shipping engine's bytes.

# 7. Atomicity. pty.openpty(), tty.setraw(slave), two threads writing the same fd;
#    count ESC_G commands containing a foreign ESC[ before their ESC\.
#    Then repeat with ONE thread issuing both writes.
```

Notes for whoever repeats this:

- `tmux attach` rejects `TERM=xterm-kitty` with *missing or unsuitable terminal*; use
  `xterm-256color`. The Kitty graphics escapes pass through regardless — tmux does not parse them.
- `screencapture -l <id>` returns a **stale** backing store for an occluded window. Every
  capture above was taken with the target window frontmost; a control write (plain text) that
  fails to appear in the capture is the tell that you are looking at a cached bitmap.
- Use a grouped session (`tmux new-session -d -s probe -t <existing>`) or a private server
  (`-L`) rather than `select-window`, which is session-scoped and will yank the user's screen.
- `tweb screenshot --pane %N` captures the *page* the engine renders, not the terminal. For this
  question — "did the terminal draw these bytes" — it answers the wrong thing, which is why the
  evidence here is window-scoped `screencapture` plus the headless client's byte stream.

---

## Recommendation

Route frames **daemon → frontend → frontend's own pty**, over the control channel
`crates/tweb-pane` already owns. Send the frame as a small control message; the frontend adds
its own tty, origin and passthrough wrapper, exactly as it already does for the Kitty deletes.

The daemon should still learn `allow-passthrough`, because `off` makes the whole product silent
and that deserves a diagnostic rather than a black pane.

Keep the file transport as the default. It is the only frame shape whose tty write is small
enough that a tear is rare rather than routine, and the pixel bytes stay off the tty entirely.

If the direct route is ever revisited — say, to skip a hop for a full-screen pane — it needs, at
minimum: a per-pane-tty cross-process lock covering *every* writer, `O_NOCTTY`, per-frame
re-resolution of `#{pane_tty}`, and its own visibility gate. That is four mechanisms to recover
what the relay provides for 9–18µs.
