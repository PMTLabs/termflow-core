use super::super::*;
use super::support::*;


/// **The row toggle bypasses the editor entirely**, which is where the boundary audit found this:
/// the editor gated its own toggle, the store validated nothing semantic, and the engine refused
/// only an uncompilable pattern — so a rule with no terminals and an empty message went live
/// straight from the list. The backend owns *"is this rule allowed to run"*.
#[test]
fn the_enable_path_refuses_an_invalid_rule_and_leaves_it_disabled() {
    let store = AutomationStore::new_in_memory();
    let mut rule = enableable("au-bad");
    rule.enabled = false;
    rule.target_ids.clear();
    rule.graph.action_mut().message = String::new();
    store.save_rule(&rule).unwrap();

    let refused = store.set_enabled_checked("au-bad", true);

    assert!(matches!(refused, Err(AutomationStoreError::Invalid(_))), "{:?}", refused);
    assert!(!enabled_flag(&store, "au-bad"), "refused, and yet the row says enabled");

    // Paired positive: the same call on a rule with nothing wrong with it goes through, so
    // "refuses everything" cannot be how the assertion above passes.
    let good = enableable("au-good");
    store.save_rule(&good).unwrap();
    store.set_enabled_checked("au-good", true).unwrap();
    assert!(enabled_flag(&store, "au-good"));
}

/// **Disabling is never refused.** A rule the user wants stopped is stopped, whatever is wrong
/// with it — refusing to turn off an invalid rule would trap it running, which is the opposite of
/// what the gate is for.
#[test]
fn disabling_is_never_refused_however_broken_the_rule_is() {
    let store = AutomationStore::new_in_memory();

    // Enabled AND broken, through the one route §7.8's save gate still allows: the PATTERN, which
    // the engine re-checks at every load and this gate therefore leaves alone. That is not a
    // convenient loophole, it is the whole shape of the exemption — and a rule in exactly this
    // state is what a user meets after an upgrade changes what compiles.
    let mut bad = enableable("au-bad");
    bad.enabled = true;
    bad.graph.parse_mut().find = "ctx:(\\d+".into();
    store.save_rule(&bad).unwrap();
    assert!(enabled_flag(&store, "au-bad"), "the premise: it is on, and it cannot run");

    store.set_enabled_checked("au-bad", false).unwrap();
    assert!(!enabled_flag(&store, "au-bad"));

    // And the other kind of broken, which can only be stored while it is off: turning a rule
    // that is already off further off is still never a validation question.
    let mut empty = enableable("au-empty");
    empty.enabled = false;
    empty.target_ids.clear();
    empty.graph.action_mut().message = String::new();
    store.save_rule(&empty).unwrap();

    store.set_enabled_checked("au-empty", false).unwrap();
    assert!(!enabled_flag(&store, "au-empty"));
}

