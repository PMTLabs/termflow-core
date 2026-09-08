use super::super::*;
use super::pending;
use crate::automation_engine::test_host::*;

// =============================================================================================
// The send's own fixtures (§10.7 – §10.9, §10.14c)
// =============================================================================================


/// Where each bracketed paste sits in the write log. One send is three writes — paste, focus-in,
/// submit — so two serialised sends put their pastes at 0 and 3, and two interleaved ones put them
/// side by side.
fn paste_positions(writes: &[String]) -> Vec<usize> {
    writes
        .iter()
        .enumerate()
        .filter(|(_, w)| w.starts_with("\x1b[200~"))
        .map(|(i, _)| i)
        .collect()
}

// =============================================================================================
// §10.7 — send serialisation
// =============================================================================================

/// **Two sends into one terminal, decided in one tick.** Route A is paste → 500 ms → focus-in →
/// submit, and without the per-leaf lock both tasks write their paste, both sleep, and the second
/// rule's text lands *inside* the first rule's composer line — which then submits both as one
/// message. That is not a lost automation, it is a wrong command typed at an agent.
///
/// The oracle is the POSITION of the two pastes, not the presence of the two messages: a lock-free
/// implementation satisfies "both messages appear somewhere" perfectly.
#[tokio::test(start_paused = true)]
async fn two_sends_to_one_terminal_never_interleave() {
    let (engine, fake, host) = wire(vec![
        ctx_rule_saying("au-1", "alpha speaking", 1),
        ctx_rule_saying("au-2", "bravo speaking", 2),
    ]);
    for id in ["au-1", "au-2"] {
        engine.runtime.set_arm(id, "tm-1", ArmState::armed());
    }
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "ctx:63%\n");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    let writes = fake.written();
    assert_eq!(
        writes.len(),
        6,
        "two sends of three writes each: {:?}",
        writes
    );
    assert_eq!(
        paste_positions(&writes),
        vec![0, 3],
        "a paste landed inside another send: {:?}",
        writes
    );

    // Order between the two is the scheduler's business; carrying ONE WHOLE message each is not.
    let mut carried: Vec<&str> = Vec::new();
    for i in [0usize, 3] {
        let alpha = writes[i].contains("alpha speaking");
        let bravo = writes[i].contains("bravo speaking");
        assert_ne!(
            alpha, bravo,
            "one paste carried both messages: {:?}",
            writes
        );
        carried.push(if alpha { "alpha" } else { "bravo" });
    }
    carried.sort_unstable();
    assert_eq!(
        carried,
        vec!["alpha", "bravo"],
        "both rules must have sent: {:?}",
        writes
    );
}

/// A send that cannot take the terminal's queue within [`SEND_QUEUE_TIMEOUT_MS`] gives up: one
/// `failed` row, nothing typed, and the arm state back at **exactly** where it was.
///
/// `prev` is a RE-armed state here rather than a fresh `armed()`, and that is the point of the
/// test: rolling back to `ArmState::armed()` loses `seen_fire`, which puts a presence rule back to
/// reading the deep window and makes it re-fire on the very line it just let go (§2.2c). A
/// rollback that looks right and is not.
#[tokio::test(start_paused = true)]
async fn a_send_that_cannot_take_the_queue_fails_once_and_rolls_back_exactly() {
    let (engine, fake, host) = wired();
    let lock = engine.runtime.send_lock("tm-1");
    let _held = lock.lock().await;

    let send = pending(&engine, &host, "au-1", ArmState::re_armed(), 1_000);
    run_crossing(engine.clone(), host.clone(), send).await;

    assert!(
        fake.written().is_empty(),
        "a send that never got the queue must type nothing"
    );
    assert_eq!(
        engine.runtime.arm_state("au-1", "tm-1"),
        ArmState::re_armed(),
        "rolled back to a fresh Armed, losing seen_fire"
    );
    let rows = log_details(&fake.store);
    assert_eq!(rows.len(), 1, "exactly one row: {:?}", rows);
    assert_eq!(rows[0].0, "Failed");
    assert!(
        rows[0].1.contains("another rule was still sending"),
        "{:?}",
        rows
    );
    assert_eq!(
        engine.runtime.fire_record("au-1", "tm-1"),
        None,
        "a failed send never fired"
    );
}

// =============================================================================================
// §10.8 — the failure paths
// =============================================================================================

