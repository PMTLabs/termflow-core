#[cfg(test)]
use super::types::{SCROLLBACK_LINES, REPLAY_SEPARATOR};

/// Tracks focus-event reporting (DECSET/DECRST 1004) for one terminal by
/// scanning raw PTY output. Kept outside the vt100 parser because vt100 does
/// not model mode 1004. `carry` holds a bounded unterminated CSI tail so a
/// sequence split across two PTY chunks is still recognized.
#[derive(Default)]
pub struct FocusReportingTracker {
    pub on: bool,
    carry: Vec<u8>,
}

enum DecsetScan {
    /// Not `ESC [ ? … h/l` — advance one byte past the ESC and keep scanning.
    NotDecset,
    /// Chunk ended mid-sequence — carry the tail into the next scan.
    Incomplete,
    /// A complete private set/reset; `len` covers the whole sequence.
    Complete { len: usize, set: bool, has_1004: bool },
}

impl FocusReportingTracker {
    /// Scan a PTY chunk for `CSI ? … 1004 … h|l`. Params can be combined
    /// (`\x1b[?1002;1004h`), and the last occurrence in the stream wins.
    pub fn scan(&mut self, chunk: &[u8]) {
        // Longest real DECSET is far below this; anything longer is not a
        // sequence we care about, so an oversized tail is dropped rather than
        // letting hostile output grow the carry without bound.
        const CARRY_MAX: usize = 64;
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(chunk);
        let mut i = 0;
        while i < buf.len() {
            if buf[i] != 0x1b {
                i += 1;
                continue;
            }
            match Self::parse_private_mode(&buf[i..]) {
                DecsetScan::NotDecset => i += 1,
                DecsetScan::Incomplete => break,
                DecsetScan::Complete { len, set, has_1004 } => {
                    if has_1004 {
                        self.on = set;
                    }
                    i += len;
                }
            }
        }
        if i < buf.len() && buf.len() - i <= CARRY_MAX {
            self.carry = buf[i..].to_vec();
        }
    }

    /// Parse `b` (starting at an ESC byte) as `ESC [ ? params h|l`.
    fn parse_private_mode(b: &[u8]) -> DecsetScan {
        if b.len() < 2 {
            return DecsetScan::Incomplete;
        }
        if b[1] != b'[' {
            return DecsetScan::NotDecset;
        }
        if b.len() < 3 {
            return DecsetScan::Incomplete;
        }
        if b[2] != b'?' {
            return DecsetScan::NotDecset;
        }
        let mut j = 3;
        while j < b.len() && (b[j].is_ascii_digit() || b[j] == b';') {
            j += 1;
        }
        if j >= b.len() {
            return DecsetScan::Incomplete;
        }
        let set = match b[j] {
            b'h' => true,
            b'l' => false,
            _ => return DecsetScan::NotDecset,
        };
        let has_1004 = b[3..j].split(|c| *c == b';').any(|p| p == b"1004");
        DecsetScan::Complete { len: j + 1, set, has_1004 }
    }
}

/// Collect the `take` visible rows at the screen's current scrollback offset as
/// `(styled bytes, plain text, soft-wraps-to-next)` records appended to `recs`.
fn collect_rows(screen: &vt100::Screen, cols: u16, take: usize, recs: &mut Vec<(Vec<u8>, String, bool)>) {
    let styled: Vec<Vec<u8>> = screen.rows_formatted(0, cols).take(take).collect();
    let plain: Vec<String> = screen.rows(0, cols).take(take).collect();
    for (i, (s, p)) in styled.into_iter().zip(plain).enumerate() {
        recs.push((s, p, screen.row_wrapped(i as u16)));
    }
}

