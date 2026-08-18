//! The supervisor's wire protocol: pane identity, lifecycle and routing. Nothing else.
//!
//! Frame transport and the engine boundary are being measured separately, and this slice must be
//! byte-identical under either answer, so no frame data, page state or navigation appears here.
//! An unknown request kind is answered with an error rather than a disconnect, so a client built
//! against a later protocol degrades instead of failing opaquely.
//!
//! One JSON value per line in each direction. Line-delimited rather than length-prefixed because
//! the transcript of a live session has to be readable with `nc` when something goes wrong.

use serde::{Deserialize, Serialize};
use tweb_core::page::PaneId;

/// The protocol this build speaks.
///
/// Sent on every attach and echoed back, because the daemon and the frontend are separate binaries
/// that a user can end up running from different builds — an installed `twebd` left running while
/// a workspace `tweb` is rebuilt is the ordinary case, not an exotic one. A mismatch has to be a
/// clean "use your own engine", never a frontend that hangs waiting for frames in a shape the
/// daemon does not send.
///
/// Moved to 2 when `host` grew the pane's viewport, origin and tty and the engine grew
/// `KEYBOARD`. Serde ignores unknown fields, so a version-1 daemon handed a version-2 `host` would
/// otherwise accept it and open the pane with no geometry at all — the exact silent-success shape
/// this number exists to prevent. The engine's `READY` line carries it too: a host that answers
/// `READY 1` is refused, and refusal means the pane spawns its own engine and works.
pub const PROTOCOL_VERSION: u32 = 2;

/// A pane's viewport and where it sits in the terminal window.
///
/// Carried in `host` rather than left to the engine because a hosted engine has no `$TMUX_PANE` of
/// its own to measure from — it has N panes and one process identity, which is the defect class
/// this whole protocol exists to fix. The frontend is the process standing in the pane, so it
/// measures and sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneGeometry {
    pub cols: u16,
    pub rows: u16,
    pub width: u32,
    pub height: u32,
    /// Where the pane starts in the window, in cells. `None` means "not measured yet", which is
    /// not the same as `(0, 0)`: that would re-anchor the pane at the window's top-left.
    pub origin: Option<(u32, u32)>,
}

/// A pane as it appears on the wire: the tmux pane id (`%3`) plus the tmux server that issued it.
///
/// Both halves are required. tmux reuses pane ids within a server and hands out the same small
/// ids on a fresh server, so `%3` alone names a different pane depending on who is asking.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneRef {
    pub pane: String,
    pub tmux_server: String,
}

/// A pane key with the pane id parsed. The registry keys on this.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PaneKey {
    pub pane: PaneId,
    pub tmux_server: String,
}

impl std::fmt::Display for PaneKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}@{}", self.pane, self.tmux_server)
    }
}

/// A monotonically increasing registration counter.
///
/// Not a timestamp: two attaches inside the same millisecond must still be ordered, and the whole
/// job of this number is to let a late message from a dead predecessor be recognised as late.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Generation(pub u64);

impl Generation {
    pub fn next(self) -> Self {
        Self(self.0 + 1)
    }
}

impl std::fmt::Display for Generation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("malformed request: {0}")]
    Malformed(String),
    #[error("pane id {0:?} is not a tmux pane id such as %3")]
    BadPaneId(String),
    #[error("tmux server identity is required")]
    MissingTmuxServer,
}

/// Parses a tmux pane id.
///
/// tmux always prints pane ids with the `%` sigil, and a bare number is far more likely to be a
/// pane *index* (which is positional and changes when panes move) than a pane id, so accepting it
/// would silently register the wrong pane.
pub fn parse_pane_id(text: &str) -> Result<PaneId, ProtocolError> {
    text.strip_prefix('%')
        .and_then(|rest| rest.parse::<i32>().ok())
        .filter(|id| *id >= 0)
        .map(PaneId)
        .ok_or_else(|| ProtocolError::BadPaneId(text.to_string()))
}

/// Turns a wire pane reference into a registry key.
pub fn pane_key(reference: &PaneRef) -> Result<PaneKey, ProtocolError> {
    if reference.tmux_server.trim().is_empty() {
        return Err(ProtocolError::MissingTmuxServer);
    }
    Ok(PaneKey {
        pane: parse_pane_id(&reference.pane)?,
        tmux_server: reference.tmux_server.clone(),
    })
}

