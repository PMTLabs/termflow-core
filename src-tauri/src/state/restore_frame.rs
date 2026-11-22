//! Keeping a restored terminal's cursor frame the same in the renderer and in ConPTY.
//!
//! A restored terminal replays the previous session's scrollback into xterm, then the
//! new shell starts. ConPTY addresses the screen ABSOLUTELY (PSReadLine repaints with
//! `ESC[row;colH`), in ITS OWN idea of where the viewport is: a child that has just
//! started believes its prompt is on row 1. xterm, having replayed a screenful of
//! history, shows the prompt at the bottom. The first keystroke makes PSReadLine
//! repaint at row 1, and the typed text lands on the top of the old content.
//!
//! The two frames are made one in either of two ways, chosen by [`CursorFrame`]:
//!
//! - [`CursorFrame::Inherited`] keeps the look the user has always had (history above,
//!   the prompt right under the "session restored" divider). ConPTY is created with
//!   `PSEUDOCONSOLE_INHERIT_CURSOR` and told, at startup, the row the replay ends on —
//!   the row a screen the size of the spawn would hold it. The renderer puts its
//!   cursor on that same row (`TerminalEngine`'s restore replay), so a repaint at
//!   `row` is a repaint on the prompt.
//! - [`CursorFrame::AboveTheFold`] is the one that always works: the child starts on
//!   row 1 (no row is asked for) and the renderer scrolls the whole replay out of the
//!   viewport, so row 1 IS the top of an empty screen. Used wherever ConPTY cannot be
//!   told a row (a host without the capability, the inbox ConPTY).
//!
//! The backend's authoritative parser must hold the same screen the renderer will, so
//! [`plan_restore`] also says what to seed it with.

/// How a restored terminal's cursor frame is kept consistent. See the module doc.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorFrame {
    /// Nothing to align: this platform's PTY does not address the screen in a frame the
    /// replay could shift (every non-Windows PTY).
    Unmanaged,
    /// ConPTY starts the child on the row the replay ends on.
    Inherited,
    /// The child starts on row 1 and the replay is pushed above the viewport.
    AboveTheFold,
}

impl CursorFrame {
    /// Pick the frame for a spawn. `inherit_capable`: whatever creates the pseudoconsole can
    /// create it inheriting the cursor (a host advertising `CAP_INHERIT_CURSOR`, or the
    /// in-process bundled ConPTY).
    pub fn choose(inherit_capable: bool) -> Self {
        Self::choose_for(cfg!(windows), inherit_capable)
    }

    /// [`Self::choose`] with the platform spelled out, so the policy is testable everywhere.
    pub fn choose_for(windows: bool, inherit_capable: bool) -> Self {
        match (windows, inherit_capable) {
            (false, _) => Self::Unmanaged,
            (true, true) => Self::Inherited,
            (true, false) => Self::AboveTheFold,
        }
    }
}

/// What a restore does to the frames; the result of [`plan_restore`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestorePlan {
    /// What to feed the backend's authoritative parser. The renderer is sent the prefix itself
    /// (`anchor_row` tells it how to place it), so the parser must end up holding the screen
    /// the renderer will show.
    pub seed: String,
    /// The row (1-based) the renderer must put the cursor on after the replay, which is the
    /// row ConPTY believes the child's prompt is on. `None` = leave the cursor where the replay
    /// ended (unchanged behaviour).
    pub anchor_row: Option<u16>,
    /// `SpawnSpec::initial_cursor_row`: `Some` exactly when the pseudoconsole is to be created
    /// inheriting the cursor, and then equal to `anchor_row`.
    pub spawn_cursor_row: Option<u16>,
}

/// The 1-based row the cursor is on after `prefix` has been replayed into a fresh `rows`×`cols`
/// screen. A restored replay always ends at the start of a line (it ends with the divider and
/// two blank lines), so this is also where the shell's first prompt belongs.
pub fn replayed_cursor_row(prefix: &str, rows: u16, cols: u16) -> u16 {
    // No scrollback: only the screen's cursor is wanted.
    let mut parser = vt100::Parser::new(rows.max(1), cols.max(1), 0);
    parser.process(prefix.as_bytes());
    parser.screen().cursor_position().0.saturating_add(1)
}