/// Render a screen's full buffer (scrollback rows then visible-screen rows) as a
/// styled, replayable byte stream. Soft-wrapped rows are joined to their continuation
/// (no line break) so a logical line stays ONE line and reflows on replay/resize;
/// only hard line ends get a trailing SGR reset + CRLF. No screen-clear is emitted.
/// Mutates the screen's scrollback offset during extraction and restores it. Returns
/// None when every row is blank.
///
/// Takes an owned/cloned screen by `&mut` (see full_scrollback_snapshot) so the
/// O(scrollback) walk never runs while holding the parser mutex the output consumer
/// contends on.
///
/// TUI-safety: a full-screen redraw (codex) clears with `\x1b[2J`, which erases the
/// visible screen WITHOUT pushing those rows to scrollback, so transient frames never
/// appear here — only lines that genuinely scrolled off, plus the final screen.
pub fn render_full_scrollback(screen: &mut vt100::Screen) -> Option<Vec<u8>> {
    let (rows, cols) = screen.size();
    let rows_us = rows as usize;
    let saved = screen.scrollback();

    screen.set_scrollback(usize::MAX);
    let total_sb = screen.scrollback();

    // One record per physical row: (styled bytes, plain text, soft-wraps-to-next).
    let mut recs: Vec<(Vec<u8>, String, bool)> = Vec::new();

    // Scrollback rows, paged in screen-height windows. At offset `total_sb - emitted`
    // the window's first visible row is logical index `emitted`, so stepping `emitted`
    // by the rows actually consumed tiles the scrollback with no overlap or gap.
    let mut emitted = 0usize;
    while emitted < total_sb {
        let take = (total_sb - emitted).min(rows_us);
        screen.set_scrollback(total_sb - emitted);
        collect_rows(screen, cols, take, &mut recs);
        emitted += take;
    }
    // Visible screen rows (offset 0).
    screen.set_scrollback(0);
    collect_rows(screen, cols, rows_us, &mut recs);

    // Restore the caller-visible offset (snapshotting must not move the user's view).
    screen.set_scrollback(saved);

    // Drop trailing blank rows (the screen's unused bottom rows) so restore doesn't
    // replay a wall of empty lines.
    while recs.last().map_or(false, |(_, p, _)| p.trim().is_empty()) {
        recs.pop();
    }
    if recs.is_empty() {
        return None;
    }

    let mut out = Vec::new();
    for (styled, _plain, wrapped) in &recs {
        out.extend_from_slice(styled);
        if !wrapped {
            // Hard line end: reset attrs and break. Soft-wrapped rows are joined to
            // their continuation so the logical line reflows on replay/resize.
            out.extend_from_slice(b"\x1b[0m\r\n");
        }
    }
    Some(out)
}

/// The paging plan for a tail read: one `(scrollback offset, rows to skip, rows to take)` per window.
///
/// Pure, and separate from the walk, because §10.1's real requirement — *never read more than
/// `max_lines + rows` rows regardless of buffer depth* — is a claim about the PLAN. `vt100::Screen`
/// cannot be instrumented to count what a walk touched, so a test that tried to assert it against the
/// walk would have to measure time, which is not an oracle. Against the plan it is arithmetic.
///
/// The offsets follow `render_full_scrollback`'s own idiom: at offset `total_sb - emitted` the
/// window's first visible row is logical index `emitted`, so stepping `emitted` by the rows actually
/// consumed tiles the buffer with no overlap or gap. While `emitted <= total_sb` the offset has not
/// saturated, so `window_first == emitted` and the skip is identically zero; only the LAST window —
/// the one whose offset is pinned at 0 — can need a non-zero skip, and it takes every remaining row.
/// That is what bounds the total at `max_lines + rows`.
pub(crate) fn tail_windows(
    total_sb: usize,
    rows: usize,
    max_lines: usize,
) -> Vec<(usize, usize, usize)> {
    let mut plan = Vec::new();
    if rows == 0 || max_lines == 0 {
        return plan;
    }
    let total = total_sb.saturating_add(rows);
    let want = max_lines.min(total);
    let mut emitted = total - want;
    while emitted < total {
        let offset = total_sb.saturating_sub(emitted);
        // The logical index of the first row visible at this offset.
        let window_first = total.saturating_sub(rows + offset);
        let skip = emitted.saturating_sub(window_first);
        let take = (total - emitted).min(rows.saturating_sub(skip));
        if take == 0 {
            // Unreachable while `rows > 0`, and a `break` rather than an assert because this runs on
            // the evaluation loop's hot path: a bad plan must cost a short read, never a panic that
            // poisons the parser mutex.
            break;
        }
        plan.push((offset, skip, take));
        emitted += take;
    }
    plan
}

