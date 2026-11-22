use super::*;
use crate::{
    commands::ssh_session::{open_core, reconnect_core},
    pty_manager::input_gate::InputDispatch,
    ssh::{
        auth::BoxFuture,
        known_hosts::KnownHosts,
        session::{Dependencies, NativeAgent, NativeStreams, SessionError, SessionTarget, TargetSource},
        tests::{Capture, Secrets},
    },
    state::{Completion, CreateMode, EndKind, PageRegistration, PaneReply, PaneResult, ShellStage, StagedShell},
};
use serde_json::{json, Value};
use std::sync::Arc;

const LEAF: &str = "tm-launch";
const CONNECTION: &str = "saved-id";
const NONCE: &str = "0123456789abcdef0123456789abcdef";
const A: &str = "source";
const B: &str = "target";

struct PendingTarget;
impl TargetSource for PendingTarget {
    fn resolve<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<SessionTarget, SessionError>> {
        Box::pin(std::future::pending())
    }
}

struct Fixture {
    keys: HostKeys,
    sessions: Arc<SessionRegistry>,
    launches: LaunchRegistry,
    bytes: Mutex<Vec<u8>>,
}

impl Fixture {
    fn new() -> Self {
        Self {
            keys: HostKeys::default(),
            sessions: Arc::new(SessionRegistry::new(Dependencies {
                targets: Arc::new(PendingTarget),
                streams: Arc::new(NativeStreams),
                agents: Arc::new(NativeAgent),
                secrets: Arc::new(Secrets::default()),
                events: Arc::new(Capture::default()),
                known_hosts: KnownHosts { path: Default::default() },
                home: Default::default(),
            })),
            launches: LaunchRegistry::default(),
            bytes: Mutex::new(Vec::new()),
        }
    }

    fn page(&self, window: &str) -> PaneIdentity {
        self.keys.reserve_window(window).unwrap().commit().unwrap();
        let PageRegistration::Registered { pg, .. } = self.keys.register_page(window).unwrap()
        else { panic!("registered page") };
        let pi = PaneIdentity { pg, seq: 1 };
        assert_eq!(self.op(window, pi, 1, json!({"kind":"enter","panes":[pane(pi)]})), PaneResult::Ok);
        pi
    }

    fn op(&self, window: &str, pi: PaneIdentity, seq: u64, op: Value) -> PaneResult {
        let request = serde_json::from_value(json!({"pg": pi.pg, "seq": seq, "op": op})).unwrap();
        let (reply, effects) = self.keys.pane_op(window, request).unwrap();
        for (leaf, receipt) in effects.ssh_retired {
            self.sessions.retire_owner(&leaf, receipt);
        }
        let PaneReply::Ack { result } = reply else { panic!("ack") };
        result
    }

    fn admit(&self, window: &str, pi: PaneIdentity, seq: u64, mode: CreateMode) -> u64 {
        let mode = if mode == CreateMode::Mount { "Mount" } else { "Restart" };
        let PaneResult::Create { cg } = self.op(window, pi, seq, json!({"kind":"admit_create","pi":pi,"mode":mode}))
        else { panic!("fresh placement") };
        assert!(matches!(self.keys.admitted_work(window, pi.pg, LEAF, cg).unwrap(), crate::state::CreateAdmission::Run(id) if id == cg));
        cg
    }

    fn place(&self, cg: u64, process: &str, prepared: bool) {
        self.keys.stage_shell(LEAF, cg, process, None).unwrap();
        if prepared {
            self.keys.register_tagged_ssh_prompt(process, cg, NONCE, Some(CONNECTION)).unwrap();
        }
        let stage = StagedShell { process: process.into(), stage: ShellStage::Local };
        assert!(matches!(self.keys.complete_shell(LEAF, cg, &stage), Completion::Registered));
    }

    fn access(&self, window: &str, attempt: &LaunchAttemptRef, op: Operation<'_>) -> Result<LaunchSnapshot, LaunchError> {
        self.launches.access(&self.keys, &self.sessions, window, LEAF, attempt.clone(), op)
    }

    fn register(&self, window: &str, attempt: &LaunchAttemptRef) -> LaunchSnapshot {
        self.access(window, attempt, Operation::Launch(CONNECTION)).unwrap()
    }

