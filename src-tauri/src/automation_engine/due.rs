//! What the evaluator tick owes on this pass, and how much of it runs now (plan §2.3).
//!
//! Pure over plain data, because it is the tick's only decision. The loop around it is an adapter:
//! sleep, snapshot, call this, evaluate what it returns. A cadence rule inside the loop would need an
//! `AppState` to test and §7.10 says that gate cannot fail on Windows.

use crate::automation_store::Cadence;

/// The evaluator's base sleep.
///
/// 250 ms sits between the backend consumer's 5 ms coalescer (`lib.rs`) and the renderer tracker's
/// 400 ms evaluator (`runningActivity.ts`), and gives the shortest timer (10 s) 2.5% resolution.
pub const BASE_TICK_MS: u64 = 250;

/// The floor between two `OnOutput` evaluations of one pair, however chatty the terminal is.
pub const EVENT_MIN_INTERVAL_MS: i64 = 250;

/// The only thing between "20 rules × 20 terminals all fall due together" and a 400-evaluation tick.
pub const MAX_EVALS_PER_TICK: usize = 64;

/// How often the targeting tick re-resolves every rule's matched set (§4.5).
pub const TARGETING_TICK_MS: u64 = 2_000;

/// Is this `(rule, terminal)` pair due for evaluation on this tick?
///
/// **A pair that has never been evaluated is always due**, which is what makes a rule start working
/// the moment it is enabled rather than one interval later.
///
/// **A NEGATIVE age counts as due, and that is not a rounding decision.** `now - last` goes negative
/// when the wall clock moves backwards — an NTP correction, or a resume, both of which this app
/// already handles — and reading that as "not yet due" stalls every rule for the length of the
/// correction, silently. The safe direction is unambiguous: an extra evaluation is idempotent (the
/// arm machine, not this function, decides whether anything is sent), while a stall is invisible.
/// Same class as `ProcSnapshot`'s freshness check, which had this exact defect and was fixed in M2.
pub fn due_now(
    cadence: Cadence,
    every_ms: i64,
    dirty: bool,
    last_eval_ms: Option<i64>,
    now_ms: i64,
) -> bool {
    let elapsed = |min: i64| match last_eval_ms {
        None => true,
        Some(last) => {
            let age = now_ms - last;
            age < 0 || age >= min
        }
    };
    match cadence {
        Cadence::OnOutput => dirty && elapsed(EVENT_MIN_INTERVAL_MS),
        // A timer rule ignores `dirty` entirely — R7 is "every N, whether or not anything was
        // printed", and a quiet terminal is exactly what such a rule is usually watching for.
        Cadence::Timer => elapsed(every_ms.max(EVENT_MIN_INTERVAL_MS)),
    }
}

/// Take at most `cap` of the due pairs, starting where the last tick stopped.
///
/// Returns the indices to run and the cursor to carry into the next tick. **Round-robin, not
/// truncation**: with 400 due pairs and a cap of 64, plain `take(64)` would run the first 64 forever
/// and the 65th would never evaluate at all — a rule silently dead because of where it sorted.
///
/// The cursor is an index into *this* tick's due list, which changes shape between ticks. That is
/// fine and deliberate: the guarantee wanted here is "everyone advances", not a stable seat number,
/// and any scheme that tried for the latter would have to key on pair identity and outlive the list.
pub fn select_due(due_len: usize, cursor: usize, cap: usize) -> (Vec<usize>, usize) {
    if due_len == 0 || cap == 0 {
        // The cursor is CARRIED, not reset. Returning 0 restarts the round-robin on every idle tick,
        // and under an alternating idle/loaded pattern with more than `cap` due pairs the tail is
        // never reached at all — the rules at the end of the sorted list simply do not run.
        return (Vec::new(), cursor);
    }
    let start = cursor % due_len;
    let take = cap.min(due_len);
    let picked: Vec<usize> = (0..take).map(|i| (start + i) % due_len).collect();
    ((picked), (start + take) % due_len)
}