/// §7.8's SAVE gate, and the one field it lets through.
///
/// The gate exists for R10: a draft saved with its toggle already on used to go live unjudged, and
/// an empty message makes `deliver` press a bare Enter into whatever is running. The exemption
/// exists for §2.7: `reload` compiles every pattern at load, refuses the ones it cannot, and
/// reports them once per load — a store that refused to write one would make that path dead code
/// here while it stays reachable in production through an older build, a migration, or a regex
/// version that no longer accepts what it once did.
#[test]
fn the_save_gate_refuses_an_enabled_draft_but_never_the_pattern() {
    let store = AutomationStore::new_in_memory();

    let mut broken = enableable("au-1");
    broken.enabled = true;
    broken.graph.action_mut().message = String::new();
    let refused = store.save_rule(&broken);
    assert!(matches!(refused, Err(AutomationStoreError::Invalid(_))), "{:?}", refused);
    assert!(store.get_rule("au-1").unwrap().is_none(), "refused, and yet the row was written");

    // The same rule with its toggle OFF is a draft, and a draft is allowed to be incomplete.
    broken.enabled = false;
    store.save_rule(&broken).unwrap();
    assert!(store.get_rule("au-1").unwrap().is_some());

    // A pattern this build cannot compile is the exemption, enabled or not.
    let mut bad_pattern = enableable("au-2");
    bad_pattern.enabled = true;
    bad_pattern.graph.parse_mut().find = "ctx:(\\d+".into();
    store.save_rule(&bad_pattern).unwrap();
    assert!(enabled_flag(&store, "au-2"), "the engine refuses this one, at load, once");

    // **An EMPTY pattern is exempted too — because the ENGINE now refuses it.** That is the whole
    // shape of this gate: it lets through exactly the set `pattern_refused_at_load` names, and not
    // a field. The first version exempted the whole `parse` field on the reasoning that the engine
    // re-checks the pattern, and the engine re-checked only whether it COMPILED — an empty regex
    // compiles into an expression matching every position of every string, so the rule went live
    // and a presence rule fired on the first byte any terminal printed. Both halves moved: the
    // engine refuses an unusable pattern, and the exemption is derived from that same answer.
    let mut empty_pattern = enableable("au-3");
    empty_pattern.enabled = true;
    empty_pattern.graph.parse_mut().find = "   ".into();
    store.save_rule(&empty_pattern).unwrap();
    assert!(
        crate::automation_validation::pattern_refused_at_load("   ").is_some(),
        "stored enabled, and the engine must be the thing that refuses to run it"
    );

    // **The case that separates a DERIVED exemption from a FIELD one**, and the only one: `parse`
    // carries three blocking problems, and `pattern_refused_at_load` answers `Some` for two of
    // them. A numeric rule keeping the bracketed value, with no brackets, compiles fine — so the
    // engine admits it, `extract` degrades to `Read::Unparsed`, and the rule runs forever without
    // firing. Under `p.field != "parse"` this rule stored ENABLED and the whole suite passed.
    let mut no_group = enableable("au-4");
    no_group.enabled = true;
    no_group.graph.parse_mut().find = r"ctx:\d+%".into();
    assert!(
        crate::automation_validation::pattern_refused_at_load(&no_group.graph.parse_ref().find)
            .is_none(),
        "the premise: the engine will happily run this pattern"
    );
    let refused = store.save_rule(&no_group);
    assert!(matches!(refused, Err(AutomationStoreError::Invalid(_))), "{:?}", refused);
    assert!(store.get_rule("au-4").unwrap().is_none());

    // The claim, narrowed to what is asserted: every pattern this gate lets through is one the
    // engine refuses at load. The converse is NOT claimed — `au-4` above is blocked here and the
    // engine would have run it, which is the entire reason this gate exists.
    for find in ["", "   ", "ctx:(\\d+"] {
        assert!(
            crate::automation_validation::pattern_refused_at_load(find).is_some(),
            "`{}` is exempted by the save gate and would then RUN",
            find
        );
    }
    assert!(crate::automation_validation::pattern_refused_at_load("ctx:(\\d+)%").is_none());

    // And the ENABLE gate still refuses it, so the exemption widens nothing: the only way an
    // uncompilable pattern is stored enabled is by being saved that way.
    store.set_enabled_checked("au-2", false).unwrap();
    let refused = store.set_enabled_checked("au-2", true);
    assert!(matches!(refused, Err(AutomationStoreError::Invalid(_))), "{:?}", refused);
}

