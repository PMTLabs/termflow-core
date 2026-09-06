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
    ActionStep, AutomationGraph, AutomationRule, AutomationStore, Cadence, CompareOp, CondStep,
    Criterion, Finds, Keep, LogOrder, LogScope, MonitorStep, ParsePreset, ParseStep, ReadMode,
    SendTo, TargetMode, TimerMode, TimerStep, SUPPORTED_SCHEMA_VERSION,
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
    /// Process-derived command lines, made visible only when the caller asks the roster for the
    /// criterion that requires a process scan. This gives targeting tests the same request/populate
    /// seam as `AppState::roster` without taking a real machine snapshot.
    pub(crate) scanned_command_lines: Mutex<HashMap<String, Vec<String>>>,
    pub(crate) roster_criteria: Mutex<Vec<Vec<Criterion>>>,
    pub(crate) text: Mutex<HashMap<String, String>>,
    /// Every `tail` the engine asked for, in order — **the screen reads, recorded**.
    ///
    /// §6.3's schedule rule is specified by what it does NOT do, and "reads no screen" is not
    /// observable from `written()` or the log: a rule that read the window and decided not to send
    /// looks identical. `text` cannot answer it either, because a read leaves no trace there. So the
    /// port records the call, and a test can assert the exact list — which is also what keeps the
    /// assertion honest, since an empty list proves nothing unless some other pair in the same run
    /// put something in it.
    pub(crate) tails: Mutex<Vec<String>>,
    pub(crate) writes: Mutex<Vec<(String, Vec<u8>)>>,
    pub(crate) write_err: Mutex<Option<String>>,
    pub(crate) activity: AtomicUsize,
    pub(crate) states: AtomicUsize,
    /// Every `emit_changed`, by the ids it named — not a counter.
    ///
    /// A count answers "did the engine announce something", which is satisfied by announcing the
    /// WRONG rule; the assertion that matters is which rule the windows were told to refetch.
    pub(crate) changed: Mutex<Vec<Vec<String>>>,
    /// Run on every `process_for_leaf`, so a test can interleave the TAP with the evaluator's own
    /// bookkeeping loop.
    ///
    /// The evaluator resolves each pair's leaf and reads that process's dirty generation in the same
    /// pass; the tap runs on another worker and can move it between two pairs of the same tick. That
    /// is the whole reason the tick keeps the EARLIEST generation it saw, and without a seam here no
    /// test can tell earliest from latest — which is how the choice shipped unpinned.
    #[allow(clippy::type_complexity)]
    pub(crate) on_leaf_lookup: Mutex<Option<Arc<dyn Fn(&str) + Send + Sync>>>,
}

impl FakeHost {
    pub(crate) fn new() -> Self {
        Self {
            store: Arc::new(AutomationStore::new_in_memory()),
            leaves: Mutex::new(HashMap::new()),
            roster: Mutex::new(Vec::new()),
            scanned_command_lines: Mutex::new(HashMap::new()),
            roster_criteria: Mutex::new(Vec::new()),
            text: Mutex::new(HashMap::new()),
            tails: Mutex::new(Vec::new()),
            writes: Mutex::new(Vec::new()),
            write_err: Mutex::new(None),
            activity: AtomicUsize::new(0),
            states: AtomicUsize::new(0),
            changed: Mutex::new(Vec::new()),
            on_leaf_lookup: Mutex::new(None),
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
            command_lines: Vec::new(),
        });
        self
    }

    /// The terminal is CLOSED: its leaf no longer resolves **and it is out of the roster**.
    ///
    /// Clearing `leaves` alone is not a closed terminal, and that distinction hid a blocker: the
    /// failure tests cleared only the leaf, so `label_for` still found the roster row and returned a
    /// name — which is exactly what a real closed terminal cannot do. An implementation that resolved
    /// the name at WRITE time therefore passed a test written to prove it resolves it at DECIDE time.
    pub(crate) fn close(&self, tm: &str) {
        self.leaves.lock().unwrap().remove(tm);
        self.roster.lock().unwrap().retain(|r| r.terminal_id.as_deref() != Some(tm));
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

    /// Every id the send path actually addressed.
    ///
    /// `written()` throws the id away, and `write` accepts any string — so `deliver(.., &tm, ..)`
    /// instead of `&pc` passed every send test while addressing a map that is keyed the other way.
    /// §7.4's whole point is that the two spaces are DELIBERATELY different strings here, and an
    /// oracle that discards the id cannot see the one mistake the fixture was built to catch.
    pub(crate) fn written_to(&self) -> Vec<String> {
        self.writes.lock().unwrap().iter().map(|(pc, _)| pc.clone()).collect()
    }

    /// Every process id whose screen was read, in order.
    pub(crate) fn tailed(&self) -> Vec<String> {
        self.tails.lock().unwrap().clone()
    }

    /// Every rule id the engine told the windows to refetch, in order.
    pub(crate) fn announced(&self) -> Vec<String> {
        self.changed.lock().unwrap().iter().flatten().cloned().collect()
    }

    pub(crate) fn last_roster_criteria(&self) -> Vec<Criterion> {
        self.roster_criteria.lock().unwrap().last().cloned().unwrap_or_default()
    }
}

