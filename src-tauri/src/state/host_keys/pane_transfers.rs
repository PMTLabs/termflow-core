use super::*;

impl HostKeys {
    pub(super) fn stash_panes(inner: &mut Inner, page: PageIdentity, tx: &str, pairs: Vec<PaneEntry>, now: Instant) -> PaneResult {
        if tx.is_empty() || inner.panes.transfers.contains_key(tx) { return rejected("transfer token already staged or empty"); }
        let mut leaves = std::collections::HashSet::new();
        for pair in &pairs {
            if pair.pi.pg != page.pg || !leaves.insert(pair.descriptor.leaf.clone()) { return rejected("invalid transfer members"); }
            let allowed = match inner.owners.get(&pair.descriptor.leaf) {
                Some(row) => Self::authority(inner, &row.owner, &pair.descriptor.leaf, pair.pi) && !matches!(row.state, OwnerState::Closing(_)),
                None => inner.panes.present.get(&pair.pi) == Some(&pair.descriptor),
            };
            if !allowed { return PaneResult::Contended; }
        }
        for pair in &pairs {
            let leaf = &pair.descriptor.leaf;
            Self::remove_transfer_member(inner, leaf);
            if let Some(row) = inner.owners.get_mut(leaf) { row.owner = Owner::Transfer { tx: tx.into(), taken: false }; }
            else {
                let (outcome, _) = tokio::sync::watch::channel(None);
                inner.owners.insert(leaf.clone(), Row { cg: 0, state: OwnerState::Held, owner: Owner::Transfer { tx: tx.into(), taken: false },
                    admitted_pg: None, started: false, outcome });
            }
            inner.panes.present.remove(&pair.pi);
            // Holder metadata remains keyed by the original pi until registration
            // or abandonment; merely taking a transfer cannot expire it.
        }
        inner.panes.transfers.insert(tx.into(), Transfer { source: page.pg, destination: None, stamp: now, members: pairs });
        PaneResult::Ok
    }
    pub(super) fn take_panes(inner: &mut Inner, pg: u64, tx: &str, now: Instant) -> PaneResult {
        let Some(transfer) = inner.panes.transfers.get(tx).cloned() else { return rejected("transfer is not staged"); };
        if transfer.source == pg {
            Self::finish_transfer(inner, tx, true);
            return PaneResult::Ok;
        }
        if transfer.destination.is_some() { return PaneResult::Contended; }
        let transfer = inner.panes.transfers.get_mut(tx).unwrap();
        transfer.destination = Some(pg);
        transfer.stamp = now;
        let payload = TransferPayload { panes: transfer.members.iter().map(|m| {
            let mut descriptor = m.descriptor.clone();
            descriptor.restore = inner.panes.holders.contains_key(&m.pi);
            descriptor
        }).collect() };
        for row in inner.owners.values_mut() {
            if row.owner == (Owner::Transfer { tx: tx.into(), taken: false }) { row.owner = Owner::Transfer { tx: tx.into(), taken: true }; }
        }
        PaneResult::Taken { payload }
    }
    pub(super) fn adopt_panes(inner: &mut Inner, pg: u64, tx: &str, pairs: Vec<PaneEntry>) -> PaneResult {
        let Some(transfer) = inner.panes.transfers.get(tx).cloned() else { return rejected("transfer is not taken"); };
        if transfer.destination != Some(pg) { return PaneResult::Contended; }
        if !Self::validate_entries(inner, pg, &pairs) { return rejected("invalid or reused pane incarnation"); }
        let mut leaves = std::collections::HashSet::new();
        if !pairs.iter().all(|p| leaves.insert(p.descriptor.leaf.clone()) && transfer.members.iter().any(|m| m.descriptor.leaf == p.descriptor.leaf)) {
            return rejected("pane is not a transfer member");
        }
        // Install only the holder capability carried by the transfer, not a
        // caller-supplied restore flag after registration already ended it.
        let entries: Vec<_> = pairs.into_iter().map(|mut pair| {
            let source = transfer.members.iter().find(|m| m.descriptor.leaf == pair.descriptor.leaf).unwrap();
            pair.descriptor.restore = inner.panes.holders.contains_key(&source.pi);
            pair.descriptor.override_key = source.descriptor.override_key.clone();
            pair
        }).collect();
        Self::insert_panes(inner, pg, &entries);
        for member in &transfer.members {
            let leaf = &member.descriptor.leaf;
            let owns = inner.owners.get(leaf).is_some_and(|r| r.owner == (Owner::Transfer { tx: tx.into(), taken: true }));
            if owns {
                if let Some(entry) = entries.iter().find(|e| &e.descriptor.leaf == leaf) {
                    inner.owners.get_mut(leaf).unwrap().owner = Owner::Pane(entry.pi);
                } else if !Self::remove_held(inner, leaf) { inner.owners.get_mut(leaf).unwrap().owner = Owner::Orphaned; }
            }
            inner.panes.holders.remove(&member.pi);
        }
        inner.panes.transfers.remove(tx);
        PaneResult::Ok
    }
    pub(super) fn cancel_panes(inner: &mut Inner, tx: &str) -> PaneResult {
        if !inner.panes.transfers.contains_key(tx) { return rejected("transfer has ended"); }
        Self::finish_transfer(inner, tx, true);
        PaneResult::Ok
    }
    fn finish_transfer(inner: &mut Inner, tx: &str, cancel: bool) {
        let Some(transfer) = inner.panes.transfers.remove(tx) else { return; };
        let source_live = inner.window_pages.window_of(transfer.source).is_some();
        for member in &transfer.members {
            let leaf = &member.descriptor.leaf;
            if inner.owners.get(leaf).is_some_and(|r| matches!(&r.owner, Owner::Transfer { tx: owner_tx, .. } if owner_tx == tx))
                && !Self::remove_held(inner, leaf) {
                inner.owners.get_mut(leaf).unwrap().owner = if cancel && source_live { Owner::Parked { pg: transfer.source, by: member.pi } } else { Owner::Orphaned };
            }
            inner.panes.holders.remove(&member.pi);
        }
    }
    pub(crate) fn expire_transfers(&self, now: Instant) { Self::expire_transfers_locked(&mut self.lock(), now); }
    pub(super) fn expire_transfers_locked(inner: &mut Inner, now: Instant) {
        let expired: Vec<_> = inner.panes.transfers.iter().filter(|(_, t)| now.saturating_duration_since(t.stamp) >= TRANSFER_DEADLINE
            || t.destination.is_some_and(|pg| inner.window_pages.window_of(pg).is_none())).map(|(tx, _)| tx.clone()).collect();
        for tx in expired { Self::finish_transfer(inner, &tx, false); }
    }
    pub(in crate::state::host_keys) fn end_pane_pages(inner: &mut Inner, ended: &[PageIdentity]) {
        let pages: std::collections::HashSet<_> = ended.iter().map(|p| p.pg).collect();
        let leaves: Vec<_> = inner.owners.iter().filter(|(_, r)| match r.owner {
            Owner::Pane(pi) => pages.contains(&pi.pg),
            Owner::Parked { pg, .. } => pages.contains(&pg),
            _ => false,
        }).map(|(leaf, _)| leaf.clone()).collect();
        for leaf in leaves {
            if !Self::remove_held(inner, &leaf) { inner.owners.get_mut(&leaf).unwrap().owner = Owner::Orphaned; }
        }
        let abandoned: Vec<_> = inner.panes.transfers.iter().filter(|(_, t)| t.destination.is_some_and(|pg| pages.contains(&pg))).map(|(tx, _)| tx.clone()).collect();
        for tx in abandoned { Self::finish_transfer(inner, &tx, false); }
        // Staged/Taken source members keep their restore capability until the
        // transfer ends; ordinary page holders end with their pane membership.
        let carried: std::collections::HashSet<_> = inner.panes.transfers.values().flat_map(|t| t.members.iter().map(|m| m.pi)).collect();
        inner.panes.holders.retain(|pi, _| !pages.contains(&pi.pg) || carried.contains(pi));
        inner.panes.present.retain(|pi, _| !pages.contains(&pi.pg));
        for pg in pages { inner.panes.streams.remove(&pg); inner.panes.incarnation_high.remove(&pg); }
    }
    pub(super) fn remove_transfer_member(inner: &mut Inner, leaf: &str) {
        let tx = inner.owners.get(leaf).and_then(|r| match &r.owner { Owner::Transfer { tx, .. } => Some(tx.clone()), _ => None });
        if let Some(tx) = tx {
            if let Some(transfer) = inner.panes.transfers.get_mut(&tx) {
                transfer.members.retain(|m| m.descriptor.leaf != leaf);
                if transfer.members.is_empty() { inner.panes.transfers.remove(&tx); }
            }
        }
    }
}
