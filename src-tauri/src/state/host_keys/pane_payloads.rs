//! The drag broker routes UI tokens, not shell ownership. Queued notifications
//! carry their original page so a delayed delivery cannot target a reused label.

use super::*;

impl HostKeys {
    fn transfer_source(inner: &Inner, label: &str, pg: u64, tx: &str) -> Result<PageIdentity, String> {
        let page = inner.window_pages.sender(label, pg)?;
        let transfer = inner.panes.transfers.get(tx).ok_or("transfer has ended")?;
        if transfer.source != pg || transfer.destination.is_some() { return Err("transfer is not staged by caller".into()); }
        Ok(page)
    }

    pub(crate) fn watch_transfer(&self, label: &str, pg: u64, tx: &str) -> Result<tokio::sync::watch::Receiver<Option<bool>>, String> {
        let mut inner = self.lock();
        inner.window_pages.sender(label, pg)?;
        if let Some(transfer) = inner.panes.transfers.get_mut(tx) {
            if transfer.source != pg { return Err("transfer has ended".into()); }
            transfer.observed = true;
            return Ok(transfer.taken.subscribe());
        }
        let &(source, outcome) = inner.panes.transfer_outcomes.get(tx).filter(|(source, _)| *source == pg).ok_or("transfer has ended")?;
        debug_assert_eq!(source, pg);
        inner.panes.transfer_outcomes.remove(tx);
        inner.panes.transfer_outcome_order.retain(|token| token != tx);
        let (_, receiver) = tokio::sync::watch::channel(Some(outcome));
        Ok(receiver)
    }

    pub(crate) fn verify_transfer_source(&self, label: &str, pg: u64, tx: &str) -> Result<(), String> {
        let mut inner = self.lock();
        Self::expire_transfers_locked(&mut inner, Instant::now());
        Self::transfer_source(&inner, label, pg, tx).map(|_| ())
    }

    pub(crate) fn begin_pane_drag(&self, label: &str, pg: u64, tx: &str, deliver: impl FnOnce(serde_json::Value) + Send + 'static, ended: impl FnOnce(String) + Send + 'static) -> Result<(), String> {
        let delivery = self.delivery_sender();
        let mut inner = self.lock();
        Self::expire_transfers_locked(&mut inner, Instant::now());
        let page = Self::transfer_source(&inner, label, pg, tx)?;
        if inner.panes.active_drag.is_some() { return Err("another pane drag is active".into()); }
        let token = tx.to_string();
        inner.panes.active_drag = Some(ActiveDrag { token: token.clone(), delivery: delivery.clone(), ended: Box::new(move || ended(token)) });
        let notice = serde_json::json!({ "token": tx, "target": label, "pg": page.pg, "wi": page.wi });
        delivery.send(Box::new(move || deliver(notice))).map_err(|e| e.to_string())
    }

    pub(crate) fn claim_pane_drag(&self, label: &str, pg: u64, tx: &str, deliver: impl FnOnce(Option<serde_json::Value>, String) + Send + 'static) -> Result<Option<serde_json::Value>, String> {
        let delivery = self.delivery_sender();
        let mut inner = self.lock();
        Self::expire_transfers_locked(&mut inner, Instant::now());
        let page = inner.window_pages.sender(label, pg)?;
        if inner.panes.active_drag.as_deref() != Some(tx) { return Ok(None); }
        let transfer = inner.panes.transfers.get(tx).ok_or("transfer has ended")?;
        if transfer.source == page.pg || transfer.destination.is_some() { return Ok(None); }
        let ui = transfer.ui.clone().ok_or("transfer has no UI payload")?;
        let source = inner.window_pages.label_of(transfer.source).map(|(target, wi)|
            serde_json::json!({ "token": tx, "target": target, "wi": wi, "pg": transfer.source }));
        Self::clear_active_drag(&mut inner, tx);
        let token = tx.to_string();
        delivery.send(Box::new(move || deliver(source, token))).map_err(|e| e.to_string())?;
        Ok(Some(ui))
    }

    pub(crate) fn end_pane_drag(&self, label: &str, pg: u64, tx: &str, orphan: bool, deliver: impl FnOnce(String) + Send + 'static) -> Result<bool, String> {
        let delivery = self.delivery_sender();
        let mut inner = self.lock();
        inner.window_pages.sender(label, pg)?;
        if orphan { Self::transfer_source(&inner, label, pg, tx)?; }
        if inner.panes.active_drag.as_deref() != Some(tx) { return Ok(false); }
        Self::transfer_source(&inner, label, pg, tx)?;
        Self::clear_active_drag(&mut inner, tx);
        let token = tx.to_string();
        delivery.send(Box::new(move || deliver(token))).map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub(crate) fn route_pane_transfer(&self, label: &str, pg: u64, tx: &str, target: &str, deliver: impl FnOnce(serde_json::Value) + Send + 'static) -> Result<bool, String> {
        let delivery = self.delivery_sender();
        let mut inner = self.lock();
        Self::expire_transfers_locked(&mut inner, Instant::now());
        let source = Self::transfer_source(&inner, label, pg, tx)?;
        let Some(page) = inner.window_pages.latest_page(target) else { return Ok(false); };
        if source.wi == page.wi { return Ok(false); }
        let notice = serde_json::json!({ "token": tx, "target": target, "wi": page.wi, "pg": page.pg });
        delivery.send(Box::new(move || deliver(notice))).map_err(|e| e.to_string())?;
        Ok(true)
    }
}
