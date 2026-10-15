// Native input for a WKWebView: real NSEvents handed to the view, never script-built DOM events.
//
// A DOM event made by script is untrusted, so the browser does nothing for it — a synthetic
// WheelEvent scrolls nothing, a synthetic keydown inserts no text — and pages that check
// `isTrusted` see a forgery. An NSEvent goes through WebKit's own event handling: it is routed
// into the right frame (cross-origin iframes included), it scrolls, and AppKit's key bindings
// turn Ctrl-A or Option-Left into the editing command they name.
//
// Coordinates arrive in view points, top-left origin — the same space as Electron's
// `sendInputEvent`, since the view is as large as the pane's window in DIPs and page zoom is
// WebKit's own (`pageZoom`), which maps view points to CSS pixels itself.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSScreen};
use objc2_core_graphics::{CGEvent, CGEventField, CGScrollEventUnit};
use objc2_foundation::{NSPoint, NSString};
use objc2_web_kit::WKWebView;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

// The modifier bits Electron's input path already uses (CDP's): Alt 1, Ctrl 2, Meta 4, Shift 8.
const ALT: u32 = 1;
const CTRL: u32 = 2;
const META: u32 = 4;
const SHIFT: u32 = 8;

fn flags(modifiers: u32) -> NSEventModifierFlags {
    let mut flags = NSEventModifierFlags::empty();
    if modifiers & SHIFT != 0 {
        flags.insert(NSEventModifierFlags::Shift);
    }
    if modifiers & ALT != 0 {
        flags.insert(NSEventModifierFlags::Option);
    }
    if modifiers & CTRL != 0 {
        flags.insert(NSEventModifierFlags::Control);
    }
    if modifiers & META != 0 {
        flags.insert(NSEventModifierFlags::Command);
    }
    flags
}

fn timestamp() -> f64 {
    static CLOCK: OnceLock<Instant> = OnceLock::new();
    CLOCK.get_or_init(Instant::now).elapsed().as_secs_f64()
}

pub struct Mouse<'a> {
    pub kind: &'a str,
    pub x: f64,
    pub y: f64,
    pub button: u32,
    pub clicks: i64,
    pub modifiers: u32,
    pub dx: f64,
    pub dy: f64,
    /// The button held, if any, so a move becomes a drag.
    pub held: Option<u32>,
    pub gesture: Gesture,
}

/// Where a wheel event sits in a trackpad gesture, as AppKit's `NSEventPhase` masks.
///
/// Given by the native input helper (crates/tweb-native-input), which read them off the real
/// gesture; a terminal wheel notch has none. WebKit reads a gesture's phases to latch it to one
/// scroller, to rubber-band at an edge and to tell inertia from the fingers — none of which a
/// phaseless event gets.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Gesture {
    pub phase: u64,
    pub momentum: u64,
    pub precise: bool,
}

// `NSEventPhase` bits, as the helper passes them on.
const NS_BEGAN: u64 = 1;
const NS_STATIONARY: u64 = 2;
const NS_CHANGED: u64 = 4;
const NS_ENDED: u64 = 8;
const NS_CANCELLED: u64 = 16;
const NS_MAY_BEGIN: u64 = 32;

/// `NSEventPhase` as the `kCGScrollWheelEventScrollPhase` field spells it (`CGScrollPhase`):
/// the same states with different bits, so a CGEvent built from them reads back as the phase
/// AppKit gave.
pub fn cg_scroll_phase(phase: u64) -> i64 {
    if phase & NS_MAY_BEGIN != 0 {
        128
    } else if phase & NS_BEGAN != 0 {
        1
    } else if phase & (NS_CHANGED | NS_STATIONARY) != 0 {
        2
    } else if phase & NS_ENDED != 0 {
        4
    } else if phase & NS_CANCELLED != 0 {
        8
    } else {
        0
    }
}

/// The inertial phase, as `kCGScrollWheelEventMomentumPhase` spells it (`CGMomentumScrollPhase`):
/// a sequence number rather than a mask — begin 1, continue 2, end 3.
pub fn cg_momentum_phase(momentum: u64) -> i64 {
    if momentum & NS_BEGAN != 0 {
        1
    } else if momentum & (NS_CHANGED | NS_STATIONARY) != 0 {
        2
    } else if momentum & (NS_ENDED | NS_CANCELLED) != 0 {
        3
    } else {
        0
    }
}

