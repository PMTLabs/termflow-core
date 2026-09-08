use super::super::*;
use super::support::*;

/// **A deleted rule is not resurrected.** The whole reason `add_target_to_rule` exists.
///
/// The path it replaces re-resolved the rule id against the renderer's cached list and sent the
/// whole rule back through `save_rule_as_of`, whose `None` arm INSERTs: window B's delete commits,
/// window A's cache still holds R, the click saves it, and R is back. A re-read of that cache just
/// before the click only narrows the window — the delete can commit between the re-read and the
/// write — so the oracle here is the one no client-side check can satisfy: with the row already
/// gone, the call writes NOTHING.
#[test]
fn adding_a_target_to_a_deleted_rule_writes_nothing_and_says_so() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    // Another window's delete, already committed.
    assert!(store.delete_rule("au-1").unwrap());

    let added = store.add_target_to_rule("au-1", "tm-9", 9_000).unwrap();

    assert!(!added, "a rule that is gone cannot take a target");
    // `Ok(false)` on its own is satisfied by an implementation that writes the row and then
    // reports failure, which is exactly the resurrection this exists to stop — so the table is
    // asserted too, through both readers, because they read it through different predicates.
    assert!(store.get_rule("au-1").unwrap().is_none(), "the deleted rule came back");
    assert!(store.list_rules().unwrap().is_empty(), "…under the list's own reading of the table");
    assert_eq!(
        store.targets_for("au-1").unwrap(),
        vec![],
        "and no orphan target row keyed to a rule that does not exist"
    );
}

/// The append itself: the id lands, and **every other column is left where it was.**
///
/// A whole-struct equality rather than a handful of named fields, because the failure worth
/// catching is the one nobody thinks to assert: `sort_order` reset to 0. That is the column
/// `save_rule_as_of` has to rescue from a renderer, and `write_rule`'s `ON CONFLICT DO UPDATE`
/// overwrites it happily — `rule.sort_order = 0` before the write kills this test.
///
/// `created_at` rides along in the same equality and **cannot fail today**: that same SET list
/// names every column except `created_at`, so the update path leaves a rule's birthday alone
/// whatever this method puts in the struct, and `rule.created_at = at` is a mutant this test
/// survives. It is still asserted rather than assumed, because what makes it safe is a SQL
/// statement two functions away: the day that SET list gains the column, this is what notices.
///
/// `AutomationRule` is `PartialEq`, so the cheapest oracle available is also the widest.
#[test]
fn appending_a_target_adds_the_id_and_touches_nothing_else() {
    let store = AutomationStore::new_in_memory();
    let mut seed = rule("au-1");
    seed.target_ids = vec!["tm-1".into()];
    // Deliberately not the defaults: a write that re-derived either would otherwise land on the
    // value it was supposed to preserve and pass.
    seed.sort_order = 7;
    seed.created_at = 4_000;
    store.save_rule(&seed).unwrap();
    let before = store.get_rule("au-1").unwrap().unwrap();

    assert!(store.add_target_to_rule("au-1", "tm-2", 12_345).unwrap());

    let mut expected = before.clone();
    expected.target_ids.push("tm-2".into());
    // The one column this write authors. `reload` drops a rule's arm keys only when `updated_at`
    // MOVES (Q11), and the set of terminals this rule watches just changed — so it must move.
    expected.updated_at = 12_345;
    assert_eq!(store.get_rule("au-1").unwrap().unwrap(), expected);

    // And the new row is PINNED. `list_rules` reads only pinned rows, so a `matched` one would be
    // dropped from `target_ids` on the next load and the terminal would silently stop being
    // watched — with the rule still showing it in the window that added it.
    assert_eq!(
        store
            .targets_for("au-1")
            .unwrap()
            .into_iter()
            .map(|r| (r.0, r.1))
            .collect::<Vec<_>>(),
        vec![
            ("tm-1".to_string(), "pinned".to_string()),
            ("tm-2".to_string(), "pinned".to_string())
        ]
    );
}

