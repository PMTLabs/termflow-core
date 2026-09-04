//! The list of terminals an automation could watch.
//!
//! Joins `state.terminals` (identity, shell, pid, `display_label`), `state.terminal_cwds` (OSC cwd)
//! and one shared `proc_snapshot`. A row whose `renderer_terminal_id` is `None` is filtered out of the
//! roster and every criterion including *All terminals*: a rule stores a `tm-` and every log line
//! carries one, so a terminal with no leaf could be neither stored nor described.
//!
//! `list_watchable_terminals` returns a row for every live terminal AND for each requested id that is
//! missing — filled from that rule's `automation_targets` snapshot, so a closed terminal still shows its
//! name and folder rather than a bare id. One function answering both makes the picker's greyed row
//! and the rule row's "1 not open right now" incapable of disagreeing. Plan §4.3.
//!
//! **`build` is the pure join; the Tauri command is only the projection into `live_rows`.** That split
//! is what lets §10.14d run on Windows: the command needs `AppState`, the join does not.

use crate::automation::labels::{label_at, LabelInputs};

/// One live terminal, projected out of `AppState` — the input to both the picker and targeting.
///
/// `terminal_id` is `Option` on purpose rather than filtered away by the projection: the exclusion of
/// leafless terminals is a RULE, and a rule the caller applies silently is a rule no test can watch
/// fail. Plan §4.3.
#[derive(Debug, Clone, PartialEq)]
pub struct RosterRow {
    /// The durable `tm-` leaf. `None` for a headless API/fleet spawn with no renderer pane.
    pub terminal_id: Option<String>,
    /// The per-run `pc-` process id.
    pub process_id: String,
    /// `Terminal.name` — `Terminal-{shell}` for every renderer-created terminal, which is why
    /// `label_at` refuses it. Never matched against by `Tab name contains`.
    pub name: String,
    pub shell: String,
    pub pid: u32,
    /// The pushed-down tab/pane title (`Terminal.display_label`). What `Tab name contains` reads.
    pub display_label: Option<String>,
    /// OSC cwd, else the snapshot's process cwd — resolved by the caller, which owns both sources.
    pub cwd: Option<String>,
    /// The deepest foreground descendant's full command line, from the shared process snapshot. `None`
    /// when no scan was taken this TTL window.
    pub command_line: Option<String>,
}

/// What `automation_targets` remembered about a terminal, for the rows that are no longer live.
#[derive(Debug, Clone, PartialEq)]
pub struct TargetSnapshot {
    pub terminal_id: String,
    pub label: Option<String>,
    pub folder: Option<String>,
}

/// One picker row.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchableTerminal {
    pub terminal_id: String,
    pub process_id: Option<String>,
    pub label: Option<String>,
    pub shell: Option<String>,
    pub pid: Option<u32>,
    pub cwd: Option<String>,
    /// `false` means "not open right now" — **dormant, never dead**. Session restore re-registers the
    /// same `tm-` under a new `pc-`, so absence is not death.
    pub alive: bool,
}

/// Live rows first, in the caller's order, then one row per requested id that is not live.
///
/// **A missing row is `alive: false` and otherwise carries the snapshot, never blanks.** The approved
/// mockup draws the dead row as `tm-e4d0a77e1 · node · ~/work/termflow-docs · not open` — id, name and
/// folder present — which is the entire reason the targets table keeps a snapshot. Only an id with no
/// snapshot anywhere comes back as a bare id.
pub fn build(
    live: &[RosterRow],
    include_ids: &[String],
    snapshots: &[TargetSnapshot],
) -> Vec<WatchableTerminal> {
    let snapshot_for = |id: &str| snapshots.iter().find(|s| s.terminal_id == id);

    let mut out: Vec<WatchableTerminal> = Vec::new();
    for row in live {
        // Leafless terminals are excluded from the roster entirely: a rule stores a `tm-`, so one
        // could be neither stored nor described.
        let Some(tm) = row.terminal_id.as_deref() else {
            continue;
        };
        let snap = snapshot_for(tm);
        out.push(WatchableTerminal {
            terminal_id: tm.to_string(),
            process_id: Some(row.process_id.clone()),
            label: label_at(&LabelInputs {
                display_label: row.display_label.as_deref(),
                name: Some(row.name.as_str()),
                shell: Some(row.shell.as_str()),
                snapshot: snap.and_then(|s| s.label.as_deref()),
            }),
            shell: Some(row.shell.clone()),
            pid: Some(row.pid),
            cwd: row.cwd.clone().or_else(|| snap.and_then(|s| s.folder.clone())),
            alive: true,
        });
    }

    for id in include_ids {
        if out.iter().any(|r| &r.terminal_id == id) {
            continue;
        }
        let snap = snapshot_for(id);
        out.push(WatchableTerminal {
            terminal_id: id.clone(),
            process_id: None,
            label: snap.and_then(|s| s.label.clone()),
            shell: None,
            pid: None,
            cwd: snap.and_then(|s| s.folder.clone()),
            alive: false,
        });
    }
    out
}