/// Which records of a tail walk make up the LOGICAL line the cursor sits on, inclusive.
///
/// The reported problem this answers: a rule watching for `deploy` fired the instant the word
/// appeared under the user's fingers, before Enter. The screen genuinely contains that text, and
/// nothing else distinguishes an echoed keystroke from output — so the rule that opted in says
/// *the line the cursor is parked on is not output yet*.
///
/// **The cursor's line only, never "and everything below".** The reported use is an agentic CLI
/// whose status line sits UNDER its input box, and that status line is the text such a rule is
/// watching for: dropping the rest of the screen would take the value along with the noise.
///
/// **Both ends of a soft wrap.** One typed line can occupy several records, and it is one line to
/// the user. The backward walk is the one a long shell command needs; the forward walk is for a
/// cursor that is not on the last of those records — press Home on a wrapped command and the
/// cursor sits on its FIRST row — where dropping only from there down would leave the beginning of
/// the command behind for the pattern to match on.
///
/// Pure, and separate from the walk, because that is what makes the span checkable as arithmetic
/// rather than through a parser: the walk's last `rows` records are the visible screen, so visible
/// row `cursor_row` is record `recs.len() - rows + cursor_row`. `None` when that lands outside the
/// walk, which is a terminal with more rows than the read's own `max_lines` — the top of its screen
/// was never in the records to begin with.
fn typed_line_span(
    recs: &[(String, bool)],
    rows: usize,
    cursor_row: usize,
) -> Option<(usize, usize)> {
    let at = recs.len().checked_add(cursor_row)?.checked_sub(rows)?;
    if at >= recs.len() {
        return None;
    }

    let mut start = at;
    while start > 0 && recs.get(start - 1).is_some_and(|(_, wrapped)| *wrapped) {
        start -= 1;
    }
    let mut end = at;
    while end + 1 < recs.len() && recs.get(end).is_some_and(|(_, wrapped)| *wrapped) {
        end += 1;
    }
    Some((start, end))
}

/// The last `max_lines` rows of a screen's buffer as PLAIN TEXT, soft-wrapped rows joined.
///
/// **Joining wrapped rows is not optional**: a `ctx:63%` straddling column 120 otherwise never
/// matches. Trailing blank rows — the unused bottom of the visible screen — are dropped, so a mostly
/// empty terminal does not return a wall of newlines.
///
/// Two hard constraints, both from review:
///
/// 1. **Never `screen.clone()`.** `vt100::Cell` is 32 bytes, so a 5000x120 buffer is ~19 MB PER
///    EVALUATION. The clone-then-walk shape `full_scrollback_snapshot` uses is fine at the 30 s
///    persist cadence and is not fine at 250 ms.
/// 2. **No indexing, no slicing, no `unwrap`.** A panic inside this walk would poison
///    `terminal_screens[id]`, and `feed_screen` responds to a poisoned lock by logging a warning and
///    DROPPING THE BYTES — that terminal's authoritative parser would be dead for the life of the
///    process: no snapshot, no scrollback persist, no hydration. A read-only feature would have
///    silently destroyed the terminal it was watching. `tail_text_with` is the second half of that
///    guard.
///
/// Bounded at `max_lines` because the walk holds the per-terminal parser mutex that `feed_screen`
/// contends on, and this file's own note above `full_scrollback_snapshot` says holding it across an
/// O(scrollback) render stalls output delivery for EVERY terminal.
///
/// `skip_typed_line` drops the logical line under the cursor — the rule's own opt-in, so that a
/// command still being typed is not read as output. See `typed_line_span`.
pub fn render_tail_lines(screen: &mut vt100::Screen, max_lines: usize, skip_typed_line: bool) -> String {
    let (rows, cols) = screen.size();
    let saved = screen.scrollback();

    // Read BEFORE the walk moves the offset. The cursor belongs to the LIVE screen, and the row it
    // reports is an index into the visible rows at offset 0 — asking part-way through the paging
    // would be asking about whichever window happened to be showing.
    let cursor_row = screen.cursor_position().0 as usize;

    screen.set_scrollback(usize::MAX);
    let total_sb = screen.scrollback();

    // One record per physical row: (plain text, soft-wraps-to-next).
    let mut recs: Vec<(String, bool)> = Vec::new();
    for (offset, skip, take) in tail_windows(total_sb, rows as usize, max_lines) {
        screen.set_scrollback(offset);
        for (i, text) in screen.rows(0, cols).skip(skip).take(take).enumerate() {
            let row_index = skip.saturating_add(i).min(u16::MAX as usize) as u16;
            let wrapped = screen.row_wrapped(row_index);
            recs.push((text, wrapped));
        }
    }

    // Unconditional, with no `?` between the set and the restore: reading must never move the user's
    // own scrollback view.
    screen.set_scrollback(saved);

    // BEFORE the trailing blanks go, because the span is addressed by position in the full walk: at
    // a shell prompt the typed line IS the last non-blank record, and popping first would leave the
    // arithmetic pointing at whatever survived.
    if skip_typed_line {
        if let Some((start, end)) = typed_line_span(&recs, rows as usize, cursor_row) {
            // `retain` with a counter rather than `drain(start..=end)`: constraint 2 above is that
            // nothing in this walk may panic, and a range index is exactly the shape that can.
            let mut i = 0usize;
            recs.retain(|_| {
                let keep = i < start || i > end;
                i += 1;
                keep
            });
        }
    }

    while recs.last().is_some_and(|(t, _)| t.trim().is_empty()) {
        recs.pop();
    }

    let mut out = String::new();
    let mut line = String::new();
    for (text, wrapped) in recs {
        line.push_str(&text);
        if !wrapped {
            out.push_str(line.trim_end());
            out.push('\n');
            line.clear();
        }
    }
    if !line.trim().is_empty() {
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

/// Run a screen walk with the parser mutex held, without letting a panic in the walk poison it.
///
/// The guard lives in the CALLER's frame and the unwind is caught here, so the guard drops normally
/// and the mutex is never poisoned. The scrollback offset is restored in **both** arms — a walk that
/// panicked half-way through paging would otherwise leave the user's view scrolled to an arbitrary
/// position, which is visible and permanent.
///
/// Returns `None` when the walk panicked: no text is not the same as empty text, and the engine
/// treats it the way it treats a terminal that is not live — no evaluation, no log line.
pub fn tail_text_with<F>(screen: &mut vt100::Screen, walk: F) -> Option<String>
where
    F: FnOnce(&mut vt100::Screen) -> String,
{
    let saved = screen.scrollback();
    let walked = {
        let reborrow = &mut *screen;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || walk(reborrow)))
    };
    screen.set_scrollback(saved);
    match walked {
        Ok(text) => Some(text),
        Err(_) => {
            log::warn!("render_tail_lines panicked; the terminal's parser is intact and the read is skipped");
            None
        }
    }
}


