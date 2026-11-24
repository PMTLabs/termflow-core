use super::*;
use crate::elevated_host::HostChannel;
use crate::state::{
    Completion, CreateAdmission, CreateMode, HostKeys, ShellStage, StageMode, StagedShell,
};
use std::io::Write;
use std::sync::{mpsc, Barrier};
use std::time::Duration;
use termflow_pty_protocol::{read_frame, Control, Data, Frame};

const PC: &str = "pc-input";
const LEAF: &str = "tm-input";
const KEY: &str = "input-session";
const BOUND: Duration = Duration::from_secs(5);
const LAUNCH: &[u8] = b"literal-ssh-command\r";
const SOURCES: &[(&str, InputSource)] = &[
    ("commands/terminal.rs:write_terminal", InputSource::Renderer),
    (
        "api_server/terminals/mod.rs:write_data_to_terminal",
        InputSource::Rest,
    ),
    (
        "api_server/ws.rs:handle_socket terminal:input",
        InputSource::WebSocket,
    ),
    (
        "automation/send.rs:write_leased (engine, exec/probe, batch, fleet)",
        InputSource::Automation,
    ),
];

struct Recording(Arc<Mutex<Vec<Vec<u8>>>>);
impl Write for Recording {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().push(bytes.into());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
struct Backend {
    keys: HostKeys,
    local: Option<LocalWriter>,
    recorded: Arc<Mutex<Vec<Vec<u8>>>>,
    client: Option<crate::pty_host_client::PtyHostClient>,
}
impl InputBackend for Backend {
    fn input_keys(&self) -> &HostKeys {
        &self.keys
    }
    fn local_writer(&self, _: &str) -> Option<LocalWriter> {
        self.local.clone()
    }
    fn hosted(&self, _: &str) -> bool {
        self.client.is_some()
    }
    fn enqueue_hosted(&self, permit: &InputPermit<'_>, bytes: &[u8]) -> bool {
        self.client.as_ref().is_some_and(|c| {
            c.write_registered_admitted(&self.keys, permit, HostChannel::Primary, KEY, bytes)
        })
    }
}
impl Backend {
    fn new(hosted: bool) -> (Arc<Self>, Option<tokio::io::DuplexStream>) {
        let keys = HostKeys::default();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let (client, peer) = if hosted {
            let (client, peer, _) = crate::pty_host_client::conn_tests::wired();
            client.bind_sessions(&keys, HostChannel::Primary, 1);
            (Some(client), Some(peer))
        } else {
            (None, None)
        };
        let local = (!hosted).then(|| {
            Arc::new(std::sync::Mutex::new(
                Box::new(Recording(recorded.clone())) as Box<dyn Write + Send>
            ))
        });
        let CreateAdmission::Run(cg) = keys.admit_create(LEAF, CreateMode::Mount).unwrap() else {
            panic!("fresh process")
        };
        let hosted_stage = hosted.then_some((HostChannel::Primary, KEY, StageMode::Spawn));
        let (stage, _, _) = keys.stage_shell(LEAF, cg, PC, hosted_stage).unwrap();
        if let Some(stage) = &stage {
            assert!(keys.publish(stage, PC, 1));
        }
        let shell = StagedShell {
            process: PC.into(),
            stage: stage.map_or(ShellStage::Local, ShellStage::Hosted),
        };
        assert!(matches!(
            keys.complete_shell(LEAF, cg, &shell),
            Completion::Registered
        ));
        (
            Arc::new(Self {
                keys,
                local,
                recorded,
                client,
            }),
            peer,
        )
    }
    fn enqueue<'io>(&'io self, permit: &InputPermit<'_>, bytes: &'io [u8]) -> Result<InputDispatch<'io, (), String>, String> {
        if self.enqueue_hosted(permit, bytes) {
            return Ok(InputDispatch::Complete(()));
        }
        if self.hosted(permit.process()) {
            return Err("host refused".into());
        }
        Ok(InputDispatch::local(move || {
            self.local.as_ref().unwrap().lock().unwrap().write_all(bytes)
                .map_err(|e| e.to_string())
        }))
    }
    async fn bytes(&self, peer: &mut Option<tokio::io::DuplexStream>) -> Vec<Vec<u8>> {
        let Some(peer) = peer else {
            return self.recorded.lock().clone();
        };
        // A FIFO fence, not a timeout/sleep-based assertion that no bytes arrived.
        assert!(self.client.as_ref().unwrap().resize("test-fence", 1, 1));
        let mut bytes = Vec::new();
        loop {
            let frame = tokio::time::timeout(BOUND, read_frame(peer))
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            match frame {
                Frame::Data(Data::Stdin {
                    tab_id,
                    bytes: data,
                }) => {
                    assert_eq!(tab_id, KEY);
                    bytes.push(data);
                }
                Frame::Ctrl(Control::Resize { tab_id, .. }) if tab_id == "test-fence" => break,
                Frame::Ctrl(Control::Close { tab_id, .. }) if tab_id == KEY => {}
                frame => panic!("unexpected fixture frame: {frame:?}"),
            }
        }
        bytes
    }
    fn ready(&self) -> ReadyEpoch {
        self.keys
            .observe_uninstrumented_test_prompt(PC, &termflow_pty_protocol::da1::StartupDrain::default())
            .unwrap()
    }
}

