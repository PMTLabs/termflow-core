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
        let inner = self.lock();
        inner.window_pages.sender(label, pg)?;
        let transfer = inner.panes.transfers.get(tx).filter(|t| t.source == pg).ok_or("transfer has ended")?;
        Ok(transfer.taken.subscribe())
    }

    pub(crate) fn verify_transfer_source(&self, label: &str, pg: u64, tx: &str) -> Result<(), String> {
        let mut inner = self.lock();
        Self::expire_transfers_locked(&mut inner, Instant::now());
        Self::transfer_source(&inner, label, pg, tx).map(|_| ())
    }

    pub(crate) fn begin_pane_drag(&self, label: &str, pg: u64, tx: &str, deliver: impl FnOnce(serde_json::Value) + Send + 'static) -> Result<(), String> {
        let mut inner = self.lock();
        Self::expire_transfers_locked(&mut inner, Instant::now());
        let page = Self::transfer_source(&inner, label, pg, tx)?;
        if inner.panes.active_drag.is_some() { return Err("another pane drag is active".into()); }
        inner.panes.active_drag = Some(tx.into());
        let notice = serde_json::json!({ "token": tx, "target": label, "pg": page.pg, "wi": page.wi });
        self.delivery_sender().send(Box::new(move || deliver(notice))).map_err(|e| e.to_string())
    }

    pub(crate) fn claim_pane_drag(&self, label: &str, pg: u64, tx: &str, deliver: impl FnOnce(Option<serde_json::Value>, String) + Send + 'static) -> Result<Option<serde_json::Value>, String> {
        let mut inner = self.lock();
        Self::expire_transfers_locked(&mut inner, Instant::now());
        let page = inner.window_pages.sender(label, pg)?;
        if inner.panes.active_drag.as_deref() != Some(tx) { return Ok(None); }
        let transfer = inner.panes.transfers.get(tx).ok_or("transfer has ended")?;
        if transfer.source == page.pg || transfer.destination.is_some() { return Ok(None); }
        let ui = transfer.ui.clone().ok_or("transfer has no UI payload")?;
        let source = inner.window_pages.label_of(transfer.source).map(|(target, wi)|
            serde_json::json!({ "token": tx, "target": target, "wi": wi, "pg": transfer.source }));
        inner.panes.active_drag = None;
        let token = tx.to_string();
        self.delivery_sender().send(Box::new(move || deliver(source, token))).map_err(|e| e.to_string())?;
        Ok(Some(ui))
    }

    pub(crate) fn end_pane_drag(&self, label: &str, pg: u64, tx: &str, orphan: bool, deliver: impl FnOnce(String) + Send + 'static) -> Result<bool, String> {
        let mut inner = self.lock();
        inner.window_pages.sender(label, pg)?;
        if orphan { Self::transfer_source(&inner, label, pg, tx)?; }
        if inner.panes.active_drag.as_deref() != Some(tx) { return Ok(false); }
        Self::transfer_source(&inner, label, pg, tx)?;
        inner.panes.active_drag = None;
        let token = tx.to_string();
        self.delivery_sender().send(Box::new(move || deliver(token))).map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub(crate) fn route_pane_transfer(&self, label: &str, pg: u64, tx: &str, target: &str, deliver: impl FnOnce(serde_json::Value) + Send + 'static) -> Result<bool, String> {
        let mut inner = self.lock();
        Self::expire_transfers_locked(&mut inner, Instant::now());
        let source = Self::transfer_source(&inner, label, pg, tx)?;
        let Some(page) = inner.window_pages.latest_page(target) else { return Ok(false); };
        if source.wi == page.wi { return Ok(false); }
        let notice = serde_json::json!({ "token": tx, "target": target, "wi": page.wi, "pg": page.pg });
        self.delivery_sender().send(Box::new(move || deliver(notice))).map_err(|e| e.to_string())?;
        Ok(true)
    }
}
