//! A blocking client for the supervisor socket.
//!
//! Blocking and std-only on purpose: every caller here is a one-shot command or an attach that
//! then sleeps, and a runtime would add nothing except a reason for the held connection to be
//! closed by a task cancellation the operator cannot see.

use crate::protocol::{decode_response, encode_request, Request, Response};
use anyhow::{bail, Context, Result};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;

/// A connection to a running supervisor.
pub struct Client {
    stream: UnixStream,
    reader: BufReader<UnixStream>,
}

impl Client {
    /// Connects, or reports that no daemon is listening.
    pub fn connect(socket_path: &Path) -> Result<Self> {
        let stream = UnixStream::connect(socket_path).with_context(|| {
            format!(
                "no twebd listening at {} (start one with `twebd serve`)",
                socket_path.display()
            )
        })?;
        let reader = BufReader::new(stream.try_clone().context("cannot clone the socket")?);
        Ok(Self { stream, reader })
    }

    /// Sends one request and reads its response.
    pub fn call(&mut self, request: &Request) -> Result<Response> {
        self.stream.write_all(encode_request(request).as_bytes())?;
        self.stream.flush()?;
        let mut line = String::new();
        if self.reader.read_line(&mut line)? == 0 {
            bail!("twebd closed the connection without answering");
        }
        decode_response(&line).map_err(Into::into)
    }

    /// Blocks until the daemon closes the connection.
    ///
    /// Used by an attached client that has nothing more to say: the connection itself is the
    /// pane's liveness signal, so it must stay open, and the process must not exit.
    pub fn block_until_closed(&mut self) -> Result<()> {
        let mut line = String::new();
        while self.reader.read_line(&mut line)? != 0 {
            line.clear();
        }
        Ok(())
    }
}

/// Renders a response for a terminal. Pure, so the output format is testable.
pub fn render(response: &Response) -> String {
    match response {
        Response::Ok => "ok".to_string(),
        Response::Attached {
            page,
            generation,
            superseded,
        } => {
            let note = if *superseded {
                " (superseded an earlier registration)"
            } else {
                ""
            };
            format!("attached {page} generation {generation}{note}")
        }
        Response::Hosted {
            page,
            generation,
            protocol,
        } => format!("hosted {page} generation {generation} protocol {protocol}"),
        Response::HostRefused { reason, detail } => {
            format!("not hosted ({reason:?}): {detail}")
        }
        Response::Frame {
            pane,
            generation,
            payload,
        } => format!("frame {pane} gen {generation} {} bytes", payload.len() / 2),
        Response::Event {
            pane,
            generation,
            event,
        } => format!("event {pane} gen {generation} {event:?}"),
        Response::Panes { panes } if panes.is_empty() => "no panes attached".to_string(),
        Response::Panes { panes } => panes
            .iter()
            .map(|entry| {
                format!(
                    "{}\t{}\tgen {}\tpid {}\t{}",
                    entry.pane, entry.page, entry.generation, entry.pid, entry.tmux_server
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Response::Status {
            pid,
            socket,
            uptime_ms,
            pane_count,
            generation_counter,
            protocol,
            engine,
            hosted_pane_count,
        } => format!(
            "pid {pid}\nsocket {socket}\nuptime_ms {uptime_ms}\npanes {pane_count}\ngenerations {generation_counter}\nprotocol {protocol}\nengine {engine}\nhosted {hosted_pane_count}"
        ),
        Response::Error { message } => format!("error: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Generation, PaneReport};

    #[test]
    fn an_empty_pane_list_says_so_rather_than_printing_nothing() {
        assert_eq!(
            render(&Response::Panes { panes: Vec::new() }),
            "no panes attached"
        );
    }

    #[test]
    fn each_attached_pane_is_one_line() {
        let rendered = render(&Response::Panes {
            panes: vec![
                PaneReport {
                    pane: "%3".into(),
                    tmux_server: "srv".into(),
                    generation: Generation(1),
                    page: "bpage_a".into(),
                    pid: 10,
                    attached_at_ms: 0,
                },
                PaneReport {
                    pane: "%4".into(),
                    tmux_server: "srv".into(),
                    generation: Generation(2),
                    page: "bpage_b".into(),
                    pid: 11,
                    attached_at_ms: 0,
                },
            ],
        });
        assert_eq!(rendered.lines().count(), 2);
        assert!(rendered.starts_with("%3\tbpage_a\tgen 1\tpid 10\tsrv"));
    }

    #[test]
    fn a_superseding_attach_says_so() {
        let rendered = render(&Response::Attached {
            page: "bpage_a".into(),
            generation: Generation(2),
            superseded: true,
        });
        assert!(rendered.contains("superseded"));
        let clean = render(&Response::Attached {
            page: "bpage_a".into(),
            generation: Generation(1),
            superseded: false,
        });
        assert!(!clean.contains("superseded"));
    }

    #[test]
    fn errors_are_prefixed_so_they_are_not_read_as_data() {
        assert_eq!(
            render(&Response::Error {
                message: "nope".into()
            }),
            "error: nope"
        );
    }
}
