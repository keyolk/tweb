//! One serialising writer per pane tty.
//!
//! `bench/measurements/frame-egress-decision.md` settles the wiring this enforces: frames go
//! daemon -> per-pane frontend -> the frontend's own pty, not daemon -> pane tty directly.
//! What survives from that decision as a hard invariant is this module's whole purpose.
//!
//! **A pty write is not atomic at any size.** Measured on this machine, two threads writing
//! one raw pty — one emitting whole Kitty graphics commands, the other emitting the caret
//! reassert `electron/main.cjs` fires after every frame:
//!
//! ```text
//! bytes per write   torn / 1500 (two writers)   torn / 1500 (one serialising writer)
//! 202                          28                            0
//! 420                          82                            0
//! 3072                        345                            0
//! 14000                       232                            0
//! ```
//!
//! PIPE_BUF atomicity is a *pipe* guarantee; a pty line discipline does not give it. There is
//! no safe write size — serialisation is the only thing that works, which is why this is a
//! type rather than a rule in a comment.
//!
//! A tear is worse than a dropped frame. When a foreign escape lands between `ESC _G` and its
//! terminating `ESC \`, the terminal falls out of graphics-parsing state and prints the rest
//! of the payload as literal text, which stays on screen until something repaints.
//!
//! Today a single-pane Electron does not tear only by accident: `electron/gfx-worker.cjs`
//! writes `process.stdout` from a worker thread, and Node funnels that through the main
//! thread's stdout stream. One runtime serving many panes has no such accident.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};

/// The single writer for one pane's tty.
///
/// Every escape sequence reaching a pane tty must pass through one of these — frames, caret
/// reasserts, Kitty deletes, cursor-shape changes. A write that goes around it voids the
/// invariant for every other writer, because serialisation is only as good as its weakest
/// participant.
pub struct PaneWriter {
    sink: Mutex<Box<dyn Write + Send>>,
}

impl PaneWriter {
    /// Wraps an already-open sink. The tty open lives in [`open_tty`] so the interleaving
    /// logic can be tested against a sink that makes tears reproducible rather than rare.
    pub fn new(sink: Box<dyn Write + Send>) -> Self {
        Self {
            sink: Mutex::new(sink),
        }
    }

    /// Writes one complete escape sequence, uninterleavable with respect to every other
    /// caller holding this writer.
    ///
    /// "Complete" is the caller's obligation: a partial sequence handed to two calls is two
    /// units and something else may land between them.
    pub fn write_sequence(&self, sequence: &[u8]) -> io::Result<()> {
        self.write_batch(std::slice::from_ref(&sequence))
    }

    /// Writes several sequences under a single lock hold.
    ///
    /// This is not a convenience. `writeDirect` in `electron/gfx-worker.cjs` splits a base64
    /// frame into hundreds of `ESC _G` commands chained with `m=1`; each command is intact on
    /// its own, but a *foreign graphics command* arriving between two chunks corrupts the
    /// terminal's transfer state just as thoroughly as a tear inside one. A multi-part
    /// transfer is one unit and must be passed as one call.
    pub fn write_batch(&self, sequences: &[&[u8]]) -> io::Result<()> {
        // A poisoned lock means another writer panicked mid-sequence, so the tty already
        // holds a partial escape. Recovering the guard and continuing is still the best move
        // available: the alternative is a pane that never draws again.
        let mut sink = self
            .sink
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for sequence in sequences {
            sink.write_all(sequence)?;
        }
        sink.flush()
    }
}

/// Opens a pane tty for writing.
///
/// `O_NOCTTY` is mandatory, not defensive. A process with no controlling terminal that opens
/// a tty without it acquires that tty as its controlling terminal, and a SIGHUP on that one
/// pane then kills a process serving every other pane.
pub fn open_tty(path: &str) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NOCTTY)
        .open(path)
}

/// The writers currently open, one per pane.
///
/// Keyed on pane id but *validated* against the tty path, because a tty path is not a stable
/// identity: pane `%452` held `/dev/ttys072`, died, and an unrelated later window came back
/// on the same `/dev/ttys072`. A registry that keyed on the path alone would eventually hand
/// one pane's writer to another pane and draw its page there.
#[derive(Default)]
pub struct PaneWriters {
    writers: HashMap<String, (String, Arc<PaneWriter>)>,
}

impl PaneWriters {
    pub fn new() -> Self {
        Self::default()
    }

