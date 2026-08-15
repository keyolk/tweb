//! The line grammar between the supervisor and the one hosted engine process.
//!
//! Every line is addressed to exactly one pane, because a hosted engine serves N of them over a
//! single stdin/stdout pair. The address form is `@%3 ` — a prefix, not a re-encoding — so the
//! engine strips it and hands the remainder to the parser it already had. An *unaddressed* line
//! keeps its current meaning of "the implicit sole pane", which is what lets the one-Electron-per-
//! pane path stay byte-identical while this exists beside it.
//!
//! Payload bytes are hex rather than base64: the repo already hex-frames terminal input in this
//! same channel, and a second encoding in one protocol is a decoding bug waiting for the day the
//! two get crossed.

use crate::protocol::Generation;

/// The address prefix a hosted line carries.
///
/// Written out rather than formatted inline so the engine-side parser and this side cannot drift
/// on whitespace, which would fail as "the pane silently never gets its input".
pub fn address(pane: &str) -> String {
    format!("@{pane} ")
}

/// One control line for a hosted pane, newline included.
///
/// `body` is the exact text the single-pane path already writes to the engine's stdin
/// (`RESIZE 80 24 800 480`, `VIS 1`, `INPUT 1b5b41`), unchanged. Only the address is added.
pub fn control_line(pane: &str, body: &str) -> String {
    format!("{}{}\n", address(pane), body.trim_end_matches('\n'))
}

/// The line that opens a pane on the hosted engine.
///
/// Carries what used to be per-process environment (`TWEB_IMAGE_ID`, `TWEB_URL`,
/// `TWEB_FRAME_RATE`, `TWEB_ADAPTIVE_FRAME_RATE`, `TWEB_RESTORE_SESSION`). None of those can stay
/// an env var once one process hosts N panes, and the image id in particular must come *from the
/// caller*: legacy per-pane engines derive theirs from their own pid, so a host that invented its
/// own range would collide with them in the terminal-wide Kitty id namespace.
///
/// The url goes last and is not escaped, because a url cannot contain a raw newline and every
/// other field is a number — so the engine can split on whitespace a fixed number of times and
/// take the rest verbatim.
pub struct OpenRequest<'a> {
    pub pane: &'a str,
    pub tmux_server: &'a str,
    pub generation: Generation,
    pub image_id: u32,
    pub frame_rate: u16,
    pub adaptive_frame_rate: bool,
    pub restore_session: bool,
    pub url: &'a str,
}

pub fn open_line(request: &OpenRequest<'_>) -> String {
    control_line(
        request.pane,
        &format!(
            "ATTACH {} {} {} {} {} {} {}",
            request.tmux_server,
            request.generation,
            request.image_id,
            request.frame_rate,
            u8::from(request.adaptive_frame_rate),
            u8::from(request.restore_session),
            request.url,
        ),
    )
}

pub fn close_line(pane: &str) -> String {
    control_line(pane, "DETACH")
}

/// What the hosted engine says back, on its stdout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineEvent {
    /// The engine's protocol version, sent once at startup. Unaddressed: it is about the process.
    Ready { protocol: u32 },
    /// Bytes the pane's frontend must write to its own tty, verbatim.
    Frame { pane: String, payload: Vec<u8> },
    /// Where this pane's agent socket ended up. Per-process today only because the process is the
    /// pane; a host has to say which pane each socket belongs to.
    AgentSocket { pane: String, path: String },
    /// Whether this pane currently claims audio. Arbitration between panes of one runtime happens
    /// inside it; this is what the runtime tells the supervisor so the claim can reach other
    /// runtimes.
    Audio { pane: String, audible: bool },
    /// The engine dropped this pane on its own (a page that closed itself, a crashed renderer it
    /// could not recover). The frontend has to hear it, because its pane is now blank.
    Closed { pane: String, reason: String },
}

/// Parses one line of engine stdout.
///
/// Returns `None` for anything unrecognised rather than erroring: Chromium writes to this process's
/// stdout on its own schedule, and a daemon that treated an unexpected line as fatal would drop
/// every hosted pane the first time a GPU warning appeared.
pub fn parse_event(line: &str) -> Option<EngineEvent> {
    let line = line.trim();
    if let Some(version) = line.strip_prefix("READY ") {
        return version
            .trim()
            .parse()
            .ok()
            .map(|protocol| EngineEvent::Ready { protocol });
    }
    let addressed = line.strip_prefix('@')?;
    let (pane, rest) = addressed.split_once(' ')?;
    if crate::protocol::parse_pane_id(pane).is_err() {
        return None;
    }
    let pane = pane.to_string();
    let (verb, argument) = match rest.split_once(' ') {
        Some((verb, argument)) => (verb, argument),
        None => (rest, ""),
    };
    match verb {
        "FRAME" => decode_hex(argument).map(|payload| EngineEvent::Frame { pane, payload }),
        "AGENT" if !argument.is_empty() => Some(EngineEvent::AgentSocket {
            pane,
            path: argument.to_string(),
        }),
        "AUDIO" => match argument {
            "0" => Some(EngineEvent::Audio {
                pane,
                audible: false,
            }),
            "1" => Some(EngineEvent::Audio {
                pane,
                audible: true,
            }),
            _ => None,
        },
        "CLOSED" => Some(EngineEvent::Closed {
            pane,
            reason: argument.to_string(),
        }),
        _ => None,
    }
}