pub fn mouse(webview: &WKWebView, input: Mouse) {
    if input.kind == "wheel" {
        wheel(webview, &input);
        return;
    }
    let Some(window) = webview.window() else {
        return;
    };
    // WKWebView is flipped, so a top-down point converts as it is.
    let location = webview.convertPoint_toView(NSPoint::new(input.x, input.y), None);
    let (event_type, clicks, pressure) = match input.kind {
        "down" => (
            match input.button {
                1 => NSEventType::OtherMouseDown,
                2 => NSEventType::RightMouseDown,
                _ => NSEventType::LeftMouseDown,
            },
            input.clicks.max(1),
            1.0,
        ),
        "up" => (
            match input.button {
                1 => NSEventType::OtherMouseUp,
                2 => NSEventType::RightMouseUp,
                _ => NSEventType::LeftMouseUp,
            },
            input.clicks.max(1),
            0.0,
        ),
        _ => match input.held {
            Some(1) => (NSEventType::OtherMouseDragged, 0, 1.0),
            Some(2) => (NSEventType::RightMouseDragged, 0, 1.0),
            Some(_) => (NSEventType::LeftMouseDragged, 0, 1.0),
            None => (NSEventType::MouseMoved, 0, 0.0),
        },
    };
    static EVENT_NUMBER: AtomicIsize = AtomicIsize::new(1);
    let Some(event) = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        event_type,
        location,
        flags(input.modifiers),
        timestamp(),
        window.windowNumber(),
        None,
        EVENT_NUMBER.fetch_add(1, Ordering::Relaxed),
        clicks as isize,
        pressure,
    ) else {
        return;
    };
    match event_type {
        NSEventType::LeftMouseDown => webview.mouseDown(&event),
        NSEventType::LeftMouseUp => webview.mouseUp(&event),
        NSEventType::RightMouseDown => webview.rightMouseDown(&event),
        NSEventType::RightMouseUp => webview.rightMouseUp(&event),
        NSEventType::OtherMouseDown => webview.otherMouseDown(&event),
        NSEventType::OtherMouseUp => webview.otherMouseUp(&event),
        NSEventType::LeftMouseDragged => webview.mouseDragged(&event),
        NSEventType::RightMouseDragged => webview.rightMouseDragged(&event),
        NSEventType::OtherMouseDragged => webview.otherMouseDragged(&event),
        _ => webview.mouseMoved(&event),
    }
}

/// NSEvent has no scroll-wheel constructor, so it is built as a CGEvent. An event made that way
/// carries no window, and WebKit then reads `locationInWindow` straight from the event's
/// location — so the location is the WINDOW point, flipped into CoreGraphics' top-down space.
/// Measured: a screen point landed the pointer on the wrong element; the window point scrolled
/// the page and a nested scroller each by exactly their own distance, as a trusted event.
fn wheel(webview: &WKWebView, input: &Mouse) {
    let Some(marker) = MainThreadMarker::new() else {
        return;
    };
    let Some(primary) = NSScreen::screens(marker).firstObject() else {
        return;
    };
    let in_window = webview.convertPoint_toView(NSPoint::new(input.x, input.y), None);
    // Electron's sign: a positive delta moves the CONTENT down/right. CGEvent's wheel1 is the
    // same way round (positive scrolls up).
    let Some(event) = CGEvent::new_scroll_wheel_event2(
        None,
        CGScrollEventUnit::Pixel,
        2,
        input.dy.round() as i32,
        input.dx.round() as i32,
        0,
    ) else {
        return;
    };
    CGEvent::set_location(
        Some(&event),
        NSPoint::new(in_window.x, primary.frame().size.height - in_window.y),
    );
    if input.gesture.precise {
        // A trackpad's own deltas are fractional points; the integer wheel values above would
        // round every small movement of a slow swipe to nothing. The fixed-point delta is what
        // AppKit reads `scrollingDeltaY` from for a continuous event.
        let event = Some(&*event);
        CGEvent::set_integer_value_field(event, CGEventField::ScrollWheelEventIsContinuous, 1);
        CGEvent::set_double_value_field(
            event,
            CGEventField::ScrollWheelEventFixedPtDeltaAxis1,
            input.dy,
        );
        CGEvent::set_double_value_field(
            event,
            CGEventField::ScrollWheelEventFixedPtDeltaAxis2,
            input.dx,
        );
        CGEvent::set_integer_value_field(
            event,
            CGEventField::ScrollWheelEventScrollPhase,
            cg_scroll_phase(input.gesture.phase),
        );
        CGEvent::set_integer_value_field(
            event,
            CGEventField::ScrollWheelEventMomentumPhase,
            cg_momentum_phase(input.gesture.momentum),
        );
    }
    if let Some(event) = NSEvent::eventWithCGEvent(&event) {
        // What WebKit will read back, not what was asked for: the phases only count if the CGEvent
        // fields above survive into the NSEvent.
        if crate::protocol::profiling() {
            crate::protocol::profile(format!(
                "wheel dy={:.2} precise={} phase={} momentum={}",
                event.scrollingDeltaY(),
                event.hasPreciseScrollingDeltas(),
                event.phase().0,
                event.momentumPhase().0,
            ));
        }
        webview.scrollWheel(&event);
    }
}