// A short bounded negative observation, never a sleep used to order work.
const STILL_WAITING: Duration = Duration::from_millis(100);

struct BlockFirstWrite {
    entered: Option<mpsc::Sender<()>>,
    release: mpsc::Receiver<bool>,
    recorded: Arc<Mutex<Vec<Vec<u8>>>>,
}
impl Write for BlockFirstWrite {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if let Some(entered) = self.entered.take() {
            entered.send(()).unwrap();
            if self.release.recv() != Ok(true) {
                return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "child closed"));
            }
        }
        self.recorded.lock().push(bytes.into());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

fn staged_local(keys: &HostKeys, leaf: &str, process: &str) -> u64 {
    let CreateAdmission::Run(cg) = keys.admit_create(leaf, CreateMode::Mount).unwrap() else {
        panic!("expected fresh placement");
    };
    keys.stage_shell(leaf, cg, process, None).unwrap();
    assert!(matches!(keys.complete_shell(leaf, cg, &StagedShell {
        process: process.into(), stage: ShellStage::Local,
    }), Completion::Registered));
    cg
}

fn blocked_local() -> (Arc<Backend>, mpsc::Sender<bool>, std::thread::JoinHandle<Result<(), WriteFailure>>) {
    let keys = HostKeys::default();
    staged_local(&keys, LEAF, PC);
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let (entered, inside) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let writer: LocalWriter = Arc::new(std::sync::Mutex::new(Box::new(BlockFirstWrite {
        entered: Some(entered), release: gate, recorded: recorded.clone(),
    })));
    let backend = Arc::new(Backend { keys, local: Some(writer), recorded, client: None });
    let a = backend.clone();
    let work = std::thread::spawn(move || write_input(&*a, PC, InputSource::Renderer, None, b"first"));
    inside.recv_timeout(BOUND).unwrap();
    (backend, release, work)
}

