use super::*;
use crate::ssh::session::{append_metrics_bounded, ExecCleanupFailure};
use tokio_util::sync::CancellationToken;

fn options() -> ExecOpts {
    ExecOpts {
        deadline: DEADLINE,
        stdout_cap: WIRE_STDOUT_CAP,
        stderr_cap: WIRE_STDERR_CAP,
        cancel: CancellationToken::new(),
    }
}

async fn exec(lease: &SshSession, opts: ExecOpts) -> (ExecOutcome, String) {
    let (command, nonce) = collector_command();
    (lease.exec_with_cleanup(&command, opts).await, nonce)
}

async fn wait_close(wire: &Wire, after: usize) {
    timeout(WAIT, async {
        while wire.closed.closed_channels.load(SeqCst) <= after || wire.pumps.load(SeqCst) != 0 {
            sleep(Duration::from_millis(2)).await;
        }
    }).await.expect("server observed exec close and stopped streaming");
}

async fn realpath(sftp: &crate::ssh::session::SftpLease) {
    let names = timeout(WAIT, sftp.request(|sftp| Box::pin(async move {
        sftp.realpath(".").await.map_err(|_| SessionError::TransportClosed)
    }))).await.unwrap().unwrap();
    assert_eq!(names.files.len(), 1);
    assert_eq!(names.files[0].filename, "/");
}

