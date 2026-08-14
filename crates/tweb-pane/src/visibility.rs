//! Pane placement and visibility, probed once per tick and pushed to the engine.
//!
//! DESIGN.md 5.2 gives `tweb __pane` "forward the pane visibility/focus lifecycle".
//! The engine used to learn this by shelling out to tmux on its own timer, which is the
//! wrong process asking: the frontend already owns `$TMUX_PANE`, already wakes on
//! SIGWINCH, and already runs a geometry tick. Folding visibility into that existing tick
//! costs no extra wakeup and lets the engine stop spawning tmux entirely.
//!
//! Everything the engine needs comes back from ONE chained `tmux` invocation
//! (`display-message ... ";" list-clients ...`), so placement, cell size and the client
//! list are one child process rather than three. Measured on this machine over 30
//! iterations: two separate calls 529ms, the chained call 260ms.
//!
//! What crosses the wire is the raw tmux output, not a verdict. The engine keeps its own
//! (already tested) rule for turning clients into visibility — see
//! electron/tmux-visibility.cjs — so the zoom rule and the tty set live in exactly one
//! place instead of being reimplemented here and drifting.

use crate::terminal::{WindowGeometry, WindowSize};

/// Placement plus the client listing, exactly as tmux reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxProbe {
    pub geometry: Option<WindowGeometry>,
    /// `session`, `window_id`, `pane_id` — absent when tmux could not resolve the pane.
    pub placement: Option<(String, String, String)>,
    /// One entry per attached client, tab-separated, in the engine's field order.
    pub clients: Vec<String>,
}

/// The chained probe. `display-message` resolves against the pane target, so it re-reads
/// where the pane lives *now*: `break-pane`/`join-pane` keep the pane id but change the
/// window (and `join-pane` can change the session too). That re-resolution is why a moved
/// pane keeps painting, and it is preserved here by asking for `session_name`/`window_id`
/// through `-t <pane>` on every single tick — the same mechanism the engine's poll used,
/// moved to the process that already owns the pane id.
///
/// `client_key_table` is carried beyond what visibility needs so the engine can reconcile
/// its passthrough key tables from the same push instead of spawning `list-clients` again.
pub fn probe_args(pane: &str) -> Vec<String> {
    vec![
        "display-message".to_string(),
        "-p".to_string(),
        "-t".to_string(),
        pane.to_string(),
        "P\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}\
         \t#{client_cell_width}\t#{client_cell_height}\t#{session_name}\t#{window_id}"
            .to_string(),
        ";".to_string(),
        "list-clients".to_string(),
        "-F".to_string(),
        "C\t#{client_tty}\t#{client_session}\t#{window_id}\
         \t#{window_zoomed_flag}\t#{pane_id}\t#{client_key_table}"
            .to_string(),
    ]
}

fn parse_pixel_size(
    cols: u16,
    rows: u16,
    cell_width: &str,
    cell_height: &str,
) -> Option<(u16, u16)> {
    let cell_width = cell_width.parse::<f64>().ok()?;
    let cell_height = cell_height.parse::<f64>().ok()?;
    if !cell_width.is_finite()
        || !cell_height.is_finite()
        || cell_width <= 0.0
        || cell_height <= 0.0
    {
        return None;
    }
    let width = (f64::from(cols) * cell_width).round();
    let height = (f64::from(rows) * cell_height).round();
    if width < 1.0 || height < 1.0 || width > f64::from(u16::MAX) || height > f64::from(u16::MAX) {
        return None;
    }
    Some((width as u16, height as u16))
}

