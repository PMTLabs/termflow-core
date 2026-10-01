//! Window ownership of renderer shells. A claim on a host session is not a
//! renderer binding: moves release the holder, closes invalidate even a create
//! running in another window, and abandoned releases are recovered non-destructively.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Longer than the host request deadline plus window boot. Unbound shells are
/// surfaced on the next settled restore sweep; cleanup never destroys a shell.
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
    revoked: HashSet<String>,
    headless: bool,
    surfaced: bool,
    delete_history: bool,
}

#[derive(Default)]
struct Inner {
    shells: HashMap<String, Shell>,
    intents: HashMap<String, HashMap<String, (String, Instant)>>,
    gone: HashSet<String>,
    exited: HashSet<String>,
    closing: HashSet<String>,
    closed_processes: HashSet<String>,
    retiring: HashMap<String, String>,
    departed: HashMap<String, HashSet<String>>,
    restoring: HashMap<String, usize>,
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
    /// close precisely this process: an explicit close or exit overtook it.
    /// Window destruction only releases ownership for later recovery.
    pub fn complete(mut self, process: &str, now: Instant) -> bool {
        let mut inner = self.bindings.0.lock().unwrap_or_else(|e| e.into_inner());
        let shell = inner.shells.get_mut(&self.leaf).expect("create reservation");
        shell.creating = false;
        shell.process = Some(process.to_string());
        shell.ready = true;
        shell.unbound_since = now;
        let closed = shell.closed;
        let exited = inner.exited.contains(process);
        if exited {
            let shell = inner.shells.get_mut(&self.leaf).unwrap();
            shell.closed = true;
            shell.process = None;
            shell.holder = None;
        }
        self.finished = true;
        !closed && !exited
    }
}

