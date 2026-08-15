//! Whether a pane's page comes from the daemon or from an engine this process spawns.
//!
//! The rule that governs everything here: **the fallback is the current path, working exactly as
//! today.** A pane that cannot be hosted is not a degraded pane; it is a pane that spawns its own
//! Electron, which is what every pane does today. So every uncertainty resolves towards
//! [`Route::Spawn`] — no daemon, an unreachable daemon, a daemon from another build, a daemon
//! whose engine cannot host, a daemon that answered something unexpected. There is deliberately no
//! condition under which this function guesses that hosting will work.

use twebd::protocol::{RefusalReason, Response};

/// The environment variable that opts a pane into the daemon.
///
/// Off by default, and it stays that way until the hosted path is the better one for a real case.
/// A flag that defaults on is the same thing as no flag when the fallback is what actually ships.
pub const DAEMON_FLAG: &str = "TWEB_DAEMON";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Ask the daemon to host this pane's page.
    Daemon,
    /// Spawn an engine for this pane — today's path, unchanged.
    Spawn,
}

/// Why a pane is not being hosted. Reported, not just decided: an operator who turned the flag on
/// and got today's behaviour needs to be told which of these happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnReason {
    FlagOff,
    NoSocket,
    ConnectFailed(String),
    Refused(RefusalReason, String),
    /// The daemon answered something this build does not understand — which is what an older
    /// daemon does with a `host` request it has never heard of.
    UnexpectedAnswer(String),
    /// Hosting was working and stopped. The pane keeps running, on its own engine.
    HostedSessionLost(String),
}

impl std::fmt::Display for SpawnReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FlagOff => write!(f, "{DAEMON_FLAG} is not set"),
            Self::NoSocket => write!(f, "no twebd socket"),
            Self::ConnectFailed(err) => write!(f, "cannot reach twebd: {err}"),
            Self::Refused(reason, detail) => write!(f, "twebd declined ({reason:?}): {detail}"),
            Self::UnexpectedAnswer(answer) => write!(f, "twebd answered {answer}"),
            Self::HostedSessionLost(reason) => write!(f, "the hosted page was lost: {reason}"),
        }
    }
}

/// Whether the flag opts this pane in.
///
/// Anything other than an explicit off is on, because the operator typed the variable for a
/// reason; but the *unset* case has to be off, which is the case that matters for shipping.
pub fn flag_enabled(value: Option<&str>) -> bool {
    !matches!(value, None | Some("") | Some("0") | Some("false"))
}

/// The route to take before anything has been sent.
pub fn initial_route(flag: Option<&str>, socket_exists: bool) -> Result<Route, SpawnReason> {
    if !flag_enabled(flag) {
        return Err(SpawnReason::FlagOff);
    }
    if !socket_exists {
        return Err(SpawnReason::NoSocket);
    }
    Ok(Route::Daemon)
}

/// The route implied by the daemon's answer to a `host` request.
///
/// Every answer that is not `hosted` means spawn. That includes `error`, which is precisely what a
/// daemon built before hosting existed replies with — so an older daemon is a fallback trigger by
/// construction, not by version sniffing.
pub fn route_from_answer(response: &Response) -> Result<Route, SpawnReason> {
    match response {
        Response::Hosted { .. } => Ok(Route::Daemon),
        Response::HostRefused { reason, detail } => {
            Err(SpawnReason::Refused(*reason, detail.clone()))
        }
        Response::Error { message } => Err(SpawnReason::UnexpectedAnswer(format!(
            "an error: {message}"
        ))),
        other => Err(SpawnReason::UnexpectedAnswer(format!("{other:?}"))),
    }
}

/// Whether a frame or event that arrived for this pane still applies.
///
/// tmux reuses pane ids, so a message stamped with an older generation belongs to a frontend that
/// has already been replaced. Writing its frame to this tty would put the previous occupant's page
/// on screen.
pub fn message_is_current(ours: u64, incoming: u64) -> bool {
    ours == incoming
}

