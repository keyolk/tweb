//! InputSink — 입력 주입 추상.
//!
//! Electron/CDP/Shell이 각각 구현.
//! 한글 IME composition을 포함. DETAIL.md 섹션 9.2.

use async_trait::async_trait;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum InputError {
    #[error("page not found")]
    PageNotFound,
    #[error("input injection failed: {0}")]
    InjectionFailed(String),
    #[error("input: {0}")]
    Other(String),
}

pub type InputResult<T> = Result<T, InputError>;

/// key event. Kitty keyboard protocol 기반.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEvent {
    pub key: String,
    pub modifiers: KeyModifiers,
    pub kind: KeyKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KeyModifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub super_key: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    Down,
    Repeat,
    Up,
}

/// mouse event. SGR pixel 좌표.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MouseEvent {
    pub x: i32,
    pub y: i32,
    pub button: MouseButton,
    pub kind: MouseKind,
    pub modifiers: KeyModifiers,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    Wheel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseKind {
    Down,
    Up,
    Move,
    Drag,
    Scroll,
}

/// IME composition event (한글).
/// native IME 경로(Electron)는 browser가 직접 받고, 수동 주입 경로는 이 event로 전달.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompositionEvent {
    /// 조합 중간 상태 (marked text).
    MarkedText {
        text: String,
        selected_range: Option<(usize, usize)>,
    },
    /// 조합 완료 text.
    InsertText { text: String },
    /// 조합 취소.
    UnmarkText,
}

/// InputSink trait.
/// 구현체: ElectronInputSink, CdpInputSink, ShellInputSink.
#[async_trait]
pub trait InputSink: Send + Sync {
    /// key event 주입.
    async fn send_key(&self, event: KeyEvent) -> InputResult<()>;

    /// mouse event 주입.
    async fn send_mouse(&self, event: MouseEvent) -> InputResult<()>;

    /// IME composition 주입 (한글).
    async fn send_composition(&self, event: CompositionEvent) -> InputResult<()>;

    /// committed text 주입.
    async fn insert_text(&self, text: &str) -> InputResult<()>;
}
