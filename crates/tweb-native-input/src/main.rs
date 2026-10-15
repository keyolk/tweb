// tweb-native-input — the real pointer and the real scroll gesture, for panes inside tmux.
//
// tmux reports the mouse to a pane in cells (it does not know SGR-pixel mode 1016), so a drag
// arrives as a staircase and the pointer sits on a cell grid; a trackpad reaches it as wheel
// notches, so there is no precise or inertial scrolling. This process reads both from macOS
// directly and prints them as JSON lines; the engine (electron/native-input.cjs) decides from the
// pane's own geometry and its own tmux reports whether they belong to one of its panes, and falls
// back to the terminal's reports whenever it cannot tell.

#[cfg(target_os = "macos")]
mod mac;
mod wire;

#[cfg(target_os = "macos")]
fn main() {
    mac::run();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("tweb-native-input: native input needs macOS");
    std::process::exit(1);
}
