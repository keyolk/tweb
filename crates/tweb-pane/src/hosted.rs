//! Running a pane whose page lives in the daemon.
//!
//! The frontend keeps every job it has today except one: it no longer spawns an engine. It still
//! owns the terminal, the raw input, the geometry and visibility polling, the alternate screen and
//! the teardown — and, decisively, it is still **the only writer of this pane's pty**. Frames come
//! back from the daemon as bytes and are written here, through the same [`crate::pane_writer`]
//! that the caret and the image delete go through, so hosting adds no second writer to a tty where
//! a write is not atomic at any size.
//!
//! Every exit from this module that is not a clean pane close is a fallback: the caller spawns an
//! engine and the pane carries on exactly as it does today.

use crate::attach::{message_is_current, SpawnReason};
use crate::pane_writer::PaneWriter;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::Arc;
use twebd::protocol::{
    decode_response, encode_request, Generation, PaneEvent, PaneRef, Request, Response,
    PROTOCOL_VERSION,
};

/// What a hosted attempt produced.
#[derive(Debug)]
pub enum Outcome {
    /// The pane ran hosted and is finished. Nothing more to do.
    Finished,
    /// Hosting is not happening. Spawn an engine — the pane has not started yet, or it has and the
    /// daemon lost it, and either way today's path is what runs from here.
    FallBack(SpawnReason),
}

/// Everything a `host` request needs that the frontend knows and the daemon does not.
pub struct HostRequest<'a> {
    pub pane: PaneRef,
    pub image_id: u32,
    pub url: &'a str,
    pub frame_rate: u16,
    pub adaptive_frame_rate: bool,
    pub restore_session: bool,
    /// Measured here because a hosted engine cannot measure it: measurement reads `$TMUX_PANE`,
    /// and a hosted engine's own is the daemon's pane, not any of the N it serves.
    pub geometry: twebd::protocol::PaneGeometry,
    /// This pane's tty. Passed for diagnostics, not as a write target — frames come back over the
    /// connection and are written here, because this process is already the sole writer of it.
    pub tty: Option<String>,
    /// Resolved by the frontend, because resolution walks up from the current directory and the
    /// frontend is the process standing in the pane's shell. A daemon started elsewhere would
    /// silently resolve a different engine app.
    pub engine_executable: String,
    pub engine_app_dir: String,
}

/// Opens the connection and asks the daemon to host this pane.
///
/// Returns the live connection and the generation the daemon assigned, or the reason to spawn.
pub fn connect_and_host(
    socket: &Path,
    request: &HostRequest<'_>,
    pid: u32,
) -> Result<(UnixStream, Generation), SpawnReason> {
    let stream =
        UnixStream::connect(socket).map_err(|err| SpawnReason::ConnectFailed(err.to_string()))?;
    let mut writer = stream
        .try_clone()
        .map_err(|err| SpawnReason::ConnectFailed(err.to_string()))?;
    let line = encode_request(&Request::Host {
        pane: request.pane.clone(),
        pid,
        protocol: PROTOCOL_VERSION,
        image_id: request.image_id,
        geometry: request.geometry,
        tty: request.tty.clone(),
        engine_executable: request.engine_executable.clone(),
        engine_app_dir: request.engine_app_dir.clone(),
        url: request.url.to_string(),
        frame_rate: request.frame_rate,
        adaptive_frame_rate: request.adaptive_frame_rate,
        restore_session: request.restore_session,
    });
    writer
        .write_all(line.as_bytes())
        .and_then(|()| writer.flush())
        .map_err(|err| SpawnReason::ConnectFailed(err.to_string()))?;

    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|err| SpawnReason::ConnectFailed(err.to_string()))?,
    );
    let mut answer = String::new();
    match reader.read_line(&mut answer) {
        // The daemon hung up without answering. Not distinguishable from — and not worth
        // distinguishing from — a daemon that cannot host.
        Ok(0) => {
            return Err(SpawnReason::ConnectFailed(
                "twebd closed the connection".into(),
            ))
        }
        Ok(_) => {}
        Err(err) => return Err(SpawnReason::ConnectFailed(err.to_string())),
    }
    let response =
        decode_response(&answer).map_err(|err| SpawnReason::UnexpectedAnswer(err.to_string()))?;
    match crate::attach::route_from_answer(&response)? {
        crate::attach::Route::Daemon => match response {
            Response::Hosted { generation, .. } => Ok((stream, generation)),
            other => Err(SpawnReason::UnexpectedAnswer(format!("{other:?}"))),
        },
        // `route_from_answer` only returns `Daemon` for a `Hosted` response, so this arm is
        // unreachable in practice; treating it as a fallback rather than a panic keeps the rule
        // "every uncertainty spawns" true even if that function later grows a case.
        crate::attach::Route::Spawn => Err(SpawnReason::UnexpectedAnswer(format!("{response:?}"))),
    }
}