impl EngineHost for FakeHost {
    fn process_for_leaf(&self, tm: &str) -> Option<String> {
        let hook = self.on_leaf_lookup.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(tm);
        }
        self.leaves.lock().unwrap().get(tm).cloned()
    }
    fn roster(&self, criteria: &[Criterion]) -> Vec<RosterRow> {
        self.roster_criteria.lock().unwrap().push(criteria.to_vec());
        let mut rows = self.roster.lock().unwrap().clone();
        if criteria.contains(&Criterion::CommandContains) {
            let scanned = self.scanned_command_lines.lock().unwrap();
            for row in &mut rows {
                if let Some(lines) = row
                    .terminal_id
                    .as_deref()
                    .and_then(|terminal_id| scanned.get(terminal_id))
                {
                    row.command_lines = lines.clone();
                }
            }
        }
        rows
    }
    fn live_processes(&self) -> Vec<String> {
        self.leaves.lock().unwrap().values().cloned().collect()
    }
    fn tail(&self, pc: &str, _depth: ReadDepth) -> Option<String> {
        // Recorded BEFORE the lookup, so a process with no text still counts as a read attempt —
        // §4.5's dormant terminal is a `None` here, and a path that reaches this port has read.
        self.tails.lock().unwrap().push(pc.to_string());
        self.text.lock().unwrap().get(pc).cloned()
    }
    fn write(&self, pc: &str, bytes: &[u8]) -> Result<(), String> {
        // **The fake refuses an id it does not know.** §7.4's one conversion is `process_for_leaf`,
        // and a `tm-` id reaching a `pc-`keyed writer is silent in production — it was silent here
        // too, because the write was recorded and read straight back as if it had landed. One
        // assertion in one test protects one write path; this protects the ones not written yet.
        if !self.leaves.lock().unwrap().values().any(|known| known == pc) {
            return Err(format!("no terminal has process id {}", pc));
        }
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
    fn emit_changed(&self, rule_ids: Vec<String>) {
        self.changed.lock().unwrap().push(rule_ids);
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
        excluded_ids: vec![],
        exclude_criterion: None,
        exclude_criterion_value: String::new(),
        completed_at: None,
        verbose_until: None,
        sort_order: 1,
        schema_version: SUPPORTED_SCHEMA_VERSION,
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
                message: "prepare to do context-hand-off".into(),
                send_to: SendTo::Matched,
                submit: true,
                cli_type: "claude".into(),
                substitute: false,
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

/// The canonical rule, with its graph adjustable through a closure — for a test that needs to change
/// more than the one or two fields `ctx_rule_saying`/`presence_rule` cover (§4.2/§4.4's substitution
/// tests vary `parse.find`, `cond.finds`, `action.message` and `action.substitute` together).
pub(crate) fn rig_with_rule(
    f: impl FnOnce(&mut AutomationGraph),
) -> (Arc<AutomationEngine>, Arc<FakeHost>, Arc<dyn EngineHost>) {
    let mut rule = ctx_rule("au-1");
    f(&mut rule.graph);
    wire(vec![rule])
}

/// Like `wire`, but plants each rule with `save_rule_bypassing_the_enable_gate_for_tests` rather
/// than `save_rule` — for a rule §7.8's enable gate would now refuse to create (Task 6's
/// `action.unknownToken` and friends), simulating one written by a build OLDER than that
/// validation. `reload`'s own `parse.*`-only exemption already establishes that such a row is
/// real, not hypothetical, and still has to reach evaluate-and-send.
pub(crate) fn wire_bypassing_the_enable_gate(
    rules: Vec<AutomationRule>,
) -> (Arc<AutomationEngine>, Arc<FakeHost>, Arc<dyn EngineHost>) {
    let fake = Arc::new(FakeHost::new().with_terminal("tm-1", "pc-1", "codex · core"));
    for rule in &rules {
        fake.store.save_rule_bypassing_the_enable_gate_for_tests(rule).unwrap();
    }
    let engine = Arc::new(AutomationEngine::new(0));
    engine.reload(&fake.store, 0).unwrap();
    for rule in &rules {
        engine.runtime.set_watched(&rule.id, ["tm-1".to_string()].into());
    }
    let host: Arc<dyn EngineHost> = fake.clone();
    (engine, fake, host)
}

/// `rig_with_rule`'s counterpart for `wire_bypassing_the_enable_gate`.
pub(crate) fn rig_with_rule_bypassing_the_enable_gate(
    f: impl FnOnce(&mut AutomationGraph),
) -> (Arc<AutomationEngine>, Arc<FakeHost>, Arc<dyn EngineHost>) {
    let mut rule = ctx_rule("au-1");
    f(&mut rule.graph);
    wire_bypassing_the_enable_gate(vec![rule])
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

/// **A schedule rule (plan 032 §3.1, §6.3): no monitor, no parse, no cond — it reads NOTHING.**
///
/// The `DailyAt` timer is what makes this a rule rather than a rule with holes in it, and `action`
/// stays required, so what it would eventually send is spelled out like any other rule's.
///
/// Targeting is untouched on purpose: §3.1 keeps `target_mode`/`criterion` as the rule's own
/// columns, so a schedule rule still watches terminals — which is exactly what makes "it is walked
/// by the tick and still does nothing" a thing that can be tested.
pub(crate) fn schedule_only_rule(id: &str) -> AutomationRule {
    let mut rule = ctx_rule(id);
    rule.graph.monitor = None;
    rule.graph.parse = None;
    rule.graph.cond = None;
    rule.graph.timer = Some(TimerStep {
        mode: TimerMode::DailyAt { minute_of_day: 9 * 60, days: 0b0001_1111 },
    });
    rule.graph.action.message = "stand-up notes?".into();
    rule
}

/// A presence rule: `find` is looked for as text and there is no threshold at all.
pub(crate) fn presence_rule(id: &str, find: &str, message: &str, sort_order: i64) -> AutomationRule {
    let mut rule = ctx_rule_saying(id, message, sort_order);
    rule.graph.parse_mut().find = find.into();
    rule.graph.parse_mut().keep = Keep::Whole;
    rule.graph.cond = Some(CondStep { finds: Finds::Event, ..Default::default() });
    rule
}

/// Every log row as `(kind, detail, terminal_name)`.
///
/// The name is in the tuple deliberately: R17 and §2.8 are entirely about that column, and an oracle
/// reading only `(kind, detail)` let a `terminal_name = NULL` on the one row the column exists for
/// pass as correct.
pub(crate) fn log_rows(store: &AutomationStore) -> Vec<(String, String, Option<String>)> {
    store
        .load_automation_log(&LogScope::All, LogOrder::Asc, 100)
        .unwrap()
        .into_iter()
        .map(|e| (format!("{:?}", e.kind), e.detail, e.terminal_name))
        .collect()
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

/// Which processes received one particular message, sorted.
///
/// `times_sent` counts and `written_to` lists ids — neither can say *this* message reached *these*
/// terminals, which is the whole claim of a rule that fires on several targets at once. A count of
/// three is satisfied by three messages into one terminal.
pub(crate) fn sent_to(fake: &FakeHost, message: &str) -> Vec<String> {
    let mut out: Vec<String> = fake
        .writes
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, bytes)| String::from_utf8_lossy(bytes).contains(message))
        .map(|(pc, _)| pc.clone())
        .collect();
    out.sort();
    out
}

/// A Rust source file with its line comments removed and its line endings normalised. **Every
/// source-derived test in this feature reads through this** — including `dry.rs`'s "this module
/// cannot send" scan and `automation_commands.rs`'s lenient-resolver scan, which each carried a
/// hand-rolled copy of exactly this filter until the claim was checked.
///
/// Two reasons. `core.autocrlf` is on with no `.gitattributes`, so the file git checks out is not
/// the file a worktree rewrote — a needle
/// containing a newline misses on one machine and hits on the other. And **a comment is prose about
/// the code, which a needle cannot tell from the code**: for a positive `contains` that is a false
/// PASS, and for a negative one a false failure. The source test guarding `tauri::async_runtime::spawn`
/// searched for `"tauri::async_runtime::"` in the text preceding the call — and the text preceding the
/// call was the comment explaining why it had to be `tauri::async_runtime::spawn`, so mutating the call
/// to `tokio::spawn` left the test green while the app no longer started. *(That test is now anchored
/// with `ends_with`, which is what actually kills the mutant; stripping is what the tests forced to use
/// `contains` need.)*
pub(crate) fn strip_comments(source: &str) -> String {
    source
        .replace("\r\n", "\n")
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}
