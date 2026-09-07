use super::super::*;
use super::support::*;

/// The rate-limit key is the PAIR, and until this test both single-field keys passed the whole
/// suite. §3.3 spends a paragraph on the terminal-only variant: *"one chatty rule consumes the
/// whole 1/sec budget and a second rule watching the same terminal writes nothing — its log
/// empty, which reads as 'the rule isn't running'."* Nothing pinned it.
#[test]
fn the_verbose_rate_limit_is_keyed_by_rule_and_terminal_together() {
    let store = AutomationStore::new_in_memory();
    for id in ["au-1", "au-2"] {
        let mut r = rule(id);
        r.verbose_until = Some(100_000);
        store.save_rule(&r).unwrap();
    }
    let check = |rule_id: &str, terminal: &str, at: i64| {
        let mut e = entry(rule_id, LogKind::Check, at);
        e.terminal_id = Some(terminal.to_string());
        e
    };

    // Two RULES, one terminal, 10 ms apart. A terminal-only key drops the second.
    assert!(store.append(&check("au-1", "tm-1", 10_000)).unwrap().is_some());
    assert!(
        store.append(&check("au-2", "tm-1", 10_010)).unwrap().is_some(),
        "a second rule watching the same terminal has its own budget"
    );
    // One rule, two TERMINALS, 10 ms apart. A rule-only key drops the second.
    assert!(
        store.append(&check("au-1", "tm-2", 10_020)).unwrap().is_some(),
        "the same rule watching a second terminal has its own budget"
    );
    // …and the pair that really did just write is still limited.
    assert!(store.append(&check("au-1", "tm-1", 10_030)).unwrap().is_none());

    let written: Vec<(String, Option<String>)> = store
        .load_automation_log(&LogScope::All, LogOrder::Asc, 10)
        .unwrap()
        .into_iter()
        .map(|e| (e.rule_id, e.terminal_id))
        .collect();
    assert_eq!(
        written,
        vec![
            ("au-1".to_string(), Some("tm-1".to_string())),
            ("au-2".to_string(), Some("tm-1".to_string())),
            ("au-1".to_string(), Some("tm-2".to_string())),
        ]
    );
}

/// A `Decision` entry must not spend the pair's `Check` budget. The `if class == Check` around the
/// `last_verbose` write is what stops a `Sent` suppressing the next second of verbose output, and
/// removing it left every test green.
#[test]
fn a_decision_entry_does_not_consume_the_check_budget() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-1");
    r.verbose_until = Some(100_000);
    store.save_rule(&r).unwrap();

    store.append(&entry("au-1", LogKind::Sent, 10_000)).unwrap();
    assert!(
        store.append(&entry("au-1", LogKind::Check, 10_010)).unwrap().is_some(),
        "the Sent 10 ms earlier must not have spent the Check budget"
    );
}

/// §3.1 gives this its own paragraph — two entries can share a millisecond, and the wall clock can
/// move backwards after an NTP correction or a resume. Swapping both `ORDER BY id` clauses to
/// `ORDER BY at` left every other test green, because in all of them `at` rose with insertion.
#[test]
fn the_log_is_ordered_by_id_and_never_by_at() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    for (detail, at) in [("first", 5_000), ("second", 5_000), ("third", 1_000)] {
        let mut e = entry("au-1", LogKind::Sent, at);
        e.detail = detail.to_string();
        store.append(&e).unwrap();
    }
    let details = |order| {
        store
            .load_automation_log(&LogScope::All, order, 10)
            .unwrap()
            .into_iter()
            .map(|e| e.detail)
            .collect::<Vec<_>>()
    };
    // Two share an instant and the third went backwards; insertion order still decides.
    assert_eq!(details(LogOrder::Asc), vec!["first", "second", "third"]);
    assert_eq!(details(LogOrder::Desc), vec!["third", "second", "first"]);
}

/// The `limit` takes the newest rows by `id` too, not by `at`.
#[test]
fn the_log_limit_takes_the_newest_by_id() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    for (detail, at) in [("oldest", 9_000), ("middle", 1_000), ("newest", 5_000)] {
        let mut e = entry("au-1", LogKind::Sent, at);
        e.detail = detail.to_string();
        store.append(&e).unwrap();
    }
    assert_eq!(
        store
            .load_automation_log(&LogScope::All, LogOrder::Asc, 2)
            .unwrap()
            .into_iter()
            .map(|e| e.detail)
            .collect::<Vec<_>>(),
        vec!["middle", "newest"]
    );
}

/// `ensure_column` had a production caller and nothing proved it: deleting the call from
/// `schema()` left all twenty tests green, while every existing install of this branch would fail
/// on the first `SELECT … folder`. This opens a real file holding the PRE-`folder` table.
#[test]
fn init_migrates_a_pre_folder_targets_table() {
    let path = std::env::temp_dir().join(format!("automation-migrate-{}.db", uuid::Uuid::new_v4()));
    {
        let old = Connection::open(&path).unwrap();
        old.execute(
            "CREATE TABLE automation_targets (
                 rule_id TEXT NOT NULL, terminal_id TEXT NOT NULL, source TEXT NOT NULL,
                 label TEXT, label_at INTEGER, last_seen_at INTEGER, added_at INTEGER NOT NULL,
                 PRIMARY KEY (rule_id, terminal_id))",
            [],
        )
        .unwrap();
    }

    let store = AutomationStore::new();
    store.init(&path);

    // Every read of this table names `folder`; without the migration each one is a hard error.
    store.touch_target("au-1", "tm-a", Some("codex"), Some("D:/w"), 1_000).unwrap();
    let rows = store.targets_for("au-1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].3.as_deref(), Some("D:/w"));
    let _ = std::fs::remove_file(&path);
}

