//! Window ownership of renderer shells. A claim on a host session is not a
//! renderer binding: moves release the holder, closes invalidate even a create
//! running in another window, and abandoned releases have a bounded lifetime.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Longer than the host's ten-second request deadline plus window boot. Cleanup
/// closes unbound shells on the next restore sweep, rather than hiding them until
/// a subsequent app restart. Bound and in-flight shells are never reaped.
pub const UNBOUND_GRACE: Duration = Duration::from_secs(30);
const INTENT_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum BindResult {
    #[serde(rename_all = "camelCase")]
    Bound { process_id: String },
    Pending,
    Refused,
    None,
}

struct Shell {
    holder: Option<String>,
    process: Option<String>,
    creating: bool,
    ready: bool,
    closed: bool,
    unbound_since: Instant,
}

#[derive(Default)]
struct Inner {
    shells: HashMap<String, Shell>,
    intents: HashMap<String, HashMap<String, (String, Instant)>>,
    gone: HashSet<String>,
}

#[derive(Clone, Default)]
pub struct SessionBindings(Arc<Mutex<Inner>>);

/// Cancellation releases the reservation; no lock is held across a host request.
pub struct Creating {
    bindings: SessionBindings,
    leaf: String,
    finished: bool,
}

impl Drop for Creating {
    fn drop(&mut self) {
        if !self.finished {
            let mut inner = self.bindings.0.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(shell) = inner.shells.get_mut(&self.leaf) {
                shell.creating = false;
                shell.holder = None;
                shell.unbound_since = Instant::now();
            }
        }
    }
}

impl Creating {
    /// Publish only the final process, never a provisional host registration that
    /// may be replaced by an in-process fallback. False means the caller must
    /// close precisely this process: a close or window destruction overtook it.
    pub fn complete(mut self, process: &str, now: Instant) -> bool {
        let mut inner = self.bindings.0.lock().unwrap_or_else(|e| e.into_inner());
        let shell = inner.shells.get_mut(&self.leaf).expect("create reservation");
        shell.creating = false;
        shell.process = Some(process.to_string());
        shell.ready = true;
        shell.unbound_since = now;
        self.finished = true;
        !shell.closed
    }
}

impl SessionBindings {
    pub fn begin_create(&self, leaf: &str, window: &str, now: Instant) -> Result<Creating, String> {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.gone.contains(window) {
            return Err("window no longer exists".into());
        }
        if let Some(shell) = inner.shells.get(leaf) {
            if shell.creating {
                return Err(format!("host-ownership-pending: {leaf} create is still running"));
            }
            if shell.process.is_some() && !shell.closed {
                return Err(format!("host-session-contended: {leaf} already has a shell"));
            }
        }
        inner.shells.insert(leaf.to_string(), Shell {
            holder: Some(window.to_string()), process: None, creating: true,
            ready: false, closed: false, unbound_since: now,
        });
        Ok(Creating { bindings: self.clone(), leaf: leaf.to_string(), finished: false })
    }

    /// Only an unbound shell (or one already held by this caller) may be bound.
    /// `registered` admits API-created shells and renderer reload reconciliation.
    pub fn bind(&self, leaf: &str, window: &str, registered: Option<&str>, now: Instant) -> BindResult {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.gone.contains(window) { return BindResult::Refused; }
        if !inner.shells.contains_key(leaf) {
            let Some(process) = registered else { return BindResult::None; };
            inner.shells.insert(leaf.to_string(), Shell {
                holder: None, process: Some(process.to_string()), creating: false,
                ready: true, closed: false, unbound_since: now,
            });
        }
        let shell = inner.shells.get_mut(leaf).unwrap();
        if shell.closed { return BindResult::None; }
        if shell.creating || (!shell.ready && shell.process.is_some()) { return BindResult::Pending; }
        if shell.holder.as_deref().is_some_and(|holder| holder != window) {
            return BindResult::Refused;
        }
        let Some(process_id) = shell.process.clone() else { return BindResult::None; };
        if registered != Some(process_id.as_str()) { return BindResult::None; }
        shell.holder = Some(window.to_string());
        if let Some(intents) = inner.intents.get_mut(leaf) { intents.remove(window); }
        BindResult::Bound { process_id }
    }

