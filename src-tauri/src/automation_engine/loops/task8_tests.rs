use super::*;
use crate::automation_engine::test_host::{
    ctx_rule,
    rig_with_rule_bypassing_the_enable_gate,
    strip_comments,
    wire_bypassing_the_enable_gate,
};
use crate::automation_store::{LogOrder, LogScope, WebhookProvider, WebhookStep};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver, Sender};

fn pending(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    prev: ArmState,
    at_ms: i64,
) -> PendingSend {
    let rule = engine
        .snapshot_live()
        .into_iter()
        .next()
        .expect("live rule");
    engine
        .runtime
        .set_arm(&rule.rule.id, "tm-1", ArmState::Fired { at_ms });
    PendingSend {
        pair: Pair {
            rule,
            tm: "tm-1".into(),
            pc: "pc-1".into(),
        },
        prev,
        label: host.label_for("tm-1"),
        at_ms,
        captures: None,
    }
}

fn webhook_endpoint() -> (String, Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback webhook listener");
    let url = format!(
        "http://{}",
        listener.local_addr().expect("listener address")
    );
    let (sent, received) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept webhook request");
        read_webhook_request(&mut stream);
        stream
            .write_all(
                b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .expect("reply");
        sent.send(()).expect("record webhook request");
    });
    (url, received)
}

/// A one-request endpoint that KEEPS the request bytes.
///
/// `webhook_endpoint` only reports that something arrived, which is enough for the delivery
/// tests and is exactly not enough for a substitution one: a rule that posts its template
/// verbatim arrives just as reliably as one that posts the resolved body. The bytes are the
/// only place the difference exists.
fn capturing_webhook_endpoint() -> (String, Receiver<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback webhook listener");
    let url = format!(
        "http://{}",
        listener.local_addr().expect("listener address")
    );
    let (sent, received) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept webhook request");
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .expect("read timeout");
        let mut buffer = [0_u8; 4096];
        let read = stream.read(&mut buffer).expect("read request");
        stream
            .write_all(
                b"HTTP/1.1 204 No Content
Content-Length: 0
Connection: close

",
            )
            .expect("reply");
        sent.send(buffer[..read].to_vec()).expect("record webhook request");
    });
    (url, received)
}

fn held_webhook_endpoint() -> (String, Sender<()>, Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback webhook listener");
    let url = format!(
        "http://{}",
        listener.local_addr().expect("listener address")
    );
    let (release_sent, release_received) = mpsc::channel();
    let (arrived_sent, arrived_received) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept webhook request");
        read_webhook_request(&mut stream);
        arrived_sent.send(()).expect("record webhook arrival");
        release_received.recv().expect("release webhook response");
        stream
            .write_all(
                b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .expect("reply");
    });
    (url, release_sent, arrived_received)
}

fn read_webhook_request(stream: &mut TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .expect("read timeout");
    let mut buffer = [0_u8; 4096];
    assert_ne!(stream.read(&mut buffer).expect("read request"), 0);
}

fn add_discord_webhook(graph: &mut crate::automation_store::AutomationGraph, url: String) {
    graph.webhook = Some(WebhookStep {
        provider: WebhookProvider::Discord,
        url,
        body: "webhook body".into(),
        substitute: false,
    });
}

// =============================================================================================
// Task 8 — one crossing, two destinations
// =============================================================================================

/// Normal live-terminal scenario: the terminal stays live after the crossing is decided, but
/// its malformed webhook endpoint fails. That failure must not suppress the terminal delivery.
#[tokio::test]
async fn a_failed_webhook_leaves_the_terminal_send_alone() {
    let (engine, fake, host) = rig_with_rule_bypassing_the_enable_gate(|graph| {
        // reqwest rejects this while building the request; it cannot leave this machine.
        add_discord_webhook(graph, "not a valid URL".into());
    });
    let send = pending(&engine, &host, ArmState::armed(), 4_000);

    run_crossing(engine.clone(), host.clone(), send).await;

    assert!(
        fake.written()
            .iter()
            .any(|write| write.contains("prepare to do context-hand-off")),
        "the terminal destination was suppressed by a failed webhook: {:?}",
        fake.written()
    );
    let rows = fake
        .store
        .load_automation_log(&LogScope::All, LogOrder::Asc, 10)
        .unwrap();
    assert_eq!(
        rows.len(),
        2,
        "each destination writes its own outcome: {rows:?}"
    );
    assert!(rows
        .iter()
        .any(|row| row.kind == LogKind::Sent && row.terminal_id.as_deref() == Some("tm-1")));
    assert!(rows
        .iter()
        .any(|row| row.kind == LogKind::Failed && row.terminal_id.is_none()));
}