/// An id the rule already watches is a no-op — and specifically one that does not move
/// `updated_at`.
///
/// Both halves matter, and only the first is obvious. `INSERT OR IGNORE` already stops the target
/// row being duplicated; nothing stops the RULE being re-stamped. `reload` drops a rule's arm keys
/// whenever `updated_at` moves (Q11), so a version of this method that appended and wrote
/// unconditionally would silently re-arm a fired rule every time a user picked a menu row that
/// changed nothing.
///
/// It still answers `Ok(true)`: the rule is there and it watches that terminal, which is what the
/// click asked for. `Ok(false)` is reserved for *the rule is gone*, and the caller renders it as
/// exactly that.
#[test]
fn adding_a_target_the_rule_already_has_changes_nothing() {
    let store = AutomationStore::new_in_memory();
    let mut seed = rule("au-1");
    seed.target_ids = vec!["tm-1".into(), "tm-2".into()];
    store.save_rule(&seed).unwrap();
    let before = store.get_rule("au-1").unwrap().unwrap();

    assert!(
        store.add_target_to_rule("au-1", "tm-2", 99_000).unwrap(),
        "the rule is still there, and it watches that terminal"
    );

    assert_eq!(
        store.get_rule("au-1").unwrap().unwrap(),
        before,
        "nothing about the rule moved, `updated_at` least of all"
    );
    assert_eq!(
        store.targets_for("au-1").unwrap().iter().filter(|r| r.0 == "tm-2").count(),
        1,
        "and the terminal was not added a second time"
    );
}

/// The MIRROR of `adding_a_target_to_a_deleted_rule_writes_nothing_and_says_so`, and it is the
/// finding this commit exists for: *Forget it* was still the old shape after the append was
/// fixed, so the identical resurrection was still reachable from the Settings list. Same oracle,
/// because a client-side re-read cannot satisfy it either — with the row already gone, the call
/// writes NOTHING.
#[test]
fn removing_a_target_from_a_deleted_rule_writes_nothing_and_says_so() {
    let store = AutomationStore::new_in_memory();
    let mut seed = rule("au-1");
    seed.target_ids = vec!["tm-1".into(), "tm-2".into()];
    store.save_rule(&seed).unwrap();
    // Another window's delete, already committed.
    assert!(store.delete_rule("au-1").unwrap());

    let removed = store
        .remove_target_from_rule("au-1", &["tm-2".to_string()], 9_000)
        .unwrap();

    assert!(!removed, "a rule that is gone cannot forget a terminal");
    assert!(store.get_rule("au-1").unwrap().is_none(), "the deleted rule came back");
    assert!(store.list_rules().unwrap().is_empty(), "…under the list's own reading of the table");
    assert_eq!(
        store.targets_for("au-1").unwrap(),
        vec![],
        "and no orphan target row keyed to a rule that does not exist"
    );
}

/// The removal itself: the pin goes, **every other column stays**, and `updated_at` moves.
///
/// A whole-struct equality for `appending_a_target_adds_the_id_and_touches_nothing_else`'s
/// reason — the failure worth catching is `sort_order` reset to 0, which `write_rule`'s
/// `ON CONFLICT DO UPDATE` would do happily and which no named-field assertion thinks to look at.
///
/// The `targets_for` half is not a restatement of the `target_ids` half: they read different
/// tables through different predicates, and the way to fail one but not the other is to drop the
/// id from the rule's list while leaving its `automation_targets` row behind — which the next
/// `list_rules` would read straight back in, so *Forget it* would appear to work and then undo
/// itself on the next load.
#[test]
fn forgetting_one_pin_drops_it_and_touches_nothing_else() {
    let store = AutomationStore::new_in_memory();
    let mut seed = rule("au-1");
    seed.target_ids = vec!["tm-1".into(), "tm-2".into()];
    // Deliberately not the defaults, so a write that re-derived either would land on the value it
    // was supposed to preserve and pass.
    seed.sort_order = 7;
    seed.created_at = 4_000;
    store.save_rule(&seed).unwrap();
    let before = store.get_rule("au-1").unwrap().unwrap();

    assert!(store
        .remove_target_from_rule("au-1", &["tm-2".to_string()], 12_345)
        .unwrap());

    let mut expected = before.clone();
    expected.target_ids = vec!["tm-1".to_string()];
    // The one column this write authors. The set of terminals this rule watches just changed, and
    // `reload` drops a rule's arm keys only when `updated_at` MOVES (Q11) — the same sentence the
    // append's test makes, in the other direction.
    expected.updated_at = 12_345;
    assert_eq!(store.get_rule("au-1").unwrap().unwrap(), expected);

    assert_eq!(
        store
            .targets_for("au-1")
            .unwrap()
            .into_iter()
            .map(|r| (r.0, r.1))
            .collect::<Vec<_>>(),
        vec![("tm-1".to_string(), "pinned".to_string())],
        "the forgotten row is gone from the table, not just from the rule's list"
    );
}