/// A request from a pane frontend or a diagnostic client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Request {
    /// Register this connection's pane. The connection is then held open for the pane's life.
    Attach {
        #[serde(flatten)]
        pane: PaneRef,
        /// The frontend's pid. Diagnostics only — liveness is the connection, not this number.
        pid: u32,
    },
    /// Register this connection's pane *and* ask the daemon's engine to host its page.
    ///
    /// Separate from [`Request::Attach`] rather than a flag on it, because the two have different
    /// failure modes: a plain attach cannot fail for want of an engine, and a daemon built before
    /// hosting existed answers this with an error and keeps the connection open — which is exactly
    /// the signal the frontend needs to fall back to spawning its own engine.
    Host {
        #[serde(flatten)]
        pane: PaneRef,
        pid: u32,
        /// The frontend's protocol version. A mismatch is answered, not guessed at.
        protocol: u32,
        /// The Kitty image id base the frontend allocated for this pane. It comes from the caller
        /// because the id namespace is terminal-wide and a pane owns a whole *range* of it
        /// (`image_id + 1 ..= image_id + 8` are its damage patches). The frontend allocates from
        /// the pane's identity, so a hosted engine — which has N panes and one process identity —
        /// never has to derive one, which is what it cannot do correctly.
        image_id: u32,
        /// The pane's viewport and origin, measured by the frontend.
        geometry: PaneGeometry,
        /// The pane's own tty, absolute. **Diagnostics and escape hatch only**: frames come back
        /// over this connection and the frontend writes them, because it is already the sole
        /// writer of this pty and a pty write is not atomic at any size. An engine that opened
        /// this path would be a second writing *process*, which no in-process writer can
        /// serialise — the tear measured at roughly one frame in 750.
        tty: Option<String>,
        /// The engine the *frontend* resolved, passed rather than re-resolved by the daemon.
        ///
        /// Engine resolution walks up from the current directory, so it answers differently in a
        /// pane's shell than in a daemon started from somewhere else — running the wrong embedded
        /// copy is the single most expensive mistake in this repo's history. The frontend is the
        /// side standing in the right place, and it has to resolve the engine anyway for its own
        /// fallback, so its answer is the one the daemon uses.
        engine_executable: String,
        engine_app_dir: String,
        url: String,
        frame_rate: u16,
        adaptive_frame_rate: bool,
        restore_session: bool,
    },
    /// One control line for an already-hosted pane — `RESIZE …`, `VIS …`, `INPUT …`, verbatim in
    /// the grammar the single-pane engine already parses.
    ///
    /// Deliberately unanswered: control is a stream, and pairing every keystroke with a response
    /// would put a round trip in the input path for no reader.
    Control {
        #[serde(flatten)]
        pane: PaneRef,
        generation: Generation,
        body: String,
    },
    /// Deregister a pane. Ignored if the generation is not the one currently registered.
    Detach {
        #[serde(flatten)]
        pane: PaneRef,
        generation: Generation,
    },
    /// Every attached pane.
    List,
    /// Daemon-level diagnostics.
    Status,
    /// Shut the daemon down.
    Stop,
}

/// One attached pane as reported by `list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneReport {
    pub pane: String,
    pub tmux_server: String,
    pub generation: Generation,
    pub page: String,
    pub pid: u32,
    pub attached_at_ms: u64,
}

/// Why the daemon would not host a pane.
///
/// A machine-readable reason rather than a message, because it decides control flow: the frontend
/// falls back to spawning its own engine on any of these, and a fallback that turned on matching
/// substrings of a human sentence would break the day someone improved the wording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalReason {
    /// The frontend and the daemon are different builds.
    ProtocolMismatch,
    /// This daemon has no engine that can host a pane — it could not be started, it crashed past
    /// its restart budget, or the resolved engine app predates hosting.
    EngineUnavailable,
    /// A pane with this tmux pane id is already hosted for a different tmux server.
    ///
    /// The engine addresses control lines by pane id alone, so two panes sharing an id make every
    /// `VIS`, `RESIZE` and `INPUT` for it ambiguous. Refusing the second keeps the answer unique,
    /// and a refusal is a pane that spawns its own engine and works.
    PaneIdConflict,
}

