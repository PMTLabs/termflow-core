//! Resolving an automation's criterion to a set of `tm-` leaves.
//!
//! Five criteria (plan §4.4). Two of them are where the bugs live:
//!
//! - `Command contains` reads the COMMAND LINE of every process on the terminal's foreground chain,
//!   never the process name, because an npm-installed agent is `node.exe` — which is why
//!   `detect_agent` reads the cmdline to disambiguate. It reads the WHOLE chain rather than its
//!   deepest link because agents spawn helpers: `pwsh -> claude.exe -> bun.exe -> conhost.exe` is a
//!   measurement off a real machine, and the deepest link there is `conhost.exe`.
//! - `Working folder is under` must NOT be a string `starts_with`. Both sides normalise through
//!   `open_commands::to_native_path` (tilde expansion, the Git-Bash/WSL `/d/...` -> `D:\...` remap,
//!   separator normalisation) because the three cwd sources genuinely disagree, and then compare
//!   COMPONENT-WISE, case-insensitive on Windows. A prefix match makes `~/work/termflow` match
//!   `~/work/termflow-site` — two rows that sit side by side in the approved mockup.

use std::collections::BTreeSet;

use crate::automation::roster::RosterRow;
use crate::automation_store::{AutomationRule, Criterion, TargetMode};
use crate::open_commands::to_native_path;

/// Split a normalised path into components, dropping a trailing separator but **keeping the leading
/// run**: `/a/b` and `a/b` are different paths and must not compare equal, and `\\\\server\\share` is a
/// third thing again — so the leading run is kept up to two, which is exactly what distinguishes a
/// UNC root from an absolute one.
///
/// An empty component ANYWHERE ELSE is a repeated separator and carries no path information:
/// `/work//termflow` is `/work/termflow`. The three cwd sources this compares genuinely disagree
/// about separators, so a doubled one is a spelling difference and must not become a component that
/// no real path can ever match.
fn components(path: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = Vec::new();
    let mut at_start = true;
    for p in path.split(['/', '\\']) {
        if !p.is_empty() {
            at_start = false;
            parts.push(p);
        } else if at_start && parts.len() < 2 {
            parts.push(p);
        }
    }
    while parts.len() > 1 && parts.last().is_some_and(|p| p.is_empty()) {
        parts.pop();
    }
    parts
}

fn same_component(a: &str, b: &str) -> bool {
    if cfg!(target_os = "windows") {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Is `child` the same folder as `ancestor`, or inside it?
///
/// **Component-wise, never `starts_with`.** A string prefix makes `~/work/termflow-site` sit under
/// `~/work/termflow`, and those are two different projects that sit side by side in the mockup.
///
/// **Neither side may be empty, and that is one guard with two halves.** An empty `ancestor` is an
/// ancestor of nothing rather than of everything: a criterion with no value must match no terminals,
/// because the failure mode here is typing into the wrong one. An empty `child` is under nothing for
/// the mirror reason — a terminal whose cwd has not been resolved yet carries an empty string, and
/// `components("")` is `[""]`, which is precisely the single component that `/` normalises to. Guard
/// one side only and every unresolved terminal sits under a `Working folder is under /` rule.
pub fn path_is_under(child: &str, ancestor: &str) -> bool {
    if child.trim().is_empty() || ancestor.trim().is_empty() {
        return false;
    }
    let child_native = to_native_path(child.trim());
    let ancestor_native = to_native_path(ancestor.trim());
    let c = components(&child_native);
    let a = components(&ancestor_native);
    if a.is_empty() || c.len() < a.len() {
        return false;
    }
    a.iter().zip(c.iter()).all(|(x, y)| same_component(x, y))
}

fn contains_ci(haystack: Option<&str>, needle: &str) -> bool {
    haystack
        .map(|h| h.to_lowercase().contains(&needle.to_lowercase()))
        .unwrap_or(false)
}

/// The `tm-` leaves one criterion selects out of the roster.
///
/// Every branch skips a row with no leaf, **including `All terminals`**: a rule stores a `tm-` and
/// every log line carries one, so a terminal with no leaf could be neither stored nor described.
///
/// A value-taking criterion with an empty value selects **nothing**. Validation blocks saving one, and
/// if one reaches here the safe direction is unambiguous: this feature types into terminals.
pub fn resolve(criterion: Criterion, value: &str, rows: &[RosterRow]) -> BTreeSet<String> {
    let needle = value.trim();
    if needle.is_empty() && criterion != Criterion::AllTerminals {
        return BTreeSet::new();
    }
    rows.iter()
        .filter_map(|row| {
            let tm = row.terminal_id.as_deref()?;
            let hit = match criterion {
                Criterion::AllTerminals => true,
                Criterion::TerminalIdIs => tm == needle,
                // `display_label`, NEVER `name` — `name` is `Terminal-{shell}` for every
                // renderer-created terminal, so matching it would match the shell, not the tab.
                Criterion::TabNameContains => contains_ci(row.display_label.as_deref(), needle),
                // ANY level of the foreground chain, never just its last link — see
                // `RosterRow::command_lines`. The program a rule names normally sits in the
                // middle of the chain, with its own helpers below it.
                Criterion::CommandContains => {
                    row.command_lines.iter().any(|line| contains_ci(Some(line), needle))
                }
                Criterion::WorkingFolderUnder => row
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| path_is_under(cwd, needle)),
            };
            hit.then(|| tm.to_string())
        })
        .collect()
}

/// What changed between two ticks of the watched set.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SetDelta {
    pub joined: Vec<String>,
    pub departed: Vec<String>,
}

