//! Leaf storage outlives a shell. Fixed stripes serialize its writers with
//! removal of the owner row, without retaining one lock per dead process.

use std::cell::Cell;
use std::sync::Mutex;

thread_local! { static IN_STORAGE: Cell<bool> = const { Cell::new(false) }; }
struct Section;
impl Drop for Section {
    fn drop(&mut self) { IN_STORAGE.with(|active| active.set(false)); }
}

static STRIPES: [Mutex<()>; 64] = [const { Mutex::new(()) }; 64];

pub(crate) fn stripe_index(leaf: &str) -> usize {
    // Fixed FNV-1a, independent of randomized map hashers.
    let hash = leaf.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    (hash & 63) as usize
}

/// Multi-leaf edits lock unique stripes in ascending order, including collisions.
/// The closure is synchronous and must not re-enter storage or owner ending.
pub(crate) fn with_leaves<T>(leaves: &[&str], edit: impl FnOnce() -> T) -> T {
    let mut indices: Vec<_> = leaves.iter().map(|leaf| stripe_index(leaf)).collect();
    indices.sort_unstable();
    indices.dedup();
    with_indices(&indices, edit)
}

/// A bulk prune has no bounded leaf set; exclude every leaf writer atomically.
pub(crate) fn with_all<T>(edit: impl FnOnce() -> T) -> T {
    with_indices(&(0..STRIPES.len()).collect::<Vec<_>>(), edit)
}

fn with_indices<T>(indices: &[usize], edit: impl FnOnce() -> T) -> T {
    IN_STORAGE.with(|active| {
        assert!(!active.get(), "leaf storage sections must not nest");
        active.set(true);
    });
    let _section = Section;
    let _guards: Vec<_> = indices.iter().map(|&index| {
        STRIPES[index].lock().unwrap_or_else(|e| e.into_inner())
    }).collect();
    edit()
}
