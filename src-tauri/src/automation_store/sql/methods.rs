use super::super::model::*;
use super::*;

impl AutomationStore {
    /// Upsert one rule and replace its pinned target set, in one transaction.
    ///
    /// **Returns the previous `updated_at`, read inside that same transaction.** `let old =
    /// get_rule(id)?; save_rule(new)?;` is two locked calls with a race between them, and the `saved`
    /// log line — *"saved from window `main`, replacing the version saved at 20:14:07"* — would then
    /// name the wrong loser. Last-save-wins is the policy (§3.5); the log entry is the requirement, so
    /// it has to be true. `Ok(None)` means this rule is new.
    ///
    /// **A save that arrives with `enabled = true` is an enable, and §7.8 gates it** — otherwise a
    /// draft saved with its toggle already on goes live unjudged, which is R10's exact failure: an
    /// empty message makes `deliver` press a bare Enter into whatever is running.
    ///
    /// **The pattern is the one blocking problem this gate lets through**, and deliberately. §2.7
    /// gives `reload` its own refusal for an uncompilable pattern, reported once per load; a store
    /// that refused to write one would make that path dead code here while it stays genuinely
    /// reachable in production, because a rule saved by an older build, arriving through a migration,
    /// or written against a different regex version can still carry a pattern this build cannot
    /// compile. Nothing is exposed by the exception: a bad pattern is still refused by the ENABLE
    /// path (`set_enabled_checked`), and a rule saved enabled with one is skipped at the next
    /// `reload` with a log row rather than run.
    pub fn save_rule(&self, rule: &AutomationRule) -> Result<Option<i64>, AutomationStoreError> {
        if rule.enabled {
            Self::refuse_if_it_would_run_wrong(rule)?;
        }

        let previous = self.write_rule_committed(rule)?;
        // Write through rather than invalidate: the new value is right here, and a rule saved with
        // verbose just switched on must not wait for a cache miss to start logging.
        self.verbose_cache.insert(rule.id.clone(), rule.verbose_until);
        Ok(previous)
    }

    /// `write_rule`, opening and committing its own transaction. The half of `save_rule` that has
    /// nothing to do with the enable gate, so a caller that needs the write WITHOUT the gate (only
    /// `save_rule_bypassing_the_enable_gate_for_tests` does) has something to call that is not a
    /// second copy of the lock/transaction/commit dance.
    pub(super) fn write_rule_committed(&self, rule: &AutomationRule) -> Result<Option<i64>, AutomationStoreError> {
        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
        let tx = conn.transaction()?;
        let previous = Self::write_rule(&tx, rule)?;
        tx.commit()?;
        Ok(previous)
    }

    /// `save_rule`, without §7.8's enable gate.
    ///
    /// **Test-only, and deliberately so.** Every path a running app can reach — `save_rule` here,
    /// and `set_enabled_checked`'s own re-validation — now refuses to CREATE the row this writes.
    /// But `save_rule`'s own doc above already establishes that such a row is not hypothetical: a
    /// rule enabled by a build OLDER than a validation rule the current build has can still be
    /// sitting in `automation_rules`, is still loaded by `reload` (whose exemption is scoped to
    /// `parse.*`, on purpose — the ENABLE path is what re-checks the rest), and still reaches the
    /// engine's evaluate-and-send loop. This is the one way left to construct that row in a test,
    /// mirroring `write_raw_graph`'s reason for existing: an old build could still write it, so a
    /// test still has to be able to.
    #[cfg(test)]
    pub(crate) fn save_rule_bypassing_the_enable_gate_for_tests(
        &self,
        rule: &AutomationRule,
    ) -> Result<Option<i64>, AutomationStoreError> {
        let previous = self.write_rule_committed(rule)?;
        self.verbose_cache.insert(rule.id.clone(), rule.verbose_until);
        Ok(previous)
    }

