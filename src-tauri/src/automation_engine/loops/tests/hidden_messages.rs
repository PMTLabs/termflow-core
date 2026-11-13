use super::*;
use crate::automation_engine::subst;

#[tokio::test(start_paused = true)]
async fn masked_messages_send_original_and_substituted_bytes() {
    for substitute in [false, true] {
        let (engine, fake, host) = rig_with_rule(|g| {
            g.action_mut().masked = true;
            g.action_mut().message = "secret ${terminal.id}".into();
            g.action_mut().substitute = substitute;
        });
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1000);
        let reserved = subst::Reserved::sample();
        let outcome = run_send(
            &engine,
            &host,
            &send,
            &reserved,
            tokio::time::Instant::now(),
        )
        .await;
        assert!(matches!(outcome, DestinationOutcome::Sent));
        let expected = if substitute {
            format!("secret {}", reserved.terminal_id)
        } else {
            "secret ${terminal.id}".into()
        };
        assert!(fake.written().join("").contains(&expected));
    }
}

#[tokio::test(start_paused = true)]
async fn readable_hidden_empty_substitution_keeps_submit_behaviour() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.action_mut().masked = true;
        g.action_mut().substitute = true;
        g.action_mut().message = "${terminal.title}".into();
    });
    let send = pending(&engine, &host, "au-1", ArmState::armed(), 1000);
    let mut reserved = subst::Reserved::sample();
    reserved.terminal_title = Some(String::new());
    assert!(matches!(
        run_send(
            &engine,
            &host,
            &send,
            &reserved,
            tokio::time::Instant::now()
        )
        .await,
        DestinationOutcome::Sent
    ));
    assert!(!fake.writes.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn empty_masked_enabled_actions_never_write_even_enter() {
    for cipher in [None, Some("v1:unreadable".into())] {
        let (engine, fake, host) = rig_with_rule_bypassing_the_enable_gate(|g| {
            g.action_mut().masked = true;
            g.action_mut().message.clear();
            g.action_mut().message_cipher = cipher;
        });
        let send = pending(&engine, &host, "au-1", ArmState::armed(), 1000);
        assert!(matches!(
            run_send(
                &engine,
                &host,
                &send,
                &subst::Reserved::sample(),
                tokio::time::Instant::now()
            )
            .await,
            DestinationOutcome::Failed(_)
        ));
        assert!(fake.writes.lock().unwrap().is_empty());
    }
}

#[tokio::test(start_paused = true)]
async fn masked_writer_errors_are_generic() {
    let (engine, fake, host) = rig_with_rule(|g| {
        g.action_mut().masked = true;
    });
    *fake.write_err.lock().unwrap() = Some("writer error quoting secretPassword".into());
    let send = pending(&engine, &host, "au-1", ArmState::armed(), 1000);
    match run_send(
        &engine,
        &host,
        &send,
        &subst::Reserved::sample(),
        tokio::time::Instant::now(),
    )
    .await
    {
        DestinationOutcome::Failed(reason) => {
            assert_eq!(reason, "the hidden message could not be sent")
        }
        _ => panic!("must refuse"),
    }
}

#[tokio::test(start_paused = true)]
async fn masked_token_refusal_does_not_name_the_token() {
    let (engine, fake, host) = rig_with_rule_bypassing_the_enable_gate(|g| {
        g.action_mut().masked = true;
        g.action_mut().substitute = true;
        g.action_mut().message = "${secretPassword}".into();
    });
    let send = pending(&engine, &host, "au-1", ArmState::armed(), 1000);
    let result = run_send(
        &engine,
        &host,
        &send,
        &subst::Reserved::sample(),
        tokio::time::Instant::now(),
    )
    .await;
    match result {
        DestinationOutcome::Failed(reason) => assert!(!reason.contains("secretPassword")),
        _ => panic!("must refuse"),
    }
    assert!(fake.writes.lock().unwrap().is_empty());
}
