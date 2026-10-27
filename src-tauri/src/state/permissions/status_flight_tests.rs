use super::StatusFlight;
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use tokio::sync::{mpsc, Semaphore};
use std::time::Duration;

fn call(flight: StatusFlight<usize>, count: Arc<AtomicUsize>, started: mpsc::UnboundedSender<usize>, release: Arc<Semaphore>) -> tokio::task::JoinHandle<usize> {
    tokio::spawn(async move {
        flight.resolve(move || async move {
            let generation = count.fetch_add(1, Ordering::SeqCst) + 1;
            started.send(generation).unwrap();
            release.acquire().await.unwrap().forget();
            generation
        }).await
    })
}
async fn start(rx: &mut mpsc::UnboundedReceiver<usize>) -> usize {
    tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap()
}
async fn result(task: tokio::task::JoinHandle<usize>) -> usize {
    tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap()
}
async fn settle() { for _ in 0..100 { tokio::task::yield_now().await; } }

#[tokio::test]
async fn trailing_generations_and_no_cache() {
    let flight = StatusFlight::default();
    let count = Arc::new(AtomicUsize::new(0));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let make = || call(flight.clone(), count.clone(), tx.clone(), release.clone());
    let first = make();
    assert_eq!(start(&mut rx).await, 1);
    let joined: Vec<_> = (0..4).map(|_| make()).collect();
    settle().await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    release.add_permits(1);
    assert_eq!(start(&mut rx).await, 2);
    assert_eq!(result(first).await, 1);
    let sixth = make();
    settle().await;
    assert_eq!(count.load(Ordering::SeqCst), 2);
    release.add_permits(1);
    assert_eq!(start(&mut rx).await, 3);
    for task in joined { assert_eq!(result(task).await, 2); }
    release.add_permits(1);
    assert_eq!(result(sixth).await, 3);
    let fresh = make();
    assert_eq!(start(&mut rx).await, 4);
    release.add_permits(1);
    assert_eq!(result(fresh).await, 4);
    assert_eq!(count.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn cancelled_leader_does_not_strand_joiners() {
    let flight = StatusFlight::default();
    let count = Arc::new(AtomicUsize::new(0));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let leader = call(flight.clone(), count.clone(), tx.clone(), release.clone());
    assert_eq!(start(&mut rx).await, 1);
    let joined = call(flight, count, tx, release.clone());
    settle().await;
    leader.abort();
    release.add_permits(1);
    assert_eq!(start(&mut rx).await, 2);
    release.add_permits(1);
    assert_eq!(result(joined).await, 2);
}

// The queued wave belongs to the worker, not to the caller whose resolver it runs (review r4, R4-02).
#[tokio::test]
async fn cancelled_queued_owner_and_promoted_caller_do_not_strand_peers() {
    let flight = StatusFlight::default();
    let count = Arc::new(AtomicUsize::new(0));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let make = || call(flight.clone(), count.clone(), tx.clone(), release.clone());
    let leader = make();
    assert_eq!(start(&mut rx).await, 1);
    let owner = make();
    settle().await;
    let cancelled_after_promotion = make();
    let survivor = make();
    settle().await;
    owner.abort();
    release.add_permits(1);
    assert_eq!(start(&mut rx).await, 2);
    assert_eq!(result(leader).await, 1);
    cancelled_after_promotion.abort();
    settle().await;
    release.add_permits(1);
    assert_eq!(result(survivor).await, 2);
    assert_eq!(count.load(Ordering::SeqCst), 2);
}