    /// The upsert and the target-set replacement, on a caller-supplied transaction.
    ///
    /// Split out so `duplicate_automation` can put its reordering and this write in **one**
    /// transaction. It used to reorder in its own autocommit statement and then call `save_rule`; a
    /// failure in between left the order permanently mutated, with a gap where the copy should have
    /// been and nothing to notice it.
    ///
    /// **Every save-ish method funnels through here**, which is why plan 032 §3.2's stamp is computed
    /// here rather than in `write_rule_committed` (which only `save_rule` and the test-only bypass
    /// reach) — `add_target_to_rule`, `remove_target_from_rule`, `save_rule_as_of` and
    /// `duplicate_automation` all call this directly. Stamping anywhere else would let a future
    /// caller of one of those opt out of it (the `gate-in-the-caller-lets-new-callers-opt-out` shape).
    /// A row from a NEWER build (`rule.schema_version > SUPPORTED_SCHEMA_VERSION`) is written back
    /// with its own number **unchanged**: this build cannot know which v3+ feature such a graph
    /// uses, and recomputing would silently relabel it (task 27 ruling R3).
    ///
    /// **The NUMBER is unchanged. The GRAPH is not (M6 review, doc-only fix).** `rule.graph` here
    /// is not the bytes the newer build wrote — it is whatever THIS build's `serde` could make of
    /// them, decoded lossily by `read_rule_on` before ever reaching this function: a v3+ field this
    /// build's `AutomationGraph` does not know about is already gone. `add_target_to_rule`,
    /// `remove_target_from_rule` and `duplicate_automation` all load a rule this way and re-serialise
    /// the WHOLE graph through here, so each one re-writes a graph already missing whatever it could
    /// not parse. No v3 exists yet, so this is prospective — but the stamp staying honest must not be
    /// read as the graph staying whole, which is exactly the sentence above invited on its own.
    pub(super) fn write_rule(
        tx: &rusqlite::Transaction<'_>,
        rule: &AutomationRule,
    ) -> Result<Option<i64>, AutomationStoreError> {
        let graph = serde_json::to_string(&rule.graph)
            .map_err(|e| AutomationStoreError::Invalid(format!("graph is not serialisable: {e}")))?;
        let target_mode = enum_to_db(&rule.target_mode)?;
        let criterion = enum_to_db(&rule.criterion)?;
        let exclude_criterion = rule.exclude_criterion.as_ref().map(enum_to_db).transpose()?;
        let schema_version = if rule.schema_version <= SUPPORTED_SCHEMA_VERSION {
            schema_version_for(rule)
        } else {
            rule.schema_version
        };

        let previous: Option<i64> = optional_row(tx.query_row(
            "SELECT updated_at FROM automation_rules WHERE id = ?1",
            [&rule.id],
            |r| r.get(0),
        ))?;

        tx.execute(
            "INSERT INTO automation_rules (
                 id, name, enabled, runs_once, target_mode, criterion, criterion_value,
                 exclude_criterion, exclude_criterion_value, follow_new, completed_at, verbose_until,
                 sort_order, schema_version, graph, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
             ON CONFLICT(id) DO UPDATE SET
                 name            = excluded.name,
                 enabled         = excluded.enabled,
                 runs_once       = excluded.runs_once,
                 target_mode     = excluded.target_mode,
                 criterion       = excluded.criterion,
                 criterion_value = excluded.criterion_value,
                 exclude_criterion = excluded.exclude_criterion,
                 exclude_criterion_value = excluded.exclude_criterion_value,
                 follow_new      = excluded.follow_new,
                 completed_at    = excluded.completed_at,
                 verbose_until   = excluded.verbose_until,
                 sort_order      = excluded.sort_order,
                 schema_version  = excluded.schema_version,
                 graph           = excluded.graph,
                 updated_at      = excluded.updated_at",
            rusqlite::params![
                rule.id,
                rule.name,
                rule.enabled,
                rule.runs_once,
                target_mode,
                criterion,
                rule.criterion_value,
                exclude_criterion,
                rule.exclude_criterion_value,
                rule.follow_new,
                rule.completed_at,
                rule.verbose_until,
                rule.sort_order,
                schema_version,
                graph,
                rule.created_at,
                rule.updated_at,
            ],
        )?;

        // REPLACE the pick set, never append to it. `INSERT OR IGNORE` + `UPDATE source` rather than
        // delete-all-then-insert: a re-save must KEEP an existing row's label/folder snapshot, which
        // the backend refreshes on its own cadence through `touch_target`. Deleting and reinserting
        // would throw away the label the picker's "not open" row draws — the one case it exists for.
        if rule.target_ids.is_empty() {
            // No `NOT IN (…)` clause at all. The previous spelling used the literal `''` to stand in
            // for an empty list, and `'' NOT IN ('')` is FALSE — so clearing a rule's targets spared
            // any row whose terminal id was itself the empty string, and the next `list_rules` read it
            // straight back into `target_ids`. An empty pick set means delete them all; say that.
            tx.execute(
                "DELETE FROM automation_targets WHERE rule_id = ?1 AND source = 'pinned'",
                [&rule.id],
            )?;
        } else {
            let placeholders = rule.target_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let mut params: Vec<&dyn rusqlite::ToSql> = vec![&rule.id];
            for id in &rule.target_ids {
                params.push(id);
            }
            tx.execute(
                &format!(
                    "DELETE FROM automation_targets
                      WHERE rule_id = ?1 AND source = 'pinned' AND terminal_id NOT IN ({placeholders})"
                ),
                params.as_slice(),
            )?;
        }
        for id in &rule.target_ids {
            tx.execute(
                "INSERT OR IGNORE INTO automation_targets
                     (rule_id, terminal_id, source, label, folder, label_at, last_seen_at, added_at)
                 VALUES (?1, ?2, 'pinned', NULL, NULL, NULL, NULL, ?3)",
                rusqlite::params![rule.id, id, rule.updated_at],
            )?;
            // A row that already existed as a criterion match becomes pinned once the user ticks it,
            // keeping its snapshot. Without this the id sits in `target_ids` with `source='matched'`,
            // and `list_rules` — which reads only pinned rows — drops it on the next load.
            tx.execute(
                "UPDATE automation_targets SET source = 'pinned'
                  WHERE rule_id = ?1 AND terminal_id = ?2",
                rusqlite::params![rule.id, id],
            )?;
        }
        tx.execute(
            "DELETE FROM automation_exclusions WHERE rule_id = ?1",
            [&rule.id],
        )?;
        for id in &rule.excluded_ids {
            tx.execute(
                "INSERT OR IGNORE INTO automation_exclusions (rule_id, terminal_id, added_at)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![rule.id, id, rule.updated_at],
            )?;
        }
        Ok(previous)
    }

