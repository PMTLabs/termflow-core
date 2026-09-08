/// One in-place reattach decision produced by [`plan_reattach`].
#[derive(Debug, PartialEq, Eq)]
pub struct ReattachAction {
    pub tab_id: String,
    pub from_offset: u64,
}

/// Complete result of reconciling the app's tabs with an answered host listing.
#[derive(Debug, PartialEq)]
pub struct ReattachPlan {
    pub reattach: Vec<ReattachAction>,
    pub teardown: Vec<String>,
    /// Live host sessions which have no corresponding app tab and must be
    /// adopted into a visible terminal.
    pub orphans: Vec<termflow_pty_protocol::SessionMeta>,
}

/// Decide, per previously host-owned tab, whether to reattach in place (session
/// still held by the reconnected host) and from which ring offset, or tear down
/// (session gone), and surface every live host session the app does not own.
/// Pure so the sleep/wake recovery policy is unit-testable.
pub fn plan_reattach(
    tabs: &[String],
    sessions: &[termflow_pty_protocol::SessionMeta],
    saved_offsets: &std::collections::HashMap<String, u64>,
) -> ReattachPlan {
    let mut reattach = Vec::new();
    let mut teardown = Vec::new();
    for tab in tabs {
        match sessions.iter().find(|m| &m.tab_id == tab) {
            Some(meta) => {
                // No saved offset (never saw a byte this app-lifetime) ⇒ replay
                // the whole ring. A saved offset PAST the ring tail can only
                // mean the saved value belongs to a different session identity
                // (stale entry for a reused id) — resuming from the tail would
                // silently skip everything the real session produced, so treat
                // it as a discontinuity and replay from zero instead.
                let saved = saved_offsets.get(tab).copied().unwrap_or(0);
                let from = if saved > meta.tail_offset { 0 } else { saved };
                reattach.push(ReattachAction {
                    tab_id: tab.clone(),
                    from_offset: from,
                });
            }
            None => teardown.push(tab.clone()),
        }
    }
    let orphans = sessions
        .iter()
        .filter(|meta| meta.alive && !tabs.contains(&meta.tab_id))
        .cloned()
        .collect();
    ReattachPlan { reattach, teardown, orphans }
}

#[cfg(test)]
mod reattach_plan_tests {
    use super::{plan_reattach, ReattachAction};
    use std::collections::HashMap;
    use termflow_pty_protocol::SessionMeta;

    fn meta(tab: &str, head: u64, tail: u64) -> SessionMeta {
        SessionMeta {
            tab_id: tab.into(),
            pid: 1234,
            head_offset: head,
            tail_offset: tail,
            alive: true,
        }
    }

    #[test]
    fn held_session_reattaches_from_saved_offset() {
        let tabs = vec!["t1".to_string()];
        let sessions = vec![meta("t1", 0, 500)];
        let saved = HashMap::from([("t1".to_string(), 320u64)]);
        let plan = plan_reattach(&tabs, &sessions, &saved);
        assert_eq!(
            plan.reattach,
            vec![ReattachAction { tab_id: "t1".into(), from_offset: 320 }]
        );
        assert!(plan.teardown.is_empty());
        assert!(plan.orphans.is_empty());
    }

    #[test]
    fn missing_session_is_torn_down() {
        let tabs = vec!["t1".to_string(), "t2".to_string()];
        let sessions = vec![meta("t2", 0, 10)];
        let plan = plan_reattach(&tabs, &sessions, &HashMap::new());
        assert_eq!(plan.reattach.len(), 1, "t2 survives");
        assert_eq!(plan.teardown, vec!["t1".to_string()], "t1 is gone from the host");
        assert!(plan.orphans.is_empty());
    }

    #[test]
    fn no_saved_offset_replays_whole_ring() {
        let tabs = vec!["t1".to_string()];
        let sessions = vec![meta("t1", 100, 900)];
        let plan = plan_reattach(&tabs, &sessions, &HashMap::new());
        assert_eq!(plan.reattach[0].from_offset, 0, "full replay (host gaps if evicted)");
    }

    /// A saved offset beyond the ring tail is a stale-identity signal (reused
    /// id), NOT a resume point — clamping to tail would silently drop all of
    /// the real session's output, so it must replay from zero.
    #[test]
    fn future_offset_is_a_discontinuity_and_replays_from_zero() {
        let tabs = vec!["t1".to_string()];
        let sessions = vec![meta("t1", 0, 50)];
        let saved = HashMap::from([("t1".to_string(), 5000u64)]);
        let plan = plan_reattach(&tabs, &sessions, &saved);
        assert_eq!(plan.reattach[0].from_offset, 0);
    }

    #[test]
    fn saved_offset_at_or_below_tail_is_used_as_is() {
        let tabs = vec!["t1".to_string()];
        let sessions = vec![meta("t1", 0, 50)];
        let saved = HashMap::from([("t1".to_string(), 50u64)]);
        let plan = plan_reattach(&tabs, &sessions, &saved);
        assert_eq!(plan.reattach[0].from_offset, 50, "exactly-at-tail resumes with no replay");
    }

    #[test]
    fn live_host_session_without_an_app_tab_is_an_orphan() {
        let tabs = vec!["t1".to_string()];
        let sessions = vec![meta("t1", 0, 10), meta("zombie", 0, 10)];
        let plan = plan_reattach(&tabs, &sessions, &HashMap::new());
        assert_eq!(plan.reattach.len(), 1);
        assert!(plan.teardown.is_empty());
        assert_eq!(plan.orphans, vec![meta("zombie", 0, 10)]);
    }

    #[test]
    fn empty_app_and_host_have_no_actions() {
        let plan = plan_reattach(&[], &[], &HashMap::new());
        assert!(plan.reattach.is_empty());
        assert!(plan.teardown.is_empty());
        assert!(plan.orphans.is_empty());
    }

    #[test]
    fn dead_host_session_without_an_app_tab_is_not_an_orphan() {
        let mut dead = meta("finished", 0, 10);
        dead.alive = false;
        let plan = plan_reattach(&[], &[dead], &HashMap::new());
        assert!(plan.reattach.is_empty());
        assert!(plan.teardown.is_empty());
        assert!(plan.orphans.is_empty());
    }

    #[test]
    fn reconciliation_table_covers_all_tab_and_session_presence_pairs() {
        let cases = [
            (vec!["t1".to_string()], vec![meta("t1", 0, 10)], (1, 0, 0)),
            (vec!["t1".to_string()], vec![], (0, 1, 0)),
            (vec![], vec![meta("host-only", 0, 10)], (0, 0, 1)),
            (vec![], vec![], (0, 0, 0)),
        ];
        for (tabs, sessions, expected) in cases {
            let plan = plan_reattach(&tabs, &sessions, &HashMap::new());
            assert_eq!(
                (plan.reattach.len(), plan.teardown.len(), plan.orphans.len()),
                expected,
                "tabs={tabs:?}, sessions={sessions:?}"
            );
        }
    }

    #[test]
    fn cold_restore_claim_prevents_a_recovered_duplicate() {
        let session = meta("tm-restored", 0, 10);
        let plan = plan_reattach(&["tm-restored".into()], &[session], &HashMap::new());
        assert!(plan.orphans.is_empty());
    }

    #[test]
    fn repeating_the_same_cold_sweep_has_one_orphan_identity() {
        let sessions = vec![meta("tm-unclaimed", 0, 10)];
        let first = plan_reattach(&[], &sessions, &HashMap::new());
        let second = plan_reattach(&[], &sessions, &HashMap::new());
        assert_eq!(first.orphans[0].tab_id, second.orphans[0].tab_id);
    }
}