/// How long after engine start an absent pinned id may be REPORTED missing.
///
/// At t=0 the live set is empty and session restore has not run, so reporting immediately writes a
/// "1 id not open right now" line on every normal restart and then silently retracts it. The set is
/// empty at t=0, and a one-shot read of it would make that emptiness permanent — which is the whole
/// of `a-live-set-is-not-existence`. Plan §4.5.
pub const MISSING_GRACE_MS: i64 = 30_000;

/// Which of a rule's pinned ids the rule row may say are not open.
///
/// Empty until the grace has elapsed — **not** because the ids are present, but because "absent" is
/// not yet a fact about the world.
/// Is this engine old enough for an absent id to mean anything? (plan §4.5)
///
/// At t=0 the live set is empty and session restore has not run, so reporting an absent pinned id
/// immediately writes a "1 id not open" line on every normal restart and then silently retracts it.
/// One implementation with two callers — this projection and the targeting tick — because the same
/// window has to open for both, or the rule row and the activity log disagree about what is missing.
pub fn grace_elapsed(now_ms: i64, engine_start_ms: i64) -> bool {
    now_ms - engine_start_ms > MISSING_GRACE_MS
}

pub fn missing_to_report(
    rows: &[WatchableTerminal],
    pinned: &[String],
    now_ms: i64,
    engine_start_ms: i64,
) -> Vec<String> {
    if !grace_elapsed(now_ms, engine_start_ms) {
        return Vec::new();
    }
    pinned
        .iter()
        .filter(|id| !rows.iter().any(|r| &&r.terminal_id == id && r.alive))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live_row(tm: Option<&str>, pc: &str, label: Option<&str>, cwd: Option<&str>) -> RosterRow {
        RosterRow {
            terminal_id: tm.map(str::to_string),
            process_id: pc.to_string(),
            name: "Terminal-powershell".to_string(),
            shell: "powershell".to_string(),
            pid: 4242,
            display_label: label.map(str::to_string),
            cwd: cwd.map(str::to_string),
            command_line: None,
        }
    }

    fn snap(tm: &str, label: Option<&str>, folder: Option<&str>) -> TargetSnapshot {
        TargetSnapshot {
            terminal_id: tm.to_string(),
            label: label.map(str::to_string),
            folder: folder.map(str::to_string),
        }
    }

    /// §10.14d — the picker's dead row draws a NAME and a FOLDER, not a bare id. The whole reason the
    /// targets table keeps a snapshot.
    #[test]
    fn a_closed_pinned_terminal_comes_back_with_its_label_and_folder() {
        let live = [live_row(Some("tm-open"), "pc-1", Some("codex"), Some("D:/work/a"))];
        let rows = build(
            &live,
            &["tm-open".into(), "tm-closed".into()],
            &[snap("tm-closed", Some("node"), Some("~/work/termflow-docs"))],
        );
        assert_eq!(rows.len(), 2, "one live row and one dead row");

        let open = &rows[0];
        assert!(open.alive);
        assert_eq!(open.process_id.as_deref(), Some("pc-1"));
        assert_eq!(open.label.as_deref(), Some("codex"));

        let closed = &rows[1];
        assert!(!closed.alive, "a pinned id with no live terminal is not open");
        assert_eq!(closed.process_id, None);
        assert_eq!(closed.label.as_deref(), Some("node"), "the dead row draws its NAME");
        assert_eq!(
            closed.cwd.as_deref(),
            Some("~/work/termflow-docs"),
            "and its FOLDER — this is what the snapshot exists for"
        );
    }

    /// The one case that legitimately yields a bare id.
    #[test]
    fn a_missing_id_with_no_snapshot_anywhere_has_no_label_and_no_cwd() {
        let rows = build(&[], &["tm-ghost".into()], &[]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, None);
        assert_eq!(rows[0].cwd, None);
        assert!(!rows[0].alive);
    }

    /// A live terminal must not be duplicated by also being pinned.
    #[test]
    fn an_included_id_that_is_live_produces_exactly_one_row() {
        let live = [live_row(Some("tm-a"), "pc-a", Some("codex"), None)];
        let rows = build(&live, &["tm-a".into()], &[]);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].alive);
    }

    /// A leafless terminal (a headless API/fleet spawn) is not a picker row.
    #[test]
    fn a_terminal_with_no_leaf_is_excluded_from_the_roster() {
        let live = [live_row(None, "pc-headless", Some("agent"), None), live_row(Some("tm-a"), "pc-a", None, None)];
        let rows = build(&live, &[], &[]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].terminal_id, "tm-a");
    }

    /// A live row falls back to the snapshot's folder when the terminal has printed no OSC cwd yet,
    /// and prefers its own live cwd when it has.
    #[test]
    fn a_live_row_prefers_its_own_cwd_over_the_snapshot() {
        let live = [live_row(Some("tm-a"), "pc-a", Some("codex"), Some("D:/now"))];
        let rows = build(&live, &[], &[snap("tm-a", None, Some("D:/then"))]);
        assert_eq!(rows[0].cwd.as_deref(), Some("D:/now"));

        let live = [live_row(Some("tm-a"), "pc-a", Some("codex"), None)];
        let rows = build(&live, &[], &[snap("tm-a", None, Some("D:/then"))]);
        assert_eq!(rows[0].cwd.as_deref(), Some("D:/then"), "no OSC cwd yet — use what we remembered");
    }

    /// §10.13b — a restart must never write a "1 id not open" line it then retracts.
    #[test]
    fn an_absent_pinned_id_is_not_reported_missing_until_the_grace_has_elapsed() {
        let rows = build(&[], &["tm-closed".into()], &[]);
        let pinned = ["tm-closed".to_string()];

        assert!(missing_to_report(&rows, &pinned, 0, 0).is_empty(), "t=0: the live set is empty for everyone");
        assert!(
            missing_to_report(&rows, &pinned, MISSING_GRACE_MS, 0).is_empty(),
            "exactly at the grace is still inside it"
        );
        assert_eq!(
            missing_to_report(&rows, &pinned, MISSING_GRACE_MS + 1, 0),
            vec!["tm-closed".to_string()],
            "after the grace, absence is a fact worth reporting"
        );
    }

    /// The grace is measured from ENGINE START, not from the epoch — a long-running app reports a
    /// terminal closed a moment ago immediately.
    #[test]
    fn the_grace_is_measured_from_engine_start() {
        let rows = build(&[], &["tm-closed".into()], &[]);
        let pinned = ["tm-closed".to_string()];
        let start = 1_700_000_000_000i64;
        assert!(missing_to_report(&rows, &pinned, start + 1_000, start).is_empty());
        assert_eq!(missing_to_report(&rows, &pinned, start + 40_000, start).len(), 1);
    }

    /// A pinned id that IS open is never reported, however long the app has run.
    #[test]
    fn a_live_pinned_id_is_never_reported_missing() {
        let live = [live_row(Some("tm-a"), "pc-a", Some("codex"), None)];
        let rows = build(&live, &["tm-a".into()], &[]);
        assert!(missing_to_report(&rows, &["tm-a".to_string()], 10_000_000, 0).is_empty());
    }
}
