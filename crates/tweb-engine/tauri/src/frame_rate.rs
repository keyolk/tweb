// Snapshot rate policy, following electron/frame-rate-policy.cjs.
//
// The engine used to know two rates: the maximum for 700ms after an input, and 1fps
// otherwise. A page that changes without input — a video, a canvas, a live dashboard — was
// therefore shown at 1fps. And while it did run at the maximum, a Retina pane's raw frame is
// 20.7MB, so 30fps asked the disk and the terminal for over 600MB/s; measured, that pressure
// slowed the page itself enough to push click-to-pixel latency from ~190ms to ~560ms.
//
// So the cost is bounded the way the Electron engine bounds it: by bytes, not by frames. A
// pane that is being used or is changing on its own runs at whatever rate the byte budget
// affords for its frame size, never under a floor that keeps motion readable.

/// Bytes per second a pane may send while active. Same default and override as Electron.
fn byte_budget() -> f64 {
    std::env::var("TWEB_PLAYBACK_BUDGET")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| *value > 0.0)
        .unwrap_or(60e6)
}

/// Below this, motion stops reading as motion; the budget yields to it.
const MIN_ACTIVE_RATE: u16 = 8;
/// How long after an input the pane counts as being used.
pub(crate) const INTERACTION_MS: u64 = 700;
/// How long after a frame actually changed the pane counts as playing.
pub(crate) const PLAYBACK_MS: u64 = 1000;

/// The rate a pane whose whole frames are `frame_bytes` long can afford.
/// An unknown size yields the ceiling: a rate policy must not be the thing that blanks a pane.
pub(crate) fn active_rate(max: u16, frame_bytes: u64, budget: f64) -> u16 {
    if frame_bytes == 0 {
        return max;
    }
    let affordable = (budget / frame_bytes as f64).round().clamp(0.0, 60.0) as u16;
    max.min(affordable.max(MIN_ACTIVE_RATE.min(max)))
}

pub(crate) struct Activity {
    pub now_ms: u64,
    pub last_input_ms: u64,
    pub last_change_ms: u64,
    pub frame_bytes: u64,
}

pub(crate) fn snapshot_rate(adaptive: bool, max: u16, activity: &Activity) -> u16 {
    if !adaptive {
        return max;
    }
    let interacting = activity.now_ms.saturating_sub(activity.last_input_ms) < INTERACTION_MS;
    let playing = activity.now_ms.saturating_sub(activity.last_change_ms) < PLAYBACK_MS;
    if interacting || playing {
        active_rate(max, activity.frame_bytes, byte_budget())
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RETINA: u64 = 2880 * 1800 * 4;

    fn activity(input_ago: u64, change_ago: u64, frame_bytes: u64) -> Activity {
        Activity {
            now_ms: 100_000,
            last_input_ms: 100_000 - input_ago,
            last_change_ms: 100_000 - change_ago,
            frame_bytes,
        }
    }

    #[test]
    fn a_page_changing_on_its_own_is_not_left_at_one_frame_per_second() {
        let rate = snapshot_rate(true, 30, &activity(60_000, 200, 980 * 456 * 4));
        assert!(
            rate > 1,
            "playback tier must engage without input, got {rate}"
        );
    }

    #[test]
    fn a_still_page_with_no_input_idles() {
        assert_eq!(
            snapshot_rate(true, 30, &activity(60_000, 60_000, RETINA)),
            1
        );
    }

    #[test]
    fn active_rate_is_bounded_by_bytes_with_a_floor() {
        // A Retina pane cannot afford 30fps at 60MB/s; it gets the readable floor instead.
        assert_eq!(active_rate(30, RETINA, 60e6), 8);
        // A small pane is limited by the configured ceiling, not by the budget.
        assert_eq!(active_rate(30, 640 * 400 * 4, 60e6), 30);
        // The floor never exceeds a ceiling set below it.
        assert_eq!(active_rate(5, RETINA, 60e6), 5);
        assert_eq!(active_rate(30, 0, 60e6), 30);
    }

    #[test]
    fn a_pinned_rate_ignores_activity() {
        assert_eq!(
            snapshot_rate(false, 24, &activity(60_000, 60_000, RETINA)),
            24
        );
    }
}
