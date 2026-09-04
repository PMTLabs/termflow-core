//! The one fake the whole engine is tested through.
//!
//! **One fake, every consumer.** The loops, the send and the dry run all reach the app through
//! [`EngineHost`], whose every method is a projection with no decision in it (§7.10) — so one
//! recording implementation is enough for all of them, and a second one could only drift.
//!
//! `leaves` maps `tm-` to `pc-` with **deliberately different strings**, so any code path that passes
//! the wrong id fails instead of coincidentally working (§7.4).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::automation::roster::RosterRow;
use crate::automation_engine::eval::ReadDepth;
use crate::automation_engine::host::EngineHost;
use crate::automation_engine::AutomationEngine;
use crate::automation_store::{
    ActionStep, AutomationGraph, AutomationRule, AutomationStore, Cadence, CompareOp, CondKind,
    CondStep, Criterion, Keep, LogOrder, LogScope, MonitorStep, ParsePreset, ParseStep, ReadMode,
    SendTo, TargetMode, SUPPORTED_SCHEMA_VERSION,
};

/// One fake for all three loops and the send.
///
/// Every method is a projection, which is what makes one fake enough: the loops hold every
/// decision, so a test can drive them with plain data and never construct an `AppState`.
/// `leaves` maps `tm-` to `pc-` with **deliberately different strings**, so any code path that
/// passes the wrong id fails instead of coincidentally working.
pub(crate) struct FakeHost {
    pub(crate) store: Arc<AutomationStore>,
    pub(crate) leaves: Mutex<HashMap<String, String>>,
    pub(crate) roster: Mutex<Vec<RosterRow>>,
    pub(crate) text: Mutex<HashMap<String, String>>,
    pub(crate) writes: Mutex<Vec<(String, Vec<u8>)>>,
    pub(crate) write_err: Mutex<Option<String>>,
    pub(crate) activity: AtomicUsize,
    pub(crate) states: AtomicUsize,
}

impl FakeHost {
    pub(crate) fn new() -> Self {
        Self {
            store: Arc::new(AutomationStore::new_in_memory()),
            leaves: Mutex::new(HashMap::new()),
            roster: Mutex::new(Vec::new()),
            text: Mutex::new(HashMap::new()),
            writes: Mutex::new(Vec::new()),
            write_err: Mutex::new(None),
            activity: AtomicUsize::new(0),
            states: AtomicUsize::new(0),
        }
    }

    pub(crate) fn with_terminal(self, tm: &str, pc: &str, label: &str) -> Self {
        self.leaves.lock().unwrap().insert(tm.into(), pc.into());
        self.roster.lock().unwrap().push(RosterRow {
            terminal_id: Some(tm.into()),
            process_id: pc.into(),
            name: "Terminal-powershell".into(),
            shell: "powershell".into(),
            pid: 100,
            display_label: Some(label.into()),
            cwd: None,
            command_line: None,
        });
        self
    }

    pub(crate) fn say(&self, pc: &str, text: &str) {
        self.text.lock().unwrap().insert(pc.into(), text.into());
    }

    pub(crate) fn written(&self) -> Vec<String> {
        self.writes
            .lock()
            .unwrap()
            .iter()
            .map(|(_, b)| String::from_utf8_lossy(b).to_string())
            .collect()
    }
}

impl EngineHost for FakeHost {
    fn process_for_leaf(&self, tm: &str) -> Option<String> {
        self.leaves.lock().unwrap().get(tm).cloned()
    }
    fn roster(&self, _criteria: &[Criterion]) -> Vec<RosterRow> {
        self.roster.lock().unwrap().clone()
    }
    fn live_processes(&self) -> Vec<String> {
        self.leaves.lock().unwrap().values().cloned().collect()
    }
    fn tail(&self, pc: &str, _depth: ReadDepth) -> Option<String> {
        self.text.lock().unwrap().get(pc).cloned()
    }
    fn write(&self, pc: &str, bytes: &[u8]) -> Result<(), String> {
        self.writes.lock().unwrap().push((pc.to_string(), bytes.to_vec()));
        match self.write_err.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
    fn label_for(&self, tm: &str) -> Option<String> {
        self.roster
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.terminal_id.as_deref() == Some(tm))
            .and_then(|r| r.display_label.clone())
    }
    fn store(&self) -> &Arc<AutomationStore> {
        &self.store
    }
    fn emit_activity(&self, _rule_ids: Vec<String>) {
        self.activity.fetch_add(1, Ordering::Relaxed);
    }
    fn emit_state(&self) {
        self.states.fetch_add(1, Ordering::Relaxed);
    }
}