/// The processes whose dirty flag this tick has fully consumed.
///
/// `due_pcs[i]` is the process id of due pair `i`; `picked` are the indices this tick actually ran.
/// A `pc` may be cleared **only when every due pair on it ran**. Two rules can watch one terminal
/// (Duplicate makes that the expected case, not an edge one), so clearing after the first would make
/// the second miss that output — and permanently, if the terminal then goes quiet, because `dirty`
/// is the only thing that would have brought it back.
///
/// **There are two ways a pair can want this output and not have run**, and the first version of this
/// function covered one of them — which is what "fixed at some sites but not all" looks like inside a
/// single function. `MAX_EVALS_PER_TICK` holds a due pair over to the next tick: that is `picked`. A
/// pair can also be **held off by the 250 ms floor** while a sibling rule on the same terminal is due,
/// and that pair is not in `due_pcs` at all, so no amount of reasoning about `picked` can see it — the
/// caller passes those as `owed`. Neither is the same statement as "clear what you evaluated".
///
/// *(A terminal that is SETTLING is not a third door. Settling is keyed by the leaf and a leaf has one
/// process, so every pair on it skips together and the process never reaches `due_pcs`.)*
pub fn settled_processes(
    due_pcs: &[String],
    picked: &[usize],
    owed: &std::collections::HashSet<String>,
) -> Vec<String> {
    let ran: std::collections::HashSet<usize> = picked.iter().copied().collect();
    let unfinished: std::collections::HashSet<&str> = due_pcs
        .iter()
        .enumerate()
        .filter(|(i, _)| !ran.contains(i))
        .map(|(_, pc)| pc.as_str())
        .collect();
    let mut out: Vec<String> = due_pcs
        .iter()
        .enumerate()
        .filter(|(i, pc)| {
            ran.contains(i) && !unfinished.contains(pc.as_str()) && !owed.contains(pc.as_str())
        })
        .map(|(_, pc)| pc.clone())
        .collect();
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// §10.6's cadence table, as a table. The three rows that matter are the two cadences and the
    /// never-evaluated pair, and each is asserted in both directions.
    #[test]
    fn the_two_cadences_are_a_table() {
        // (cadence, every_ms, dirty, last_eval, now, want)
        let cases: &[(Cadence, i64, bool, Option<i64>, i64, bool)] = &[
            // Never evaluated: due immediately, so enabling a rule starts it now.
            (Cadence::OnOutput, 0, true, None, 1_000, true),
            (Cadence::Timer, 30_000, false, None, 1_000, true),
            // OnOutput needs BOTH dirty and the floor.
            (Cadence::OnOutput, 0, false, Some(0), 10_000, false),
            (Cadence::OnOutput, 0, true, Some(9_900), 10_000, false),
            (Cadence::OnOutput, 0, true, Some(9_750), 10_000, true),
            // A timer rule does not care about dirty at all — R7.
            (Cadence::Timer, 30_000, false, Some(0), 29_999, false),
            (Cadence::Timer, 30_000, false, Some(0), 30_000, true),
            (Cadence::Timer, 30_000, true, Some(0), 29_999, false),
            // A timer shorter than the floor cannot outrun the evaluator's own tick.
            (Cadence::Timer, 1, false, Some(0), 249, false),
            (Cadence::Timer, 1, false, Some(0), 250, true),
        ];
        for (cadence, every, dirty, last, now, want) in cases {
            assert_eq!(
                due_now(*cadence, *every, *dirty, *last, *now),
                *want,
                "{:?} every={} dirty={} last={:?} now={}",
                cadence,
                every,
                dirty,
                last,
                now
            );
        }
    }

    /// A 100 Hz chatty terminal must not produce 100 evaluations a second.
    #[test]
    fn a_dirty_terminal_evaluates_at_most_four_times_a_second() {
        let mut last: Option<i64> = None;
        let mut evaluations = 0;
        // One second of 10 ms ticks, dirty on every one of them.
        for t in (0..1_000).step_by(10) {
            if due_now(Cadence::OnOutput, 0, true, last, t as i64) {
                evaluations += 1;
                last = Some(t as i64);
            }
        }
        assert_eq!(evaluations, 4, "250 ms floor means four per second, not a hundred");
    }

    /// The `ProcSnapshot` lesson, one module over: a clock that moves backwards must not stall the
    /// engine. A stall here is silent — no log line, no state change, the rule simply stops.
    #[test]
    fn a_backwards_clock_leaves_a_pair_due_rather_than_stalling_it() {
        // The stamp is 10 minutes in the "future" after a correction.
        assert!(
            due_now(Cadence::Timer, 30_000, false, Some(600_000), 1_000),
            "a negative age must read as due, never as freshly evaluated"
        );
        assert!(due_now(Cadence::OnOutput, 0, true, Some(600_000), 1_000));
        // And the premise, so this cannot pass because the arithmetic saturated somewhere.
        assert!(1_000i64 - 600_000i64 < 0);
    }

    /// The cap, and the property plain truncation does not have: everyone gets a turn.
    #[test]
    fn the_cap_round_robins_rather_than_starving_the_tail() {
        let mut cursor = 0;
        let mut seen = std::collections::HashSet::new();
        // 400 due pairs, 64 per tick: every one of them must run within the first seven ticks.
        for _ in 0..7 {
            let (picked, next) = select_due(400, cursor, MAX_EVALS_PER_TICK);
            assert_eq!(picked.len(), MAX_EVALS_PER_TICK);
            seen.extend(picked);
            cursor = next;
        }
        assert_eq!(seen.len(), 400, "a `take(64)` implementation reaches only 64 of them, forever");
    }

    /// Spending one terminal's dirty flag must not silence a second rule watching it.
    ///
    /// *Clear the flag while a rule still wants that output and the rule never sees it at all — no
    /// log line, no state change, nothing on screen — and permanently, if the terminal then goes
    /// quiet, which is the normal end of a build.*
    ///
    /// **A table over both reasons a pair can want the output and not have run**, because the first
    /// version of this function covered only the cap. `owed` is the other one, and it carries two
    /// cases the cap cannot express — a pair the 250 ms floor held off, and a pair skipped because
    /// its terminal is settling — neither of which appears in `due_pcs` at all.
    #[test]
    fn a_terminal_is_only_settled_once_every_rule_watching_it_has_run() {
        let pcs = vec!["pc-a".to_string(), "pc-a".to_string(), "pc-b".to_string()];
        let none = HashSet::new();

        // Both of pc-a's pairs ran, and so did pc-b's.
        assert_eq!(settled_processes(&pcs, &[0, 1, 2], &none), vec!["pc-a", "pc-b"]);

        // Only the FIRST of pc-a's two pairs ran: pc-a keeps its flag, pc-b does not.
        assert_eq!(
            settled_processes(&pcs, &[0, 2], &none),
            vec!["pc-b"],
            "clearing pc-a here is how the second rule watching it goes silent"
        );

        // Nothing ran at all.
        assert!(settled_processes(&pcs, &[], &none).is_empty());
        // And a terminal is named once however many of its pairs ran.
        assert_eq!(settled_processes(&pcs, &[0, 1], &none), vec!["pc-a"]);

        // Every pair that IS due ran, and pc-a is still owed — by a pair that never reached the due
        // list. Nothing about `picked` can see that, which is the whole reason for the argument.
        let owed: HashSet<String> = ["pc-a".to_string()].into_iter().collect();
        assert_eq!(
            settled_processes(&pcs, &[0, 1, 2], &owed),
            vec!["pc-b"],
            "a pair held off by the floor, or skipped for settling, still wants this output"
        );
        // And being owed is not contagious: pc-b is cleared in exactly the same call.
        assert_eq!(
            settled_processes(&pcs, &[2], &owed),
            vec!["pc-b"],
            "only the terminal that is owed keeps its flag"
        );
    }

    /// The ordinary case is not a rotation at all, and the edges do not panic.
    #[test]
    fn a_tick_under_the_cap_runs_everything_and_the_edges_are_total() {
        let (picked, next) = select_due(5, 0, MAX_EVALS_PER_TICK);
        assert_eq!(picked, vec![0, 1, 2, 3, 4]);
        assert_eq!(next, 0, "wrapping a fully-consumed list leaves the cursor at the start");

        // The cursor SURVIVES an idle tick. Returning 0 here starved the tail of any list longer
        // than the cap under an alternating idle/loaded pattern: every idle tick sent the next loaded
        // one back to index 0, so the pairs past `cap` were never reached at all.
        assert_eq!(select_due(0, 7, MAX_EVALS_PER_TICK), (Vec::new(), 7));
        assert_eq!(select_due(3, 0, 0), (Vec::new(), 0));
        // A cursor left over from a longer list must not index out of a shorter one.
        let (picked, _) = select_due(3, 400, MAX_EVALS_PER_TICK);
        assert_eq!(picked, vec![1, 2, 0]);
    }
}