/// **Both delivery failures, as a table**, because they are one class: the message did not go out.
/// Each writes exactly one row, leaves the arm state where the decision found it, records no fire,
/// and leaves neither an echo needle nor a settle window behind — a send that half-happened is the
/// one outcome the log must never imply.
#[tokio::test(start_paused = true)]
async fn a_send_that_cannot_be_delivered_fails_once_and_leaves_the_pair_armed() {
    // (what breaks it, how to break it, what the row must say, writes actually attempted)
    let cases: Vec<(&str, fn(&FakeHost), &str, usize)> = vec![
        (
            "the terminal closed between the decision and our turn at the queue",
            |fake: &FakeHost| fake.close("tm-1"),
            "the terminal closed before the message was sent",
            0,
        ),
        (
            "the write itself was refused",
            |fake: &FakeHost| {
                *fake.write_err.lock().unwrap() = Some("terminal pc-1 has no writer".into());
            },
            "the message could not be sent",
            1,
        ),
    ];

    for (what, break_it, says, attempted) in cases {
        let (engine, fake, host) = wired();
        // The decision is made while the terminal is OPEN, and only then does the thing that
        // breaks the send happen. Building the send after breaking it would resolve the label
        // against an already-dead terminal, which is not the sequence §2.8 is about.
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
        break_it(&fake);

        run_crossing(engine.clone(), host.clone(), send).await;
        tokio::time::sleep(Duration::from_millis(1_500)).await;

        assert_eq!(
            fake.written().len(),
            attempted,
            "{}: a refused paste must not be followed by a submit — {:?}",
            what,
            fake.written()
        );
        assert_eq!(
            engine.runtime.arm_state("au-1", "tm-1"),
            ArmState::armed(),
            "{}",
            what
        );
        let rows = log_details(&fake.store);
        assert_eq!(rows.len(), 1, "{}: exactly one row, got {:?}", what, rows);
        assert_eq!(rows[0].0, "Failed", "{}: {:?}", what, rows);
        assert!(rows[0].1.contains(says), "{}: {:?}", what, rows);
        // R17 / §2.8. The `terminal closed` row is written when there is no name left to look
        // up, which is precisely why the decision carries one — and precisely the row the Name
        // column exists to serve. An oracle reading only `(kind, detail)` let a NULL through here.
        assert_eq!(
            log_rows(&fake.store)[0].2.as_deref(),
            Some("codex · core"),
            "{}: the log lost the terminal's name",
            what
        );
        assert_eq!(engine.runtime.fire_record("au-1", "tm-1"), None, "{}", what);
        assert!(
            engine.runtime.echoes_for("tm-1", 1_000).is_empty(),
            "{}: nothing was typed, so there is no echo to strip",
            what
        );
        assert!(
            !engine.runtime.is_settling("tm-1", 1_000),
            "{}: and no message is landing, so nothing must be held off this terminal",
            what
        );
    }
}

/// §10.8's third failure, and the only one that happens at LOAD rather than at send: an
/// uncompilable pattern is reported once per load and never per tick.
///
/// `automation_engine.rs` asserts the same thing from the live set's side, where "nothing
/// evaluates it" could only be argued. Here eight real ticks run over it — which is the claim that
/// matters, and until M3b there was no evaluator to make it against.
#[tokio::test(start_paused = true)]
async fn an_uncompilable_pattern_is_reported_once_at_load_and_never_by_a_tick() {
    let mut bad = ctx_rule("au-bad");
    bad.graph.parse_mut().find = r"ctx:(\d+%".into();
    let (engine, fake, host) = wire(vec![bad]);

    assert_eq!(
        log_kinds(&fake.store),
        vec!["Failed".to_string()],
        "one row, written at load"
    );
    assert!(
        engine.snapshot_live().is_empty(),
        "and the rule is not running"
    );

    fake.say("pc-1", "ctx:63%\n");
    let mut cursor = 0;
    for t in 1..=8 {
        engine.runtime.mark_dirty("pc-1");
        cursor = evaluate_tick(&engine, &host, cursor, t * 1_000).await;
    }

    assert_eq!(
        log_kinds(&fake.store),
        vec!["Failed".to_string()],
        "a tick wrote a second row"
    );
    assert!(
        fake.written().is_empty(),
        "and an uncompilable rule must never send"
    );
}

// =============================================================================================
// §10.8b — the stop flag, at the one place a half-executed step is visible to a user
// =============================================================================================

#[tokio::test(start_paused = true)]
async fn a_quit_stops_a_queued_send_and_never_splits_one_already_typing() {
    // Queued: the flag is set before the first write, so nothing is typed at all.
    {
        let (engine, fake, host) = wired();
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
        engine.stop();

        run_crossing(engine.clone(), host.clone(), send).await;

        assert!(
            fake.written().is_empty(),
            "a send that started after the quit must type nothing"
        );
        assert_eq!(
            engine.runtime.arm_state("au-1", "tm-1"),
            ArmState::armed(),
            "and the crossing must still be able to fire next launch"
        );
        // No `failed` row, deliberately — and the reason used to be that `RunEvent::Exit` flushed
        // the log after setting this flag, so nobody would read it. `append` is write-through, so
        // that was never true and the row WOULD survive. The real reason is that nothing failed:
        // the arm state is restored, the crossing is still armed, and it fires on the next launch.
        // A row here would be the only trace of a non-event, in a 200-row log §3.3 reserves for
        // decisions a user can act on.
        assert!(
            log_kinds(&fake.store).is_empty(),
            "{:?}",
            log_details(&fake.store)
        );
    }

    // Already typing: the flag is set during the paste-to-submit gap and the submit still goes
    // out. A check between the two leaves the user's composer holding an unsent line.
    {
        let (engine, fake, host) = wired();
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1_000);
        let task = tokio::spawn(run_crossing(engine.clone(), host.clone(), send));

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            fake.written().len(),
            1,
            "the paste must be out and the gap running"
        );
        engine.stop();
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        assert!(task.is_finished(), "the send must not park on the flag");

        let writes = fake.written();
        assert_eq!(writes.len(), 3, "paste, focus-in, submit: {:?}", writes);
        assert_eq!(writes[2], "\x1b\r\r", "the submit itself: {:?}", writes);
        assert_eq!(
            engine.runtime.arm_state("au-1", "tm-1"),
            ArmState::Fired { at_ms: 1_000 },
            "a completed send is not rolled back"
        );
        assert!(log_kinds(&fake.store).contains(&"Sent".to_string()));
    }
}