#[cfg(test)]
mod tests {
    use super::*;
    use twebd::protocol::Generation;

    #[test]
    fn the_flag_is_off_unless_it_is_explicitly_on() {
        assert!(!flag_enabled(None));
        assert!(!flag_enabled(Some("")));
        assert!(!flag_enabled(Some("0")));
        assert!(!flag_enabled(Some("false")));
        assert!(flag_enabled(Some("1")));
        assert!(flag_enabled(Some("yes")));
    }

    // The shipping default. Nothing about the daemon is consulted, so a broken or hostile daemon
    // cannot affect a pane that did not ask for it.
    #[test]
    fn without_the_flag_a_pane_spawns_its_own_engine_even_with_a_daemon_running() {
        assert_eq!(initial_route(None, true), Err(SpawnReason::FlagOff));
    }

    #[test]
    fn the_flag_without_a_daemon_falls_back_rather_than_failing() {
        assert_eq!(initial_route(Some("1"), false), Err(SpawnReason::NoSocket));
        assert_eq!(initial_route(Some("1"), true), Ok(Route::Daemon));
    }

    #[test]
    fn only_a_hosted_answer_routes_to_the_daemon() {
        assert_eq!(
            route_from_answer(&Response::Hosted {
                page: "bpage_a".into(),
                generation: Generation(1),
                protocol: 1,
            }),
            Ok(Route::Daemon)
        );
    }

    #[test]
    fn every_refusal_reason_falls_back_to_spawning() {
        for reason in [
            RefusalReason::ProtocolMismatch,
            RefusalReason::EngineUnavailable,
        ] {
            let route = route_from_answer(&Response::HostRefused {
                reason,
                detail: "because".into(),
            });
            assert_eq!(route, Err(SpawnReason::Refused(reason, "because".into())));
        }
    }

    // A daemon built before hosting existed answers `host` with an error and keeps the connection
    // open. That is the whole compatibility story: no version sniffing, no probing — the error
    // *is* the signal.
    #[test]
    fn an_older_daemon_answering_error_is_a_fallback_not_a_failure() {
        let route = route_from_answer(&Response::Error {
            message: "malformed request: unknown variant `host`".into(),
        });
        assert!(matches!(route, Err(SpawnReason::UnexpectedAnswer(_))));
    }

    // Anything the daemon says that is not an answer to this question means spawn. A frontend that
    // treated an unrecognised response as success would sit waiting for frames forever.
    #[test]
    fn an_answer_to_some_other_question_also_falls_back() {
        for response in [
            Response::Ok,
            Response::Attached {
                page: "bpage_a".into(),
                generation: Generation(1),
                superseded: false,
            },
            Response::Panes { panes: Vec::new() },
        ] {
            assert!(matches!(
                route_from_answer(&response),
                Err(SpawnReason::UnexpectedAnswer(_))
            ));
        }
    }

    #[test]
    fn a_message_from_a_superseded_generation_is_not_current() {
        assert!(message_is_current(7, 7));
        assert!(!message_is_current(7, 6));
        assert!(!message_is_current(7, 8));
    }

    // Every reason is reported to the operator, so "I set the flag and nothing changed" has an
    // answer in the log rather than requiring a debugger.
    #[test]
    fn every_reason_says_something_specific() {
        for reason in [
            SpawnReason::FlagOff,
            SpawnReason::NoSocket,
            SpawnReason::ConnectFailed("refused".into()),
            SpawnReason::Refused(RefusalReason::EngineUnavailable, "no engine".into()),
            SpawnReason::UnexpectedAnswer("Ok".into()),
            SpawnReason::HostedSessionLost("engine exited".into()),
        ] {
            let text = reason.to_string();
            assert!(!text.is_empty());
            assert!(text.len() > 5, "{text:?} is not a diagnosis");
        }
    }
}