/// Something the daemon pushes to an attached frontend without being asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum PaneEvent {
    /// The hosted engine is gone and this pane is no longer being painted. The frontend's job on
    /// seeing this is to stop trusting the daemon for this pane and spawn its own engine.
    EngineLost { reason: String },
    /// The engine dropped this one pane while continuing to serve others.
    Closed { reason: String },
    /// Where this pane's agent socket ended up.
    AgentSocket { path: String },
    /// Whether this pane currently holds the audio claim.
    Audio { audible: bool },
    /// Re-declare this pane's keyboard mode on its own pty.
    ///
    /// Replaces the SIGUSR1 the engine used to send its frontend after native DevTools reset the
    /// terminal modes. A signal names a *process*, and a hosted engine's idea of "my frontend" is
    /// the supervisor — which owns no pty, has nothing to re-declare, and (SIGUSR1's default action
    /// being terminate) died of it. The mode belongs to one pane's pty, so the message has to be
    /// addressed to that pane and delivered to the process holding it.
    KeyboardRestore,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    Ok,
    Attached {
        page: String,
        generation: Generation,
        /// True when this attach displaced an earlier registration for the same pane key.
        superseded: bool,
    },
    /// The pane is registered *and* its page is being hosted by the daemon's engine.
    Hosted {
        page: String,
        generation: Generation,
        protocol: u32,
    },
    /// The pane was not hosted, and nothing was registered. The frontend spawns its own engine.
    HostRefused {
        reason: RefusalReason,
        detail: String,
    },
    /// Bytes this pane's frontend must write to its own tty, verbatim, hex-encoded.
    ///
    /// The daemon does not write pane ttys itself: the frontend is already the sole writer of
    /// caret, cursor-shape and teardown sequences on that pty, and a pty write is not atomic at
    /// any size, so routing frames through it is what keeps one serialising writer per pane tty.
    Frame {
        pane: String,
        generation: Generation,
        payload: String,
    },
    Event {
        pane: String,
        generation: Generation,
        #[serde(flatten)]
        event: PaneEvent,
    },
    Panes {
        panes: Vec<PaneReport>,
    },
    Status {
        pid: u32,
        socket: String,
        uptime_ms: u64,
        pane_count: usize,
        generation_counter: Generation,
        protocol: u32,
        /// What the daemon's hosted engine is doing. Diagnostics, and the thing that tells an
        /// operator whether a pane fell back because of the flag or because of the engine.
        engine: String,
        hosted_pane_count: usize,
    },
    Error {
        message: String,
    },
}

/// Decodes one request line.
pub fn decode_request(line: &str) -> Result<Request, ProtocolError> {
    serde_json::from_str(line.trim()).map_err(|err| ProtocolError::Malformed(err.to_string()))
}

/// Encodes one request as a line, newline included.
pub fn encode_request(request: &Request) -> String {
    let mut line = serde_json::to_string(request).expect("request is always serializable");
    line.push('\n');
    line
}

/// Decodes one response line.
pub fn decode_response(line: &str) -> Result<Response, ProtocolError> {
    serde_json::from_str(line.trim()).map_err(|err| ProtocolError::Malformed(err.to_string()))
}

