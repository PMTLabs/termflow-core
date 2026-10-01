//! A host key is meaningful only on its channel and connection epoch.

use crate::elevated_host::HostChannel;
use dashmap::DashMap;
use std::sync::{atomic::{AtomicU64, Ordering}, Arc};

#[derive(Clone)]
struct Route {
    process: String,
    epoch: u64,
}

#[derive(Clone, Default)]
pub struct HostRoutes {
    entries: Arc<DashMap<(HostChannel, String), Route>>,
    dropped: Arc<AtomicU64>,
}

impl HostRoutes {
    pub fn register(&self, channel: HostChannel, key: &str, process: &str, epoch: u64) {
        self.entries.insert((channel, key.to_string()), Route { process: process.to_string(), epoch });
    }

    pub fn contains(&self, channel: HostChannel, key: &str) -> bool {
        self.entries.contains_key(&(channel, key.to_string()))
    }

    pub fn remove_process(&self, process: &str) {
        self.entries.retain(|_, route| route.process != process);
    }

    pub fn remove_channel(&self, channel: HostChannel) {
        self.entries.retain(|(owner, _), _| *owner != channel);
    }

    pub fn resolve(&self, channel: HostChannel, key: &str, epoch: u64, current: bool) -> Option<String> {
        let process = if current {
            self.entries.get(&(channel, key.to_string()))
                .filter(|route| route.epoch == epoch).map(|route| route.process.clone())
        } else { None };
        if process.is_none() {
            self.record_drop();
        }
        process
    }

    pub(super) fn record_drop(&self) {
        self.dropped.fetch_add(1, Ordering::Relaxed);
    }

    pub fn dropped_frames(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::elevated_host::FrozenId;

    #[test]
    fn identical_keys_on_two_channels_do_not_overwrite_routes() {
        let routes = HostRoutes::default();
        let other = HostChannel::Frozen(FrozenId(1));
        routes.register(HostChannel::Primary, "same", "pc-a", 1);
        routes.register(other, "same", "pc-b", 2);
        assert_eq!(routes.resolve(HostChannel::Primary, "same", 1, true).as_deref(), Some("pc-a"));
        assert_eq!(routes.resolve(other, "same", 2, true).as_deref(), Some("pc-b"));
        routes.remove_process("pc-a");
        assert_eq!(routes.resolve(HostChannel::Primary, "same", 1, true), None);
        assert_eq!(routes.resolve(other, "same", 2, true).as_deref(), Some("pc-b"));
        assert_eq!(routes.resolve(other, "same", 1, true), None);
        assert_eq!(routes.resolve(other, "same", 2, false), None);
        assert_eq!(routes.dropped_frames(), 3);
        routes.remove_channel(other);
        assert!(!routes.contains(other, "same"));
    }
}
