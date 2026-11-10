//! Which cells of this pane a tmux floating pane is drawn over.
//!
//! tmux 3.8 floating panes are drawn by tmux into the cell grid, but the page is a Kitty
//! graphics placement the outer terminal composites ABOVE the cell grid. tmux does not know
//! the image is there, so a floating pane opened over a tweb pane is painted underneath the
//! page and cannot be seen. The engine cannot fix that on its own: it has no idea where the
//! floats are. This module turns the window's pane list into the rectangles, in this pane's
//! own cells, that the page must leave transparent.
//!
//! The rules are tmux's, read from its source (window.c, tmux 3.8):
//!
//! - `pane_z` counts from the front. A floating pane's value is the number of floating panes
//!   in front of it; every tiled pane gets the floating count plus one. So "A is drawn over B"
//!   is exactly `A.z < B.z`, and that also covers a tweb pane that is itself floating.
//! - A floating pane's border is one cell outside its content on every side, unless its
//!   `pane-border-lines` is `none` (`window_pane_floating_overlaps`). The border row is also
//!   where a floating status line is drawn, so covering the border covers that too.
//! - A zoomed window shows the zoomed pane and only the floats created with `new-pane -A`.
//!   No format exposes that flag (`PANE_FLOATOVERZOOM`), and the hidden floats keep their
//!   `pane_floating_flag` and geometry, so while zoomed nothing is reported. A float made
//!   with `-A` stays covered by a zoomed tweb pane; the alternative is punching holes for
//!   floats that are not on screen.

/// The `list-panes` format the probe chains after `list-clients`. Tagged `F` like the probe's
/// own `P`/`C` lines so the parser matches on the tag, not on position.
pub const LIST_PANES_FORMAT: &str = "F\t#{pane_id}\t#{pane_floating_flag}\t#{pane_z}\
     \t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\
     \t#{pane-border-lines}\t#{window_zoomed_flag}";

/// One `list-panes` line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneBox {
    pub id: String,
    pub floating: bool,
    pub z: u32,
    pub left: i64,
    pub top: i64,
    pub width: i64,
    pub height: i64,
    pub bordered: bool,
    pub window_zoomed: bool,
}

/// A rectangle in this pane's cells: `col`/`row` from its top-left, `cols`/`rows` wide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellRect {
    pub col: u32,
    pub row: u32,
    pub cols: u32,
    pub rows: u32,
}

/// Parses the fields after the `F` tag. A line that does not parse is skipped by the caller:
/// one unreadable pane must not cost the others.
pub fn parse_pane_box(rest: &str) -> Option<PaneBox> {
    let fields: Vec<&str> = rest.split('\t').collect();
    if fields.len() < 9 || fields[0].is_empty() {
        return None;
    }
    Some(PaneBox {
        id: fields[0].to_string(),
        floating: fields[1] == "1",
        z: fields[2].parse().ok()?,
        left: fields[3].parse().ok()?,
        top: fields[4].parse().ok()?,
        width: fields[5].parse().ok()?,
        height: fields[6].parse().ok()?,
        bordered: fields[7] != "none",
        window_zoomed: fields[8] == "1",
    })
}

/// The cells of `pane` that a floating pane in front of it covers, in `pane`'s coordinates.
///
/// Empty when `pane` is not in the list: that is a probe that could not see the window, and
/// reporting "nothing covers you" is the state the pane had before this module existed.
pub fn covered_cells(panes: &[PaneBox], pane: &str) -> Vec<CellRect> {
    let Some(me) = panes.iter().find(|p| p.id == pane) else {
        return Vec::new();
    };
    if me.window_zoomed {
        return Vec::new();
    }
    let mut rects = Vec::new();
    for other in panes {
        if other.id == me.id || !other.floating || other.z >= me.z {
            continue;
        }
        let border = i64::from(other.bordered);
        let left = (other.left - border).max(me.left);
        let top = (other.top - border).max(me.top);
        let right = (other.left + other.width + border).min(me.left + me.width);
        let bottom = (other.top + other.height + border).min(me.top + me.height);
        if right <= left || bottom <= top {
            continue;
        }
        rects.push(CellRect {
            col: (left - me.left) as u32,
            row: (top - me.top) as u32,
            cols: (right - left) as u32,
            rows: (bottom - top) as u32,
        });
    }
    rects
}

/// `OCC <col>,<row>,<cols>,<rows> ...`; a bare `OCC` means nothing covers the pane. An engine
/// that predates this line parses it as unrecognised and ignores it.
pub fn occlusion_control_message(rects: &[CellRect]) -> String {
    let mut line = String::from("OCC");
    for rect in rects {
        line.push_str(&format!(" {},{},{},{}", rect.col, rect.row, rect.cols, rect.rows));
    }
    line.push('\n');
    line
}

