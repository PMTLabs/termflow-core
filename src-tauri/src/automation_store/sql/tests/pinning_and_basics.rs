use super::super::*;
use super::support::*;




#[test]
fn exclusions_round_trip_through_save_and_list() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-x");
    r.target_mode = TargetMode::Rule;
    r.criterion = Criterion::CommandContains;
    r.criterion_value = "claude".into();
    r.excluded_ids = vec!["tm-b".into(), "tm-c".into()];
    r.exclude_criterion = Some(Criterion::WorkingFolderUnder);
    r.exclude_criterion_value = "~/scratch".into();
    store.save_rule(&r).unwrap();

    let back = store.list_rules().unwrap().into_iter().find(|x| x.id == "au-x").unwrap();
    assert_eq!(back.excluded_ids, vec!["tm-b".to_string(), "tm-c".to_string()]);
    assert_eq!(back.exclude_criterion, Some(Criterion::WorkingFolderUnder));
    assert_eq!(back.exclude_criterion_value, "~/scratch");
}

/// A terminal can be BOTH a pick and an exclusion, and one must not erase the other. This is the
/// test that fails if exclusions are squeezed into `automation_targets.source`, whose primary key
/// (`:1024`) has no room for two memberships of one pair.
#[test]
fn a_terminal_can_be_both_pinned_and_excluded_without_either_erasing_the_other() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-x");
    r.target_ids = vec!["tm-a".into(), "tm-b".into()];   // picks
    r.excluded_ids = vec!["tm-b".into()];                // and tm-b is also excluded
    store.save_rule(&r).unwrap();

    let back = store.list_rules().unwrap().into_iter().find(|x| x.id == "au-x").unwrap();
    assert_eq!(back.target_ids, vec!["tm-a".to_string(), "tm-b".to_string()]);
    assert_eq!(back.excluded_ids, vec!["tm-b".to_string()]);
}

/// BOTH loaders, not just the bulk one. `read_rule_on` is the path get_rule, duplicate, enable and
/// every target mutation take; if only `list_rules` learns exclusions, a duplicate silently drops
/// them and a target edit writes the rule back without them.
#[test]
fn the_single_rule_loader_returns_exclusions_too() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-x");
    r.excluded_ids = vec!["tm-b".into()];
    store.save_rule(&r).unwrap();

    let one = store.get_rule("au-x").unwrap().unwrap();
    assert_eq!(one.excluded_ids, vec!["tm-b".to_string()], "get_rule must agree with list_rules");
}

/// Exclusions must survive a mutation that rewrites the rule for an unrelated reason.
#[test]
fn a_target_mutation_preserves_exclusions() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-x");
    r.excluded_ids = vec!["tm-b".into()];
    store.save_rule(&r).unwrap();
    store.add_target_to_rule("au-x", "tm-z", 2_000).unwrap();
    assert_eq!(store.get_rule("au-x").unwrap().unwrap().excluded_ids, vec!["tm-b".to_string()]);
}




// -- §10.14 -------------------------------------------------------------------------------

/// The second `init` names a **different** file, which is what makes this able to fail. Pointed at
/// the same path, an implementation with no guard at all re-opens the same database, reads the
/// same row back, and passes — the oracle could not tell "ignored" from "redone".
#[test]
fn init_twice_is_ignored() {
    let first = std::env::temp_dir().join(format!("automation-init-a-{}.db", uuid::Uuid::new_v4()));
    let second = std::env::temp_dir().join(format!("automation-init-b-{}.db", uuid::Uuid::new_v4()));
    let store = AutomationStore::new();
    store.init(&first);
    store.save_rule(&rule("au-1")).unwrap();

    store.init(&second);

    let listed = store.list_rules().unwrap();
    assert_eq!(
        listed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["au-1"],
        "the store still reads the database it was initialised with"
    );
    let _ = std::fs::remove_file(&first);
    let _ = std::fs::remove_file(&second);
}

/// Clearing a rule's targets must clear ALL of them. The empty pick set used to be spelled as
/// `terminal_id NOT IN ('')`, and `'' NOT IN ('')` is FALSE — so an empty-string terminal id
/// survived, and the next `list_rules` put it straight back into `target_ids`.
#[test]
fn clearing_the_pick_set_deletes_every_pinned_row() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-1");
    r.target_ids = vec!["tm-a".into(), String::new()];
    store.save_rule(&r).unwrap();
    assert_eq!(store.targets_for("au-1").unwrap().len(), 2);

    // §7.8's save gate refuses a PINNED rule with no targets while it is enabled — which is
    // what the editor's own blocked Save button already told the user. Clearing the picks is
    // therefore something that happens to a rule that is off, and that is the save under test.
    r.enabled = false;
    r.target_ids = vec![];
    store.save_rule(&r).unwrap();

    assert_eq!(store.targets_for("au-1").unwrap(), vec![]);
    assert_eq!(store.get_rule("au-1").unwrap().unwrap().target_ids, Vec::<String>::new());
}

