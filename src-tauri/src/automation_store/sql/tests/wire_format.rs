use super::super::*;
use super::support::*;

#[test]
fn the_wire_format_of_finds_is_unchanged_from_v1() {
    // The rename is Rust-and-UI only. If this serialises "reading" instead of "number",
    // every v1 rule stops loading AND every older build stops reading v2 rules —
    // and §3.3 says the second failure takes the whole list with it.
    let c = CondStep { finds: Finds::Reading, ..Default::default() };
    let v = serde_json::to_value(&c).unwrap();
    assert_eq!(v["kind"], "number");
    let e = CondStep { finds: Finds::Event, ..Default::default() };
    assert_eq!(serde_json::to_value(&e).unwrap()["kind"], "text");
}

#[test]
fn a_v1_cond_blob_still_deserialises() {
    let c: CondStep = serde_json::from_str(r#"{"kind":"number","op":"gt","threshold":25.0}"#).unwrap();
    assert_eq!(c.finds, Finds::Reading);
    assert_eq!(c.op, Some(CompareOp::Gt));
    assert!(c.clauses.is_empty(), "v1 has no clause list; the fold happens at load, not here");
}

/// The other half of the wire contract: a rule that uses no v2 feature must not GAIN a key.
///
/// Separate from `the_wire_format_of_finds_is_unchanged_from_v1` because it fails for a different
/// reason — that one catches a changed VALUE, this one a changed KEY SET, and §3.2's per-rule
/// `schema_version` stamp is only implementable while both hold. A `clauses: []` or a
/// `join: "and"` written into an untouched v1 rule is a rule an older build reads as v2-shaped.
#[test]
fn a_rule_using_no_v2_feature_gains_no_key_on_the_way_out() {
    // Byte for byte, not merely key-for-key: this is the exact blob a v1 build wrote.
    let v1 = r#"{"kind":"number","op":"gt","threshold":25.0}"#;
    let round_tripped = serde_json::to_string(&serde_json::from_str::<CondStep>(v1).unwrap()).unwrap();
    assert_eq!(round_tripped, v1);

    // And an event rule, which has no `op`/`threshold` to carry: `kind` alone.
    let e = CondStep { finds: Finds::Event, ..Default::default() };
    assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"kind":"text"}"#);
}

