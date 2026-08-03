use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;

const PASSTHROUGH_TABLE: &str = "tweb-pass";

#[derive(Clone)]
struct ClientState {
    pane_id: String,
    key_table: String,
}

pub(crate) struct TmuxRuntime {
    pane: Option<String>,
    original_title: Option<String>,
    passthrough_clients: Mutex<HashMap<String, String>>,
}

impl TmuxRuntime {
    pub(crate) fn initialize() -> Self {
        let pane = std::env::var("TMUX_PANE").ok();
        let original_title = pane
            .as_deref()
            .and_then(|pane| tmux_output(&["display-message", "-p", "-t", pane, "#{pane_title}"]));
        if pane.is_some() {
            Self::ensure_passthrough_table();
        }
        Self {
            pane,
            original_title,
            passthrough_clients: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn window_session_key(&self) -> Option<String> {
        let pane = self.pane.as_deref()?;
        let identity = tmux_output(&[
            "display-message",
            "-p",
            "-t",
            pane,
            "#{socket_path}\t#{start_time}\t#{window_id}",
        ])?;
        let fields = identity.split('\t').collect::<Vec<_>>();
        if fields.len() != 3 || fields.iter().any(|field| field.is_empty()) {
            return None;
        }
        let digest = Sha256::digest(fields.join("\0").as_bytes());
        Some(
            digest[..12]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        )
    }

    pub(crate) fn notify(&self, message: &str) {
        if let Some(pane) = &self.pane {
            let _ = tmux_status(&["display-message", "-t", pane, message]);
        }
        eprintln!("tweb: {message}");
    }

    pub(crate) fn update_title(&self, title: &str) {
        let Some(pane) = &self.pane else {
            return;
        };
        let title = sanitize_title(title);
        let _ = tmux_status(&["select-pane", "-t", pane, "-T", &title]);
    }

    pub(crate) fn set_shortcuts_enabled(&self, enabled: bool) {
        let Some(pane) = &self.pane else {
            return;
        };
        let states = list_client_states();
        let Ok(mut armed) = self.passthrough_clients.lock() else {
            return;
        };
        armed.retain(|tty, original| {
            let keep = !enabled && states.get(tty).is_some_and(|state| state.pane_id == *pane);
            if !keep && states.contains_key(tty) {
                let _ = switch_client_table(tty, original);
            }
            keep
        });
        if enabled {
            return;
        }
        for (tty, state) in states {
            if state.pane_id != *pane || armed.contains_key(&tty) {
                continue;
            }
            let original = if state.key_table == PASSTHROUGH_TABLE {
                "root".to_string()
            } else {
                state.key_table
            };
            if switch_client_table(&tty, PASSTHROUGH_TABLE) {
                armed.insert(tty, original);
            }
        }
    }

    pub(crate) fn cleanup(&self) {
        if let Ok(mut armed) = self.passthrough_clients.lock() {
            for (tty, original) in armed.drain() {
                let _ = switch_client_table(&tty, &original);
            }
        }
        if let (Some(pane), Some(title)) = (&self.pane, &self.original_title) {
            let _ = tmux_status(&["select-pane", "-t", pane, "-T", title]);
        }
    }

    fn ensure_passthrough_table() {
        configure_root_toggle_binding();
        let user_keys = [
            (110, 5001),
            (111, 5009),
            (112, 5010),
            (113, 5002),
            (114, 5003),
            (115, 5004),
            (116, 5007),
        ];
        for (index, code) in user_keys {
            let option = format!("user-keys[{index}]");
            let sequence = format!("\x1b[{code}~");
            let _ = tmux_status(&["set-option", "-s", &option, &sequence]);
        }
        let _ = tmux_status(&[
            "bind-key",
            "-T",
            PASSTHROUGH_TABLE,
            "User110",
            "send-keys",
            "-H",
            "1b",
            "5b",
            "35",
            "30",
            "30",
            "31",
            "7e",
            ";",
            "switch-client",
            "-T",
            PASSTHROUGH_TABLE,
        ]);
        for (key, code) in [
            ("User113", 5002),
            ("User114", 5003),
            ("User115", 5004),
            ("User116", 5007),
        ] {
            let bytes = format!(
                "1b 5b {} 7e",
                String::from_utf8_lossy(
                    &code
                        .to_string()
                        .bytes()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<Vec<_>>()
                        .join(" ")
                        .into_bytes()
                )
            );
            let parts: Vec<&str> = bytes.split_whitespace().collect();
            let mut passthrough = vec!["bind-key", "-T", PASSTHROUGH_TABLE, key, "send-keys", "-H"];
            passthrough.extend(parts.iter().copied());
            passthrough.extend([";", "switch-client", "-T", PASSTHROUGH_TABLE]);
            let _ = tmux_status(&passthrough);
        }
        let _ = tmux_status(&[
            "bind-key",
            "-T",
            PASSTHROUGH_TABLE,
            "User112",
            "detach-client",
        ]);
        let private = [
            ("User100", ["35", "30", "30", "35"]),
            ("User101", ["35", "30", "30", "36"]),
            ("User111", ["35", "30", "30", "39"]),
        ];
        for (key, digits) in private {
            let mut args = vec![
                "bind-key",
                "-T",
                PASSTHROUGH_TABLE,
                key,
                "send-keys",
                "-H",
                "1b",
                "5b",
            ];
            args.extend(digits);
            args.extend(["7e", ";", "switch-client", "-T", PASSTHROUGH_TABLE]);
            let _ = tmux_status(&args);
        }
        let _ = tmux_status(&[
            "bind-key",
            "-T",
            PASSTHROUGH_TABLE,
            "Any",
            "send-keys",
            ";",
            "switch-client",
            "-T",
            PASSTHROUGH_TABLE,
        ]);
        for key in [
            "MouseDown1Pane",
            "MouseDown2Pane",
            "MouseDown3Pane",
            "MouseUp1Pane",
            "MouseUp2Pane",
            "MouseUp3Pane",
            "MouseDrag1Pane",
            "MouseDrag2Pane",
            "MouseDrag3Pane",
            "MouseDragEnd1Pane",
            "MouseDragEnd2Pane",
            "MouseDragEnd3Pane",
            "WheelUpPane",
            "WheelDownPane",
        ] {
            let _ = tmux_status(&[
                "bind-key",
                "-T",
                PASSTHROUGH_TABLE,
                key,
                "send-keys",
                "-M",
                ";",
                "switch-client",
                "-T",
                PASSTHROUGH_TABLE,
            ]);
        }
    }
}

impl Drop for TmuxRuntime {
    fn drop(&mut self) {
        self.cleanup();
    }
}

fn root_binding(key: &str) -> Option<String> {
    tmux_output(&["list-keys", "-T", "root", key])
}

fn ensure_root_binding(key: &str, action: &[&str], signatures: &[&str]) {
    let current = root_binding(key).unwrap_or_default();
    if !current.is_empty() {
        if !signatures
            .iter()
            .all(|signature| current.contains(signature))
            && std::env::var_os("TWEB_DEBUG").is_some()
        {
            eprintln!("tweb: preserving custom root {key} binding");
        }
        return;
    }
    let mut args = vec!["bind-key", "-T", "root", key];
    args.extend(action.iter().copied());
    let _ = tmux_status(&args);
}

fn configure_root_toggle_binding() {
    let toggle = root_binding("User110").unwrap_or_default();
    let legacy = toggle.contains("@tweb_browser") && toggle.contains("35 30 30 31");
    if legacy {
        let _ = tmux_status(&["unbind-key", "-T", "root", "User110"]);
    }

    for (key, digits) in [
        ("User110", ["35", "30", "30", "31"]),
        ("User111", ["35", "30", "30", "39"]),
        ("User113", ["35", "30", "30", "32"]),
        ("User114", ["35", "30", "30", "33"]),
        ("User115", ["35", "30", "30", "34"]),
        ("User116", ["35", "30", "30", "37"]),
    ] {
        let action = [
            "send-keys",
            "-H",
            "1b",
            "5b",
            digits[0],
            digits[1],
            digits[2],
            digits[3],
            "7e",
        ];
        let signature = format!(
            "send-keys -H 1b 5b {} {} {} {} 7e",
            digits[0], digits[1], digits[2], digits[3]
        );
        ensure_root_binding(key, &action, &[&signature]);
    }
    ensure_root_binding("User112", &["detach-client"], &["detach-client"]);
}

fn sanitize_title(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(160)
        .collect()
}

fn list_client_states() -> HashMap<String, ClientState> {
    let Some(output) = tmux_output(&[
        "list-clients",
        "-F",
        "#{client_tty}\t#{pane_id}\t#{client_key_table}",
    ]) else {
        return HashMap::new();
    };
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            Some((
                fields.next()?.to_string(),
                ClientState {
                    pane_id: fields.next()?.to_string(),
                    key_table: fields.next().unwrap_or("root").to_string(),
                },
            ))
        })
        .collect()
}

fn switch_client_table(tty: &str, table: &str) -> bool {
    tmux_status(&["switch-client", "-c", tty, "-T", table])
}

fn tmux_output(args: &[&str]) -> Option<String> {
    let output = Command::new("tmux").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn tmux_status(args: &[&str]) -> bool {
    Command::new("tmux")
        .args(args)
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(test)]
mod tests {
    use super::sanitize_title;

    #[test]
    fn pane_titles_drop_terminal_controls() {
        assert_eq!(sanitize_title("hello\n\x1b[2Jworld"), "hello[2Jworld");
    }
}