// =============================================================================================
// §10.9 — the echo guard, end to end
// =============================================================================================

/// **§2.6 in the canonical rule's own shape.** Pattern `HANDOFF`, message `HANDOFF now`: a rule
/// whose message contains its own pattern is what breaks without the guard, and the rule this
/// whole feature was designed around is exactly that shape.
///
/// The needle is stripped, so once the real line has scrolled away the rule sees nothing and
/// **re-arms**. Without the strip it sits in `Fired` forever reading its own message — which is
/// indistinguishable from working until the day the condition happens again.
#[tokio::test(start_paused = true)]
async fn a_rule_re_arms_when_the_only_thing_left_on_screen_is_its_own_echo() {
    let (engine, fake, host) = wire(vec![presence_rule("au-1", "HANDOFF", "HANDOFF now", 1)]);
    engine.runtime.set_arm("au-1", "tm-1", ArmState::armed());
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "building\nHANDOFF\n");

    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(
        fake.written().len(),
        3,
        "the crossing must send: {:?}",
        fake.written()
    );
    assert_eq!(
        engine.runtime.echoes_for("tm-1", 1_000),
        vec!["HANDOFF now".to_string()]
    );

    // The real line has scrolled off. All that is left is what this rule typed.
    fake.say("pc-1", "HANDOFF now\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 4_000).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert_eq!(
        engine.runtime.arm_state("au-1", "tm-1"),
        ArmState::re_armed(),
        "the rule read its own message and stayed Fired"
    );
    assert_eq!(fake.written().len(), 3, "and it must not have sent again");
    assert!(log_kinds(&fake.store).contains(&"ReArmed".to_string()));

    // The positive half. The strip removes the NEEDLE, not the window: a genuine match arriving
    // while the echo is still live is still seen — otherwise "never fires again" is how this test
    // passes.
    fake.say("pc-1", "HANDOFF now\nHANDOFF\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 7_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(
        fake.written().len(),
        6,
        "a real match beside the echo must still send: {:?}",
        fake.written()
    );
}

/// The **per-terminal** half of §2.6, and the reason the needle map is keyed by terminal rather
/// than by rule: rule A's message is echoed into a pane rule B is also watching, and B has no idea
/// A wrote it. A per-rule map hands B an empty needle list and B fires on A's message.
#[tokio::test(start_paused = true)]
async fn a_needle_one_rule_recorded_is_stripped_before_another_rule_reads_that_terminal() {
    let (engine, fake, host) = wire(vec![
        presence_rule("au-a", "HANDOFF", "HANDOFF now", 1),
        presence_rule("au-b", "now", "bravo saw it", 2),
    ]);
    for id in ["au-a", "au-b"] {
        engine.runtime.set_arm(id, "tm-1", ArmState::armed());
    }
    engine.runtime.mark_dirty("pc-1");
    fake.say("pc-1", "building\nHANDOFF\n");

    // A crosses. B sees no `now` at all and stays armed.
    evaluate_tick(&engine, &host, 0, 1_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(engine.runtime.arm_state("au-b", "tm-1"), ArmState::armed());
    assert_eq!(times_sent(&fake, "HANDOFF now"), 1);

    // A's message lands in the pane B is watching.
    fake.say("pc-1", "HANDOFF now\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 4_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    assert_eq!(
        engine.runtime.arm_state("au-b", "tm-1"),
        ArmState::armed(),
        "B fired on a message this feature typed itself"
    );
    assert_eq!(
        times_sent(&fake, "bravo saw it"),
        0,
        "B must not have sent: {:?}",
        fake.written()
    );

    // Paired positive: the same word arriving organically beside the echo DOES reach B.
    fake.say("pc-1", "HANDOFF now\nfinishing now\n");
    engine.runtime.mark_dirty("pc-1");
    evaluate_tick(&engine, &host, 0, 7_000).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(
        times_sent(&fake, "bravo saw it"),
        1,
        "the strip removes the needle, not the window: {:?}",
        fake.written()
    );
}

