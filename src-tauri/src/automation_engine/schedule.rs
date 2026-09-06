//! The wall-clock predicate behind a schedule rule — plan 032 §6.3.
//!
//! **A rule kind with nothing to read.** Every other rule in this engine is a `(rule, terminal)` pair
//! that reads terminal text; a `TimerMode::DailyAt` rule reads a clock. So it needs a question
//! `due_now` cannot express: that signature is `(cadence, every_ms, dirty, last_eval_ms, now_ms)` and
//! has no room for a deadline or for "already fired today". A new function, not a new match arm —
//! and a new module, because `due.rs` answers *poll cadence*, which is a different question with the
//! same word in its name.
//!
//! **Pure, and split from its clock on purpose.** [`schedule_due`] takes a [`LocalTime`] and decides;
//! [`local_now`] does the one impure thing (ask the OS what "local" means) and is the only place that
//! does it, so the tick and `reload`'s seeding cannot disagree about which day it is.
//!
//! **Local wall-clock, and this is the first local time in the crate.** Every other clock here is
//! `Utc::now()`. "09:00" means nine in the morning where the user is, and it has to keep meaning
//! that across a DST change, which is exactly what `with_timezone(&Local)` does and what an offset
//! added by hand does not.

use chrono::{DateTime, Datelike, Local, NaiveDate, Timelike, Utc};

use crate::automation_store::{TimerMode, MINUTES_PER_DAY, WEEKDAY_BITS_MASK};

/// A local wall-clock instant, reduced to the only two things a schedule cares about.
///
/// `day_ordinal` is `NaiveDate::num_days_from_ce()` — days since 0001-01-01, which is a Monday, so it
/// carries both "which day" (the double-fire guard's key) and "which weekday" (the mask's key) in one
/// `i32`. `minute_of_day` is `hour * 60 + minute`, in `0..MINUTES_PER_DAY`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    pub day_ordinal: i32,
    pub minute_of_day: i32,
}

/// The tick's `now_ms` as a local wall-clock time.
///
/// **The one impure line in this module, and the only local-time conversion in the crate.** Both
/// callers — the evaluator tick and `AutomationEngine::reload`'s seeding — go through here, so
/// "which day is it" is answered once. `with_timezone(&Local)` is what makes a DST change behave:
/// chrono asks the platform's own zone rules for the offset *at that instant*, so 09:00 stays nine in
/// the morning either side of a transition, which an offset captured once and added by hand does not.
pub fn local_now(now_ms: i64) -> LocalTime {
    // `None` needs a `now_ms` some 8×10^15 ms outside the representable range, which
    // `Utc::now().timestamp_millis()` cannot produce. The epoch is the arbitrary-but-total answer:
    // returning an `Option` here would put a branch in every caller for an instant that cannot
    // arrive, and the alternative fallback — reading the clock again — hides a second clock in the
    // one function that exists to have exactly one.
    let local = DateTime::from_timestamp_millis(now_ms)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .with_timezone(&Local);
    LocalTime {
        day_ordinal: local.date_naive().num_days_from_ce(),
        minute_of_day: local.hour() as i32 * 60 + local.minute() as i32,
    }
}

