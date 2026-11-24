use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, MutexGuard};

pub const MIN_SCREEN_ROWS: u16 = 2;
pub const MIN_SCREEN_COLS: u16 = 2;

pub fn new_screen_parser(rows: u16, cols: u16, scrollback: usize) -> vt100::Parser {
    vt100::Parser::new(
        rows.max(MIN_SCREEN_ROWS),
        cols.max(MIN_SCREEN_COLS),
        scrollback,
    )
}

pub fn resize_screen_parser(parser: &mut vt100::Parser, rows: u16, cols: u16) {
    parser
        .screen_mut()
        .set_size(rows.max(MIN_SCREEN_ROWS), cols.max(MIN_SCREEN_COLS));
}

fn rebuild(parser: &mut vt100::Parser) {
    let (rows, cols) = parser.screen().size();
    let mut fresh = new_screen_parser(rows, cols, 0);
    // vt100 exposes the current scrollback offset, not its capacity. RIS resets
    // the screen using its original primary-grid capacity. Run it with a fresh
    // decoder so any partial escape sequence in the old decoder is discarded.
    *fresh.screen_mut() = parser.screen().clone();
    fresh.process(b"\x1bc");
    resize_screen_parser(&mut fresh, rows, cols);
    *parser = fresh;
}

pub(super) fn lock_screen_parser<'a>(
    lock: &'a Mutex<TerminalScreen>,
    id: &str,
) -> MutexGuard<'a, TerminalScreen> {
    match lock.lock() {
        Ok(parser) => parser,
        Err(poisoned) => {
            let mut parser = poisoned.into_inner();
            rebuild(&mut parser.parser);
            lock.clear_poison();
            log::warn!("rebuilt poisoned screen parser for {id}");
            parser
        }
    }
}

pub fn feed_screen_parser(lock: &Mutex<TerminalScreen>, id: &str, data: &[u8]) {
    let mut parser = lock_screen_parser(lock, id);
    if catch_unwind(AssertUnwindSafe(|| parser.parser.process(data))).is_err() {
        rebuild(&mut parser.parser);
        log::warn!("screen parser panicked for {id}; rebuilt it and dropped the chunk");
    }
}

pub struct TerminalScreen {
    pub(crate) parser: vt100::Parser,
    pub(super) rows: u16,
    pub(super) cols: u16,
}

pub(super) fn projects_one_row(rows: u16) -> bool {
    rows <= 1
}

pub(crate) fn visible_text(screen: &vt100::Screen, rows: u16, cols: u16) -> String {
    if !projects_one_row(rows) {
        return screen.contents();
    }
    screen
        .rows(0, cols.max(1))
        .nth(usize::from(screen.cursor_position().0))
        .unwrap_or_default()
}

pub(super) fn append_cursor(out: &mut Vec<u8>, screen: &vt100::Screen, rows: u16, cols: u16) {
    if !projects_one_row(rows) {
        out.extend_from_slice(&screen.cursor_state_formatted());
    } else {
        out.extend_from_slice(if screen.hide_cursor() {
            b"\x1b[?25l"
        } else {
            b"\x1b[?25h"
        });
        let (row, col) = screen.cursor_position();
        let row = row.saturating_add(1).min(rows.max(1));
        let col = col.saturating_add(1).min(cols.max(1));
        out.extend_from_slice(format!("\x1b[{row};{col}H").as_bytes());
    }
    out.extend_from_slice(&screen.attributes_formatted());
}

/// Paint the shadow cursor's row onto the real one-row viewport. Moving it to
/// row zero on a scratch grid also removes any wrap-in positioning from vt100's
/// row formatter. Keep the original cursor, modes and attributes for the tail.
pub(super) fn one_row_snapshot(screen: &vt100::Screen, cols: u16) -> Vec<u8> {
    let mut out = b"\x1b[0m\x1b[1;1H\x1b[2K".to_vec();
    let mut scratch = new_screen_parser(1, screen.size().1, 0);
    *scratch.screen_mut() = screen.clone();
    if screen.cursor_position().0 != 0 {
        scratch.process(b"\x1b[?6l\x1b[r\x1b[1;1H\x1b[M");
    }
    if let Some(row) = scratch.screen().rows_formatted(0, cols.max(1)).next() {
        out.extend_from_slice(&row);
    }
    append_cursor(&mut out, screen, 1, cols);
    out
}

pub(super) fn append_one_row_scrollback_tail(
    blob: &mut Vec<u8>,
    screen: &vt100::Screen,
    cols: u16,
) {
    // If the active line was the last rendered row, don't scroll it
    // into history only to redraw it again in the viewport.
    let last_nonblank = screen
        .rows(0, screen.size().1)
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(row, _)| row)
        .last();
    let (row, col) = screen.cursor_position();
    if last_nonblank == Some(usize::from(row)) {
        if blob.ends_with(b"\r\n") {
            blob.truncate(blob.len() - 2);
        }
        // History already painted the active row. Address only the column:
        // on the real pane this stays on row 1, wherever replay ended.
        blob.extend_from_slice(if screen.hide_cursor() {
            b"\x1b[?25l"
        } else {
            b"\x1b[?25h"
        });
        let col = col.saturating_add(1).min(cols.max(1));
        blob.extend_from_slice(format!("\x1b[{col}G").as_bytes());
        blob.extend_from_slice(&screen.attributes_formatted());
    } else {
        blob.extend_from_slice(&one_row_snapshot(screen, cols));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_row_scrollback_preserves_wrapped_history_without_duplicating_latest() {
        let mut parser = new_screen_parser(1, 41, 1000);
        parser.process(b"earlier wrapped line that runs beyond forty-one columns\r\n");
        resize_screen_parser(&mut parser, 1, 24);
        parser.process(b"another long output line that wraps\r\nlatest");
        let screen = parser.screen_mut();
        let mut blob = super::super::render_full_scrollback(screen).unwrap();
        append_one_row_scrollback_tail(&mut blob, screen, 24);
        super::super::screen_parser_tests::assert_one_row_replay(&blob);
    }

    #[test]
    fn one_row_snapshot_replays_the_active_row_and_bounds_cup() {
        let mut parser = new_screen_parser(1, 24, 0);
        parser.process(b"older\r\n\x1b[31mlatest");
        assert_eq!(visible_text(parser.screen(), 1, 24), "latest");
        let blob = one_row_snapshot(parser.screen(), 24);
        let mut replay = new_screen_parser(1, 24, 0);
        replay.process(&blob);
        assert_eq!(replay.screen().contents(), "latest");
        assert_eq!(replay.screen().cursor_position(), (0, 6));
        assert_eq!(
            replay.screen().cell(0, 0).unwrap().fgcolor(),
            vt100::Color::Idx(1)
        );
        assert_eq!(
            super::super::restore_frame::replayed_cursor_row("a\r\nb", 1, 24),
            1
        );
    }
}