/// Only pushes on change, like the visibility push: every OCC makes the engine send a whole
/// frame, so an unconditional push would be four whole frames a second.
pub fn changed_occlusion_message(
    previous: &mut Option<Vec<CellRect>>,
    current: Vec<CellRect>,
) -> Option<String> {
    if previous.as_ref() == Some(&current) {
        return None;
    }
    let message = occlusion_control_message(&current);
    *previous = Some(current);
    Some(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(id: &str, floating: bool, z: u32, rect: (i64, i64, i64, i64)) -> PaneBox {
        PaneBox {
            id: id.into(),
            floating,
            z,
            left: rect.0,
            top: rect.1,
            width: rect.2,
            height: rect.3,
            bordered: true,
            window_zoomed: false,
        }
    }

    #[test]
    fn parses_a_list_panes_line() {
        let parsed = parse_pane_box("%9\t1\t0\t10\t4\t30\t8\tsingle\t0").unwrap();
        assert_eq!(parsed, pane("%9", true, 0, (10, 4, 30, 8)));
        assert!(!parse_pane_box("%9\t1\t0\t10\t4\t30\t8\tnone\t0").unwrap().bordered);
        assert!(parse_pane_box("%9\t1\tx\t10\t4\t30\t8\tsingle\t0").is_none());
        assert!(parse_pane_box("\t1\t0\t10\t4\t30\t8\tsingle\t0").is_none());
    }

    #[test]
    fn a_float_over_a_tiled_pane_covers_its_content_and_border() {
        // tweb is the right half of a 200-wide window; the float straddles the split.
        let panes = [
            pane("%1", false, 2, (0, 0, 99, 50)),
            pane("%2", false, 2, (100, 0, 100, 50)),
            pane("%9", true, 0, (90, 10, 30, 8)),
        ];
        assert_eq!(
            covered_cells(&panes, "%2"),
            vec![CellRect { col: 0, row: 9, cols: 21, rows: 10 }]
        );
    }

    #[test]
    fn a_borderless_float_covers_only_its_content() {
        let mut float = pane("%9", true, 0, (10, 10, 5, 3));
        float.bordered = false;
        let panes = [pane("%2", false, 1, (0, 0, 80, 24)), float];
        assert_eq!(
            covered_cells(&panes, "%2"),
            vec![CellRect { col: 10, row: 10, cols: 5, rows: 3 }]
        );
    }

    #[test]
    fn a_float_that_does_not_reach_the_pane_covers_nothing() {
        let panes = [
            pane("%2", false, 2, (100, 0, 100, 50)),
            // Its right border is column 99, the cell before the pane starts.
            pane("%9", true, 0, (60, 10, 38, 8)),
        ];
        assert!(covered_cells(&panes, "%2").is_empty());
    }

    #[test]
    fn a_floating_tweb_pane_is_covered_only_by_floats_in_front_of_it() {
        let panes = [
            pane("%1", false, 3, (0, 0, 200, 50)),
            pane("%front", true, 0, (12, 12, 4, 4)),
            pane("%tweb", true, 1, (10, 10, 40, 20)),
            pane("%behind", true, 2, (20, 20, 4, 4)),
        ];
        assert_eq!(
            covered_cells(&panes, "%tweb"),
            vec![CellRect { col: 1, row: 1, cols: 6, rows: 6 }]
        );
        // And a tiled pane under the floating tweb pane is not tweb's business.
        assert_eq!(covered_cells(&panes, "%1").len(), 3);
    }

    #[test]
    fn a_zoomed_window_reports_nothing() {
        let mut me = pane("%2", false, 1, (0, 0, 80, 24));
        me.window_zoomed = true;
        let mut float = pane("%9", true, 0, (10, 10, 5, 3));
        float.window_zoomed = true;
        assert!(covered_cells(&[me, float], "%2").is_empty());
    }

    #[test]
    fn an_unlisted_pane_reports_nothing() {
        assert!(covered_cells(&[pane("%9", true, 0, (0, 0, 5, 5))], "%2").is_empty());
    }

    #[test]
    fn the_control_line_lists_rects_and_is_bare_when_clear() {
        assert_eq!(occlusion_control_message(&[]), "OCC\n");
        assert_eq!(
            occlusion_control_message(&[
                CellRect { col: 0, row: 9, cols: 21, rows: 10 },
                CellRect { col: 3, row: 4, cols: 5, rows: 6 },
            ]),
            "OCC 0,9,21,10 3,4,5,6\n"
        );
    }

    #[test]
    fn pushes_only_on_change_and_always_pushes_the_first_state() {
        let mut previous = None;
        assert_eq!(
            changed_occlusion_message(&mut previous, Vec::new()).as_deref(),
            Some("OCC\n")
        );
        assert!(changed_occlusion_message(&mut previous, Vec::new()).is_none());
        let covered = vec![CellRect { col: 1, row: 2, cols: 3, rows: 4 }];
        assert!(changed_occlusion_message(&mut previous, covered.clone()).is_some());
        assert!(changed_occlusion_message(&mut previous, covered).is_none());
        assert!(changed_occlusion_message(&mut previous, Vec::new()).is_some());
    }
}
