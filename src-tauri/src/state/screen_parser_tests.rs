//! Backlog 056: a vt100 shadow screen at 1 row (or 1 column) panics inside vt100-0.16.2, and the
//! panic used to poison the per-terminal parser mutex for the life of the pane.
//!
//! Plain `#[cfg(test)]`: nothing here needs a tauri runtime, so it runs on Windows with `cargo test`.

use super::{
    feed_screen_parser, new_screen_parser, resize_screen_parser, visible_text, TerminalScreen,
    MIN_SCREEN_COLS, MIN_SCREEN_ROWS,
};
use std::sync::Mutex;

/// Text long enough to wrap a 24-column row at least once.
const WRAPPING: &[u8] = b"PS C:\\Users\\someone> ssh host-with-a-long-name\r\n";

/// The vendor defect itself. If a vt100 upgrade fixes it, this test turns red. That is the signal
/// to reconsider the clamp, not to delete the test.
#[test]
fn raw_vt100_panics_when_a_one_row_grid_wraps() {
    let result = std::panic::catch_unwind(|| {
        let mut p = vt100::Parser::new(1, 24, 0);
        p.process(WRAPPING);
    });
    assert!(
        result.is_err(),
        "vt100 no longer panics at 1 row; revisit MIN_SCREEN_ROWS"
    );
}

#[test]
fn raw_vt100_panics_on_a_wide_char_in_a_one_column_grid() {
    let result = std::panic::catch_unwind(|| {
        let mut p = vt100::Parser::new(24, 1, 0);
        p.process("界".as_bytes());
    });
    assert!(
        result.is_err(),
        "vt100 no longer panics at 1 column; revisit MIN_SCREEN_COLS"
    );
}

#[test]
fn minimums_are_at_least_two() {
    assert!(MIN_SCREEN_ROWS >= 2);
    assert!(MIN_SCREEN_COLS >= 2);
}

/// Every size the 054 live run hit (24x1, 35x1, 41x1), plus 0 and 1 in both dimensions.
#[test]
fn new_parser_at_degenerate_sizes_survives_wrapping_and_wide_output() {
    for (rows, cols) in [
        (1, 24),
        (1, 35),
        (1, 41),
        (0, 24),
        (24, 0),
        (24, 1),
        (1, 1),
        (0, 0),
    ] {
        let mut p = new_screen_parser(rows, cols, 1000);
        let (r, c) = p.screen().size();
        assert!(
            r >= MIN_SCREEN_ROWS && c >= MIN_SCREEN_COLS,
            "{rows}x{cols} gave {r}x{c}"
        );
        let fed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            p.process(WRAPPING);
            p.process(
                "界界界
"
                .as_bytes(),
            );
            for i in 0..50 {
                p.process(
                    format!("line {i} that is longer than forty-one columns wide\r\n").as_bytes(),
                );
            }
        }));
        assert!(fed.is_ok(), "feeding a {rows}x{cols} parser panicked");
    }
}

#[test]
fn resize_to_one_row_is_clamped_and_survives_output() {
    let mut p = new_screen_parser(24, 80, 1000);
    p.process(
        b"before
",
    );
    resize_screen_parser(&mut p, 1, 24);
    let (r, c) = p.screen().size();
    assert!(
        r >= MIN_SCREEN_ROWS && c >= MIN_SCREEN_COLS,
        "resize to 1x24 gave {r}x{c}"
    );
    p.process(WRAPPING);
    resize_screen_parser(&mut p, 24, 1);
    p.process("界".as_bytes());
    resize_screen_parser(&mut p, 0, 0);
    p.process(WRAPPING);
}

