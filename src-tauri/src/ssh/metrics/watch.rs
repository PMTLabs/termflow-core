//! Page-owned subscriptions and the native eligibility census. Placement is
//! read from the same authority that owns the pane stream and SSH session.
use super::sampler::{EligibilityObserver, EventSink, Fence, SamplerRegistry};
use crate::{
    ssh::{auth::BoxFuture, session::{SessionError, SessionRegistry}},
    state::HostKeys,
};
use parking_lot::Mutex;
use std::{collections::{HashMap, HashSet}, sync::{Arc, Weak}, time::Duration};
use tauri::{Manager, Runtime};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct WindowKey {
    label: String,
    wi: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Consumer {
    window: WindowKey,
    pg: u64,
    id: Uuid,
}

struct Slot {
    placement: u64,
    retired: bool,
    established: bool,
    consumers: HashSet<Consumer>,
    visible: HashSet<WindowKey>,
}

type SlotRef = Arc<Mutex<Slot>>;

pub(crate) struct WatchRegistry {
    keys: HostKeys,
    sampler: SamplerRegistry,
    // The map guard is only used for lookup/install/removal. Each terminal
    // serializes its own command and effect commits without blocking others.
    slots: Mutex<HashMap<String, SlotRef>>,
    visibility: Arc<dyn Visibility>,
}

// Native queries run without an ownership or registry mutex. The result is
// qualified by window incarnation before being applied to the live consumers.
trait Visibility: Send + Sync {
    fn visible(&self, windows: Vec<WindowKey>) -> BoxFuture<'_, HashSet<WindowKey>>;
}

struct Native<R: Runtime>(tauri::AppHandle<R>);
impl<R: Runtime> Visibility for Native<R> {
    fn visible(&self, windows: Vec<WindowKey>) -> BoxFuture<'_, HashSet<WindowKey>> {
        Box::pin(async move {
            let (send, receive) = tokio::sync::oneshot::channel();
            let app = self.0.clone();
            if self.0.run_on_main_thread(move || {
                let visible = windows.into_iter().filter(|key| {
                    key.label != "drag-preview" && app.get_webview_window(&key.label).is_some_and(|window| {
                        on_screen(window.is_visible().ok(), window.is_minimized().ok())
                    })
                }).collect();
                let _ = send.send(visible);
            }).is_err() {
                return HashSet::new();
            }
            // A stuck/closing event loop cannot authorize any work.
            tokio::time::timeout(Duration::from_secs(2), receive).await
                .ok().and_then(Result::ok).unwrap_or_default()
        })
    }
}

fn on_screen(visible: Option<bool>, minimized: Option<bool>) -> bool {
    visible == Some(true) && minimized == Some(false)
}

struct Observe(Weak<WatchRegistry>);
impl EligibilityObserver for Observe {
    fn refresh<'a>(&'a self, terminal_id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if let Some(registry) = self.0.upgrade() {
                registry.refresh(terminal_id).await;
            }
        })
    }
}

impl WatchRegistry {
    pub(crate) fn native<R: Runtime>(keys: HostKeys, sessions: Arc<SessionRegistry>, app: tauri::AppHandle<R>) -> Arc<Self> {
        Self::new(keys, sessions, Arc::new(app.clone()), Arc::new(Native(app)))
    }

    fn new(keys: HostKeys, sessions: Arc<SessionRegistry>, events: Arc<dyn EventSink>, visibility: Arc<dyn Visibility>) -> Arc<Self> {
        Arc::new_cyclic(|registry| Self {
            keys,
            sampler: SamplerRegistry::observing(sessions, events, Arc::new(Observe(registry.clone()))),
            slots: Mutex::default(),
            visibility,
        })
    }

    fn consumer(label: &str, wi: u64, pg: u64, id: Uuid) -> Consumer {
        Consumer { window: WindowKey { label: label.into(), wi }, pg, id }
    }

    pub(crate) fn watch(&self, label: &str, pg: u64, terminal: &str, id: Uuid) -> Result<Fence, SessionError> {
        let (wi, placement) = self.keys.metrics_owner(label, pg, terminal).ok_or(SessionError::OwnerRetired)?;
        let entry = self.slots.lock().entry(terminal.into()).or_insert_with(|| Arc::new(Mutex::new(Slot {
            placement,
            retired: false,
            established: false,
            consumers: HashSet::new(),
            visible: HashSet::new(),
        }))).clone();
        let mut slot = entry.lock();
        if !self.prune(terminal, &entry, &mut slot) || slot.placement != placement
            || self.keys.metrics_owner(label, pg, terminal) != Some((wi, placement)) {
            return Err(SessionError::OwnerRetired);
        }
        let fence = match self.sampler.fence(terminal) {
            Ok(fence) => fence,
            Err(error) => {
                if !slot.established { self.retire(terminal, &entry, &mut slot); }
                return Err(error);
            }
        };
        slot.established = true;
        // Do not attach a verified page to a different placement across teardown.
        if self.keys.metrics_owner(label, pg, terminal) != Some((wi, placement)) {
            self.prune(terminal, &entry, &mut slot);
            return Err(SessionError::OwnerRetired);
        }
        slot.consumers.insert(Self::consumer(label, wi, pg, id));
        self.apply(terminal, &slot);
        Ok(fence)
    }