/// Does this schedule fire *now*?
///
/// **`>=`, not `==`, and that is the whole of the DST story.** A 250 ms tick can miss an
/// exact-equality instant under load or behind a `spawn_blocking`, and spring-forward deletes an hour
/// outright — a 02:30 timer on a day with no 02:30 would be equal to `now` never, and go silently
/// dead once a year. With `>=` it fires at 03:00: late, once. `due.rs` chose this same direction for
/// a negative age — *"an extra evaluation is idempotent … while a stall is invisible"*.
///
/// **`last_fired_day` is what makes `>=` safe**, and it carries two jobs. Within a day it is the
/// double-fire guard, which is also the answer to fall-back: 01:30 happens twice and the second pass
/// is a no-op. Across a launch it is the *missed schedule* guard — `reload` seeds it to today for any
/// schedule whose minute has already passed, so an app started at 14:00 does not deliver a 09:00
/// prompt on arrival (the "nagging on arrival" behaviour plan 028 Q3 ruled against for arm state).
/// Without that seeding, `>=` and an absent `last_fired_day` are exactly the launch case.
///
/// **Refuses what validation refuses**, on both fields: a `days` byte that names no weekday and a
/// `minute_of_day` outside the day are `timer.noDays` and `timer.badMinute`, and a row that reached
/// the store some other way must not be *runnable but never firing* on one side and *unfireable* on
/// the other. `an_unfireable_rule_is_unfireable_on_both_sides` walks the whole `days` space to check
/// that the two answers agree.
///
/// `AfterMatch` is not a schedule and is never due here — it is parked at its crossing and drained by
/// `take_parked_due` (§6.2). Answering `false` rather than taking `DailyAt` alone keeps this callable
/// from a walk that has a `&TimerMode` and no reason to have destructured it yet.
pub fn schedule_due(mode: &TimerMode, last_fired_day: Option<i32>, now_local: LocalTime) -> bool {
    let TimerMode::DailyAt { minute_of_day, days } = mode else {
        return false;
    };
    if !(0..MINUTES_PER_DAY).contains(minute_of_day) {
        return false;
    }
    if last_fired_day == Some(now_local.day_ordinal) {
        return false;
    }
    let Some(today) = weekday_bit(now_local.day_ordinal) else {
        return false;
    };
    // `WEEKDAY_BITS_MASK` is `automation_store`'s, so this and `timer.noDays` cannot answer from two
    // different tables. **It is a no-op in this expression and is kept as documentation, not as a
    // guard**: `today` is `1 << (0..=6)`, so it is already inside the mask and no `days` byte exists
    // for which anding the mask in changes the answer — the spare 8th bit cannot select a weekday
    // because there is no weekday to select. The real binding to validation is the exhaustive
    // agreement test, not this term.
    if days & WEEKDAY_BITS_MASK & today == 0 {
        return false;
    }
    now_local.minute_of_day >= *minute_of_day
}

/// Has this schedule's target minute already gone by today?
///
/// **`AutomationEngine::reload`'s question, and it must be `schedule_due`'s own comparison** — the
/// seed is only correct while it means *"`schedule_due` would say yes on the strength of the minute
/// alone"*. Written out a second time at the call site, a change to one of them would leave the
/// engine seeding a day it then refuses to fire, or refusing to seed a day it would.
///
/// The weekday is deliberately not consulted: seeding a day the mask excludes marks a day the rule
/// was never going to fire on, which changes nothing and keeps the seed a fact about the CLOCK. A
/// mode that is not a schedule, or a `minute_of_day` that is not a time of day, has no target to
/// have passed — the same two refusals `schedule_due` makes, for the same reason.
pub fn target_already_past(mode: &TimerMode, now_local: LocalTime) -> bool {
    let TimerMode::DailyAt { minute_of_day, .. } = mode else {
        return false;
    };
    (0..MINUTES_PER_DAY).contains(minute_of_day) && now_local.minute_of_day >= *minute_of_day
}

/// A `minute_of_day` as a 24-hour `HH:MM`.
///
/// **Here rather than in `dry.rs`, where it started, because it now has two readers.** The dry run
/// prints a schedule's target minute and so does the suppression row `seed_missed_schedules` writes
/// — one rule's one time of day, and two spellings of it is `two-implementations-one-fix` waiting
/// to happen the first time either is padded differently.
///
/// Still not shared with the TypeScript `clockTime`, for `describe_wait`'s reason: nothing sends
/// these strings across the wire, and a shared formatter would be a coupling with no call path.
/// An out-of-range minute is `timer.badMinute`'s business, not this function's: it formats whatever
/// arithmetic gives, and every caller refuses the range before calling it — `target_already_past`
/// and `schedule_due` refuse it internally, and `dry.rs`'s schedule branch refuses it explicitly
/// before formatting the "sends at" row.
///
/// **Corrected (I1).** This used to claim `dry.rs` had "already been through `target_already_past`
/// or `schedule_due`", which was false: it called this function directly, unguarded, so unpicking
/// every weekday and pressing Test formatted `-5` into `"00:-5"` and reported it as an ordinary,
/// would-fire time. `dry.rs` now range-checks before calling this, matching the other two callers
/// rather than being named alongside them without doing what they do.
pub fn clock_time(minute_of_day: i32) -> String {
    format!("{:02}:{:02}", minute_of_day / 60, minute_of_day % 60)
}

