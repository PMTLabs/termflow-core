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
            lifecycle: Arc::new(HostRetention::Unknown),
            alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        },
        out_rx,
    )
}

/// Ack every `Disarm` after ignoring the first `ignore_first` of them.
fn responder(
    mut out_rx: tokio::sync::mpsc::UnboundedReceiver<Frame>,
    pending: PendingMap,
    mut ignore_first: usize,
) {
    tokio::spawn(async move {
        while let Some(f) = out_rx.recv().await {
            if let Frame::Ctrl(Control::Disarm { req }) = f {
                if ignore_first > 0 {
                    ignore_first -= 1;
                    continue;
                }
                if let Some(tx) = pending.lock().unwrap().remove(&req) {
                    let _ = tx.send(Response::DisarmAck { req });
                }
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