/// Applies one response from the daemon to this pane.
///
/// Pure apart from the writer it is handed, so the generation filtering and the fallback triggers
/// are testable without a daemon, a terminal or an engine.
pub fn apply(
    response: &Response,
    ours: Generation,
    writer: &PaneWriter,
) -> Result<(), SpawnReason> {
    match response {
        Response::Frame {
            generation,
            payload,
            ..
        } => {
            // A frame stamped with a superseded generation belongs to a frontend that has already
            // been replaced. tmux reuses pane ids, so writing it would draw the previous
            // occupant's page onto this pane.
            if !message_is_current(ours.0, generation.0) {
                return Ok(());
            }
            let Some(bytes) = twebd::engine_wire::decode_hex(payload) else {
                // A frame that cannot be decoded whole is dropped whole: half an escape sequence
                // leaves the terminal parsing graphics and printing the rest as literal text.
                return Ok(());
            };
            // An IO error on this pane's own tty is not a reason to fall back to a *second*
            // process writing the same broken tty. The pane is going away; let the read loop
            // notice the connection close.
            let _ = writer.write_sequence(&bytes);
            Ok(())
        }
        Response::Event {
            generation, event, ..
        } => {
            if !message_is_current(ours.0, generation.0) {
                return Ok(());
            }
            match event {
                PaneEvent::EngineLost { reason } => {
                    Err(SpawnReason::HostedSessionLost(reason.clone()))
                }
                PaneEvent::Closed { reason } => Err(SpawnReason::HostedSessionLost(reason.clone())),
                // Recorded rather than acted on: the frontend does not own the agent socket or the
                // audio claim, it only needs them in its diagnostics.
                PaneEvent::AgentSocket { path } => {
                    tracing::info!(path = %path, "hosted pane agent socket");
                    Ok(())
                }
                PaneEvent::Audio { audible } => {
                    tracing::debug!(audible, "hosted pane audio claim");
                    Ok(())
                }
                // The SIGUSR1 replacement, and the reason it had to become an addressed event:
                // this process holds the pane's pty, so it is the only one that can re-declare
                // the mode. It goes through the pane writer rather than straight at stdout —
                // writing the tty directly is exactly the second-writer hazard the writer exists
                // to close, and a frame is in flight on this path several times a second.
                PaneEvent::KeyboardRestore => {
                    if crate::terminal::keyboard_mode_is_tracked() {
                        let _ = writer.write_sequence(crate::terminal::TRACKED_KEYBOARD_MODE);
                    }
                    Ok(())
                }
            }
        }
        // `control` is answered `ok` and nothing else arrives unsolicited.
        Response::Ok => Ok(()),
        Response::Error { message } => {
            tracing::warn!(%message, "twebd reported an error on a hosted pane");
            Ok(())
        }
        other => {
            tracing::debug!(?other, "unexpected response on a hosted pane");
            Ok(())
        }
    }
}

/// Reads from the daemon until the pane ends or hosting is lost.
///
/// Blocking, and run on its own thread: the frontend's async runtime is busy with terminal input
/// and the geometry tick, and a hosted pane's frame path must not queue behind either.
pub fn pump(stream: UnixStream, ours: Generation, writer: Arc<PaneWriter>) -> SpawnReason {
    let reader = match stream.try_clone() {
        Ok(clone) => BufReader::new(clone),
        Err(err) => return SpawnReason::HostedSessionLost(err.to_string()),
    };
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => return SpawnReason::HostedSessionLost(err.to_string()),
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(response) = decode_response(&line) else {
            continue;
        };
        if let Err(reason) = apply(&response, ours, &writer) {
            return reason;
        }
    }
    // The daemon went away. The pane is still alive and still owns its terminal, so it falls back
    // rather than exiting — a user's browser does not close because a supervisor did.
    SpawnReason::HostedSessionLost("twebd closed the connection".into())
}

