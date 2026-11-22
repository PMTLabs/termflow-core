//! Safety identities refuse exhaustion instead of becoming an older identity.
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) fn advance(counter: &AtomicU64) -> Result<u64, String> {
    counter.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1))
        .map(|n| n + 1).map_err(|_| "terminal host identity exhausted".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_identity_exhaustion_does_not_wrap_or_publish_a_new_value() {
        let counter = AtomicU64::new(u64::MAX - 1);
        assert_eq!(advance(&counter).unwrap(), u64::MAX);
        assert!(advance(&counter).is_err());
        assert!(advance(&counter).is_err());
        assert_eq!(counter.load(Ordering::Acquire), u64::MAX);
    }
}