/// Splits the chained output into its two halves. tmux emits the `display-message` line
/// first and the client lines after, but the `P`/`C` tags are matched rather than the
/// position so a pane with no attached client (where `display-message` yields an empty
/// line) is read as "placement unknown" instead of shifting every client up by one.
pub fn parse_probe(stdout: &str, pane: &str) -> TmuxProbe {
    let mut geometry = None;
    let mut placement = None;
    let mut clients = Vec::new();

    for line in stdout.lines() {
        let Some((tag, rest)) = line.split_once('\t') else {
            continue;
        };
        match tag {
            "P" => {
                let fields: Vec<&str> = rest.split('\t').collect();
                if fields.len() < 8 {
                    continue;
                }
                let (Ok(cols), Ok(rows)) = (fields[0].parse::<u16>(), fields[1].parse::<u16>())
                else {
                    continue;
                };
                let (Ok(left), Ok(top)) = (fields[2].parse::<u32>(), fields[3].parse::<u32>())
                else {
                    continue;
                };
                if cols == 0 || rows == 0 {
                    continue;
                }
                let (width, height) =
                    parse_pixel_size(cols, rows, fields[4], fields[5]).unwrap_or((0, 0));
                geometry = Some(WindowGeometry {
                    size: WindowSize {
                        cols,
                        rows,
                        width,
                        height,
                    },
                    origin: Some((left, top)),
                });
                if !fields[6].is_empty() && !fields[7].is_empty() {
                    placement = Some((
                        fields[6].to_string(),
                        fields[7].to_string(),
                        pane.to_string(),
                    ));
                }
            }
            "C" => {
                if !rest.split('\t').next().unwrap_or("").is_empty() {
                    clients.push(rest.to_string());
                }
            }
            _ => {}
        }
    }

    TmuxProbe {
        geometry,
        placement,
        clients,
    }
}

/// The payload the engine parses: placement on the first line, one client per line after.
/// Empty when placement is unknown — the engine must not be told "no clients" on the
/// strength of a probe that could not even find the pane, because that reads as hidden and
/// stops painting.
pub fn visibility_payload(probe: &TmuxProbe) -> Option<String> {
    let (session, window, pane) = probe.placement.as_ref()?;
    let mut payload = format!("{session}\t{window}\t{pane}");
    for client in &probe.clients {
        payload.push('\n');
        payload.push_str(client);
    }
    Some(payload)
}

/// Hex framing, as `INPUT` already uses: the payload carries tabs and newlines, and the
/// control channel is line-delimited.
pub fn visibility_control_message(payload: &str) -> String {
    let mut line = String::with_capacity(payload.len() * 2 + 6);
    line.push_str("VIS ");
    for byte in payload.as_bytes() {
        use std::fmt::Write as _;
        let _ = write!(line, "{byte:02x}");
    }
    line.push('\n');
    line
}

/// Only pushes when something actually moved. Two reasons beyond saving bytes: the engine
/// treats every push as a change signal, and the Tauri engine restarts its 35ms
/// escape-flush timer on any line it does not parse, so an unconditional 4Hz push would
/// sit on top of a pending escape sequence there.
pub fn changed_visibility_message(
    previous: &mut Option<String>,
    probe: &TmuxProbe,
) -> Option<String> {
    let payload = visibility_payload(probe)?;
    if previous.as_deref() == Some(payload.as_str()) {
        return None;
    }
    let message = visibility_control_message(&payload);
    *previous = Some(payload);
    Some(message)
}

