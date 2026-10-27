use super::*;

fn client() -> (PtyHostClient, tokio::sync::mpsc::UnboundedReceiver<Frame>) {
    let (outbound, out_rx) = unbounded_channel::<Frame>();
    (
        PtyHostClient {
            sessions: Arc::new(Mutex::new(SessionBinding {
                keys: crate::state::HostKeys::default(), channel: crate::elevated_host::HostChannel::Primary, epoch: 0,
            })),
            outbound,
            pending: Arc::new(Mutex::new(HashMap::new())),
            req_ctr: Arc::new(AtomicU64::new(0)),
            survives_hotswap: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            attach_acks: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            shutdown_control: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            inherit_cursor: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            mcp_hold: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            permissions: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            identity_cache: Arc::default(),
            lifecycle: Arc::new(HostRetention::Unknown),
            alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            lifecycle_token: Arc::new("tok".into()),
            conn: conn::ConnState::new(),
            exe_origin: Arc::default(),
            #[cfg(target_os = "macos")]
            permission_identity: Arc::default(),
            before_stdout: Arc::default(),
            claim_observer: Arc::default(),
            release_observer: Arc::default(),
            stdout_observer: Arc::default(),
        },
        out_rx,
    )
}

#[tokio::test]
async fn code_identity_cache_clears_on_pid_change_and_close() {
    use crate::state::permissions::IdentityVerdict;
    use std::sync::atomic::AtomicUsize;
    let (client, _peer, _) = super::conn_tests::wired();
    let count = AtomicUsize::new(0);
    let lookup = |_| { count.fetch_add(1, Ordering::SeqCst); IdentityVerdict::Matches };
    client.set_peer_pid(41);
    client.identity_cache.verify(41, lookup);
    client.identity_cache.verify(41, lookup);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    client.set_peer_pid(42);
    client.set_peer_pid(41);
    client.identity_cache.verify(41, lookup);
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert!(client.close_transport().await);
    client.identity_cache.verify(41, lookup);
    assert_eq!(count.load(Ordering::SeqCst), 3);
    assert_eq!(client.host_identity_verdict(41), IdentityVerdict::Unverifiable);
}

#[tokio::test]
async fn code_identity_cache_clears_on_transport_loss() {
    use crate::state::permissions::IdentityVerdict;
    use std::sync::atomic::AtomicUsize;
    let (client, peer, counters) = super::conn_tests::wired();
    let count = AtomicUsize::new(0);
    let lookup = |_| { count.fetch_add(1, Ordering::SeqCst); IdentityVerdict::Matches };
    client.set_peer_pid(41);
    client.identity_cache.verify(41, lookup);
    drop(peer);
    // The disconnect callback fires after cache invalidation.
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while counters.disconnects.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    client.identity_cache.verify(41, lookup);
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert_eq!(client.host_identity_verdict(41), IdentityVerdict::Unverifiable);
}

#[cfg(target_os = "macos")]
#[test]
fn permission_identity_is_shared_per_connection_and_unknown_by_default() {
    let (client, _rx) = client();
    let clone = client.clone();
    assert_eq!(client.host_permission_identity(), None);
    client.set_peer_pid(42);
    *client.permission_identity.lock().unwrap() = Some((42, HostPermissionIdentity::App));
    assert_eq!(clone.host_permission_identity(), Some(HostPermissionIdentity::App));
    *client.permission_identity.lock().unwrap() = Some((42, HostPermissionIdentity::Helper));
    assert_eq!(clone.host_permission_identity(), Some(HostPermissionIdentity::Helper));
    client.set_peer_pid(43);
    assert_eq!(clone.host_permission_identity(), None, "spawn evidence is invalid for a different peer PID");
}