/// An id this rule does not watch is a no-op — and specifically one that does not move
/// `updated_at`.
///
/// The button's list is `missing ∩ target_ids` computed in a renderer that may be a commit
/// behind, so naming an id another window already forgot is an ordinary outcome rather than a
/// bug. Answering `Ok(false)` would tell the user their automation had been deleted; writing
/// would re-arm the rule for a click that changed nothing.
#[test]
fn forgetting_an_id_the_rule_never_watched_changes_nothing() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    let before = store.get_rule("au-1").unwrap().unwrap();

    assert!(
        store
            .remove_target_from_rule("au-1", &["tm-9".to_string()], 99_000)
            .unwrap(),
        "the rule is still there, and it does not watch that terminal"
    );

    assert_eq!(
        store.get_rule("au-1").unwrap().unwrap(),
        before,
        "nothing about the rule moved, `updated_at` least of all"
    );
}

/// Emptying an ENABLED pinned rule's pick set is refused, and the refusal writes nothing.
///
/// This is the one blocking problem a removal can CREATE rather than clear, which is why the gate
/// is not the near-unreachable formality it is on the append. It is also the behaviour being
/// preserved: the `save_automation` path this replaces ran the same gate, so a user who could not
/// forget their last pinned terminal yesterday still cannot today — and is told why rather than
/// left with an enabled rule watching nothing.
#[test]
fn forgetting_the_last_pin_of_an_enabled_rule_is_refused_and_writes_nothing() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    let before = store.get_rule("au-1").unwrap().unwrap();
    assert_eq!(before.target_ids, vec!["tm-1".to_string()]);

    let err = store
        .remove_target_from_rule("au-1", &["tm-1".to_string()], 50_000)
        .unwrap_err();
    assert!(
        matches!(&err, AutomationStoreError::Invalid(m) if m.contains("at least one terminal")),
        "{err}"
    );

    // The transaction rolled back: the rule is whole, and its target row is still in the table.
    assert_eq!(store.get_rule("au-1").unwrap().unwrap(), before);
    assert_eq!(
        store.targets_for("au-1").unwrap().into_iter().map(|r| r.0).collect::<Vec<_>>(),
        vec!["tm-1".to_string()]
    );
}

/// The verbose switch's own copy of the same oracle: with the row already gone, nothing is
/// written and the call says so.
#[test]
fn setting_the_verbose_deadline_on_a_deleted_rule_writes_nothing_and_says_so() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    assert!(store.delete_rule("au-1").unwrap());

    assert!(!store.set_verbose_until("au-1", Some(60_000)).unwrap());
    assert!(store.get_rule("au-1").unwrap().is_none(), "the deleted rule came back");
    assert!(store.list_rules().unwrap().is_empty());
}

/// **The write-through is the feature, not a cache detail.**
///
/// `check_passes_gate` falls back to a `SELECT` only on a cache MISS, so a stale entry is never
/// re-read — and the arrangement below is the state that makes that fatal rather than
/// theoretical: the rule's gate has already been consulted once, so `None` is cached, which is
/// exactly what happens to any rule the engine has evaluated. An implementation that updates the
/// row and forgets `verbose_cache` goes on dropping every `Check` entry after the switch is on —
/// verbose visibly enabled, the log staying empty, until a delete, a save or the startup sweep
/// happens to clear the cache.
///
/// The row assertion is separate on purpose: it is what tells a missing write-through apart from
/// a missing `UPDATE`, so the two mutants fail on different lines instead of on the same one.
#[test]
fn the_verbose_switch_reaches_the_gate_through_the_cache_it_writes() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();

    // Seeds `verbose_cache` with the OFF value, the way any evaluated rule seeds it.
    assert!(store.append(&entry("au-1", LogKind::Check, 1_000)).unwrap().is_none());

    assert!(store.set_verbose_until("au-1", Some(60_000)).unwrap());
    assert_eq!(
        store.get_rule("au-1").unwrap().unwrap().verbose_until,
        Some(60_000),
        "the row did not take the deadline"
    );

    assert!(
        store.append(&entry("au-1", LogKind::Check, 3_000)).unwrap().is_some(),
        "the gate is still reading a cached `None` the switch never corrected"
    );
    assert_eq!(
        store
            .load_automation_log(&LogScope::All, LogOrder::Desc, 10)
            .unwrap()
            .iter()
            .map(|e| (e.kind, e.at))
            .collect::<Vec<_>>(),
        vec![(LogKind::Check, 3_000)],
        "identified by its own kind and instant, so no other row can stand in for it"
    );

    // And off again, through the same path — otherwise this test would pass an implementation
    // that hard-coded the cache to "on".
    assert!(store.set_verbose_until("au-1", None).unwrap());
    assert!(store.append(&entry("au-1", LogKind::Check, 5_000)).unwrap().is_none());
}

