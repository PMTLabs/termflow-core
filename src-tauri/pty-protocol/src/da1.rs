//! Answering the modern ConPTY's startup DA1 handshake (plan 050).
//!
//! The sideloaded OpenConsole (plan 049) opens every session with a burst like
//! `ESC[1t ESC[c ESC[?1004h ESC[?9001h` and then HOLDS the child process until
//! the terminal answers the DA1 query (`ESC[c`), giving up after ~3 s. Windows
//! Terminal answers at once; TermFlow relied on xterm.js in the renderer, which
//! may not be mounted yet (or sees the query discarded by a snapshot hydrate).
//! The host therefore answers it itself, at the producer, and removes that one
//! query from the stream so a renderer never answers it a second time.
//!
//! [`StartupDa1`] is a byte-level recogniser for the *preamble context only*:
//! `ESC [` + bytes 0x20..=0x3F + a final byte of `t`, `h` or `l` (it does not
//! validate parameter-before-intermediate ordering). The first DA1 met inside
//! that context is answered and stripped; the first byte that is not part of
//! such a sequence (child text, another CSI, a stray `ESC`) retires the filter
//! untouched. The recogniser cannot tell WHO sent the bytes: it relies on the
//! bundled ConPTY emitting its preamble before any child output, so a child's own
//! DA1 is only safe from it once something else (the backend's own preamble, or
//! any other byte) has been seen first. The result depends only on the byte
//! stream, never on how `read()` happened to chunk it.
//!
//! **Cursor report.** A pseudoconsole created with `PSEUDOCONSOLE_INHERIT_CURSOR`
//! (a restored terminal, see `pty-host`'s `Session::spawn`) opens with `ESC[6n`
//! BEFORE the DA1 query and starts the child's cursor wherever the reply says,
//! instead of at row 1. When the filter was given a cursor row it answers that one
//! query the same way — at the producer, stripped from the stream, `ESC[row;1R` —
//! and stays armed for the DA1 behind it. The reply MUST precede the DA1 reply:
//! ConPTY treats the DA1 answer as "the terminal has nothing more to say" and
//! settles for row 1 if the cursor report has not arrived by then.

use std::borrow::Cow;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

/// What xterm.js itself answers to DA1 (`InputHandler.ts` for `termName: xterm`):
/// a VT100 with the advanced video option.
pub const DA1_REPLY: &[u8] = b"\x1b[?1;2c";

/// The cursor-position report for a startup `ESC[6n`: row `row` (1-based), column 1.
/// A restored terminal's replay always ends at the start of a line.
pub fn cursor_report(row: u16) -> Vec<u8> {
    format!("\x1b[{};1R", row.max(1)).into_bytes()
}

/// The cursor row a new pseudoconsole should be created inheriting: `requested`, but only
/// where ConPTY is measured to honour it — the bundled one (it asks for the cursor before
/// the DA1 and never hangs on a missing reply). The inbox ConPTY and every other platform
/// get `None`, i.e. a plain pseudoconsole whose child starts on row 1.
///
/// Callers use the SAME answer to create the pseudoconsole and to build the reader's
/// [`StartupDa1::for_spawn`] filter, so the two cannot disagree.
pub fn inheritable_cursor_row(requested: Option<u16>) -> Option<u16> {
    requested.filter(|_| inherit_cursor_supported())
}

/// Whether this process creates pseudoconsoles that can inherit the cursor — what a host
/// advertises as `CAP_INHERIT_CURSOR`. True exactly when the bundled ConPTY is loaded
/// (so only after `conpty::init_for_current_exe`), and never off Windows.
pub fn inherit_cursor_supported() -> bool {
    #[cfg(windows)]
    {
        crate::conpty::is_bundled_active()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Stop accepting new preamble sequences once this many raw bytes were seen.
/// Checked only at a sequence boundary, so a sequence that STARTED below the
/// limit may still complete (bounded by [`MAX_SEQ`]).
const BUDGET: usize = 256;

/// Longest in-progress sequence we hold back (`ESC [` plus parameters).
const MAX_SEQ: usize = 16;

const ESC: u8 = 0x1b;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    /// At a sequence boundary.
    Ground,
    /// Saw `ESC`.
    Esc,
    /// Saw `ESC [`; collecting parameter / intermediate bytes.
    Csi,
}

/// Output of [`StartupDa1::filter`].
#[derive(Debug)]
pub struct Filtered<'a> {
    /// Bytes to forward. Borrowed (no copy) once the filter has retired.
    pub bytes: Cow<'a, [u8]>,
    /// True exactly once per filter: the startup DA1 was found in this chunk and
    /// removed. The caller must now send [`DA1_REPLY`] to the PTY.
    pub answered: bool,
    /// True at most once per filter: the startup cursor-position query was found in
    /// this chunk and removed (only when the filter was given a cursor row).
    pub cursor_answered: bool,
    /// Every reply now due, concatenated in the order the queries appeared — the
    /// cursor report first, then [`DA1_REPLY`]. Empty when nothing was answered.
    /// Sending it as ONE write keeps that order.
    pub reply: Vec<u8>,
    /// Raw bytes consumed so far, for diagnostics.
    pub consumed: usize,
}