    fn open(&self, pi: PaneIdentity, process: &str) -> LaunchAttemptRef {
        reference(pi, process, &open_core(&self.keys, &self.sessions, LEAF, CONNECTION).unwrap())
    }

    fn reconnect(&self, pi: PaneIdentity, process: &str) -> LaunchAttemptRef {
        reference(pi, process, &reconnect_core(&self.keys, &self.sessions, LEAF).unwrap())
    }

    fn locked_and_untouched(&self, process: &str) {
        assert_eq!(self.keys.ssh_prompt_input_generation(process), Some(0));
        assert_eq!(self.record_input(process), Err(Refusal::InputLocked));
        assert!(self.bytes.lock().is_empty());
    }

    fn record_input(&self, process: &str) -> Result<(), Refusal> {
        self.keys.admit_input(process, None, |_| {
            self.bytes.lock().extend_from_slice(b"probe\r");
            Ok(InputDispatch::Complete(()))
        })
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        tauri::async_runtime::block_on(self.sessions.shutdown());
    }
}
fn pane(pi: PaneIdentity) -> Value {
    json!({"pi":pi,"paneId":"pn-launch","leaf":LEAF,"restore":false})
}
fn reference(pi: PaneIdentity, process: &str, view: &SessionView) -> LaunchAttemptRef {
    LaunchAttemptRef {
        session_generation: view.generation,
        attempt_receipt: view.into(),
        process_incarnation: process.into(),
        owner_incarnation: pi,
    }
}

#[test]
fn delayed_old_launch_cannot_join_successor_attempt() {
    let f = Fixture::new();
    let pi = f.page(A);
    f.place(f.admit(A, pi, 2, CreateMode::Mount), "pc-a", true);
    let first = f.open(pi, "pc-a");
    let first_snapshot = f.register(A, &first);
    let second = f.reconnect(pi, "pc-a");
    let successor = f.register(A, &second);
    assert!(successor.launch_seq > first_snapshot.launch_seq);
    assert_eq!(f.access(A, &first, Operation::Launch(CONNECTION)), Err(LaunchErrorCode::StaleAttempt.into()));
    assert_eq!(f.access(A, &second, Operation::Query), Ok(successor));
    f.locked_and_untouched("pc-a");
}

#[test]
fn delayed_old_cancel_cannot_cancel_successor_attempt() {
    let f = Fixture::new();
    let pi = f.page(A);
    f.place(f.admit(A, pi, 2, CreateMode::Mount), "pc-a", true);
    let first = f.open(pi, "pc-a");
    f.register(A, &first);
    let second = f.reconnect(pi, "pc-a");
    let successor = f.register(A, &second);
    let session = f.sessions.state(LEAF, false).unwrap();
    assert_eq!(f.access(A, &first, Operation::Cancel), Err(LaunchErrorCode::StaleAttempt.into()));
    assert_eq!(f.access(A, &second, Operation::Query), Ok(successor));
    assert_eq!(f.sessions.state(LEAF, false).unwrap(), session);
    f.locked_and_untouched("pc-a");
}