pub(crate) fn ctx_rule(id: &str) -> AutomationRule {
    AutomationRule {
        id: id.into(),
        name: format!("rule {}", id),
        enabled: true,
        runs_once: false,
        target_mode: TargetMode::Rule,
        criterion: Criterion::AllTerminals,
        criterion_value: String::new(),
        follow_new: true,
        target_ids: vec![],
        completed_at: None,
        verbose_until: None,
        sort_order: 1,
        schema_version: SUPPORTED_SCHEMA_VERSION,
        graph: AutomationGraph {
            monitor: MonitorStep { read: ReadMode::NewOutput, cadence: Cadence::OnOutput, every_ms: 0 },
            parse: ParseStep {
                preset: ParsePreset::Custom,
                literal: None,
                find: r"ctx:(\d+)%".into(),
                keep: Keep::Brackets,
            },
            cond: CondStep { kind: CondKind::Number, op: Some(CompareOp::Gt), threshold: Some(25.0) },
            action: ActionStep {
                message: "prepare to do context-hand-off".into(),
                send_to: SendTo::Matched,
                submit: true,
                cli_type: "claude".into(),
            },
        },
        created_at: 1_000,
        updated_at: 1_000,
    }
}

/// Engine + host, with every given rule loaded and watching the one terminal.
///
/// The rules go through `reload`, not straight into the live set, so a fixture cannot run a rule
/// the real load path would have refused.
pub(crate) fn wire(rules: Vec<AutomationRule>) -> (Arc<AutomationEngine>, Arc<FakeHost>, Arc<dyn EngineHost>) {
    let fake = Arc::new(FakeHost::new().with_terminal("tm-1", "pc-1", "codex · core"));
    for rule in &rules {
        fake.store.save_rule(rule).unwrap();
    }
    let engine = Arc::new(AutomationEngine::new(0));
    engine.reload(&fake.store, 0).unwrap();
    for rule in &rules {
        engine.runtime.set_watched(&rule.id, ["tm-1".to_string()].into());
    }
    let host: Arc<dyn EngineHost> = fake.clone();
    (engine, fake, host)
}

/// The canonical rule, alone.
pub(crate) fn wired() -> (Arc<AutomationEngine>, Arc<FakeHost>, Arc<dyn EngineHost>) {
    wire(vec![ctx_rule("au-1")])
}

pub(crate) fn log_kinds(store: &AutomationStore) -> Vec<String> {
    store
        .load_automation_log(&LogScope::All, LogOrder::Asc, 100)
        .unwrap()
        .into_iter()
        .map(|e| format!("{:?}", e.kind))
        .collect()
}

/// The canonical rule with a different message, so two sends into one terminal are told apart in
/// the write log by their contents rather than by the order they happen to arrive in.
pub(crate) fn ctx_rule_saying(id: &str, message: &str, sort_order: i64) -> AutomationRule {
    let mut rule = ctx_rule(id);
    rule.graph.action.message = message.into();
    rule.sort_order = sort_order;
    rule
}

/// A presence rule: `find` is looked for as text and there is no threshold at all.
pub(crate) fn presence_rule(id: &str, find: &str, message: &str, sort_order: i64) -> AutomationRule {
    let mut rule = ctx_rule_saying(id, message, sort_order);
    rule.graph.parse.find = find.into();
    rule.graph.parse.keep = Keep::Whole;
    rule.graph.cond = CondStep { kind: CondKind::Text, op: None, threshold: None };
    rule
}

pub(crate) fn log_details(store: &AutomationStore) -> Vec<(String, String)> {
    store
        .load_automation_log(&LogScope::All, LogOrder::Asc, 100)
        .unwrap()
        .into_iter()
        .map(|e| (format!("{:?}", e.kind), e.detail))
        .collect()
}

pub(crate) fn times_sent(fake: &FakeHost, message: &str) -> usize {
    fake.written().iter().filter(|w| w.contains(message)).count()
}
