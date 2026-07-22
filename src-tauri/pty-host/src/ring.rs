//! Bounded, offset-tracked replay buffer.
//!
//! The ring is the SINGLE source of truth for a session's output while the GUI
//! is detached — there is deliberately no second unbounded live buffer, so a
//! busy shell during a hot-swap cannot grow memory without bound.
//!
//! Every byte ever written has a monotonically increasing absolute offset.
//! `head` is the offset of the oldest byte still retained; `tail` is the offset
//! one past the newest byte (== total bytes ever produced). A reattaching GUI
//! asks for bytes "from offset N"; if N is older than `head`, the gap is
//! reported so the GUI can force a repaint heal instead of trusting a snapshot
//! that starts mid-escape-sequence.

use std::collections::VecDeque;

pub struct ReplayRing {
    cap: usize,
    buf: VecDeque<u8>,
    /// Absolute offset of `buf.front()` (oldest retained byte).
    head: u64,
    /// Absolute offset one past `buf.back()` (== total bytes ever pushed).
    tail: u64,
}

/// Result of a replay request.
pub struct Snapshot {
    /// Absolute offset of `bytes[0]`.
    pub start_offset: u64,
    pub bytes: Vec<u8>,
    /// True if the requested offset was older than what the ring still holds
    /// (bytes were evicted) — the caller should heal by forcing a repaint.
    pub gap: bool,
}

impl ReplayRing {
    pub fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            buf: VecDeque::new(),
            head: 0,
            tail: 0,
        }
    }

    /// Append output, evicting oldest bytes to stay within `cap`.
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend(bytes.iter().copied());
        self.tail += bytes.len() as u64;
        while self.buf.len() > self.cap {
            self.buf.pop_front();
            self.head += 1;
        }
    }

    pub fn head(&self) -> u64 {
        self.head
    }

    pub fn tail(&self) -> u64 {
        self.tail
    }

    /// Return retained bytes from `clamp(offset, head..=tail)` to `tail`. `gap`
    /// is true when `offset < head` (requested bytes were already evicted).
    /// A future `offset > tail` (should not happen) is clamped to `tail`,
    /// yielding an empty snapshot rather than an out-of-range start or a
    /// truncated `usize` index on 32-bit targets.
    pub fn snapshot_from(&self, offset: u64) -> Snapshot {
        let gap = offset < self.head;
        let start = offset.clamp(self.head, self.tail);
        // Index into the deque for `start` (bounded by buf.len()).
        let skip = (start - self.head) as usize;
        let bytes: Vec<u8> = self.buf.iter().copied().skip(skip).collect();
        Snapshot {
            start_offset: start,
            bytes,
            gap,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_only_last_cap_bytes_and_tracks_offsets() {
        let mut r = ReplayRing::new(4);
        r.push(b"ab"); // offsets 0,1 ; tail=2
        r.push(b"cdef"); // total "abcdef" -> cap 4 keeps "cdef", head=2, tail=6
        assert_eq!(r.head(), 2);
        assert_eq!(r.tail(), 6);
        let snap = r.snapshot_from(0);
        assert!(snap.gap, "offset 0 was evicted");
        assert_eq!(snap.start_offset, 2);
        assert_eq!(snap.bytes, b"cdef".to_vec());
    }

    #[test]
    fn ring_under_cap_keeps_all_no_gap() {
        let mut r = ReplayRing::new(8);
        r.push(b"xy");
        r.push(b"z");
        assert_eq!(r.head(), 0);
        assert_eq!(r.tail(), 3);
        let snap = r.snapshot_from(0);
        assert!(!snap.gap);
        assert_eq!(snap.start_offset, 0);
        assert_eq!(snap.bytes, b"xyz".to_vec());
    }

    #[test]
    fn snapshot_from_midpoint_returns_suffix() {
        let mut r = ReplayRing::new(16);
        r.push(b"hello world");
        let snap = r.snapshot_from(6); // from 'w'
        assert!(!snap.gap);
        assert_eq!(snap.start_offset, 6);
        assert_eq!(snap.bytes, b"world".to_vec());
    }

    #[test]
    fn snapshot_from_future_offset_clamps_to_tail() {
        let mut r = ReplayRing::new(16);
        r.push(b"abc"); // tail = 3
        let snap = r.snapshot_from(99); // beyond tail
        assert!(!snap.gap);
        assert_eq!(snap.start_offset, 3);
        assert!(snap.bytes.is_empty());
    }
}