/// Every field, asserted by comparing the WHOLE struct. A field-by-field spot check is how a new
/// column reaches the DTO, the UI and this test's fixture while never reaching the INSERT.
#[test]
fn every_rule_field_round_trips_including_the_graph_blob() {
    let store = AutomationStore::new_in_memory();
    let mut original = rule("au-1");
    original.enabled = false;
    original.runs_once = true;
    original.target_mode = TargetMode::Rule;
    original.criterion = Criterion::WorkingFolderUnder;
    original.criterion_value = "~/work/termflow".to_string();
    original.follow_new = false;
    original.completed_at = Some(9_999);
    original.verbose_until = Some(12_345);
    original.sort_order = 7;
    original.created_at = 111;
    original.updated_at = 222;
    // The `rule()` fixture's own `schema_version` is a stamp value (`SUPPORTED_SCHEMA_VERSION`),
    // not something this write path echoes back: `write_rule` recomputes it from the graph
    // (task 27 / plan 032 §3.2), and `graph()`'s plain four-step shape recomputes to `1`
    // regardless of what the fixture set here. Setting it explicitly documents what the round
    // trip actually asserts, rather than leaning on the fixture's number staying in sync with it.
    original.schema_version = 1;

    store.save_rule(&original).unwrap();
    let loaded = store.get_rule("au-1").unwrap().expect("rule");
    assert_eq!(loaded, original);
    // And through the list path, which decodes the graph blob separately.
    assert_eq!(store.list_rules().unwrap(), vec![original]);
}

#[test]
fn save_rule_replaces_the_pick_set_rather_than_appending() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-1");
    r.target_ids = vec!["tm-a".into(), "tm-b".into()];
    store.save_rule(&r).unwrap();

    r.target_ids = vec!["tm-b".into(), "tm-c".into()];
    store.save_rule(&r).unwrap();

    let loaded = store.get_rule("au-1").unwrap().unwrap();
    let mut ids = loaded.target_ids.clone();
    ids.sort();
    assert_eq!(ids, vec!["tm-b".to_string(), "tm-c".to_string()]);
}

/// The label is written by the BACKEND on its own cadence. A re-save that dropped and reinserted
/// the target rows would throw away exactly the snapshot the picker's "not open" row draws.
#[test]
fn a_re_save_keeps_an_existing_label_snapshot() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("au-1");
    r.target_ids = vec!["tm-a".into()];
    store.save_rule(&r).unwrap();
    store
        .touch_target("au-1", "tm-a", Some("codex"), Some("D:/work"), 5_000)
        .unwrap();

    r.target_ids = vec!["tm-a".into(), "tm-b".into()];
    r.updated_at = 6_000;
    store.save_rule(&r).unwrap();

    let targets = store.targets_for("au-1").unwrap();
    let a = targets.iter().find(|(id, ..)| id == "tm-a").expect("tm-a row");
    assert_eq!(a.2.as_deref(), Some("codex"), "label snapshot survived the re-save");
    assert_eq!(a.3.as_deref(), Some("D:/work"), "folder snapshot survived the re-save");
}

#[test]
fn ensure_column_adds_a_missing_column_to_an_older_table() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute("CREATE TABLE automation_targets (rule_id TEXT, terminal_id TEXT)", [])
        .unwrap();
    // The pre-`folder` shape: a SELECT naming it fails on every existing install without this.
    assert!(conn.query_row("SELECT folder FROM automation_targets", [], |_| Ok(())).is_err());

    AutomationStore::ensure_column(&conn, "automation_targets", "folder", "TEXT").unwrap();
    conn.query_row("SELECT COUNT(folder) FROM automation_targets", [], |r| {
        r.get::<_, i64>(0)
    })
    .expect("folder is queryable after the migration");

    // Idempotent: a second run on an already-migrated table must not fail with "duplicate column".
    AutomationStore::ensure_column(&conn, "automation_targets", "folder", "TEXT").unwrap();
}

/// A bare `bool` would collapse "disabled", "not found" and "SQLite is locked" into one `false`,
/// and the panel would render an empty list where rules exist — inviting a user to recreate rules
/// they already have.
#[test]
fn a_disabled_store_errs_on_every_method() {
    let store = AutomationStore::new();
    let is_disabled = |e: AutomationStoreError| matches!(e, AutomationStoreError::Disabled);

    assert!(is_disabled(store.list_rules().unwrap_err()));
    assert!(is_disabled(store.get_rule("au-1").unwrap_err()));
    assert!(is_disabled(store.save_rule(&rule("au-1")).unwrap_err()));
    assert!(is_disabled(store.delete_rule("au-1").unwrap_err()));
    assert!(is_disabled(store.mark_completed("au-1", 1).unwrap_err()));
    assert!(is_disabled(store.duplicate_automation("au-1", 1).unwrap_err()));
    assert!(is_disabled(store.touch_target("au-1", "tm-a", None, None, 1).unwrap_err()));
    assert!(is_disabled(store.targets_for("au-1").unwrap_err()));
    assert!(is_disabled(store.append(&entry("au-1", LogKind::Sent, 1)).unwrap_err()));
    assert!(is_disabled(
        store.load_automation_log(&LogScope::All, LogOrder::Desc, 10).unwrap_err()
    ));
}

/// Skipped, never deleted, and never coerced. A downgrade is real (multi-instance profiles), and
/// a user whose rules silently vanished after one would have no way to know they still exist.
#[test]
fn a_future_schema_version_rule_is_skipped_not_deleted() {
    let store = AutomationStore::new_in_memory();
    let mut future = rule("au-future");
    future.schema_version = SUPPORTED_SCHEMA_VERSION + 1;
    store.save_rule(&future).unwrap();
    store.save_rule(&rule("au-ok")).unwrap();

    let listed = store.list_rules().unwrap();
    assert_eq!(listed.len(), 2, "the future rule is still listed");
    let loaded = listed.iter().find(|r| r.id == "au-future").unwrap();
    assert_eq!(loaded.schema_version, SUPPORTED_SCHEMA_VERSION + 1);
    assert!(!loaded.is_runnable(), "and the engine is told to skip it");
    assert!(listed.iter().find(|r| r.id == "au-ok").unwrap().is_runnable());
}

// -----------------------------------------------------------------------------------------
// Task 27 / Plan 032 §3.2 — `schema_version` is stamped per rule, only when the graph needs it.
// -----------------------------------------------------------------------------------------

