// The wire between this host and electron/webkit/helper.cjs.
//
//   stdin   one JSON command per line, from the Electron engine
//   stdout  one JSON event per line, to it
//   fd 3    binary records: frames, capture replies and PDFs (see `pixels.rs`)
//
// Pixels do not go through JSON: a Retina frame is 20MB, and base64 would make it 27MB and
// cost an encode on one side and a decode on the other for every frame.

use serde::Deserialize;
use serde_json::Value;
use std::io::Write;
use std::sync::Mutex;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Command {
    /// Once, before any view: the scripts every frame gets, by world.
    Init {
        tweb_scripts: Vec<String>,
        page_scripts: Vec<String>,
        #[serde(default)]
        application_name: Option<String>,
    },
    Create {
        view: u32,
        width: f64,
        height: f64,
        scale: f64,
    },
    Close {
        view: u32,
    },
    Load {
        view: u32,
        url: String,
    },
    Reload {
        view: u32,
        #[serde(default)]
        ignore_cache: bool,
    },
    Stop {
        view: u32,
    },
    Go {
        view: u32,
        offset: i64,
    },
    Resize {
        view: u32,
        width: f64,
        height: f64,
        scale: f64,
    },
    Zoom {
        view: u32,
        factor: f64,
    },
    Eval {
        view: u32,
        req: u64,
        /// The frame's id from its messages; absent is the main frame.
        #[serde(default)]
        frame: Option<u64>,
        /// `tweb` (the preload's isolated world) or `page`.
        world: String,
        code: String,
    },
    Mouse {
        view: u32,
        kind: String,
        x: f64,
        y: f64,
        #[serde(default)]
        button: u32,
        #[serde(default)]
        clicks: i64,
        #[serde(default)]
        modifiers: u32,
        #[serde(default)]
        dx: f64,
        #[serde(default)]
        dy: f64,
    },
    Key {
        view: u32,
        kind: String,
        #[serde(default)]
        key: String,
        #[serde(default)]
        code: String,
        #[serde(default)]
        text: String,
        #[serde(default)]
        modifiers: u32,
    },
    Text {
        view: u32,
        text: String,
    },
    /// An editing command (copy, paste, selectAll, undo, ...), wire name `command`.
    #[serde(rename = "command")]
    Edit {
        view: u32,
        name: String,
    },
    Paint {
        view: u32,
        on: bool,
    },
    Rate {
        view: u32,
        fps: f64,
    },
    Invalidate {
        view: u32,
    },
    Capture {
        view: u32,
        req: u64,
        #[serde(default)]
        rect: Option<[f64; 4]>,
    },
    Pdf {
        view: u32,
        req: u64,
    },
    UserAgent {
        view: u32,
        ua: Option<String>,
    },
    Devtools {
        view: u32,
    },
    Focus {
        view: u32,
    },
    Download {
        view: u32,
        url: String,
    },
    DownloadDest {
        dl: u64,
        path: Option<String>,
    },
    DownloadCancel {
        dl: u64,
    },
    Chooser {
        view: u32,
        paths: Option<Vec<String>>,
    },
    Quit,
}

impl Command {
    /// The view a command is about to change the picture of — input, navigation, resize, zoom —
    /// so the snapshot clock treats it as lively again. Reads and queries are not activity.
    pub fn activity_view(&self) -> Option<u32> {
        match self {
            Command::Load { view, .. }
            | Command::Reload { view, .. }
            | Command::Go { view, .. }
            | Command::Resize { view, .. }
            | Command::Zoom { view, .. }
            | Command::Mouse { view, .. }
            | Command::Key { view, .. }
            | Command::Text { view, .. }
            | Command::Edit { view, .. }
            | Command::Paint { view, .. }
            | Command::Invalidate { view }
            | Command::Focus { view } => Some(*view),
            _ => None,
        }
    }
}

static STDOUT: Mutex<()> = Mutex::new(());

/// One event line. A failed write means the Electron engine is gone, and so is the reason to
/// run: the host exits rather than serving pages nobody can see.
pub fn emit(event: Value) {
    let _guard = STDOUT.lock().unwrap_or_else(|poison| poison.into_inner());
    let mut out = std::io::stdout().lock();
    let line = format!("{event}\n");
    if out
        .write_all(line.as_bytes())
        .and_then(|()| out.flush())
        .is_err()
    {
        std::process::exit(0);
    }
}

/// `TWEB_WEBKIT_PROFILE=1`: one stderr line per step of the frame and eval paths, with a
/// millisecond clock, so a latency can be split into where it went.
pub fn profiling() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("TWEB_WEBKIT_PROFILE").is_some())
}

pub fn profile(message: impl AsRef<str>) {
    if !profiling() {
        return;
    }
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let at = START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs_f64()
        * 1000.0;
    eprintln!("tweb-webkit {at:10.1} {}", message.as_ref());
}

pub fn log(message: impl AsRef<str>) {
    eprintln!("tweb-webkit: {}", message.as_ref());
}

#[cfg(test)]
mod tests {
    use super::Command;

    #[test]
    fn parses_commands_by_op() {
        let command: Command =
            serde_json::from_str(r#"{"op":"eval","view":3,"req":9,"world":"tweb","code":"1"}"#)
                .unwrap();
        assert!(matches!(
            command,
            Command::Eval {
                view: 3,
                req: 9,
                frame: None,
                ..
            }
        ));
        let command: Command =
            serde_json::from_str(r#"{"op":"download-dest","dl":4,"path":null}"#).unwrap();
        assert!(matches!(
            command,
            Command::DownloadDest { dl: 4, path: None }
        ));
        let command: Command = serde_json::from_str(
            r#"{"op":"mouse","view":1,"kind":"down","x":3.5,"y":4,"button":0,"clicks":1}"#,
        )
        .unwrap();
        assert!(matches!(command, Command::Mouse { clicks: 1, .. }));
    }
}