/// The emit window must DRAIN its pending list. Replacing `mem::take` with `clone()` passed every
/// assertion the suite had, while in production every later emit would name every rule that ever
/// wrote — a payload that grows forever and repaints rows that did nothing.
#[test]
fn the_activity_emit_drains_its_pending_rules() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    store.save_rule(&rule("au-2")).unwrap();

    store.append(&entry("au-1", LogKind::Sent, 10_000)).unwrap();
    store.append(&entry("au-2", LogKind::Sent, 10_300)).unwrap();
    let second_emit = store.append(&entry("au-1", LogKind::Sent, 11_000)).unwrap().unwrap();
    assert!(second_emit.emit);

    // A later window must name ONLY what wrote since the last emit.
    let third = store.append(&entry("au-1", LogKind::Sent, 12_200)).unwrap().unwrap();
    assert!(third.emit);
    assert_eq!(third.rule_ids, vec!["au-1".to_string()]);
}

/// Both rate limits do interval arithmetic on a wall clock that the schema comment three hundred
/// lines above says moves backwards. Untreated, a correction of N ms silences every activity emit
/// and drops every verbose entry for N ms — in the one mode the user turned on to watch.
#[test]
fn a_backwards_wall_clock_does_not_silence_either_gate() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-1");
    r.verbose_until = Some(1_000_000);
    store.save_rule(&r).unwrap();

    store.append(&entry("au-1", LogKind::Check, 500_000)).unwrap();
    // …and now the clock jumps back a minute.
    assert!(
        store.append(&entry("au-1", LogKind::Check, 440_000)).unwrap().is_some(),
        "a Check after a backwards correction still writes"
    );
    let outcome = store.append(&entry("au-1", LogKind::Sent, 441_000)).unwrap().unwrap();
    assert!(outcome.emit, "and the activity emit resyncs rather than waiting out the skew");
}


/// `None` means "no new value", never "clear the stored one". `label_at` returns `None` once a
/// terminal is gone — exactly when the picker's "not open" row needs the snapshot most.
#[test]
fn touch_target_never_clears_a_stored_label_with_none() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    store.touch_target("au-1", "tm-m", Some("codex"), Some("D:/a"), 1_000).unwrap();

    // The terminal closed: the resolver has no label to offer any more.
    store.touch_target("au-1", "tm-m", None, None, 2_000).unwrap();

    let row = matched_row(&store, "au-1", "tm-m");
    assert_eq!(row.2.as_deref(), Some("codex"), "the label survived the terminal");
    assert_eq!(row.3.as_deref(), Some("D:/a"), "and so did the folder");
}

/// §3.3's startup sweep. The gate is a comparison and does not need it; the column is
/// user-visible and does, or the editor renders "verbose until 10:17" for a deadline days past.
#[test]
fn the_startup_sweep_nulls_deadlines_already_past() {
    let store = AutomationStore::new_in_memory();
    let mut past = rule("au-past");
    past.verbose_until = Some(1_000);
    store.save_rule(&past).unwrap();
    let mut future = rule("au-future");
    future.verbose_until = Some(9_000);
    store.save_rule(&future).unwrap();

    assert_eq!(store.sweep_expired_verbose(5_000).unwrap(), 1);

    assert_eq!(store.get_rule("au-past").unwrap().unwrap().verbose_until, None);
    assert_eq!(store.get_rule("au-future").unwrap().unwrap().verbose_until, Some(9_000));
}

/// §3.2 leans on `id <= NULL` being a safe no-op — *"no separate guard needed"* — but the early
/// return below the cap means the DELETE never ran with a short log, so the claim was untested.
/// Counter drift makes that reachable in production, so drive it directly.
#[test]
fn the_watermark_delete_is_a_no_op_below_the_cap() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    for i in 0..5 {
        let mut e = entry("au-1", LogKind::Sent, 1_000 + i);
        e.detail = format!("entry {i}");
        store.append(&e).unwrap();
    }
    // Pretend the lazily-seeded counter drifted far past the cap, which forces the trim to run
    // against a log of five rows.
    store.log_counts.insert("au-1".to_string(), LOG_CAP + LOG_SLACK + 100);
    let mut e = entry("au-1", LogKind::Sent, 2_000);
    e.detail = "entry 5".to_string();
    store.append(&e).unwrap();

    let details = store
        .load_automation_log(&LogScope::All, LogOrder::Asc, 100)
        .unwrap()
        .into_iter()
        .map(|e| e.detail)
        .collect::<Vec<_>>();
    assert_eq!(
        details,
        vec!["entry 0", "entry 1", "entry 2", "entry 3", "entry 4", "entry 5"],
        "a trim below the cap deletes nothing"
    );
}

// =============================================================================================
// §10.18b — the enable path actually refuses (R10's only backend oracle)
// =============================================================================================