/// Lowercase hex, the same form the input channel already uses.
pub fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Decodes hex, rejecting an odd length rather than dropping the last nibble.
///
/// A truncated frame is not a frame: writing half an escape sequence to a tty leaves the terminal
/// parsing graphics and printing the rest of the payload as literal text, which persists until a
/// repaint. Dropping it whole is strictly better than emitting a prefix.
pub fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_control_line_is_the_single_pane_body_with_an_address_in_front() {
        assert_eq!(
            control_line("%3", "RESIZE 80 24 800 480 20 0"),
            "@%3 RESIZE 80 24 800 480 20 0\n"
        );
        assert_eq!(control_line("%12", "VIS 1"), "@%12 VIS 1\n");
    }

    #[test]
    fn a_body_that_already_ends_in_a_newline_does_not_get_two() {
        // The frontend's messages are built with a trailing newline for the single-pane path, so
        // forwarding one verbatim must not produce a blank line the engine parses as garbage.
        assert_eq!(control_line("%3", "VIS 1\n"), "@%3 VIS 1\n");
    }

    #[test]
    fn open_carries_what_used_to_be_environment() {
        let line = open_line(&OpenRequest {
            pane: "%3",
            tmux_server: "/tmp/tmux-501/default,1,0",
            generation: Generation(7),
            image_id: 4242,
            frame_rate: 30,
            adaptive_frame_rate: true,
            restore_session: false,
            url: "https://example.com/a b",
        });
        assert_eq!(
            line,
            "@%3 ATTACH /tmp/tmux-501/default,1,0 7 4242 30 1 0 https://example.com/a b\n"
        );
    }

    #[test]
    fn close_names_the_pane() {
        assert_eq!(close_line("%9"), "@%9 DETACH\n");
    }

    #[test]
    fn frames_round_trip_through_hex() {
        let payload = b"\x1b_Gf=32,t=f,i=42;L3RtcA==\x1b\\".to_vec();
        let line = control_line("%3", &format!("FRAME {}", encode_hex(&payload)));
        let event = parse_event(line.trim()).expect("parsed");
        assert_eq!(
            event,
            EngineEvent::Frame {
                pane: "%3".into(),
                payload
            }
        );
    }

    #[test]
    fn every_event_kind_parses() {
        assert_eq!(
            parse_event("READY 1"),
            Some(EngineEvent::Ready { protocol: 1 })
        );
        assert_eq!(
            parse_event("@%3 AGENT /tmp/tweb-501/agent-3.sock"),
            Some(EngineEvent::AgentSocket {
                pane: "%3".into(),
                path: "/tmp/tweb-501/agent-3.sock".into()
            })
        );
        assert_eq!(
            parse_event("@%3 AUDIO 1"),
            Some(EngineEvent::Audio {
                pane: "%3".into(),
                audible: true
            })
        );
        assert_eq!(
            parse_event("@%3 AUDIO 0"),
            Some(EngineEvent::Audio {
                pane: "%3".into(),
                audible: false
            })
        );
        assert_eq!(
            parse_event("@%3 CLOSED renderer-gone"),
            Some(EngineEvent::Closed {
                pane: "%3".into(),
                reason: "renderer-gone".into()
            })
        );
    }

    // Chromium logs to this stdout whenever it likes. Treating an unparsed line as fatal would
    // drop every hosted pane the first time a GPU warning appeared.
    #[test]
    fn engine_noise_is_ignored_rather_than_fatal() {
        for noise in [
            "[12345:0814/221500.123:ERROR:gpu_init.cc(521)] Passthrough is not supported",
            "",
            "@ FRAME 00",
            "@notapane FRAME 00",
            "@%3 SOMETHING_NEW 1",
            "@%3 AUDIO maybe",
            "@%3 AGENT",
            "READY not-a-number",
        ] {
            assert_eq!(parse_event(noise), None, "should be ignored: {noise:?}");
        }
    }

    // Half an escape sequence on a tty leaves the terminal parsing graphics and printing the rest
    // as literal text. A frame that cannot be decoded whole must not be delivered at all.
    #[test]
    fn a_truncated_or_non_hex_frame_is_dropped_whole() {
        assert_eq!(parse_event("@%3 FRAME abc"), None);
        assert_eq!(parse_event("@%3 FRAME zz"), None);
        assert_eq!(decode_hex("0"), None);
        assert_eq!(decode_hex("0g"), None);
    }

    #[test]
    fn an_empty_frame_is_a_frame_with_no_bytes_not_an_error() {
        assert_eq!(
            parse_event("@%3 FRAME"),
            Some(EngineEvent::Frame {
                pane: "%3".into(),
                payload: Vec::new()
            })
        );
    }

    #[test]
    fn hex_is_lowercase_and_zero_padded() {
        assert_eq!(encode_hex(&[0x00, 0x0f, 0xff, 0x1b]), "000fff1b");
        assert_eq!(decode_hex("000FFF1B"), Some(vec![0x00, 0x0f, 0xff, 0x1b]));
    }
}