    /// The writer for this pane, creating it via `open` on first use.
    ///
    /// A pane whose tty path has changed gets a fresh writer and the stale one is dropped —
    /// the pane was recreated, and its old tty either belongs to nobody or to somebody else.
    pub fn writer_for<F>(
        &mut self,
        pane: &str,
        tty_path: &str,
        open: F,
    ) -> io::Result<Arc<PaneWriter>>
    where
        F: FnOnce(&str) -> io::Result<Box<dyn Write + Send>>,
    {
        if let Some((known_tty, writer)) = self.writers.get(pane) {
            if known_tty == tty_path {
                return Ok(Arc::clone(writer));
            }
        }
        let writer = Arc::new(PaneWriter::new(open(tty_path)?));
        self.writers.insert(
            pane.to_string(),
            (tty_path.to_string(), Arc::clone(&writer)),
        );
        Ok(writer)
    }

    /// Drops a pane's writer, closing its tty once every outstanding `Arc` is gone.
    pub fn release(&mut self, pane: &str) {
        self.writers.remove(pane);
    }

    pub fn len(&self) -> usize {
        self.writers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.writers.is_empty()
    }
}

/// Counts Kitty graphics commands with a foreign CSI spliced inside them.
///
/// A tear is what a terminal cannot recover from: bytes between `ESC _G` and its terminating
/// `ESC \` that belong to some other writer. Exposed rather than test-private because it is
/// the definition of the defect this module exists to prevent, and a caller wiring a new
/// writer into the path can assert on it.
pub fn count_torn_commands(stream: &[u8]) -> usize {
    const START: &[u8] = b"\x1b_G";
    const END: &[u8] = b"\x1b\\";
    const FOREIGN: &[u8] = b"\x1b[";

    let find = |haystack: &[u8], needle: &[u8], from: usize| -> Option<usize> {
        if from >= haystack.len() {
            return None;
        }
        haystack[from..]
            .windows(needle.len())
            .position(|window| window == needle)
            .map(|at| at + from)
    };

    let mut torn = 0;
    let mut cursor = 0;
    while let Some(begin) = find(stream, START, cursor) {
        let Some(end) = find(stream, END, begin + START.len()) else {
            break;
        };
        if find(stream, FOREIGN, begin + START.len()).is_some_and(|at| at < end) {
            torn += 1;
        }
        cursor = end + END.len();
    }
    torn
}

#[cfg(test)]
mod tests {
    use super::{count_torn_commands, PaneWriter, PaneWriters};
    use std::io::{self, Write};
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread;

    /// A sink that writes one byte at a time and yields between bytes.
    ///
    /// The real defect is a race that needs ~1500 writes to show up once, which is not a thing
    /// to put in `cargo test`. This sink gives an unserialised writer every opportunity to be
    /// interleaved, so a `PaneWriter` that failed to serialise would be caught here.
    ///
    /// Used only where the assertion is one-sided — "no tears" cannot pass by luck, so it is
    /// safe under any scheduler. Proving a tear *must* happen needs [`LockstepSink`].
    #[derive(Clone)]
    struct InterleavingSink {
        written: Arc<Mutex<Vec<u8>>>,
    }

