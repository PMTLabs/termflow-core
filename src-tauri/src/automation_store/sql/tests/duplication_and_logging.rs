use super::super::*;
use super::support::*;

/// Asserted as a LIST rather than a spot check: a faulty clone passes §10.14 today. R12, and Clone
/// Rule was the first thing Tam asked for.
#[test]
fn duplicate_automation_produces_an_independent_copy() {
    let store = AutomationStore::new_in_memory();
    let mut original = rule("au-1");
    original.sort_order = 2;
    original.enabled = true;
    original.completed_at = Some(500);
    original.verbose_until = Some(600);
    original.target_ids = vec!["tm-a".into(), "tm-b".into()];
    store.save_rule(&original).unwrap();

    let mut tail = rule("au-tail");
    tail.sort_order = 3;
    store.save_rule(&tail).unwrap();

    store.append(&entry("au-1", LogKind::Sent, 1_000)).unwrap();

    let copy = store.duplicate_automation("au-1", 8_888).unwrap();

    assert!(!copy.enabled, "a copy must not start firing the moment it is created");
    assert_eq!(copy.completed_at, None);
    assert_eq!(copy.verbose_until, None);
    assert_ne!(copy.id, original.id);
    assert_eq!(copy.name, "rule au-1 (copy)");
    let mut copied_ids = copy.target_ids.clone();
    copied_ids.sort();
    assert_eq!(copied_ids, vec!["tm-a".to_string(), "tm-b".to_string()]);
    assert_eq!(
        store.load_automation_log(&LogScope::Rule(copy.id.clone()), LogOrder::Desc, 10).unwrap().len(),
        0,
        "a copy inherits no history"
    );
    // Created now, not when its original was.
    assert_eq!((copy.created_at, copy.updated_at), (8_888, 8_888));

    // The requirement is a POSITION, not an arithmetic relation: the copy sits directly beneath
    // its original in the list's own order.
    let order: Vec<String> =
        store.list_rules().unwrap().into_iter().map(|r| r.id).collect();
    assert_eq!(order, vec!["au-1".to_string(), copy.id.clone(), "au-tail".to_string()]);
    // And the stored slots agree with that order, so it survives a reload.
    assert_eq!(
        store.list_rules().unwrap().into_iter().map(|r| r.sort_order).collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert_eq!(store.get_rule(&copy.id).unwrap().unwrap().sort_order, copy.sort_order);
}

/// Nothing enforces that `sort_order` is unique, and a shift by one cannot place the copy when a
/// sibling already occupies the original's slot: the sibling moves into the copy's intended slot
/// and the tie falls to whichever id sorts first. Asserted as the position, which is the actual
/// requirement.
#[test]
fn duplicate_lands_beneath_its_original_even_when_a_sibling_shares_the_slot() {
    let store = AutomationStore::new_in_memory();
    let mut a = rule("au-a");
    a.sort_order = 2;
    store.save_rule(&a).unwrap();
    // Same slot, and an id that sorts AFTER the original — so it sorts between the original and
    // anything placed at `original.sort_order + 1`.
    let mut sibling = rule("au-b");
    sibling.sort_order = 2;
    store.save_rule(&sibling).unwrap();

    let copy = store.duplicate_automation("au-a", 1).unwrap();

    let order: Vec<String> = store.list_rules().unwrap().into_iter().map(|r| r.id).collect();
    assert_eq!(order, vec!["au-a".to_string(), copy.id, "au-b".to_string()]);
}

/// §10.14d's second half. Five rules, duplicate the MIDDLE one, and assert both the order and the
/// absence of collisions — a tail shift that merely increments produces the right ORDER while
/// leaving two rules sharing a slot, and the next duplicate then falls to whichever uuid sorts
/// first. Asserting the order alone cannot see that.
#[test]
fn duplicating_the_middle_of_five_renumbers_densely_with_no_collisions() {
    let store = AutomationStore::new_in_memory();
    for (i, id) in ["au-1", "au-2", "au-3", "au-4", "au-5"].iter().enumerate() {
        let mut r = rule(id);
        r.sort_order = i as i64;
        r.name = id.to_string();
        store.save_rule(&r).unwrap();
    }

    let copy = store.duplicate_automation("au-3", 1).unwrap();

    let rules = store.list_rules().unwrap();
    let order: Vec<String> = rules.iter().map(|r| r.id.clone()).collect();
    assert_eq!(
        order,
        vec![
            "au-1".to_string(),
            "au-2".to_string(),
            "au-3".to_string(),
            copy.id.clone(),
            "au-4".to_string(),
            "au-5".to_string(),
        ],
        "the copy lands directly beneath its original, and the tail follows"
    );

    let slots: Vec<i64> = rules.iter().map(|r| r.sort_order).collect();
    assert_eq!(slots, vec![0, 1, 2, 3, 4, 5], "dense, and every slot distinct");
}

// -- §10.15 -------------------------------------------------------------------------------

/// R17. The `failed — the terminal closed` line is written AFTER the terminal is gone, so a
/// display-time lookup returns nothing for exactly the line the feature uses to prove itself —
/// and a rename would rewrite the past.
///
/// Both halves are asserted: asserting only the log half passes on a `touch_target` that no-ops,
/// which is the exact defect §7.6 says the draft had.
#[test]
fn a_log_entry_keeps_the_name_it_was_written_with() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-1");
    r.target_ids = vec!["tm-1".into()];
    store.save_rule(&r).unwrap();
    store.append(&entry("au-1", LogKind::Sent, 1_000)).unwrap();

    store
        .touch_target("au-1", "tm-1", Some("renamed"), None, 2_000)
        .unwrap();

    let log = store
        .load_automation_log(&LogScope::Rule("au-1".into()), LogOrder::Desc, 10)
        .unwrap();
    assert_eq!(log[0].terminal_name.as_deref(), Some("claude"), "the entry keeps its snapshot");

    let targets = store.targets_for("au-1").unwrap();
    let row = targets.iter().find(|(id, ..)| id == "tm-1").expect("tm-1 row");
    assert_eq!(row.2.as_deref(), Some("renamed"), "and touch_target really did write");
}

