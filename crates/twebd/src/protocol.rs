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
    Panes {
        panes: Vec<PaneReport>,
    },
    Status {
        pid: u32,
        socket: String,
        uptime_ms: u64,
        pane_count: usize,
        generation_counter: Generation,
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

    #[test]
    fn requests_round_trip() {
        let cases = vec![
            Request::Attach {
                pane: pane_ref("%3", "srv"),
                pid: 4711,
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

    #[test]
    fn responses_round_trip() {
        let cases = vec![
            Response::Ok,
            Response::Attached {
                page: "bpage_x".into(),
                generation: Generation(1),
                superseded: true,
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