    impl InterleavingSink {
        fn new() -> Self {
            Self {
                written: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn bytes(&self) -> Vec<u8> {
            self.written.lock().unwrap().clone()
        }
    }

    impl Write for InterleavingSink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            for byte in buf {
                self.written.lock().unwrap().push(*byte);
                thread::yield_now();
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct LockstepState {
        bytes: Vec<u8>,
        turn: usize,
        done: [bool; 2],
    }

    /// A sink that forces two writers to alternate, so a tear is certain rather than likely.
    ///
    /// `two_unserialised_writers_tear_frames` has to assert that a tear *did* happen, and that
    /// direction cannot be left to the scheduler: measured here, a barrier-synchronised pair of
    /// threads on the yielding sink produced no tear in roughly half of 20 runs, which is a
    /// flaky test in the failing direction — the worst kind to ship in the file whose subject
    /// is determinism.
    ///
    /// Each writer takes a turn, and the turn is skipped once the other side is finished, so
    /// the shorter writer running out cannot deadlock the longer one.
    #[derive(Clone)]
    struct LockstepSink {
        state: Arc<(Mutex<LockstepState>, Condvar)>,
        id: usize,
        // Granularity is per writer on purpose, and it models the real thing: an 8-byte caret
        // lands whole, while a 150-byte graphics command is the one the kernel splits. A sink
        // that split the caret too would scatter its `ESC [` across frame bytes and the tear
        // would stop being detectable — an artefact of the model, not of the hazard.
        chunk: usize,
    }

    impl LockstepSink {
        fn new() -> Self {
            Self {
                state: Arc::new((Mutex::new(LockstepState::default()), Condvar::new())),
                id: 0,
                chunk: 1,
            }
        }

        fn writer(&self, id: usize, chunk: usize) -> Self {
            Self {
                state: Arc::clone(&self.state),
                id,
                chunk,
            }
        }

        fn bytes(&self) -> Vec<u8> {
            self.state.0.lock().unwrap().bytes.clone()
        }

        /// Releases the other writer from waiting on a turn that will never come.
        fn finish(&self) {
            let (lock, cvar) = &*self.state;
            let mut state = lock.lock().unwrap();
            state.done[self.id] = true;
            state.turn = 1 - self.id;
            cvar.notify_all();
        }
    }

    impl Write for LockstepSink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let (lock, cvar) = &*self.state;
            for piece in buf.chunks(self.chunk) {
                let mut state = lock.lock().unwrap();
                while state.turn != self.id && !state.done[1 - self.id] {
                    state = cvar.wait(state).unwrap();
                }
                state.bytes.extend_from_slice(piece);
                state.turn = 1 - self.id;
                cvar.notify_all();
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn frame(id: u32) -> Vec<u8> {
        format!(
            "\x1b_Ga=T,i={id},C=1,f=32,s=800,v=540,t=f,q=2;{}\x1b\\",
            "A".repeat(120)
        )
        .into_bytes()
    }

    // The caret reassert electron/main.cjs fires after every frame. This is the second writer
    // that made the shipping pipeline tear.
    const CARET: &[u8] = b"\x1b[10;20H";

    /// The detector has to fire on a real tear, or every test below passes vacuously.
    #[test]
    fn a_spliced_caret_reads_as_a_torn_command() {
        let clean = frame(1);
        assert_eq!(count_torn_commands(&clean), 0);

        let mut torn = clean.clone();
        torn.splice(20..20, CARET.iter().copied());
        assert_eq!(count_torn_commands(&torn), 1);

        // A caret *between* two commands is exactly what the frontend legitimately writes.
        let mut between = frame(1);
        between.extend_from_slice(CARET);
        between.extend_from_slice(&frame(2));
        assert_eq!(count_torn_commands(&between), 0);
    }

    /// The regression: two writers on one tty tear frames. This is the failure the primitive
    /// exists to prevent, and the assertion is that a tear DID happen — so the interleaving is
    /// forced rather than hoped for.
    #[test]
    fn two_unserialised_writers_tear_frames() {
        let sink = LockstepSink::new();
        let frames = {
            let mut sink = sink.writer(0, 16);
            thread::spawn(move || {
                for id in 0..40 {
                    sink.write_all(&frame(id)).unwrap();
                }
                sink.finish();
            })
        };
        let carets = {
            let mut sink = sink.writer(1, CARET.len());
            thread::spawn(move || {
                for _ in 0..40 {
                    sink.write_all(CARET).unwrap();
                }
                sink.finish();
            })
        };
        frames.join().unwrap();
        carets.join().unwrap();

        assert!(
            count_torn_commands(&sink.bytes()) > 0,
            "the sink must be able to tear, or the serialised case proves nothing"
        );
    }

    /// The same two writers, through one `PaneWriter`: zero tears.
    ///
    /// The lockstep sink would deadlock here — one thread holds the writer's lock across a
    /// whole sequence while the sink waits for the other to take a turn it cannot take, which
    /// is precisely the serialisation under test. The yielding sink is the right instrument
    /// for this direction: "no tears" cannot pass by luck.
    #[test]
    fn one_serialising_writer_never_tears() {
        let sink = InterleavingSink::new();
        let writer = Arc::new(PaneWriter::new(Box::new(sink.clone())));

        let frames = {
            let writer = Arc::clone(&writer);
            thread::spawn(move || {
                for id in 0..40 {
                    writer.write_sequence(&frame(id)).unwrap();
                }
            })
        };
        let carets = {
            let writer = Arc::clone(&writer);
            thread::spawn(move || {
                for _ in 0..40 {
                    writer.write_sequence(CARET).unwrap();
                }
            })
        };
        frames.join().unwrap();
        carets.join().unwrap();

        let bytes = sink.bytes();
        assert_eq!(count_torn_commands(&bytes), 0);
        // Every frame arrived whole, so serialisation cost no frames either.
        assert_eq!(bytes.windows(3).filter(|w| *w == b"\x1b_G").count(), 40);
    }

    /// A multi-part `m=1` transfer is one unit. A foreign graphics command landing between
    /// two chunks corrupts the transfer even though every chunk is individually intact, which
    /// is why chunked frames must go through `write_batch`.
    #[test]
    fn a_chunked_transfer_admits_nothing_between_its_chunks() {
        let sink = InterleavingSink::new();
        let writer = Arc::new(PaneWriter::new(Box::new(sink.clone())));

        let chunks: Vec<Vec<u8>> = (0..8)
            .map(|n| format!("\x1b_Gm={};{}\x1b\\", u8::from(n < 7), "B".repeat(64)).into_bytes())
            .collect();

        let transfer = {
            let writer = Arc::clone(&writer);
            let chunks = chunks.clone();
            thread::spawn(move || {
                for _ in 0..20 {
                    let parts: Vec<&[u8]> = chunks.iter().map(|c| c.as_slice()).collect();
                    writer.write_batch(&parts).unwrap();
                }
            })
        };
        let intruder = {
            let writer = Arc::clone(&writer);
            thread::spawn(move || {
                for id in 0..40 {
                    writer.write_sequence(&frame(id)).unwrap();
                }
            })
        };
        transfer.join().unwrap();
        intruder.join().unwrap();

        let bytes = sink.bytes();
        assert_eq!(count_torn_commands(&bytes), 0);
        // The real assertion: no intruding command split a transfer. Every `m=1` run of eight
        // chunks is contiguous, so the byte string of one whole transfer appears 20 times.
        let whole: Vec<u8> = chunks.concat();
        let occurrences = bytes
            .windows(whole.len())
            .filter(|window| *window == whole.as_slice())
            .count();
        assert_eq!(occurrences, 20);
    }

    fn recording_open(
        opened: Arc<Mutex<Vec<String>>>,
    ) -> impl FnOnce(&str) -> io::Result<Box<dyn Write + Send>> {
        move |path: &str| {
            opened.lock().unwrap().push(path.to_string());
            Ok(Box::new(InterleavingSink::new()))
        }
    }

    /// One writer per pane tty means the registry must hand back the same one, or the
    /// invariant is a per-call mutex that serialises nothing.
    #[test]
    fn the_same_pane_and_tty_always_get_the_same_writer() {
        let mut writers = PaneWriters::new();
        let opened = Arc::new(Mutex::new(Vec::new()));

        let first = writers
            .writer_for("%1", "/dev/ttys001", recording_open(Arc::clone(&opened)))
            .unwrap();
        let second = writers
            .writer_for("%1", "/dev/ttys001", recording_open(Arc::clone(&opened)))
            .unwrap();

        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(opened.lock().unwrap().len(), 1, "the tty was opened twice");
    }

    /// A tty path is not an identity. A pane that came back on a different tty must not keep
    /// writing the old one, which by then may belong to a different pane entirely.
    #[test]
    fn a_changed_tty_replaces_the_writer() {
        let mut writers = PaneWriters::new();
        let opened = Arc::new(Mutex::new(Vec::new()));

        let before = writers
            .writer_for("%1", "/dev/ttys001", recording_open(Arc::clone(&opened)))
            .unwrap();
        let after = writers
            .writer_for("%1", "/dev/ttys002", recording_open(Arc::clone(&opened)))
            .unwrap();

        assert!(!Arc::ptr_eq(&before, &after));
        assert_eq!(
            *opened.lock().unwrap(),
            vec!["/dev/ttys001", "/dev/ttys002"]
        );
        assert_eq!(writers.len(), 1);
    }

    /// The converse of the reuse case: two panes sharing a tty path — which happens when a
    /// dead pane's tty is recycled and the registry has not caught up — must not share a
    /// writer, because they are not the same pane.
    #[test]
    fn two_panes_on_one_tty_path_do_not_share_a_writer() {
        let mut writers = PaneWriters::new();
        let opened = Arc::new(Mutex::new(Vec::new()));

        let one = writers
            .writer_for("%1", "/dev/ttys001", recording_open(Arc::clone(&opened)))
            .unwrap();
        let two = writers
            .writer_for("%2", "/dev/ttys001", recording_open(Arc::clone(&opened)))
            .unwrap();

        assert!(!Arc::ptr_eq(&one, &two));
        assert_eq!(writers.len(), 2);
    }

    /// A pane that goes away must release its tty, or a long-lived process accumulates open
    /// fds on ttys that have been recycled under it.
    #[test]
    fn releasing_a_pane_drops_its_writer() {
        let mut writers = PaneWriters::new();
        let opened = Arc::new(Mutex::new(Vec::new()));

        writers
            .writer_for("%1", "/dev/ttys001", recording_open(Arc::clone(&opened)))
            .unwrap();
        writers.release("%1");
        assert!(writers.is_empty());

        writers
            .writer_for("%1", "/dev/ttys001", recording_open(Arc::clone(&opened)))
            .unwrap();
        assert_eq!(
            opened.lock().unwrap().len(),
            2,
            "the writer was not dropped"
        );
    }

    /// A write that fails must not leave the writer locked out for everyone else — a pane
    /// whose terminal went away would otherwise take the whole process with it.
    #[test]
    fn a_failing_write_leaves_the_writer_usable() {
        struct Failing(bool);
        impl Write for Failing {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                if self.0 {
                    return Err(io::Error::new(io::ErrorKind::BrokenPipe, "gone"));
                }
                Ok(buf.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let writer = PaneWriter::new(Box::new(Failing(true)));
        assert!(writer.write_sequence(b"\x1b_Ga=T\x1b\\").is_err());
        assert!(writer.write_sequence(b"\x1b_Ga=T\x1b\\").is_err());
    }
}