#[cfg(test)]
mod tail_read_tests {
    use super::{render_tail_lines, tail_text_with, tail_windows, typed_line_span};
    use std::sync::Mutex;

    fn parser(rows: u16, cols: u16) -> vt100::Parser {
        vt100::Parser::new(rows, cols, super::SCROLLBACK_LINES)
    }

    /// §10.1 — the last `max_lines` lines, in order, as plain text.
    ///
    /// Fed WITHOUT a trailing newline so the bottom row holds `line 500` and the buffer has no unused
    /// rows: "exactly the last 200" is then literally checkable rather than approximately.
    #[test]
    fn render_tail_lines_returns_exactly_the_last_lines_in_order() {
        let mut p = parser(24, 80);
        let body: Vec<String> = (1..=500).map(|i| format!("line {}", i)).collect();
        p.process(body.join("\r\n").as_bytes());

        let text = render_tail_lines(p.screen_mut(), 200, false);
        let got: Vec<&str> = text.lines().collect();
        assert_eq!(got.len(), 200, "exactly `max_lines` rows");
        assert_eq!(got.first().copied(), Some("line 301"));
        assert_eq!(got.last().copied(), Some("line 500"));
        for (i, line) in got.iter().enumerate() {
            assert_eq!(*line, format!("line {}", 301 + i), "out of order at {}", i);
        }
    }

    /// A buffer shorter than the window returns everything it has, not a padded 200.
    #[test]
    fn a_short_buffer_returns_only_what_it_holds() {
        let mut p = parser(24, 80);
        p.process(b"alpha\r\nbeta\r\ngamma");
        let text = render_tail_lines(p.screen_mut(), 200, false);
        assert_eq!(text.lines().collect::<Vec<_>>(), vec!["alpha", "beta", "gamma"]);
    }

    /// The unused bottom of the visible screen is not 20 empty lines of "output".
    #[test]
    fn trailing_blank_rows_are_dropped() {
        let mut p = parser(24, 80);
        p.process(b"only line\r\n");
        let text = render_tail_lines(p.screen_mut(), 200, false);
        assert_eq!(text, "only line\n");
    }

    /// §10.2 — soft-wrap join. A value straddling the last column matches only when the rows are
    /// joined, which is the entire reason `row_wrapped` is consulted.
    #[test]
    fn a_soft_wrapped_value_is_joined_and_matches() {
        let mut p = parser(10, 20);
        // 18 characters, then `ctx:63%` - the value straddles column 20.
        p.process(b"..................ctx:63%");
        let joined = render_tail_lines(p.screen_mut(), 200, false);
        assert!(joined.contains("ctx:63%"), "wrapped rows must be joined: {:?}", joined);
        assert_eq!(joined.lines().count(), 1, "one logical line, not two physical rows");
    }

    /// The counterpart: a HARD line break at the same place must NOT be joined, or every rule would
    /// match across unrelated lines.
    #[test]
    fn a_hard_line_break_is_not_joined() {
        let mut p = parser(10, 20);
        p.process(b"..................ct\r\nx:63%");
        let text = render_tail_lines(p.screen_mut(), 200, false);
        assert!(!text.contains("ctx:63%"), "a hard break is a real line end: {:?}", text);
        assert_eq!(text.lines().count(), 2);
    }