/// Leader's addition (1): a 1-row pane's shadow screen is 2 rows tall. Its dump must still hold the
/// latest output, and the cursor must sit on the row that output went to.
#[test]
fn one_row_pane_dump_holds_the_latest_output() {
    let mut p = new_screen_parser(1, 41, 1000);
    p.process(b"first\r\nsecond\r\nPS C:\\> ");
    assert_eq!(visible_text(p.screen(), 1, 41).trim_end(), r"PS C:\>");
    let (row, col) = p.screen().cursor_position();
    assert!(row < MIN_SCREEN_ROWS, "cursor row {row} outside the grid");
    assert_eq!(col, 8, "cursor must sit right after the prompt");
    // A full-screen redraw by a program that believes the screen is 1 row: CUP 1;1 + EL.
    p.process(b"\x1b[1;1H\x1b[Kredrawn");
    assert_eq!(visible_text(p.screen(), 1, 41), "redrawn");
}

/// Leader's addition (2): a panic during a feed must not leave the mutex poisoned, and must not
/// leave a half-updated grid in use. The helper recovers by rebuilding the parser from scratch at
/// the same (clamped) size, so later feeds land on a clean screen.
#[test]
fn a_panicking_feed_does_not_poison_the_mutex() {
    let lock = prepared_lock(new_screen_parser(24, 80, 1000), 24, 80);
    let _ = std::panic::catch_unwind(|| {
        let _g = lock.lock().unwrap();
        panic!("simulated vt100 panic");
    });
    assert!(lock.is_poisoned());
    assert_recovered(&lock, (24, 80));
}

fn prepared_lock(mut parser: vt100::Parser, rows: u16, cols: u16) -> Mutex<TerminalScreen> {
    parser.process(b"\x1b[?1049h\x1b[?25lstale\x1b[3");
    assert!(parser.screen().alternate_screen());
    assert!(parser.screen().hide_cursor());
    Mutex::new(TerminalScreen { parser, rows, cols })
}

fn assert_recovered(lock: &Mutex<TerminalScreen>, size: (u16, u16)) {
    feed_screen_parser(lock, "pc-test", b"m-ok");
    assert!(!lock.is_poisoned());
    let parser = lock.lock().unwrap();
    let screen = parser.parser.screen();
    assert!(!screen.alternate_screen());
    assert!(!screen.hide_cursor());
    assert_eq!(screen.contents().as_bytes(), b"m-ok");
    assert_eq!(screen.cursor_position(), (0, 4));
    assert_eq!(screen.size(), size);
}

#[test]
fn real_vt100_panic_drops_chunk_resets_modes_and_preserves_capacity() {
    let lock = prepared_lock(vt100::Parser::new(1, 24, 3), 1, 24);
    // Finish the pending CSI before emitting enough printable text to wrap.
    feed_screen_parser(
        &lock,
        "tiny",
        b"m-a chunk long enough to wrap at least once",
    );
    assert!(!lock.is_poisoned());
    assert_recovered(&lock, (2, 24));
    let mut shadow = lock.lock().unwrap();
    assert_eq!((shadow.rows, shadow.cols), (1, 24));
    shadow.parser.process(b"1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7");
    shadow.parser.screen_mut().set_scrollback(usize::MAX);
    assert_eq!(shadow.parser.screen().scrollback(), 3);
}

pub(crate) fn assert_one_row_replay(blob: &[u8]) {
    let mut replay = new_screen_parser(1, 24, 1000);
    replay.process(blob);
    let screen = replay.screen_mut();
    assert_eq!(visible_text(screen, 1, 24), "latest");
    assert_eq!(screen.cursor_position().1, 6, "cursor must sit right after \"latest\"");
    screen.set_scrollback(usize::MAX);
    let mut history = String::new();
    for offset in (1..=screen.scrollback()).rev() {
        screen.set_scrollback(offset);
        history.push_str(&screen.rows(0, 24).next().unwrap());
        if !screen.row_wrapped(0) {
            history.push('\n');
        }
    }
    assert!(
        history.contains("earlier wrapped line"),
        "history: {history:?}"
    );
    screen.set_scrollback(0);
    history.push_str(&screen.contents());
    assert_eq!(history.matches("latest").count(), 1, "buffer: {history:?}");
}