    /// Delete a rule and everything keyed to it, in one transaction. `Ok(false)` = already absent.
    pub fn delete_rule(&self, id: &str) -> Result<bool, AutomationStoreError> {
        let n = {
            let mut guard = self.conn.lock().unwrap();
            let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
            let tx = conn.transaction()?;
            tx.execute("DELETE FROM automation_targets WHERE rule_id = ?1", [id])?;
            tx.execute("DELETE FROM automation_exclusions WHERE rule_id = ?1", [id])?;
            tx.execute("DELETE FROM automation_log WHERE rule_id = ?1", [id])?;
            let n = tx.execute("DELETE FROM automation_rules WHERE id = ?1", [id])?;
            tx.commit()?;
            n
        };
        self.log_counts.remove(id);
        self.last_verbose.retain(|(rule_id, _), _| rule_id != id);
        self.verbose_cache.remove(id);
        self.target_cache.retain(|(rule_id, _), _| rule_id != id);
        Ok(n > 0)
    }

    /// Flip a rule's `enabled` flag, **re-validating on the way in** (plan §7.8, R10).
    ///
    /// The boundary audit's finding was that the enable path had no gate at all: the editor validated
    /// its own toggle, the store validated nothing semantic, and the engine refused only an
    /// uncompilable pattern — so a rule with no terminals and an empty message went live straight from
    /// the list row, where the editor's validation never runs. The backend owns *"is this rule allowed
    /// to run"* and must not be talked into it by a stale renderer.
    ///
    /// Disabling is never refused. A rule the user wants stopped is stopped, whatever is wrong with
    /// it — refusing to turn off an invalid rule would trap it running.
    ///
    /// The Tauri command is a two-line wrapper over this, per §7.10: this is the thing worth testing,
    /// and it needs no `AppHandle`.
    pub fn set_enabled_checked(
        &self,
        rule_id: &str,
        enabled: bool,
    ) -> Result<(), AutomationStoreError> {
        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
        let tx = conn.transaction()?;

        // **The row this validates is the row it flips.** `get_rule` takes and releases its own lock,
        // so a `get_rule` + `UPDATE` pair is two locked calls with a gap - and this gate is only worth
        // having if nothing can replace the rule inside that gap. A save may legally persist a
        // DISABLED rule with an empty message (the save gate's `refuse_if_it_would_run_wrong` runs
        // only `if rule.enabled`), so the losing interleaving is not exotic: window A saves that
        // draft while window B switches the rule on, B validates the pre-A row, A's write lands, and
        // B's `UPDATE` sets `enabled = 1` on it. `reload` never re-checks message content, so the
        // rule runs and `deliver` presses a bare Enter into the terminal - the exact R10 outcome this
        // gate exists to prevent.
        if enabled {
            let rule = Self::read_rule_on(&tx, rule_id)?
                .ok_or_else(|| AutomationStoreError::Invalid(format!("no rule {}", rule_id)))?;
            Self::refuse_if_invalid(&rule)?;
        }
        tx.execute(
            "UPDATE automation_rules SET enabled = ?1 WHERE id = ?2",
            rusqlite::params![enabled as i64, rule_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Stamp a runs-once rule as completed. `Ok(false)` = no such rule.
    ///
    /// This row is the SECOND line of defence, not the mechanism: the engine also drops the rule from
    /// its live set in the same critical section. A completed rule that stayed in memory kept logging
    /// `held`, and the next crossing sent a **second** message in the same session from a rule the UI
    /// already showed as Completed. Plan §7.8.
    pub fn mark_completed(&self, rule_id: &str, at: i64) -> Result<bool, AutomationStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        Ok(conn.execute(
            "UPDATE automation_rules SET completed_at = ?1 WHERE id = ?2",
            rusqlite::params![at, rule_id],
        )? > 0)
    }

    /// The ENABLE gate (§7.8): every blocking problem, because after this the rule RUNS.
    ///
    /// §7.8's second call site — *"any save with `enabled = true`"* — is `refuse_if_it_would_run_wrong`
    /// below, wired since round 1's H-1. *(This paragraph used to say that gate was deferred, and it
    /// stood for three commits after the gate was written, one of which was about this very gate.)*
    pub(super) fn refuse_if_invalid(rule: &AutomationRule) -> Result<(), AutomationStoreError> {
        Self::refuse(crate::automation_validation::problems(rule))
    }

    /// The SAVE gate (§7.8): everything the engine does not independently refuse.
    ///
    /// **The exemption is derived, not named.** It used to be `p.field != "parse"` — a whole FIELD,
    /// on the reasoning that the engine re-checks the pattern. The engine re-checked whether the
    /// pattern COMPILED, and `parse` also carries an empty pattern, which compiles into an expression
    /// matching every position of every string: a presence rule saved enabled with `find = ""` went
    /// live and typed into the first terminal that printed anything. `pattern_refused_at_load` is now
    /// the single answer to *"will the engine refuse this?"*, asked here and by `reload`, so the two
    /// cannot drift apart again.
    pub(super) fn refuse_if_it_would_run_wrong(rule: &AutomationRule) -> Result<(), AutomationStoreError> {
        // A rule with no parse step has no pattern for the engine to refuse, so nothing on the
        // `parse` field is exempted for it — `pattern_problems` reports nothing there either.
        let engine_will_refuse = rule
            .graph
            .parse
            .as_ref()
            .is_some_and(|p| crate::automation_validation::pattern_refused_at_load(&p.find).is_some());
        Self::refuse(
            crate::automation_validation::problems(rule)
                .into_iter()
                .filter(|p| !(engine_will_refuse && p.field == "parse"))
                .collect(),
        )
    }

    pub(super) fn refuse(
        problems: Vec<crate::automation_validation::Problem>,
    ) -> Result<(), AutomationStoreError> {
        let blocking: Vec<String> = problems
            .into_iter()
            .filter(crate::automation_validation::Problem::blocks)
            .map(|p| p.message)
            .collect();
        if blocking.is_empty() {
            return Ok(());
        }
        Err(AutomationStoreError::Invalid(blocking.join(" ")))
    }

    /// Un-complete a runs-once rule, so it can run again. `Ok(false)` = no such rule.
    ///
    /// The engine purge is the caller's other half and they are one command (§7.8): a rule whose row
    /// says it may run again while its arm keys still say `Fired` re-arms on its next false read and
    /// fires with no crossing.
    pub fn clear_completed(&self, rule_id: &str) -> Result<bool, AutomationStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        Ok(conn.execute(
            "UPDATE automation_rules SET completed_at = NULL WHERE id = ?1",
            [rule_id],
        )? > 0)
    }

    /// Copy a rule to a fresh id, directly beneath the original. R12 — Tam's first request.
    ///
    /// Deliberately not a bare clone-with-a-new-id: an enabled duplicate starts firing the moment it
    /// is created, and a copied `completed_at` makes it Completed before it has ever run.
    pub fn duplicate_automation(
        &self,
        id: &str,
        at: i64,
    ) -> Result<AutomationRule, AutomationStoreError> {
        let mut guard = self.conn.lock().unwrap();
        let conn = guard.as_mut().ok_or(AutomationStoreError::Disabled)?;
        let tx = conn.transaction()?;

        // **Read inside the transaction that writes the copy**, for `save_rule_as_of`'s reason. The
        // editor's Duplicate button is gated only on the draft HAVING an id - deliberately not on the
        // in-flight save that `disabled={saving}` guards for the Save button - so Save followed by
        // Duplicate before the round trip commits clones the version the save is replacing.
        let original = Self::read_rule_on(&tx, id)?
            .ok_or_else(|| AutomationStoreError::Invalid(format!("no such rule {id}")))?;
        let mut copy = original.clone();
        copy.id = format!("au-{}", uuid::Uuid::new_v4());
        copy.name = format!("{} (copy)", original.name);
        copy.enabled = false;
        copy.completed_at = None;
        copy.verbose_until = None;
        // A copy was created now, not when its original was. `at` is a parameter rather than a call to
        // the clock, so the store keeps taking time from its caller the way `mark_completed` and
        // `touch_target` already do — and so this is testable.
        copy.created_at = at;
        copy.updated_at = at;

        // Renumber the whole list densely rather than shifting the tail by one.
        //
        // A `sort_order + 1 WHERE sort_order > original` shift assumes sort orders are unique, and
        // nothing enforces that. With a second rule already sharing the original's slot, the shift
        // moves that rule into the copy's intended slot, the tie is broken by id, and the copy can
        // still land beneath a rule that is not its original — which is the whole requirement. There
        // is also no integer between `n` and `n+1` to escape to. Rewriting the order is deterministic,
        // self-healing for duplicate slots already stored, and this table holds tens of rows and is
        // renumbered only on an explicit duplicate.
        let existing: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM automation_rules ORDER BY sort_order, id")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let mut v = Vec::new();
            for row in rows {
                v.push(row?);
            }
            v
        };
        Self::write_rule(&tx, &copy)?;

        let mut order = Vec::with_capacity(existing.len() + 1);
        for rule_id in existing {
            let is_original = rule_id == original.id;
            order.push(rule_id);
            if is_original {
                order.push(copy.id.clone());
            }
        }
        for (slot, rule_id) in order.iter().enumerate() {
            tx.execute(
                "UPDATE automation_rules SET sort_order = ?1 WHERE id = ?2",
                rusqlite::params![slot as i64, rule_id],
            )?;
        }
        tx.commit()?;

        copy.sort_order = order
            .iter()
            .position(|r| r == &copy.id)
            .map(|p| p as i64)
            .unwrap_or(copy.sort_order);
        Ok(copy)
    }