/// **§4.3's fallback, which had no test at all.** `list_watchable_terminals` answers an unsaved
/// draft's picker from this, and reverting it to `Ok(Vec::new())` — the exact round-1 defect,
/// where every closed terminal drew as a bare id — passed the whole suite.
///
/// The property under test is *newest by `label_at`, not by `last_seen_at`*: `touch_target`'s
/// throttle refreshes `last_seen_at` on a row whose label is an hour old, so a query ordered the
/// other way returns the stale name. Two rules holding different labels for one terminal is what
/// makes the two orderings disagree; one rule cannot.
#[test]
fn the_newest_snapshot_across_rules_is_the_newest_label_not_the_newest_sighting() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    store.save_rule(&rule("au-2")).unwrap();

    // au-1 saw it first, under its old name.
    store.touch_target("au-1", "tm-shared", Some("bash"), Some("D:/old"), 1_000).unwrap();
    // au-2 saw it later, renamed. This is the row a `label_at` ordering must return.
    store.touch_target("au-2", "tm-shared", Some("claude"), Some("D:/new"), 5_000).unwrap();
    // …and then au-1's row is touched again, which moves only `last_seen_at`. A query ordered by
    // sighting returns "bash" from here on.
    store
        .touch_target("au-1", "tm-shared", None, None, 5_000 + LAST_SEEN_THROTTLE_MS)
        .unwrap();

    let snaps = store.newest_snapshots().unwrap();
    let shared = snaps
        .iter()
        .find(|s| s.terminal_id == "tm-shared")
        .expect("the fallback returned nothing for a terminal two rules have seen");
    assert_eq!(shared.label.as_deref(), Some("claude"), "the stale label won");
    assert_eq!(shared.folder.as_deref(), Some("D:/new"));
    assert_eq!(snaps.iter().filter(|s| s.terminal_id == "tm-shared").count(), 1, "one row per id");
}

/// **The cache is not allowed to become the answer.** A changed label must reach the row even
/// when the cache has an entry, and a repeat inside the throttle must not.
#[test]
fn touch_target_skips_the_row_only_while_nothing_has_changed() {
    let store = AutomationStore::new_in_memory();
    store.save_rule(&rule("au-1")).unwrap();
    store.touch_target("au-1", "tm-1", Some("bash"), Some("D:/a"), 1_000).unwrap();

    // The instrument, made dirty on purpose: change the row behind the cache's back. A second
    // identical touch inside the throttle must not read or write it, so the change survives.
    {
        let guard = store.conn.lock().unwrap();
        guard
            .as_ref()
            .unwrap()
            .execute(
                "UPDATE automation_targets SET label = 'tampered' WHERE rule_id = 'au-1'",
                [],
            )
            .unwrap();
    }
    store.touch_target("au-1", "tm-1", Some("bash"), Some("D:/a"), 2_000).unwrap();
    assert_eq!(
        store.targets_for("au-1").unwrap()[0].2.as_deref(),
        Some("tampered"),
        "the skip did not happen: this touch went to the row"
    );

    // A CHANGED label is never skipped, cache or no cache.
    store.touch_target("au-1", "tm-1", Some("claude"), Some("D:/a"), 3_000).unwrap();
    assert_eq!(store.targets_for("au-1").unwrap()[0].2.as_deref(), Some("claude"));
}

/// A rule that is not there is an error, not a silent no-op: the command's caller shows the
/// message, and an `Ok(())` for a row that was deleted in another window looks like success.
#[test]
fn enabling_a_rule_that_is_not_there_says_so() {
    let store = AutomationStore::new_in_memory();
    assert!(matches!(
        store.set_enabled_checked("au-ghost", true),
        Err(AutomationStoreError::Invalid(_))
    ));
}

/// `clear_completed` is *Reset*'s store half. `Ok(false)` for a rule that is not there, and it
/// touches nothing else on the row.
#[test]
fn clear_completed_un_completes_a_rule_and_leaves_the_rest_of_it_alone() {
    let store = AutomationStore::new_in_memory();
    let mut rule = enableable("au-1");
    rule.runs_once = true;
    store.save_rule(&rule).unwrap();
    store.mark_completed("au-1", 5_000).unwrap();
    assert_eq!(store.get_rule("au-1").unwrap().unwrap().completed_at, Some(5_000));

    assert!(store.clear_completed("au-1").unwrap());
    let after = store.get_rule("au-1").unwrap().unwrap();
    assert_eq!(after.completed_at, None);
    assert_eq!(after.runs_once, true, "reset must not un-tick `run once`");
    assert_eq!(after.enabled, rule.enabled);
    assert_eq!(after.updated_at, rule.updated_at, "and it is not an edit");

    assert!(!store.clear_completed("au-ghost").unwrap());
}

// =============================================================================================
// The atomic target add — the context menu's *Add to an existing automation* row
// =============================================================================================