#[tokio::test]
async fn timeout_closes_only_exec_and_sftp_still_works() {
    let (f, wire, events, sampler) = rig([Reply::Hang]);
    let (_, lease) = f.connected().await;
    let sftp = lease.sftp().await.unwrap();
    realpath(&sftp).await;
    let fence = sampler.fence(A).unwrap();
    assert_eq!(fence.pause_seq, 0);
    sampler.set_eligible(A, true).unwrap();
    let start = wire.started(1).await;
    assert_eq!(events.event("ssh-metrics:control", 0).await, json!({
        "terminalId": A, "generation": fence.generation, "pauseSeq": 1,
        "pausedReason": "Metrics paused: host didn't answer in 5 s"
    }));
    assert!((Duration::from_millis(4900)..Duration::from_millis(5600)).contains(&start.elapsed()));
    wait_close(&wire, 0).await;
    assert_eq!(wire.closed.closed_channels.load(SeqCst), 1);
    assert_eq!(events.events.lock().len(), 1); // No timeout telemetry.
    assert_eq!(wire.count(), 1);
    assert_eq!(f.registry.state(A, false).unwrap().state, SessionState::Connected);
    assert_eq!(f.server.counters.live_connections.load(SeqCst), 1);
    assert!(Arc::ptr_eq(&lease, &f.registry.lease(A).unwrap()));
    realpath(&sftp).await; // New request/reply on the same cached subsystem, not just an Arc check.
    let resumed = sampler.resume(A).unwrap();
    assert_eq!(events.event(CONTROL, 1).await["pauseSeq"], 2);
    assert_eq!(resumed.pause_seq, 2);
    assert_warming(&events.event(SAMPLE, 0).await);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn oversized_stream_is_stopped_before_cap_allocation() {
    let (f, wire, events, sampler) = rig([
        Reply::Flood { stdout: WIRE_STDOUT_CAP + 1, stderr: 0 },
        Reply::Flood { stdout: 0, stderr: WIRE_STDERR_CAP + 1 },
        Reply::AtCaps,
    ]);
    connect(&f, A).await;
    sampler.set_eligible(A, true).unwrap();
    for i in 0..2 {
        let at = wire.started(i + 1).await;
        let sample = events.event(SAMPLE, i).await;
        assert_unavailable(&sample, "Metrics output exceeded limit");
        assert!(at.elapsed() < DEADLINE, "overflow was not stopped by the incremental reader");
        wait_close(&wire, i).await;
    }
    assert_warming(&events.event(SAMPLE, 2).await);
    assert_eq!(wire.count(), 3);

    // Inspect the same production append used by both real reader branches.
    // Irregular accepted chunks must not make geometric growth exceed the cap;
    // the first rejected chunk must not grow or relocate the backing buffer.
    for cap in [WIRE_STDOUT_CAP, WIRE_STDERR_CAP] {
        let mut buffer = Vec::new();
        let chunks = [vec![1; cap - 19], vec![2; 18]];
        for chunk in chunks { append_metrics_bounded(&mut buffer, &chunk, cap).unwrap(); }
        assert_eq!(buffer.len(), cap - 1);
        assert!(buffer.capacity() <= cap);
        let allocation = (buffer.as_ptr(), buffer.capacity());
        assert_eq!(append_metrics_bounded(&mut buffer, &[3, 4], cap), Err(SessionError::OutputTooLarge));
        assert_eq!((buffer.as_ptr(), buffer.capacity()), allocation);
        assert_eq!(buffer.len(), cap - 1);
        assert_eq!(buffer.last(), Some(&2));
    }
    f.registry.shutdown().await;
}

#[tokio::test]
async fn production_exec_reader_bounds_both_streams() {
    let (f, wire, _, _) = rig([
        Reply::Flood { stdout: usize::MAX, stderr: 0 },
        Reply::Flood { stdout: 0, stderr: usize::MAX },
        Reply::Flood { stdout: usize::MAX, stderr: usize::MAX },
        Reply::BadBytes(vec![0xff]), Reply::BadBytes(vec![0]),
        Reply::NoAck, Reply::NoStatus, Reply::NoClose, Reply::Hang, Reply::Good,
    ]);
    let (_, lease) = f.connected().await;
    let sftp = lease.sftp().await.unwrap();
    realpath(&sftp).await;
    for closed in 0..3 {
        let (result, _) = exec(&lease, options()).await;
        assert_eq!(result.result, Err(SessionError::OutputTooLarge));
        assert_eq!(result.cleanup_failure, None);
        wait_close(&wire, closed).await;
    }
    for bad in [0xffu8, 0] {
        let (result, nonce) = exec(&lease, options()).await;
        assert_eq!(result.result.as_ref().unwrap().stdout[..2], [bad, b'\n']);
        assert!(matches!(classify(&result, &nonce), Reading::Unavailable("Invalid metrics framing")));
    }
    for expected in [SessionError::CapabilityUnavailable, SessionError::MissingExitStatus] {
        let (result, _) = exec(&lease, options()).await;
        assert_eq!(result.result, Err(expected));
    }
    let (result, _) = exec(&lease, ExecOpts { deadline: Duration::from_millis(300), ..options() }).await;
    assert_eq!(result.result, Err(SessionError::TimedOut)); // Complete frame and exit, but no CLOSE.
    let close_before_cancel = wire.closed.closed_channels.load(SeqCst);
    let cancel = CancellationToken::new();
    let runner = {
        let (lease, token) = (lease.clone(), cancel.clone());
        tokio::spawn(async move { exec(&lease, ExecOpts { cancel: token, ..options() }).await })
    };
    wire.started(9).await;
    cancel.cancel();
    let (result, _) = timeout(WAIT, runner).await.unwrap().unwrap();
    assert_eq!(result.result, Err(SessionError::Cancelled));
    assert_eq!(result.cleanup_failure, None);
    wait_close(&wire, close_before_cancel).await;
    let (ok, nonce) = exec(&lease, options()).await;
    assert!(matches!(classify(&ok, &nonce), Reading::Sample(_)));
    assert_eq!(wire.pumps.load(SeqCst), 0);
    assert_eq!(wire.count(), 10);
    realpath(&sftp).await;
    assert_eq!(f.server.counters.subsystems.load(SeqCst), 1);
    f.registry.shutdown().await;
}

#[tokio::test]
async fn real_exec_reader_reports_cleanup_failures_without_changing_legacy_errors() {
    use ExecCleanupFailure::*;
    let (f, wire, events, _) = rig((0..10).map(|_| Reply::Flood { stdout: 0, stderr: WIRE_STDERR_CAP + 16 }));
    let (_, lease) = f.connected().await;
    let worker = Terminal::new(A);
    worker.set_eligible(true).unwrap();
    let without_fault = admit(&worker, &f, &events, 100);
    deliver(&worker, &f, &events, &without_fault).await;
    assert_unavailable(&events.event(SAMPLE, 0).await, "Metrics output exceeded limit");
    for (index, fault) in [CloseFailed, CloseTimedOut, ReaderJoinFailed].into_iter().enumerate() {
        let expected = if fault == ReaderJoinFailed { SessionError::TransportClosed } else { SessionError::OutputTooLarge };
        let (command, _) = collector_command();
        *lease.next_exec_cleanup_fault.lock() = Some(fault);
        assert_eq!(lease.exec_with(&command, options()).await, Err(expected.clone()));
        *lease.next_exec_cleanup_fault.lock() = Some(fault);
        let at = Instant::now();
        let (diagnostic, _) = exec(&lease, options()).await;
        assert_eq!(diagnostic.cleanup_failure, Some(fault));
        assert_eq!(diagnostic.result, Err(expected));
        if fault == CloseTimedOut { assert!(at.elapsed() >= Duration::from_millis(250)); }
        let tick = admit(&worker, &f, &events, 200 + index as u64);
        *lease.next_exec_cleanup_fault.lock() = Some(fault);
        deliver(&worker, &f, &events, &tick).await;
        let pause = events.event(CONTROL, 2 * index).await;
        assert_eq!(pause["pauseSeq"], (2 * index + 1) as u64);
        assert_eq!(pause["pausedReason"], "Metrics paused: could not clean up metrics exec");
        assert!(matches!(worker.plan_tick(&f.registry, &*events, Instant::now(), wall_now_ms), Action::Wait(_)));
        worker.fence(&f.registry, &*events, true).unwrap();
    }
    assert_eq!(events.events.lock().iter().filter(|(name, _)| *name == SAMPLE).count(), 1);
    assert_eq!(wire.count(), 10);
    f.registry.shutdown().await;
}

#[test]
fn every_session_error_is_classified_without_host_debug_text() {
    use SessionError::*;
    for (error, class) in [
        (TimedOut, TIMEOUT), (OutputTooLarge, "Metrics output exceeded limit"),
        (CapabilityUnavailable, "Metrics exec unavailable"), (TransportClosed, "Metrics transport closed"),
        (MissingExitStatus, "Metrics exit status missing"), (Cancelled, "discard"),
        (NotConnected, "disarm"), (NotFound, "disarm"), (StaleAttempt, "disarm"),
        (OwnerRetired, "disarm"), (AdmissionClosed, "disarm"), (InvalidTarget, "disarm"),
        (HostKeyChanged, "disarm"), (HostKeyRevoked, "disarm"), (HostCertificateUnsupported, "disarm"),
        (KnownHostsMalformed { line: 31337 }, "disarm"), (KnownHostsUnreadable, "disarm"),
        (TrustWriteFailed, "disarm"), (TrustAlreadyPinned, "disarm"), (AuthRejected, "disarm"),
        (AgentUnavailable, "disarm"), (IdentityUnreadable, "disarm"), (UnsupportedAuthentication, "disarm"),
        (RememberUnavailable, "disarm"), (StoreUnavailable, "disarm"),
    ] {
        let outcome = ExecOutcome::from(error.clone());
        assert_eq!(match classify(&outcome, "unused") {
            Reading::Unavailable(reason) => reason,
            Reading::IndeterminateRemoteWork { reason, completed: None } => reason,
            Reading::Discard { disarm: false } => "discard",
            Reading::Discard { disarm: true } => "disarm",
            _ => panic!("unexpected sample from {error:?}"),
        }, class, "{error:?}");
    }
}