/// The startup-handshake filter. One per session, owned by the reader thread.
#[derive(Debug)]
pub struct StartupDa1 {
    armed: bool,
    /// Answer (and strip) the DA1 query. False when the filter is armed ONLY for the
    /// cursor report (an inbox ConPTY that was asked to inherit the cursor): there a
    /// DA1 is not ours to eat, so it retires the filter and goes to the renderer.
    answer_da1: bool,
    /// The report to send for the first `ESC[6n`; `None` = do not touch cursor queries.
    cursor_reply: Option<Vec<u8>>,
    cursor_done: bool,
    mode: Mode,
    consumed: usize,
    /// Bytes of the in-progress sequence, withheld until it resolves.
    held: Vec<u8>,
}

impl StartupDa1 {
    pub fn new(armed: bool) -> Self {
        Self {
            armed,
            answer_da1: armed,
            cursor_reply: None,
            cursor_done: false,
            mode: Mode::Ground,
            consumed: 0,
            held: Vec::new(),
        }
    }

    /// Also answer the startup cursor-position query with `row` (see the module doc).
    /// Arms the filter even when DA1 answering is off: a pseudoconsole created with
    /// `PSEUDOCONSOLE_INHERIT_CURSOR` WILL ask, and the child does not start until it is
    /// answered (or, on the bundled ConPTY, until the DA1 behind it times out).
    pub fn with_cursor_row(mut self, row: Option<u16>) -> Self {
        if let Some(row) = row {
            self.cursor_reply = Some(cursor_report(row));
            self.armed = true;
        }
        self
    }

    /// Armed only when the bundled (modern) ConPTY has been loaded — the inbox ConPTY
    /// never asks, so arming there could only ever eat a child's query. "Loaded" is
    /// `portable-pty`'s backend only provided `conpty::init_for_current_exe` (or `init_conpty`)
    /// ran before the process's first `openpty` (`portable-pty` resolves its function table
    /// once); both production entry points (host `main`, fallback `spawn`) do that.
    pub fn for_platform() -> Self {
        #[cfg(windows)]
        {
            Self::new(crate::conpty::is_bundled_active())
        }
        #[cfg(not(windows))]
        {
            Self::new(false)
        }
    }

    /// [`Self::for_platform`] for a session whose pseudoconsole was (or was not) created
    /// inheriting the cursor: `cursor_row` is `Some` exactly when it was.
    pub fn for_spawn(cursor_row: Option<u16>) -> Self {
        Self::for_platform().with_cursor_row(cursor_row)
    }

    pub fn is_armed(&self) -> bool {
        self.armed
    }

    /// Filter one raw read. Never loses or reorders a byte other than the
    /// startup DA1 (and, when configured, the startup cursor query) itself; held
    /// bytes are released in order.
    pub fn filter<'a>(&mut self, chunk: &'a [u8]) -> Filtered<'a> {
        if !self.armed {
            return Filtered {
                bytes: Cow::Borrowed(chunk),
                answered: false,
                cursor_answered: false,
                reply: Vec::new(),
                consumed: self.consumed,
            };
        }
        let mut out: Vec<u8> = Vec::with_capacity(chunk.len() + self.held.len());
        let mut reply: Vec<u8> = Vec::new();
        let mut answered = false;
        let mut cursor_answered = false;
        for (i, &b) in chunk.iter().enumerate() {
            let before = self.consumed;
            self.consumed += 1;
            match self.mode {
                Mode::Ground => {
                    if before >= BUDGET || b != ESC {
                        self.retire(&mut out, &chunk[i..]);
                        break;
                    }
                    self.held.push(b);
                    self.mode = Mode::Esc;
                }
                Mode::Esc => {
                    if b != b'[' {
                        self.retire(&mut out, &chunk[i..]);
                        break;
                    }
                    self.held.push(b);
                    self.mode = Mode::Csi;
                }
                Mode::Csi => match b {
                    // Parameter (0x30..=0x3F) and intermediate (0x20..=0x2F) bytes.
                    0x20..=0x3F => {
                        if self.held.len() >= MAX_SEQ {
                            self.retire(&mut out, &chunk[i..]);
                            break;
                        }
                        self.held.push(b);
                    }
                    0x40..=0x7e => {
                        let params = &self.held[2..];
                        let is_da1 = b == b'c' && (params.is_empty() || params == b"0");
                        let is_cursor_query = b == b'n' && params == b"6";
                        if is_da1 && self.answer_da1 {
                            // The startup DA1: drop it, answer once, retire for good.
                            self.held.clear();
                            self.armed = false;
                            self.mode = Mode::Ground;
                            out.extend_from_slice(&chunk[i + 1..]);
                            reply.extend_from_slice(DA1_REPLY);
                            answered = true;
                            break;
                        } else if is_cursor_query && !self.cursor_done && self.cursor_reply.is_some() {
                            // The startup cursor query of an INHERIT_CURSOR pseudoconsole: drop
                            // it, answer it once, and stay armed — the DA1 comes right behind.
                            self.held.clear();
                            self.mode = Mode::Ground;
                            self.cursor_done = true;
                            if let Some(report) = &self.cursor_reply {
                                reply.extend_from_slice(report);
                            }
                            cursor_answered = true;
                        } else if matches!(b, b't' | b'h' | b'l') {
                            // Another preamble sequence: forward it and stay armed.
                            self.held.push(b);
                            out.append(&mut self.held);
                            self.mode = Mode::Ground;
                        } else {
                            self.retire(&mut out, &chunk[i..]);
                            break;
                        }
                    }
                    _ => {
                        self.retire(&mut out, &chunk[i..]);
                        break;
                    }
                },
            }
        }
        Filtered { bytes: Cow::Owned(out), answered, cursor_answered, reply, consumed: self.consumed }
    }

    /// Stream ended (EOF or read error): release anything still held, in order.
    /// Idempotent.
    pub fn finish(&mut self) -> Vec<u8> {
        self.armed = false;
        self.mode = Mode::Ground;
        std::mem::take(&mut self.held)
    }

    /// Stop filtering: emit what was held, then the rest of the chunk verbatim.
    fn retire(&mut self, out: &mut Vec<u8>, rest: &[u8]) {
        out.append(&mut self.held);
        out.extend_from_slice(rest);
        self.armed = false;
        self.mode = Mode::Ground;
    }
}