/// Which weekday bit `day_ordinal` names, `1 << 0` = Monday.
///
/// Derived through `chrono` rather than `(ordinal - 1) % 7`: the modulus is right only because
/// 0001-01-01 happens to be a Monday in the proleptic Gregorian calendar, and that is a fact about
/// chrono's epoch, not one this module should restate. `None` for an ordinal outside chrono's date
/// range, which `local_now` cannot produce.
fn weekday_bit(day_ordinal: i32) -> Option<u8> {
    let date = NaiveDate::from_num_days_from_ce_opt(day_ordinal)?;
    Some(1u8 << date.weekday().num_days_from_monday())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Weekday;

    const WEEKDAYS: u8 = 0b0001_1111;
    const ALL_DAYS: u8 = WEEKDAY_BITS_MASK;
    /// The bit that names no day at all — a hand-crafted or corrupted mask, never one the editor
    /// can produce.
    const SPARE_BIT_ONLY: u8 = 0b1000_0000;

    fn daily_at(minute_of_day: i32, days: u8) -> TimerMode {
        TimerMode::DailyAt { minute_of_day, days }
    }

    fn local(day_ordinal: i32, minute_of_day: i32) -> LocalTime {
        LocalTime { day_ordinal, minute_of_day }
    }

    /// A real date as an ordinal, **with its weekday asserted here** so a test that says "Saturday"
    /// cannot quietly be about a Tuesday.
    fn day(y: i32, m: u32, d: u32, weekday: Weekday) -> i32 {
        let date = NaiveDate::from_ymd_opt(y, m, d).expect("a real date");
        assert_eq!(date.weekday(), weekday, "{date} is not a {weekday:?}");
        date.num_days_from_ce()
    }

    /// The ordinary day: due once the minute arrives, and not a second time.
    #[test]
    fn fires_once_on_the_target_day() {
        let mode = daily_at(9 * 60, WEEKDAYS);
        let monday = day(2026, 9, 7, Weekday::Mon);

        assert!(!schedule_due(&mode, None, local(monday, 8 * 60 + 59)), "a minute early");
        assert!(schedule_due(&mode, None, local(monday, 9 * 60)), "on the minute");
        assert!(
            !schedule_due(&mode, Some(monday), local(monday, 9 * 60)),
            "the same tick, once the day is marked"
        );
        assert!(
            !schedule_due(&mode, Some(monday), local(monday, 23 * 60 + 59)),
            "and not again all day, which is what `>=` would otherwise mean"
        );
        // Yesterday's mark is not today's.
        assert!(schedule_due(&mode, Some(monday - 1), local(monday, 9 * 60)));
    }

    #[test]
    fn does_not_fire_on_a_day_outside_the_mask() {
        let mode = daily_at(9 * 60, WEEKDAYS);
        let saturday = day(2026, 9, 5, Weekday::Sat);
        let sunday = day(2026, 9, 6, Weekday::Sun);

        assert!(!schedule_due(&mode, None, local(saturday, 9 * 60)));
        assert!(!schedule_due(&mode, None, local(sunday, 12 * 60)));
        // And the mask is read the right way round: Monday is bit 0, not Sunday.
        assert!(schedule_due(&mode, None, local(day(2026, 9, 7, Weekday::Mon), 9 * 60)));
        assert!(schedule_due(&mode, None, local(day(2026, 9, 11, Weekday::Fri), 9 * 60)));
    }

    /// **02:00–03:00 does not exist on this day**, so a 02:30 timer is never *equal* to `now`.
    ///
    /// `==` would make this rule silently dead once a year. `>=` fires it at 03:00 — late, once. The
    /// date is a real spring-forward Sunday, but the weekday is incidental: what is under test is the
    /// hour the clock skipped.
    #[test]
    fn spring_forward_fires_late_rather_than_never() {
        let mode = daily_at(2 * 60 + 30, ALL_DAYS);
        let transition = day(2026, 3, 8, Weekday::Sun);

        // 01:59 is the last minute before the jump, and the rule is not due yet.
        assert!(!schedule_due(&mode, None, local(transition, 60 + 59)));
        // The next wall-clock minute the tick can observe is 03:00. It must fire.
        assert!(
            schedule_due(&mode, None, local(transition, 3 * 60)),
            "an hour that does not exist must not silence the rule for the whole day"
        );
    }

    /// **01:00–02:00 happens twice on this day.** `last_fired_day` is the whole guard.
    #[test]
    fn fall_back_does_not_fire_twice_in_the_repeated_hour() {
        let mode = daily_at(60 + 30, ALL_DAYS);
        let transition = day(2026, 11, 1, Weekday::Sun);

        assert!(schedule_due(&mode, None, local(transition, 90)), "the first 01:30");
        assert!(
            !schedule_due(&mode, Some(transition), local(transition, 90)),
            "last_fired_day is the guard: the second 01:30 is the same day"
        );
    }

    /// **The launch case, as the predicate sees it.** A 09:00 prompt must not arrive at 14:00 because
    /// the app started late — and with `>=` the only thing standing between it and arriving is the
    /// day mark that `AutomationEngine::reload` seeds. The seeding itself is pinned where it lives,
    /// by `a_schedule_missed_while_the_app_was_closed_does_not_fire_on_launch`.
    #[test]
    fn a_day_already_marked_swallows_a_target_that_is_long_past() {
        let today = day(2026, 9, 7, Weekday::Mon);
        assert!(!schedule_due(&daily_at(9 * 60, ALL_DAYS), Some(today), local(today, 14 * 60)));
        // And the same instant with NO mark is due — which is why the seeding has to exist.
        assert!(schedule_due(&daily_at(9 * 60, ALL_DAYS), None, local(today, 14 * 60)));
    }

    /// A `days` byte whose only bit is the spare 8th one selects no weekday, ever.
    ///
    /// `timer.noDays` blocks such a rule at save; this is the other half of that agreement, for a row
    /// that reached the store some other way.
    #[test]
    fn the_spare_eighth_bit_alone_never_fires() {
        let mode = daily_at(0, SPARE_BIT_ONLY);
        let monday = day(2026, 9, 7, Weekday::Mon);
        for offset in 0..7 {
            assert!(
                !schedule_due(&mode, None, local(monday + offset, 23 * 60 + 59)),
                "day +{offset} fired on a mask that names no day"
            );
        }
    }

    /// `minute_of_day` is a bare `i32`: `-5` would make `now >= target` true from midnight, and
    /// `5000` true never. Both are `timer.badMinute`, and both are refused here too.
    #[test]
    fn a_minute_outside_the_day_never_fires() {
        let monday = day(2026, 9, 7, Weekday::Mon);
        for minute in [-1, -5, MINUTES_PER_DAY, MINUTES_PER_DAY + 1, i32::MIN, i32::MAX] {
            let mode = daily_at(minute, ALL_DAYS);
            for now in [0, 12 * 60, MINUTES_PER_DAY - 1] {
                assert!(
                    !schedule_due(&mode, None, local(monday, now)),
                    "minute_of_day {minute} fired at {now}"
                );
            }
        }
        // The two ends of the legal range still work, so the bound is not off by one.
        assert!(schedule_due(&daily_at(0, ALL_DAYS), None, local(monday, 0)), "midnight is a time");
        assert!(schedule_due(
            &daily_at(MINUTES_PER_DAY - 1, ALL_DAYS),
            None,
            local(monday, MINUTES_PER_DAY - 1)
        ));
    }

    /// **The agreement F5 is actually about**, walked rather than asserted: for every one of the 256
    /// `days` bytes, "validation says this can never fire" and "the engine never fires it" must be
    /// the same sentence. A mask re-declared in the engine, or dropped from either side, splits them.
    ///
    /// The oracle is `automation_validation::problems` itself, not a re-derivation of its rule — a
    /// test that recomputed `days & MASK == 0` here would agree with a broken validator.
    #[test]
    fn an_unfireable_rule_is_unfireable_on_both_sides() {
        let monday = day(2026, 9, 7, Weekday::Mon);
        for days in 0u8..=u8::MAX {
            let mut rule = crate::automation_engine::test_host::schedule_only_rule("au-sweep");
            rule.graph.timer =
                Some(crate::automation_store::TimerStep { mode: daily_at(9 * 60, days) });
            let blocked = crate::automation_validation::problems(&rule)
                .iter()
                .any(|p| p.code == "timer.noDays");

            let mode = daily_at(9 * 60, days);
            // A whole week, at an hour past the target, so only the mask can hold it back.
            let ever = (0..7).any(|d| schedule_due(&mode, None, local(monday + d, 10 * 60)));

            assert_eq!(
                !ever, blocked,
                "days={days:#010b}: validation blocks={blocked}, engine ever fires={ever}"
            );
        }
    }

    /// The same agreement on the other field. The `minute_of_day` space is too big to walk, so this
    /// is its boundary: one under, both ends, one over.
    #[test]
    fn a_minute_validation_refuses_is_a_minute_the_engine_refuses() {
        let monday = day(2026, 9, 7, Weekday::Mon);
        for minute in [-1, 0, 1, MINUTES_PER_DAY - 1, MINUTES_PER_DAY, MINUTES_PER_DAY + 1] {
            let mut rule = crate::automation_engine::test_host::schedule_only_rule("au-sweep");
            rule.graph.timer = Some(crate::automation_store::TimerStep {
                mode: daily_at(minute, WEEKDAY_BITS_MASK),
            });
            let blocked = crate::automation_validation::problems(&rule)
                .iter()
                .any(|p| p.code == "timer.badMinute");

            let mode = daily_at(minute, WEEKDAY_BITS_MASK);
            // Every minute of the day, so only the range check can hold it back.
            let ever = (0..MINUTES_PER_DAY).any(|m| schedule_due(&mode, None, local(monday, m)));

            assert_eq!(
                !ever, blocked,
                "minute_of_day={minute}: validation blocks={blocked}, engine ever fires={ever}"
            );
        }
    }

    /// The seed's own question, and it must not drift from `schedule_due`'s comparison: whatever
    /// `target_already_past` says, `schedule_due` on an unmarked day must say the same thing once the
    /// mask is out of the way.
    #[test]
    fn the_seed_asks_exactly_what_the_minute_comparison_asks() {
        let monday = day(2026, 9, 7, Weekday::Mon);
        for target in [0, 1, 9 * 60, MINUTES_PER_DAY - 1] {
            let mode = daily_at(target, ALL_DAYS);
            for now in [0, 1, 9 * 60 - 1, 9 * 60, 14 * 60, MINUTES_PER_DAY - 1] {
                assert_eq!(
                    target_already_past(&mode, local(monday, now)),
                    schedule_due(&mode, None, local(monday, now)),
                    "target={target} now={now}"
                );
            }
        }
        // Neither a delay nor a minute that is not a time of day has a target to have passed.
        assert!(!target_already_past(
            &TimerMode::AfterMatch { delay_ms: 30_000 },
            local(monday, MINUTES_PER_DAY - 1)
        ));
        assert!(!target_already_past(&daily_at(-5, ALL_DAYS), local(monday, 0)));
        assert!(!target_already_past(&daily_at(MINUTES_PER_DAY, ALL_DAYS), local(monday, 0)));
    }

    /// A delay rule is not a schedule and is never due here — it is parked and drained elsewhere.
    #[test]
    fn an_after_match_wait_is_never_a_schedule() {
        let mode = TimerMode::AfterMatch { delay_ms: 30_000 };
        let monday = day(2026, 9, 7, Weekday::Mon);
        assert!(!schedule_due(&mode, None, local(monday, 0)));
        assert!(!schedule_due(&mode, None, local(monday, MINUTES_PER_DAY - 1)));
    }

    /// **`local_now` reads the wall clock, not UTC** — the crate's other sixteen clocks are
    /// `Utc::now()` and this is the one place that must not be.
    ///
    /// The expectation is built by ARITHMETIC (the zone's offset at that instant, added to the UTC
    /// instant), not by a second `with_timezone(&Local)` call, so it is an independent derivation
    /// rather than the implementation restated. On a machine set to UTC the offset is zero and this
    /// degenerates to a consistency check; on any other machine — including the one this was written
    /// on — swapping `Local` for `Utc` fails it.
    #[test]
    fn local_now_is_a_wall_clock_and_not_a_utc_clock() {
        use chrono::{Offset, TimeZone};
        for now_ms in [0i64, 1_700_000_000_000, 1_772_000_000_000, -86_400_000] {
            let utc = DateTime::from_timestamp_millis(now_ms).expect("in range");
            let offset_secs =
                Local.offset_from_utc_datetime(&utc.naive_utc()).fix().local_minus_utc() as i64;
            let shifted = utc + chrono::Duration::seconds(offset_secs);

            assert_eq!(
                local_now(now_ms),
                LocalTime {
                    day_ordinal: shifted.date_naive().num_days_from_ce(),
                    minute_of_day: shifted.hour() as i32 * 60 + shifted.minute() as i32,
                },
                "now_ms={now_ms} offset={offset_secs}s"
            );
        }
    }

    /// Whatever the zone, a minute-of-day is a minute of a day, and the ordinal is the day it is in.
    #[test]
    fn local_now_stays_inside_the_day_it_names() {
        // A little over two days, a minute at a time, so a DST transition in any zone is crossed by
        // some machine running this and none of it may fall outside the range.
        let base = 1_772_000_000_000i64;
        for step in 0..3_000i64 {
            let at = local_now(base + step * 60_000);
            assert!(
                (0..MINUTES_PER_DAY).contains(&at.minute_of_day),
                "step {step} produced minute {}",
                at.minute_of_day
            );
            assert_eq!(
                NaiveDate::from_num_days_from_ce_opt(at.day_ordinal).map(|d| d.num_days_from_ce()),
                Some(at.day_ordinal),
                "the ordinal must name a real date, or the weekday cannot be derived from it"
            );
        }
    }

    /// The ordinal carries the weekday, and `weekday_bit` reads it the way §3.1 numbers it.
    #[test]
    fn the_ordinal_names_monday_as_bit_zero() {
        assert_eq!(weekday_bit(day(2026, 9, 7, Weekday::Mon)), Some(0b0000_0001));
        assert_eq!(weekday_bit(day(2026, 9, 11, Weekday::Fri)), Some(0b0001_0000));
        assert_eq!(weekday_bit(day(2026, 9, 5, Weekday::Sat)), Some(0b0010_0000));
        assert_eq!(weekday_bit(day(2026, 9, 6, Weekday::Sun)), Some(0b0100_0000));
        // Every bit it can produce is inside the mask — which is why the mask cannot change an
        // answer in `schedule_due`, and why the agreement above is asserted against the validator
        // rather than against that term.
        for offset in 0..7 {
            let bit = weekday_bit(day(2026, 9, 7, Weekday::Mon) + offset).expect("a real day");
            assert_eq!(bit & WEEKDAY_BITS_MASK, bit, "weekday {offset} escaped the mask");
        }
    }
}
