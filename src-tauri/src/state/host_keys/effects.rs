//! Retain the original shell identity across waits. Projection maps can disappear
//! or be replaced; they are not authority for a later host enqueue.

use super::*;

#[derive(Clone, Debug)]
pub(crate) struct SessionIdentity {
    pub channel: HostChannel,
    pub key: String,
    pub process: String,
    pub cg: Option<u64>,
}

impl HostKeys {
    pub(crate) fn session_identity(&self, channel: HostChannel, key: &str, process: &str) -> Option<SessionIdentity> {
        let inner = self.lock();
        let state = &inner.keys.get(&(channel, key.into()))?.state;
        let cg = inner.owners.values().find(|r| owners::shell_of(&r.state).is_some_and(|s| s.process == process)).map(|r| r.cg);
        match state {
            KeyState::Bound(pc) if pc == process => {},
            KeyState::Held(held) if cg == Some(*held) => {},
            _ => return None,
        }
        Some(SessionIdentity { channel, key: key.into(), process: process.into(), cg })
    }

    fn matches_session(inner: &Inner, identity: &SessionIdentity) -> bool {
        match inner.keys.get(&(identity.channel, identity.key.clone())).map(|r| &r.state) {
            Some(KeyState::Bound(pc)) => pc == &identity.process,
            Some(KeyState::Held(cg)) => identity.cg == Some(*cg) && inner.owners.values().any(|r|
                r.cg == *cg && owners::shell_of(&r.state).is_some_and(|s| s.process == identity.process)),
            _ => false,
        }
    }

    pub(crate) fn enqueue_session_on(&self, identity: &SessionIdentity, channel: HostChannel, epoch: u64, enqueue: impl FnOnce() -> bool) -> bool {
        let inner = self.lock();
        identity.channel == channel
            && inner.channels.get(&channel).and_then(|c| c.connection.as_ref()).is_some_and(|c| c.epoch == epoch && c.alive.load(Ordering::Acquire))
            && Self::matches_session(&inner, identity) && enqueue()
    }

    pub(crate) fn recover_listed(&self, channel: HostChannel, key: &str, unregistered: impl FnOnce() -> bool, announce: impl FnOnce() + Send + 'static) {
        // Initialise the worker outside ownership. Delivery may re-enter us.
        let delivery = self.delivery_sender();
        let mut inner = self.lock();
        if inner.keys.get(&(channel, key.into())).map(|r| &r.state) != Some(&KeyState::Listed)
            || inner.keys.iter().any(|((_, k), r)| k == key && matches!(r.state, KeyState::Held(_) | KeyState::Bound(_)))
            || !unregistered() { return; }
        let now = std::time::Instant::now();
        if Self::protected(&inner, key) { return; }
        if Self::unowned_due(&inner, key, now) { Self::end(&mut inner, channel, key, CloseState::Pending); }
        else {
            let record = inner.keys.get(&(channel, key.into())).unwrap();
            let identity = (channel, key.to_owned(), inner.channels.get(&channel).and_then(|c| c.connection.as_ref()).map(|c| c.epoch), record.pid, record.order);
            if !inner.pending_deliveries.insert(identity.clone()) { return; }
            let authority = Arc::downgrade(&self.inner);
            let completed = identity.clone();
            if delivery.send(Box::new(move || {
                // Keep executing work pending too: repeated sweeps behind a slow
                // observer must not accumulate copies. Panic still releases it.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(announce));
                if let Some(authority) = authority.upgrade() {
                    authority.lock().unwrap_or_else(|e| e.into_inner()).pending_deliveries.remove(&completed);
                }
            })).is_err() { inner.pending_deliveries.remove(&identity); }
        }
    }

    pub(crate) fn publish_route_on(&self, identity: &SessionIdentity, channel: HostChannel, epoch: u64) -> bool {
        #[cfg(test)]
        {
            let hook = self.route_hook.lock().unwrap().clone();
            if let Some(hook) = hook { hook(); }
        }
        self.enqueue_session_on(identity, channel, epoch, || {
            self.routes.register(channel, &identity.key, &identity.process, epoch);
            true
        })
    }

