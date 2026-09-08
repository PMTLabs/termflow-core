use super::*;
// The fake, the canonical rule and the wiring are shared with the dry run's tests so there can
// only ever be one of each.
use crate::automation::roster::RosterRow;
use crate::automation_engine::test_host::*;

mod tick_substitution_and_schedule;
mod wait_and_cancellation;
mod send_serialisation_and_guards;
mod runs_once_and_targeting;
mod review_findings_send_and_log;
mod review_findings_targeting_and_misc;

// Fixtures reached by more than one bucket. `pending` and `open_second_terminal` are each imported
// by three of them directly; `open_terminal` is imported by one, and is here because
// `open_second_terminal` is built on it — a fixture's second consumer can be another fixture.
// Anything reached from a single bucket and nothing else stays in that bucket's own file.

/// A crossing that has been decided and not yet written — built exactly the way `evaluate_pair`
/// builds one, **including advancing the arm state first**, so a test of the rollback is a test of
/// the real starting position rather than of a state the engine never produces.
fn pending(
    engine: &Arc<AutomationEngine>,
    host: &Arc<dyn EngineHost>,
    rule_id: &str,
    prev: ArmState,
    at_ms: i64,
) -> PendingSend {
    let rule = engine
        .snapshot_live()
        .into_iter()
        .find(|l| l.rule.id == rule_id)
        .expect("the rule must be live for a send to have been decided");
    engine
        .runtime
        .set_arm(rule_id, "tm-1", ArmState::Fired { at_ms });
    PendingSend {
        pair: Pair {
            rule,
            tm: "tm-1".into(),
            pc: "pc-1".into(),
        },
        prev,
        label: host.label_for("tm-1"),
        at_ms,
        // None of this fixture's callers exercise substitution — they are the rollback/
        // serialisation suites, which vary the terminal and the queue, not the message.
        captures: None,
    }
}

/// A second live terminal, with ids that share no substring with the first (§7.4).
fn open_second_terminal(fake: &Arc<FakeHost>) {
    open_terminal(fake, "tm-2", "pc-2", "second");
}

/// One more terminal on a rig that is already built. `FakeHost::with_terminal` is the same thing
/// at construction time; this is the `&Arc<FakeHost>` form, and §6.3's fixtures need three and
/// four of them.
fn open_terminal(fake: &Arc<FakeHost>, tm: &str, pc: &str, label: &str) {
    fake.roster.lock().unwrap().push(RosterRow {
        terminal_id: Some(tm.into()),
        process_id: pc.into(),
        name: "Terminal-powershell".into(),
        shell: "powershell".into(),
        pid: 102,
        display_label: Some(label.into()),
        cwd: None,
        command_lines: Vec::new(),
    });
    fake.leaves.lock().unwrap().insert(tm.into(), pc.into());
}