    /// Release is authorized by the holder's label, including during create. A
    /// stale source release after a destination bind cannot release the new holder.
    pub fn release(&self, leaf: &str, window: &str, now: Instant) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(intents) = inner.intents.get_mut(leaf) { intents.remove(window); }
        if let Some(shell) = inner.shells.get_mut(leaf) {
            if shell.holder.as_deref() == Some(window) {
                shell.holder = None;
                shell.unbound_since = now;
            }
        }
    }

    /// A close from ANY window invalidates the outstanding create and takes the
    /// registered process exactly once. Other windows' restore intents survive.
    pub fn close(&self, leaf: &str, window: &str) -> Option<String> {
        self.close_registered(leaf, window, None)
    }

    pub fn close_registered(&self, leaf: &str, window: &str, registered: Option<&str>) -> Option<String> {
        self.close_registered_with(leaf, window, registered, Instant::now(), |_| {})
    }

    pub(crate) fn close_registered_with(
        &self, leaf: &str, window: &str, registered: Option<&str>, now: Instant,
        record: impl FnOnce(bool),
    ) -> Option<String> {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(intents) = inner.intents.get_mut(leaf) { intents.remove(window); }
        let other_intent = inner.intents.get(leaf).is_some_and(|windows| windows.values()
            .any(|(_, stamp)| now.saturating_duration_since(*stamp) < INTENT_TTL));
        record(other_intent);
        let Some(shell) = inner.shells.get_mut(leaf) else { return registered.map(str::to_string); };
        shell.closed = true;
        shell.holder = None;
        if shell.creating { None } else { shell.process.take() }
    }

    pub fn register_intent(&self, leaf: &str, key: &str, window: &str, now: Instant) {
        self.register_intent_with(leaf, key, window, now, || {});
    }

    pub(crate) fn register_intent_with(
        &self, leaf: &str, key: &str, window: &str, now: Instant, record: impl FnOnce(),
    ) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.intents.entry(leaf.to_string()).or_default()
            .insert(window.to_string(), (key.to_string(), now));
        record();
    }

    /// A process-addressed close may observe a provisional registration through
    /// the API. Defer killing it until the host request returns; killing and
    /// unindexing it first would lose the shell the host has not spawned yet.
    pub fn defer_process_close(&self, process: &str) -> bool {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for shell in inner.shells.values_mut() {
            if shell.creating && shell.process.as_deref() == Some(process) {
                shell.closed = true;
                shell.holder = None;
                return true;
            }
        }
        false
    }

    pub fn has_intent(&self, leaf: &str, now: Instant) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).intents.get(leaf)
            .is_some_and(|windows| windows.values().any(|(_, stamp)| now.saturating_duration_since(*stamp) < INTENT_TTL))
    }

    pub fn has_key_intent(&self, key: &str, now: Instant) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).intents.values()
            .any(|windows| windows.values().any(|(k, stamp)| k == key && now.saturating_duration_since(*stamp) < INTENT_TTL))
    }

    pub fn refresh_intents(&self, key: &str, now: Instant) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for windows in inner.intents.values_mut() {
            for (k, stamp) in windows.values_mut() {
                if k == key { *stamp = now; }
            }
        }
    }

    pub(crate) fn forget_key_if_no_intents(&self, key: &str, now: Instant, forget: impl FnOnce()) {
        let inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let waiting = inner.intents.values().any(|windows| windows.values()
            .any(|(k, stamp)| k == key && now.saturating_duration_since(*stamp) < INTENT_TTL));
        if !waiting { forget(); }
    }

    pub fn destroy_window(&self, window: &str, now: Instant) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.gone.insert(window.to_string());
        for intents in inner.intents.values_mut() { intents.remove(window); }
        for shell in inner.shells.values_mut() {
            if shell.holder.as_deref() == Some(window) {
                shell.holder = None;
                shell.unbound_since = now;
            }
        }
    }

    /// A consumed move payload releases every leaf before the destination can
    /// mount, even leaves omitted from its live-process list. This decision is
    /// backend-local, so it does not rely on a source renderer's final IPC call.
    pub fn release_tree(&self, tree: &serde_json::Value, window: &str, now: Instant) {
        if let Some(leaf) = tree.get("terminalId").and_then(|v| v.as_str()) {
            self.release(leaf, window, now);
        }
        if let Some(children) = tree.get("children").and_then(|v| v.as_array()) {
            for child in children { self.release_tree(child, window, now); }
        }
    }

    /// Retain the provisional identity for cancellation cleanup, without making
    /// it bindable before the host request (and any fallback) has finished.
    pub fn stage_process(&self, leaf: &str, process: &str) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(shell) = inner.shells.get_mut(leaf) {
            if shell.creating { shell.process = Some(process.to_string()); }
        }
    }

    pub fn forget_process(&self, process: &str) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for shell in inner.shells.values_mut() {
            if shell.process.as_deref() == Some(process) {
                shell.process = None;
                if !shell.creating { shell.holder = None; }
            }
        }
    }

    /// Taking the process under the same mutex as bind makes sweep vs bind a
    /// single decision. Returned processes are closed, never surfaced as owned.
    pub fn reap_unbound(&self, now: Instant) -> Vec<String> {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.intents.retain(|_, windows| {
            windows.retain(|_, (_, stamp)| now.saturating_duration_since(*stamp) < INTENT_TTL);
            !windows.is_empty()
        });
        inner.shells.retain(|_, shell| shell.creating || shell.process.is_some()
            || now.saturating_duration_since(shell.unbound_since) < INTENT_TTL);
        inner.shells.values_mut().filter_map(|shell| {
            if !shell.creating && shell.holder.is_none()
                && now.saturating_duration_since(shell.unbound_since) >= UNBOUND_GRACE {
                shell.closed = true;
                shell.process.take()
            } else { None }
        }).collect()
    }

    #[cfg(test)]
    fn holder(&self, leaf: &str) -> Option<String> {
        self.0.lock().unwrap().shells.get(leaf).and_then(|s| s.holder.clone())
    }
}

#[cfg(test)]
#[path = "session_bindings_tests.rs"]
mod tests;