    pub(crate) fn publish_frame(&self, channel: HostChannel, key: &str, epoch: u64, process: &str, publish: impl FnOnce()) -> bool {
        let inner = self.lock();
        let current = inner.channels.get(&channel).and_then(|c| c.connection.as_ref())
            .is_some_and(|c| c.epoch == epoch && c.alive.load(Ordering::Acquire));
        if !current || self.routes.resolve(channel, key, epoch, true).as_deref() != Some(process) { return false; }
        let identity = SessionIdentity { channel, key: key.into(), process: process.into(),
            cg: inner.owners.values().find(|r| owners::shell_of(&r.state).is_some_and(|s| s.process == process)).map(|r| r.cg) };
        if !Self::matches_session(&inner, &identity) { return false; }
        publish();
        true
    }

    pub(crate) fn publish_shell_projection<T>(&self, process: &str, publish: impl FnOnce() -> T) -> Option<T> {
        let inner = self.lock();
        let valid = inner.owners.values().any(|r| matches!(&r.state,
            OwnerState::Placing { stage: Some(s), staged_exited: false, .. } if s.process == process));
        valid.then(publish)
    }

    pub(crate) fn detach_idle(&self, channel: HostChannel, epoch: u64, detach: impl FnOnce() -> bool) -> bool {
        let mut inner = self.lock();
        if inner.owners.values().any(|r| owners::shell_of(&r.state).is_some_and(|s|
            matches!(&s.stage, ShellStage::Hosted(h) if h.channel == channel)))
            || inner.keys.iter().any(|((c, _), r)| *c == channel && matches!(r.state, KeyState::Held(_) | KeyState::Bound(_)))
            || !inner.channels.get(&channel).and_then(|c| c.connection.as_ref()).is_some_and(|c| c.epoch == epoch)
            || !detach() { return false; }
        self.disconnect_inner(&mut inner, channel, epoch);
        true
    }

    pub(crate) fn close_original(&self, identity: &SessionIdentity) -> bool {
        let mut inner = self.lock();
        if !Self::matches_session(&inner, identity) { return false; }
        self.routes.remove_key(identity.channel, &identity.key);
        Self::end(&mut inner, identity.channel, &identity.key, CloseState::Pending);
        true
    }

    pub(crate) fn cleanup_session_projection(&self, channel: HostChannel, key: &str, process: &str, cleanup: impl FnOnce()) -> bool {
        let inner = self.lock();
        let original = match inner.keys.get(&(channel, key.into())).map(|r| &r.state) {
            Some(KeyState::Bound(pc)) => pc == process,
            Some(KeyState::Held(cg)) => inner.owners.values().any(|r| r.cg == *cg
                && owners::shell_of(&r.state).is_some_and(|s| s.process == process)),
            _ => true,
        };
        if original { cleanup(); }
        original
    }

    pub(crate) fn with_registered_on<T>(&self, process: &str, channel: HostChannel, key: &str, epoch: u64, effect: impl FnOnce() -> T) -> Option<T> {
        let inner = self.lock();
        if !inner.channels.get(&channel).and_then(|c| c.connection.as_ref()).is_some_and(|c| c.epoch == epoch) { return None; }
        let valid = inner.owners.values().any(|r| matches!(&r.state, OwnerState::Registered(s)
            if s.process == process && matches!(&s.stage, ShellStage::Hosted(h) if h.channel == channel && h.key == key)))
            && inner.keys.get(&(channel, key.into())).map(|r| &r.state) == Some(&KeyState::Bound(process.into()));
        valid.then(effect)
    }

    /// User mutations require a Registered row and its Bound key through enqueue.
    pub(crate) fn with_registered<T>(&self, process: &str, effect: impl FnOnce(&StagedShell) -> T) -> Option<T> {
        let inner = self.lock();
        let shell = inner.owners.values().find_map(|r| match &r.state {
            OwnerState::Registered(s) if s.process == process => Some(s), _ => None,
        })?;
        if let ShellStage::Hosted(h) = &shell.stage {
            if inner.keys.get(&(h.channel, h.key.clone())).map(|r| &r.state) != Some(&KeyState::Bound(process.into())) { return None; }
        }
        Some(effect(shell))
    }

    pub(crate) fn with_metadata<T>(&self, process: &str, effect: impl FnOnce(&str) -> T) -> Option<T> {
        let inner = self.lock();
        let valid = inner.owners.values().any(|r| match &r.state {
            OwnerState::Registered(s) => s.process == process,
            OwnerState::Placing { stage: Some(s), staged_exited: false, .. } => s.process == process,
            _ => false,
        });
        valid.then(|| effect(process))
    }
}