/// Already-decided / terminal-closed scenario from the scope note: the leaf disappears after
/// the crossing exists, so the terminal fails, but the webhook still sends once and retires the
/// runs-once rule rather than rolling the arm back for a repeat.
#[tokio::test]
async fn a_failed_terminal_send_does_not_let_the_webhook_repeat() {
    let (url, requested) = webhook_endpoint();
    let mut rule = ctx_rule("au-1");
    rule.runs_once = true;
    add_discord_webhook(&mut rule.graph, url);
    let (engine, fake, host) = wire_bypassing_the_enable_gate(vec![rule]);
    let send = pending(&engine, &host, ArmState::armed(), 4_000);
    fake.close("tm-1");

    run_crossing(engine.clone(), host.clone(), send).await;

    requested
        .recv_timeout(Duration::from_secs(3))
        .expect("the webhook was sent after the terminal closed");
    assert!(
        !engine.is_live("au-1"),
        "the successful webhook completed the crossing once"
    );
    let rows = fake
        .store
        .load_automation_log(&LogScope::All, LogOrder::Asc, 10)
        .unwrap();
    assert!(rows
        .iter()
        .any(|row| row.kind == LogKind::Failed && row.terminal_id.as_deref() == Some("tm-1")));
    assert!(rows
        .iter()
        .any(|row| row.kind == LogKind::Sent && row.terminal_id.is_none()));
}

/// Normal live-terminal scenario: both destinations succeed for one already-decided crossing,
/// so its fire history increments once rather than once per destination.
#[tokio::test]
async fn a_crossing_records_one_fire_however_many_destinations_it_had() {
    let (url, requested) = webhook_endpoint();
    let (engine, _fake, host) =
        rig_with_rule_bypassing_the_enable_gate(|graph| add_discord_webhook(graph, url));
    let send = pending(&engine, &host, ArmState::armed(), 4_000);

    run_crossing(engine.clone(), host.clone(), send).await;

    requested
        .recv_timeout(Duration::from_secs(3))
        .expect("webhook request");
    assert_eq!(
        engine.runtime.fire_record("au-1", "tm-1"),
        Some((1, 4_000)),
        "two destinations are one crossing, not two fires"
    );
}

/// Normal live-terminal scenario: the terminal has finished its 500 ms delivery while the
/// webhook deliberately waits for its local response. Completion must wait for that response.
#[tokio::test]
async fn completion_waits_for_every_destination_not_the_first() {
    let (url, release, arrived) = held_webhook_endpoint();
    let mut rule = ctx_rule("au-1");
    rule.runs_once = true;
    add_discord_webhook(&mut rule.graph, url);
    let (engine, fake, host) = wire_bypassing_the_enable_gate(vec![rule]);
    let send = pending(&engine, &host, ArmState::armed(), 4_000);
    let task = tokio::spawn(run_crossing(engine.clone(), host.clone(), send));

    tokio::time::sleep(Duration::from_millis(100)).await;
    arrived
        .try_recv()
        .expect("webhook request reached the held listener");
    tokio::time::sleep(Duration::from_millis(650)).await;
    assert!(
        fake.written()
            .iter()
            .any(|write| write.contains("prepare to do context-hand-off")),
        "the terminal destination did not complete"
    );
    assert!(
        engine.is_live("au-1"),
        "the first completed destination retired the rule early"
    );
    assert!(
        !task.is_finished(),
        "the crossing returned before the held webhook did"
    );

    release.send(()).expect("release webhook response");
    task.await.expect("crossing task");
    assert!(
        !engine.is_live("au-1"),
        "completion did not follow both destination outcomes"
    );
}

/// Normal live-terminal scenario: this is the strong two-row oracle. Both rows must name the
/// same rule and decision timestamp, while their terminal identity, provider identity, kind,
/// and observed delivery outcomes distinguish a terminal send from a webhook send.
#[tokio::test]
async fn one_crossing_with_two_destinations_writes_one_row_each() {
    let (url, requested) = webhook_endpoint();
    let (engine, fake, host) =
        rig_with_rule_bypassing_the_enable_gate(|graph| add_discord_webhook(graph, url));
    let send = pending(&engine, &host, ArmState::armed(), 4_242);

    run_crossing(engine.clone(), host.clone(), send).await;

    requested
        .recv_timeout(Duration::from_secs(3))
        .expect("webhook request");
    assert!(
        fake.written()
            .iter()
            .any(|write| write.contains("prepare to do context-hand-off")),
        "the terminal delivery did not occur"
    );
    let rows = fake
        .store
        .load_automation_log(&LogScope::All, LogOrder::Asc, 10)
        .unwrap();
    assert_eq!(rows.len(), 2, "not a bare count: inspect both rows below");
    let terminal = rows
        .iter()
        .find(|row| row.terminal_id.as_deref() == Some("tm-1"))
        .expect("terminal destination row");
    assert_eq!(terminal.rule_id, "au-1");
    assert_eq!(terminal.at, 4_242);
    assert_eq!(terminal.kind, LogKind::Sent);
    assert_eq!(terminal.terminal_name.as_deref(), Some("codex · core"));
    assert_eq!(terminal.detail, "sent to codex · core");

    let webhook = rows
        .iter()
        .find(|row| row.terminal_id.is_none())
        .expect("webhook destination row");
    assert_eq!(webhook.rule_id, "au-1");
    assert_eq!(webhook.at, 4_242);
    assert_eq!(webhook.kind, LogKind::Sent);
    assert_eq!(webhook.terminal_name, None);
    assert_eq!(webhook.detail, "webhook sent via Discord");
}

