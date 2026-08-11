//! Input — keyboard/mouse decoding and Browser mode management.
//!
//! DESIGN.md section 9. Splits input ownership between tmux mode and Browser mode.
//! Kitty keyboard protocol key-down/repeat/up, SGR pixel mouse.

use tweb_core::input::{KeyEvent, KeyKind, KeyModifiers, MouseEvent};

/// The input mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMode {
    /// Every key → the tmux key table.
    Tmux,
    /// The reserved toggle returns to tmux; every other key goes to the browser pane.
    Browser,
}

/// The mode toggle key (DESIGN.md section 9.2, `C-g` by default).
pub const TOGGLE_KEY: &str = "C-g";

/// Decodes raw terminal input into a KeyEvent.
/// TODO: parse the Kitty keyboard protocol.
pub fn decode_key(data: &[u8]) -> Option<KeyEvent> {
    // placeholder: a single byte as a character.
    if data.len() == 1 {
        let ch = data[0] as char;
        if ch.is_ascii() {
            return Some(KeyEvent {
                key: ch.to_string(),
                modifiers: KeyModifiers::default(),
                kind: KeyKind::Down,
            });
        }
    }
    None
}

/// Decodes raw terminal input into a MouseEvent.
/// TODO: SGR pixel mouse parse.
pub fn decode_mouse(_data: &[u8]) -> Option<MouseEvent> {
    None
}
