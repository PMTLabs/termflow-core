//! Cross-subplan SSH contract tests through the registered desktop IPC handler.
use super::{
    auth::BoxFuture,
    known_hosts::KnownHosts,
    session::{AgentFactory, Dependencies, DynamicAgent, ExecOpts, ExecOutput, LaunchState,
        SessionError, SessionState, SessionTarget},
    sessions::{on_launch_lifecycle, with_session},
    sftp::{edit::EditRegistry, watch::TokioClock},
    store::Store,
    store_adapter::StoreAdapter,
    tests::{hop, Fixture, Server, Targets},
};
use crate::{
    commands::ssh_session::TauriSshEvents,
    state::{AppState, Completion, PageRegistration, PaneIdentity, PaneReply, PaneResult, ShellStage, StagedShell},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::Ordering::SeqCst, Arc, Mutex},
    time::Duration,
};
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{self, MockRuntime},
    webview::InvokeRequest,
    Emitter, Listener, Manager, WebviewWindow,
};
use tokio::{sync::{mpsc, oneshot}, time::timeout};
use uuid::Uuid;

const T: &str = "tm-a";
const C: &str = "c-a";
const SOURCE: &str = "ssh-owner";
const DEST: &str = "ssh-destination";
const PROCESS: &str = "pc-a";
const STORE_EVENT: &str = "ssh-store:changed";
const SESSION_EVENT: &str = "ssh-session:state";
const PROBE_EVENT: &str = "ssh-test:state";
const WAIT: Duration = Duration::from_secs(8);

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("tf-ssh-integration-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// AppState and preview use profile paths. Isolate them without mutating the
// parent test process environment or consulting its SSH configuration.
async fn isolated(name: &str) -> bool {
    const GUARD: &str = "TF_SSH_T7_ISOLATED_CASE";
    if std::env::var(GUARD).ok().as_deref() == Some(name) {
        return true;
    }
    let home = Temp::new();
    let (_, module) = module_path!().split_once("::").unwrap();
    let stdout = home.0.join("libtest-output");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([format!("{module}::{name}"), "--exact".into(), "--nocapture".into()])
        .env(GUARD, name)
        .env("HOME", &home.0)
        .env("USERPROFILE", &home.0)
        .env("XDG_CONFIG_HOME", &home.0)
        .env("XDG_DATA_HOME", &home.0)
        .env("XDG_STATE_HOME", &home.0)
        .env_remove("SSH_AUTH_SOCK")
        .stdout(Stdio::from(fs::File::create(&stdout).unwrap()))
        .current_dir(&home.0)
        .spawn().unwrap();
    let status = timeout(Duration::from_secs(90), async {
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("isolated test did not exit");
    let output = fs::read_to_string(stdout).unwrap();
    assert!(status.success() && output.contains("1 passed"), "isolated test {name}: {status}\n{output}");
    false
}

struct NoAgent;
impl AgentFactory for NoAgent {
    fn connect(&self) -> BoxFuture<'_, Result<DynamicAgent, SessionError>> {
        panic!("password fixtures must not use an SSH agent")
    }
}

type Wire = Result<Value, Value>;
type Log = Arc<Mutex<Vec<Value>>>;

struct Rig {
    app: tauri::App<MockRuntime>,
    source: WebviewWindow<MockRuntime>,
    dest: WebviewWindow<MockRuntime>,
    fixture: Fixture,
    store: Store,
    store_path: PathBuf,
    replies: Log,
    events: Log,
    received: mpsc::UnboundedReceiver<(&'static str, Value)>,
    _temp: Temp,
}
impl Rig {
    fn new(server: Server, pinned: bool, use_store: bool) -> Self {
        let temp = Temp::new();
        let store_path = temp.0.join("ssh.json");
        let store = Store::new(store_path.clone());
        let app = test::mock_builder()
            .manage(store.clone())
            .manage(Arc::new(EditRegistry::new(temp.0.join("edits"), Arc::new(TokioClock))))
            .invoke_handler(crate::ssh_handlers![
                crate::commands::ssh_terminal_launch,
                crate::commands::ssh_terminal_cancel_launch,
                crate::commands::ssh_terminal_launch_state,
            ])
            .build(test::mock_context(test::noop_assets())).unwrap();
        let source = tauri::WebviewWindowBuilder::new(&app, SOURCE, Default::default()).build().unwrap();
        let dest = tauri::WebviewWindowBuilder::new(&app, DEST, Default::default()).build().unwrap();
        let events: Log = Arc::default();
        let (send, received) = mpsc::unbounded_channel();
        for name in [STORE_EVENT, SESSION_EVENT, PROBE_EVENT, "ssh-launch:state", "ssh-fs:edit-state", "ssh-fs:cwd"] {
            let send = send.clone();
            let events = events.clone();
            app.listen(name, move |event| {
                let payload: Value = serde_json::from_str(event.payload()).unwrap();
                events.lock().unwrap().push(json!({"event":name,"payload":payload}));
                let _ = send.send((name, payload));
            });
        }
        let fixture = Fixture::new(server, vec![hop(C, "alice")], pinned);
        let emitter = app.handle().clone();
        let adapter = Arc::new(StoreAdapter::new(store.clone(), temp.0.clone(), Arc::new(move |reply| {
            emitter.emit(STORE_EVENT, reply).unwrap();
        })));
        fixture.registry.configure(Dependencies {
            targets: if use_store { adapter.clone() } else { Arc::new(Targets(SessionTarget { hops: vec![hop(C, "alice")] })) },
            streams: fixture.integration_streams(),
            agents: Arc::new(NoAgent),
            secrets: if use_store { adapter } else { fixture.secrets.clone() },
            events: Arc::new(TauriSshEvents(app.handle().clone())),
            known_hosts: KnownHosts { path: fixture.path.clone() },
            home: fixture.path.parent().unwrap().into(),
        }).unwrap();
        let (tx, _) = tokio::sync::broadcast::channel(16);
        let mut state = AppState::new(tx, app.handle().clone(), crate::app_config::NetworkConfig::defaults());
        state.ssh_sessions = fixture.registry.clone();
        app.manage(state);
        Self { app, source, dest, fixture, store, store_path, replies: Arc::default(), events, received, _temp: temp }
    }

    fn state(&self) -> tauri::State<'_, AppState<MockRuntime>> {
        self.app.state()
    }

    async fn call(&self, cmd: &'static str, args: Value) -> Wire {
        self.call_from(&self.source, cmd, args).await
    }
    async fn call_from(&self, window: &WebviewWindow<MockRuntime>, cmd: &'static str, args: Value) -> Wire {
        invoke(window, &self.replies, cmd, args).await
    }
    async fn ok(&self, cmd: &'static str, args: Value) -> Value {
        self.call(cmd, args).await.unwrap_or_else(|err| panic!("{cmd}: {err}"))
    }
    fn payloads(&self, name: &str) -> Vec<Value> {
        self.events.lock().unwrap().iter().filter(|e| e["event"] == name)
            .map(|e| e["payload"].clone()).collect()
    }
    async fn event(&mut self, name: &str, id: &str, generation: u64, state: &str) -> Value {
        let id_key = if name == PROBE_EVENT { "probeId" } else { "terminalId" };
        // No other producer can consume these immutable snapshots; prompt
        // matching is a barrier, not a delay or a registry polling loop.
        timeout(WAIT, async {
            loop {
                let (kind, v) = self.received.recv().await.unwrap();
                if kind == name && v[id_key] == id && v["generation"] == generation && v["state"] == state {
                    return v;
                }
            }
        }).await.unwrap_or_else(|_| panic!("missing {name} {id}/{generation}: {state}"))
    }
    fn page(&self, name: &str) -> PaneIdentity {
        let state = self.state();
        let keys = state.host_table.keys();
        keys.reserve_window(name).unwrap().commit().unwrap();
        let PageRegistration::Registered { pg, .. } = keys.register_page(name).unwrap() else { panic!("register page") };
        PaneIdentity { pg, seq: 1 }
    }
    fn op(&self, name: &str, pi: PaneIdentity, seq: u64, op: Value) -> PaneResult {
        let state = self.state();
        let (reply, effects) = state.host_table.keys().pane_op(name,
            serde_json::from_value(json!({"pg":pi.pg,"seq":seq,"op":op})).unwrap()).unwrap();
        for (id, receipt) in effects.ssh_retired {
            self.fixture.registry.retire_owner(&id, receipt);
        }
        state.reconcile_ssh_owners();
        let PaneReply::Ack { result } = reply else { panic!("pane op acknowledge") };
        result
    }
    fn mount(&self, connection: &str) -> PaneIdentity {
        let pi = self.page(SOURCE);
        assert_eq!(self.op(SOURCE, pi, 1, json!({"kind":"enter","panes":[pane(pi)]})), PaneResult::Ok);
        let PaneResult::Create { cg } = self.op(SOURCE, pi, 2, json!({"kind":"admit_create","pi":pi,"mode":"Mount"})) else { panic!("admit create") };
        let state = self.state();
        let keys = state.host_table.keys();
        keys.stage_shell(T, cg, PROCESS, None).unwrap();
        keys.register_tagged_ssh_prompt(PROCESS, cg, "0123456789abcdef0123456789abcdef", Some(connection)).unwrap();
        assert!(matches!(keys.complete_shell(T, cg, &StagedShell {
            process: PROCESS.into(), stage: ShellStage::Local,
        }), Completion::Registered));
        pi
    }
    async fn open(&self, connection: &str) -> u64 {
        let v = self.ok("ssh_session_open", json!({"terminalId":T,"connectionId":connection})).await;
        let g = generation(&v);
        assert_eq!(v, json!({"terminalId":T,"connectionId":connection,"generation":g,"revision":0,"state":"connecting","gate":"pending"}));
        g
    }
    async fn password(&mut self, id: &str, g: u64, probe: bool, connection: &str) -> Value {
        self.password_at(id, g, probe, connection, 3).await
    }
    async fn password_at(&mut self, id: &str, g: u64, probe: bool, connection: &str, revision: u64) -> Value {
        let (event, state_cmd, id_key) = if probe { (PROBE_EVENT, "ssh_test_state", "probeId") }
            else { (SESSION_EVENT, "ssh_session_state", "terminalId") };
        let v = self.event(event, id, g, "needs-secret").await;
        let mut expected = json!({"connectionId":connection,"generation":g,"revision":revision,
            "state":"needs-secret","gate":"verified","knownHostsPaths":{"target":self.fixture.path},
            "secretKind":"password","promptId":string(&v,"promptId"),
            "promptTarget":{"connectionId":connection,"host":"target.test","port":22,"user":"alice","hop":"target"}});
        expected[id_key] = json!(id);
        assert_eq!(v, expected);
        assert_eq!(self.ok(state_cmd, json!({(id_key):id})).await, expected);
        v
    }
    async fn submit(&self, v: &Value, remember: bool) {
        let (cmd, key) = if v.get("probeId").is_some() { ("ssh_test_submit_secret", "probeId") }
            else { ("ssh_session_submit_secret", "terminalId") };
        assert_eq!(self.ok(cmd, json!({(key):v[key],"secret":self.fixture.server.password,
            "remember":remember,"generation":v["generation"],"promptId":v["promptId"]})).await, Value::Null);
    }
    async fn connect(&mut self, g: u64, connection: &str, remember: bool) -> Value {
        let prompt = self.password(T, g, false, connection).await;
        self.submit(&prompt, remember).await;
        on_launch_lifecycle(&self.fixture.registry, T, g, 1, LaunchState::Running, Some(PROCESS.into())).unwrap();
        self.connected(T, g, false, connection).await
    }
    async fn connected(&mut self, id: &str, g: u64, probe: bool, connection: &str) -> Value {
        let (event, cmd, key) = if probe { (PROBE_EVENT, "ssh_test_state", "probeId") }
            else { (SESSION_EVENT, "ssh_session_state", "terminalId") };
        let v = self.event(event, id, g, "connected").await;
        assert_eq!(v, json!({(key):id,"connectionId":connection,"generation":g,"revision":v["revision"],
            "state":"connected","gate":"verified","knownHostsPaths":{"target":self.fixture.path}}));
        assert_eq!(self.ok(cmd, json!({(key):id})).await, v);
        v
    }
    fn pane_map(&self, expected: Option<(&str, SessionState, u64, Option<bool>)>) {
        let expected: HashMap<_, _> = expected.into_iter().map(|(c, s, g, task)| (T.to_owned(), (c.to_owned(), s, g, task))).collect();
        assert_eq!(self.fixture.registry.integration_snapshot(false), expected);
    }
    async fn drain(&self, retired: bool) {
        if retired {
            assert!(!self.fixture.registry.integration_retired_tasks().is_empty(), "no retired task to drain");
        }
        wait_until(|| self.fixture.registry.integration_retired_tasks().iter().all(|done| *done)).await;
        wait_until(|| self.fixture.server.counters.live_connections.load(SeqCst) == 0).await;
        timeout(WAIT, self.fixture.registry.shutdown()).await.unwrap();
        assert_eq!(self.fixture.registry.integration_retired_tasks(), Vec::<bool>::new());
    }
}

async fn invoke(window: &WebviewWindow<MockRuntime>, replies: &Log, cmd: &'static str, args: Value) -> Wire {
    // Tauri's test helper waits on a blocking channel. Keep the waiter off both
    // runtimes, and bound a missing IPC response without blocking runtime drop.
    let (send, recv) = oneshot::channel();
    let window = window.clone();
    std::thread::spawn(move || {
        let result = test::get_ipc_response(&window, InvokeRequest {
            cmd: cmd.into(), callback: CallbackFn(0), error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(), body: InvokeBody::Json(args),
            headers: Default::default(), invoke_key: test::INVOKE_KEY.into(),
        }).map(|response| response.deserialize::<Value>().unwrap());
        let _ = send.send(result);
    });
    let result = timeout(WAIT, recv).await.unwrap_or_else(|_| panic!("IPC timeout: {cmd}"))
        .unwrap_or_else(|_| panic!("IPC waiter failed: {cmd}"));
    replies.lock().unwrap().push(match &result {
        Ok(v) => json!({"ok":v}), Err(v) => json!({"error":v}),
    });
    result
}
async fn wait_until(mut complete: impl FnMut() -> bool) {
    timeout(WAIT, async {
        while !complete() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }).await.expect("observable work did not finish");
}
fn string(v: &Value, key: &str) -> String { v[key].as_str().unwrap().to_owned() }
fn generation(v: &Value) -> u64 { v["generation"].as_u64().unwrap() }
fn pane(pi: PaneIdentity) -> Value { json!({"pi":pi,"paneId":"pane-a","leaf":T,"restore":false}) }
fn connection(id: Option<&str>, name: &str) -> Value {
    json!({"id":id,"folderId":null,"name":name,"host":"target.test","port":22,"user":"alice",
        "auth":"password","identityFile":null,"jumpConnectionId":null,"extraOptions":[],"bookmarked":false})
}
fn view(revision: u64, folders: Value, connections: Value) -> Value {
    json!({"revision":revision,"view":{"revision":revision,"folders":folders,"connections":connections,"loadError":null}})
}
fn row(id: &str, name: &str, order: usize) -> Value {
    let mut row = connection(Some(id), name);
    row["order"] = json!(order);
    row["lastUsedAt"] = Value::Null;
    row["hasSavedSecret"] = json!(false);
    row
}
fn file_request(g: u64, path: &str) -> Value {
    json!({"terminalId":T,"path":path,"expectedGeneration":g})
}
fn list(g: u64, path: &str, entries: Value) -> Value {
    json!({"path":path,"entries":entries,"sessionGeneration":g})
}
fn launch_attempt(pi: PaneIdentity, g: u64) -> Value {
    json!({"sessionGeneration":g,"attemptReceipt":{"generation":g,"gate":"pending"},
        "processIncarnation":PROCESS,"ownerIncarnation":pi})
}
fn trust_request(v: &Value, accept: bool) -> Value {
    let key = if v.get("probeId").is_some() { "probeId" } else { "terminalId" };
    json!({(key):v[key],"accept":accept,"generation":v["generation"],"promptId":v["promptId"]})
}
fn known_hosts_line(server: &Server) -> String {
    format!("target.test {}\n", server.host.public_key().to_openssh().unwrap())
}
fn preview(home: &Path, revision: u64) -> Value {
    let kh = format!("UserKnownHostsFile=\"{}\"", home.join(".ssh/known_hosts").display());
    let argv = ["/usr/bin/ssh", "-F", "none", "-o", "StrictHostKeyChecking=yes", "-o", &kh,
        "-o", "GlobalKnownHostsFile=none", "-p", "22", "-l", "alice", "-o", "PreferredAuthentications=password", "--", "target.test"];
    let display = argv.iter().map(|arg| json!(arg).to_string()).collect::<Vec<_>>().join(" ");
    json!({"argv":argv,"display":display,"storeRevision":revision,
        "configNotice":"~/.ssh/config does not apply to saved connections. Preview only; trust is not verified here.",
        "wrapper":"Direct native OpenSSH connection"})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_integration_registered_commands_round_trip_wire_payloads() {
    if !isolated("ssh_integration_registered_commands_round_trip_wire_payloads").await { return; }
    let mut r = Rig::new(Server::new(1, "alice"), true, true);
    assert_eq!(r.ok("ssh_store_get", json!({})).await, view(0, json!([]), json!([])));
    let folder = r.ok("ssh_folder_upsert", json!({"input":{
        "parentId":null,"name":"Wire folder","icon":"server","color":"amber"
    }})).await;
    let fid = string(&folder["view"]["folders"][0], "id");
    let dirs = json!([{"id":fid,"parentId":null,"name":"Wire folder","icon":"server","color":"amber","order":0}]);
    assert_eq!(folder, view(1, dirs.clone(), json!([])));
    let created = r.ok("ssh_connection_upsert", json!({"input":connection(None,"A")})).await;
    let id = string(&created["view"]["connections"][0], "id");
    let mut a = row(&id, "A", 1);
    assert_eq!(created, view(2, dirs.clone(), json!([a])));
    a["folderId"] = json!(fid);
    a["order"] = json!(0);
    let moved = r.ok("ssh_move", json!({"kind":"connection","id":id,"parentId":fid,"index":0})).await;
    assert_eq!(moved, view(3, dirs.clone(), json!([a])));
    a["bookmarked"] = json!(true);
    let star = r.ok("ssh_set_bookmark", json!({"id":id,"bookmarked":true})).await;
    assert_eq!(star, view(4, dirs.clone(), json!([a])));
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    for source in [json!({"kind":"saved","id":id}), json!({"kind":"draft","draft":connection(None,"Draft")})] {
        assert_eq!(r.ok("ssh_connection_preview", json!({"source":source})).await, preview(&home, 4));
    }
    assert_eq!(r.ok("ssh_store_reload", json!({})).await, star);
    let used = r.ok("ssh_connection_mark_used", json!({"id":id})).await;
    a["lastUsedAt"] = json!(used["view"]["connections"][0]["lastUsedAt"].as_i64().unwrap());
    assert_eq!(used, view(5, dirs.clone(), json!([a])));
    assert_eq!(r.payloads(STORE_EVENT), vec![folder, created, moved, star, used]);

    let bad = r.call("ssh_test_connection", json!({"connection_id":id})).await.unwrap_err();
    assert!(bad.as_str().unwrap().contains("missing required key connectionId"), "{bad}");

    let pi = r.mount(&id);
    let g = r.open(&id).await;
    let pin = r.password(T, g, false, &id).await;
    let attempt = launch_attempt(pi, g);
    let started = r.ok("ssh_terminal_launch", json!({"terminalId":T,"connectionId":id,"attempt":attempt})).await;
    let seq = started["launchSeq"].as_u64().unwrap();
    let authoritative = json!({"sessionGeneration":g,"attemptReceipt":{"generation":g,"gate":"verified",
        "knownHostsPaths":pin["knownHostsPaths"]},"processIncarnation":PROCESS,"ownerIncarnation":pi});
    assert_eq!(started, json!({"terminalId":T,"connectionId":id,"attempt":authoritative,
        "revision":seq,"launchSeq":seq,"stage":"preparing"}));
    let query = r.ok("ssh_terminal_launch_state", json!({"terminalId":T,"attempt":attempt})).await;
    let query_seq = query["launchSeq"].as_u64().unwrap();
    let query_stage = string(&query, "stage");
    assert!(matches!(query_stage.as_str(), "preparing" | "waiting-ready"));
    assert!(query_seq >= seq);
    assert_eq!(query, json!({"terminalId":T,"connectionId":id,"attempt":authoritative,
        "revision":query_seq,"launchSeq":query_seq,"stage":query_stage}));
    let cancelled = r.ok("ssh_terminal_cancel_launch", json!({"terminalId":T,"attempt":attempt})).await;
    let cancel_seq = cancelled["launchSeq"].as_u64().unwrap();
    assert!(cancel_seq > query_seq);
    let mut cancelled_attempt = authoritative;
    cancelled_attempt["attemptReceipt"]["gate"] = json!("blocked");
    cancelled_attempt["attemptReceipt"]["reason"] = json!("SSH launch cancelled");
    assert_eq!(cancelled, json!({"terminalId":T,"connectionId":id,"attempt":cancelled_attempt,
        "revision":cancel_seq,"launchSeq":cancel_seq,"stage":"cancelled"}));

    let next = r.ok("ssh_session_reconnect", json!({"terminalId":T})).await;
    let g = generation(&next);
    let auth = r.password(T, g, false, &id).await;
    assert_eq!(r.call("ssh_session_trust_host", trust_request(&auth, true)).await,
        Err(json!({"code":"stale-attempt"})));
    r.submit(&auth, false).await;
    on_launch_lifecycle(&r.fixture.registry, T, g, 1, LaunchState::Running, Some(PROCESS.into())).unwrap();
    r.connected(T, g, false, &id).await;

    let initial = list(g, "/", json!([]));
    assert_eq!(r.ok("ssh_fs_list", file_request(g, "/")).await, initial);
    assert_eq!(r.call("ssh_fs_list", file_request(g - 1, "/")).await,
        Err(fs_error("stale", "list", "/", "The SSH session has changed.")));
    assert_eq!(r.ok("ssh_fs_mkdir", file_request(g, "/folder")).await, Value::Null);
    assert_eq!(r.ok("ssh_fs_create", file_request(g, "/folder/source")).await, Value::Null);
    let mut rename = file_request(g, "/folder/source");
    rename["newPath"] = json!("/folder/dest");
    assert_eq!(r.ok("ssh_fs_rename", rename).await, Value::Null);
    let mut mode = file_request(g, "/folder/dest");
    mode["mode"] = json!(0o640);
    assert_eq!(r.ok("ssh_fs_chmod", mode).await, Value::Null);
    let mut owner = file_request(g, "/folder/dest");
    owner["uid"] = json!(1234);
    owner["gid"] = json!(2345);
    assert_eq!(r.ok("ssh_fs_chown", owner).await, Value::Null);
    r.fixture.server.sftp_faults.lock().omit_attrs = true;
    let entry = json!({"name":"dest","path":"/folder/dest","kind":"file","mode":0o100640,"uid":1234,"gid":2345});
    assert_eq!(r.ok("ssh_fs_stat", file_request(g, "/folder/dest")).await, entry);
    assert_eq!(r.ok("ssh_fs_list", file_request(g, "/folder")).await, list(g, "/folder", json!([entry])));

    // Admission is exercised without opening a host-native dialog or editor.
    for (cmd, operation) in [("ssh_fs_download", "download"), ("ssh_fs_open", "open"), ("ssh_fs_open_with", "openWith")] {
        assert_eq!(r.call(cmd, file_request(g - 1, "/folder/dest")).await,
            Err(fs_error("stale", operation, "/folder/dest", "The SSH session has changed.")));
    }
    assert_eq!(r.call("ssh_fs_insert_path", file_request(g - 1, "/folder/dest")).await,
        Err(fs_error("stale", "insertPath", "/folder/dest", "The SSH session generation changed.")));
    assert_eq!(r.ok("ssh_fs_edit_list", json!({"terminalId":T,"path":"."})).await, json!([]));
    assert_eq!(r.ok("ssh_fs_edit_stop", json!({"terminalId":T,"path":"/folder/dest","editId":Uuid::nil()})).await,
        json!({"retained":false}));
    let mut delete = file_request(g, "/folder");
    delete["recursive"] = json!(true);
    delete["confirmed"] = json!(true);
    assert_eq!(r.ok("ssh_fs_delete", delete).await, Value::Null);
    assert_eq!(r.ok("ssh_fs_list", file_request(g, "/")).await, initial);
    assert_eq!(r.ok("ssh_session_close", json!({"terminalId":T,"generation":g})).await, Value::Null);
    assert_eq!(r.call("ssh_session_state", json!({"terminalId":T})).await, Err(json!({"code":"not-found"})));

    // Only the disposable known_hosts file: exercise positive probe trust as
    // well as the pane's wrong-prompt refusal above.
    fs::remove_file(&r.fixture.path).unwrap();
    let created = r.ok("ssh_test_connection", json!({"connectionId":id})).await;
    let probe = string(&created, "probeId");
    assert_eq!(created, json!({"probeId":probe}));
    let trust = trust_prompt(&mut r, &probe, &id, g + 1, true).await;
    assert_eq!(r.ok("ssh_test_trust_host", trust_request(&trust, true)).await, Value::Null);
    let v = r.password_at(&probe, g + 1, true, &id, 6).await;
    assert_eq!(fs::read(&r.fixture.path).unwrap(), known_hosts_line(&r.fixture.server).as_bytes());
    r.submit(&v, false).await;
    r.connected(&probe, g + 1, true, &id).await;
    assert_eq!(r.ok("ssh_test_close", json!({"probeId":probe})).await, Value::Null);
    assert_eq!(r.call("ssh_test_state", json!({"probeId":probe})).await, Err(json!({"code":"not-found"})));

    let forgotten = r.ok("ssh_forget_secret", json!({"id":id})).await;
    assert_eq!(forgotten, view(6, dirs.clone(), json!([a])));
    let deleted = r.ok("ssh_connection_delete", json!({"id":id})).await;
    assert_eq!(deleted, view(7, dirs, json!([])));
    let removed = r.ok("ssh_folder_delete", json!({"id":fid,"recursive":false})).await;
    assert_eq!(removed, view(8, json!([]), json!([])));
    assert_eq!(r.payloads(STORE_EVENT)[5..], [forgotten, deleted, removed]);
    assert_eq!(r.op(SOURCE, pi, 3, json!({"kind":"close","pi":pi})), PaneResult::Ok);
    r.drain(true).await;
}

fn fs_error(code: &str, op: &str, path: &str, detail: &str) -> Value {
    json!({"code":code,"operation":op,"path":path,"outcome":"unchanged","message":format!("{op} on {path}: {detail}")})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_integration_store_revision_lock_and_redaction() {
    if !isolated("ssh_integration_store_revision_lock_and_redaction").await { return; }
    let secret = format!("t7-password-sentinel-{}", Uuid::new_v4());
    let mut server = Server::new(1, "alice");
    server.password = secret.clone();
    let mut r = Rig::new(server, true, true);

    // Independent store caches on the same ConfigLock/file. A's mark-used must
    // re-read B's commit, not overwrite it with the last view A served.
    let second = test::mock_builder().manage(Store::new(r.store_path.clone()))
        .invoke_handler(crate::ssh_handlers![])
        .build(test::mock_context(test::noop_assets())).unwrap();
    let log = r.events.clone();
    second.listen(STORE_EVENT, move |event| {
        let reply: Value = serde_json::from_str(event.payload()).unwrap();
        log.lock().unwrap().push(json!({"event":STORE_EVENT,"payload":reply}));
    });
    let other = tauri::WebviewWindowBuilder::new(&second, "other-store", Default::default()).build().unwrap();

    let b_saved = r.ok("ssh_connection_upsert", json!({"input":connection(None,"B")})).await;
    let bid = string(&b_saved["view"]["connections"][0], "id");
    let mut b = row(&bid, "B", 0);
    assert_eq!(b_saved, view(1, json!([]), json!([b])));
    let a_saved = r.ok("ssh_connection_upsert", json!({"input":connection(None,"A")})).await;
    let aid = string(&a_saved["view"]["connections"][1], "id");
    let mut a = row(&aid, "A", 1);
    assert_eq!(a_saved, view(2, json!([]), json!([b, a])));
    b["bookmarked"] = json!(true);
    let bookmarked = invoke(&other, &r.replies, "ssh_set_bookmark", json!({"id":bid,"bookmarked":true})).await.unwrap();
    assert_eq!(bookmarked, view(3, json!([]), json!([b, a])));
    let marked = r.ok("ssh_connection_mark_used", json!({"id":aid})).await;
    let last_used = marked["view"]["connections"][1]["lastUsedAt"].as_i64().unwrap();
    assert!(last_used > 0);
    a["lastUsedAt"] = json!(last_used);
    assert_eq!(marked, view(4, json!([]), json!([b, a])));
    assert_eq!(r.ok("ssh_store_reload", json!({})).await, marked);

    a["name"] = json!("A edited");
    let edited = r.ok("ssh_connection_upsert", json!({"input":connection(Some(&aid),"A edited")})).await;
    assert_eq!(edited, view(5, json!([]), json!([b, a])));
    let commits = vec![b_saved, a_saved, bookmarked, marked, edited.clone()];
    assert_eq!(r.payloads(STORE_EVENT), commits);
    let bytes = fs::read(&r.store_path).unwrap();
    assert_eq!(r.call("ssh_connection_delete", json!({"id":"absent"})).await,
        Err(json!({"field":null,"code":"not-found","message":"Connection not found"})));
    assert_eq!(r.ok("ssh_store_get", json!({})).await, edited);
    assert_eq!(fs::read(&r.store_path).unwrap(), bytes);
    assert_eq!(r.payloads(STORE_EVENT), commits);

    let pi = r.mount(&aid);
    let g = r.open(&aid).await;
    r.connect(g, &aid, true).await;
    a["hasSavedSecret"] = json!(true);
    let saved = view(6, json!([]), json!([b, a]));
    assert_eq!(r.ok("ssh_store_reload", json!({})).await, saved);
    let mut commits = commits;
    commits.push(saved);
    assert_eq!(r.payloads(STORE_EVENT), commits);
    let ciphertext = r.store.snapshot().unwrap().connections.into_iter()
        .find(|c| c.id == aid).unwrap().secret.unwrap();
    assert!(ciphertext.starts_with("v1:") && !ciphertext.contains(&secret));

    // Positive reuse control: connect without another prompt or password IPC.
    let next = r.ok("ssh_session_reconnect", json!({"terminalId":T})).await;
    let next = generation(&next);
    on_launch_lifecycle(&r.fixture.registry, T, next, 1, LaunchState::Running, Some(PROCESS.into())).unwrap();
    r.connected(T, next, false, &aid).await;
    assert_eq!(*r.fixture.server.counters.principals.lock(), ["alice", "alice"]);
    assert!(r.payloads(SESSION_EVENT).iter().all(|v| v["generation"] != next || v["state"] != "needs-secret"));
    assert_eq!(r.op(SOURCE, pi, 3, json!({"kind":"close","pi":pi})), PaneResult::Ok);
    r.drain(true).await;
    for log in [&r.replies, &r.events] {
        for outbound in log.lock().unwrap().iter() {
            let serialized = outbound.to_string();
            assert!(!serialized.contains(&secret), "plaintext SSH credential on the wire");
            assert!(!serialized.contains(&ciphertext), "encrypted SSH credential on the wire");
        }
    }
}

fn exec_opts(cancel: tokio_util::sync::CancellationToken) -> ExecOpts {
    ExecOpts { deadline: Duration::from_secs(5), stdout_cap: 1024 * 1024, stderr_cap: 16 * 1024, cancel }
}
async fn exec(r: &Rig, command: &str) -> Result<ExecOutput, SessionError> {
    timeout(WAIT, with_session(&r.fixture.registry, T, |session| async move {
        session.exec_with(command, exec_opts(session.cancellation())).await
    })).await.unwrap()
}
fn check_login(r: &Rig, principals: &[&str], handshakes: usize) {
    assert_eq!(r.fixture.server.counters.principals.lock().iter().map(String::as_str).collect::<Vec<_>>(), principals);
    assert_eq!(r.fixture.server.counters.auth.load(SeqCst), principals.len());
    assert_eq!(r.fixture.server.counters.handshakes.load(SeqCst), handshakes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_integration_files_and_metrics_share_session_and_stop_on_drop() {
    if !isolated("ssh_integration_files_and_metrics_share_session_and_stop_on_drop").await { return; }
    let mut r = Rig::new(Server::new(1, "alice"), true, false);
    let pi = r.mount(C);
    let g = r.open(C).await;
    r.connect(g, C, false).await;
    r.pane_map(Some((C, SessionState::Connected, g, Some(false))));
    let listing = list(g, "/", json!([]));
    assert_eq!(r.ok("ssh_fs_list", file_request(g, "/")).await, listing);
    assert_eq!(exec(&r, "fixture-metrics").await, Ok(ExecOutput {
        stdout: b"fixture-output".to_vec(), stderr: b"fixture-stderr".to_vec(), exit: 7,
    }));

    let closed = r.fixture.server.counters.closed_channels.load(SeqCst);
    assert_eq!(exec(&r, "hang").await, Err(SessionError::TimedOut));
    wait_until(|| r.fixture.server.counters.closed_channels.load(SeqCst) > closed).await;
    assert_eq!(r.ok("ssh_fs_list", file_request(g, "/")).await, listing);
    check_login(&r, &["alice"], 1);
    let requests = r.fixture.server.sftp_faults.lock().requests.clone();
    assert!(requests.contains(&("opendir".into(), "/".into())));

    assert_eq!(r.op(SOURCE, pi, 3, json!({"kind":"close","pi":pi})), PaneResult::Ok);
    assert_eq!(r.call("ssh_fs_list", file_request(g, "/")).await,
        Err(fs_error("notConnected", "list", "/", "SSH is not connected.")));
    assert_eq!(exec(&r, "fixture-metrics").await, Err(SessionError::NotConnected));
    r.pane_map(None);
    r.drain(true).await;
    assert_eq!(r.fixture.server.sftp_faults.lock().requests, requests);
    check_login(&r, &["alice"], 1);
}

async fn trust_prompt(r: &mut Rig, id: &str, connection: &str, generation: u64, probe: bool) -> Value {
    let (event, cmd, id_key) = if probe { (PROBE_EVENT, "ssh_test_state", "probeId") }
        else { (SESSION_EVENT, "ssh_session_state", "terminalId") };
    let v = r.event(event, id, generation, "needs-hostkey").await;
    let key = r.fixture.server.host.public_key();
    let expected = json!({(id_key):id,"connectionId":connection,"generation":generation,"revision":3,
        "state":"needs-hostkey","gate":"blocked","knownHostsPaths":{"target":r.fixture.path},
        "promptId":string(&v,"promptId"),
        "promptTarget":{"connectionId":connection,"host":"target.test","port":22,"user":"alice","hop":"target"},
        "hostKey":{"algorithm":key.algorithm().to_string(),
            "fingerprintSha256":key.fingerprint(ssh_key::HashAlg::Sha256).to_string(),"changed":false}});
    assert_eq!(v, expected);
    assert_eq!(r.ok(cmd, json!({(id_key):id})).await, expected);
    v
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_integration_trust_cancel_changed_and_pane_less_test_cleanup() {
    if !isolated("ssh_integration_trust_cancel_changed_and_pane_less_test_cleanup").await { return; }
    let mut r = Rig::new(Server::new(1, "alice"), false, false);
    let pi = r.mount(C);
    let first = r.open(C).await;
    let prompt = trust_prompt(&mut r, T, C, first, false).await;
    assert_eq!(r.ok("ssh_session_trust_host", trust_request(&prompt, false)).await, Value::Null);
    let cancelled = r.event(SESSION_EVENT, T, first, "disconnected").await;
    let cancelled_lease = r.fixture.registry.lease(T).err();
    let cancelled_disk = fs::read(&r.fixture.path);
    let rejected_auth = r.fixture.server.counters.principals.lock().clone();

    let receipt = r.ok("ssh_session_reconnect", json!({"terminalId":T})).await;
    let trusted = generation(&receipt);
    let prompt = trust_prompt(&mut r, T, C, trusted, false).await;
    assert_eq!(r.ok("ssh_session_trust_host", trust_request(&prompt, true)).await, Value::Null);
    let auth = r.password_at(T, trusted, false, C, 6).await;
    r.submit(&auth, false).await;
    on_launch_lifecycle(&r.fixture.registry, T, trusted, 1, LaunchState::Running, Some(PROCESS.into())).unwrap();
    r.connected(T, trusted, false, C).await;
    let line = known_hosts_line(&r.fixture.server);
    assert_eq!(fs::read(&r.fixture.path).unwrap(), line.as_bytes());

    assert_eq!(cancelled, json!({"terminalId":T,"connectionId":C,"generation":first,"revision":5,
        "state":"disconnected","gate":"blocked","knownHostsPaths":{"target":r.fixture.path},
        "reason":"The SSH attempt was cancelled.","errorCode":"cancelled"}));
    assert_eq!(cancelled_lease, Some(SessionError::NotConnected));
    assert_eq!(cancelled_disk.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    assert_eq!(rejected_auth, Vec::<String>::new());

    // Pin Ed25519, then present a different algorithm for the same host token.
    let mut changed = Server::new(2, "alice");
    changed.host = russh::keys::decode_secret_key(include_str!("fixtures/client_rsa"), None).unwrap();
    r.fixture.use_server_for_next_connection(&changed);
    let receipt = r.ok("ssh_session_reconnect", json!({"terminalId":T})).await;
    let changed_g = generation(&receipt);
    let error = r.event(SESSION_EVENT, T, changed_g, "error").await;
    let key = changed.host.public_key();
    assert_eq!(error, json!({"terminalId":T,"connectionId":C,"generation":changed_g,"revision":2,
        "state":"error","gate":"blocked","knownHostsPaths":{"target":r.fixture.path},
        "reason":"The host key changed. Confirm the new fingerprint with the server's administrator before updating ~/.ssh/known_hosts. There is no override.",
        "errorCode":"host-key-changed",
        "promptTarget":{"connectionId":C,"host":"target.test","port":22,"user":"alice","hop":"target"},
        "hostKey":{"algorithm":key.algorithm().to_string(),
            "fingerprintSha256":key.fingerprint(ssh_key::HashAlg::Sha256).to_string(),"changed":true}}));
    assert_eq!(r.ok("ssh_session_state", json!({"terminalId":T})).await, error);
    assert_eq!(r.call("ssh_session_trust_host", trust_request(&error, true)).await,
        Err(json!({"code":"stale-attempt"})));
    assert_eq!(fs::read(&r.fixture.path).unwrap(), line.as_bytes());
    assert_eq!(*changed.counters.principals.lock(), Vec::<String>::new());
    assert_eq!(r.op(SOURCE, pi, 3, json!({"kind":"close","pi":pi})), PaneResult::Ok);
    r.pane_map(None);

    r.fixture.use_server_for_next_connection(&r.fixture.server);
    wait_until(|| r.fixture.server.counters.live_connections.load(SeqCst) == 0).await;
    wait_until(|| changed.counters.live_connections.load(SeqCst) == 0).await;
    let no_panes = r.fixture.registry.integration_snapshot(false);
    let reply = r.ok("ssh_test_connection", json!({"connectionId":C})).await;
    let probe = string(&reply, "probeId");
    let probe_g = changed_g + 1;
    let auth = r.password(&probe, probe_g, true, C).await;
    assert_eq!(r.fixture.registry.integration_snapshot(true),
        HashMap::from([(probe.clone(), (C.into(), SessionState::NeedsSecret, probe_g, Some(false)))]));
    assert_eq!(r.fixture.server.counters.live_connections.load(SeqCst), 1);
    assert_eq!(r.fixture.registry.integration_snapshot(false), no_panes);
    assert_eq!(r.ok("ssh_test_close", json!({"probeId":probe})).await, Value::Null);
    assert_eq!(r.fixture.registry.integration_snapshot(true), HashMap::new());
    assert_eq!(r.fixture.registry.integration_snapshot(false), no_panes);
    assert_eq!(r.call("ssh_test_state", json!({"probeId":probe})).await, Err(json!({"code":"not-found"})));
    assert_eq!(r.call("ssh_test_submit_secret", json!({"probeId":probe,"secret":"late",
        "remember":false,"generation":probe_g,"promptId":auth["promptId"]})).await, Err(json!({"code":"not-found"})));
    r.drain(true).await;
    assert_eq!(*r.fixture.server.counters.principals.lock(), ["alice"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_integration_duplicate_open_transfer_reconnect_close_exact_map() {
    if !isolated("ssh_integration_duplicate_open_transfer_reconnect_close_exact_map").await { return; }
    let mut r = Rig::new(Server::new(1, "alice"), true, false);
    let source = r.mount(C);
    let first = r.open(C).await;
    let connected = r.connect(first, C, false).await;
    r.pane_map(Some((C, SessionState::Connected, first, Some(false))));
    assert_eq!(r.ok("ssh_session_open", json!({"terminalId":T,"connectionId":C})).await, connected);
    r.pane_map(Some((C, SessionState::Connected, first, Some(false))));
    check_login(&r, &["alice"], 1);

    // Hold a successful exec result across revocation. Its caller may finish,
    // but with_session must fence the old generation's result.
    let (ready_tx, ready_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let registry = r.fixture.registry.clone();
    let held = tokio::spawn(async move {
        with_session(&registry, T, |session| async move {
            let result = session.exec_with("fixture-metrics", exec_opts(session.cancellation())).await;
            ready_tx.send(result.as_ref().map(|out| out.stdout.clone()).map_err(Clone::clone)).unwrap();
            release_rx.await.unwrap();
            result
        }).await
    });
    assert_eq!(timeout(WAIT, ready_rx).await.unwrap().unwrap(), Ok(b"fixture-output".to_vec()));

    let cancelled = generation(&r.ok("ssh_session_reconnect", json!({"terminalId":T})).await);
    assert!(cancelled > first);
    let prompt = r.password(T, cancelled, false, C).await;
    r.pane_map(Some((C, SessionState::NeedsSecret, cancelled, Some(false))));
    let attempt = launch_attempt(source, cancelled);
    assert_eq!(r.ok("ssh_terminal_launch", json!({"terminalId":T,"connectionId":C,"attempt":attempt})).await["stage"], "preparing");
    assert_eq!(r.ok("ssh_terminal_cancel_launch", json!({"terminalId":T,"attempt":attempt})).await["stage"], "cancelled");
    wait_until(|| r.fixture.registry.integration_snapshot(false).get(T)
        .is_some_and(|(_, _, g, task)| *g == cancelled && *task == Some(true))).await;
    r.pane_map(Some((C, SessionState::Disconnected, cancelled, Some(true))));
    wait_until(|| r.fixture.server.counters.live_connections.load(SeqCst) == 0).await;
    check_login(&r, &["alice"], 2);

    wait_until(|| r.fixture.registry.integration_retired_tasks().iter().all(|finished| *finished)).await;
    let current = generation(&r.ok("ssh_session_reconnect", json!({"terminalId":T})).await);
    assert!(current > cancelled);
    let successor_prompt = r.password(T, current, false, C).await;
    r.pane_map(Some((C, SessionState::NeedsSecret, current, Some(false))));
    let stale = r.call("ssh_session_submit_secret", json!({"terminalId":T,"secret":"late",
        "remember":false,"generation":cancelled,"promptId":prompt["promptId"]})).await;
    assert_eq!(stale, Err(json!({"code":"stale-attempt"})));
    assert_eq!(r.ok("ssh_session_state", json!({"terminalId":T})).await, successor_prompt);
    r.submit(&successor_prompt, false).await;
    on_launch_lifecycle(&r.fixture.registry, T, current, 1, LaunchState::Running, Some(PROCESS.into())).unwrap();
    let connected = r.connected(T, current, false, C).await;
    let expected = Some((C, SessionState::Connected, current, Some(false)));
    r.pane_map(expected);
    let before_late = r.payloads(SESSION_EVENT);
    release_tx.send(()).unwrap();
    assert_eq!(timeout(WAIT, held).await.unwrap().unwrap(), Err(SessionError::Cancelled));
    assert_eq!(on_launch_lifecycle(&r.fixture.registry, T, first, 2, LaunchState::Ended, Some(PROCESS.into())),
        Err(SessionError::StaleAttempt));
    assert_eq!(on_launch_lifecycle(&r.fixture.registry, T, current, 1, LaunchState::Ended, Some(PROCESS.into())),
        Err(SessionError::StaleAttempt));
    assert_eq!(r.ok("ssh_session_state", json!({"terminalId":T})).await, connected);
    assert_eq!(r.payloads(SESSION_EVENT), before_late);
    r.pane_map(expected);

    let dest = r.page(DEST);
    assert_eq!(r.op(SOURCE, source, 3, json!({"kind":"stash","tx":"move","pairs":[pane(source)]})), PaneResult::Ok);
    r.pane_map(expected);
    assert!(matches!(r.op(DEST, dest, 1, json!({"kind":"take","tx":"move"})), PaneResult::Taken { .. }));
    r.pane_map(expected);
    assert_eq!(r.op(DEST, dest, 2, json!({"kind":"adopt","tx":"move","pairs":[pane(dest)]})), PaneResult::Ok);
    r.pane_map(expected);
    {
        let state = r.state();
        let keys = state.host_table.keys();
        let placement = keys.launch_placement(DEST, T, dest, PROCESS);
        assert!(placement.is_some());
        assert_eq!(placement, keys.ssh_owner_receipt(T));
        assert_eq!(keys.launch_placement(SOURCE, T, source, PROCESS), None);
    }
    let stale_owner = r.call("ssh_terminal_launch_state", json!({"terminalId":T,
        "attempt":launch_attempt(source, current)})).await;
    assert_eq!(stale_owner, Err(json!({"code":"StaleAttempt","message":"The SSH launch attempt is no longer current."})));
    assert_eq!(r.call_from(&r.dest, "ssh_session_open", json!({"terminalId":T,"connectionId":C})).await, Ok(connected));
    assert_eq!(r.call_from(&r.dest, "ssh_session_close", json!({"terminalId":T,"generation":first})).await,
        Err(json!({"code":"stale-attempt"})));
    r.pane_map(expected);
    check_login(&r, &["alice", "alice"], 3);
    assert_eq!(r.op(DEST, dest, 3, json!({"kind":"close","pi":dest})), PaneResult::Ok);
    r.pane_map(None);
    assert_eq!(r.call("ssh_session_state", json!({"terminalId":T})).await, Err(json!({"code":"not-found"})));
    r.drain(true).await;
    check_login(&r, &["alice", "alice"], 3);
}