pub struct Key<'a> {
    pub kind: &'a str,
    pub key: &'a str,
    pub code: &'a str,
    pub text: &'a str,
    pub modifiers: u32,
}

pub fn key(webview: &WKWebView, input: Key) {
    let Some(window) = webview.window() else {
        return;
    };
    let (characters, ignoring) = key_characters(&input);
    let event_type = if input.kind == "up" {
        NSEventType::KeyUp
    } else {
        NSEventType::KeyDown
    };
    let characters = NSString::from_str(&characters);
    let ignoring = NSString::from_str(&ignoring);
    let Some(event) = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        event_type,
        NSPoint::new(0.0, 0.0),
        flags(input.modifiers),
        timestamp(),
        window.windowNumber(),
        None,
        &characters,
        &ignoring,
        false,
        virtual_key(input.code, input.key),
    ) else {
        return;
    };
    if event_type == NSEventType::KeyUp {
        webview.keyUp(&event);
        return;
    }
    // A Command combination is a key equivalent, not a key: the page sees it as a keydown
    // through `performKeyEquivalent:`, and if the page leaves it alone it is the menu's to act
    // on. This host has no menu, so the editing ones a browser's Edit menu carries are run here.
    if input.modifiers & META != 0 {
        if webview.performKeyEquivalent(&event) {
            return;
        }
        if let Some(selector) = edit_selector(input.key, input.modifiers) {
            let none: Option<&objc2::runtime::AnyObject> = None;
            let _: objc2::runtime::Bool =
                unsafe { objc2::msg_send![webview, tryToPerform: selector, with: none] };
        }
        return;
    }
    webview.keyDown(&event);
}

fn edit_selector(key: &str, modifiers: u32) -> Option<objc2::runtime::Sel> {
    use objc2::sel;
    let shift = modifiers & SHIFT != 0;
    Some(match key.to_ascii_lowercase().as_str() {
        "a" => sel!(selectAll:),
        "c" => sel!(copy:),
        "x" => sel!(cut:),
        "v" if shift && modifiers & ALT != 0 => sel!(pasteAsPlainText:),
        "v" => sel!(paste:),
        "z" if shift => sel!(redo:),
        "z" => sel!(undo:),
        _ => return None,
    })
}