/// Write `bytes` under the writer mutex (poison-tolerant: a panicked input
/// writer must not turn into a 3 s stall).
pub fn write_reply(writer: &Mutex<Box<dyn Write + Send>>, bytes: &[u8]) -> std::io::Result<()> {
    let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
    w.write_all(bytes)?;
    w.flush()
}

/// [`write_reply`] for the DA1 answer.
pub fn write_da1_reply(writer: &Mutex<Box<dyn Write + Send>>) -> std::io::Result<()> {
    write_reply(writer, DA1_REPLY)
}

/// One batch of replies that [`StartupDa1::filter`] made due, as the shared pump hands it
/// to its caller.
#[derive(Debug, Clone, Copy)]
pub struct StartupReply<'a> {
    /// What to write, in query order (cursor report, then DA1).
    pub bytes: &'a [u8],
    /// `bytes` starts with the cursor-position report.
    pub cursor: bool,
    /// `bytes` ends with the DA1 reply.
    pub da1: bool,
    /// Raw bytes consumed so far, for diagnostics.
    pub consumed: usize,
}

impl StartupReply<'_> {
    fn what(&self) -> &'static str {
        match (self.cursor, self.da1) {
            (true, true) => "cursor report + DA1",
            (true, false) => "cursor report",
            _ => "DA1",
        }
    }
}

/// Hands out write turns so replies reach the PTY in the order they were requested even
/// though each is written from its own thread.
#[derive(Debug, Default)]
struct Turns {
    next: Mutex<u64>,
    /// Set when a reply could not be started at all (no thread): its turn will never be taken,
    /// so nothing may wait for it.
    abandoned: AtomicBool,
    cv: Condvar,
}

impl Turns {
    fn wait(&self, n: u64) {
        let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
        while *next != n && !self.abandoned.load(Ordering::Acquire) {
            next = self.cv.wait(next).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// A turn will never be taken: release everything waiting behind it.
    fn abandon(&self) {
        self.abandoned.store(true, Ordering::Release);
        // Take the lock before notifying so a waiter either sees the flag or is woken.
        let _next = self.next.lock().unwrap_or_else(|e| e.into_inner());
        self.cv.notify_all();
    }

    fn done(&self) {
        *self.next.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        self.cv.notify_all();
    }
}

/// Ends the turn when dropped, so a panic while writing cannot park every later reply.
struct EndTurn<'a>(&'a Turns);
impl Drop for EndTurn<'_> {
    fn drop(&mut self) {
        self.0.done();
    }
}

/// The startup replies of ONE session, written strictly in the order they were sent.
///
/// A reply is written from a short-lived thread so the reader never blocks on the writer
/// mutex (an input write can hold it through an unbounded `WriteFile`; output keeps
/// draining while the reply waits its turn). With two possible replies — the cursor
/// report and then DA1 — separate threads could otherwise race, and a DA1 that lands
/// first makes ConPTY settle for row 1. At most two threads per session, because the
/// filter retires on the first DA1 and answers the cursor query once. A reply that cannot get
/// a thread is dropped and logged, never written on the caller's thread (see `send_with`).
pub struct StartupReplies {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    label: String,
    turns: Arc<Turns>,
    issued: u64,
}

impl StartupReplies {
    pub fn new(writer: Arc<Mutex<Box<dyn Write + Send>>>, label: String) -> Self {
        Self { writer, label, turns: Arc::new(Turns::default()), issued: 0 }
    }

    /// Queue `reply` behind everything sent before it. Never blocks on the writer.
    pub fn send(&mut self, reply: StartupReply<'_>) {
        self.send_with(reply, spawn_startup_reply);
    }