#[test]
fn blocked_local_write_never_blocks_owner_changes_or_other_terminals() {
    use crate::state::{CloseAction, CloseStorage, EndKind};

    let (backend, release, first) = blocked_local();
    let (progress, observed) = mpsc::channel();
    let close = std::thread::spawn({
        let backend = backend.clone();
        move || {
            // These effects determine whether AppState is allowed to kill the child.
            assert!(matches!(backend.keys.close_process(PC, CloseStorage::Preserve), CloseAction::End { .. }));
            assert!(backend.keys.end_process(PC, EndKind::Close(CloseStorage::Preserve), |_| {}).is_some());
            progress.send("A closed").unwrap();
        }
    });
    assert_eq!(observed.recv_timeout(BOUND).unwrap(), "A closed");
    release.send(false).unwrap(); // model the kill breaking the in-flight WriteFile
    let err = first.join().unwrap().unwrap_err();
    assert_eq!(err.kind, FailureKind::Write);
    assert_eq!(err.message, "child closed");
    assert!(backend.recorded.lock().is_empty());
    close.join().unwrap();

    let (backend, release, first) = blocked_local();
    let (selected, reserved) = mpsc::channel();
    let (entered, writing) = mpsc::channel();
    let second = std::thread::spawn({
        let backend = backend.clone();
        move || {
            let writer = backend.local.as_ref().unwrap().clone();
            backend.keys.admit_input(PC, None, |_| {
                selected.send(()).unwrap();
                Ok(InputDispatch::local(move || {
                    entered.send(()).unwrap(); // witness before acquiring the actual writer mutex
                    writer.lock().unwrap().write_all(b"second")
                }))
            })
        }
    });
    reserved.recv_timeout(BOUND).unwrap();
    let (progress, observed) = mpsc::channel();
    let other = std::thread::spawn({
        let backend = backend.clone();
        move || {
            const B: &str = "pc-unrelated-input";
            staged_local(&backend.keys, "tm-unrelated-input", B);
            progress.send(("B created", Vec::new())).unwrap();
            let recorded = Arc::new(Mutex::new(Vec::new()));
            let mut writer = Recording(recorded.clone());
            backend.keys.admit_input(B, None, |_| Ok(InputDispatch::local(move || writer.write_all(b"B input")))).unwrap();
            let bytes = recorded.lock().clone();
            progress.send(("B wrote", bytes)).unwrap();
        }
    });
    assert_eq!(observed.recv_timeout(BOUND).unwrap(), ("B created", vec![]));
    assert_eq!(observed.recv_timeout(BOUND).unwrap(), ("B wrote", vec![b"B input".to_vec()]));
    assert_eq!(writing.recv_timeout(STILL_WAITING), Err(mpsc::RecvTimeoutError::Timeout));
    release.send(true).unwrap();
    writing.recv_timeout(BOUND).unwrap();
    first.join().unwrap().unwrap();
    second.join().unwrap().unwrap();
    other.join().unwrap();
    assert_eq!(*backend.recorded.lock(), [b"first".to_vec(), b"second".to_vec()]);

    let (backend, release, first) = blocked_local();
    let (selected, reserved) = mpsc::channel();
    let (takeover, ticket) = (backend.clone(), backend.keys.prepare_ssh_input(PC).unwrap());
    let ready = backend.ready(); // fresh observation while the preceding write is still in flight
    let launch = std::thread::spawn({
        let backend = backend.clone();
        move || backend.keys.submit_ssh_input(&ticket, &ready, |p| {
            selected.send(()).unwrap();
            backend.enqueue(p, LAUNCH)
        })
    });
    reserved.recv_timeout(BOUND).unwrap();
    let (selected, revoked) = mpsc::channel();
    let human = std::thread::spawn(move || takeover.keys.takeover_input(PC, |p| {
        selected.send(()).unwrap(); // the takeover has already revoked the queued launch
        takeover.enqueue(p, b"human")
    }));
    revoked.recv_timeout(BOUND).unwrap();
    release.send(true).unwrap();
    first.join().unwrap().unwrap();
    assert_eq!(launch.join().unwrap(), Err(Refusal::StaleAttempt.to_string()));
    human.join().unwrap().unwrap();
    assert_eq!(*backend.recorded.lock(), [b"first".to_vec(), b"human".to_vec()]);
}