    /// The user's own scrollback position is not a thing a background read may move.
    #[test]
    fn the_scrollback_offset_is_restored() {
        let mut p = parser(10, 40);
        for i in 0..200 {
            p.process(format!("line {}\r\n", i).as_bytes());
        }
        p.screen_mut().set_scrollback(37);
        let before = p.screen().scrollback();
        assert_eq!(before, 37, "premise: the view is scrolled");
        let _ = render_tail_lines(p.screen_mut(), 50, false);
        assert_eq!(p.screen().scrollback(), 37, "the walk moved the user's view");
    }

    /// §2.2's ruling, second half: a panicking walk must leave the parser USABLE. Without the catch,
    /// the mutex is poisoned and `feed_screen` then drops that terminal's bytes for the life of the
    /// process - no snapshot, no persist, no hydration.
    #[test]
    fn a_panicking_walk_neither_poisons_the_mutex_nor_moves_the_view() {
        let cell = Mutex::new(parser(10, 40));
        {
            let mut guard = cell.lock().expect("fresh mutex");
            // Enough lines to HAVE a scrollback: `set_scrollback` clamps to what exists, so a short
            // buffer would leave the offset at 0 and the restore assertion below could not fail.
            for i in 0..40 {
                guard.process(format!("before {}\r\n", i).as_bytes());
            }
            guard.screen_mut().set_scrollback(3);
            assert_eq!(guard.screen().scrollback(), 3, "premise: the view is genuinely scrolled");
            let out = tail_text_with(guard.screen_mut(), |screen| {
                // Move the view, THEN fail - the state a naive walk would leave behind.
                screen.set_scrollback(9);
                panic!("stub walk");
            });
            assert_eq!(out, None, "a panicked walk yields no text, never empty text");
            assert_eq!(guard.screen().scrollback(), 3, "the view was restored on the error path");
        }
        // The guard dropped normally because the unwind was caught in the inner frame.
        let mut guard = cell.lock().expect("the parser mutex must not be poisoned");
        guard.process(b"after\r\n");
        // The view is still parked three rows back — which is the point of the restore above — so
        // look at the LIVE screen to see whether the bytes actually landed.
        guard.screen_mut().set_scrollback(0);
        assert!(
            guard.screen().contents().contains("after"),
            "the parser must still accept feed_screen"
        );
    }

    /// §10.1's third clause, checked against the plan rather than the clock: whatever the buffer
    /// depth, a tail read visits at most `max_lines + rows` rows.
    #[test]
    fn a_tail_read_never_visits_more_than_max_lines_plus_one_screen() {
        for total_sb in [0usize, 1, 23, 199, 200, 201, 5_000, 50_000] {
            for rows in [1usize, 2, 24, 50] {
                for max_lines in [1usize, 200] {
                    let plan = tail_windows(total_sb, rows, max_lines);
                    let visited: usize = plan.iter().map(|(_, skip, take)| skip + take).sum();
                    let taken: usize = plan.iter().map(|(_, _, take)| take).sum();
                    assert!(
                        visited <= max_lines + rows,
                        "sb={} rows={} max={} visited {} rows",
                        total_sb, rows, max_lines, visited
                    );
                    assert_eq!(
                        taken,
                        max_lines.min(total_sb + rows),
                        "sb={} rows={} max={}",
                        total_sb, rows, max_lines
                    );
                }
            }
        }
    }

    /// The plan tiles the buffer with no overlap and no gap - the property that keeps the returned
    /// lines contiguous and in order.
    #[test]
    fn the_paging_plan_tiles_the_tail_exactly_once() {
        let (total_sb, rows, max_lines) = (500usize, 24usize, 200usize);
        let total = total_sb + rows;
        let mut expected = total - max_lines;
        for (offset, skip, take) in tail_windows(total_sb, rows, max_lines) {
            let window_first = total - rows - offset;
            assert_eq!(window_first + skip, expected, "gap or overlap at offset {}", offset);
            assert!(skip + take <= rows, "a window cannot yield more rows than it has");
            expected += take;
        }
        assert_eq!(expected, total, "the plan must reach the end of the buffer");
    }

    /// A zero-row screen cannot be paged, and must not loop forever trying.
    #[test]
    fn a_degenerate_screen_yields_an_empty_plan() {
        assert!(tail_windows(0, 0, 200).is_empty());
        assert!(tail_windows(500, 24, 0).is_empty());
    }

    // -----------------------------------------------------------------------------------------
    // "Ignore the line being typed" — `monitor.skip_typed_line`
    // -----------------------------------------------------------------------------------------

    /// Park the cursor on a 1-based `(row, col)`, the way a shell or a TUI leaves it.
    fn park(p: &mut vt100::Parser, row: u16, col: u16) {
        p.process(format!("\x1b[{};{}H", row, col).as_bytes());
    }