/// Source-derived rather than behavioural: the dispatch code has no clock of its own, and the
/// webhook sibling never takes `send_lock`. This test exercises no terminal scenario.
#[test]
fn the_webhook_path_adds_no_new_clock() {
    let source = strip_comments(include_str!("../loops.rs"));
    let crossing_start = source
        .rfind("async fn run_crossing(")
        .expect("crossing function");
    let webhook_start = source
        .rfind("async fn run_webhook(")
        .expect("webhook function");
    let terminal_start = source
        .rfind("async fn run_send(")
        .expect("terminal function");
    let completion_start = source
        .rfind("fn complete_crossing(")
        .expect("completion function");
    let crossing = &source[crossing_start..terminal_start];
    let webhook = &source[webhook_start..completion_start];
    assert!(
        crossing.contains("tokio::join!"),
        "destinations must be aggregated together"
    );
    for body in [crossing, webhook] {
        assert!(
            !body.contains("tokio::time::interval"),
            "a webhook path added an interval"
        );
        assert!(
            !body.contains("tokio::time::sleep"),
            "a webhook path added a sleep"
        );
    }
    assert!(
        !webhook.contains("send_lock"),
        "a webhook must not queue behind a terminal send"
    );
    assert!(crossing.contains("run_send") && crossing.contains("run_webhook"));
}

/// **The webhook destination posts the RESOLVED body**, the exact twin of the test above.
///
/// Reported from a live build: *"on Discord I got the $0, not the matched value"*. The
/// substitution in `run_webhook` was correct, and nothing covered it — every webhook test until
/// now asserted only that a request ARRIVED, which a rule posting its template verbatim does
/// just as reliably. `capturing_webhook_endpoint` exists so the assertion can be about the
/// bytes, where the difference actually lives.
///
/// Driven through `run_crossing` with a hand-built `Captures` rather than through a tick,
/// because the two neighbouring webhook tests do: reqwest is real I/O and the tick-driven
/// tests run on a paused clock.
#[tokio::test]
async fn a_crossing_posts_the_resolved_webhook_body() {
    let (url, posted) = capturing_webhook_endpoint();
    let (engine, _fake, host) = rig_with_rule_bypassing_the_enable_gate(|graph| {
        add_discord_webhook(graph, url);
        let webhook = graph.webhook.as_mut().expect("the webhook just added");
        webhook.body = "Fix the $1 failing tests in $2".into();
        webhook.substitute = true;
    });
    let mut send = pending(&engine, &host, ArmState::armed(), 4_000);
    send.captures = Some(Captures {
        groups: vec![
            Some("FAILED 17 tests in a.ts".into()),
            Some("17".into()),
            Some("a.ts".into()),
        ],
        named: Default::default(),
    });

    run_crossing(engine.clone(), host.clone(), send).await;

    let request = posted
        .recv_timeout(Duration::from_secs(3))
        .expect("the webhook was never posted");
    let text = String::from_utf8_lossy(&request);
    assert!(
        text.contains("Fix the 17 failing tests in a.ts"),
        "the resolved body never reached the wire: {text}"
    );
    // The complaint in its own words: the token itself must not survive the send.
    assert!(!text.contains("$1"), "a raw token was posted: {text}");
}

/// The other half of the pair, and the reason the flag is worth having: with substitution off
/// the body is posted EXACTLY as typed. Asserted so that "resolved" above cannot be satisfied
/// by a sender that always substitutes — a webhook body is sometimes JSON a user wrote by
/// hand, and `$` is not always a token.
#[tokio::test]
async fn a_webhook_that_opted_out_posts_its_body_verbatim() {
    let (url, posted) = capturing_webhook_endpoint();
    let (engine, _fake, host) = rig_with_rule_bypassing_the_enable_gate(|graph| {
        add_discord_webhook(graph, url);
        let webhook = graph.webhook.as_mut().expect("the webhook just added");
        webhook.body = "Fix the $1 failing tests in $2".into();
        webhook.substitute = false;
    });
    let mut send = pending(&engine, &host, ArmState::armed(), 4_000);
    send.captures = Some(Captures {
        groups: vec![Some("FAILED 17 tests in a.ts".into()), Some("17".into())],
        named: Default::default(),
    });

    run_crossing(engine.clone(), host.clone(), send).await;

    let request = posted
        .recv_timeout(Duration::from_secs(3))
        .expect("the webhook was never posted");
    let text = String::from_utf8_lossy(&request);
    assert!(text.contains("$1"), "the opted-out body was rewritten: {text}");
}