/// Decide how `prefix` (the persisted blob plus [`REPLAY_SEPARATOR`]) is seeded and anchored for
/// a terminal spawned at `rows`×`cols`. The spawn size is the size the pseudoconsole is CREATED
/// at; the renderer may resize it before it hydrates, which is why the anchor is a row and not a
/// distance from the bottom.
pub fn plan_restore(prefix: &str, rows: u16, cols: u16, frame: CursorFrame) -> RestorePlan {
    match frame {
        CursorFrame::Unmanaged => {
            RestorePlan { seed: prefix.to_string(), anchor_row: None, spawn_cursor_row: None }
        }
        CursorFrame::Inherited => {
            let row = replayed_cursor_row(prefix, rows, cols);
            RestorePlan { seed: prefix.to_string(), anchor_row: Some(row), spawn_cursor_row: Some(row) }
        }
        CursorFrame::AboveTheFold => {
            // One line feed per row scrolls every row the replay left on screen into scrollback,
            // whatever row it ended on; the cursor is then homed. (vt100 drops lines scrolled
            // inside a scroll region, so plain line feeds — not a region — are what keep the
            // history.)
            let mut seed = String::with_capacity(prefix.len() + usize::from(rows) + 8);
            seed.push_str(prefix);
            seed.extend(std::iter::repeat('\n').take(usize::from(rows.max(1))));
            seed.push_str("\x1b[1;1H");
            RestorePlan { seed, anchor_row: Some(1), spawn_cursor_row: None }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::REPLAY_SEPARATOR;

    /// A persisted blob as `render_full_scrollback` writes it: rows separated by CRLF, no
    /// trailing newline.
    fn blob(lines: usize) -> String {
        (1..=lines).map(|i| format!("old-line-{i:03}")).collect::<Vec<_>>().join("\r\n")
    }

    fn prefix(lines: usize) -> String {
        format!("{}{REPLAY_SEPARATOR}", blob(lines))
    }

    /// An independent count of where the cursor ends: `lines` rows of blob, then the divider's
    /// three line feeds (`\r\n` + text + `\r\n` + `\r\n`), capped at the bottom row.
    fn expected_row(lines: usize, rows: u16) -> u16 {
        (lines + 3).min(usize::from(rows)) as u16
    }

    #[test]
    fn the_policy_is_a_function_of_platform_and_capability() {
        assert_eq!(CursorFrame::choose_for(false, true), CursorFrame::Unmanaged);
        assert_eq!(CursorFrame::choose_for(false, false), CursorFrame::Unmanaged);
        assert_eq!(CursorFrame::choose_for(true, true), CursorFrame::Inherited);
        assert_eq!(CursorFrame::choose_for(true, false), CursorFrame::AboveTheFold);
        assert_eq!(CursorFrame::choose(true), CursorFrame::choose_for(cfg!(windows), true));
    }

    #[test]
    fn an_unmanaged_restore_changes_nothing() {
        let p = prefix(5);
        let plan = plan_restore(&p, 24, 80, CursorFrame::Unmanaged);
        assert_eq!(plan, RestorePlan { seed: p, anchor_row: None, spawn_cursor_row: None });
    }

    #[test]
    fn an_inherited_restore_anchors_on_the_row_the_replay_ends_on() {
        // Short history (cursor mid-screen), exactly a screenful, and far more than one: the
        // row differs in each, which is what a single fixed row could not do.
        for lines in [1, 3, 10, 20, 21, 22, 23, 24, 100] {
            let p = prefix(lines);
            let plan = plan_restore(&p, 24, 80, CursorFrame::Inherited);
            let want = expected_row(lines, 24);
            assert_eq!(plan.anchor_row, Some(want), "{lines} history lines");
            assert_eq!(plan.spawn_cursor_row, Some(want), "ConPTY is told the row the renderer anchors on");
            assert_eq!(plan.seed, p, "the parser is seeded with the replay itself");
        }
    }

    #[test]
    fn the_anchor_follows_the_spawn_size_not_a_constant() {
        let p = prefix(100);
        for (rows, cols) in [(10u16, 80u16), (24, 80), (50, 120), (1, 80), (2, 10)] {
            let plan = plan_restore(&p, rows, cols, CursorFrame::Inherited);
            assert_eq!(plan.anchor_row, Some(replayed_cursor_row(&p, rows, cols)));
            assert_eq!(plan.anchor_row, Some(rows), "a long replay ends on the bottom row of a {rows}-row screen");
        }
    }

    #[test]
    fn a_line_that_wraps_at_the_spawn_width_counts_its_wrapped_rows() {
        let p = format!("{}{REPLAY_SEPARATOR}", "x".repeat(200));
        // 200 columns of text at 80 columns = 3 rows (cursor ends on the 3rd), plus the divider.
        assert_eq!(plan_restore(&p, 24, 80, CursorFrame::Inherited).anchor_row, Some(3 + 3));
        assert_eq!(plan_restore(&p, 24, 200, CursorFrame::Inherited).anchor_row, Some(1 + 3));
    }

    #[test]
    fn the_seeded_parser_is_where_the_plan_says_it_is() {
        for lines in [3, 30] {
            let p = prefix(lines);
            let plan = plan_restore(&p, 24, 80, CursorFrame::Inherited);
            let mut parser = vt100::Parser::new(24, 80, 5000);
            parser.process(plan.seed.as_bytes());
            assert_eq!(Some(parser.screen().cursor_position().0 + 1), plan.anchor_row);
            assert_eq!(parser.screen().cursor_position().1, 0, "the replay ends at the start of a line");
        }
    }

    #[test]
    fn a_child_repaint_at_the_anchor_lands_on_the_prompt_row_below_the_divider() {
        // The user-visible defect, in the backend's model of the screen: the child starts on the
        // anchor row (ConPTY's side), prints a prompt, and on the first keystroke repaints with an
        // ABSOLUTE position at that same row.
        for lines in [3, 30] {
            let p = prefix(lines);
            let plan = plan_restore(&p, 24, 80, CursorFrame::Inherited);
            let row = plan.anchor_row.unwrap();
            let mut parser = vt100::Parser::new(24, 80, 5000);
            parser.process(plan.seed.as_bytes());
            parser.process(b"PS D:\\src> ");
            parser.process(format!("\x1b[{row};1HPS D:\\src> x\x1b[{row};12H").as_bytes());
            let rows: Vec<String> = parser.screen().rows(0, 80).collect();
            let at = |needle: &str| rows.iter().position(|r| r.contains(needle)).unwrap();
            assert_eq!(at("PS D:\\src> x"), usize::from(row) - 1, "typed text is on the anchor row: {rows:?}");
            assert!(at("session restored") < at("PS D:\\src> x"), "the divider stays above it: {rows:?}");
            assert!(rows.iter().any(|r| r.contains("old-line-")), "history survives: {rows:?}");
        }
    }

    #[test]
    fn an_above_the_fold_restore_asks_for_no_row_and_leaves_an_empty_screen_with_the_history_behind_it() {
        for lines in [1, 3, 24, 100] {
            let p = prefix(lines);
            let plan = plan_restore(&p, 24, 80, CursorFrame::AboveTheFold);
            assert_eq!(plan.anchor_row, Some(1));
            assert_eq!(plan.spawn_cursor_row, None, "ConPTY starts on row 1 by itself");

            let mut parser = vt100::Parser::new(24, 80, 5000);
            parser.process(plan.seed.as_bytes());
            assert_eq!(parser.screen().cursor_position(), (0, 0), "{lines} lines");
            assert!(parser.screen().rows(0, 80).all(|r| r.trim().is_empty()), "the visible screen is empty");

            // Nothing is lost: the whole replay is in the scrollback a flush persists.
            let dump = String::from_utf8_lossy(&super::super::render_full_scrollback(parser.screen_mut()).expect("history")).into_owned();
            assert!(dump.contains("old-line-001"), "oldest line kept ({lines} lines)");
            assert!(dump.contains(&format!("old-line-{lines:03}")), "newest line kept ({lines} lines)");
            assert!(dump.contains("session restored"), "divider kept ({lines} lines)");
        }
    }

    #[test]
    fn a_child_repaint_on_row_one_after_an_above_the_fold_restore_touches_no_history() {
        let p = prefix(30);
        let plan = plan_restore(&p, 24, 80, CursorFrame::AboveTheFold);
        let mut parser = vt100::Parser::new(24, 80, 5000);
        parser.process(plan.seed.as_bytes());
        parser.process(b"\x1b[1;1HPS D:\\src> x");
        let dump = String::from_utf8_lossy(&super::super::render_full_scrollback(parser.screen_mut()).unwrap()).into_owned();
        assert!(dump.contains("old-line-030") && dump.contains("session restored"), "{dump}");
        assert!(parser.screen().rows(0, 80).next().unwrap().starts_with("PS D:\\src> x"));
    }
}