    /// The span, as arithmetic over a walk's records — no parser, no screen.
    ///
    /// A table over both dimensions that can be wrong independently: WHERE the cursor is among the
    /// records, and how far the soft wrap around it reaches. Varying one at a time is how an
    /// implementation that ignores `rows` passes (every row of a buffer with no scrollback) or one
    /// that only walks backwards passes (every cursor already at the end of its logical line).
    #[test]
    fn typed_line_span_is_a_table_over_position_and_wrapping() {
        let plain = |n: usize| vec![(String::new(), false); n];
        // `true` means "this record soft-wraps into the next", so b/c/d are ONE logical line.
        let wrapped = vec![
            (String::new(), false), // a
            (String::new(), true),  // b
            (String::new(), true),  // c
            (String::new(), false), // d
            (String::new(), false), // e
        ];

        // No scrollback: record index and visible row coincide.
        for row in 0..5 {
            assert_eq!(typed_line_span(&plain(5), 5, row), Some((row, row)), "row {}", row);
        }
        // With scrollback ahead of it, the visible screen is the LAST `rows` records.
        assert_eq!(typed_line_span(&plain(8), 5, 2), Some((5, 5)));
        assert_eq!(typed_line_span(&plain(8), 5, 0), Some((3, 3)));

        // Anywhere inside a wrapped run yields the WHOLE run, from either end of it.
        assert_eq!(typed_line_span(&wrapped, 5, 1), Some((1, 3)), "from its first row");
        assert_eq!(typed_line_span(&wrapped, 5, 2), Some((1, 3)), "from its middle");
        assert_eq!(typed_line_span(&wrapped, 5, 3), Some((1, 3)), "from its last row");
        // Its neighbours are untouched by it.
        assert_eq!(typed_line_span(&wrapped, 5, 0), Some((0, 0)));
        assert_eq!(typed_line_span(&wrapped, 5, 4), Some((4, 4)));

        // A screen taller than the read: its top rows were never in the walk, so a cursor up there
        // addresses nothing. Nothing is dropped rather than something arbitrary.
        assert_eq!(typed_line_span(&plain(3), 24, 0), None);
        assert_eq!(typed_line_span(&plain(3), 24, 20), None);
        assert_eq!(typed_line_span(&plain(3), 24, 23), Some((2, 2)), "the bottom row still lands");
        assert_eq!(typed_line_span(&[], 24, 3), None, "an empty walk has no line to drop");
    }

    /// The reported bug: a command still being typed at a prompt fired the rule before Enter.
    ///
    /// Both directions in one test, because the flag is the only difference between them — an
    /// implementation that ignores it passes either half alone.
    #[test]
    fn the_line_being_typed_is_dropped_only_when_the_rule_asks() {
        let mut p = parser(6, 40);
        p.process(b"build ok\r\n$ deploy now");

        let read = render_tail_lines(p.screen_mut(), 200, false);
        assert!(read.contains("deploy now"), "off, the screen is the screen: {:?}", read);

        let skipped = render_tail_lines(p.screen_mut(), 200, true);
        assert!(!skipped.contains("deploy"), "the typed line survived: {:?}", skipped);
        assert_eq!(skipped, "build ok\n", "and nothing above it went with it");
    }

    /// Tam's own qualifier, and the half a naive implementation fails: an agentic CLI draws its
    /// status line UNDER the input box, and that status line is what the rule is watching for.
    /// "The cursor's line and everything below" would take the value along with the noise.
    #[test]
    fn a_status_line_below_the_cursor_is_still_read() {
        let mut p = parser(6, 40);
        p.process(b"build ok\r\n> deploy now\r\nctx:63% . idle");
        park(&mut p, 2, 13); // back onto `> deploy now`, where a TUI leaves it

        let text = render_tail_lines(p.screen_mut(), 200, true);
        // Whole-output equality, not three `contains` calls: what makes this test worth writing is
        // exactly WHICH lines survived, and a `contains` oracle cannot tell "kept the status line"
        // from "kept the status line and half of something else".
        assert_eq!(text, "build ok\nctx:63% . idle\n");
    }

    /// A typed line long enough to wrap is still ONE line to the user, and the cursor may sit on
    /// any of its rows — press Home on a long command and it sits on the FIRST. Dropping from the
    /// cursor down would leave the beginning of that command behind for the pattern to match.
    #[test]
    fn a_soft_wrapped_typed_line_goes_whole() {
        let mut p = parser(6, 20);
        p.process(b"before\r\n$ deploy the whole cluster now");
        p.process(b"\x1b[5;1Hctx:63%");
        park(&mut p, 2, 3); // the first physical row of the wrapped command

        let text = render_tail_lines(p.screen_mut(), 200, true);
        // Whole-output equality, and a mutation run is why. The wrap falls mid-word — the rows are
        // `$ deploy the whole c` and `luster now` — so `!text.contains("cluster")` was true even
        // with the continuation row still there, and a backward-only walk passed this test.
        assert_eq!(text, "before\n\nctx:63%\n");
    }

