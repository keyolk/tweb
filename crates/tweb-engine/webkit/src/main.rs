// tweb-webkit — WKWebViews hosted for the Electron engine.
//
// `--engine webkit` panes run the same Electron engine as every other pane; only the page lives
// here. electron/webkit/ presents each view to main.cjs as an Electron `webContents`, exactly as
// electron/cdp/ does for a Chrome tab, so modes, hints, tabs, the agent socket and the frame
// pipeline are the shared code rather than a second implementation. This process hosts views,
// takes their pictures, feeds them native input and answers.

#[cfg(target_os = "macos")]
mod app;
#[cfg(target_os = "macos")]
mod delegates;
#[cfg(target_os = "macos")]
mod input;
// Platform-neutral, so their tests run everywhere; only the macOS host calls into them.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod pixels;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod protocol;

#[cfg(target_os = "macos")]
fn main() {
    app::run();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("tweb-webkit: the WebKit engine needs macOS WKWebView");
    std::process::exit(1);
}