    fn entry(&self, terminal: &str) -> Option<SlotRef> {
        self.slots.lock().get(terminal).cloned()
    }

    #[cfg(all(test, feature = "integration-tests", not(windows)))]
    pub(crate) fn invoke_census(&self, terminal: &str) -> (Vec<(String, u64, Uuid)>, bool) {
        let owners = self.entry(terminal).map(|entry| entry.lock().consumers.iter()
            .map(|c| (c.window.label.clone(), c.pg, c.id)).collect()).unwrap_or_default();
        (owners, self.sampler.status(terminal).is_some_and(|(_, eligible, _)| eligible))
    }

    pub(crate) fn unwatch(&self, label: &str, pg: u64, terminal: &str, id: Uuid) -> Result<(), SessionError> {
        let wi = self.keys.metrics_sender(label, pg).ok_or(SessionError::OwnerRetired)?;
        if let Some(entry) = self.entry(terminal) {
            let mut slot = entry.lock();
            if !slot.retired {
                slot.consumers.remove(&Self::consumer(label, wi, pg, id));
                self.prune(terminal, &entry, &mut slot);
            }
        }
        Ok(())
    }

    pub(crate) fn resume(&self, label: &str, pg: u64, terminal: &str, id: Uuid) -> Result<Fence, SessionError> {
        let entry = self.entry(terminal).ok_or(SessionError::OwnerRetired)?;
        let mut slot = entry.lock();
        let (wi, placement) = self.keys.metrics_owner(label, pg, terminal).ok_or(SessionError::OwnerRetired)?;
        if !self.prune(terminal, &entry, &mut slot) || slot.placement != placement
            || !slot.consumers.contains(&Self::consumer(label, wi, pg, id)) {
            return Err(SessionError::OwnerRetired);
        }
        self.sampler.resume(terminal)
    }

    /// Consume existing pane/page/transfer/destruction effects after their
    /// ownership lock is released. Re-read authority instead of trusting an
    /// old label or a delayed effect to identify the surviving placement.
    pub(crate) fn reconcile(&self) {
        let slots = self.slots.lock().clone();
        for (terminal, entry) in slots {
            self.prune(&terminal, &entry, &mut entry.lock());
        }
    }

    fn retire(&self, terminal: &str, entry: &SlotRef, slot: &mut Slot) {
        slot.retired = true;
        self.sampler.retire(terminal);
        let mut slots = self.slots.lock();
        if slots.get(terminal).is_some_and(|current| Arc::ptr_eq(current, entry)) {
            slots.remove(terminal);
        }
    }

    fn prune(&self, terminal: &str, entry: &SlotRef, slot: &mut Slot) -> bool {
        if slot.retired { return false; }
        if self.keys.metrics_placement(terminal) != Some(slot.placement) {
            // Final owner/session teardown, not disconnect or reconnect of a
            // still-owned terminal. Only the former can release stamp history.
            self.retire(terminal, entry, slot);
            return false;
        }
        let placement = slot.placement;
        slot.consumers.retain(|c| self.keys.metrics_owner(&c.window.label, c.pg, terminal) == Some((c.window.wi, placement)));
        slot.visible.retain(|window| slot.consumers.iter().any(|c| &c.window == window));
        self.apply(terminal, slot);
        true
    }

    fn apply(&self, terminal: &str, slot: &Slot) {
        if !slot.established { return; }
        let eligible = slot.consumers.iter().any(|c| slot.visible.contains(&c.window));
        let _ = self.sampler.set_eligible(terminal, eligible);
        self.sampler.set_observed(terminal, !slot.consumers.is_empty());
    }

    async fn refresh(&self, terminal: &str) {
        let Some(entry) = self.entry(terminal) else { return; };
        let windows: HashSet<_> = {
            let mut slot = entry.lock();
            if !self.prune(terminal, &entry, &mut slot) { return; }
            slot.consumers.iter().map(|c| c.window.clone()).collect()
        };
        if windows.is_empty() { return; }
        let visible = self.visibility.visible(windows.into_iter().collect()).await;
        let mut slot = entry.lock();
        if self.prune(terminal, &entry, &mut slot) {
            slot.visible = visible.into_iter().filter(|window| slot.consumers.iter().any(|c| &c.window == window)).collect();
            self.apply(terminal, &slot);
        }
    }
}

#[cfg(test)]
mod tests;
