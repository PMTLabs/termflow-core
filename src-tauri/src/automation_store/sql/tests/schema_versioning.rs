use super::super::*;
use super::support::*;









/// One row per term of the predicate, plus the plain rule that must STAY v1. A single row would
/// leave the other six silently wrong — `schema_version_for` folds seven conditions into one
/// bool, and a table is the only shape that shows a wrong term rather than just a wrong result.
#[test]
fn schema_version_is_stamped_from_what_the_rule_actually_uses() {
    assert_eq!(
        stamped(graph()),
        1,
        "a plain four-step rule must still load on an older build"
    );
    assert_eq!(stamped(graph_with_timer()), 2);
    assert_eq!(stamped(graph_with_no_monitor()), 2);
    assert_eq!(stamped(graph_with_no_parse()), 2);
    assert_eq!(stamped(graph_with_no_cond()), 2);
    assert_eq!(stamped(graph_with_one_clause()), 2);
    assert_eq!(stamped(graph_with_substitute()), 2);
    let mut webhook = graph();
    webhook.webhook = Some(WebhookStep { provider: WebhookProvider::Discord, url: "https://example.invalid/hook".into(), body: "build failed".into(), substitute: false });
    assert_eq!(stamped(webhook.clone()), 3);
    webhook.webhook = None;
    assert_eq!(stamped(webhook), 1, "removing the last webhook drops the stamp back");
    let mut no_action = graph();
    no_action.action = None;
    assert_eq!(stamped(no_action), 3);
    // Ships in the same milestone as the two above. An older build decodes such a rule
    // perfectly and ignores the key — it reads the line the user is still typing and fires on
    // it, which is precisely what ticking the box was meant to stop.
    assert_eq!(stamped(graph_with_skip_typed_line()), 3);

    // R4: not sticky. Dropping the last clause must not leave the rule permanently v2 — the
    // opposite (monotonic) behaviour is the more obvious thing to write by accident.
    let mut g = graph_with_one_clause();
    g.cond.as_mut().unwrap().clauses.clear();
    assert_eq!(
        stamped(g),
        1,
        "dropping the last clause makes the rule v1-compatible again"
    );
}

#[test]
fn a_rule_with_exclusions_is_stamped_v3_even_on_a_v1_graph() {
    let mut excluded = rule("au-excluded");
    excluded.schema_version = 1;
    excluded.excluded_ids = vec!["tm-secret".into()];
    assert_eq!(schema_version_for(&excluded), 3);
    excluded.excluded_ids.clear();
    assert_eq!(schema_version_for(&excluded), 1);
    excluded.exclude_criterion_value = "scratch".into();
    assert_eq!(schema_version_for(&excluded), 3);
    excluded.exclude_criterion_value.clear();
    assert_eq!(schema_version_for(&excluded), 1);
}

/// §3.2's whole point: merely loading and re-saving an old rule must not brick it for a
/// downgrade. The in-memory fold (§5.4, `fold_v1_clauses`) gives a v1 numeric rule one clause
/// at LOAD, in the engine, on a copy that is never written back — so the row this test reads
/// back through the STORE (which never runs that fold) must still show zero clauses and `1`.
#[test]
fn saving_a_v1_rule_does_not_promote_it() {
    let store = AutomationStore::new_in_memory();
    let mut v1 = rule("au-v1"); // op/threshold, no clauses — exactly what a v1 build wrote
    v1.schema_version = 1;
    store.save_rule(&v1).unwrap();

    let loaded = store.list_rules().unwrap().pop().unwrap();
    assert_eq!(loaded.schema_version, 1);
    assert!(loaded.graph.cond.as_ref().unwrap().clauses.is_empty());
}

// R3 — a row from a newer build is written back unchanged — is already pinned by
// `a_future_schema_version_rule_is_skipped_not_deleted` above, via `save_rule`, which is one of
// `write_rule`'s five callers. No separate test is added here for the same claim.

/// Plan 032 §4.2: a graph blob written by a build before `substitute` existed has no such key at
/// all — decoding it must not fail, and must not turn substitution on behind the user's back.
/// `awk '{print $1}'` is a message someone may already have saved, and this is the test that
/// pins it keeps sending literally after the upgrade.
///
/// A mutation that changes `#[serde(default)]` to a function returning `true` is exactly the
/// regression this guards: only THIS test would catch it, because every fixture literal in this
/// crate sets `substitute` explicitly and so never exercises serde's own default.
#[test]
fn a_graph_with_no_substitute_key_decodes_with_it_off() {
    let raw = r#"{
        "monitor": {"read": "newOutput", "cadence": "onOutput", "everyMs": 0},
        "parse": {"preset": "custom", "find": "FAILED (\\d+)", "keep": "brackets"},
        "cond": {"kind": "text"},
        "action": {"message": "awk '{print $1}'", "sendTo": "matched", "submit": true, "cliType": "default"}
    }"#;
    let decoded: AutomationGraph =
        serde_json::from_str(raw).expect("a graph missing only a newer optional field must still decode");
    assert!(!decoded.action.as_ref().unwrap().substitute, "a rule from before this field existed must load with it off");
}

#[test]
fn a_webhook_only_rule_writes_no_action_key() {
    let mut graph = graph();
    graph.action = None;
    graph.webhook = Some(WebhookStep { provider: WebhookProvider::Slack, url: "https://example.invalid/hook".into(), body: "build failed".into(), substitute: false });
    assert!(!serde_json::to_string(&graph).unwrap().contains("\"action\""));
}

#[test]
fn a_graph_with_no_webhook_writes_no_webhook_key() {
    assert!(!serde_json::to_string(&graph()).unwrap().contains("\"webhook\""));
}

#[test]
fn a_v1_rule_still_round_trips_byte_for_byte() {
    let v1 = r#"{"monitor":{"read":"newOutput","cadence":"onOutput","everyMs":0},"parse":{"preset":"custom","literal":null,"find":"ctx:(\\d+)%","keep":"brackets"},"cond":{"kind":"number","op":"gt","threshold":25.0},"timer":null,"action":{"message":"prepare to do context-hand-off","sendTo":"matched","submit":true,"cliType":"default","substitute":false}}"#;
    assert_eq!(serde_json::to_string(&serde_json::from_str::<AutomationGraph>(v1).unwrap()).unwrap(), v1);
}

// -- §10.14b ------------------------------------------------------------------------------