#[test]
fn cross_window_old_owner_launch_cancel_query_are_stale() {
    let f = Fixture::new();
    let source = f.page(A);
    f.place(f.admit(A, source, 2, CreateMode::Mount), "pc-a", true);
    let first = f.open(source, "pc-a");
    let original = f.register(A, &first);
    assert_eq!(f.op(A, source, 3, json!({"kind":"stash","tx":"move","pairs":[pane(source)]})), PaneResult::Ok);
    f.keys.reserve_window(B).unwrap().commit().unwrap();
    let PageRegistration::Registered { pg, .. } = f.keys.register_page(B).unwrap() else { panic!("target") };
    let target = PaneIdentity { pg, seq: 1 };
    assert!(matches!(f.op(B, target, 1, json!({"kind":"take","tx":"move"})), PaneResult::Taken { .. }));
    assert_eq!(f.op(B, target, 2, json!({"kind":"adopt","tx":"move","pairs":[pane(target)]})), PaneResult::Ok);
    let adopted = LaunchAttemptRef { owner_incarnation: target, ..first.clone() };
    let moved = f.access(B, &adopted, Operation::Query).unwrap();
    assert_eq!(moved.stage, original.stage);
    assert_eq!(moved.attempt.session_generation, original.attempt.session_generation);
    assert!(moved.launch_seq > original.launch_seq);
    let successor_ref = f.reconnect(target, "pc-a");
    let successor = f.register(B, &successor_ref);
    let session = f.sessions.state(LEAF, false).unwrap();
    let wrong_owner = LaunchAttemptRef { owner_incarnation: source, ..successor_ref.clone() };
    let input_generation = f.keys.ssh_prompt_input_generation("pc-a");
    for op in [Operation::Launch(CONNECTION), Operation::Cancel, Operation::Query] {
        for (window, old) in [(A, &first), (A, &wrong_owner), (B, &wrong_owner), (A, &successor_ref)] {
            assert_eq!(f.access(window, old, op), Err(LaunchErrorCode::StaleAttempt.into()));
        }
        assert_eq!(f.access(B, &successor_ref, Operation::Query), Ok(successor.clone()));
        assert_eq!(f.sessions.state(LEAF, false).unwrap(), session);
    }
    assert_eq!(f.keys.ssh_prompt_input_generation("pc-a"), input_generation);
    assert_eq!(f.record_input("pc-a"), Err(Refusal::InputLocked));
    assert!(f.bytes.lock().is_empty());
}

#[test]
fn fresh_restart_carries_tag_but_no_stale_ticket() {
    let f = Fixture::new();
    let pi = f.page(A);
    f.place(f.admit(A, pi, 2, CreateMode::Mount), "pc-a", true);
    let first = f.open(pi, "pc-a");
    f.register(A, &first);
    assert!(f.keys.end_process("pc-a", EndKind::Exit, |_| {}).is_some());
    f.sessions.disconnect_generation(LEAF, first.session_generation, "Local shell ended");
    f.place(f.admit(A, pi, 3, CreateMode::Restart), "pc-b", true);
    assert_eq!(f.keys.ssh_launch_connection("pc-a"), None);
    assert_eq!(f.keys.ssh_launch_connection("pc-b").as_deref(), Some(CONNECTION));
    assert!(f.keys.input_lease("pc-b").is_ok(), "no ticket inherited");
    let wrong_process = LaunchAttemptRef { process_incarnation: "pc-b".into(), ..first.clone() };
    assert_eq!(f.access(A, &wrong_process, Operation::Launch(CONNECTION)), Err(LaunchErrorCode::StaleAttempt.into()));
    let second = f.reconnect(pi, "pc-b");
    let fresh = f.register(A, &second);
    let stale_process = LaunchAttemptRef { process_incarnation: "pc-a".into(), ..second.clone() };
    assert_eq!(f.access(A, &stale_process, Operation::Cancel), Err(LaunchErrorCode::StaleAttempt.into()));
    assert_eq!(f.access(A, &second, Operation::Query), Ok(fresh));
    f.locked_and_untouched("pc-b");
}

#[test]
fn launch_cancel_query_from_a_thread_without_a_tokio_runtime_do_not_panic() {
    std::thread::spawn(|| {
        assert!(tokio::runtime::Handle::try_current().is_err());
        let f = Fixture::new();
        let pi = f.page(A);
        f.place(f.admit(A, pi, 2, CreateMode::Mount), "pc-a", true);
        let attempt = f.open(pi, "pc-a");
        let snapshot = f.register(A, &attempt);
        assert_eq!(f.access(A, &attempt, Operation::Query), Ok(snapshot.clone()));
        let cancelled = f.access(A, &attempt, Operation::Cancel).unwrap();
        assert_eq!(cancelled.stage, LaunchStage::Cancelled);
        assert!(cancelled.launch_seq > snapshot.launch_seq);
        assert_eq!(f.access(A, &attempt, Operation::Query), Ok(cancelled));
        assert!(f.bytes.lock().is_empty());
        f.record_input("pc-a").unwrap();
        assert_eq!(f.bytes.lock().as_slice(), b"probe\r");
    }).join().expect("sync launch operations panicked without a Tokio runtime");
}