/// Encodes one response as a line, newline included.
pub fn encode_response(response: &Response) -> String {
    let mut line = serde_json::to_string(response).expect("response is always serializable");
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane_ref(pane: &str, server: &str) -> PaneRef {
        PaneRef {
            pane: pane.to_string(),
            tmux_server: server.to_string(),
        }
    }

    #[test]
    fn pane_ids_need_the_tmux_sigil() {
        assert_eq!(parse_pane_id("%3"), Ok(PaneId(3)));
        assert_eq!(parse_pane_id("%0"), Ok(PaneId(0)));
        assert_eq!(parse_pane_id("%124"), Ok(PaneId(124)));
        assert!(parse_pane_id("3").is_err());
        assert!(parse_pane_id("%-1").is_err());
        assert!(parse_pane_id("%abc").is_err());
        assert!(parse_pane_id("").is_err());
    }

    #[test]
    fn a_pane_key_needs_a_server_identity() {
        assert_eq!(
            pane_key(&pane_ref("%3", "  ")),
            Err(ProtocolError::MissingTmuxServer)
        );
        let key = pane_key(&pane_ref("%3", "/tmp/tmux-501/default,1,0")).expect("valid");
        assert_eq!(key.pane, PaneId(3));
        assert_eq!(key.tmux_server, "/tmp/tmux-501/default,1,0");
    }

    #[test]
    fn the_same_pane_id_on_two_servers_is_two_keys() {
        let a = pane_key(&pane_ref("%3", "/tmp/tmux-501/default,1,0")).expect("valid");
        let b = pane_key(&pane_ref("%3", "/tmp/tmux-501/other,2,0")).expect("valid");
        assert_ne!(a, b);
    }

    fn geometry() -> PaneGeometry {
        PaneGeometry {
            cols: 80,
            rows: 24,
            width: 800,
            height: 480,
            origin: Some((20, 0)),
        }
    }

    #[test]
    fn requests_round_trip() {
        let cases = vec![
            Request::Attach {
                pane: pane_ref("%3", "srv"),
                pid: 4711,
            },
            Request::Host {
                pane: pane_ref("%3", "srv"),
                pid: 4711,
                protocol: PROTOCOL_VERSION,
                image_id: 909,
                geometry: geometry(),
                tty: Some("/dev/ttys004".into()),
                engine_executable: "/opt/Electron".into(),
                engine_app_dir: "/opt/tweb/electron".into(),
                url: "https://example.com".into(),
                frame_rate: 30,
                adaptive_frame_rate: true,
                restore_session: false,
            },
            Request::Control {
                pane: pane_ref("%3", "srv"),
                generation: Generation(2),
                body: "INPUT 1b5b41".into(),
            },
            Request::Detach {
                pane: pane_ref("%3", "srv"),
                generation: Generation(7),
            },
            Request::List,
            Request::Status,
            Request::Stop,
        ];
        for request in cases {
            let line = encode_request(&request);
            assert!(line.ends_with('\n'));
            assert_eq!(decode_request(&line), Ok(request));
        }
    }

    // A pane that has not measured its placement yet is not a pane at the window's top-left.
    // Collapsing the two would re-anchor it there, which is a visible jump on every cold start.
    #[test]
    fn an_unmeasured_origin_is_not_an_origin_of_zero() {
        let unmeasured = PaneGeometry {
            origin: None,
            ..geometry()
        };
        let line = serde_json::to_string(&unmeasured).expect("serializable");
        assert_eq!(
            serde_json::from_str::<PaneGeometry>(&line).expect("valid"),
            unmeasured
        );
        assert_ne!(
            unmeasured,
            PaneGeometry {
                origin: Some((0, 0)),
                ..geometry()
            }
        );
    }

    // The whole point of the version field: a daemon from another build must be *detected*, not
    // guessed at. A frontend that assumed compatibility would hang waiting for frames in a shape
    // the daemon does not send.
    #[test]
    fn host_carries_the_protocol_version_on_the_wire() {
        let line = encode_request(&Request::Host {
            pane: pane_ref("%3", "srv"),
            pid: 1,
            protocol: PROTOCOL_VERSION,
            image_id: 5,
            geometry: geometry(),
            tty: Some("/dev/ttys004".into()),
            engine_executable: "/opt/Electron".into(),
            engine_app_dir: "/opt/tweb/electron".into(),
            url: "https://example.com".into(),
            frame_rate: 30,
            adaptive_frame_rate: false,
            restore_session: true,
        });
        let value: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(value["kind"], "host");
        assert_eq!(value["pane"], "%3");
        assert_eq!(value["protocol"], PROTOCOL_VERSION);
        assert_eq!(value["image_id"], 5);
        assert_eq!(value["restore_session"], true);
        assert_eq!(value["geometry"]["cols"], 80);
        assert_eq!(value["tty"], "/dev/ttys004");
    }

    // Serde ignores unknown fields, so a version-1 daemon handed a version-2 `host` would decode it
    // happily and open the pane with no geometry at all — a silent success that paints nothing.
    // The version number is what turns that into a refusal, so it must actually have moved.
    #[test]
    fn the_version_moved_when_host_grew_fields() {
        let previous_version_that_lacked_geometry = 1;
        assert!(
            PROTOCOL_VERSION > previous_version_that_lacked_geometry,
            "geometry, tty and keyboard_restore are protocol 2"
        );
    }

    // A daemon built before hosting existed answers `host` with an error and keeps the connection
    // open — this is the decode side of that, and it is what makes an older daemon a fallback
    // trigger rather than a hang.
    #[test]
    fn a_host_request_is_unknown_to_an_older_protocol_reader() {
        let err = decode_request(r#"{"kind":"host","pane":"%3"}"#).unwrap_err();
        assert!(matches!(err, ProtocolError::Malformed(_)));
    }

    #[test]
    fn responses_round_trip() {
        let cases = vec![
            Response::Ok,
            Response::Attached {
                page: "bpage_x".into(),
                generation: Generation(1),
                superseded: true,
            },
            Response::Hosted {
                page: "bpage_x".into(),
                generation: Generation(3),
                protocol: PROTOCOL_VERSION,
            },
            Response::HostRefused {
                reason: RefusalReason::EngineUnavailable,
                detail: "no hosted-capable engine".into(),
            },
            Response::Frame {
                pane: "%3".into(),
                generation: Generation(4),
                payload: "1b5f47".into(),
            },
            Response::Event {
                pane: "%3".into(),
                generation: Generation(4),
                event: PaneEvent::EngineLost {
                    reason: "exited".into(),
                },
            },
            Response::Event {
                pane: "%3".into(),
                generation: Generation(4),
                event: PaneEvent::AgentSocket {
                    path: "/tmp/a.sock".into(),
                },
            },
            Response::Event {
                pane: "%3".into(),
                generation: Generation(4),
                event: PaneEvent::Audio { audible: true },
            },
            Response::Event {
                pane: "%3".into(),
                generation: Generation(4),
                event: PaneEvent::KeyboardRestore,
            },
            Response::Event {
                pane: "%3".into(),
                generation: Generation(4),
                event: PaneEvent::Closed {
                    reason: "renderer-gone".into(),
                },
            },
            Response::Panes {
                panes: vec![PaneReport {
                    pane: "%3".into(),
                    tmux_server: "srv".into(),
                    generation: Generation(2),
                    page: "bpage_y".into(),
                    pid: 12,
                    attached_at_ms: 99,
                }],
            },
            Response::Status {
                pid: 1,
                socket: "/tmp/x.sock".into(),
                uptime_ms: 5,
                pane_count: 1,
                generation_counter: Generation(2),
                protocol: PROTOCOL_VERSION,
                engine: "idle".into(),
                hosted_pane_count: 0,
            },
            Response::Error {
                message: "no".into(),
            },
        ];
        for response in cases {
            let line = encode_response(&response);
            assert_eq!(decode_response(&line), Ok(response));
        }
    }

    #[test]
    fn the_attach_wire_form_is_flat() {
        let line = encode_request(&Request::Attach {
            pane: pane_ref("%3", "srv"),
            pid: 7,
        });
        let value: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(value["kind"], "attach");
        assert_eq!(value["pane"], "%3");
        assert_eq!(value["tmux_server"], "srv");
        assert_eq!(value["pid"], 7);
    }

    #[test]
    fn an_unknown_kind_is_a_malformed_request_not_a_panic() {
        let err = decode_request(r#"{"kind":"render_frame","bytes":"..."}"#).unwrap_err();
        assert!(matches!(err, ProtocolError::Malformed(_)));
    }

    #[test]
    fn trailing_whitespace_and_blank_lines_do_not_decode_as_requests() {
        assert_eq!(
            decode_request("  {\"kind\":\"list\"}  \n"),
            Ok(Request::List)
        );
        assert!(decode_request("   ").is_err());
    }

    #[test]
    fn generations_are_ordered_and_monotonic() {
        assert_eq!(Generation(4).next(), Generation(5));
        assert!(Generation(4) < Generation(5));
    }
}