    // ------------------------------------------------------------------------------------------
    // Targets
    // ------------------------------------------------------------------------------------------

    /// Refresh one terminal's label/folder snapshot, inserting the row when this is a criterion match
    /// that was never pinned.
    ///
    /// **Upsert, not UPDATE-only.** The draft was UPDATE-only and throttled to one write per five
    /// minutes, so a criterion-matched id — for which `save_rule` never writes a row — had no row at
    /// all, and the picker's "not open" row had nothing to draw for exactly the closed-terminal case
    /// the snapshot exists for. A CHANGED label or folder is written immediately; only `last_seen_at`
    /// is throttled. `source` is never downgraded: a pinned row touched by the targeting tick stays
    /// pinned. Plan §7.6.
    pub fn touch_target(
        &self,
        rule_id: &str,
        terminal_id: &str,
        label: Option<&str>,
        folder: Option<&str>,
        at: i64,
    ) -> Result<(), AutomationStoreError> {
        let key = (rule_id.to_string(), terminal_id.to_string());
        // The whole question, answered without the lock: this row already says what we were about to
        // write, and its `last_seen_at` is inside the throttle. `None` means "no new value for this",
        // never "clear it", so a `None` argument agrees with whatever is stored.
        if let Some(cached) = self.target_cache.get(&key) {
            let (l, f, seen) = cached.value();
            let same = label.is_none_or(|new| Some(new) == l.as_deref())
                && folder.is_none_or(|new| Some(new) == f.as_deref());
            if same && at - seen < LAST_SEEN_THROTTLE_MS {
                return Ok(());
            }
        }
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        let existing: Option<(Option<String>, Option<String>, Option<i64>)> =
            optional_row(conn.query_row(
                "SELECT label, folder, last_seen_at FROM automation_targets
                  WHERE rule_id = ?1 AND terminal_id = ?2",
                rusqlite::params![rule_id, terminal_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ))?;

        let Some((old_label, old_folder, last_seen)) = existing else {
            conn.execute(
                "INSERT INTO automation_targets
                     (rule_id, terminal_id, source, label, folder, label_at, last_seen_at, added_at)
                 VALUES (?1, ?2, 'matched', ?3, ?4, ?5, ?5, ?5)",
                rusqlite::params![rule_id, terminal_id, label, folder, at],
            )?;
            self.target_cache.insert(
                key,
                (label.map(str::to_string), folder.map(str::to_string), at),
            );
            return Ok(());
        };

        // `None` means "I have no new value for this", never "clear the stored one". `label_at`
        // returns `None` once a terminal is gone, and that is exactly when the snapshot has to
        // survive — clearing it there empties the picker's "not open" row of the label it exists to
        // draw, which is the one case §7.6 was written for.
        let label = label.or(old_label.as_deref());
        let folder = folder.or(old_folder.as_deref());

        // `last_seen_at` as the ROW now holds it, which is not always `at`: the throttle branch
        // deliberately does not write, and a cache that recorded `at` anyway would extend the throttle
        // by one full period every time it was asked.
        let mut seen_now = last_seen.unwrap_or(0);
        if old_label.as_deref() != label || old_folder.as_deref() != folder {
            conn.execute(
                "UPDATE automation_targets
                    SET label = ?3, folder = ?4, label_at = ?5, last_seen_at = ?5
                  WHERE rule_id = ?1 AND terminal_id = ?2",
                rusqlite::params![rule_id, terminal_id, label, folder, at],
            )?;
            seen_now = at;
        } else if at - seen_now >= LAST_SEEN_THROTTLE_MS {
            conn.execute(
                "UPDATE automation_targets SET last_seen_at = ?3
                  WHERE rule_id = ?1 AND terminal_id = ?2",
                rusqlite::params![rule_id, terminal_id, at],
            )?;
            seen_now = at;
        }
        self.target_cache.insert(
            key,
            (label.map(str::to_string), folder.map(str::to_string), seen_now),
        );
        Ok(())
    }

    /// The newest snapshot for **every** terminal id, across all rules (plan §4.3).
    ///
    /// The picker's fallback when the caller has no rule to scope to — an unsaved draft, which is the
    /// case a template is tested in. §4.3: *"scoped to `rule_id` when the caller passes one … else the
    /// newest row for that id across rules. `rule_id: None` with an unknown id is the only case that
    /// yields `label: None, cwd: None`."* Without it every closed terminal in a fresh draft's picker
    /// renders as a bare id, which is the one row the snapshot exists for.
    ///
    /// "Newest" is `label_at`, not `last_seen_at`: the question is *when was this NAME true*, and a
    /// row touched every 30 s by `touch_target`'s throttle carries a recent `last_seen_at` beside a
    /// label from an hour ago.
    ///
    /// The `MAX()`-with-bare-columns form is SQLite's documented bare-column rule: in a query with a
    /// single `min()`/`max()` aggregate, the non-aggregated columns come from the row that produced
    /// it. That is the whole point here — a `GROUP BY` without it would return one rule's label beside
    /// another rule's folder. With every `label_at` NULL the row chosen is arbitrary, which is correct:
    /// there is nothing to prefer.
    pub fn newest_snapshots(
        &self,
    ) -> Result<Vec<crate::automation::roster::TargetSnapshot>, AutomationStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        let mut stmt = conn.prepare(
            "SELECT terminal_id, label, folder, MAX(label_at) FROM automation_targets
              GROUP BY terminal_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(crate::automation::roster::TargetSnapshot {
                terminal_id: r.get(0)?,
                label: r.get(1)?,
                folder: r.get(2)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// One rule's stored targets: `(terminal_id, source, label, folder, last_seen_at)`.
    #[allow(clippy::type_complexity)]
    pub fn targets_for(
        &self,
        rule_id: &str,
    ) -> Result<
        Vec<(String, String, Option<String>, Option<String>, Option<i64>)>,
        AutomationStoreError,
    > {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        let mut stmt = conn.prepare(
            "SELECT terminal_id, source, label, folder, last_seen_at FROM automation_targets
              WHERE rule_id = ?1 ORDER BY added_at, terminal_id",
        )?;
        let rows = stmt.query_map([rule_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    // ------------------------------------------------------------------------------------------
    // The activity log
    // ------------------------------------------------------------------------------------------

    /// The one activity-log writer, the one cap, and the one thing that decides whether
    /// `automation:activity` is due.
    ///
    /// `Ok(None)` means the verbose gate dropped the entry — a normal outcome, not a failure. The
    /// store performs no emit itself: it holds no `AppHandle`, deliberately (see the module doc), so
    /// the caller emits when `AppendOutcome.emit` is true.
    ///
    /// `entry.at` is the entry's own DECISION timestamp and drives both gates. One flush-time `now`
    /// for a whole batch would collapse ten distinct verbose entries into one, breaking the exact
    /// feature verbose logging exists for. Plan §7.5.
    pub fn append(
        &self,
        entry: &AutomationLogEntry,
    ) -> Result<Option<AppendOutcome>, AutomationStoreError> {
        let class = class_of(entry.kind);
        if class == LogClass::Check && !self.check_passes_gate(entry)? {
            return Ok(None);
        }

        let kind = enum_to_db(&entry.kind)?;
        let entry_id = {
            let guard = self.conn.lock().unwrap();
            let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
            conn.execute(
                "INSERT INTO automation_log (rule_id, terminal_id, terminal_name, kind, detail, at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    entry.rule_id,
                    entry.terminal_id,
                    entry.terminal_name,
                    kind,
                    entry.detail,
                    entry.at
                ],
            )?;
            conn.last_insert_rowid()
        };

        if class == LogClass::Check {
            self.last_verbose
                .insert((entry.rule_id.clone(), entry.terminal_id.clone()), entry.at);
        }
        if let Err(e) = self.bump_and_trim(&entry.rule_id) {
            // The row is already written. A failure to TRIM is not a failure to append, and returning
            // it as one would make the caller log a failed send that actually landed.
            log::warn!("[AUTOMATION] log trim failed for {}: {}", entry.rule_id, e);
        }

        let mut emit = self.emit.lock().unwrap();
        if !emit.pending.contains(&entry.rule_id) {
            emit.pending.push(entry.rule_id.clone());
        }
        if entry.at < emit.last_ms {
            // The wall clock moved backwards. Left alone, `last_ms` sits in the future and NO
            // `automation:activity` is emitted until real time catches up — the panel silently stops
            // repainting for the length of the correction. Resync instead of waiting it out.
            emit.last_ms = entry.at;
        }
        let due = entry.at - emit.last_ms >= EMIT_MIN_INTERVAL_MS;
        let rule_ids = if due {
            emit.last_ms = entry.at;
            std::mem::take(&mut emit.pending)
        } else {
            Vec::new()
        };
        Ok(Some(AppendOutcome {
            entry_id,
            emit: due,
            rule_ids,
        }))
    }

    /// A `Check` entry writes only while verbose is on for its rule AND its pair has been quiet for a
    /// second. `Decision` entries never reach here.
    pub(super) fn check_passes_gate(&self, entry: &AutomationLogEntry) -> Result<bool, AutomationStoreError> {
        // Copied out so the shard guard drops before anything else takes a lock.
        let cached = self.verbose_cache.get(&entry.rule_id).map(|r| *r);
        let verbose_until: Option<i64> = match cached {
            Some(v) => v,
            None => {
                let v = {
                    let guard = self.conn.lock().unwrap();
                    let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
                    optional_row(conn.query_row(
                        "SELECT verbose_until FROM automation_rules WHERE id = ?1",
                        [&entry.rule_id],
                        |r| r.get(0),
                    ))?
                    .flatten()
                };
                self.verbose_cache.insert(entry.rule_id.clone(), v);
                v
            }
        };
        if !matches!(verbose_until, Some(until) if entry.at < until) {
            return Ok(false);
        }
        let last = self
            .last_verbose
            .get(&(entry.rule_id.clone(), entry.terminal_id.clone()))
            .map(|r| *r);
        Ok(match last {
            // A stored instant in the FUTURE means the wall clock moved backwards — an NTP
            // correction, or a resume, which this app already handles as an event and which the
            // `automation_log` schema comment above names explicitly. Treat it as no history rather
            // than suppressing every Check until real time catches up: verbose mode is precisely the
            // state the user turned on in order to watch.
            Some(prev) if prev > entry.at => true,
            Some(prev) => entry.at - prev >= VERBOSE_MIN_INTERVAL_MS,
            None => true,
        })
    }

    /// Keep one rule's log at the cap without a scan per write.
    ///
    /// The watermark DELETE yields NULL when the rule has fewer than `LOG_CAP` rows, and `id <= NULL`
    /// is NULL, so it is a safe no-op — no separate guard needed. Plan §3.2.
    pub(super) fn bump_and_trim(&self, rule_id: &str) -> Result<(), AutomationStoreError> {
        let seeded = self.log_counts.get(rule_id).map(|r| *r);
        let count = match seeded {
            // The seeded counter is the count BEFORE this append.
            Some(n) => n + 1,
            // The seeding query runs after the insert, so it already includes this row.
            None => {
                let guard = self.conn.lock().unwrap();
                let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
                conn.query_row(
                    "SELECT COUNT(*) FROM automation_log WHERE rule_id = ?1",
                    [rule_id],
                    |r| r.get::<_, i64>(0),
                )?
            }
        };
        if count <= LOG_CAP + LOG_SLACK {
            self.log_counts.insert(rule_id.to_string(), count);
            return Ok(());
        }
        {
            let guard = self.conn.lock().unwrap();
            let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
            conn.execute(
                "DELETE FROM automation_log
                  WHERE rule_id = ?1
                    AND id <= (SELECT id FROM automation_log WHERE rule_id = ?1
                                ORDER BY id DESC LIMIT 1 OFFSET ?2)",
                rusqlite::params![rule_id, LOG_CAP],
            )?;
        }
        self.log_counts.insert(rule_id.to_string(), LOG_CAP);
        Ok(())
    }

    /// Read the log. **Both callers pass scope, order and limit explicitly** — the drawer is a
    /// recent-activity peek (newest first) and the full log is a timeline read forward (oldest first),
    /// and round 0's audit found the two surfaces disagreeing with nothing to settle it.
    ///
    /// `limit` always takes the NEWEST rows, whichever direction they are then returned in: a
    /// forward-ordered page of the oldest 50 entries would show a busy rule's ancient history and
    /// never its current behaviour.
    pub fn load_automation_log(
        &self,
        scope: &LogScope,
        order: LogOrder,
        limit: i64,
    ) -> Result<Vec<AutomationLogEntry>, AutomationStoreError> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AutomationStoreError::Disabled)?;
        let where_clause = match scope {
            LogScope::Rule(_) => "WHERE rule_id = ?1",
            LogScope::All => "",
        };
        // `limit` is interpolated rather than bound purely so the optional `?1` above keeps index 1
        // in both scopes — SQLite binds parameters in LIMIT perfectly well, so this is a readability
        // choice, not a limitation. It is injection-safe because the value is an `i64`; it is clamped
        // because SQLite reads a NEGATIVE limit as *unlimited*, and this value reaches the store from
        // a Tauri command once M4 lands.
        let limit = limit.max(0);
        let sql = format!(
            "SELECT id, rule_id, terminal_id, terminal_name, kind, detail, at
               FROM (SELECT * FROM automation_log {where_clause} ORDER BY id DESC LIMIT {limit})
              ORDER BY id {}",
            match order {
                LogOrder::Asc => "ASC",
                LogOrder::Desc => "DESC",
            }
        );
        let mut stmt = conn.prepare(&sql)?;
        let read = |r: &rusqlite::Row<'_>| -> rusqlite::Result<(i64, String, Option<String>, Option<String>, String, String, i64)> {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
        };
        let rows: Vec<_> = match scope {
            LogScope::Rule(id) => stmt.query_map([id.as_str()], read)?.collect(),
            LogScope::All => stmt.query_map([], read)?.collect(),
        };
        let mut out = Vec::new();
        for row in rows {
            let (id, rule_id, terminal_id, terminal_name, kind, detail, at) = row?;
            out.push(AutomationLogEntry {
                id,
                rule_id,
                terminal_id,
                terminal_name,
                kind: enum_from_db(&kind)?,
                detail,
                at,
            });
        }
        Ok(out)
    }
}