#[test]
fn a_decision_entry_is_never_rate_limited() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    // Same millisecond, verbose off — three sends are three rows.
    for i in 0..3 {
        let mut e = entry("au-1", LogKind::Sent, 1_000);
        e.detail = format!("send {i}");
        assert!(store.append(&e).unwrap().is_some());
    }
    // By content, not by count: three rows of the wrong kind or the wrong rule would satisfy a
    // length assertion.
    let log = store.load_automation_log(&LogScope::All, LogOrder::Asc, 10).unwrap();
    assert_eq!(
        log.iter().map(|e| (e.rule_id.as_str(), e.kind, e.detail.as_str())).collect::<Vec<_>>(),
        vec![
            ("au-1", LogKind::Sent, "send 0"),
            ("au-1", LogKind::Sent, "send 1"),
            ("au-1", LogKind::Sent, "send 2"),
        ]
    );
}

#[test]
fn check_entries_are_dropped_when_verbose_is_off() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();

    assert!(store.append(&entry("au-1", LogKind::Check, 1_000)).unwrap().is_none());
    assert!(store.append(&entry("au-1", LogKind::NoMatch, 2_000)).unwrap().is_none());
    assert_eq!(
        store.load_automation_log(&LogScope::All, LogOrder::Desc, 10).unwrap(),
        vec![]
    );

    // Turn verbose on and the same entry lands — identified by its own kind and instant, so a row
    // written for some other reason cannot stand in for it.
    let mut r = rule("au-1");
    r.verbose_until = Some(60_000);
    store.save_rule(&r).unwrap();
    assert!(store.append(&entry("au-1", LogKind::Check, 3_000)).unwrap().is_some());
    let log = store.load_automation_log(&LogScope::All, LogOrder::Desc, 10).unwrap();
    assert_eq!(
        log.iter().map(|e| (e.kind, e.at)).collect::<Vec<_>>(),
        vec![(LogKind::Check, 3_000)]
    );
}

#[test]
fn the_cap_trims_to_200_and_the_newest_survives() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    // One past CAP + SLACK, which is where exactly one watermark DELETE runs.
    for i in 1..=(LOG_CAP + LOG_SLACK + 1) {
        let mut e = entry("au-1", LogKind::Sent, 1_000 + i);
        e.detail = format!("entry {i}");
        store.append(&e).unwrap();
    }
    let log = store
        .load_automation_log(&LogScope::Rule("au-1".into()), LogOrder::Desc, 1_000)
        .unwrap();
    assert_eq!(log.len() as i64, LOG_CAP);
    assert_eq!(log[0].detail, format!("entry {}", LOG_CAP + LOG_SLACK + 1));
}

// -- §10.15b ------------------------------------------------------------------------------

