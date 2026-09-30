//! Lifecycle of one wired connection: who decided it ended, and when the
//! underlying stream was really released.
//!
//! `tokio::io::split` halves share one `Arc` of the stream, so neither dropping
//! the client nor half-closing the writer closes the handle/socket: the stream
//! is released only when BOTH halves are dropped. The reader and writer tasks
//! each own one half and each drop it on cancel; [`ConnState::halves_released`]
//! reports when the last one is gone, which is the moment the host sees EOF.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

const LIVE: u8 = 0;
const CLOSING: u8 = 1;
const LOST: u8 = 2;

/// Who ended the connection. Decided once, by a compare-exchange from `Live`.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    Live,
    /// We closed it on purpose; `on_disconnect` must NOT fire.
    Closing,
    /// The transport failed (peer EOF or a write error); `on_disconnect` fires.
    Lost,
}

pub(super) struct ConnState {
    phase: AtomicU8,
    /// Level-triggered, so a task that starts waiting after the cancel still sees it.
    cancel: watch::Sender<bool>,
    /// Every task holds a receiver until its half is dropped; `closed()` on the
    /// sender resolves once the last one is gone.
    halves: watch::Sender<()>,
}

impl ConnState {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            phase: AtomicU8::new(LIVE),
            cancel: watch::channel(false).0,
            halves: watch::channel(()).0,
        })
    }

    #[cfg(test)]
    pub(super) fn phase(&self) -> Phase {
        match self.phase.load(Ordering::Acquire) {
            LIVE => Phase::Live,
            CLOSING => Phase::Closing,
            _ => Phase::Lost,
        }
    }

    /// `Live -> Closing`. True for the single caller that wins.
    pub(super) fn begin_close(&self) -> bool {
        self.phase
            .compare_exchange(LIVE, CLOSING, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// `Live -> Lost`. True for the single caller that wins.
    pub(super) fn begin_lost(&self) -> bool {
        self.phase
            .compare_exchange(LIVE, LOST, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub(super) fn cancel(&self) {
        self.cancel.send_replace(true);
    }

    pub(super) fn cancel_rx(&self) -> watch::Receiver<bool> {
        self.cancel.subscribe()
    }

    /// Held by a task from before it starts until after it dropped its half.
    pub(super) fn half_guard(&self) -> watch::Receiver<()> {
        self.halves.subscribe()
    }

    /// True once both halves are dropped (the stream is closed), false if that
    /// did not happen within `bound`.
    pub(super) async fn halves_released(&self, bound: Duration) -> bool {
        tokio::time::timeout(bound, self.halves.closed()).await.is_ok()
    }
}

/// Resolves when the connection is being torn down. A dropped sender counts as
/// cancelled: nothing is left to cancel it later.
pub(super) async fn cancelled(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|c| *c).await;
}
