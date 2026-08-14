//! Whether this terminal will render what the engine draws.
//!
//! DESIGN.md 5.2 gives `tweb __pane` "detect the terminal's Kitty graphics ... capabilities"
//! and "show a text fallback when the terminal does not support graphics". The engine writes
//! Kitty graphics straight to the inherited stdout, so a terminal that cannot render them
//! shows no page, no error and no clue — the pane just sits there.
//!
//! The hard part is not the query, it is what to do when the query cannot answer. Measured
//! on this machine (tmux 3.5a, Ghostty 1.3.1, Apple Terminal), with a 1s wait — 20x what the
//! shipping probe allowed:
//!
//! ```text
//! context                         DA1        Kitty a=q reply     verdict
//! bare tty, Ghostty               0.1ms      Gi=31;OK  0.2ms     supported
//! bare tty, Apple Terminal        0.3ms      none                unsupported
//! inside tmux, Ghostty client     0.0ms      none                UNKNOWABLE
//! ```
//!
//! tmux answers the device-attributes query itself and never forwards the outer terminal's
//! graphics reply back — with or without DCS passthrough. So inside tmux a capable Ghostty
//! is byte-for-byte indistinguishable from a terminal that cannot draw at all, and tmux is
//! the primary supported configuration (DESIGN.md 7.4). A gate that treated silence as "no
//! graphics" would refuse to start on essentially every real installation.
//!
//! Hence the tri-state. Only a *definite* negative — the terminal proved it was listening by
//! answering DA1, and still said nothing about graphics — stops the engine. Every ambiguity
//! (inside tmux, not a tty, a terminal too slow to answer at all) proceeds exactly as before
//! this gate existed. Failing closed on a terminal that would have worked is worse than the
//! silent pane this replaces, so ambiguity always resolves toward starting.

/// What the terminal said about the Kitty graphics protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphicsSupport {
    /// The terminal answered the graphics query. It speaks the protocol.
    Supported,
    /// The terminal answered the device-attributes query but not the graphics one. It was
    /// listening and had nothing to say, which is the only sound evidence of absence.
    Unsupported,
    /// No usable answer: inside tmux, not a tty, or nothing came back in time.
    Unknown,
}

/// Whether the engine may be started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Spawn the engine.
    Start,
    /// Do not spawn; show the fallback message instead.
    Refuse,
}

/// The startup decision.
///
/// `override_requested` is the `TWEB_ASSUME_GRAPHICS` escape hatch. Detection that is wrong
/// in the refusing direction takes the browser away entirely, so there has to be a way past
/// it that does not involve editing the source — the same reasoning as `TWEB_NO_ALT_SCREEN`.
pub fn gate(support: GraphicsSupport, override_requested: bool) -> Gate {
    match support {
        GraphicsSupport::Unsupported if !override_requested => Gate::Refuse,
        _ => Gate::Start,
    }
}

/// What the user sees instead of a browser.
///
/// Written to stderr before the alternate screen is entered, so it survives on the terminal
/// the user is actually looking at. This can only be reached outside tmux — the one context
/// where the pane *is* the user's own terminal and the text stays put after the process
/// exits.
pub fn unsupported_message() -> String {
    // Naming the query matters: the next person to hit this needs to know the verdict came
    // from asking the terminal, not from a list of terminal names it failed to appear on.
    "tweb: this terminal does not support the Kitty graphics protocol.\n\
     \n\
     The browser engine draws pages as Kitty graphics on stdout. Without that\n\
     protocol the pane would show nothing at all, so tweb stopped rather than\n\
     start an engine whose output nothing can render.\n\
     \n\
     What was detected: the terminal answered the device-attributes query\n\
     (ESC [ c) but not the Kitty graphics query (ESC _G a=q). It was listening,\n\
     and it does not speak the protocol.\n\
     \n\
     How to fix it: run tweb under Ghostty, Kitty, or WezTerm.\n\
     Run `tweb doctor` for the full terminal and tmux diagnosis.\n\
     \n\
     To start anyway, set TWEB_ASSUME_GRAPHICS=1.\n"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{gate, unsupported_message, Gate, GraphicsSupport};

    /// The whole point of the tri-state: only a proven negative may stop the engine.
    /// Unknown is the state every tmux pane reports, and tmux is the primary supported
    /// configuration — refusing there would break every real installation.
    #[test]
    fn only_a_proven_negative_stops_the_engine() {
        assert_eq!(gate(GraphicsSupport::Supported, false), Gate::Start);
        assert_eq!(gate(GraphicsSupport::Unknown, false), Gate::Start);
        assert_eq!(gate(GraphicsSupport::Unsupported, false), Gate::Refuse);
    }

    /// Detection that is wrong in the refusing direction costs the user the browser
    /// entirely, so the override has to work without a rebuild.
    #[test]
    fn the_override_starts_even_a_terminal_that_answered_no() {
        assert_eq!(gate(GraphicsSupport::Unsupported, true), Gate::Start);
        assert_eq!(gate(GraphicsSupport::Unknown, true), Gate::Start);
    }

    /// A message that does not name the missing thing, a fix and the way past it leaves the
    /// user exactly as stuck as the blank pane it replaced.
    #[test]
    fn the_message_names_the_gap_the_fix_and_the_escape_hatch() {
        let message = unsupported_message();
        assert!(message.contains("Kitty graphics"));
        assert!(message.contains("Ghostty"));
        assert!(message.contains("tweb doctor"));
        assert!(message.contains("TWEB_ASSUME_GRAPHICS=1"));
    }
}
