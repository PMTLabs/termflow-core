use super::super::*;

pub(super) fn graph() -> AutomationGraph {
    AutomationGraph {
        layout: None,
        timer: None,
        monitor: Some(MonitorStep {
            read: ReadMode::NewOutput,
            cadence: Cadence::OnOutput,
            every_ms: 30_000,
            skip_typed_line: false,
        }),
        parse: Some(ParseStep {
            preset: ParsePreset::Percentage,
            literal: Some("ctx:".to_string()),
            find: r"ctx:\s*(\d+)%".to_string(),
            keep: Keep::Brackets,
        }),
        cond: Some(CondStep {
            finds: Finds::Reading,
            op: Some(CompareOp::Gt),
            threshold: Some(25.0),
            ..Default::default()
        }),
        action: Some(ActionStep {
            message: "prepare to do context-hand-off".to_string(),
            send_to: SendTo::Matched,
            submit: true,
            cli_type: "claude".to_string(),
            substitute: false,
        }),
        webhook: None,
    }
}

pub(super) fn rule(id: &str) -> AutomationRule {
    AutomationRule {
        id: id.to_string(),
        name: format!("rule {id}"),
        enabled: true,
        runs_once: false,
        target_mode: TargetMode::Pinned,
        criterion: Criterion::CommandContains,
        criterion_value: "claude".to_string(),
        follow_new: true,
        // A PINNED rule with no targets is one the enable gate refuses, so a fixture that had
        // none was every store test arranging a row the product cannot produce.
        target_ids: vec!["tm-1".to_string()],
        excluded_ids: vec![],
        exclude_criterion: None,
        exclude_criterion_value: String::new(),
        completed_at: None,
        verbose_until: None,
        sort_order: 1,
        schema_version: SUPPORTED_SCHEMA_VERSION,
        graph: graph(),
        created_at: 1_000,
        updated_at: 1_000,
    }
}

/// Insert a row whose `graph` column is arbitrary text, bypassing `save_rule`'s
/// serialisation. There is no other way to author a row this build cannot decode.
pub(super) fn write_raw_graph(store: &AutomationStore, id: &str, graph: &str) {
    store.insert_raw_graph_for_test(id, graph);
}

pub(super) fn rule_named(name: &str) -> AutomationRule {
    let mut r = rule(&format!("au-{name}")); // the existing fixture in this module
    r.name = name.to_string();
    r.sort_order = if name == "first" { 1 } else { 3 };
    r
}

pub(super) fn entry(rule_id: &str, kind: LogKind, at: i64) -> AutomationLogEntry {
    AutomationLogEntry {
        id: 0,
        rule_id: rule_id.to_string(),
        terminal_id: Some("tm-1".to_string()),
        terminal_name: Some("claude".to_string()),
        kind,
        detail: "detail".to_string(),
        at,
    }
}

pub(super) fn graph_with_timer() -> AutomationGraph {
    let mut g = graph();
    g.timer = Some(TimerStep { mode: TimerMode::AfterMatch { delay_ms: 30_000 } });
    g
}

pub(super) fn graph_with_no_monitor() -> AutomationGraph {
    let mut g = graph();
    g.monitor = None;
    g
}

pub(super) fn graph_with_no_parse() -> AutomationGraph {
    let mut g = graph();
    g.parse = None;
    g
}

pub(super) fn graph_with_no_cond() -> AutomationGraph {
    let mut g = graph();
    g.cond = None;
    g
}

pub(super) fn graph_with_one_clause() -> AutomationGraph {
    let mut g = graph();
    g.cond.as_mut().unwrap().clauses.push(Clause {
        source: Source::Group(1),
        test: Test::Number { op: CompareOp::Gt, value: Some(25.0) },
    });
    g
}

pub(super) fn graph_with_substitute() -> AutomationGraph {
    let mut g = graph();
    g.action_mut().substitute = true;
    g
}

pub(super) fn graph_with_skip_typed_line() -> AutomationGraph {
    let mut g = graph();
    g.monitor_mut().skip_typed_line = true;
    g
}

pub(super) fn stamped(graph: AutomationGraph) -> i64 {
    let mut rule = rule("au-stamp");
    rule.graph = graph;
    schema_version_for(&rule)
}

/// One rule's row for one terminal.
#[allow(clippy::type_complexity)]
pub(super) fn matched_row(
    store: &AutomationStore,
    rule_id: &str,
    tm: &str,
) -> (String, String, Option<String>, Option<String>, Option<i64>) {
    store
        .targets_for(rule_id)
        .unwrap()
        .into_iter()
        .find(|r| r.0 == tm)
        .unwrap_or_else(|| panic!("no row for {}", tm))
}

/// The store's own `rule()` fixture has an EMPTY pick set, which `problems()` blocks on — so the
/// enable-path tests need one that could legitimately run. That the base fixture is invalid is
/// itself the point: nothing before now judged a rule at all.
pub(super) fn enableable(id: &str) -> AutomationRule {
    let mut r = rule(id);
    r.target_ids = vec!["tm-1".to_string()];
    r
}

pub(super) fn enabled_flag(store: &AutomationStore, id: &str) -> bool {
    store.get_rule(id).unwrap().expect("the rule must still be there").enabled
}

