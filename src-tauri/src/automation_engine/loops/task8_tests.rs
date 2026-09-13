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

#[tokio::test]
async fn a_crossing_posts_the_source_terminal_reserved_values() {
    let (url, posted) = capturing_webhook_endpoint();
    let (engine, fake, host) = rig_with_rule_bypassing_the_enable_gate(|graph| {
        add_discord_webhook(graph, url);
        let webhook = graph.webhook.as_mut().expect("the webhook just added");
        webhook.body = "${terminal.title}|${terminal.id}|${terminal.cwd}|${time}".into();
        webhook.substitute = true;
    });
    fake.roster.lock().unwrap()[0].cwd = Some("/one".into());
    let send = pending(&engine, &host, ArmState::armed(), 4_000);

    let before = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    run_crossing(engine.clone(), host.clone(), send).await;

    let request = posted
        .recv_timeout(Duration::from_secs(3))
        .expect("the webhook was never posted");
    let text = String::from_utf8_lossy(&request);
    let after = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let rendered = text
        .split("codex · core|tm-1|/one|")
        .nth(1)
        .map(|rest| rest.chars().take(before.chars().count()).collect::<String>())
        .unwrap_or_else(|| panic!("source values were not posted: {text}"));
    // Bracketed between two real clock reads, not matched by shape: the bag's `${time}` is the
    // crossing's own `now_ms()`, and a fixed timestamp of the right shape must fail here. The
    // bounds are formatted by chrono directly, not by `time_from_ms`, so they do not move with
    // a mutant.
    assert!(
        before <= rendered && rendered <= after,
        "the posted time {rendered} is not between {before} and {after}"
    );
}

/// **The cwd is the crossing's own process's, not whatever the leaf points at when it fires.**
///
/// A parked send is decided against run A and drained up to `MAX_DELAY_MS` later; a Ctrl+R in
/// between re-indexes the same `tm-` to run B. `run_send` refuses that crossing (`pc !=
/// send.pair.pc`), but the webhook has no such guard and still posts — so a cwd looked up BY LEAF
/// would pair run A's `$1` with run B's directory. The rig replaces `pc-1` (cwd `/a`) with `pc-2`
/// (cwd `/b`) under the same `tm-1` after the crossing was read from `pc-1`: the matched process
/// is gone, so the honest value is `""` — and it must not be `/b`, which is what EVERY leaf-keyed
/// lookup (by `process_for_leaf`, or by the first roster row for the leaf) would say.
#[tokio::test]
async fn a_webhook_after_a_restart_posts_the_cwd_of_the_process_that_matched() {
    let (url, posted) = capturing_webhook_endpoint();
    let (engine, fake, host) = rig_with_rule_bypassing_the_enable_gate(|graph| {
        add_discord_webhook(graph, url);
        let webhook = graph.webhook.as_mut().expect("the webhook just added");
        webhook.body = "in ${terminal.cwd}".into();
        webhook.substitute = true;
    });
    fake.roster.lock().unwrap()[0].cwd = Some("/a".into());
    let send = pending(&engine, &host, ArmState::armed(), 4_000);
    // The restart: `pc-1` is gone, and the leaf now resolves to a new process with its own
    // directory.
    fake.leaves.lock().unwrap().insert("tm-1".into(), "pc-2".into());
    fake.roster.lock().unwrap().retain(|r| r.process_id != "pc-1");
    fake.roster.lock().unwrap().push(crate::automation::roster::RosterRow {
        terminal_id: Some("tm-1".into()),
        process_id: "pc-2".into(),
        name: "Terminal-powershell".into(),
        shell: "powershell".into(),
        pid: 101,
        display_label: Some("codex · core".into()),
        cwd: Some("/b".into()),
        command_lines: Vec::new(),
    });

    run_crossing(engine.clone(), host.clone(), send).await;

    let request = posted
        .recv_timeout(Duration::from_secs(3))
        .expect("the webhook was never posted");
    let text = String::from_utf8_lossy(&request);
    assert!(
        text.contains(r#""content":"in ""#),
        "the gone process's cwd should render empty: {text}"
    );
    assert!(!text.contains("/b"), "the restarted process's cwd leaked in: {text}");
}

/// **A Custom body carries a Windows path and a quoted title as JSON string fragments.**
///
/// `payload` posts a Custom body byte-for-byte, so before this every `${terminal.cwd}` on Windows
/// produced `{"cwd":"D:\src"}` — invalid JSON, 100% of the time — while validation's
/// backslash-free sample let it save. The oracle parses the posted bytes and reads the raw values
/// back, which a body that merely CONTAINS the path cannot satisfy.
#[tokio::test]
async fn a_custom_body_escapes_substituted_values_as_json_strings() {
    let (url, posted) = capturing_webhook_endpoint();
    let (engine, fake, host) = rig_with_rule_bypassing_the_enable_gate(|graph| {
        add_discord_webhook(graph, url);
        let webhook = graph.webhook.as_mut().expect("the webhook just added");
        webhook.provider = WebhookProvider::Custom;
        webhook.body = r#"{"cwd":"${terminal.cwd}","title":"${terminal.title}"}"#.into();
        webhook.substitute = true;
    });
    {
        let mut roster = fake.roster.lock().unwrap();
        roster[0].cwd = Some(r"D:\src\core".into());
        roster[0].display_label = Some(r#"say "hi""#.into());
    }
    let send = pending(&engine, &host, ArmState::armed(), 4_000);

    run_crossing(engine.clone(), host.clone(), send).await;

    let request = posted
        .recv_timeout(Duration::from_secs(3))
        .expect("the webhook was never posted");
    let text = String::from_utf8_lossy(&request);
    // The endpoint captures the whole request; the body is what follows the header block.
    let body = text.split("\r\n\r\n").nth(1).unwrap_or_default();
    let parsed: serde_json::Value =
        serde_json::from_str(body).unwrap_or_else(|e| panic!("not JSON ({e}): {body}"));
    assert_eq!(parsed["cwd"], r"D:\src\core");
    assert_eq!(parsed["title"], r#"say "hi""#);
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