#[test]
fn join_existing_host_attach_and_strictmode_write_once() {
    use crate::state::{source_scan::{fn_body, production}, CreateAdmission};
    let admitted = production(include_str!("../commands/panes.rs"));
    let create = fn_body(&admitted, "fn create_admitted_terminal(");
    assert!(create.contains("CreateAdmission::Existing(pc) => Ok(pc),"));
    assert!(create.contains("CreateAdmission::Join(waiter) => CreateAdmission::joined("));
    assert_eq!(create.matches("run_create(").count(), 1);
    let legacy = production(include_str!("../commands/terminal.rs"));
    let wrapper = fn_body(&legacy, "fn spawn_routed(");
    assert!(wrapper.contains("Err(existing) => return Ok(existing),"));
    let routed = fn_body(&legacy, "fn run_create(");
    let attach = routed.split("if let Some(pid) = claimed_pid {").nth(1).unwrap()
        .split("return Ok(process_id);").next().unwrap();
    assert!(attach.contains("attach_owned("));
    assert!(!attach.contains("PreparedShell::register(") && !attach.contains("spawn_owned("));
    assert!(!attach.contains("ssh_launches") && !attach.contains("ssh_sessions"));

    let f = Fixture::new();
    let pi = f.page(A);
    let cg = f.admit(A, pi, 2, CreateMode::Mount);
    assert!(matches!(f.keys.admitted_work(A, pi.pg, LEAF, cg).unwrap(), CreateAdmission::Join(_)));
    f.place(cg, "pc-a", true);
    assert!(matches!(f.keys.admitted_work(A, pi.pg, LEAF, cg).unwrap(), CreateAdmission::Existing(pc) if pc == "pc-a"));
    let attempt = f.open(pi, "pc-a");
    assert_eq!(f.access(A, &attempt, Operation::Query), Err(LaunchErrorCode::NotFound.into()));
    let registered = f.register(A, &attempt);
    let ticket = f.launches.0.lock()[LEAF].ticket.clone().unwrap();
    assert_eq!(f.register(A, &attempt), registered);
    // StrictMode retry must not replace the first input ticket either.
    f.keys.cancel_ssh_input(&ticket).expect("first ticket remains current");
    assert!(f.bytes.lock().is_empty(), "T3a does not submit input at all");

    let attached = Fixture::new();
    let pi = attached.page(A);
    attached.place(attached.admit(A, pi, 2, CreateMode::Mount), "pc-attach", false);
    let attempt = attached.open(pi, "pc-attach");
    assert_eq!(attached.access(A, &attempt, Operation::Launch(CONNECTION)), Err(LaunchErrorCode::UnsupportedContext.into()));
    assert!(attached.keys.input_lease("pc-attach").is_ok());
    assert!(attached.bytes.lock().is_empty());
}

#[test]
fn attempt_receipt_copies_the_reason_code_with_the_reason() {
    let f = Fixture::new();
    let pi = f.page(A);
    f.place(f.admit(A, pi, 2, CreateMode::Mount), "pc-a", true);
    let mut value = serde_json::to_value(open_core(&f.keys, &f.sessions, LEAF, CONNECTION).unwrap()).unwrap();
    value["reason"] = json!("Host key verification failed");
    value["errorCode"] = json!("host-key-changed");
    let view: SessionView = serde_json::from_value(value).unwrap();
    let receipt = AttemptReceipt::from(&view);
    assert_eq!(receipt.reason.as_deref(), Some("Host key verification failed"));
    assert_eq!(receipt.error_code.as_deref(), Some("host-key-changed"));
    let wire = serde_json::to_value(&receipt).unwrap();
    assert_eq!(wire["errorCode"], "host-key-changed");
    assert_eq!(serde_json::from_value::<AttemptReceipt>(wire).unwrap(), receipt);
}

#[test]
fn launch_receipt_uses_authoritative_067_fields() {
    let f = Fixture::new();
    let pi = f.page(A);
    f.place(f.admit(A, pi, 2, CreateMode::Mount), "pc-a", true);
    let mut request = f.open(pi, "pc-a");
    request.attempt_receipt.gate = Gate::Verified;
    request.attempt_receipt.known_hosts_paths = Some(KnownHostsPaths { target: "forged".into(), jump: None });
    let snapshot = f.register(A, &request);
    assert_eq!(snapshot.attempt.attempt_receipt.gate, Gate::Pending);
    assert_eq!(snapshot.attempt.attempt_receipt.known_hosts_paths, None);
    f.locked_and_untouched("pc-a");
}