    /// A cursor resting on a blank row drops a blank row — never the nearest text above it.
    #[test]
    fn a_cursor_on_an_empty_row_costs_nothing() {
        let mut p = parser(6, 40);
        p.process(b"ctx:63%\r\n");
        assert_eq!(render_tail_lines(p.screen_mut(), 200, true), "ctx:63%\n");
    }
}

#[cfg(test)]
mod focus_reporting_tests {
    use super::FocusReportingTracker;

    #[test]
    fn tracks_set_and_reset() {
        let mut t = FocusReportingTracker::default();
        t.scan(b"boot noise\x1b[?1004hui frame");
        assert!(t.on);
        t.scan(b"exit\x1b[?1004l");
        assert!(!t.on);
    }

    #[test]
    fn recognizes_combined_params() {
        let mut t = FocusReportingTracker::default();
        t.scan(b"\x1b[?1002;1004;1006h");
        assert!(t.on, "1004 inside a combined DECSET must be recognized");
        t.scan(b"\x1b[?1002;1006l");
        assert!(t.on, "a DECRST without 1004 must not clear it");
        t.scan(b"\x1b[?1049;1004l");
        assert!(!t.on);
    }

    #[test]
    fn sequence_split_across_chunks() {
        let mut t = FocusReportingTracker::default();
        t.scan(b"prompt\x1b[?10");
        assert!(!t.on, "must not fire on a partial sequence");
        t.scan(b"04h");
        assert!(t.on, "split DECSET must still be recognized via the carry");
    }

    #[test]
    fn ignores_lookalikes_and_wrong_finals() {
        let mut t = FocusReportingTracker::default();
        t.scan(b"\x1b[?1004n\x1b[1004h\x1b]0;title 1004h\x07plain 1004h text");
        assert!(!t.on);
        // Mode 11004 shares digits but is not 1004.
        t.scan(b"\x1b[?11004h");
        assert!(!t.on);
    }

    #[test]
    fn oversized_partial_tail_is_dropped_not_grown() {
        let mut t = FocusReportingTracker::default();
        // An unterminated CSI longer than the carry cap: dropped, and a 1004h in
        // a later chunk still tracks.
        let mut junk = b"\x1b[?".to_vec();
        junk.extend(std::iter::repeat(b'1').take(200));
        t.scan(&junk);
        t.scan(b"\x1b[?1004h");
        assert!(t.on);
    }
}

#[cfg(test)]
mod scrollback_tests {
    use super::render_full_scrollback;

    #[test]
    fn full_scrollback_recovers_offscreen_lines() {
        let mut p = vt100::Parser::new(24, 80, 1000);
        for i in 0..50 {
            p.process(format!("line-{:04}\r\n", i).as_bytes());
        }
        let blob = render_full_scrollback(p.screen_mut()).expect("nonblank");
        let text = String::from_utf8_lossy(&blob);
        // line-0001 scrolled off the 24-row screen but must be in the full dump.
        assert!(text.contains("line-0001"), "early off-screen line must be recovered:\n{text}");
        assert!(text.contains("line-0049"), "latest line must be present");
    }

    #[test]
    fn full_scrollback_excludes_2j_cleared_transient_frames() {
        // The codex regression pattern: main-buffer clears + an absolute-positioned
        // transient frame, then the final prompt. 2J-cleared content must NOT appear.
        let mut p = vt100::Parser::new(24, 80, 1000);
        p.process(b"stale pre-codex line\r\n");
        p.process(b"\x1b[2J\x1b[H");
        p.process(b"\x1b[10;5Htransient codex UI");
        p.process(b"\x1b[2J\x1b[H");
        p.process(b"PS D:\\sources> echo done\r\ndone\r\nPS D:\\sources> ");
        let blob = render_full_scrollback(p.screen_mut()).expect("nonblank");
        let text = String::from_utf8_lossy(&blob);
        assert!(text.contains("PS D:\\sources>"), "final prompt must survive, got:\n{text}");
        assert!(!text.contains("transient codex UI"), "2J-cleared transient must not appear, got:\n{text}");
        assert!(!text.contains("stale pre-codex line"), "2J-cleared content must not reappear, got:\n{text}");
    }

