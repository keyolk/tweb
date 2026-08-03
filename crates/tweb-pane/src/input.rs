//! Input — keyboard/mouse decode, Browser mode 관리.
//!
//! DESIGN.md 섹션 9. tmux mode와 Browser mode 입력 소유권 분리.
//! Kitty keyboard protocol key-down/repeat/up, SGR pixel mouse.

use tweb_core::input::{KeyEvent, KeyKind, KeyModifiers, MouseEvent};

/// 입력 mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMode {
    /// 모든 key → tmux key table.
    Tmux,
    /// reserved toggle → tmux 복귀, 나머지 key → browser pane.
    Browser,
}

/// mode 전환 toggle key (DESIGN.md 섹션 9.2 기본 `C-g`).
pub const TOGGLE_KEY: &str = "C-g";

/// raw terminal 입력을 KeyEvent로 decode.
/// TODO: Kitty keyboard protocol parse.
pub fn decode_key(data: &[u8]) -> Option<KeyEvent> {
    // placeholder: 단일 byte를 문자로.
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

/// raw terminal 입력을 MouseEvent로 decode.
/// TODO: SGR pixel mouse parse.
pub fn decode_mouse(_data: &[u8]) -> Option<MouseEvent> {
    None
}
