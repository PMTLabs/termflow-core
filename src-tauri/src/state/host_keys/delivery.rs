//! Recovery is committed as an immutable queued delivery. Framework observers
//! may query ownership, so they must run on the other side of the mutex.

use super::*;
use std::sync::mpsc::{channel, Sender};

pub(super) type Delivery = Box<dyn FnOnce() + Send>;
pub(super) type RecoveryIdentity = (HostChannel, String, Option<u64>, u32, std::time::Instant);

impl HostKeys {
    pub(super) fn delivery_sender(&self) -> &Sender<Delivery> {
        self.deliveries.get_or_init(|| {
            let (sender, receiver) = channel::<Delivery>();
            std::thread::spawn(move || {
                while let Ok(deliver) = receiver.recv() {
                    // A failed observer must not stop later recoveries.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(deliver));
                }
            });
            sender
        })
    }

    #[cfg(test)]
    pub(crate) fn pending_deliveries(&self) -> usize { self.lock().pending_deliveries.len() }

    #[cfg(test)]
    pub(crate) fn flush_deliveries(&self) {
        let (sent, received) = channel();
        self.delivery_sender().send(Box::new(move || { let _ = sent.send(()); })).unwrap();
        received.recv_timeout(std::time::Duration::from_secs(3)).expect("recovery delivery fence");
    }
}