/// Runs the chained probe. Returns `None` outside tmux or when the call fails, in which
/// case the caller keeps whatever it already had rather than reporting a blank pane.
pub fn run_probe(pane: &str) -> Option<TmuxProbe> {
    let output = std::process::Command::new("tmux")
        .args(probe_args(pane))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(parse_probe(&String::from_utf8_lossy(&output.stdout), pane))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANE: &str = "%7";

    fn probe(stdout: &str) -> TmuxProbe {
        parse_probe(stdout, PANE)
    }

    #[test]
    fn parses_placement_geometry_and_clients_from_one_chained_output() {
        let parsed = probe(
            "P\t80\t24\t0\t1\t7\t14\tmain\t@3\n\
             C\t/dev/ttys001\tmain\t@3\t0\t%7\troot\n\
             C\t/dev/ttys002\tother\t@9\t0\t%2\ttweb-pass\n",
        );
        assert_eq!(
            parsed.geometry,
            Some(WindowGeometry {
                size: WindowSize {
                    cols: 80,
                    rows: 24,
                    width: 560,
                    height: 336
                },
                origin: Some((0, 1)),
            })
        );
        assert_eq!(
            parsed.placement,
            Some(("main".into(), "@3".into(), PANE.into()))
        );
        assert_eq!(parsed.clients.len(), 2);
        assert_eq!(parsed.clients[0], "/dev/ttys001\tmain\t@3\t0\t%7\troot");
    }

    #[test]
    fn reports_the_window_the_pane_lives_in_now_not_the_one_it_started_in() {
        // break-pane/join-pane keep %7 but move it to @9. The probe asks tmux through
        // `-t %7` every tick, so the pushed placement follows the pane.
        let moved =
            probe("P\t80\t24\t0\t0\t7\t14\tmain\t@9\nC\t/dev/ttys001\tmain\t@9\t0\t%7\troot\n");
        assert_eq!(
            moved.placement,
            Some(("main".into(), "@9".into(), PANE.into()))
        );
        assert_eq!(
            visibility_payload(&moved).unwrap(),
            "main\t@9\t%7\n/dev/ttys001\tmain\t@9\t0\t%7\troot"
        );
    }

    #[test]
    fn a_pane_tmux_cannot_resolve_yields_no_payload_rather_than_no_clients() {
        // With no client attached, the chained call still succeeds and prints an empty
        // display-message line. Pushing that as "zero clients" would read as hidden.
        let parsed = probe("P\t\nC\t/dev/ttys001\tmain\t@3\t0\t%7\troot\n");
        assert_eq!(parsed.placement, None);
        assert_eq!(visibility_payload(&parsed), None);
    }

    #[test]
    fn keeps_a_resolved_pane_with_no_attached_clients() {
        let parsed = probe("P\t80\t24\t0\t0\t7\t14\tmain\t@3\n");
        assert!(parsed.clients.is_empty());
        assert_eq!(visibility_payload(&parsed).unwrap(), "main\t@3\t%7");
    }

    #[test]
    fn skips_client_lines_with_no_tty() {
        let parsed = probe("P\t80\t24\t0\t0\t7\t14\tmain\t@3\nC\t\tmain\t@3\t0\t%7\troot\n");
        assert!(parsed.clients.is_empty());
    }

    #[test]
    fn falls_back_to_zero_pixels_when_the_cell_size_is_unusable() {
        let parsed = probe("P\t80\t24\t0\t0\t\t\tmain\t@3\n");
        assert_eq!(parsed.geometry.unwrap().size.width, 0);
        // Placement still resolves — a missing cell size must not cost us the pane.
        assert!(parsed.placement.is_some());
    }

    #[test]
    fn rejects_a_zero_sized_pane() {
        assert!(probe("P\t0\t24\t0\t0\t7\t14\tmain\t@3\n")
            .geometry
            .is_none());
    }

    #[test]
    fn hex_frames_the_payload_so_tabs_and_newlines_survive_the_line_channel() {
        assert_eq!(visibility_control_message("a\tb\nc"), "VIS 6109620a63\n");
    }

    #[test]
    fn pushes_only_when_the_payload_changes() {
        let first =
            probe("P\t80\t24\t0\t0\t7\t14\tmain\t@3\nC\t/dev/ttys001\tmain\t@3\t0\t%7\troot\n");
        let mut previous = None;
        assert!(changed_visibility_message(&mut previous, &first).is_some());
        assert!(changed_visibility_message(&mut previous, &first).is_none());

        let hidden = probe("P\t80\t24\t0\t0\t7\t14\tmain\t@3\n");
        assert!(changed_visibility_message(&mut previous, &hidden).is_some());
        assert!(changed_visibility_message(&mut previous, &hidden).is_none());
    }

    #[test]
    fn an_unresolvable_probe_does_not_clear_the_last_pushed_state() {
        let mut previous = None;
        let good =
            probe("P\t80\t24\t0\t0\t7\t14\tmain\t@3\nC\t/dev/ttys001\tmain\t@3\t0\t%7\troot\n");
        changed_visibility_message(&mut previous, &good);
        let kept = previous.clone();
        assert!(changed_visibility_message(&mut previous, &probe("P\t\n")).is_none());
        assert_eq!(previous, kept);
    }

    #[test]
    fn probe_args_ask_tmux_for_the_pane_by_id_on_every_call() {
        let args = probe_args(PANE);
        assert_eq!(args[0], "display-message");
        assert_eq!(args[3], PANE);
        assert_eq!(args[5], ";");
        assert_eq!(args[6], "list-clients");
        assert!(args[4].contains("#{session_name}") && args[4].contains("#{window_id}"));
        assert!(
            args[8].contains("#{window_zoomed_flag}") && args[8].contains("#{client_key_table}")
        );
    }
}