/// The gate must read each entry's OWN decision timestamp, never one flush-time `now` for the
/// batch — verbose logging exists precisely to show several distinct instants, and a shared `now`
/// collapses them.
///
/// The plan's three instants (`t`, `t+400`, `t+900`) do not on their own distinguish the two
/// implementations: both write one row. **The fourth append past the 1 s boundary is what makes
/// this test able to fail** — with per-entry instants it writes (2 rows), with a shared flush-time
/// `now` it is still inside the same window and does not (1 row).
#[test]
fn the_verbose_limiter_sees_each_entrys_own_instant() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-1");
    r.verbose_until = Some(100_000);
    store.save_rule(&r).unwrap();

    let t = 10_000;
    let written: Vec<bool> = [t, t + 400, t + 900, t + 1_200]
        .iter()
        .map(|at| store.append(&entry("au-1", LogKind::Check, *at)).unwrap().is_some())
        .collect();

    assert_eq!(written, vec![true, false, false, true]);
    let log = store
        .load_automation_log(&LogScope::All, LogOrder::Asc, 10)
        .unwrap();
    assert_eq!(
        log.iter().map(|e| e.at).collect::<Vec<_>>(),
        vec![t, t + 1_200],
        "and each surviving row carries its own instant, not the batch's"
    );
}

// -- §10.16 -------------------------------------------------------------------------------

/// Two windows can hold one rule open and the later save wins whole. The log line naming the
/// loser is the requirement, so the previous `updated_at` has to be read inside the same
/// transaction that overwrites it — a separate `get_rule` then `save_rule` is two locked calls
/// with a race between them.
#[test]
fn save_rule_returns_the_previous_updated_at() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-1");
    r.updated_at = 1_000;
    assert_eq!(store.save_rule(&r).unwrap(), None, "a new rule has no previous version");

    r.updated_at = 2_000;
    assert_eq!(store.save_rule(&r).unwrap(), Some(1_000));

    r.updated_at = 3_000;
    assert_eq!(store.save_rule(&r).unwrap(), Some(2_000));
    assert_eq!(store.get_rule("au-1").unwrap().unwrap().updated_at, 3_000);
}

/// A new rule belongs AFTER every rule that already exists — **and stays where it landed**.
///
/// `list_rules` is `ORDER BY sort_order, id`, and the renderer sends `sortOrder: 0` for a draft
/// because where a new rule lands is not its decision. The first fix minted the slot on the
/// INSERT path only, which is the half of the class that is easy to see: the editor stays open
/// after that first Save, its draft still holds `sortOrder: 0`, and the second Save wrote that
/// zero through and sent the rule back to the top. **The second save is the assertion.**
#[test]
fn a_renderer_save_takes_its_slot_from_the_store_every_time() {
    let store = AutomationStore::new_in_memory();

    let mut a = rule("au-1");
    a.sort_order = 0;
    store.save_rule(&a).unwrap();
    // A gap, which `duplicate_automation`'s renumbering can leave: the next slot is past the
    // HIGHEST, not one past the count.
    let mut b = rule("au-2");
    b.sort_order = 7;
    store.save_rule(&b).unwrap();

    // The renderer's draft: a placeholder zero in every column that is the row's own fact.
    let mut fresh = rule("au-3");
    fresh.sort_order = 0;
    fresh.created_at = 0;
    fresh.updated_at = 0;

    assert_eq!(store.save_rule_as_of(&fresh, 5_000).unwrap(), None, "this rule is new");
    let after_insert = store.get_rule("au-3").unwrap().unwrap();
    assert_eq!(after_insert.sort_order, 8, "a new rule files after the highest slot in use");
    assert_eq!(after_insert.created_at, 5_000);
    assert_eq!(after_insert.updated_at, 5_000);

    // The SECOND save, from the same still-open editor, whose draft never learned any of this.
    assert_eq!(
        store.save_rule_as_of(&fresh, 6_000).unwrap(),
        Some(5_000),
        "the previous `updated_at` names the version this one replaced"
    );
    let after_update = store.get_rule("au-3").unwrap().unwrap();
    assert_eq!(after_update.sort_order, 8, "a re-save must not move the rule in the list");
    assert_eq!(after_update.created_at, 5_000, "a re-save must not change when it was created");
    assert_eq!(
        after_update.updated_at, 6_000,
        "`reload` drops a rule's arm keys only when this moves — Q11 has no other path"
    );
}

