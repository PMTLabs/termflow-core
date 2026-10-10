//! Test-only allocation gauge (plan 054 review 295 F3, review 296 R3).
//!
//! The per-connection memory claim (§4.4: "a connection's memory is its input
//! plus a few KiB; replies are written as borrowed pieces, never concatenated")
//! is about everything the handler owns, not only its input buffers. So this
//! counts the real allocations the handler makes: a counting global allocator
//! that, on a thread, counts allocations made while a future wrapped by
//! [`measured`] is being polled. Whatever the reply path allocates (a
//! concatenated body, a second copy of a snapshot, a bigger header buffer)
//! shows up in [`peak_live`], however the code is written.
//!
//! Attribution: every allocation carries a small header holding the
//! measurement window it was made in (0 = none). A free subtracts only bytes
//! that the current window allocated, whenever and wherever the free happens.
//! Freeing a buffer from outside the window, or from before a [`reset`], does
//! not hide the window's own bytes. A growing buffer is a new allocation plus a
//! free (`GlobalAlloc`'s default `realloc`), so growing a foreign buffer inside
//! the window counts in full: an over-count, which is the safe side for an
//! upper bound.
//!
//! Thread-local, like the other gauges: exact under `#[tokio::test]`'s
//! current-thread runtime, and the test client's own buffers are never counted
//! because they are only allocated outside the wrapped polls.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
    /// This thread's current window; 0 until the first `reset` or measured allocation.
    static WINDOW: Cell<u64> = const { Cell::new(0) };
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK_LIVE: Cell<usize> = const { Cell::new(0) };
}

/// Window ids are unique across threads, so a buffer freed on another thread
/// never matches that thread's window by accident.
static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

fn new_window() -> u64 {
    NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)
}

/// Counts an allocation if this thread is measuring; returns the tag to store.
fn note_alloc(size: usize) -> u64 {
    if !ARMED.try_with(Cell::get).unwrap_or(false) {
        return 0;
    }
    let Ok(window) = WINDOW.try_with(|w| {
        if w.get() == 0 {
            w.set(new_window());
        }
        w.get()
    }) else {
        return 0;
    };
    if let Ok(live) = LIVE.try_with(|l| {
        l.set(l.get() + size);
        l.get()
    }) {
        let _ = PEAK_LIVE.try_with(|p| p.set(p.get().max(live)));
    }
    window
}

/// Subtracts a freed allocation if, and only if, this thread's current window made it.
fn note_free(tag: u64, size: usize) {
    if tag != 0 && WINDOW.try_with(Cell::get).ok() == Some(tag) {
        let _ = LIVE.try_with(|l| l.set(l.get().saturating_sub(size)));
    }
}

/// Bytes in front of every allocation: room for the 8-byte tag, and a multiple
/// of the alignment so the caller's pointer stays aligned.
fn header(align: usize) -> usize {
    align.max(16)
}

fn full_layout(layout: Layout) -> Option<(Layout, usize)> {
    let hdr = header(layout.align());
    let size = layout.size().checked_add(hdr)?;
    Some((Layout::from_size_align(size, layout.align()).ok()?, hdr))
}

struct Counting;

// SAFETY: every allocation is a `System` allocation of `size + hdr` bytes at
// the caller's alignment; the caller gets `base + hdr`, which keeps that
// alignment because `hdr` is a multiple of it, and the tag lives in the 8
// bytes just before the caller's pointer (inside the header, unaligned access).
// `dealloc` recomputes the same layout from the caller's layout. `alloc_zeroed`
// and `realloc` use the trait's defaults, which go through these two. The
// counters only use const thread-locals and an atomic, so they never allocate.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let Some((full, hdr)) = full_layout(layout) else {
            return std::ptr::null_mut();
        };
        let base = System.alloc(full);
        if base.is_null() {
            return base;
        }
        let ptr = base.add(hdr);
        let tag = note_alloc(layout.size());
        ptr.sub(8).cast::<u64>().write_unaligned(tag);
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let (full, hdr) = full_layout(layout).expect("alloc accepted this layout");
        note_free(ptr.sub(8).cast::<u64>().read_unaligned(), layout.size());
        System.dealloc(ptr.sub(hdr), full);
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// Starts a new window on this thread: what was counted so far is forgotten,
/// and frees of earlier windows' allocations no longer subtract.
pub fn reset() {
    WINDOW.with(|w| w.set(new_window()));
    LIVE.with(|l| l.set(0));
    PEAK_LIVE.with(|p| p.set(0));
}

