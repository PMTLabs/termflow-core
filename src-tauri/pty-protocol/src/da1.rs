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
//! complete CSI sequences whose final byte is `t`, `h` or `l`. The first DA1
//! met inside that context is answered and stripped; the first byte that is not
//! part of such a sequence (child text, another CSI, a stray `ESC`) retires the
//! filter untouched, so a child's own DA1 can never be eaten. The result depends
//! only on the byte stream, never on how `read()` happened to chunk it.

use std::borrow::Cow;
use std::io::Write;
use std::sync::{Arc, Mutex};

/// What xterm.js itself answers to DA1 (`InputHandler.ts` for `termName: xterm`):
/// a VT100 with the advanced video option.
pub const DA1_REPLY: &[u8] = b"\x1b[?1;2c";

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
    /// Raw bytes consumed so far, for diagnostics.
    pub consumed: usize,
}

/// The startup-handshake filter. One per session, owned by the reader thread.
#[derive(Debug)]
pub struct StartupDa1 {
    armed: bool,
    mode: Mode,
    consumed: usize,
    /// Bytes of the in-progress sequence, withheld until it resolves.
    held: Vec<u8>,
}

impl StartupDa1 {
    pub fn new(armed: bool) -> Self {
        Self { armed, mode: Mode::Ground, consumed: 0, held: Vec::new() }
    }

    /// Armed only when the bundled (modern) ConPTY is what `portable-pty` will use —
    /// the inbox ConPTY never asks, so arming there could only ever eat a child's query.
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

    pub fn is_armed(&self) -> bool {
        self.armed
    }

    /// Filter one raw read. Never loses or reorders a byte other than the
    /// startup DA1 itself; held bytes are released in order.
    pub fn filter<'a>(&mut self, chunk: &'a [u8]) -> Filtered<'a> {
        if !self.armed {
            return Filtered { bytes: Cow::Borrowed(chunk), answered: false, consumed: self.consumed };
        }
        let mut out: Vec<u8> = Vec::with_capacity(chunk.len() + self.held.len());
        let mut answered = false;
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
                        if b == b'c' && (params.is_empty() || params == b"0") {
                            // The startup DA1: drop it, answer once, retire for good.
                            self.held.clear();
                            self.armed = false;
                            self.mode = Mode::Ground;
                            out.extend_from_slice(&chunk[i + 1..]);
                            answered = true;
                            break;
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
        Filtered { bytes: Cow::Owned(out), answered, consumed: self.consumed }
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

/// Write the reply under the writer mutex (poison-tolerant: a panicked input
/// writer must not turn into a 3 s stall).
pub fn write_da1_reply(writer: &Mutex<Box<dyn Write + Send>>) -> std::io::Result<()> {
    let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
    w.write_all(DA1_REPLY)?;
    w.flush()
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
        assert!(matches!(done.filter(data).bytes, Cow::Borrowed(_)), "hot path must not copy");
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
        let t0 = std::time::Instant::now();
        send_da1_reply(writer.clone(), "t".into(), 7);
        assert!(t0.elapsed() < std::time::Duration::from_millis(500), "caller must not wait for the lock");
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(sink.0.lock().unwrap().is_empty(), "reply must wait for the writer lock");
        drop(guard);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while sink.0.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(*sink.0.lock().unwrap(), DA1_REPLY);
    }
}
