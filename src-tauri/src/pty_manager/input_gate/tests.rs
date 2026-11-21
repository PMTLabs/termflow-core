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
    fn enqueue(&self, permit: &InputPermit<'_>, bytes: &[u8]) -> Result<(), String> {
        if self.enqueue_hosted(permit, bytes) {
            return Ok(());
        }
        if self.hosted(permit.process()) {
            return Err("host refused".into());
        }
        self.local
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .write_all(bytes)
            .map_err(|e| e.to_string())
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
                "enqueue must retain admission: {sink}"
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
        writer
            .lock()
            .unwrap()
            .write_all(LAUNCH)
            .map_err(|e| e.to_string())
    })
    .unwrap();
    assert_eq!(
        *recorded.lock(),
        [b"\x1b[4;1R".to_vec(), DA1_REPLY.to_vec(), LAUNCH.to_vec()]
    );
    let next_ticket = keys.prepare_ssh_input(PC).unwrap();
    let next_ready = observe(3).unwrap();
    keys.admit_protocol_input(PC, |_permit| Ok::<_, String>(()))
        .unwrap();
    assert_eq!(
        keys.submit_ssh_input(&next_ticket, &next_ready, |_| Ok::<_, String>(()))
            .unwrap_err(),
        Refusal::NotReady.to_string(),
        "a later protocol reply invalidates an unconsumed prompt epoch"
    );
}
