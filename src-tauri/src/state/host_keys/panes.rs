//! Pane-copy authority and the ordered page command stream. Host work is returned
//! as immutable process effects and executed only after releasing ownership.

use super::*;
use super::owners::{Row, shell_of};
use super::pages::PageIdentity;
use std::time::{Duration, Instant};

#[path = "pane_transfers.rs"]
mod transfers;
#[path = "pane_payloads.rs"]
mod payloads;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub(crate) struct PaneIdentity { pub pg: u64, pub seq: u64 }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Owner {
    Pane(PaneIdentity),
    Parked { pg: u64, by: PaneIdentity },
    Transfer { tx: String, taken: bool },
    Orphaned,
    Headless,
    #[allow(dead_code)]
    Offered(u64),
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaneDescriptor {
    pub pane_id: String,
    pub leaf: String,
    #[serde(default)] pub restore: bool,
    #[serde(rename = "override", skip_serializing_if = "Option::is_none")] pub override_key: Option<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct PaneEntry { #[serde(flatten)] pub descriptor: PaneDescriptor, pub pi: PaneIdentity }
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(untagged)]
pub(crate) enum BindVia { Named(String), Offer { offer: u64 } }
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum PaneOp {
    Enter { panes: Vec<PaneEntry> },
    Depart { pi: PaneIdentity },
    AdmitCreate { pi: PaneIdentity, mode: CreateMode },
    Bind { pi: PaneIdentity, pc: String, via: BindVia },
    Close { pi: PaneIdentity },
    Stash { tx: String, pairs: Vec<PaneEntry>, #[serde(default)] ui: Option<serde_json::Value> },
    Take { tx: String },
    Adopt { tx: String, pairs: Vec<PaneEntry> },
    Cancel { tx: String },
    Settle,
}
#[derive(Clone, Debug, serde::Deserialize)]
pub(crate) struct PaneRequest { pub pg: u64, pub seq: u64, pub op: PaneOp }
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status")]
pub(crate) enum PaneResult {
    Ok, Retry, Pending, Contended,
    Create { cg: u64 }, Join { cg: u64 },
    Existing { pc: String }, AlreadyBound { pc: String },
    Taken { payload: TransferPayload },
    Rejected { message: String },
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct TransferPayload {
    pub panes: Vec<PaneDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")] pub ui: Option<serde_json::Value>,
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status")]
pub(crate) enum PaneReply {
    Ack { result: PaneResult },
    Resync { #[serde(rename = "nextSeq")] next_seq: u64 },
}
#[derive(Clone)]
pub(super) struct Stream { pub next: u64, pub last: Option<(u64, PaneResult)> }
#[derive(Default)]
pub(super) struct PaneTable {
    pub streams: HashMap<u64, Stream>,
    pub present: HashMap<PaneIdentity, PaneDescriptor>,
    // Incarnations may never re-enter, including after close or depart.
    pub incarnation_high: HashMap<u64, u64>,
    pub holders: HashMap<PaneIdentity, super::restore::Aliases>,
    pub transfers: HashMap<String, Transfer>,
    pub active_drag: Option<String>,
}
#[derive(Clone)]
pub(super) struct Transfer {
    pub source: u64,
    pub destination: Option<u64>,
    pub stamp: Instant,
    pub members: Vec<PaneEntry>,
    pub ui: Option<serde_json::Value>,
    pub taken: tokio::sync::watch::Sender<Option<bool>>,
}
pub(crate) const TRANSFER_DEADLINE: Duration = Duration::from_secs(60);

#[derive(Default, Debug)]
pub(crate) struct PaneEffects { pub closes: Vec<String>, pub wake_transfers: bool, pub release_restore_sweep: bool }

fn rejected(message: &str) -> PaneResult { PaneResult::Rejected { message: message.into() } }
impl HostKeys {
    pub(crate) fn pane_op(&self, label: &str, request: PaneRequest) -> Result<(PaneReply, PaneEffects), String> {
        self.pane_op_at(label, request, Instant::now())
    }

    pub(crate) fn pane_op_at(&self, label: &str, request: PaneRequest, now: Instant) -> Result<(PaneReply, PaneEffects), String> {
        let mut inner = self.lock();
        let page = inner.window_pages.sender(label, request.pg)?;
        let stream = inner.panes.streams.get(&page.pg).ok_or("page stream ended")?;
        if let Some((seq, result)) = &stream.last {
            if *seq == request.seq { return Ok((PaneReply::Ack { result: result.clone() }, PaneEffects::default())); }
        }
        if request.seq != stream.next { return Ok((PaneReply::Resync { next_seq: stream.next }, PaneEffects::default())); }
        let next = stream.next.checked_add(1).ok_or("page op sequence exhausted")?;
        Self::expire_transfers_locked(&mut inner, now);
        let timed = matches!(&request.op, PaneOp::Stash { .. } | PaneOp::Take { .. });
        let mut effects = PaneEffects::default();
        let result = Self::apply_pane_op(&mut inner, page, request.op, now, &mut effects);
        effects.wake_transfers = timed && matches!(result, PaneResult::Ok | PaneResult::Taken { .. });
        let stream = inner.panes.streams.get_mut(&page.pg).unwrap();
        stream.next = next;
        stream.last = Some((request.seq, result.clone()));
        Ok((PaneReply::Ack { result }, effects))
    }

    fn apply_pane_op(inner: &mut Inner, page: PageIdentity, op: PaneOp, now: Instant, effects: &mut PaneEffects) -> PaneResult {
        match op {
            PaneOp::Enter { panes } => Self::enter_panes(inner, page.pg, &panes),
            PaneOp::AdmitCreate { pi, mode } => {
                let Some(descriptor) = Self::present_pane(inner, page.pg, pi).cloned() else { return rejected("pane is not present in sender page"); };
                Self::admit_pane(inner, page, pi, &descriptor.leaf, mode)
            }
            PaneOp::Bind { pi, pc, via } => {
                let Some(descriptor) = Self::present_pane(inner, page.pg, pi).cloned() else { return rejected("pane is not present in sender page"); };
                Self::bind_pane(inner, page, pi, &descriptor.leaf, &pc, &via)
            }
            PaneOp::Depart { pi } => {
                if Self::present_pane(inner, page.pg, pi).is_none() { return rejected("pane is not present in sender page"); }
                Self::depart_pane(inner, pi);
                PaneResult::Ok
            }
            PaneOp::Close { pi } => {
                if pi.pg != page.pg { return rejected("pane belongs to another page"); }
                let leaf = inner.owners.iter().find(|(leaf, row)| Self::authority(inner, &row.owner, leaf, pi)).map(|(leaf, _)| leaf.clone());
                Self::forget_pane_holder(inner, pi, leaf.is_some(), now);
                inner.panes.present.remove(&pi);
                let Some(leaf) = leaf else { return PaneResult::Contended; };
                Self::remove_transfer_member(inner, &leaf);
                Self::close_leaf_locked(inner, &leaf, CloseStorage::Delete, &mut effects.closes);
                PaneResult::Ok
            }
            PaneOp::Stash { tx, pairs, ui } => Self::stash_panes(inner, page, &tx, pairs, ui, now),
            PaneOp::Take { tx } => Self::take_panes(inner, page.pg, &tx, now),
            PaneOp::Adopt { tx, pairs } => Self::adopt_panes(inner, page.pg, &tx, pairs),
            PaneOp::Cancel { tx } => Self::cancel_panes(inner, &tx),
            PaneOp::Settle => {
                let ended = inner.window_pages.settle(page).expect("validated sender page");
                Self::end_pages_locked(inner, &ended);
                effects.release_restore_sweep = inner.window_pages.settle_restore_participant(page);
                PaneResult::Ok
            }
        }
    }

    fn present_pane(inner: &Inner, pg: u64, pi: PaneIdentity) -> Option<&PaneDescriptor> {
        if pi.pg != pg { return None; }
        inner.panes.present.get(&pi)
    }
    fn validate_entries(inner: &Inner, pg: u64, entries: &[PaneEntry]) -> bool {
        let mut seqs = std::collections::HashSet::new();
        let high = inner.panes.incarnation_high.get(&pg).copied().unwrap_or(0);
        entries.iter().all(|entry| entry.pi.pg == pg && entry.pi.seq > high
            && seqs.insert(entry.pi.seq) && !entry.descriptor.leaf.is_empty() && !entry.descriptor.leaf.contains('~'))
    }
    fn enter_panes(inner: &mut Inner, pg: u64, entries: &[PaneEntry]) -> PaneResult {
        if !Self::validate_entries(inner, pg, entries) { return rejected("invalid or reused pane incarnation"); }
        Self::insert_panes(inner, pg, entries);
        PaneResult::Ok
    }
    fn insert_panes(inner: &mut Inner, pg: u64, entries: &[PaneEntry]) {
        for entry in entries {
            inner.panes.present.insert(entry.pi, entry.descriptor.clone());
            inner.panes.incarnation_high.entry(pg).and_modify(|high| *high = (*high).max(entry.pi.seq)).or_insert(entry.pi.seq);
            if entry.descriptor.restore && !inner.owners.get(&entry.descriptor.leaf).is_some_and(|r| matches!(r.state, OwnerState::Registered(_) | OwnerState::Closing(_))) {
                Self::register_pane_holder(inner, entry.pi, &entry.descriptor);
            }
        }
    }
    fn authority(inner: &Inner, owner: &Owner, leaf: &str, pi: PaneIdentity) -> bool {
        match owner {
            Owner::Pane(by) | Owner::Parked { by, .. } => *by == pi,
            Owner::Transfer { tx, taken: false } => inner.panes.transfers.get(tx).is_some_and(|t| t.members.iter().any(|m| m.pi == pi && m.descriptor.leaf == leaf)),
            _ => false,
        }
    }
    fn bindable(inner: &Inner, owner: &Owner, page: PageIdentity, via: &BindVia) -> bool {
        match owner {
            Owner::Parked { pg, .. } => inner.window_pages.window_of(*pg) == Some(page.wi),
            Owner::Orphaned => matches!(via, BindVia::Named(v) if v == "restore" || v == "reconcile"),
            Owner::Headless => true,
            // Offers have no producer until recovery delivery is enabled.
            Owner::Offered(ro) => matches!(via, BindVia::Offer { offer } if offer == ro),
            _ => false,
        }
    }
    fn admit_pane(inner: &mut Inner, page: PageIdentity, pi: PaneIdentity, leaf: &str, mode: CreateMode) -> PaneResult {
        if let Some(row) = inner.owners.get(leaf) {
            if matches!(row.state, OwnerState::Closing(_)) { return PaneResult::Pending; }
            if row.owner == Owner::Pane(pi) {
                match &row.state {
                    OwnerState::Registered(s) => return if mode == CreateMode::Mount { PaneResult::AlreadyBound { pc: s.process.clone() } } else { PaneResult::Contended },
                    OwnerState::Placing { .. } => return PaneResult::Join { cg: row.cg },
                    OwnerState::Held => {},
                    OwnerState::Closing(_) => unreachable!(),
                }
            } else if matches!(row.state, OwnerState::Registered(_)) && Self::bindable(inner, &row.owner, page, &BindVia::Named("restore".into())) {
                let row = inner.owners.get_mut(leaf).unwrap();
                row.owner = Owner::Pane(pi);
                let pc = shell_of(&row.state).unwrap().process.clone();
                inner.panes.holders.remove(&pi);
                return PaneResult::Existing { pc };
            } else { return PaneResult::Contended; }
        }
        let Some(cg) = inner.sequence.checked_add(1) else { return PaneResult::Retry; };
        inner.sequence = cg;
        let (outcome, _) = tokio::sync::watch::channel(None);
        inner.owners.insert(leaf.into(), Row { cg, state: OwnerState::Placing { stage: None, staged_exited: false, cancel: None },
            owner: Owner::Pane(pi), admitted_pg: Some(page.pg), started: false, outcome });
        PaneResult::Create { cg }
    }
    fn bind_pane(inner: &mut Inner, page: PageIdentity, pi: PaneIdentity, leaf: &str, pc: &str, via: &BindVia) -> PaneResult {
        let Some(row) = inner.owners.get(leaf) else { return PaneResult::Retry; };
        if !matches!(&row.state, OwnerState::Registered(s) if s.process == pc) { return PaneResult::Contended; }
        if row.owner != Owner::Pane(pi) && !Self::bindable(inner, &row.owner, page, via) { return PaneResult::Contended; }
        inner.owners.get_mut(leaf).unwrap().owner = Owner::Pane(pi);
        inner.panes.holders.remove(&pi);
        PaneResult::Ok
    }
    fn depart_pane(inner: &mut Inner, pi: PaneIdentity) {
        let leaves: Vec<_> = inner.owners.iter().filter(|(_, r)| r.owner == Owner::Pane(pi)).map(|(l, _)| l.clone()).collect();
        for leaf in leaves {
            if !Self::release_idle_owner(inner, &leaf) { inner.owners.get_mut(&leaf).unwrap().owner = Owner::Parked { pg: pi.pg, by: pi }; }
        }
        inner.panes.present.remove(&pi);
        inner.panes.holders.remove(&pi);
    }
    pub(crate) fn admitted_work(&self, label: &str, pg: u64, leaf: &str, cg: u64) -> Result<CreateAdmission, String> {
        let mut inner = self.lock();
        inner.window_pages.sender(label, pg)?;
        let row = inner.owners.get_mut(leaf).filter(|r| r.cg == cg && (r.admitted_pg == Some(pg) || matches!(r.owner, Owner::Pane(pi) if pi.pg == pg)))
            .ok_or("host-ownership-pending: create has no matching admission")?;
        match &row.state {
            OwnerState::Placing { .. } if !row.started => {
                if !matches!(row.owner, Owner::Pane(pi) if pi.pg == pg) { return Err("host-ownership-pending: create owner changed".into()); }
                row.started = true;
                Ok(CreateAdmission::Run(cg))
            },
            OwnerState::Placing { .. } => Ok(CreateAdmission::Join(row.outcome.subscribe())),
            OwnerState::Registered(s) => Ok(CreateAdmission::Existing(s.process.clone())),
            _ => Err("host-ownership-pending: admitted placement ended".into()),
        }
    }
    pub(crate) fn close_process_reap(&self, pc: &str, reap: bool) -> (PaneResult, Vec<String>) {
        let mut inner = self.lock();
        let leaf = inner.owners.iter().find(|(_, r)| shell_of(&r.state).is_some_and(|s| s.process == pc)).map(|(l, _)| l.clone());
        let Some(leaf) = leaf else { return (PaneResult::Ok, Vec::new()); };
        if reap && !matches!(inner.owners[&leaf].owner, Owner::Parked { .. } | Owner::Orphaned | Owner::Headless) { return (PaneResult::Contended, Vec::new()); }
        let mut effects = Vec::new();
        Self::remove_transfer_member(&mut inner, &leaf);
        Self::close_leaf_locked(&mut inner, &leaf, CloseStorage::Delete, &mut effects);
        (PaneResult::Ok, effects)
    }
    #[cfg(test)]
    pub(crate) fn pane_owner(&self, leaf: &str) -> Option<Owner> { self.lock().owners.get(leaf).map(|r| r.owner.clone()) }
}

#[cfg(test)]
#[path = "pane_table_tests.rs"]
mod tests;