#[test]
fn prompt_observed_under_lock_contention_is_not_lost() {
    use super::super::ssh_shell::filter_local_output;
    use termflow_pty_protocol::{da1::StartupDrain, ssh_prompt::PromptParser};

    fn during_contention<T: Send + 'static, G>(held: G, read: impl FnOnce() -> T + Send + 'static) -> T {
        let (starting, started) = mpsc::sync_channel(0);
        let (done, result) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            starting.send(()).unwrap();
            let _ = done.send(read());
        });
        started.recv_timeout(BOUND).unwrap();
        let early = result.recv_timeout(STILL_WAITING);
        drop(held);
        assert!(matches!(early, Err(mpsc::RecvTimeoutError::Timeout)), "prompt lookup must wait for metadata, not drop it");
        let value = result.recv_timeout(BOUND).unwrap();
        worker.join().unwrap();
        value
    }

    let keys = HostKeys::default();
    let cg = staged_local(&keys, LEAF, PC);
    let nonce = "0123456789abcdef0123456789abcdef";
    keys.register_ssh_prompt(PC, cg, nonce).unwrap();
    let entry = keys.input.processes.lock().get(PC).unwrap().clone();
    let actual_nonce = during_contention(entry.lock(), {
        let keys = keys.clone();
        move || keys.ssh_prompt_nonce(PC)
    });
    assert_eq!(actual_nonce.as_deref(), Some(nonce));
    let mut parser = Some(PromptParser::new(actual_nonce.unwrap()));
    for (seq, lock) in [(1, "map"), (2, "ownership"), (3, "entry")] {
        let feed = {
            let keys = keys.clone();
            move || {
                let drain = StartupDrain::default();
                let marker = format!("\x1b]633;TermFlowSshReady;{nonce};{seq}\x07").into_bytes();
                let mut count = 0;
                let visible = filter_local_output(&mut parser, &keys, PC, Some(&drain), marker.clone(), |_| count += 1);
                assert!(visible.is_empty());
                assert_eq!(count, 1);
                assert!(filter_local_output(&mut parser, &keys, PC, Some(&drain), marker, |_| count += 1).is_empty());
                assert_eq!(count, 1);
                parser
            }
        };
        parser = match lock {
            "map" => during_contention(keys.input.processes.lock(), feed),
            "ownership" => during_contention(keys.input_owner_change(), feed),
            _ => during_contention(entry.lock(), feed),
        };
    }

    // Also exercise the observer's own locks, independent of the pre-parse snapshot.
    let stamp = keys.ssh_prompt_input_generation(PC).unwrap();
    for (seq, lock) in [(4, "map"), (5, "entry")] {
        let observe = {
            let keys = keys.clone();
            move || keys.observe_shell_prompt(PC, nonce, seq, super::super::ssh_shell::PromptProof::Local {
                drain: &StartupDrain::default(), input_generation: stamp,
            })
        };
        let ready = if lock == "map" {
            during_contention(keys.input.processes.lock(), observe)
        } else {
            during_contention(entry.lock(), observe)
        };
        assert!(ready.is_ok());
    }
}

fn delayed_launch(
    backend: Arc<Backend>,
    ticket: LaunchTicket,
    ready: ReadyEpoch,
) -> (Arc<Barrier>, std::thread::JoinHandle<Result<(), String>>) {
    let barrier = Arc::new(Barrier::new(2));
    let worker = std::thread::spawn({
        let barrier = barrier.clone();
        move || {
            barrier.wait();
            backend
                .keys
                .submit_ssh_input(&ticket, &ready, |p| backend.enqueue(p, LAUNCH))
        }
    });
    (barrier, worker)
}

