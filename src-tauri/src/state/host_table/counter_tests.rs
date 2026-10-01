use super::*;

#[tokio::test]
async fn epoch_and_holder_exhaustion_refuse_before_publication_or_quiescing() {
    let table = HostTable::new();
    {
        let mut inner = table.shared.lock();
        inner.next_epoch = u64::MAX - 1;
        inner.next_holder = u64::MAX - 1;
    }
    let epoch = table.reserve_epoch().unwrap();
    assert_eq!(epoch, u64::MAX);
    assert!(table.publish(HostChannel::Elevated, epoch));
    assert!(table.reserve_epoch().is_err());
    assert_eq!(table.epoch(HostChannel::Elevated), Some(u64::MAX));
    let holder = table.quiesce(QuiesceReason::Offload, Duration::from_secs(1)).await.unwrap();
    assert_eq!(holder.holder, u64::MAX);
    drop(holder);
    assert!(matches!(table.quiesce(QuiesceReason::Update, Duration::from_secs(1)).await, Err(Busy::Exhausted)));
    assert_eq!(table.lifecycle_reason(), None);
    assert!(table.begin(HostChannel::Elevated).is_ok());
    assert_eq!(table.shared.lock().next_epoch, u64::MAX);
    assert_eq!(table.shared.lock().next_holder, u64::MAX);
}
