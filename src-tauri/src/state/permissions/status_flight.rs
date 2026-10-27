//! Per-app single-flight. Overlapping callers share the active result, not a
//! stale cache. A later wave starts one trailing resolution; callers overlapping
//! that wave share it too. Requests never enter this coordinator.
use super::ResolvedPermissionSubject;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

type ResultSlot = watch::Receiver<Option<ResolvedPermissionSubject>>;
#[derive(Clone, Default)]
pub(crate) struct StatusFlight(Arc<Mutex<Option<ResultSlot>>>);

impl StatusFlight {
    pub async fn resolve<F, Fut>(&self, resolve: F) -> ResolvedPermissionSubject
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ResolvedPermissionSubject> + Send + 'static,
    {
        let mut receiver = {
            let mut active = self.0.lock().unwrap();
            if let Some(receiver) = active.as_ref() {
                receiver.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                *active = Some(receiver.clone());
                let flight = self.clone();
                // A canceled caller must not strand the other callers or keep
                // an unpolled future (and its AppState) alive indefinitely.
                tokio::spawn(async move {
                    let result = resolve().await;
                    let mut active = flight.0.lock().unwrap();
                    sender.send_replace(Some(result));
                    *active = None;
                });
                receiver
            }
        };
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() { return result; }
            receiver.changed().await.expect("permission inventory worker stopped");
        }
    }
}