impl SessionBindings {
    pub fn begin_create(&self, leaf: &str, window: &str, now: Instant) -> Result<Creating, String> {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.gone.contains(window) {
            return Err("window no longer exists".into());
        }
        if inner.departed.get(leaf).is_some_and(|windows| windows.contains(window)) {
            return Err(format!("host-ownership-pending: {leaf} transferred from this window"));
        }
        if inner.retiring.contains_key(leaf) {
            return Err(format!("host-ownership-pending: {leaf} shell is retiring"));
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
            revoked: HashSet::new(), headless: false, surfaced: false, delete_history: true,
        });
        Ok(Creating { bindings: self.clone(), leaf: leaf.to_string(), finished: false })
    }

    /// API producers reserve final publication too, but have no expiring UI owner.
    pub fn begin_headless_create(&self, leaf: &str, now: Instant) -> Result<Creating, String> {
        let creating = self.begin_create(leaf, "", now)?;
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let shell = inner.shells.get_mut(leaf).unwrap();
        shell.holder = None;
        shell.headless = true;
        Ok(creating)
    }

    /// Only an unbound shell (or one already held by this caller) may be bound.
    /// `registered` admits API-created shells and renderer reload reconciliation.
    pub fn bind(&self, leaf: &str, window: &str, registered: Option<&str>, now: Instant) -> BindResult {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.gone.contains(window) { return BindResult::Refused; }
        if inner.departed.get(leaf).is_some_and(|windows| windows.contains(window)) { return BindResult::None; }
        if !inner.shells.contains_key(leaf) {
            let Some(process) = registered else { return BindResult::None; };
            inner.shells.insert(leaf.to_string(), Shell {
                holder: None, process: Some(process.to_string()), creating: false,
                ready: true, closed: false, unbound_since: now,
                revoked: HashSet::new(), headless: false, surfaced: false, delete_history: true,
            });
        }
        let shell = inner.shells.get_mut(leaf).unwrap();
        if shell.closed || shell.revoked.contains(window) { return BindResult::None; }
        if shell.creating || (!shell.ready && shell.process.is_some()) { return BindResult::Pending; }
        if shell.holder.as_deref().is_some_and(|holder| holder != window) {
            return BindResult::Refused;
        }
        let Some(process_id) = shell.process.clone() else { return BindResult::None; };
        if registered != Some(process_id.as_str()) { return BindResult::None; }
        shell.holder = Some(window.to_string());
        shell.headless = false;
        shell.surfaced = false;
        if let Some(intents) = inner.intents.get_mut(leaf) { intents.remove(window); }
        BindResult::Bound { process_id }
    }

    /// Release is authorized by the holder's label, including during create. A
    /// stale source release after a destination bind cannot release the new holder.
    pub fn release(&self, leaf: &str, window: &str, now: Instant) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // A release may be delayed past registration of a replacement restore.
        // Keep its intent until bind, explicit close, window destruction or TTL.
        if let Some(shell) = inner.shells.get_mut(leaf) {
            if shell.holder.as_deref() == Some(window) {
                shell.holder = None;
                shell.unbound_since = now;
            }
        }
    }

    /// Only the holder or an unheld leaf may close its logical session. A refused
    /// duplicate has no authority over another window's shell.
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
        self.close_expected_registered_with(leaf, window, registered, None, now, record)
    }

    pub(crate) fn close_expected_registered_with(
        &self, leaf: &str, window: &str, registered: Option<&str>, expected: Option<&str>,
        now: Instant, record: impl FnOnce(bool),
    ) -> Option<String> {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(expected) = expected {
            let current = inner.shells.get(leaf).map_or(registered, |s| s.process.as_deref());
            if current != Some(expected) { record(true); return None; }
        }
        if let Some(intents) = inner.intents.get_mut(leaf) { intents.remove(window); }
        let other_intent = inner.intents.get(leaf).is_some_and(|windows| windows.iter()
            .any(|(window, (_, stamp))| inner.restoring.contains_key(window)
                || now.saturating_duration_since(*stamp) < INTENT_TTL));
        let refused = inner.departed.get(leaf).is_some_and(|windows| windows.contains(window))
            || inner.shells.get(leaf).is_some_and(|shell|
                shell.holder.as_deref().is_some_and(|holder| holder != window));
        record(other_intent || refused);
        if refused { return None; }
        let Some(shell) = inner.shells.get_mut(leaf) else { return registered.map(str::to_string); };
        shell.closed = true;
        shell.holder = None;
        if shell.creating { None } else {
            let process = shell.process.take();
            if let Some(process) = &process { inner.retiring.insert(leaf.to_string(), process.clone()); }
            process
        }
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
        let inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.intents.get(leaf).is_some_and(|windows| windows.iter().any(|(window, (_, stamp))|
            inner.restoring.contains_key(window) || now.saturating_duration_since(*stamp) < INTENT_TTL))
    }

    pub fn has_key_intent(&self, key: &str, now: Instant) -> bool {
        let inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.intents.values().any(|windows| windows.iter().any(|(window, (k, stamp))|
            k == key && (inner.restoring.contains_key(window) || now.saturating_duration_since(*stamp) < INTENT_TTL)))
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
        let waiting = inner.intents.values().any(|windows| windows.iter()
            .any(|(window, (k, stamp))| k == key && (inner.restoring.contains_key(window)
                || now.saturating_duration_since(*stamp) < INTENT_TTL)));
        if !waiting { forget(); }
    }

    pub fn begin_restore(&self, window: &str) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        *inner.restoring.entry(window.to_string()).or_default() += 1;
    }

    pub fn end_restore(&self, window: &str) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(depth) = inner.restoring.get_mut(window) {
            *depth = depth.saturating_sub(1);
            if *depth == 0 { inner.restoring.remove(window); }
        }
    }

    pub fn restore_in_progress(&self) -> bool {
        !self.0.lock().unwrap_or_else(|e| e.into_inner()).restoring.is_empty()
    }

    pub fn destroy_window(&self, window: &str, now: Instant) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.gone.insert(window.to_string());
        inner.restoring.remove(window);
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
        self.transfer_tree(tree, window, "", now);
    }

    pub fn transfer_tree(&self, tree: &serde_json::Value, window: &str, destination: &str, now: Instant) {
        if let Some(leaf) = tree.get("terminalId").and_then(|v| v.as_str()) {
            let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
            let departed = inner.departed.entry(leaf.to_string()).or_default();
            departed.insert(window.to_string());
            departed.remove(destination);
            if let Some(shell) = inner.shells.get_mut(leaf) {
                shell.revoked.insert(window.to_string());
                shell.revoked.remove(destination);
                if shell.holder.as_deref() == Some(window) {
                    shell.holder = None;
                    shell.unbound_since = now;
                }
            }
        }
        if let Some(children) = tree.get("children").and_then(|v| v.as_array()) {
            for child in children { self.transfer_tree(child, window, destination, now); }
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
        inner.exited.insert(process.to_string());
        for shell in inner.shells.values_mut() {
            if shell.process.as_deref() == Some(process) {
                shell.process = None;
                if !shell.creating { shell.holder = None; }
            }
        }
    }

    /// Reconcile missed destruction events against the backend window inventory.
    pub fn reconcile_windows(&self, live: &HashSet<String>, now: Instant) {
        let inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let holders: HashSet<_> = inner.shells.values().filter_map(|s| s.holder.clone())
            .chain(inner.restoring.keys().cloned()).filter(|w| !live.contains(w)).collect();
        drop(inner);
        for window in holders { self.destroy_window(&window, now); }
    }

    /// Claim a physical close exactly once, qualified by process identity. A late
    /// close of P must never invalidate a replacement reservation or shell Q.
    pub fn begin_process_close(&self, process: &str, delete_history: bool) -> bool {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.closing.contains(process) || inner.closed_processes.contains(process) { return false; }
        let mut leaf = None;
        for (key, shell) in inner.shells.iter_mut() {
            if shell.process.as_deref() == Some(process) {
                shell.closed = true;
                shell.delete_history &= delete_history;
                shell.holder = None;
                if shell.creating { return false; }
                leaf = Some(key.clone());
            }
        }
        if let Some(leaf) = leaf { inner.retiring.insert(leaf, process.to_string()); }
        inner.closing.insert(process.to_string());
        true
    }

    /// All explicit process-close entry points share this synchronous operation.
    /// Selection and effects are separated so no state mutex encloses I/O.
    pub fn close_process_with(&self, process: &str, delete_history: bool, effect: impl FnOnce(bool)) {
        if !self.begin_process_close(process, delete_history) { return; }
        let history = self.0.lock().unwrap_or_else(|e| e.into_inner()).shells.values()
            .find(|s| s.process.as_deref() == Some(process))
            .map_or(delete_history, |s| s.delete_history && delete_history);
        effect(history);
        self.finish_process_close(process);
    }

    /// Recheck selection before emitting a recovery tab. Binding or another
    /// restore may have overtaken the sweep after its mutex was released.
    pub fn prepare_recovery(&self, process: &str, window: &str, now: Instant) -> bool {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(leaf) = inner.shells.iter().find(|(_, s)| s.process.as_deref() == Some(process))
            .map(|(leaf, _)| leaf.clone()) else { return false; };
        let wanted = !inner.restoring.is_empty() || inner.intents.get(&leaf).is_some_and(|windows|
            windows.values().any(|(_, stamp)| now.saturating_duration_since(*stamp) < INTENT_TTL));
        let shell = inner.shells.get_mut(&leaf).unwrap();
        if wanted || shell.creating || shell.closed || shell.holder.is_some() {
            shell.surfaced = false;
            return false;
        }
        shell.revoked.remove(window);
        shell.ready = true;
        if let Some(departed) = inner.departed.get_mut(&leaf) { departed.remove(window); }
        true
    }

    pub fn retry_recovery(&self, process: &str) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for shell in inner.shells.values_mut() {
            if shell.process.as_deref() == Some(process) { shell.surfaced = false; }
        }
    }

    pub fn finish_process_close(&self, process: &str) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.closing.remove(process);
        inner.closed_processes.insert(process.to_string());
        inner.retiring.retain(|_, p| p != process);
    }

    /// Select an abandoned process once for non-destructive recovery. Intent and
    /// active creates exclude it; the process remains registered and bindable.
    pub fn reap_unbound(&self, now: Instant) -> Vec<String> {
        self.reap_unbound_except(now, &HashSet::new())
    }

    pub fn reap_unbound_except(&self, now: Instant, protected: &HashSet<String>) -> Vec<String> {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !inner.restoring.is_empty() { return Vec::new(); }
        inner.intents.retain(|_, windows| {
            windows.retain(|_, (_, stamp)| now.saturating_duration_since(*stamp) < INTENT_TTL);
            !windows.is_empty()
        });
        inner.shells.retain(|_, shell| shell.creating || shell.process.is_some()
            || now.saturating_duration_since(shell.unbound_since) < INTENT_TTL);
        let wanted: HashSet<_> = inner.intents.keys().cloned().collect();
        inner.shells.iter_mut().filter_map(|(leaf, shell)| {
            if !shell.creating && !shell.closed && !shell.headless && !shell.surfaced
                && !wanted.contains(leaf) && !protected.contains(leaf) && shell.holder.is_none()
                && now.saturating_duration_since(shell.unbound_since) >= UNBOUND_GRACE {
                let process = shell.process.clone()?;
                shell.surfaced = true;
                Some(process)
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