/// **Turning the log's detail up must not re-arm the rule you turned it up to watch.**
///
/// `reload` drops a rule's arm keys whenever `updated_at` moves (Q11), and the path this replaces
/// — `save_automation`, so `save_rule_as_of` — stamped it on every save. So *Log every check*,
/// the switch a user reaches for when a rule is not firing, re-armed every pair of that rule as
/// a side effect: the receipt they were about to read was produced by a different arm state than
/// the one they were investigating.
///
/// A whole-struct equality rather than an `updated_at` assertion, because it pins the other half
/// too — this must change the one column and no other, and going through `write_rule` (which
/// would also rewrite `sort_order` and replace the target rows) is the implementation that looks
/// most obviously correct.
#[test]
fn switching_verbose_on_leaves_the_rest_of_the_rule_where_it_was() {
    let store = AutomationStore::new_in_memory();
    let mut seed = rule("au-1");
    seed.sort_order = 7;
    seed.created_at = 4_000;
    seed.updated_at = 4_500;
    store.save_rule(&seed).unwrap();
    let before = store.get_rule("au-1").unwrap().unwrap();

    assert!(store.set_verbose_until("au-1", Some(60_000)).unwrap());

    let mut expected = before.clone();
    expected.verbose_until = Some(60_000);
    assert_eq!(
        store.get_rule("au-1").unwrap().unwrap(),
        expected,
        "verbose is a logging gate: it changes this column and nothing else, `updated_at` included"
    );
}

/// **The row a gate validates must be the row that gate writes.**
///
/// `save_rule_as_of` names this race in its own doc and folds its read into its transaction - and
/// nothing swept the rest of the file, so `set_enabled_checked` and `duplicate_automation` kept
/// the `get_rule(...)`-then-write shape. `get_rule` takes and releases its own lock, so another
/// window fits between the two calls. A save may legally persist a DISABLED rule with an empty
/// message (the save gate runs only `if rule.enabled`), so an enable that validated the row
/// before that save lands then sets `enabled = 1` on the row after it; `reload` never re-checks
/// message content, the rule runs, and `deliver` presses a bare Enter into the terminal - the
/// R10 outcome the gate exists to prevent.
///
/// **Asserted on the source, because the defect is an interleaving.** The two shapes are
/// behaviourally identical on any single-threaded run, so a behavioural test cannot tell them
/// apart, and a threaded one would pin one schedule rather than the property. What is pinned here
/// is the structural claim the fix actually makes. Both halves are needed: deleting the read
/// altogether would satisfy the negative on its own.
///
/// `add_target_to_rule` joined the list in the same commit that introduced it rather than waiting
/// to be swept in later, which is the entire lesson of the two that had to be — and
/// `remove_target_from_rule` and `set_verbose_until` join it here for the same reason, in the
/// commit that closes the two sites `add_target_to_rule` alone did not.
#[test]
fn every_read_that_decides_a_write_happens_on_that_write_s_own_transaction() {
    // `sql.rs` was split further, once the crate's 1500-line-per-file ceiling forced
    // `impl AutomationStore` itself apart: `set_enabled_checked` and `duplicate_automation` now
    // live in `sql/methods.rs`, not `sql.rs`. `methods.rs` carries no test module of its own, so it
    // is concatenated AHEAD of `sql.rs` — whose trailing `#[cfg(test)]\nmod tests;` still marks
    // where production code ends — rather than searched separately.
    let module = crate::automation_engine::test_host::strip_comments(concat!(
        include_str!("../../sql/methods.rs"),
        include_str!("../../sql.rs")
    ));
    // The test MODULE, not the first `#[cfg(test)]` - `new_in_memory` carries one hundreds of
    // lines above these functions, and truncating there left `code` holding neither of them while
    // the test still reported success on two `assert!`s it never reached.
    let code = &module[..module
        .find("#[cfg(test)]\nmod tests")
        .expect("the test module must follow the code")];

    let mut checked = 0;
    // Every method that reads a rule in order to decide what to write about it. The last three
    // are the ones whose whole point IS the conditional: an `Ok(false)` arm is only a promise
    // that nothing was written while the read and the write share a transaction. All three of
    // those are one gesture from a Settings list or a context menu that may be a commit behind,
    // so all three are one delete away from resurrecting the rule they were called about.
    for name in [
        "set_enabled_checked",
        "duplicate_automation",
        "add_target_to_rule",
        "remove_target_from_rule",
        "set_verbose_until",
    ] {
        let start = code
            .find(&format!("fn {}(", name))
            .unwrap_or_else(|| panic!("`{}` moved; this test was checking nothing", name));
        let rest = &code[start + 4..];
        let end = rest.find("\n    pub fn ").unwrap_or(rest.len());
        let body = &rest[..end];
        assert!(
            !body.contains("self.get_rule("),
            "`{}` decides from a `get_rule` that takes its own lock: the row it validates is not \
             guaranteed to be the row it writes",
            name
        );
        assert!(
            body.contains("read_rule_on(&tx"),
            "`{}` no longer reads on its own transaction",
            name
        );
        checked += 1;
    }
    assert_eq!(checked, 5, "every call site of the class must be checked");
}

