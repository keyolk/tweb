//! `tweb learn`: the agent asks the user to show it a flow, and waits for the demonstration.
//!
//! `gR` is the user deciding to teach. This is the other direction: an agent that does not know
//! how a site goes, and has no playbook for it, asks to be shown. The pane starts a learning
//! recording that names what was asked (`● SHOW ME: <goal>`), the user does it in the page and
//! presses `gR`, and the timeline comes back to the call that asked, not into a pane. The user
//! can refuse with `:decline`, and the agent is told so rather than handed a timeline that is
//! not a demonstration.
//!
//! What the agent then learns is its own job: it writes the site's playbook (`tweb playbook
//! write`), which the next session's `snapshot` points at.

use anyhow::Result;
use serde_json::{json, Value};
use std::time::Duration;

use crate::agent;

/// How long one call waits for the user, by default. A person doing a flow by hand takes
/// minutes; longer than this and the agent should say what it is waiting for and ask again.
pub const DEFAULT_WAIT: Duration = Duration::from_secs(600);

/// Start a learning recording that asks the user to show `goal`, and wait for it.
pub fn ask(pane: Option<&str>, goal: &str, interval: f64, timeout: Duration) -> Result<Value> {
    let goal = goal.trim();
    if goal.is_empty() {
        anyhow::bail!("say what to be shown: tweb learn \"<what the user should do>\"");
    }
    let started = agent::request(
        pane,
        "record-start",
        json!({ "learn": true, "goal": goal, "interval": interval }),
    )?;
    if started.get("already").and_then(Value::as_bool) == Some(true) {
        let asked = started.get("goal").and_then(Value::as_str);
        anyhow::bail!(
            "the pane is already recording{}; wait for it (tweb record wait) or stop it (tweb record stop)",
            asked.map(|goal| format!(" (asked: {goal})")).unwrap_or_default()
        );
    }
    let directory = started.get("directory").and_then(Value::as_str);
    wait(pane, directory, timeout)
}

/// Until the pane's recording stops, or `timeout`. `directory` names the recording, so asking
/// again after a timeout still gets its result once the user has finished.
pub fn wait(pane: Option<&str>, directory: Option<&str>, timeout: Duration) -> Result<Value> {
    agent::request(
        pane,
        "record-wait",
        json!({ "directory": directory, "timeout": timeout.as_millis() as u64 }),
    )
}

/// What the agent reads: the timeline and what to do with it, that the user declined, or that
/// they have not finished yet and how to keep waiting.
pub fn render(result: &Value) -> String {
    let text = |key: &str| result.get(key).and_then(Value::as_str).unwrap_or("");
    if result.get("waiting").and_then(Value::as_bool) == Some(true) {
        let asked = text("goal");
        return format!(
            "still waiting: the user has not finished showing {} (recording to {})\n\
             keep waiting with `tweb record wait` (MCP: tweb_record_wait); tell the user what you are waiting for if it takes long\n",
            if asked.is_empty() { "the flow".to_string() } else { format!("\"{asked}\"") },
            text("directory"),
        );
    }
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return "not recording\n".to_string();
    }
    let mut out = text("summary").to_string();
    if result.get("declined").and_then(Value::as_bool) == Some(true) {
        out.push_str("Do not learn from this timeline. Ask the user how they want to proceed.\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::render;
    use serde_json::json;

    #[test]
    fn a_wait_that_ran_out_says_how_to_keep_waiting() {
        let out = render(&json!({
            "ok": false, "waiting": true, "recording": true, "directory": "/r/1", "goal": "pay with 쿠페이",
        }));
        assert!(out.starts_with("still waiting"), "{out}");
        assert!(out.contains("\"pay with 쿠페이\""));
        assert!(out.contains("tweb record wait"));
    }

    #[test]
    fn a_shown_flow_is_its_summary_and_a_declined_one_says_not_to_learn() {
        let shown =
            json!({ "ok": true, "summary": "tweb learning: /r/1/timeline.md\nLearn this flow\n" });
        assert_eq!(
            render(&shown),
            "tweb learning: /r/1/timeline.md\nLearn this flow\n"
        );
        let declined =
            json!({ "ok": true, "declined": true, "summary": "tweb learning: declined\n" });
        assert!(render(&declined).contains("Do not learn from this timeline"));
        assert_eq!(
            render(&json!({ "ok": false, "recording": false })),
            "not recording\n"
        );
    }
}