/// The save gate applies on this path too, and **before anything is read**.
///
/// `save_rule_as_of` is a second door to the same table, and a second door that skipped
/// `refuse_if_it_would_run_wrong` would let a rule saved with its toggle already on go live
/// unjudged — R10's exact failure, through the one path a renderer actually uses.
#[test]
fn a_renderer_save_is_gated_exactly_as_save_rule_is() {
    let store = AutomationStore::new_in_memory();
    let mut bad = rule("au-1");
    bad.enabled = true;
    bad.graph.action_mut().message = String::new();

    assert!(store.save_rule_as_of(&bad, 1_000).is_err(), "an enabled rule with no message");
    assert!(store.get_rule("au-1").unwrap().is_none(), "and nothing was written");
}

/// `LogClass` is derived from `kind` inside `append` and is not a parameter, so a caller cannot
/// gate a `Sent` entry behind the verbose flag and lose the one line the log exists for.
#[test]
fn a_sent_entry_cannot_be_gated_but_a_check_can() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    // Verbose is off for both. Only the class derived from `kind` separates them.
    let sent = store.append(&entry("au-1", LogKind::Sent, 1_000)).unwrap();
    let check = store.append(&entry("au-1", LogKind::Check, 1_000)).unwrap();
    assert!(sent.is_some(), "a Sent entry always writes");
    assert!(check.is_none(), "a Check entry does not");
}

/// The store owns the DECISION to emit even though its caller performs the emit, so the 1/sec
/// limit cannot be re-implemented per caller — and the rules that wrote inside a shut window are
/// carried into the next emit rather than lost.
#[test]
fn the_activity_emit_is_coalesced_and_names_every_rule_that_wrote() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    store.save_rule(&rule("au-2")).unwrap();

    let first = store.append(&entry("au-1", LogKind::Sent, 10_000)).unwrap().unwrap();
    assert!(first.emit);
    assert_eq!(first.rule_ids, vec!["au-1".to_string()]);

    // Inside the window: no emit, but the rule is remembered.
    let second = store.append(&entry("au-2", LogKind::Sent, 10_300)).unwrap().unwrap();
    assert!(!second.emit);
    assert!(second.rule_ids.is_empty());

    // The window reopens and the emit names BOTH rules — au-2's only entry fell inside the shut
    // window, and a payload that dropped it would leave that row's panel never repainting.
    let third = store.append(&entry("au-1", LogKind::Sent, 11_000)).unwrap().unwrap();
    assert!(third.emit);
    let mut named = third.rule_ids.clone();
    named.sort();
    assert_eq!(named, vec!["au-1".to_string(), "au-2".to_string()]);
}

// -- §10.16b ------------------------------------------------------------------------------

/// Both callers pass scope, order and limit explicitly, so both directions are tested: the drawer
/// is a newest-first peek and the full log is a timeline read forward.
#[test]
fn load_automation_log_honours_scope_order_and_limit() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    store.save_rule(&rule("au-2")).unwrap();
    for (rule_id, at) in [("au-1", 1_000), ("au-2", 2_000), ("au-1", 3_000), ("au-2", 4_000)] {
        let mut e = entry(rule_id, LogKind::Sent, at);
        e.detail = format!("{rule_id}@{at}");
        store.append(&e).unwrap();
    }
    let details = |v: Vec<AutomationLogEntry>| {
        v.into_iter().map(|e| e.detail).collect::<Vec<_>>()
    };

    assert_eq!(
        details(store.load_automation_log(&LogScope::Rule("au-1".into()), LogOrder::Asc, 10).unwrap()),
        vec!["au-1@1000", "au-1@3000"]
    );
    assert_eq!(
        details(store.load_automation_log(&LogScope::Rule("au-1".into()), LogOrder::Desc, 10).unwrap()),
        vec!["au-1@3000", "au-1@1000"]
    );
    assert_eq!(
        details(store.load_automation_log(&LogScope::All, LogOrder::Asc, 10).unwrap()),
        vec!["au-1@1000", "au-2@2000", "au-1@3000", "au-2@4000"]
    );
    // A limit takes the NEWEST rows whichever direction they are then shown in. A forward page of
    // the OLDEST two would show a busy rule's ancient history and never its current behaviour.
    assert_eq!(
        details(store.load_automation_log(&LogScope::All, LogOrder::Asc, 2).unwrap()),
        vec!["au-1@3000", "au-2@4000"]
    );
    assert_eq!(
        details(store.load_automation_log(&LogScope::All, LogOrder::Desc, 2).unwrap()),
        vec!["au-2@4000", "au-1@3000"]
    );
}