#[test]
fn one_undecodable_row_is_skipped_and_the_rest_of_the_list_survives() {
    let store = AutomationStore::new_in_memory();
    // Two good rules either side of one whose graph blob names a variant this
    // build does not know. That is exactly what an older build sees when it
    // reads a v2 rule (spec §3.3): serde has no #[serde(other)] anywhere, so
    // an unknown ENUM VARIANT fails the decode.
    store.save_rule(&rule_named("first")).unwrap();
    store.save_rule(&rule_named("third")).unwrap();
    write_raw_graph(&store, "au-bad", r#"{"monitor":{"read":"fromTheFuture","cadence":"onOutput","everyMs":0}}"#);

    let rules = store.list_rules().expect("a bad row must not fail the read");

    let names: Vec<&str> = rules.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, vec!["first", "third"], "the good rules must survive");

    let skipped = store.take_skipped_rows();
    assert_eq!(skipped.len(), 1, "the skip must be reported, not silent");
    assert_eq!(skipped[0].0, "au-bad");
    assert!(
        skipped[0].1.contains("newer version"),
        "the reason must be the user-facing one reload() already uses, got: {}",
        skipped[0].1
    );
}

#[test]
fn a_skipped_row_is_reported_once_per_read_not_once_per_row_scanned() {
    let store = AutomationStore::new_in_memory();
    write_raw_graph(&store, "au-bad", r#"{"monitor":{"read":"fromTheFuture","cadence":"onOutput","everyMs":0}}"#);
    store.list_rules().unwrap();
    assert_eq!(store.take_skipped_rows().len(), 1);
    assert_eq!(
        store.take_skipped_rows().len(),
        0,
        "draining must clear — otherwise every reload re-logs the same row forever"
    );
}

#[test]
fn malformed_webhook_values_never_escape_decode_or_save_errors() {
    let secret = "https://hooks.example.invalid/credential-token";
    let malformed = format!(
        r#"{{"webhook":{{"provider":"{secret}","url":"{secret}","body":"done"}}}}"#
    );

    // This is the producer, not a hand-written error: serde really does quote the malformed
    // provider value, which is why forwarding its Display would leak the URL.
    let raw = serde_json::from_str::<AutomationGraph>(&malformed)
        .expect_err("a URL is not a webhook provider")
        .to_string();
    assert!(raw.contains(secret), "premise: serde produced the secret: {raw}");

    let store = AutomationStore::new_in_memory();
    write_raw_graph(&store, "au-malformed", &malformed);
    assert!(store.list_rules().unwrap().is_empty());
    let skipped = store.take_skipped_rows();
    assert_eq!(skipped.len(), 1);
    assert!(!skipped[0].1.contains(secret), "skipped row leaked: {:?}", skipped[0]);
    assert!(skipped[0].1.contains("bad graph blob"));

    // Save errors also carry the store's Display through the command layer. Exercise the real
    // enable/save validation with a well-typed, secret-bearing webhook rule rather than
    // inventing an error text.
    let mut invalid = rule("au-save");
    invalid.graph.webhook = Some(WebhookStep {
        provider: WebhookProvider::Custom,
        url: secret.to_string(),
        body: r#"{\"result\": ${value}}"#.to_string(),
        substitute: true,
    });
    invalid.graph.parse.as_mut().expect("parse fixture").find = r"(?<value>\\w+)".to_string();
    let error = store
        .save_rule(&invalid)
        .expect_err("post-substitution custom JSON is refused")
        .to_string();
    assert!(!error.contains(secret), "save error leaked: {error}");
}

// -----------------------------------------------------------------------------------------
// Plan 032 §5.2/§5.3 — `finds` (read depth) split from the per-clause `Test` (comparison).
// -----------------------------------------------------------------------------------------