/// What AppKit would put in `characters` and `charactersIgnoringModifiers`.
fn key_characters(input: &Key) -> (String, String) {
    if let Some(special) = function_key(input.key) {
        let text = special.to_string();
        return (text.clone(), text);
    }
    let base = if !input.text.is_empty() {
        input.text.to_string()
    } else if input.key.chars().count() == 1 {
        input.key.to_string()
    } else {
        String::new()
    };
    // Ctrl-letter is a control character in `characters`, as a real keyboard sends it; the key
    // bindings (Ctrl-A, Ctrl-E, ...) are matched on that.
    if input.modifiers & CTRL != 0 && input.modifiers & (ALT | META) == 0 {
        if let Some(letter) = base.chars().next().filter(char::is_ascii_alphabetic) {
            let control = char::from(letter.to_ascii_lowercase() as u8 - b'a' + 1);
            return (control.to_string(), letter.to_ascii_lowercase().to_string());
        }
    }
    (base.clone(), base.to_lowercase())
}

fn function_key(key: &str) -> Option<char> {
    use objc2_app_kit::{
        NSDeleteFunctionKey, NSDownArrowFunctionKey, NSEndFunctionKey, NSF10FunctionKey,
        NSF11FunctionKey, NSF12FunctionKey, NSF1FunctionKey, NSF2FunctionKey, NSF3FunctionKey,
        NSF4FunctionKey, NSF5FunctionKey, NSF6FunctionKey, NSF7FunctionKey, NSF8FunctionKey,
        NSF9FunctionKey, NSHomeFunctionKey, NSInsertFunctionKey, NSLeftArrowFunctionKey,
        NSPageDownFunctionKey, NSPageUpFunctionKey, NSRightArrowFunctionKey, NSUpArrowFunctionKey,
    };
    let code = match key {
        "Escape" => return Some('\u{1b}'),
        "Enter" => return Some('\r'),
        "Tab" => return Some('\t'),
        "Backspace" => return Some('\u{7f}'),
        "Delete" => NSDeleteFunctionKey,
        "Insert" => NSInsertFunctionKey,
        "ArrowLeft" => NSLeftArrowFunctionKey,
        "ArrowRight" => NSRightArrowFunctionKey,
        "ArrowDown" => NSDownArrowFunctionKey,
        "ArrowUp" => NSUpArrowFunctionKey,
        "Home" => NSHomeFunctionKey,
        "End" => NSEndFunctionKey,
        "PageUp" => NSPageUpFunctionKey,
        "PageDown" => NSPageDownFunctionKey,
        "F1" => NSF1FunctionKey,
        "F2" => NSF2FunctionKey,
        "F3" => NSF3FunctionKey,
        "F4" => NSF4FunctionKey,
        "F5" => NSF5FunctionKey,
        "F6" => NSF6FunctionKey,
        "F7" => NSF7FunctionKey,
        "F8" => NSF8FunctionKey,
        "F9" => NSF9FunctionKey,
        "F10" => NSF10FunctionKey,
        "F11" => NSF11FunctionKey,
        "F12" => NSF12FunctionKey,
        _ => return None,
    };
    char::from_u32(code)
}

