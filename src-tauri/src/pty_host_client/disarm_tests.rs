use super::*;

fn client() -> (PtyHostClient, tokio::sync::mpsc::UnboundedReceiver<Frame>) {
    let (outbound, out_rx) = unbounded_channel::<Frame>();
    (
        PtyHostClient {
            outbound,
            pending: Arc::new(Mutex::new(HashMap::new())),
            req_ctr: Arc::new(AtomicU64::new(0)),
            survives_hotswap: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            attach_acks: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            shutdown_control: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            lifecycle: Arc::new(HostRetention::Unknown),
            alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            lifecycle_token: Arc::new("tok".into()),
        },
        out_rx,
    )
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