    #[test]
    fn full_scrollback_preserves_soft_wrap_for_reflow() {
        // A 120-char logical line in an 80-col terminal is ONE soft-wrapped line. The
        // dump must NOT hard-break it, so replaying into a wider terminal reflows it
        // back onto a single row (the previous code hard-wrapped at col 80).
        let mut p = vt100::Parser::new(24, 80, 1000);
        let long: String = (0..120).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        p.process(long.as_bytes());
        let blob = render_full_scrollback(p.screen_mut()).expect("nonblank");

        let mut r = vt100::Parser::new(24, 200, 1000);
        r.process(&blob);
        let row0 = r.screen().rows(0, 200).next().unwrap_or_default();
        assert!(
            row0.contains(&long),
            "soft-wrapped line must reflow onto one row when wider, got: {row0:?}"
        );
    }

    /// Load-bearing for the ED3 resize-wipe repair fix (docs/superpowers/specs/
    /// 2026-07-24-protocol-state-and-resize-wipe-fixes-design.md): codex answers a
    /// resize with `ESC[2J ESC[3J` then re-emits its own retained transcript
    /// (capped at ~1000 lines). xterm.js treats `3J` as "erase scrollback buffer"
    /// and wipes everything the client accumulated beyond that cap. This proves
    /// the Rust-side vt100 parser does NOT: content that already scrolled into
    /// genuine history before the clear survives `2J`/`3J` (standard ED2
    /// semantics — erase only touches the currently visible grid); only the last
    /// visible page at the moment of the clear is lost, identically on both
    /// sides, which is expected/unavoidable and not part of this bug.
    #[test]
    fn full_scrollback_survives_2j_3j_for_already_scrolled_history() {
        let mut p = vt100::Parser::new(24, 80, 1000);
        for i in 0..100 {
            p.process(format!("line-{:04}\r\n", i).as_bytes());
        }
        // codex's exact resize-response sequence, then a short re-emit.
        p.process(b"\x1b[2J\x1b[3J");
        p.process(b"codex reprint\r\n");

        let blob = render_full_scrollback(p.screen_mut()).expect("nonblank");
        let text = String::from_utf8_lossy(&blob);

        assert!(
            text.contains("line-0001"),
            "already-scrolled-off history must survive codex's 2J/3J, got:\n{text}"
        );
        assert!(
            text.contains("codex reprint"),
            "codex's post-clear re-emit must be present, got:\n{text}"
        );
        // line-0099 was still on the visible screen at the moment of the 2J — its
        // loss is the standard, unavoidable "clear the current page" behavior,
        // not the bug this fix targets. Pinned here so a future vt100 upgrade
        // that changed this wouldn't silently invalidate the assumption above.
        assert!(
            !text.contains("line-0099"),
            "the last visible page at clear-time is expected to be lost, got:\n{text}"
        );
    }

    #[test]
    fn blank_terminal_snapshot_is_none() {
        let mut p = vt100::Parser::new(24, 80, 1000);
        assert!(render_full_scrollback(p.screen_mut()).is_none());
    }

    /// The scrollback-persistence ratchet regression (docs: partial-scrollback bug):
    /// a fresh parser seeded with the previous session's persisted dump plus the
    /// replay separator — exactly what stage_scrollback feeds it — must re-dump
    /// BOTH sessions, so the next flush preserves restored history instead of
    /// overwriting it with only post-restart content. Also pins that the separator
    /// itself never wipes the seed (e.g. if it ever grew a 2J).
    #[test]
    fn seeded_restore_prefix_survives_reflush() {
        // Session 1: 100 lines scroll off a 24-row screen, then get dumped.
        let mut p1 = vt100::Parser::new(24, 80, 5000);
        for i in 0..100 {
            p1.process(format!("old-line-{:04}\r\n", i).as_bytes());
        }
        let blob1 = render_full_scrollback(p1.screen_mut()).expect("session 1 dump");

        // App restart: fresh parser, seeded with dump + separator, then new output.
        let mut p2 = vt100::Parser::new(24, 80, 5000);
        p2.process(&blob1);
        p2.process(super::REPLAY_SEPARATOR.as_bytes());
        p2.process(b"new-session output\r\n");

        let blob2 = render_full_scrollback(p2.screen_mut()).expect("session 2 dump");
        let text = String::from_utf8_lossy(&blob2);
        assert!(text.contains("old-line-0000"), "oldest restored line must survive reflush:\n{text}");
        assert!(text.contains("old-line-0099"), "newest restored line must survive reflush:\n{text}");
        assert!(text.contains("session restored"), "divider must be part of the re-dump:\n{text}");
        assert!(text.contains("new-session output"), "new session's output must follow:\n{text}");
    }
}