#[test]
fn deleting_a_rule_removes_its_targets_and_its_log() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-1");
    r.target_ids = vec!["tm-a".into()];
    store.save_rule(&r).unwrap();
    store.save_rule(&rule("au-2")).unwrap();
    store.append(&entry("au-1", LogKind::Sent, 1_000)).unwrap();
    store.append(&entry("au-2", LogKind::Sent, 2_000)).unwrap();

    assert!(store.delete_rule("au-1").unwrap());
    assert!(!store.delete_rule("au-1").unwrap(), "already absent is Ok(false), not an error");

    assert_eq!(store.get_rule("au-1").unwrap(), None, "the rule itself is gone");
    assert_eq!(store.targets_for("au-1").unwrap(), vec![]);
    // Asserted by IDENTITY, not by count: `DELETE … WHERE rule_id != ?1` also leaves one row.
    let surviving = store.load_automation_log(&LogScope::All, LogOrder::Asc, 10).unwrap();
    assert_eq!(
        surviving.iter().map(|e| e.rule_id.as_str()).collect::<Vec<_>>(),
        vec!["au-2"],
        "au-2's history is what survived"
    );
    assert!(store.get_rule("au-2").unwrap().is_some());
}

/// Reusing an id is the observable regression: without `DELETE FROM automation_exclusions`, a
/// newly saved rule silently inherits the deleted rule's exception rows.
#[test]
fn deleting_then_reusing_a_rule_id_does_not_restore_old_exclusions() {
    let store = AutomationStore::new_in_memory();
    let mut original = rule("au-x");
    original.excluded_ids = vec!["tm-excluded-before-delete".into()];
    store.save_rule(&original).unwrap();

    assert!(store.delete_rule("au-x").unwrap());

    let replacement = rule("au-x");
    store.save_rule(&replacement).unwrap();
    let saved = store.get_rule("au-x").unwrap().unwrap();
    assert!(
        saved.excluded_ids.is_empty(),
        "the replacement must not inherit exclusions from the deleted rule: {:?}",
        saved.excluded_ids
    );
}

#[test]
fn mark_completed_stamps_the_rule_and_reports_a_missing_one() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    assert!(store.mark_completed("au-1", 7_777).unwrap());
    assert_eq!(store.get_rule("au-1").unwrap().unwrap().completed_at, Some(7_777));
    assert!(!store.mark_completed("au-nope", 1).unwrap());
}

/// A criterion-matched terminal is never pinned, so `save_rule` never writes its row. UPDATE-only
/// left it with no row at all — empty for exactly the closed-terminal case the snapshot exists
/// for. Plan §7.6.
#[test]
fn touch_target_upserts_a_matched_terminal_and_throttles_only_last_seen() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();

    store.touch_target("au-1", "tm-m", Some("codex"), Some("D:/a"), 1_000).unwrap();
    // By ID, never by position: the rule also has a PINNED row, and a test that says "the
    // first row" is one ordering change away from asserting about the wrong terminal.
    let row = |s: &AutomationStore| matched_row(s, "au-1", "tm-m");
    let first = row(&store);
    assert_eq!(first.1, "matched", "a never-pinned match still gets a row");
    assert_eq!(first.2.as_deref(), Some("codex"));
    assert_eq!(first.4, Some(1_000));

    // Nothing changed and the throttle window is open: no write.
    store.touch_target("au-1", "tm-m", Some("codex"), Some("D:/a"), 2_000).unwrap();
    assert_eq!(row(&store).4, Some(1_000), "last_seen_at is throttled");

    // A CHANGED label is written immediately, throttle or no throttle.
    store.touch_target("au-1", "tm-m", Some("claude"), Some("D:/a"), 3_000).unwrap();
    let renamed = row(&store);
    assert_eq!(renamed.2.as_deref(), Some("claude"));
    assert_eq!(renamed.4, Some(3_000));

    // Past the throttle window with nothing else changed: last_seen_at alone moves.
    store
        .touch_target("au-1", "tm-m", Some("claude"), Some("D:/a"), 3_000 + LAST_SEEN_THROTTLE_MS)
        .unwrap();
    assert_eq!(row(&store).4, Some(3_000 + LAST_SEEN_THROTTLE_MS));
}

// -- Added after the M1 dual review: guards whose absence let a wrong implementation pass -----

