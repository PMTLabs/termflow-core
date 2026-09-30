//! The one PTY read loop both output readers run (plan 050).
//!
//! The pty-host session reader and the in-process fallback reader used to carry
//! two copies of "read → UTF-8 carry → forward". Sharing the loop is what lets the
//! startup DA1 filter ([`crate::da1`]) be applied identically on both paths and be
//! tested without a real pseudoconsole: the only per-caller parts are the UTF-8
//! boundary function (each crate already has its own, unchanged), what `emit` does
//! with a finished chunk, and what happens when the handshake is answered.

use crate::da1::StartupDa1;
use std::io::Read;

/// How the stream ended.
#[derive(Debug, PartialEq, Eq)]
pub enum PumpEnd {
    Eof,
    Err(std::io::ErrorKind),
}

/// Read `reader` to the end, forwarding chunks through `emit`.
///
/// Per read: run the startup filter, prepend the carried partial UTF-8 scalar,
/// split at `boundary`, `emit` the complete part (never an empty one) and carry the
/// rest. On EOF **or error** the ordered tail `carried ++ held-by-the-filter` is
/// emitted through the same `emit`, so a chunk boundary can never reorder or drop
/// the last bytes.
///
/// `on_answered(consumed)` fires exactly once, when the startup DA1 has been removed
/// from the stream; the caller must then send [`crate::da1::DA1_REPLY`] to the PTY.
pub fn pump_output<R: Read>(
    reader: &mut R,
    boundary: fn(&[u8]) -> usize,
    da1: &mut StartupDa1,
    mut on_answered: impl FnMut(usize),
    mut emit: impl FnMut(Vec<u8>),
) -> PumpEnd {
    let mut buf = [0u8; 4096];
    let mut pending: Vec<u8> = Vec::new();
    let end = loop {
        match reader.read(&mut buf) {
            Ok(0) => break PumpEnd::Eof,
            Ok(n) => {
                let was_armed = da1.is_armed();
                let filtered = da1.filter(&buf[..n]);
                if filtered.answered {
                    on_answered(filtered.consumed);
                } else if was_armed && !da1.is_armed() {
                    log::debug!(
                        "[CONPTY] startup DA1 filter retired after {} bytes without seeing a query",
                        filtered.consumed
                    );
                }
                let mut data = if pending.is_empty() {
                    filtered.bytes.into_owned()
                } else {
                    let mut combined = std::mem::take(&mut pending);
                    combined.extend_from_slice(&filtered.bytes);
                    combined
                };
                let valid_end = boundary(&data);
                if valid_end < data.len() {
                    pending = data[valid_end..].to_vec();
                    data.truncate(valid_end);
                }
                if !data.is_empty() {
                    emit(data);
                }
            }
            Err(e) => break PumpEnd::Err(e.kind()),
        }
    };
    let mut tail = pending;
    tail.extend_from_slice(&da1.finish());
    if !tail.is_empty() {
        emit(tail);
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    /// Same contract as the host's `find_utf8_boundary`: carry only an incomplete trailing scalar.
    fn boundary(data: &[u8]) -> usize {
        match std::str::from_utf8(data) {
            Ok(_) => data.len(),
            Err(e) => match e.error_len() {
                None => e.valid_up_to(),
                Some(_) => data.len(),
            },
        }
    }

    /// A reader that yields scripted results, one per `read`.
    struct Script(std::collections::VecDeque<io::Result<Vec<u8>>>);
    impl Script {
        fn ok(chunks: &[&[u8]]) -> Self {
            Script(chunks.iter().map(|c| Ok(c.to_vec())).collect())
        }
        fn then_err(mut self, kind: io::ErrorKind) -> Self {
            self.0.push_back(Err(kind.into()));
            self
        }
    }
    impl Read for Script {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            match self.0.pop_front() {
                None => Ok(0),
                Some(Err(e)) => Err(e),
                Some(Ok(v)) => {
                    out[..v.len()].copy_from_slice(&v);
                    Ok(v.len())
                }
            }
        }
    }

    struct Run {
        emitted: Vec<Vec<u8>>,
        answered_at: Vec<usize>,
        end: PumpEnd,
    }
    impl Run {
        fn bytes(&self) -> Vec<u8> {
            self.emitted.concat()
        }
        /// Each emitted payload is decoded on its own downstream (`output_pipeline` runs
        /// `from_utf8_lossy` per payload), so a scalar split across two payloads is corrupted
        /// even when the concatenation is right.
        fn assert_every_chunk_is_valid_utf8(&self) {
            for (i, c) in self.emitted.iter().enumerate() {
                assert!(std::str::from_utf8(c).is_ok(), "emitted chunk {i} is not valid UTF-8 on its own: {c:?}");
            }
        }
    }
    fn run(mut r: Script, armed: bool) -> Run {
        let mut da1 = StartupDa1::new(armed);
        let (mut emitted, mut answered_at) = (Vec::new(), Vec::new());
        let end = pump_output(&mut r, boundary, &mut da1, |c| answered_at.push(c), |d| emitted.push(d));
        Run { emitted, answered_at, end }
    }

    const PRE: &[u8] = b"\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h";
    const PRE_STRIPPED: &[u8] = b"\x1b[1t\x1b[?1004h\x1b[?9001h";

    #[test]
    fn armed_pump_emits_the_exact_stream_and_one_answer() {
        let r = run(Script::ok(&[b"\x1b[1t", b"\x1b[c\x1b[?1004h\x1b[?9001h", b"Microsoft Windows\r\n"]), true);
        let mut want = PRE_STRIPPED.to_vec();
        want.extend_from_slice(b"Microsoft Windows\r\n");
        assert_eq!(r.bytes(), want);
        assert_eq!(r.answered_at, vec![4 + 3], "answered once, after the 7 bytes that contain the query");
        assert_eq!(r.end, PumpEnd::Eof);
        assert!(r.emitted.iter().all(|c| !c.is_empty()), "never emits an empty chunk");
    }

    #[test]
    fn the_query_split_across_reads_is_still_removed() {
        let r = run(Script::ok(&[b"\x1b", b"[", b"c", b"\x1b[?9001h"]), true);
        assert_eq!(r.bytes(), b"\x1b[?9001h");
        assert_eq!(r.answered_at, vec![3], "consumed = the three query bytes seen so far");
    }

    #[test]
    fn disarmed_pump_is_the_identity() {
        let r = run(Script::ok(&[PRE, b"text"]), false);
        assert_eq!(r.bytes(), [PRE, &b"text"[..]].concat());
        assert!(r.answered_at.is_empty());
    }

    #[test]
    fn a_utf8_scalar_split_across_reads_is_reassembled_alongside_the_preamble() {
        let euro = "€".as_bytes(); // E2 82 AC
        let r = run(Script::ok(&[&[PRE, &euro[..2]].concat(), &euro[2..], b"!"]), true);
        assert_eq!(r.bytes(), [PRE_STRIPPED, euro, b"!"].concat());
        r.assert_every_chunk_is_valid_utf8();
        assert!(
            r.emitted.iter().any(|c| c.starts_with(euro)),
            "the scalar is emitted whole, at the start of the chunk that completes it: {:?}",
            r.emitted
        );
        assert_eq!(String::from_utf8(r.bytes()).unwrap().chars().last(), Some('!'));
        assert_eq!(r.answered_at.len(), 1);
    }

    #[test]
    fn eof_tail_is_the_carried_scalar_then_the_held_filter_bytes_in_order() {
        // The two tail sources can never both be non-empty: the filter holds bytes only inside
        // ASCII preamble context, and a partial UTF-8 scalar means it already retired. The pump
        // still orders `carried ++ held`, so each source is checked on its own here.
        //
        // (1) Partial scalar carried by the pump at EOF (filter retired on the text).
        let euro = "€".as_bytes();
        let mut da1 = StartupDa1::new(true);
        let mut r = Script::ok(&[&[b"hi", &euro[..2]].concat()]);
        let mut emitted: Vec<Vec<u8>> = Vec::new();
        let end = pump_output(&mut r, boundary, &mut da1, |_| {}, |d| emitted.push(d));
        assert_eq!(end, PumpEnd::Eof);
        assert_eq!(emitted.concat(), [&b"hi"[..], &euro[..2]].concat(), "partial scalar is flushed, not lost");
        assert_eq!(emitted, vec![b"hi".to_vec(), euro[..2].to_vec()], "the carried scalar is the final, separate tail emit");

        // (2) Bytes held by the filter at EOF (an unfinished preamble sequence).
        let mut r = Script::ok(&[b"\x1b[1t", b"\x1b"]);
        let mut da1 = StartupDa1::new(true);
        let mut emitted: Vec<Vec<u8>> = Vec::new();
        pump_output(&mut r, boundary, &mut da1, |_| {}, |d| emitted.push(d));
        assert_eq!(emitted.concat(), b"\x1b[1t\x1b", "held ESC released after the forwarded sequence");
        assert_eq!(emitted.last().unwrap(), b"\x1b", "the held ESC is the final tail emit");
    }

    #[test]
    fn a_read_error_flushes_the_tail_exactly_like_eof() {
        let euro = "€".as_bytes();
        let r = run(Script::ok(&[&[PRE, &euro[..1]].concat()]).then_err(io::ErrorKind::BrokenPipe), true);
        assert_eq!(r.end, PumpEnd::Err(io::ErrorKind::BrokenPipe));
        assert_eq!(r.bytes(), [PRE_STRIPPED, &euro[..1]].concat());
        assert_eq!(r.emitted.last().unwrap(), &euro[..1], "the carried byte is the final tail emit, not forwarded mid-read");

        // A read error while the filter still holds an unfinished escape: `finish()` must run on
        // the error path too (the case above has already retired the filter).
        let r = run(Script::ok(&[b"\x1b[1t", b"\x1b[?10"]).then_err(io::ErrorKind::BrokenPipe), true);
        assert_eq!(r.end, PumpEnd::Err(io::ErrorKind::BrokenPipe));
        assert_eq!(r.bytes(), b"\x1b[1t\x1b[?10", "bytes held by the filter are released on error");
        assert_eq!(r.emitted.last().unwrap(), b"\x1b[?10");
    }

    #[test]
    fn an_answer_fires_exactly_once_even_with_later_queries() {
        let r = run(Script::ok(&[PRE, b"\x1b[c", b"\x1b[0c"]), true);
        assert_eq!(r.answered_at, vec![7], "one answer, at the offset where the query ended");
        assert_eq!(r.bytes(), [PRE_STRIPPED, &b"\x1b[c\x1b[0c"[..]].concat(), "later queries are the frontend's");
    }

    #[test]
    fn a_chunk_that_is_only_the_query_emits_nothing() {
        let r = run(Script::ok(&[b"\x1b[c"]), true);
        assert!(r.emitted.is_empty());
        assert_eq!(r.answered_at, vec![3]);
    }
}