/// The most bytes that were live at once inside [`measured`] windows since [`reset`].
pub fn peak_live() -> usize {
    PEAK_LIVE.with(Cell::get)
}

/// Restores the armed flag when dropped, so a panicking poll does not leave the
/// thread counting.
struct Armed(bool);

impl Armed {
    fn on() -> Self {
        Armed(ARMED.replace(true))
    }
}

impl Drop for Armed {
    fn drop(&mut self) {
        ARMED.set(self.0);
    }
}

/// Runs `fut` to completion, counting its allocations: only while `fut` itself
/// is being polled, not while the caller's other futures run.
pub async fn measured<F: Future>(fut: F) -> F::Output {
    let mut fut = std::pin::pin!(fut);
    std::future::poll_fn(move |cx| {
        let _armed = Armed::on();
        fut.as_mut().poll(cx)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::hint::black_box;
    use std::task::{Context, Poll, Waker};

    const K: usize = 1024;

    fn live() -> usize {
        LIVE.with(Cell::get)
    }

    /// Polls `fut` once inside a measured window.
    fn poll_measured<T>(fut: impl Future<Output = T>) -> Poll<T> {
        let mut fut = std::pin::pin!(measured(fut));
        fut.as_mut().poll(&mut Context::from_waker(Waker::noop()))
    }

    #[test]
    fn a_foreign_free_does_not_hide_the_windows_own_bytes() {
        let external = black_box(vec![0u8; 64 * K]);
        reset();
        let held = poll_measured(async move {
            let a = black_box(vec![1u8; 128 * K]);
            drop(external);
            let b = black_box(vec![2u8; 128 * K]);
            (a, b)
        });
        assert!(peak_live() >= 256 * K, "peak {} must include both 128 KiB buffers", peak_live());
        drop(held);
    }

    #[test]
    fn a_window_allocation_freed_after_the_poll_still_subtracts() {
        reset();
        let Poll::Ready(a) = poll_measured(async { black_box(vec![0u8; 100 * K]) }) else { unreachable!() };
        assert!(live() >= 100 * K, "live {}", live());
        drop(a);
        assert!(live() < K, "the window's buffer was freed outside the poll: live {}", live());
    }

    #[test]
    fn a_reset_forgets_earlier_windows_frees_too() {
        reset();
        let Poll::Ready(old) = poll_measured(async { black_box(vec![0u8; 100 * K]) }) else { unreachable!() };
        reset();
        let Poll::Ready(new) = poll_measured(async { black_box(vec![0u8; 10 * K]) }) else { unreachable!() };
        let before = live();
        drop(old);
        assert_eq!(live(), before, "a buffer from before the reset must not subtract from the new window");
        assert!((10 * K..11 * K).contains(&before), "live {before}");
        drop(new);
    }

    #[test]
    fn a_panicking_poll_disarms_the_thread() {
        reset();
        let caught = std::panic::catch_unwind(|| poll_measured(async { panic!("handler panicked") }));
        assert!(caught.is_err());
        assert!(!ARMED.with(Cell::get), "the panic left the thread counting");
        let peak = peak_live();
        let after = black_box(vec![0u8; 512 * K]);
        assert_eq!(peak_live(), peak, "an allocation after the panic was counted as handler memory");
        drop(after);
    }
}