/// The macOS virtual key code for a DOM `code` (falling back to `key`). Pages read it as
/// `event.keyCode`/`event.code`, and the key bindings match on it, so a wrong one is a
/// different key, not a cosmetic difference.
pub fn virtual_key(code: &str, key: &str) -> u16 {
    let by_code = match code {
        "KeyA" => 0,
        "KeyS" => 1,
        "KeyD" => 2,
        "KeyF" => 3,
        "KeyH" => 4,
        "KeyG" => 5,
        "KeyZ" => 6,
        "KeyX" => 7,
        "KeyC" => 8,
        "KeyV" => 9,
        "KeyB" => 11,
        "KeyQ" => 12,
        "KeyW" => 13,
        "KeyE" => 14,
        "KeyR" => 15,
        "KeyY" => 16,
        "KeyT" => 17,
        "Digit1" => 18,
        "Digit2" => 19,
        "Digit3" => 20,
        "Digit4" => 21,
        "Digit6" => 22,
        "Digit5" => 23,
        "Equal" => 24,
        "Digit9" => 25,
        "Digit7" => 26,
        "Minus" => 27,
        "Digit8" => 28,
        "Digit0" => 29,
        "BracketRight" => 30,
        "KeyO" => 31,
        "KeyU" => 32,
        "BracketLeft" => 33,
        "KeyI" => 34,
        "KeyP" => 35,
        "Enter" => 36,
        "KeyL" => 37,
        "KeyJ" => 38,
        "Quote" => 39,
        "KeyK" => 40,
        "Semicolon" => 41,
        "Backslash" => 42,
        "Comma" => 43,
        "Slash" => 44,
        "KeyN" => 45,
        "KeyM" => 46,
        "Period" => 47,
        "Tab" => 48,
        "Space" => 49,
        "Backquote" => 50,
        "Backspace" => 51,
        "Escape" => 53,
        "F5" => 96,
        "F6" => 97,
        "F7" => 98,
        "F3" => 99,
        "F8" => 100,
        "F9" => 101,
        "F11" => 103,
        "F10" => 109,
        "F12" => 111,
        "Insert" => 114,
        "Home" => 115,
        "PageUp" => 116,
        "Delete" => 117,
        "F4" => 118,
        "End" => 119,
        "F2" => 120,
        "PageDown" => 121,
        "F1" => 122,
        "ArrowLeft" => 123,
        "ArrowRight" => 124,
        "ArrowDown" => 125,
        "ArrowUp" => 126,
        _ => u16::MAX,
    };
    if by_code != u16::MAX {
        return by_code;
    }
    let letter = key.chars().next().filter(|_| key.chars().count() == 1);
    match letter.map(|c| c.to_ascii_lowercase()) {
        Some(c @ 'a'..='z') => virtual_key(&format!("Key{}", c.to_ascii_uppercase()), ""),
        Some(c @ '0'..='9') => virtual_key(&format!("Digit{c}"), ""),
        Some(' ') => 49,
        _ => match key {
            "Enter" | "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Tab"
            | "Backspace" | "Escape" | "Home" | "End" | "PageUp" | "PageDown" | "Delete" => {
                virtual_key(key, "")
            }
            _ => 0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_input<'a>(key: &'a str, text: &'a str, modifiers: u32) -> Key<'a> {
        Key {
            kind: "down",
            key,
            code: "",
            text,
            modifiers,
        }
    }

    #[test]
    fn maps_codes_and_falls_back_to_keys() {
        assert_eq!(virtual_key("KeyA", "a"), 0);
        assert_eq!(virtual_key("", "j"), 38);
        assert_eq!(virtual_key("", "J"), 38);
        assert_eq!(virtual_key("", "Enter"), 36);
        assert_eq!(virtual_key("", "7"), 26);
        assert_eq!(virtual_key("", "한"), 0);
    }

    #[test]
    fn control_letters_are_control_characters() {
        let (characters, ignoring) = key_characters(&key_input("a", "", CTRL));
        assert_eq!(characters, "\u{1}");
        assert_eq!(ignoring, "a");
        let (characters, _) = key_characters(&key_input("a", "", CTRL | META));
        assert_eq!(characters, "a");
    }

    #[test]
    fn named_keys_use_function_key_characters() {
        let (characters, _) = key_characters(&key_input("ArrowLeft", "", 0));
        assert_eq!(characters.chars().next().map(u32::from), Some(0xF702));
        let (characters, _) = key_characters(&key_input("Enter", "\r", 0));
        assert_eq!(characters, "\r");
        let (characters, _) = key_characters(&key_input("A", "A", SHIFT));
        assert_eq!(characters, "A");
    }

    #[test]
    fn appkit_phases_become_the_coregraphics_fields_that_read_back_as_them() {
        assert_eq!(cg_scroll_phase(NS_BEGAN), 1);
        assert_eq!(cg_scroll_phase(NS_CHANGED), 2);
        assert_eq!(cg_scroll_phase(NS_ENDED), 4);
        assert_eq!(cg_scroll_phase(NS_CANCELLED), 8);
        assert_eq!(cg_scroll_phase(NS_MAY_BEGIN), 128);
        assert_eq!(
            cg_scroll_phase(0),
            0,
            "a momentum event has no finger phase"
        );
        assert_eq!(cg_momentum_phase(NS_BEGAN), 1);
        assert_eq!(cg_momentum_phase(NS_CHANGED), 2);
        assert_eq!(cg_momentum_phase(NS_ENDED), 3);
        assert_eq!(cg_momentum_phase(0), 0);
    }
}