fn page(keys: &HostKeys, label: &str) -> u64 {
    let window = keys.reserve_window(label).unwrap();
    window.commit().unwrap();
    let crate::state::PageRegistration::Registered { pg, .. } = keys.register_page(label).unwrap()
    else {
        panic!("registered page")
    };
    pg
}
fn pane_op(keys: &HostKeys, label: &str, pg: u64, seq: u64, op: serde_json::Value) {
    let request =
        serde_json::from_value(serde_json::json!({ "pg": pg, "seq": seq, "op": op })).unwrap();
    let (reply, _) = keys.pane_op(label, request).unwrap();
    assert!(
        matches!(
            reply,
            crate::state::PaneReply::Ack {
                result: crate::state::PaneResult::Ok
            }
        ),
        "{reply:?}"
    );
}
fn transfer(keys: &HostKeys) {
    let pg = page(keys, "input-source");
    let entry =
        serde_json::json!({ "paneId": "pn-input", "leaf": LEAF, "pi": { "pg": pg, "seq": 1 } });
    pane_op(
        keys,
        "input-source",
        pg,
        1,
        serde_json::json!({ "kind": "enter", "panes": [entry.clone()] }),
    );
    pane_op(
        keys,
        "input-source",
        pg,
        2,
        serde_json::json!({ "kind": "bind", "pi": { "pg": pg, "seq": 1 }, "pc": PC, "via": "reconcile" }),
    );
    pane_op(
        keys,
        "input-source",
        pg,
        3,
        serde_json::json!({ "kind": "stash", "tx": "input-transfer", "pairs": [entry] }),
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_input_sink_serializes_takeover_submit_and_transfer() {
    for &(sink, source) in SOURCES {
        for hosted in [false, true] {
            // Ordinary controls execute the exact shared production dispatcher and its distinct
            // route/flush/error policy. Hosted bytes traverse the real framed FIFO client.
            let (backend, mut peer) = Backend::new(hosted);
            write_input(&*backend, PC, source, None, b"ordinary \0\x1b\r").unwrap();
            assert_eq!(
                backend.bytes(&mut peer).await,
                [b"ordinary \0\x1b\r".to_vec()],
                "{sink} hosted={hosted}"
            );
            let ticket = backend.keys.prepare_ssh_input(PC).unwrap();
            assert_eq!(
                write_input(&*backend, PC, source, None, b"forbidden")
                    .unwrap_err()
                    .kind,
                FailureKind::Locked,
                "{sink}"
            );
            let ready = backend.ready();
            let barrier = Arc::new(Barrier::new(2));
            let worker = std::thread::spawn({
                let backend = backend.clone();
                let barrier = barrier.clone();
                move || {
                    barrier.wait();
                    backend
                        .keys
                        .submit_ssh_input(&ticket, &ready, |p| backend.enqueue(p, LAUNCH))
                }
            });
            backend
                .keys
                .takeover_input(PC, |p| backend.enqueue(p, b"human takeover"))
                .unwrap();
            barrier.wait();
            assert!(
                worker
                    .join()
                    .unwrap()
                    .unwrap_err()
                    .starts_with("StaleAttempt:"),
                "{sink}"
            );
            let mut expected = vec![b"human takeover".to_vec()];
            if !hosted {
                expected.insert(0, b"ordinary \0\x1b\r".to_vec());
            }
            assert_eq!(
                backend.bytes(&mut peer).await,
                expected,
                "zero SSH bytes after takeover: {sink}"
            );

            // A competing write cannot interleave bytes with command+Enter enqueue.
            let (backend, mut peer) = Backend::new(hosted);
            let ticket = backend.keys.prepare_ssh_input(PC).unwrap();
            let ready = backend.ready();
            let (inside_tx, inside_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let worker = std::thread::spawn({
                let backend = backend.clone();
                let ticket = ticket.clone();
                let ready = ready.clone();
                move || {
                    backend.keys.submit_ssh_input(&ticket, &ready, |p| {
                        inside_tx.send(()).unwrap();
                        release_rx.recv_timeout(BOUND).unwrap();
                        backend.enqueue(p, LAUNCH)
                    })
                }
            });
            inside_rx.recv_timeout(BOUND).unwrap();
            let process = backend.keys.input.processes.lock().get(PC).unwrap().clone();
            assert!(
                process.try_lock().is_none(),
                "FIFO reservation/hosted enqueue must retain admission: {sink}"
            );
            assert!(
                backend.keys.input.ownership.try_write().is_none(),
                "transfer/replacement must wait for enqueue: {sink}"
            );
            let (start_tx, start_rx) = mpsc::channel();
            let competitor = std::thread::spawn({
                let backend = backend.clone();
                move || {
                    start_tx.send(()).unwrap();
                    write_input(&*backend, PC, source, None, b"competing")
                }
            });
            start_rx.recv_timeout(BOUND).unwrap();
            release_tx.send(()).unwrap();
            worker.join().unwrap().unwrap();
            competitor.join().unwrap().unwrap();
            assert!(backend
                .keys
                .submit_ssh_input(&ticket, &ready, |p| backend.enqueue(p, LAUNCH))
                .is_err());
            assert_eq!(
                backend.bytes(&mut peer).await,
                [LAUNCH.to_vec(), b"competing".to_vec()],
                "exactly once: {sink}"
            );

            // A real pane stream stash changes owner identity before the final check.
            let (backend, mut peer) = Backend::new(hosted);
            let ticket = backend.keys.prepare_ssh_input(PC).unwrap();
            let ready = backend.ready();
            let (barrier, delayed) = delayed_launch(backend.clone(), ticket, ready);
            transfer(&backend.keys);
            barrier.wait();
            assert!(delayed
                .join()
                .unwrap()
                .unwrap_err()
                .starts_with("StaleAttempt:"));
            assert!(
                backend.bytes(&mut peer).await.is_empty(),
                "transfer fence: {sink}"
            );

            // Close and a replacement process never retarget a captured old process ticket.
            let (backend, mut peer) = Backend::new(hosted);
            let ticket = backend.keys.prepare_ssh_input(PC).unwrap();
            let ready = backend.ready();
            let (barrier, delayed) = delayed_launch(backend.clone(), ticket, ready);
            backend
                .keys
                .close_process(PC, crate::state::CloseStorage::Preserve);
            backend
                .keys
                .end_process(
                    PC,
                    crate::state::EndKind::Close(crate::state::CloseStorage::Preserve),
                    |_| {},
                )
                .unwrap();
            let CreateAdmission::Run(cg) =
                backend.keys.admit_create(LEAF, CreateMode::Mount).unwrap()
            else {
                panic!("replacement admission")
            };
            backend
                .keys
                .stage_shell(LEAF, cg, "pc-successor", None)
                .unwrap();
            backend.keys.complete_shell(
                LEAF,
                cg,
                &StagedShell {
                    process: "pc-successor".into(),
                    stage: ShellStage::Local,
                },
            );
            barrier.wait();
            assert!(delayed
                .join()
                .unwrap()
                .unwrap_err()
                .starts_with("StaleAttempt:"));
            assert!(
                backend.bytes(&mut peer).await.is_empty(),
                "process replacement: {sink}"
            );
        }
    }
}

struct LegacyWriter {
    flushes: Arc<std::sync::atomic::AtomicUsize>,
    fail_write: bool,
}
impl Write for LegacyWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.fail_write {
            return Err(std::io::Error::other("legacy write error"));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.flushes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(std::io::Error::other("legacy ignored flush error"))
    }
}
#[test]
fn ordinary_input_bytes_flush_and_errors_are_unchanged() {
    for &(_, source) in SOURCES {
        let (mut backend, _) = Backend::new(false);
        let flushes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        Arc::get_mut(&mut backend).unwrap().local =
            Some(Arc::new(std::sync::Mutex::new(Box::new(LegacyWriter {
                flushes: flushes.clone(),
                fail_write: false,
            }))));
        write_input(&*backend, PC, source, None, b"ordinary").unwrap();
        assert_eq!(
            flushes.load(std::sync::atomic::Ordering::SeqCst),
            usize::from(matches!(source, InputSource::Automation))
        );
        Arc::get_mut(&mut backend).unwrap().local =
            Some(Arc::new(std::sync::Mutex::new(Box::new(LegacyWriter {
                flushes,
                fail_write: true,
            }))));
        let error = write_input(&*backend, PC, source, None, b"ordinary").unwrap_err();
        assert_eq!(error.message, "legacy write error");
        assert_eq!(error.kind, FailureKind::Write);
        Arc::get_mut(&mut backend).unwrap().local = None;
        let error = write_input(&*backend, PC, source, None, b"ordinary").unwrap_err();
        let legacy_missing = match source {
            InputSource::Renderer | InputSource::Rest => "Terminal not found",
            InputSource::WebSocket => "terminal not found",
            InputSource::Automation => "terminal pc-input has no writer",
        };
        assert_eq!(error.message, legacy_missing);
        assert_eq!(error.kind, FailureKind::Missing);
    }
}

struct LeasedPort(Arc<Backend>, Arc<tokio::sync::Notify>);
impl crate::automation::send::TerminalWriter for LeasedPort {
    fn write(&self, pc: &str, bytes: &[u8]) -> Result<(), String> {
        self.write_leased(pc, bytes, None)
    }
    fn input_lease(&self, pc: &str) -> Result<Option<InputLease>, String> {
        self.0.keys.input_lease(pc).map(Some).map_err(Into::into)
    }
    fn write_leased(
        &self,
        pc: &str,
        bytes: &[u8],
        lease: Option<&InputLease>,
    ) -> Result<(), String> {
        write_input(&*self.0, pc, InputSource::Automation, lease, bytes).map_err(|e| e.message)?;
        if bytes.starts_with(b"\x1b[200~") {
            self.1.notify_one();
        }
        Ok(())
    }
}
#[tokio::test(start_paused = true)]
async fn delayed_automation_submit_cannot_cross_launch_lease() {
    use crate::automation::send::{deliver, SubmitPattern};
    for hosted in [false, true] {
        let (backend, mut peer) = Backend::new(hosted);
        let pasted = Arc::new(tokio::sync::Notify::new());
        let port = LeasedPort(backend.clone(), pasted.clone());
        let task = tokio::spawn(async move {
            deliver(
                &port,
                PC,
                "custom",
                SubmitPattern {
                    separator: "separator",
                    end_indicator: "\r",
                },
                "queued message",
                true,
            )
            .await
        });
        // Notify is emitted by the actual paste write, not a guessed delay or a sleep.
        pasted.notified().await;
        let ticket = backend.keys.prepare_ssh_input(PC).unwrap();
        let ready = backend.ready();
        backend.keys.submit_ssh_input(&ticket, &ready, |p| backend.enqueue(p, LAUNCH)).unwrap();
        tokio::time::advance(Duration::from_millis(
            crate::automation::send::PASTE_SUBMIT_GAP_MS,
        ))
        .await;
        assert!(task
            .await
            .unwrap()
            .unwrap_err()
            .starts_with("StaleAttempt:"));
        assert_eq!(
            backend.bytes(&mut peer).await,
            [b"\x1b[200~queued message\x1b[201~".to_vec(), LAUNCH.to_vec()]
        );
        backend.keys.cancel_ssh_input(&ticket).unwrap();
        write_input(
            &*backend,
            PC,
            InputSource::Automation,
            None,
            b"positive unlocked",
        )
        .unwrap();
        let bytes = backend.bytes(&mut peer).await;
        assert_eq!(bytes.last().unwrap(), b"positive unlocked");
    }
}

#[test]
fn startup_replies_drain_before_ready() {
    use termflow_pty_protocol::da1::{StartupReplies, StartupReply, DA1_REPLY};
    let keys = HostKeys::default();
    let CreateAdmission::Run(cg) = keys.admit_create(LEAF, CreateMode::Mount).unwrap() else {
        panic!("admit")
    };
    keys.stage_shell(LEAF, cg, PC, None).unwrap();
    keys.complete_shell(
        LEAF,
        cg,
        &StagedShell {
            process: PC.into(),
            stage: ShellStage::Local,
        },
    );
    use crate::pty_manager::ssh_shell::PromptProof;
    let nonce = "0123456789abcdef0123456789abcdef";
    keys.register_ssh_prompt(PC, cg, nonce).unwrap();
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let writer: LocalWriter =
        Arc::new(std::sync::Mutex::new(Box::new(Recording(recorded.clone()))));
    let held_writer = writer.lock().unwrap();
    let mut replies = StartupReplies::new(writer.clone(), "drain-fixture".into());
    let drain = replies.drain();
    replies.send(StartupReply {
        bytes: b"\x1b[4;1R",
        cursor: true,
        da1: false,
        consumed: 1,
    });
    replies.send(StartupReply {
        bytes: DA1_REPLY,
        cursor: false,
        da1: true,
        consumed: 2,
    });
    let observe = |seq| keys.observe_shell_prompt(PC, nonce, seq, PromptProof::Local {
        drain: &drain, input_generation: keys.ssh_prompt_input_generation(PC).unwrap(),
    });
    assert!(!drain.is_drained(), "reply pending before writer release");
    assert!(matches!(
        observe(1),
        Err(Refusal::NotReady)
    ));
    assert!(recorded.lock().is_empty());
    drop(held_writer);
    drain.wait();
    let ready = observe(2).unwrap();
    let ticket = keys.prepare_ssh_input(PC).unwrap();
    keys.submit_ssh_input(&ticket, &ready, |_permit| {
        Ok(InputDispatch::local(move || {
            writer.lock().unwrap().write_all(LAUNCH).map_err(|e| e.to_string())
        }))
    })
    .unwrap();
    assert_eq!(
        *recorded.lock(),
        [b"\x1b[4;1R".to_vec(), DA1_REPLY.to_vec(), LAUNCH.to_vec()]
    );
    let next_ticket = keys.prepare_ssh_input(PC).unwrap();
    let next_ready = observe(3).unwrap();
    keys.admit_protocol_input(PC, |_permit| Ok::<_, String>(InputDispatch::Complete(())))
        .unwrap();
    assert_eq!(
        keys.submit_ssh_input(&next_ticket, &next_ready, |_| Ok::<_, String>(InputDispatch::Complete(())))
            .unwrap_err(),
        Refusal::NotReady.to_string(),
        "a later protocol reply invalidates an unconsumed prompt epoch"
    );
}

fn cancel_retry_ticket(keys: &HostKeys, ticket: &LaunchTicket, ordered: bool) -> Result<(), Refusal> {
    if ordered {
        let _order = keys.input_owner_change();
        keys.cancel_registered_launch_ordered(ticket)
    } else {
        keys.cancel_ssh_input(ticket)
    }
}

#[tokio::test]
async fn retry_reuses_exact_unsubmitted_prompt() {
    for ordered in [false, true] {
        // An ordinary write consumes readiness, so check it on a separate fixture.
        let (ordinary, _) = Backend::new(false);
        let ticket = ordinary.keys.prepare_ssh_input(PC).unwrap();
        cancel_retry_ticket(&ordinary.keys, &ticket, ordered).unwrap();
        write_input(&*ordinary, PC, SOURCES[0].1, None, b"human input").unwrap();

        let (backend, mut peer) = Backend::new(false);
        let keys = &backend.keys;
        let first = keys.prepare_ssh_input(PC).unwrap();
        let ready = backend.ready();
        cancel_retry_ticket(keys, &first, ordered).unwrap();
        assert_eq!(
            keys.submit_ssh_input::<(), Refusal>(&first, &ready, |_| panic!("cancelled launch was admitted")),
            Err(Refusal::StaleAttempt),
        );
        assert_eq!(cancel_retry_ticket(keys, &first, ordered),
            if ordered { Ok(()) } else { Err(Refusal::StaleAttempt) });
        let mut next = keys.prepare_ssh_input(PC).unwrap();
        let retained = keys.launch_ready_ordered(&mut next).unwrap().expect("retry must see the original prompt");
        assert_eq!((retained.epoch, retained.input_generation), (ready.epoch, ready.input_generation));
        keys.submit_ssh_input(&next, &retained, |p| backend.enqueue(p, LAUNCH)).unwrap();
        assert_eq!(backend.bytes(&mut peer).await, [LAUNCH.to_vec()]);
    }
}

#[test]
fn retry_requires_fresh_prompt_after_submission_input_or_transfer() {
    for ordered in [false, true] {
        for change in ["submitted with intervening prompt", "ordinary", "transfer"] {
            let (backend, _) = Backend::new(false);
            let keys = &backend.keys;
            let first = keys.prepare_ssh_input(PC).unwrap();
            let ready = backend.ready();
            if change == "submitted with intervening prompt" {
                keys.submit_ssh_input(&first, &ready, |p| backend.enqueue(p, LAUNCH)).unwrap();
                backend.ready();
            }
            cancel_retry_ticket(keys, &first, ordered).unwrap();
            if change == "ordinary" {
                write_input(&*backend, PC, SOURCES[0].1, None, b"human input").unwrap();
            } else if change == "transfer" {
                transfer(keys);
            }
            let mut next = keys.prepare_ssh_input(PC).unwrap();
            assert!(keys.launch_ready_ordered(&mut next).unwrap().is_none(), "{change}, ordered={ordered}");
            let fresh = backend.ready();
            assert_eq!(keys.launch_ready_ordered(&mut next).unwrap().unwrap().epoch, fresh.epoch);
        }
    }
}

#[test]
fn effective_ssh_shell_identity_uses_live_pin_and_rejects_dead_pin() {
    use crate::pty_manager::ssh_helpers::ProcessIdentity;
    let live = ProcessIdentity::capture(std::process::id()).unwrap();
    let bound = BoundSshShell { shell: "test".into(), identity: live.clone(), leaf: Arc::default() };
    assert_eq!(bound.effective_identity().unwrap().0, live);
    let dead = ProcessIdentity { pid: live.pid, start_time: live.start_time + 1 };
    let launcher = BoundSshShell { shell: "test".into(), identity: dead.clone(), leaf: Arc::default() };
    launcher.pin_leaf_for_test(live.clone());
    assert_eq!(launcher.effective_identity().unwrap().0, live);
    bound.pin_leaf_for_test(dead);
    assert!(bound.effective_identity().is_none());
}

#[test]
fn ssh_shell_resolver_accessor_source_census() {
    use std::{fs, path::Path};
    fn scan(dir: &Path, root: &Path, hits: &mut Vec<String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                scan(&path, root, hits);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let source = fs::read_to_string(&path).unwrap();
                for _ in source.lines().flat_map(|line| line.matches(concat!("launcher_for_", "leaf_resolution"))) {
                    hits.push(path.strip_prefix(root).unwrap().to_str().unwrap().replace(char::from(92), "/"));
                }
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut hits = Vec::new();
    scan(&root, &root, &mut hits);
    hits.sort();
    assert_eq!(hits, ["pty_manager/input_gate.rs", "ssh/launch/drive/bare_shell.rs"]);
}