    /// [`Self::send`] with the thread start spelled out, so a test can make it fail or hold it.
    ///
    /// When `spawn` fails the reply is DROPPED, not written inline: this runs on the output
    /// reader, and an input write can hold the writer mutex through an unbounded `WriteFile`,
    /// so waiting for the mutex here could stop output from draining. (The one-shot DA1 sender
    /// this replaced did the same: log and carry on, and ConPTY falls back to its own defaults
    /// or its ~3 s handshake timeout.) The turn is abandoned so a reply behind it does not wait
    /// for a write that will never happen.
    fn send_with(
        &mut self,
        reply: StartupReply<'_>,
        spawn: impl FnOnce(Box<dyn FnOnce() + Send + 'static>) -> std::io::Result<()>,
    ) {
        let turn = self.issued;
        self.issued += 1;
        let (what, consumed) = (reply.what(), reply.consumed);
        let bytes = reply.bytes.to_vec();
        let run = {
            let (writer, label, turns) = (self.writer.clone(), self.label.clone(), self.turns.clone());
            move || {
                turns.wait(turn);
                let _end = EndTurn(&turns);
                match write_reply(&writer, &bytes) {
                    Ok(()) => log::info!("[CONPTY] answered startup {what} for {label} ({consumed} bytes in)"),
                    Err(e) => log::warn!(
                        "[CONPTY] could not answer startup {what} for {label}: {e}; the shell will start \
                         only after ConPTY's ~3 s handshake timeout"
                    ),
                }
            }
        };
        if let Err(e) = spawn(Box::new(run)) {
            log::warn!(
                "[CONPTY] could not start the startup {what} reply thread for {}: {e}; dropping it \
                 (ConPTY falls back to its own defaults or its ~3 s handshake timeout)",
                self.label
            );
            self.turns.abandon();
        }
    }
}

/// The production thread start of [`StartupReplies`]: one short-lived named thread per reply.
fn spawn_startup_reply(run: Box<dyn FnOnce() + Send + 'static>) -> std::io::Result<()> {
    std::thread::Builder::new().name("startup-reply".into()).spawn(run).map(drop)
}

/// Send the reply from a one-shot thread so the reader never blocks on the writer
/// mutex (an input write can hold it through an unbounded `WriteFile`); output
/// keeps draining while the reply waits its turn. Bounded: at most one thread per
/// session, because the filter retires on the first DA1.
pub fn send_da1_reply(writer: Arc<Mutex<Box<dyn Write + Send>>>, label: String, consumed: usize) {
    let spawned = std::thread::Builder::new().name("da1-reply".into()).spawn({
        let label = label.clone();
        move || match write_da1_reply(&writer) {
            Ok(()) => log::info!("[CONPTY] answered startup DA1 for {label} ({consumed} bytes in)"),
            Err(e) => log::warn!(
                "[CONPTY] could not answer startup DA1 for {label}: {e}; the shell will start \
                 only after ConPTY's ~3 s handshake timeout"
            ),
        }
    });
    if let Err(e) = spawned {
        log::warn!("[CONPTY] could not start the DA1 reply thread for {label}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    /// The measured ConPTY 1.24 preamble: 4 + 3 + 8 + 8 = 23 bytes.
    const PREAMBLE: &[u8] = b"\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h";
    const PREAMBLE_WITHOUT_QUERY: &[u8] = b"\x1b[1t\x1b[?1004h\x1b[?9001h";

    /// Feed `stream` cut at `cuts` (sorted, exclusive positions) through a fresh
    /// armed filter; returns (forwarded bytes after `finish`, replies requested).
    fn run(stream: &[u8], cuts: &[usize]) -> (Vec<u8>, usize) {
        let mut f = StartupDa1::new(true);
        let (mut out, mut replies, mut start) = (Vec::new(), 0, 0);
        for &end in cuts.iter().chain(std::iter::once(&stream.len())) {
            let r = f.filter(&stream[start..end]);
            out.extend_from_slice(&r.bytes);
            replies += usize::from(r.answered);
            start = end;
        }
        out.extend_from_slice(&f.finish());
        (out, replies)
    }

    /// Every way to cut `stream` into 1, 2 and 3 pieces, plus byte-at-a-time.
    fn chunkings(len: usize) -> Vec<Vec<usize>> {
        let mut v: Vec<Vec<usize>> = vec![vec![]];
        for a in 1..len {
            v.push(vec![a]);
        }
        // 3-way: exhaustive for short streams, sampled (stride) for long ones.
        let stride = if len > 64 { 7 } else { 1 };
        for a in (1..len).step_by(stride) {
            for b in (a + 1..len).step_by(stride) {
                v.push(vec![a, b]);
            }
        }
        v.push((1..len).collect());
        v
    }

    fn assert_chunking_independent(stream: &[u8], want_out: &[u8], want_replies: usize) {
        for cuts in chunkings(stream.len()) {
            let (out, replies) = run(stream, &cuts);
            assert_eq!(out, want_out, "forwarded bytes differ for cuts {cuts:?}");
            assert_eq!(replies, want_replies, "reply count differs for cuts {cuts:?}");
        }
    }

    #[test]
    fn preamble_is_answered_and_stripped_for_every_chunking() {
        assert_eq!(PREAMBLE.len(), 23);
        assert_chunking_independent(PREAMBLE, PREAMBLE_WITHOUT_QUERY, 1);
    }

    #[test]
    fn forwarded_bytes_equal_input_minus_the_query() {
        // Child output right behind the preamble, and a query-free control.
        let mut stream = PREAMBLE.to_vec();
        stream.extend_from_slice("Microsoft Windows [Version 10]\r\n(c) é ✓\r\n".as_bytes());
        let mut want = PREAMBLE_WITHOUT_QUERY.to_vec();
        want.extend_from_slice("Microsoft Windows [Version 10]\r\n(c) é ✓\r\n".as_bytes());
        assert_chunking_independent(&stream, &want, 1);

        let quiet = b"\x1b[?1004h\x1b[?9001h hello";
        assert_chunking_independent(quiet, quiet, 0);
    }

    #[test]
    fn every_accepted_final_and_intermediate_byte_is_forwarded_and_keeps_the_filter_armed() {
        // `l` (e.g. DECTCEM hide, `ESC[?25l`) and an intermediate byte (`ESC[1 t`) sit in the
        // preamble context; the query behind them must still be answered and only it stripped.
        for before in [&b"\x1b[?1004h"[..], b"\x1b[?25l", b"\x1b[1t", b"\x1b[1 t"] {
            let stream = [before, b"\x1b[c", b"\x1b[?9001h"].concat();
            assert_chunking_independent(&stream, &[before, b"\x1b[?9001h"].concat(), 1);
        }
    }

    #[test]
    fn the_longest_held_sequence_is_accepted_and_one_byte_more_retires() {
        // MAX_SEQ = 16 held bytes: `ESC [` + 14 parameter bytes may be held, then the final.
        let seq = |params: usize| {
            let mut v = b"\x1b[".to_vec();
            v.extend(std::iter::repeat_n(b'1', params));
            v.push(b't');
            v
        };
        let ok = [seq(14), b"\x1b[c".to_vec(), b"x".to_vec()].concat();
        assert_chunking_independent(&ok, &[seq(14), b"x".to_vec()].concat(), 1);

        let too_long = [seq(15), b"\x1b[c".to_vec()].concat();
        assert_chunking_independent(&too_long, &too_long, 0);
    }

    #[test]
    fn zero_param_form_is_recognised_for_every_chunking() {
        let stream = b"\x1b[1t\x1b[0c\x1b[?9001h";
        assert_chunking_independent(stream, b"\x1b[1t\x1b[?9001h", 1);
    }

    /// A prefix of exactly `n` bytes made only of preamble-shaped sequences.
    fn preamble_prefix(n: usize) -> Vec<u8> {
        assert!(n >= 20);
        let mut v = Vec::new();
        for _ in 0..n % 4 {
            v.extend_from_slice(b"\x1b[?1h"); // 5 bytes: +1 (mod 4) each
        }
        while v.len() < n {
            v.extend_from_slice(b"\x1b[1t"); // 4 bytes
        }
        assert_eq!(v.len(), n);
        v
    }

    #[test]
    fn cap_is_applied_at_sequence_boundaries_only() {
        // The query STARTS at offset `start`; honoured iff start < 256, for every
        // chunking — including a read that straddles the whole budget (review F1).
        for start in 240..=268 {
            let mut stream = preamble_prefix(start);
            stream.extend_from_slice(b"\x1b[c\x1b[?9001h");
            let answered = start < BUDGET;
            let want: Vec<u8> = if answered {
                let mut w = preamble_prefix(start);
                w.extend_from_slice(b"\x1b[?9001h");
                w
            } else {
                stream.clone()
            };
            for cuts in chunkings(stream.len()) {
                let (out, replies) = run(&stream, &cuts);
                assert_eq!(out, want, "start {start}, cuts {cuts:?}");
                assert_eq!(replies, usize::from(answered), "start {start}, cuts {cuts:?}");
            }
        }
    }

    #[test]
    fn retires_on_text_other_csi_or_bad_escape() {
        let long_params = {
            let mut v = b"\x1b[".to_vec();
            v.extend(std::iter::repeat_n(b'1', 17));
            v.extend_from_slice(b"c");
            v
        };
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("text before the query", b"hello\x1b[c".to_vec()),
            ("clear screen first", b"\x1b[2J\x1b[c".to_vec()),
            ("DA2 is not DA1", b"\x1b[>c".to_vec()),
            ("private query", b"\x1b[?c".to_vec()),
            ("non-zero parameter", b"\x1b[1;2c".to_vec()),
            ("ESC ESC [ c", b"\x1b\x1b[c".to_vec()),
            ("ESC not followed by [", b"\x1b]0;title\x07\x1b[c".to_vec()),
            ("over-long parameter run", long_params),
            ("control byte inside CSI", b"\x1b[1\x07c".to_vec()),
        ];
        for (name, stream) in cases {
            assert_chunking_independent(&stream, &stream, 0);
            let mut f = StartupDa1::new(true);
            let _ = f.filter(&stream);
            assert!(!f.is_armed(), "{name}: filter must retire");
        }
    }

    #[test]
    fn after_the_handshake_every_later_da1_passes_through() {
        let mut stream = PREAMBLE.to_vec();
        stream.extend_from_slice(b"hi\x1b[c\x1b[0c\x1b[c");
        let mut want = PREAMBLE_WITHOUT_QUERY.to_vec();
        want.extend_from_slice(b"hi\x1b[c\x1b[0c\x1b[c");
        assert_chunking_independent(&stream, &want, 1);
    }

    #[test]
    fn finish_releases_held_bytes_once_in_order() {
        for held in [&b"\x1b"[..], b"\x1b[", b"\x1b[?10", b"\x1b[?1004"] {
            let mut f = StartupDa1::new(true);
            let r = f.filter(held);
            assert!(r.bytes.is_empty(), "{held:?} must be withheld");
            assert_eq!(f.finish(), held, "released verbatim");
            assert!(f.finish().is_empty(), "second finish is empty");
            assert!(!f.is_armed());
            assert_eq!(&*f.filter(b"\x1b[c").bytes, b"\x1b[c", "retired filter passes everything");
        }
    }

    #[test]
    fn disarmed_and_retired_filters_borrow_their_input() {
        let data = b"\x1b[c plain";
        let mut off = StartupDa1::new(false);
        let r = off.filter(data);
        assert!(matches!(r.bytes, Cow::Borrowed(_)) && !r.answered);
        assert_eq!(&*r.bytes, data);

        let mut done = StartupDa1::new(true);
        assert!(done.filter(PREAMBLE).answered);
        let hot = done.filter(data);
        assert!(matches!(hot.bytes, Cow::Borrowed(_)), "hot path must not copy");
        assert_eq!(&*hot.bytes, data, "and must hand back every byte");
    }

    // ---- reply writer -------------------------------------------------------

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);
    impl Write for Shared {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    fn boxed<W: Write + Send + 'static>(w: W) -> Mutex<Box<dyn Write + Send>> {
        Mutex::new(Box::new(w))
    }

    struct Trickle(Shared); // at most 2 bytes per write
    impl Write for Trickle {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.write(&b[..b.len().min(2)])
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    struct InterruptedOnce(Shared, bool);
    impl Write for InterruptedOnce {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            if !self.1 {
                self.1 = true;
                return Err(io::ErrorKind::Interrupted.into());
            }
            self.0.write(b)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    struct ZeroWriter;
    impl Write for ZeroWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Ok(0)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    struct PartialThenErr(Shared, bool);
    impl Write for PartialThenErr {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            if self.1 {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            self.1 = true;
            self.0.write(&b[..3])
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn write_da1_reply_handles_short_writes_and_errors() {
        let sink = Shared::default();
        write_da1_reply(&boxed(sink.clone())).unwrap();
        assert_eq!(*sink.0.lock().unwrap(), DA1_REPLY);

        let sink = Shared::default();
        write_da1_reply(&boxed(Trickle(sink.clone()))).unwrap();
        assert_eq!(*sink.0.lock().unwrap(), DA1_REPLY, "short writes are completed");

        let sink = Shared::default();
        write_da1_reply(&boxed(InterruptedOnce(sink.clone(), false))).unwrap();
        assert_eq!(*sink.0.lock().unwrap(), DA1_REPLY, "Interrupted is retried");

        assert_eq!(write_da1_reply(&boxed(ZeroWriter)).unwrap_err().kind(), io::ErrorKind::WriteZero);

        let sink = Shared::default();
        let err = write_da1_reply(&boxed(PartialThenErr(sink.clone(), false))).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
        assert_eq!(sink.0.lock().unwrap().len(), 3, "partial write then failure is reported, not hidden");
    }

    /// Bytes become visible in `visible` only when `flush` runs.
    struct FlushGated {
        staged: Vec<u8>,
        visible: Shared,
    }
    impl Write for FlushGated {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.staged.extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            self.visible.0.lock().unwrap().append(&mut self.staged);
            Ok(())
        }
    }
    struct FlushFails;
    impl Write for FlushFails {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
    }

    #[test]
    fn write_da1_reply_flushes_and_reports_a_failed_flush() {
        let visible = Shared::default();
        write_da1_reply(&boxed(FlushGated { staged: Vec::new(), visible: visible.clone() })).unwrap();
        assert_eq!(*visible.0.lock().unwrap(), DA1_REPLY, "the reply is not delivered until the writer is flushed");

        assert_eq!(write_da1_reply(&boxed(FlushFails)).unwrap_err().kind(), io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn write_da1_reply_survives_a_poisoned_writer_mutex() {
        let sink = Shared::default();
        let m = Arc::new(boxed(sink.clone()));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison the writer mutex");
        })
        .join();
        assert!(m.is_poisoned());
        write_da1_reply(&m).unwrap();
        assert_eq!(*sink.0.lock().unwrap(), DA1_REPLY);
    }

    #[test]
    fn send_da1_reply_does_not_block_the_caller_on_a_held_writer_lock() {
        let sink = Shared::default();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(boxed(sink.clone()));
        let guard = writer.lock().unwrap(); // an input write holding the mutex
        // Run the call behind a deadline the test controls: a synchronous implementation would
        // block here forever instead of failing the assertion below.
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let caller = {
            let writer = writer.clone();
            std::thread::spawn(move || {
                send_da1_reply(writer, "t".into(), 7);
                let _ = done_tx.send(());
            })
        };
        done_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("send_da1_reply must return while the writer lock is held elsewhere");
        caller.join().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(sink.0.lock().unwrap().is_empty(), "reply must wait for the writer lock");
        drop(guard);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while sink.0.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(*sink.0.lock().unwrap(), DA1_REPLY);
    }

    // ---- startup cursor report (INHERIT_CURSOR) ---------------------------------

    /// What the bundled ConPTY 1.24 sends when created with `PSEUDOCONSOLE_INHERIT_CURSOR`
    /// (measured): the cursor query sits BEFORE the DA1 query.
    const INHERIT_PREAMBLE: &[u8] = b"\x1b[1t\x1b[6n\x1b[c\x1b[?1004h\x1b[?9001h";
    const INHERIT_PREAMBLE_WITHOUT_QUERIES: &[u8] = b"\x1b[1t\x1b[?1004h\x1b[?9001h";

    /// Feed `stream` cut at `cuts` through `f`; returns (forwarded bytes after `finish`,
    /// every reply batch in the order the filter asked for it).
    fn run_with(mut f: StartupDa1, stream: &[u8], cuts: &[usize]) -> (Vec<u8>, Vec<Vec<u8>>) {
        let (mut out, mut replies, mut start) = (Vec::new(), Vec::new(), 0);
        for &end in cuts.iter().chain(std::iter::once(&stream.len())) {
            let r = f.filter(&stream[start..end]);
            out.extend_from_slice(&r.bytes);
            if !r.reply.is_empty() {
                replies.push(r.reply.clone());
            }
            start = end;
        }
        out.extend_from_slice(&f.finish());
        (out, replies)
    }

    fn inheriting(row: u16) -> StartupDa1 {
        StartupDa1::new(true).with_cursor_row(Some(row))
    }

    #[test]
    fn the_cursor_report_format_is_row_then_column_one() {
        assert_eq!(cursor_report(24), b"\x1b[24;1R");
        assert_eq!(cursor_report(1), b"\x1b[1;1R");
        assert_eq!(cursor_report(0), b"\x1b[1;1R", "a zero row is not a valid cursor position");
    }

    #[test]
    fn both_startup_queries_are_answered_stripped_and_ordered_for_every_chunking() {
        let want_replies = [cursor_report(24), DA1_REPLY.to_vec()].concat();
        for cuts in chunkings(INHERIT_PREAMBLE.len()) {
            let (out, replies) = run_with(inheriting(24), INHERIT_PREAMBLE, &cuts);
            assert_eq!(out, INHERIT_PREAMBLE_WITHOUT_QUERIES, "forwarded bytes for cuts {cuts:?}");
            assert_eq!(replies.concat(), want_replies, "the cursor report must come before DA1; cuts {cuts:?}");
            assert!(replies.len() <= 2, "at most one batch per query; cuts {cuts:?}");
        }
    }

    #[test]
    fn the_cursor_report_is_due_before_the_da1_has_even_arrived() {
        // ConPTY may hold the child on the cursor report alone; waiting for the DA1 behind it
        // would be a deadlock, so the reply is requested as soon as the query is complete.
        let mut f = inheriting(12);
        let r = f.filter(b"\x1b[1t\x1b[6n");
        assert_eq!(r.reply, cursor_report(12));
        assert!(r.cursor_answered && !r.answered);
        assert_eq!(&*r.bytes, b"\x1b[1t", "the query itself is not forwarded");
        assert!(f.is_armed(), "the DA1 is still to come");
        let r = f.filter(b"\x1b[c");
        assert_eq!(r.reply, DA1_REPLY);
        assert!(r.answered && !r.cursor_answered);
        assert!(!f.is_armed());
    }

    #[test]
    fn a_filter_without_a_cursor_row_leaves_the_cursor_query_to_the_renderer() {
        // The default for every spawn that did not ask ConPTY to inherit the cursor: an `ESC[6n`
        // in the preamble is just another CSI, so the filter retires and forwards it untouched.
        let stream = b"\x1b[1t\x1b[6n\x1b[c";
        for cuts in chunkings(stream.len()) {
            let (out, replies) = run_with(StartupDa1::new(true), stream, &cuts);
            assert_eq!(out, stream, "cuts {cuts:?}");
            assert!(replies.is_empty(), "nothing is answered, cuts {cuts:?}");
        }
    }

    #[test]
    fn only_the_first_cursor_query_is_answered() {
        let stream = b"\x1b[6n\x1b[6n\x1b[c";
        let (out, replies) = run_with(inheriting(9), stream, &[]);
        assert_eq!(out, b"\x1b[6n\x1b[c", "a second query belongs to the renderer and retires the filter");
        assert_eq!(replies.concat(), cursor_report(9));
    }

    #[test]
    fn a_cursor_query_after_text_is_a_childs_own_and_is_never_answered() {
        let stream = b"\x1b[1thello\x1b[6n";
        let (out, replies) = run_with(inheriting(9), stream, &[]);
        assert_eq!(out, stream);
        assert!(replies.is_empty());
    }

    #[test]
    fn only_the_plain_cursor_report_query_is_recognised() {
        for query in [&b"\x1b[5n"[..], b"\x1b[?6n", b"\x1b[6;1n", b"\x1b[n"] {
            let (out, replies) = run_with(inheriting(9), query, &[]);
            assert_eq!(out, query, "{query:?} must be forwarded");
            assert!(replies.is_empty(), "{query:?} must not be answered");
        }
    }

    #[test]
    fn a_cursor_only_filter_answers_the_cursor_query_and_hands_the_da1_to_the_renderer() {
        // An inbox ConPTY that was asked to inherit the cursor: DA1 is not ours to eat there.
        let f = StartupDa1::new(false).with_cursor_row(Some(7));
        assert!(f.is_armed(), "asking for the cursor must arm the filter by itself");
        let (out, replies) = run_with(f, INHERIT_PREAMBLE, &[]);
        assert_eq!(out, b"\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h", "DA1 stays in the stream");
        assert_eq!(replies.concat(), cursor_report(7));
    }

    #[test]
    fn no_cursor_row_means_exactly_the_old_filter() {
        // `None` must not disturb a disarmed filter either.
        let f = StartupDa1::new(false).with_cursor_row(None);
        assert!(!f.is_armed());
        let (out, replies) = run_with(f, INHERIT_PREAMBLE, &[]);
        assert_eq!(out, INHERIT_PREAMBLE);
        assert!(replies.is_empty());
    }

    // ---- ordered reply sender -----------------------------------------------------

    fn wait_for(sink: &Shared, len: usize) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while sink.0.lock().unwrap().len() < len && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    #[test]
    fn replies_reach_the_writer_in_the_order_they_were_sent() {
        // Two threads race for the writer mutex; the turn counter, not the scheduler, decides.
        // Repeated so a wrong implementation loses the race at least once.
        let cursor = cursor_report(24);
        for round in 0..200 {
            let sink = Shared::default();
            let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(boxed(sink.clone()));
            let mut replies = StartupReplies::new(writer, format!("round-{round}"));
            replies.send(StartupReply { bytes: &cursor, cursor: true, da1: false, consumed: 6 });
            replies.send(StartupReply { bytes: DA1_REPLY, cursor: false, da1: true, consumed: 9 });
            wait_for(&sink, cursor.len() + DA1_REPLY.len());
            assert_eq!(*sink.0.lock().unwrap(), [cursor.clone(), DA1_REPLY.to_vec()].concat(), "round {round}");
        }
    }

    #[test]
    fn sending_a_reply_never_blocks_the_reader_on_a_held_writer_lock() {
        let sink = Shared::default();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(boxed(sink.clone()));
        let guard = writer.lock().unwrap(); // an input write holding the mutex
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let caller = {
            let writer = writer.clone();
            std::thread::spawn(move || {
                let mut replies = StartupReplies::new(writer, "t".into());
                replies.send(StartupReply { bytes: b"\x1b[3;1R", cursor: true, da1: false, consumed: 4 });
                replies.send(StartupReply { bytes: DA1_REPLY, cursor: false, da1: true, consumed: 9 });
                let _ = done_tx.send(());
            })
        };
        done_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("send must return while the writer lock is held elsewhere");
        caller.join().unwrap();
        assert!(sink.0.lock().unwrap().is_empty(), "replies wait for the writer lock");
        drop(guard);
        wait_for(&sink, 6 + DA1_REPLY.len());
        assert_eq!(*sink.0.lock().unwrap(), [&b"\x1b[3;1R"[..], DA1_REPLY].concat());
    }

    #[test]
    fn a_failed_write_does_not_park_the_reply_behind_it() {
        struct FailsOnce(Shared, bool);
        impl Write for FailsOnce {
            fn write(&mut self, b: &[u8]) -> io::Result<usize> {
                if !self.1 {
                    self.1 = true;
                    return Err(io::ErrorKind::BrokenPipe.into());
                }
                self.0.write(b)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let sink = Shared::default();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(boxed(FailsOnce(sink.clone(), false)));
        let mut replies = StartupReplies::new(writer, "t".into());
        replies.send(StartupReply { bytes: b"\x1b[3;1R", cursor: true, da1: false, consumed: 4 });
        replies.send(StartupReply { bytes: DA1_REPLY, cursor: false, da1: true, consumed: 9 });
        wait_for(&sink, DA1_REPLY.len());
        assert_eq!(*sink.0.lock().unwrap(), DA1_REPLY, "the second reply still goes out");
    }

    /// `thread::Builder::spawn` failing, as it does when the OS has no thread to give.
    fn no_thread(_run: Box<dyn FnOnce() + Send + 'static>) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::WouldBlock, "no thread to give"))
    }

    #[test]
    fn a_reply_that_cannot_get_a_thread_is_dropped_never_written_on_the_readers_thread() {
        let sink = Shared::default();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(boxed(sink.clone()));
        let guard = writer.lock().unwrap(); // an input write holding the mutex through a slow WriteFile
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let caller = {
            let writer = writer.clone();
            std::thread::spawn(move || {
                let mut replies = StartupReplies::new(writer, "t".into());
                replies.send_with(StartupReply { bytes: b"\x1b[3;1R", cursor: true, da1: false, consumed: 4 }, no_thread);
                replies.send_with(StartupReply { bytes: DA1_REPLY, cursor: false, da1: true, consumed: 9 }, no_thread);
                let _ = done_tx.send(());
            })
        };
        done_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("a failed thread start must not wait on the writer lock (that would stall output)");
        caller.join().unwrap();
        drop(guard);
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(sink.0.lock().unwrap().is_empty(), "a dropped reply is never written inline");
    }

    #[test]
    fn a_dropped_reply_does_not_park_the_one_behind_it() {
        // The cursor report (turn 0) gets no thread; the DA1 reply (turn 1) starts normally and
        // must not wait for a write that is never going to happen.
        let sink = Shared::default();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(boxed(sink.clone()));
        let mut replies = StartupReplies::new(writer, "t".into());
        replies.send_with(StartupReply { bytes: b"\x1b[3;1R", cursor: true, da1: false, consumed: 4 }, no_thread);
        replies.send(StartupReply { bytes: DA1_REPLY, cursor: false, da1: true, consumed: 9 });
        wait_for(&sink, DA1_REPLY.len());
        assert_eq!(*sink.0.lock().unwrap(), DA1_REPLY);
    }

    #[test]
    fn a_later_reply_waits_for_the_earlier_one_even_when_its_thread_runs_first() {
        // The scheduler is taken out of the picture: both reply threads are captured, then the
        // SECOND is started alone. Without the turn barrier it writes straight away.
        type Run = Box<dyn FnOnce() + Send + 'static>;
        let captured = Arc::new(Mutex::new(Vec::<Run>::new()));
        let capture = |captured: &Arc<Mutex<Vec<Run>>>| {
            let captured = captured.clone();
            move |run: Run| -> io::Result<()> {
                captured.lock().unwrap().push(run);
                Ok(())
            }
        };
        let sink = Shared::default();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(boxed(sink.clone()));
        let mut replies = StartupReplies::new(writer, "t".into());
        replies.send_with(StartupReply { bytes: b"\x1b[3;1R", cursor: true, da1: false, consumed: 4 }, capture(&captured));
        replies.send_with(StartupReply { bytes: DA1_REPLY, cursor: false, da1: true, consumed: 9 }, capture(&captured));
        let mut runs = std::mem::take(&mut *captured.lock().unwrap());
        assert_eq!(runs.len(), 2, "one thread start per reply");
        let (first, second) = (runs.remove(0), runs.remove(0));

        let t_second = std::thread::spawn(second);
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(sink.0.lock().unwrap().is_empty(), "the DA1 reply must not reach the writer ahead of the cursor report");

        let t_first = std::thread::spawn(first);
        t_first.join().unwrap();
        t_second.join().unwrap();
        assert_eq!(*sink.0.lock().unwrap(), [&b"\x1b[3;1R"[..], DA1_REPLY].concat());
    }
}
