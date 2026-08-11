//! InputSink — the input injection abstraction.
//!
//! Implemented separately for Electron/CDP/Shell.
//! Covers Korean IME composition. DETAIL.md section 9.2.

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

/// A key event. Based on the Kitty keyboard protocol.
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

/// A mouse event. In SGR pixel coordinates.
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

/// An IME composition event (Korean).
/// On the native IME path (Electron) the browser receives it directly; the manual injection path
/// delivers it through this event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompositionEvent {
    /// An in-progress composition state (marked text).
    MarkedText {
        text: String,
        selected_range: Option<(usize, usize)>,
    },
    /// The committed composition text.
    InsertText { text: String },
    /// The composition was cancelled.
    UnmarkText,
}

/// InputSink trait.
/// Implementations: ElectronInputSink, CdpInputSink, ShellInputSink.
#[async_trait]
pub trait InputSink: Send + Sync {
    /// Injects a key event.
    async fn send_key(&self, event: KeyEvent) -> InputResult<()>;

    /// Injects a mouse event.
    async fn send_mouse(&self, event: MouseEvent) -> InputResult<()>;

    /// Injects an IME composition (Korean).
    async fn send_composition(&self, event: CompositionEvent) -> InputResult<()>;

    /// Injects committed text.
    async fn insert_text(&self, text: &str) -> InputResult<()>;
}
