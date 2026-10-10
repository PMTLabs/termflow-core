//! Test-only allocation gauge (plan 054 review 295 F3).
//!
//! The per-connection memory claim (§4.4: "a connection's memory is its input
//! plus a few KiB; replies are written as borrowed pieces, never concatenated")
//! is about everything the handler owns, not only its input buffers. So this
//! counts the real allocations the handler makes: a counting global allocator
//! that, on a thread, only counts while a future wrapped by [`measured`] is
//! being polled. Whatever the reply path allocates (a concatenated body, a
//! second copy of a snapshot, a bigger header buffer) shows up in
//! [`peak_live`], however the code is written.
//!
//! Thread-local, like the other gauges: exact under `#[tokio::test]`'s
//! current-thread runtime, and the test client's own buffers are never counted
//! because they are only touched outside the wrapped polls.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::future::Future;

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK_LIVE: Cell<usize> = const { Cell::new(0) };
}

fn note_alloc(size: usize) {
    let _ = ARMED.try_with(|armed| {
        if armed.get() {
            let live = LIVE.try_with(|l| {
                l.set(l.get() + size);
                l.get()
            });
            if let Ok(live) = live {
                let _ = PEAK_LIVE.try_with(|p| p.set(p.get().max(live)));
            }
        }
    });
}

fn note_free(size: usize) {
    let _ = ARMED.try_with(|armed| {
        if armed.get() {
            // Memory allocated before the window and freed inside it must not
            // push the count below what the window itself holds.
            let _ = LIVE.try_with(|l| l.set(l.get().saturating_sub(size)));
        }
    });
}

struct Counting;

// SAFETY: every call is forwarded unchanged to `System`; the counters only read
// the size that the caller passed and never allocate (const thread-locals).
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() {
            note_alloc(layout.size());
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(layout);
        if !p.is_null() {
            note_alloc(layout.size());
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        note_free(layout.size());
        System.dealloc(ptr, layout);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = System.realloc(ptr, layout, new_size);
        if !p.is_null() {
            note_free(layout.size());
            note_alloc(new_size);
        }
        p
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// Forgets what was counted so far on this thread.
pub fn reset() {
    LIVE.with(|l| l.set(0));
    PEAK_LIVE.with(|p| p.set(0));
}

/// The most bytes that were live at once inside [`measured`] windows since [`reset`].
pub fn peak_live() -> usize {
    PEAK_LIVE.with(Cell::get)
}

/// Runs `fut` to completion, counting its allocations: only while `fut` itself
/// is being polled, not while the caller's other futures run.
pub async fn measured<F: Future>(fut: F) -> F::Output {
    let mut fut = std::pin::pin!(fut);
    std::future::poll_fn(move |cx| {
        let was = ARMED.replace(true);
        let polled = fut.as_mut().poll(cx);
        ARMED.set(was);
        polled
    })
    .await
}