/// **Every clause spelling on the wire, decoded from literal JSON.**
///
/// The renderer's shared fixture is a strong pin, but it only happens to exercise
/// `TextOp::{Is, Contains, IsEmpty, Matches}` and `CompareOp::Gt` \u2014 `TextOp::{IsNot,
/// NotContains, IsNotEmpty}`, five of the six `CompareOp`s and `Join` ENTIRELY were decoded by
/// no Rust test at all. These are permanent contracts: the first rule saved with one of them
/// fixes its spelling forever, and `#[serde(rename_all = "camelCase")]` producing `notContains`
/// rather than `not_contains` is a fact about the derive, not something to assume.
///
/// Written as literal JSON on purpose \u2014 a serialise-then-deserialise round trip agrees with
/// itself whatever the derive renames things to.
#[test]
fn every_clause_spelling_decodes_from_its_wire_form() {
    let text_ops: [(&str, TextOp); 7] = [
        (r#"{"source":"whole","test":{"text":{"op":"is","value":"x"}}}"#, TextOp::Is),
        (r#"{"source":"whole","test":{"text":{"op":"isNot","value":"x"}}}"#, TextOp::IsNot),
        (r#"{"source":"whole","test":{"text":{"op":"contains","value":"x"}}}"#, TextOp::Contains),
        (
            r#"{"source":"whole","test":{"text":{"op":"notContains","value":"x"}}}"#,
            TextOp::NotContains,
        ),
        (r#"{"source":"whole","test":{"text":{"op":"matches","value":"x"}}}"#, TextOp::Matches),
        (r#"{"source":"whole","test":{"text":{"op":"isEmpty","value":""}}}"#, TextOp::IsEmpty),
        (
            r#"{"source":"whole","test":{"text":{"op":"isNotEmpty","value":""}}}"#,
            TextOp::IsNotEmpty,
        ),
    ];
    for (json, want) in text_ops {
        let c: Clause = serde_json::from_str(json).unwrap_or_else(|e| panic!("{json}: {e}"));
        match c.test {
            Test::Text { op, .. } => assert_eq!(op, want, "{json}"),
            other => panic!("{json} decoded as {other:?}"),
        }
        // And back out again, byte for byte: the spelling is a contract in both directions.
        assert_eq!(serde_json::to_string(&c).unwrap(), json);
    }

    let num_ops: [(&str, CompareOp); 6] = [
        (r#"{"source":{"group":1},"test":{"number":{"op":"gt","value":1.0}}}"#, CompareOp::Gt),
        (r#"{"source":{"group":1},"test":{"number":{"op":"gte","value":1.0}}}"#, CompareOp::Gte),
        (r#"{"source":{"group":1},"test":{"number":{"op":"lt","value":1.0}}}"#, CompareOp::Lt),
        (r#"{"source":{"group":1},"test":{"number":{"op":"lte","value":1.0}}}"#, CompareOp::Lte),
        (r#"{"source":{"group":1},"test":{"number":{"op":"eq","value":1.0}}}"#, CompareOp::Eq),
        (r#"{"source":{"group":1},"test":{"number":{"op":"neq","value":1.0}}}"#, CompareOp::Neq),
    ];
    for (json, want) in num_ops {
        let c: Clause = serde_json::from_str(json).unwrap_or_else(|e| panic!("{json}: {e}"));
        match c.test {
            Test::Number { op, value } => {
                assert_eq!(op, want, "{json}");
                assert_eq!(value, Some(1.0), "{json}");
            }
            other => panic!("{json} decoded as {other:?}"),
        }
        assert_eq!(serde_json::to_string(&c).unwrap(), json);
    }

    // The third `Source` spelling, which neither list above uses.
    let named: Clause =
        serde_json::from_str(r#"{"source":{"named":"code"},"test":{"text":{"op":"is","value":"x"}}}"#)
            .unwrap();
    assert_eq!(named.source, Source::Named("code".into()));

    // A numeric clause with NO threshold \u2014 `null`, which is what `CondPanel` puts on the wire
    // the moment a row turns numeric, and what a bare `f64` refused outright.
    let empty_json = r#"{"source":"whole","test":{"number":{"op":"gt","value":null}}}"#;
    let empty: Clause = serde_json::from_str(empty_json).unwrap();
    assert!(matches!(empty.test, Test::Number { value: None, .. }));
    // **And back out again, like every filled row above.** `value: None` carries no
    // `skip_serializing_if`, so it is written as `"value":null` rather than omitted — correct
    // for this build, and now a pinned contract rather than an accident. Only the FILLED values
    // were pinned in both directions, and the first rule saved with a half-typed threshold
    // fixes this spelling forever.
    assert_eq!(serde_json::to_string(&empty).unwrap(), empty_json);
    // And a MISSING key decodes the same way, which is what `#[serde(default)]` is there for.
    let absent: Clause =
        serde_json::from_str(r#"{"source":"whole","test":{"number":{"op":"gt"}}}"#).unwrap();
    assert_eq!(absent, empty);
}

/// `Join` is decoded by no other test in either suite \u2014 the renderer fixture never sets it, and
/// `And` is skipped on serialise, so only `"or"` ever appears on the wire at all.
#[test]
fn the_join_spellings_decode_from_their_wire_form() {
    let or: CondStep = serde_json::from_str(r#"{"kind":"number","join":"or"}"#).unwrap();
    assert_eq!(or.join, Join::Or);
    let and: CondStep = serde_json::from_str(r#"{"kind":"number","join":"and"}"#).unwrap();
    assert_eq!(and.join, Join::And);
    // Absent means `And` \u2014 the default, which is why it is never written.
    let absent: CondStep = serde_json::from_str(r#"{"kind":"number"}"#).unwrap();
    assert_eq!(absent.join, Join::And);
    // Out again: `Or` is written, `And` is not.
    assert_eq!(serde_json::to_string(&or).unwrap(), r#"{"kind":"number","join":"or"}"#);
    assert_eq!(serde_json::to_string(&and).unwrap(), r#"{"kind":"number"}"#);
}

#[test]
fn a_clause_round_trips() {
    let c = Clause { source: Source::Group(2), test: Test::Number { op: CompareOp::Gt, value: Some(60.0) } };
    let s = serde_json::to_string(&c).unwrap();
    assert_eq!(serde_json::from_str::<Clause>(&s).unwrap(), c);
}

// -----------------------------------------------------------------------------------------
// Plan 032 §3.1/§6 — `TimerStep`/`TimerMode`. `AfterMatch` drives park/drain (§6.2), and
// `DailyAt` drives `schedule_due` (§6.3). The wire shape is a permanent contract once a rule
// with a timer is saved, so these serde tests pin it.
// -----------------------------------------------------------------------------------------

/// `AfterMatch` is a single-field struct variant. `#[serde(rename_all = "camelCase")]` on the
/// enum must reach the FIELD inside the variant, not just the variant name itself — that is the
/// thing worth not assuming about a struct-variant enum.
#[test]
fn after_match_serialises_to_the_wire_shape_spec_gives() {
    let t = TimerStep { mode: TimerMode::AfterMatch { delay_ms: 30_000 } };
    assert_eq!(serde_json::to_string(&t).unwrap(), r#"{"mode":{"afterMatch":{"delayMs":30000}}}"#);
}

/// `DailyAt` has two fields; both must come out camelCase.
#[test]
fn daily_at_serialises_to_the_wire_shape_spec_gives() {
    // Mon+Tue+Wed+Thu+Fri, bit 0 = Monday, per the spec's doc comment.
    let t = TimerStep { mode: TimerMode::DailyAt { minute_of_day: 540, days: 0b0001_1111 } };
    assert_eq!(
        serde_json::to_string(&t).unwrap(),
        r#"{"mode":{"dailyAt":{"minuteOfDay":540,"days":31}}}"#
    );
}

#[test]
fn timer_step_round_trips_both_modes() {
    for t in [
        TimerStep { mode: TimerMode::AfterMatch { delay_ms: 30_000 } },
        TimerStep { mode: TimerMode::DailyAt { minute_of_day: 540, days: 31 } },
    ] {
        let s = serde_json::to_string(&t).unwrap();
        assert_eq!(serde_json::from_str::<TimerStep>(&s).unwrap(), t, "round trip of {s}");
    }
}

/// `skipTypedLine` behaves the way every other added field on this wire has to: absent decodes
/// off, off writes nothing, and on survives a round trip.
///
/// The middle one is the load-bearing clause and the reason this field is
/// `skip_serializing_if` where `substitute` is not. `MonitorStep` is on EVERY watching rule, so
/// a field that always serialised would rewrite every stored blob the first time this build
/// touched it — `a_v1_rule_still_round_trips_byte_for_byte` is the same claim from the other
/// end, and would have caught it as a failure rather than as a decision.
#[test]
fn skip_typed_line_defaults_off_writes_nothing_off_and_round_trips_on() {
    let older = r#"{"read":"newOutput","cadence":"onOutput","everyMs":0}"#;
    let decoded: MonitorStep = serde_json::from_str(older)
        .expect("a monitor step written before this field existed must still decode");
    assert!(!decoded.skip_typed_line, "an older rule must not acquire the opt-in from a default");
    assert_eq!(serde_json::to_string(&decoded).unwrap(), older, "and must not gain the key");

    let on = MonitorStep { skip_typed_line: true, ..decoded };
    let s = serde_json::to_string(&on).unwrap();
    assert!(s.contains(r#""skipTypedLine":true"#), "written when it is actually used: {s}");
    assert_eq!(serde_json::from_str::<MonitorStep>(&s).unwrap(), on, "round trip of {s}");
}

/// The whole reason `timer` is `#[serde(default)]`: a rule saved by a build before this
/// milestone has no `timer` key in its graph blob at all, and that older JSON must still
/// decode — with `timer: None`, not a decode failure. Mirrors
/// `a_graph_with_no_substitute_key_decodes_with_it_off` above.
#[test]
fn a_graph_with_no_timer_key_still_decodes_as_none() {
    let raw = r#"{
        "monitor": {"read": "newOutput", "cadence": "onOutput", "everyMs": 0},
        "parse": {"preset": "custom", "find": "x", "keep": "whole"},
        "cond": {"kind": "text"},
        "action": {"message": "m"}
    }"#;
    let decoded: AutomationGraph =
        serde_json::from_str(raw).expect("a graph missing only the new optional `timer` field must still decode");
    assert_eq!(decoded.timer, None, "an older rule has no timer, and must not gain one from a default value");
}

/// §3.1 — an absent input step writes **no key at all**, never `"monitor": null`.
///
/// **The distinction is not cosmetic, and this is why the assertion is on the KEY SET.** A
/// `null` in a `monitor` position is a value an older build must decode into a NON-optional
/// `MonitorStep`, which fails — and §3.3 says a row that will not decode takes the whole rule
/// list with it, so one v2 rule would empty the Automations page. With the key simply absent,
/// the older build's own `#[serde(default)]`-less required field still fails, but the same
/// shape on a build that has this change decodes cleanly and is refused, if at all, at the
/// friendlier `is_runnable()` gate. `assert_eq!(v["monitor"], Value::Null)` would pass for both
/// spellings and pin neither.
#[test]
fn a_schedule_rule_writes_no_monitor_parse_or_cond_key() {
    let schedule = AutomationGraph {
        monitor: None,
        parse: None,
        cond: None,
        timer: Some(TimerStep {
            mode: TimerMode::DailyAt { minute_of_day: 9 * 60, days: 0b0001_1111 },
        }),
        action: Some(ActionStep {
            message: "stand-up notes?".to_string(),
            send_to: SendTo::Matched,
            submit: true,
            cli_type: "default".to_string(),
            substitute: false,
        }),
        webhook: None,
        layout: None,
    };

    let v = serde_json::to_value(&schedule).unwrap();
    let obj = v.as_object().expect("a graph serialises as an object");
    for step in ["monitor", "parse", "cond"] {
        assert!(
            !obj.contains_key(step),
            "an absent `{step}` must write NO key, not a null — got {v}"
        );
    }
    // And what it DOES write, so this cannot pass by serialising nothing at all.
    assert!(obj.contains_key("timer"), "the schedule itself must survive: {v}");
    assert!(obj.contains_key("action"), "`action` stays required (§3.1): {v}");

    // Round trip: absence decodes back as absence, not as a defaulted step. `ParseStep`'s
    // default would be an EMPTY pattern, which compiles and matches everything.
    let back: AutomationGraph = serde_json::from_value(v).unwrap();
    assert_eq!(back, schedule);
}

/// The paired negative: a rule that HAS the three steps still writes all three.
///
/// Without this, the test above is satisfied by a `skip_serializing_if` that always skips.
#[test]
fn an_ordinary_rule_still_writes_all_three_input_steps() {
    let v = serde_json::to_value(graph()).unwrap();
    let obj = v.as_object().unwrap();
    for step in ["monitor", "parse", "cond", "action"] {
        assert!(obj.contains_key(step), "`{step}` must still cross the wire: {v}");
    }
}