/// Ack every `Disarm` / `Shutdown` after ignoring the first `ignore_first` of
/// them. A `Shutdown` is acked only with the right token, like the host does.
fn responder(
    mut out_rx: tokio::sync::mpsc::UnboundedReceiver<Frame>,
    pending: PendingMap,
    mut ignore_first: usize,
) {
    tokio::spawn(async move {
        while let Some(f) = out_rx.recv().await {
            let (req, ack) = match f {
                Frame::Ctrl(Control::Disarm { req }) => (req, Response::DisarmAck { req }),
                Frame::Ctrl(Control::Shutdown { req, token }) if token == "tok" => {
                    (req, Response::ShutdownAck { req })
                }
                _ => continue,
            };
            if ignore_first > 0 {
                ignore_first -= 1;
                continue;
            }
            if let Some(tx) = pending.lock().unwrap().remove(&req) {
                let _ = tx.send(ack);
            }
        }
    });
}

#[tokio::test]
async fn disarm_reports_true_when_the_host_acks() {
    let (c, out_rx) = client();
    responder(out_rx, c.pending.clone(), 0);
    assert!(c.disarm().await, "a DisarmAck must be reported as success");
}

/// The case that makes the quit path a lie: the request went out, nothing
/// came back. Exiting here strands sessions, so it must NOT read as success.
#[tokio::test(start_paused = true)]
async fn disarm_reports_false_when_the_host_never_acks() {
    let (c, _out_rx) = client(); // receiver alive, so the send succeeds; nothing answers
    assert!(
        !c.disarm().await,
        "an unanswered disarm must not report success"
    );
}

/// A dead pipe is the one honest "nothing to disarm" — it must not stall the
/// quit waiting out a timeout for a host that is already gone.
#[tokio::test(start_paused = true)]
async fn disarm_reports_false_promptly_when_the_pipe_is_gone() {
    let (c, out_rx) = client();
    drop(out_rx);
    assert!(!c.disarm().await);
}

/// One dropped request on a flaky pipe must not decide the question. This is
/// the difference between the old `let _ = request(...)` and a disarm the
/// exit path can rely on.
#[tokio::test(start_paused = true)]
async fn disarm_retries_before_giving_up() {
    let (c, out_rx) = client();
    responder(out_rx, c.pending.clone(), 1); // swallow the first attempt
    assert!(
        c.disarm().await,
        "a disarm that succeeds on retry must report success"
    );
}

#[tokio::test]
async fn shutdown_reports_true_when_the_host_acks() {
    let (c, out_rx) = client();
    responder(out_rx, c.pending.clone(), 0);
    assert!(c.shutdown().await, "a ShutdownAck must be reported as success");
}

/// The frame carries the launch token: the host ignores an unauthenticated
/// Shutdown, and an ignored Shutdown means Exit leaves shells held.
#[tokio::test]
async fn shutdown_sends_the_lifecycle_token() {
    let (c, mut out_rx) = client();
    let sent = tokio::spawn(async move { out_rx.recv().await });
    let _ = tokio::time::timeout(std::time::Duration::from_millis(50), c.shutdown()).await;
    match sent.await.unwrap() {
        Some(Frame::Ctrl(Control::Shutdown { token, .. })) => assert_eq!(token, "tok"),
        other => panic!("expected a Shutdown frame, got {other:?}"),
    }
}

/// Exiting on an unanswered Shutdown holds the shells for the retention
/// window — it must NOT read as success, so the quit path can log it.
#[tokio::test(start_paused = true)]
async fn shutdown_reports_false_when_the_host_never_acks() {
    let (c, _out_rx) = client();
    assert!(!c.shutdown().await);
}

#[tokio::test(start_paused = true)]
async fn shutdown_retries_before_giving_up() {
    let (c, out_rx) = client();
    responder(out_rx, c.pending.clone(), 1);
    assert!(c.shutdown().await);
}

/// A legacy host (no `CAP_SHUTDOWN_CONTROL`) tears down on the disconnect
/// itself and cannot decode `Shutdown`: nothing must be sent, and the quit
/// must not wait out an ack that can never come.
#[tokio::test(start_paused = true)]
async fn shutdown_is_a_silent_success_for_a_host_without_the_capability() {
    let (c, mut out_rx) = client();
    c.set_shutdown_control(false);
    assert!(c.shutdown().await, "nothing to announce is not a failure");
    assert!(
        out_rx.try_recv().is_err(),
        "a legacy host must not be sent a frame it cannot decode"
    );
}