impl SetDelta {
    pub fn is_empty(&self) -> bool {
        self.joined.is_empty() && self.departed.is_empty()
    }
}

/// The set diff the targeting tick emits.
///
/// A departure is reported **once** — on the tick it leaves — which is what makes "exactly one final
/// persist when the id leaves the matched set" true rather than one persist per tick forever.
pub fn set_delta(previous: &BTreeSet<String>, next: &BTreeSet<String>) -> SetDelta {
    SetDelta {
        joined: next.difference(previous).cloned().collect(),
        departed: previous.difference(next).cloned().collect(),
    }
}

/// The leaves one rule watches on this tick.
///
/// - **Pinned**: exactly the ids the user ticked, live or not. An absent id is dormant, never dropped —
///   session restore re-registers the same `tm-` under a new `pc-`, so absence is not death.
/// - **Rule + `follow_new`**: whatever matches right now.
/// - **Rule without `follow_new`**: the set is **frozen** at whatever it first resolved to. A terminal
///   the user deliberately excluded cannot join later, and — the half a re-resolve would break — one
///   that closes and comes back is not silently dropped in between.
///
/// **An EMPTY previous set is not a resolution to freeze on**, and that is not a special case: an
/// empty frozen set is the absence of a set, not a set, and freezing it makes `follow_new: false`
/// mean "never watch anything, ever". The first targeting tick can easily land before session restore
/// has registered a single terminal — the same t=0 emptiness §4.5's missing-target grace exists for —
/// and "a previous set exists" cannot tell that apart from "this rule genuinely matches nothing".
/// `a-live-set-is-not-existence`.
pub fn watched_set(
    rule: &AutomationRule,
    rows: &[RosterRow],
    previous: Option<&BTreeSet<String>>,
) -> BTreeSet<String> {
    let mut watched = match rule.target_mode {
        TargetMode::Pinned => rule.target_ids.iter().cloned().collect(),
        TargetMode::Rule => match (rule.follow_new, previous) {
            (false, Some(frozen)) if !frozen.is_empty() => frozen.clone(),
            _ => resolve(rule.criterion, &rule.criterion_value, rows),
        },
    };
    if rule.target_mode == TargetMode::Rule {
        let mut excluded: BTreeSet<String> = rule.excluded_ids.iter().cloned().collect();
        if let Some(criterion) = rule.exclude_criterion {
            excluded.extend(resolve(criterion, &rule.exclude_criterion_value, rows));
        }
        watched.retain(|terminal_id| !excluded.contains(terminal_id));
    }
    watched
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation_store::{
        ActionStep, AutomationGraph, Cadence, CompareOp, CondStep, Finds, Keep, MonitorStep,
        ParsePreset, ParseStep, ReadMode, SendTo,
    };

    /// One row whose foreground chain is exactly the levels given, shell first.
    fn row_chain(tm: Option<&str>, cmd: &[&str]) -> RosterRow {
        RosterRow {
            terminal_id: tm.map(str::to_string),
            process_id: format!("pc-{}", tm.unwrap_or("none")),
            name: "Terminal-powershell".to_string(),
            shell: "powershell".to_string(),
            pid: 100,
            display_label: None,
            cwd: None,
            command_lines: cmd.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn row(tm: Option<&str>, label: Option<&str>, cwd: Option<&str>, cmd: Option<&str>) -> RosterRow {
        RosterRow {
            terminal_id: tm.map(str::to_string),
            process_id: format!("pc-{}", tm.unwrap_or("none")),
            name: "Terminal-powershell".to_string(),
            shell: "powershell".to_string(),
            pid: 100,
            display_label: label.map(str::to_string),
            cwd: cwd.map(str::to_string),
            command_lines: cmd.into_iter().map(str::to_string).collect(),
        }
    }

    fn ids(set: BTreeSet<String>) -> Vec<String> {
        set.into_iter().collect()
    }

    // -----------------------------------------------------------------------------------------
    // §10.10 — path_is_under, asserted as a LIST
    // -----------------------------------------------------------------------------------------

    /// The hit/miss set as a list, not one sample: a guard validated at one sample is width-dependent,
    /// and this one has a specific neighbour it must reject.
    #[test]
    fn path_is_under_is_a_list_of_hits_and_misses() {
        let cases: &[(&str, &str, bool)] = &[
            // The same folder is under itself.
            ("~/work/termflow", "~/work/termflow", true),
            // Genuinely inside.
            ("~/work/termflow/src", "~/work/termflow", true),
            ("~/work/termflow/src/deep/deeper", "~/work/termflow", true),
            // THE case a string prefix gets wrong — two rows side by side in the mockup.
            ("~/work/termflow-site", "~/work/termflow", false),
            ("~/work/termflow-docs", "~/work/termflow", false),
            ("~/work/termflowsite", "~/work/termflow", false),
            // A parent is not under its child.
            ("~/work", "~/work/termflow", false),
            // A sibling is not under it.
            ("~/other/termflow", "~/work/termflow", false),
            // A trailing separator changes nothing.
            ("~/work/termflow/", "~/work/termflow", true),
            ("~/work/termflow", "~/work/termflow/", true),
            // An empty ancestor is an ancestor of nothing. The tilde cases below cannot prove that on
            // their own: `to_native_path` expands `~` to a drive-rooted path on Windows, whose first
            // component is `C:` and never the empty string, so the component compare rejects them
            // anyway and the guard goes untested. An ABSOLUTE path is the case that needs it — its
            // first component IS the empty string, which matches an empty ancestor's only component.
            ("~/work/termflow", "", false),
            ("~/work/termflow", "   ", false),
            // A path whose FIRST component is the empty string, which is what an empty ancestor's
            // only component is — the case the guard exists for. Two letters, so Windows' msys remap
            // leaves it alone (`/a/b` would become `A:` and never reach this shape).
            ("/ab/c", "", false),
            ("/ab/c", "   ", false),
            // ...and the OTHER half of that guard, which shipped missing. An unresolved cwd is under
            // nothing, not under root: `components("")` is `[""]`, the very component `/` normalises
            // to, so without the child half every terminal with no cwd yet matches a `/` rule.
            ("", "/", false),
            ("   ", "/", false),
            ("", "/ab", false),
            ("", "", false),
            // A repeated separator is a spelling difference, not a component: the three cwd sources
            // disagree about separators, and an empty inner component matches no real path segment.
            ("/work//termflow/src", "/work/termflow", true),
            ("~/work//termflow", "~/work/termflow", true),
            // But a UNC root is not an absolute path with a stutter — the leading run is kept.
            ("//server/share/x", "/server/share", false),
        ];
        for (child, ancestor, want) in cases {
            assert_eq!(
                path_is_under(child, ancestor),
                *want,
                "{:?} under {:?}",
                child,
                ancestor
            );
        }
    }

    /// The three cwd sources genuinely disagree about separators and drive spelling, which is the
    /// whole reason both sides go through `to_native_path`.
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_equates_the_msys_and_native_spellings_and_ignores_case() {
        assert!(path_is_under("/d/sources/work", "D:\\sources"), "/d/... must equate to D:\\...");
        assert!(path_is_under("D:\\sources\\work", "/d/sources"));
        assert!(path_is_under("D:/sources/work", "d:\\SOURCES"), "case-insensitive on Windows");
        assert!(!path_is_under("D:\\sources\\work-site", "D:\\sources\\work"));
    }

    /// On every other OS a `/d/...` path is a genuine POSIX path and case matters.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn posix_keeps_case_and_leaves_slash_d_alone() {
        assert!(!path_is_under("/home/u/Work", "/home/u/work"), "case-sensitive off Windows");
        assert!(path_is_under("/d/sources/work", "/d/sources"));
        assert!(!path_is_under("/d/sources", "D:\\sources"));
    }

    /// An absolute path and a relative one that spell the same components are different paths.
    ///
    /// **Two-letter segments, for the reason the list above already names**: on Windows a
    /// single-letter first segment is read as a drive, so `/a/b` becomes `A:\\b` and neither
    /// assertion would touch a leading empty component at all — the property this test is named for
    /// would be untested on the platform it is developed on, and only red in CI. The list test three
    /// functions above carries that fix; this one was the site of the class still missing it.
    #[test]
    fn a_leading_separator_is_part_of_the_path() {
        assert!(!path_is_under("ab/c", "/ab"));
        assert!(path_is_under("/ab/c", "/ab"));
    }

    // -----------------------------------------------------------------------------------------
    // §10.11 — the five criteria
    // -----------------------------------------------------------------------------------------

    fn roster() -> Vec<RosterRow> {
        vec![
            row(Some("tm-a"), Some("codex · core"), Some("~/work/termflow"), Some("node C:/n/claude.js --x")),
            row(Some("tm-b"), Some("build"), Some("~/work/termflow-site"), Some("npm run dev")),
            row(Some("tm-c"), None, None, None),
            // Leafless: excluded from EVERY criterion, including All.
            row(None, Some("codex · headless"), Some("~/work/termflow"), Some("node claude.js")),
        ]
    }

    #[test]
    fn each_of_the_five_criteria_resolves() {
        let rows = roster();
        assert_eq!(
            ids(resolve(Criterion::AllTerminals, "", &rows)),
            vec!["tm-a", "tm-b", "tm-c"]
        );
        assert_eq!(ids(resolve(Criterion::TerminalIdIs, "tm-b", &rows)), vec!["tm-b"]);
        assert_eq!(ids(resolve(Criterion::TabNameContains, "codex", &rows)), vec!["tm-a"]);
        assert_eq!(ids(resolve(Criterion::CommandContains, "claude", &rows)), vec!["tm-a"]);
        assert_eq!(
            ids(resolve(Criterion::WorkingFolderUnder, "~/work/termflow", &rows)),
            vec!["tm-a"],
            "termflow-site is a different project"
        );
    }

    /// `Tab name contains` reads `display_label` and NEVER `name`. Every fixture row carries
    /// `Terminal-powershell` as its name, so a resolver reading the wrong field matches everything.
    #[test]
    fn tab_name_contains_reads_display_label_and_not_name() {
        let rows = roster();
        assert!(
            ids(resolve(Criterion::TabNameContains, "powershell", &rows)).is_empty(),
            "matching `name` would select every terminal"
        );
        assert_eq!(ids(resolve(Criterion::TabNameContains, "build", &rows)), vec!["tm-b"]);
    }

    /// `Command contains` reads the COMMAND LINE, not the process name: an npm-installed agent is
    /// `node.exe`, so matching the name selects every node process at once.
    #[test]
    fn command_contains_reads_the_command_line() {
        let rows = roster();
        assert_eq!(ids(resolve(Criterion::CommandContains, "run dev", &rows)), vec!["tm-b"]);
        // Case-insensitive, and matching a substring of the ARGUMENTS, not just the exe.
        assert_eq!(ids(resolve(Criterion::CommandContains, "NODE", &rows)), vec!["tm-a"]);
        assert_eq!(ids(resolve(Criterion::CommandContains, "CLAUDE.JS", &rows)), vec!["tm-a"]);
        assert_eq!(ids(resolve(Criterion::CommandContains, "NPM", &rows)), vec!["tm-b"]);
        // No snapshot taken this window: no command line, no match — never "matches everything".
        let no_scan = [row(Some("tm-x"), Some("x"), None, None)];
        assert!(ids(resolve(Criterion::CommandContains, "node", &no_scan)).is_empty());
    }

    /// **The measured defect: the program a rule names is on the chain, but not at its end.**
    ///
    /// Read off a real machine — a terminal running the Claude CLI is
    /// `pwsh -> claude.exe -> bun.exe -> conhost.exe`. A matcher that reads only the deepest
    /// descendant tests `conhost.exe`'s command line, so `Command contains "claude"` selected
    /// nothing, on every tick, forever. The whole chain is the haystack, and the assertion is a
    /// LIST over the levels because "the agent is somewhere on it" is the property — one sample
    /// cannot state that, and the level that used to be read is the one that does NOT match.
    #[test]
    fn command_contains_matches_any_level_of_the_chain_not_only_the_deepest() {
        let rows = [row_chain(
            Some("tm-agent"),
            &[
                r"C:\Program Files\PowerShell\7\pwsh.exe -NoLogo",
                r"C:\Users\t\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe --resume",
                r"bun.exe x tsc --noEmit",
                r"\??\C:\WINDOWS\system32\conhost.exe 0x4",
            ],
        )];
        for (needle, want, why) in [
            ("pwsh", true, "the shell itself is the first link"),
            ("claude", true, "THE case: the agent sits in the middle of the chain"),
            ("bun", true, "a helper the agent spawned"),
            ("conhost", true, "the deepest link, the only one the old matcher could see"),
            ("codex", false, "a needle on no level still matches nothing"),
        ] {
            assert_eq!(
                !ids(resolve(Criterion::CommandContains, needle, &rows)).is_empty(),
                want,
                "{:?}: {}",
                needle,
                why
            );
        }
    }

    /// An empty chain is "no scan taken", which must read as no match and never as matches-all.
    #[test]
    fn an_empty_chain_matches_nothing() {
        let rows = [row_chain(Some("tm-x"), &[])];
        assert!(ids(resolve(Criterion::CommandContains, "claude", &rows)).is_empty());
        assert!(ids(resolve(Criterion::CommandContains, "x", &rows)).is_empty());
    }

    #[test]
    fn a_leafless_row_is_excluded_from_every_criterion_including_all() {
        let rows = roster();
        for (criterion, value) in [
            (Criterion::AllTerminals, ""),
            (Criterion::TabNameContains, "codex"),
            (Criterion::CommandContains, "claude"),
            (Criterion::WorkingFolderUnder, "~/work/termflow"),
        ] {
            let got = ids(resolve(criterion, value, &rows));
            assert!(
                !got.iter().any(|id| id.starts_with("pc-")),
                "{:?} leaked a leafless row: {:?}",
                criterion,
                got
            );
            assert_eq!(got.len(), if criterion == Criterion::AllTerminals { 3 } else { 1 });
        }
    }

    /// An empty value must select nothing, not everything. `contains("")` is true of every string and
    /// an empty ancestor is a prefix of every path — both would make an unfinished rule type into
    /// every open terminal.
    #[test]
    fn an_empty_criterion_value_selects_nothing() {
        let rows = roster();
        for criterion in [
            Criterion::TabNameContains,
            Criterion::CommandContains,
            Criterion::WorkingFolderUnder,
            Criterion::TerminalIdIs,
        ] {
            assert!(
                ids(resolve(criterion, "  ", &rows)).is_empty(),
                "{:?} with an empty value must select nothing",
                criterion
            );
        }
        assert_eq!(ids(resolve(Criterion::AllTerminals, "", &rows)).len(), 3, "All takes no value");
    }

    // -----------------------------------------------------------------------------------------
    // §10.11b — follow_new
    // -----------------------------------------------------------------------------------------

    fn rule(mode: TargetMode, criterion: Criterion, value: &str, follow_new: bool) -> AutomationRule {
        AutomationRule {
            id: "au-1".into(),
            name: "r".into(),
            enabled: true,
            runs_once: false,
            target_mode: mode,
            criterion,
            criterion_value: value.into(),
            follow_new,
            target_ids: vec!["tm-pinned".into()],
            excluded_ids: vec![],
            exclude_criterion: None,
            exclude_criterion_value: String::new(),
            completed_at: None,
            verbose_until: None,
            sort_order: 0,
            schema_version: 1,
            graph: AutomationGraph {
                layout: None,
                timer: None,
                monitor: Some(MonitorStep { read: ReadMode::NewOutput, cadence: Cadence::OnOutput, every_ms: 0 }),
                parse: Some(ParseStep {
                    preset: ParsePreset::Custom,
                    literal: None,
                    find: r"ctx:(\d+)%".into(),
                    keep: Keep::Brackets,
                }),
                cond: Some(CondStep { finds: Finds::Reading, op: Some(CompareOp::Gt), threshold: Some(25.0), ..Default::default() }),
                action: ActionStep {
                    message: "m".into(),
                    send_to: SendTo::Matched,
                    submit: true,
                    cli_type: "default".into(),
                    substitute: false,
                },
            },
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn follow_new_false_freezes_the_set_and_true_adopts_the_newcomer() {
        let before = [row(Some("tm-a"), Some("codex"), None, None)];
        let after = [
            row(Some("tm-a"), Some("codex"), None, None),
            row(Some("tm-new"), Some("codex"), None, None),
        ];

        let frozen = rule(TargetMode::Rule, Criterion::TabNameContains, "codex", false);
        let first = watched_set(&frozen, &before, None);
        assert_eq!(ids(first.clone()), vec!["tm-a"]);
        assert_eq!(
            ids(watched_set(&frozen, &after, Some(&first))),
            vec!["tm-a"],
            "a newly-opened matching terminal must NOT join a frozen rule"
        );

        let following = rule(TargetMode::Rule, Criterion::TabNameContains, "codex", true);
        assert_eq!(
            ids(watched_set(&following, &after, Some(&first))),
            vec!["tm-a", "tm-new"],
            "the same rule with follow_new adopts it on the next tick"
        );
    }

    /// A frozen rule resolves until it has something to freeze.
    ///
    /// **The fixture has to vary the ROSTER as well as `previous`.** Freezing is a function of both,
    /// and the version of this test that shipped only ever resolved against a populated roster — so
    /// it asserted the first tick resolves and could not see that a first tick resolving to NOTHING
    /// froze the rule dead for the session. A fixture that varies one dimension cannot test a
    /// decision that reads two.
    #[test]
    fn a_frozen_rule_resolves_until_it_has_something_to_freeze() {
        let none: [RosterRow; 0] = [];
        let rows = [row(Some("tm-a"), Some("codex"), None, None)];
        let frozen = rule(TargetMode::Rule, Criterion::TabNameContains, "codex", false);

        // Tick 1, before session restore has registered anything: nothing matches yet.
        let first = watched_set(&frozen, &none, None);
        assert!(first.is_empty());

        // Tick 2, the terminals are up. An empty tick 1 is not a resolution, so this must resolve.
        let second = watched_set(&frozen, &rows, Some(&first));
        assert_eq!(
            ids(second.clone()),
            vec!["tm-a"],
            "an empty first tick must not freeze the rule at nothing for the session"
        );

        // Tick 3: NOW it is frozen for real, and a newcomer does not join.
        let more = [
            row(Some("tm-a"), Some("codex"), None, None),
            row(Some("tm-new"), Some("codex"), None, None),
        ];
        assert_eq!(ids(watched_set(&frozen, &more, Some(&second))), vec!["tm-a"]);

        // And a terminal that closes is still not dropped — the half a re-resolve would break.
        assert_eq!(ids(watched_set(&frozen, &none, Some(&second))), vec!["tm-a"]);

        // The original property, unchanged: a first tick with a live roster resolves.
        assert_eq!(ids(watched_set(&frozen, &rows, None)), vec!["tm-a"]);
    }

    /// Pinned ids are the user's list, live or not — dormant, never dropped.
    #[test]
    fn a_pinned_rule_watches_its_ids_even_when_none_are_live() {
        let pinned = rule(TargetMode::Pinned, Criterion::AllTerminals, "", true);
        assert_eq!(ids(watched_set(&pinned, &[], None)), vec!["tm-pinned"]);
    }

    #[test]
    fn a_pinned_rule_ignores_exclusions_entirely() {
        let rows = vec![row(Some("tm-a"), None, None, Some("claude"))];
        let mut r = rule(TargetMode::Pinned, Criterion::CommandContains, "claude", true);
        r.target_ids = vec!["tm-a".into()];
        r.excluded_ids = vec!["tm-a".into()];
        assert_eq!(
            ids(watched_set(&r, &rows, None)),
            vec!["tm-a"],
            "a hand-picked set says what it means; exclusions do not apply"
        );
    }

    #[test]
    fn an_exclusion_pattern_removes_everything_it_matches() {
        let rows = vec![
            row(Some("tm-scratch"), None, Some("~/scratch/project"), None),
            row(Some("tm-work"), None, Some("~/work/termflow"), None),
        ];
        let mut r = rule(TargetMode::Rule, Criterion::AllTerminals, "", true);
        r.exclude_criterion = Some(Criterion::WorkingFolderUnder);
        r.exclude_criterion_value = "~/scratch".into();

        assert_eq!(ids(watched_set(&r, &rows, None)), vec!["tm-work"]);
    }

    #[test]
    fn the_two_exclusion_kinds_union_rather_than_override() {
        let rows = vec![
            row(Some("tm-id"), None, Some("~/work/termflow"), None),
            row(Some("tm-pattern"), None, Some("~/scratch/project"), None),
            row(Some("tm-kept"), None, Some("~/work/other"), None),
        ];
        let mut r = rule(TargetMode::Rule, Criterion::AllTerminals, "", true);
        r.excluded_ids = vec!["tm-id".into()];
        r.exclude_criterion = Some(Criterion::WorkingFolderUnder);
        r.exclude_criterion_value = "~/scratch".into();

        assert_eq!(ids(watched_set(&r, &rows, None)), vec!["tm-kept"]);
    }

    // -----------------------------------------------------------------------------------------
    // §10.12b — the departure is reported once
    // -----------------------------------------------------------------------------------------

    #[test]
    fn a_departure_is_reported_on_the_tick_it_leaves_and_not_again() {
        let before: BTreeSet<String> = ["tm-a".to_string(), "tm-b".to_string()].into();
        let after: BTreeSet<String> = ["tm-b".to_string(), "tm-c".to_string()].into();

        let d = set_delta(&before, &after);
        assert_eq!(d.departed, vec!["tm-a".to_string()]);
        assert_eq!(d.joined, vec!["tm-c".to_string()]);

        let again = set_delta(&after, &after);
        assert!(again.is_empty(), "a stable set produces no further persists");
    }
}
