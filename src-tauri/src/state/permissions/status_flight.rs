//! Per-app single-flight: callers arriving during a resolution share one queued
//! trailing resolution, whose snapshot starts after the active resolution ends.
//! Nothing is cached; permission requests never enter this coordinator.
use super::ResolvedPermissionSubject;
use std::{future::Future, pin::Pin, sync::{Arc, Mutex}};
use tokio::sync::watch;

type Resolver<T> = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = T> + Send>> + Send>;
type ResultSlot<T> = watch::Receiver<Option<T>>;
struct Wave<T> { sender: watch::Sender<Option<T>>, receiver: ResultSlot<T>, resolve: Resolver<T> }
struct State<T> { active: Option<ResultSlot<T>>, trailing: Option<Wave<T>> }
pub(crate) struct StatusFlight<T = ResolvedPermissionSubject>(Arc<Mutex<State<T>>>);
impl<T> Clone for StatusFlight<T> { fn clone(&self) -> Self { Self(self.0.clone()) } }
impl<T> Default for StatusFlight<T> {
    fn default() -> Self { Self(Arc::new(Mutex::new(State { active: None, trailing: None }))) }
}
impl<T: Clone + Send + Sync + 'static> StatusFlight<T> {
    pub async fn resolve<F, Fut>(&self, resolve: F) -> T
    where F: FnOnce() -> Fut + Send + 'static, Fut: Future<Output = T> + Send + 'static {
        let mut receiver = {
            let mut state = self.0.lock().unwrap();
            if let Some(wave) = &state.trailing {
                wave.receiver.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                let wave = Wave { sender, receiver: receiver.clone(), resolve: Box::new(move || Box::pin(resolve())) };
                if state.active.is_some() {
                    state.trailing = Some(wave);
                } else {
                    state.active = Some(receiver.clone());
                    let flight = self.clone();
                    tokio::spawn(async move { flight.run(wave).await; });
                }
                receiver
            }
        };
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() { return result; }
            receiver.changed().await.expect("permission inventory worker stopped");
        }
    }
    async fn run(&self, mut wave: Wave<T>) {
        loop {
            let result = (wave.resolve)().await;
            let next = {
                let mut state = self.0.lock().unwrap();
                wave.sender.send_replace(Some(result));
                let next = state.trailing.take();
                state.active = next.as_ref().map(|w| w.receiver.clone());
                next
            };
            match next { Some(next) => wave = next, None => break }
        }
    }
}