/// One control line for a hosted pane, in the grammar the engine already parses.
pub fn control_request(pane: &PaneRef, generation: Generation, body: &str) -> Request {
    Request::Control {
        pane: pane.clone(),
        generation,
        // The single-pane path builds these with a trailing newline for a pipe. The wire is one
        // JSON value per line, so an embedded newline in the body would be carried into the
        // daemon's own line framing.
        body: body.trim_end_matches('\n').to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default, Clone)]
    struct Recorder(Arc<Mutex<Vec<u8>>>);

    impl Write for Recorder {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("lock").extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn writer() -> (PaneWriter, Recorder) {
        let recorder = Recorder::default();
        (PaneWriter::new(Box::new(recorder.clone())), recorder)
    }

    fn written(recorder: &Recorder) -> Vec<u8> {
        recorder.0.lock().expect("lock").clone()
    }

    #[test]
    fn a_frame_for_this_generation_reaches_the_tty_byte_for_byte() {
        let (writer, recorder) = writer();
        let payload = b"\x1b_Ga=T,f=100,i=42;path\x1b\\";
        apply(
            &Response::Frame {
                pane: "%3".into(),
                generation: Generation(4),
                payload: twebd::engine_wire::encode_hex(payload),
            },
            Generation(4),
            &writer,
        )
        .expect("a frame is not a fallback");
        assert_eq!(written(&recorder), payload);
    }

    // tmux reuses pane ids. A frame from the frontend this one replaced would draw the previous
    // occupant's page onto this pane.
    #[test]
    fn a_frame_from_a_superseded_generation_is_never_written() {
        let (writer, recorder) = writer();
        for generation in [Generation(3), Generation(5)] {
            apply(
                &Response::Frame {
                    pane: "%3".into(),
                    generation,
                    payload: twebd::engine_wire::encode_hex(b"\x1b_Ga=T;x\x1b\\"),
                },
                Generation(4),
                &writer,
            )
            .expect("a stale frame is dropped, not a fallback");
        }
        assert!(written(&recorder).is_empty());
    }

    // Half an escape sequence leaves the terminal parsing graphics and printing the rest as
    // literal text, which persists until a repaint. Nothing is better than a prefix.
    #[test]
    fn an_undecodable_frame_writes_nothing_at_all() {
        let (writer, recorder) = writer();
        apply(
            &Response::Frame {
                pane: "%3".into(),
                generation: Generation(1),
                payload: "1b5f4".into(),
            },
            Generation(1),
            &writer,
        )
        .expect("dropped, not a fallback");
        assert!(written(&recorder).is_empty());
    }

    #[test]
    fn losing_the_engine_or_the_page_falls_back() {
        let (writer, _) = writer();
        for event in [
            PaneEvent::EngineLost {
                reason: "engine exited: signal 9".into(),
            },
            PaneEvent::Closed {
                reason: "renderer-gone".into(),
            },
        ] {
            let result = apply(
                &Response::Event {
                    pane: "%3".into(),
                    generation: Generation(1),
                    event,
                },
                Generation(1),
                &writer,
            );
            assert!(matches!(result, Err(SpawnReason::HostedSessionLost(_))));
        }
    }

    // A dead predecessor's engine loss must not tear down the pane that replaced it.
    #[test]
    fn a_stale_engine_lost_event_does_not_fall_back() {
        let (writer, _) = writer();
        apply(
            &Response::Event {
                pane: "%3".into(),
                generation: Generation(1),
                event: PaneEvent::EngineLost {
                    reason: "old".into(),
                },
            },
            Generation(2),
            &writer,
        )
        .expect("stale events are dropped");
    }

    #[test]
    fn agent_and_audio_events_are_recorded_without_ending_the_session() {
        let (writer, recorder) = writer();
        for event in [
            PaneEvent::AgentSocket {
                path: "/tmp/a.sock".into(),
            },
            PaneEvent::Audio { audible: true },
        ] {
            apply(
                &Response::Event {
                    pane: "%3".into(),
                    generation: Generation(1),
                    event,
                },
                Generation(1),
                &writer,
            )
            .expect("not a fallback");
        }
        assert!(written(&recorder).is_empty(), "these are not tty bytes");
    }

    // The SIGUSR1 replacement. #28 removed the hazard (a daemon dying of the default action) but
    // lost the *function* on the hosted path: nothing re-declared the mode after DevTools reset
    // it. The bytes have to reach this pane's own pty, and through the writer — the tty already
    // carries frames, and a second writer on it is the tear the writer exists to prevent.
    #[test]
    fn a_keyboard_restore_puts_the_tracked_sequence_on_this_panes_tty() {
        // The mode only exists inside tmux, and the test process may be anywhere.
        if !crate::terminal::keyboard_mode_is_tracked() {
            return;
        }
        let (writer, recorder) = writer();
        apply(
            &Response::Event {
                pane: "%3".into(),
                generation: Generation(1),
                event: PaneEvent::KeyboardRestore,
            },
            Generation(1),
            &writer,
        )
        .expect("a restore is not a fallback");
        assert_eq!(written(&recorder), crate::terminal::TRACKED_KEYBOARD_MODE);
    }

    // A restore stamped with a dead predecessor's generation would re-declare a mode on behalf of
    // a frontend that no longer owns this pane.
    #[test]
    fn a_stale_keyboard_restore_writes_nothing() {
        let (writer, recorder) = writer();
        apply(
            &Response::Event {
                pane: "%3".into(),
                generation: Generation(1),
                event: PaneEvent::KeyboardRestore,
            },
            Generation(2),
            &writer,
        )
        .expect("stale events are dropped");
        assert!(written(&recorder).is_empty());
    }

    // The wire is one JSON value per line; a body carrying its own newline would be carried into
    // the daemon's line framing and split the request in two.
    #[test]
    fn a_control_body_never_carries_its_own_newline() {
        let request = control_request(
            &PaneRef {
                pane: "%3".into(),
                tmux_server: "srv".into(),
            },
            Generation(2),
            "RESIZE 80 24 800 480\n",
        );
        let Request::Control { body, .. } = request else {
            panic!("expected a control request");
        };
        assert_eq!(body, "RESIZE 80 24 800 480");
        assert!(!encode_request(&control_request(
            &PaneRef {
                pane: "%3".into(),
                tmux_server: "srv".into()
            },
            Generation(2),
            "INPUT 1b\n"
        ))
        .trim_end()
        .contains('\n'));
    }
}
