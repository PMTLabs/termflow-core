//! The snapshot client against an in-test HTTP fixture that reproduces what the SDK's streamable
//! HTTP transport (1.30.0) enforces, plus one rule stricter than the SDK, so a client that only
//! works against a lenient server fails here.

use super::mcp_handover::fit_to_frame;
use super::mcp_snapshot::{mcp_snapshot, Snapshot, BODY_CAP, MCP_PROTOCOL_VERSION, SNAPSHOT_BUDGET};
use super::types::McpLaunch;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use termflow_pty_protocol::{encode, read_frame, write_frame, Control, Frame, McpHoldReason, McpHoldSpec, MAX_FRAME_LEN};

/// What the fixture negotiates: deliberately not the client's constant, so a client that sends its
/// own constant on later requests instead of the negotiated one is caught.
const NEGOTIATED: &str = "2025-06-18";
const SESSION: &str = "session-7f3a";
const TOKEN: &str = "fixture-bearer-1";
/// Non-canonical on purpose: key order, spacing and an escaped quote must survive byte for byte.
pub(crate) const INIT_RESULT: &str = r#"{ "serverInfo" : {"version":"1.0.0","name":"termflow-mcp"},  "protocolVersion":"2025-06-18", "capabilities":{"tools":{ "listChanged":true }} }"#;
pub(crate) const LIST_RESULT: &str = r#"{"tools":[ {"name":"zeta","description":"a \"quoted\" } brace","inputSchema":{"type":"object"}},   {"name":"alpha"} ] ,"nextCursor":null}"#;

#[derive(Clone, Default)]
pub(crate) struct Config {
    token: Option<String>,
    sse: bool,
    sse_noise: bool,
    multiline_sse: bool,
    list_error: bool,
    stall_after_initialize: bool,
    stall_everything: bool,
    slow_delete: Duration,
    notify_status: Option<u16>,
    wrong_id_on_list: bool,
    init_result: Option<String>,
    list_result: Option<String>,
}

/// What a `tools/list` error carries in its message and its `data`: response body, never logged.
const ERROR_MESSAGE_SENTINEL: &str = "ERRMSG_SENTINEL_41b7";
const ERROR_DATA_SENTINEL: &str = "ERRDATA_SENTINEL_9d02";

/// An open-or-bearer fixture whose two results are as big as a reply may be: each body is exactly
/// [`BODY_CAP`] bytes, so each part is accepted alone. Returns the config and both results.
pub(crate) fn config_at_the_body_cap(token: &str) -> (Config, String, String) {
    // The fixture's JSON envelope around a result (`rpc`), ids 1 and 2 are the same width.
    let envelope = r#"{ "result" : , "jsonrpc":"2.0", "id": 1 }"#.len();
    let fill = |head: &str| {
        let shell = format!(r#"{{{head}"pad":""}}"#).len();
        format!(r#"{{{head}"pad":"{}"}}"#, "p".repeat(BODY_CAP - envelope - shell))
    };
    let init = fill(&format!(r#""protocolVersion":"{NEGOTIATED}","#));
    let list = fill(r#""tools":[],"#);
    let config = Config { token: Some(token.into()), init_result: Some(init.clone()), list_result: Some(list.clone()), ..open() };
    (config, init, list)
}

// ---- captured logs (one logger per test binary; every test that reads logs installs this one) ----

static CAPTURED: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct Capture;

impl log::Log for Capture {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        CAPTURED.lock().unwrap().push(record.args().to_string());
    }
    fn flush(&self) {}
}

/// Route every log line of this test binary into [`captured_logs`].
pub(crate) fn capture_logs() {
    static CAPTURE: Capture = Capture;
    let _ = log::set_logger(&CAPTURE);
    log::set_max_level(log::LevelFilter::Info);
}

pub(crate) fn captured_logs() -> Vec<String> {
    CAPTURED.lock().unwrap().clone()
}

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    authorization: Option<String>,
    session: Option<String>,
    protocol: Option<String>,
    body: Value,
}

#[derive(Default)]
struct Shared {
    config: Config,
    seen: Mutex<Vec<Seen>>,
    initialized: Mutex<bool>,
    closed: Mutex<bool>,
}

pub(crate) struct Fixture {
    pub(crate) port: u16,
    shared: Arc<Shared>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Fixture {
    pub(crate) async fn start(config: Config) -> Fixture {
        let shared = Arc::new(Shared { config, ..Shared::default() });
        let app = axum::Router::new().route("/mcp", axum::routing::any(handle)).with_state(shared.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Fixture { port, shared, task }
    }

    pub(crate) fn launch(&self) -> McpLaunch {
        McpLaunch { port: self.port, bind_host: "127.0.0.1".into(), auth_token: self.shared.config.token.clone() }
    }

    fn seen(&self) -> Vec<Seen> {
        self.shared.seen.lock().unwrap().clone()
    }

    /// How many requests the fixture has received.
    pub(crate) fn requests(&self) -> usize {
        self.shared.seen.lock().unwrap().len()
    }

    fn closed(&self) -> bool {
        *self.shared.closed.lock().unwrap()
    }
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

fn reply(status: u16) -> axum::http::response::Builder {
    Response::builder().status(StatusCode::from_u16(status).unwrap())
}

async fn handle(State(shared): State<Arc<Shared>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let headers = &parts.headers;
    let seen = Seen {
        method: parts.method.to_string(),
        authorization: header(headers, "authorization"),
        session: header(headers, "mcp-session-id"),
        protocol: header(headers, "mcp-protocol-version"),
        body: body.clone(),
    };
    shared.seen.lock().unwrap().push(seen.clone());
    let config = &shared.config;
    if config.stall_everything {
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
    if let Some(token) = &config.token {
        if seen.authorization.as_deref() != Some(&format!("Bearer {token}")) {
            return reply(401).body(Body::empty()).unwrap();
        }
    }
    let session_ok = |seen: &Seen| match seen.session.as_deref() {
        None => Err(400),
        Some(SESSION) => Ok(()),
        Some(_) => Err(404),
    };
    if parts.method == Method::DELETE {
        if let Err(status) = session_ok(&seen) {
            return reply(status).body(Body::empty()).unwrap();
        }
        tokio::time::sleep(config.slow_delete).await;
        *shared.closed.lock().unwrap() = true;
        return reply(200).body(Body::empty()).unwrap();
    }
    if parts.method != Method::POST {
        return reply(405).body(Body::empty()).unwrap();
    }
    let accept = header(headers, "accept").unwrap_or_default();
    if !(accept.contains("application/json") && accept.contains("text/event-stream")) {
        return reply(406).body(Body::empty()).unwrap();
    }
    if !header(headers, "content-type").unwrap_or_default().starts_with("application/json") {
        return reply(415).body(Body::empty()).unwrap();
    }
    let method = body.get("method").and_then(Value::as_str).unwrap_or_default().to_owned();
    let id = body.get("id").cloned();
    if method == "initialize" {
        let params = &body["params"];
        if ["protocolVersion", "capabilities", "clientInfo"].iter().any(|k| params.get(k).is_none()) {
            return reply(400).body(Body::empty()).unwrap();
        }
        let result = config.init_result.clone().unwrap_or_else(|| INIT_RESULT.to_owned());
        return rpc(config, id.unwrap(), &result, Some(SESSION));
    }
    if let Err(status) = session_ok(&seen) {
        return reply(status).body(Body::empty()).unwrap();
    }
    if seen.protocol.as_deref() != Some(NEGOTIATED) {
        return reply(400).body(Body::empty()).unwrap();
    }
    match method.as_str() {
        "notifications/initialized" => {
            if config.stall_after_initialize {
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
            *shared.initialized.lock().unwrap() = true;
            reply(config.notify_status.unwrap_or(202)).body(Body::empty()).unwrap()
        }
        // Stricter than the SDK: a list before the client said it is initialized is refused.
        "tools/list" if !*shared.initialized.lock().unwrap() => reply(400).body(Body::empty()).unwrap(),
        "tools/list" if config.list_error => {
            let error = json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32603, "message": ERROR_MESSAGE_SENTINEL, "data": { "token": ERROR_DATA_SENTINEL } },
            })
            .to_string();
            Response::builder().header("content-type", "application/json").body(Body::from(error)).unwrap()
        }
        "tools/list" => {
            let id = if config.wrong_id_on_list { json!(99) } else { id.unwrap() };
            let result = config.list_result.clone().unwrap_or_else(|| LIST_RESULT.to_owned());
            rpc(config, id, &result, None)
        }
        _ => reply(400).body(Body::empty()).unwrap(),
    }
}

/// A JSON-RPC response carrying `result` verbatim, as JSON or as an event stream.
fn rpc(config: &Config, id: Value, result: &str, session: Option<&str>) -> Response {
    let message = format!(r#"{{ "result" : {result}, "jsonrpc":"2.0", "id": {id} }}"#);
    let mut builder = Response::builder();
    if let Some(session) = session {
        builder = builder.header("mcp-session-id", session);
    }
    if !config.sse {
        return builder.header("content-type", "application/json").body(Body::from(message)).unwrap();
    }
    let mut stream = String::new();
    if config.sse_noise {
        stream.push_str(": keep-alive\n\n");
        stream.push_str("id: 5\ndata:\n\n");
        stream.push_str("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":99,\"result\":{\"other\":true}}\n\n");
    }
    if config.multiline_sse {
        // The same message with a line break inside it, split across two data lines.
        let (head, tail) = message.split_at(message.find("\"jsonrpc\"").unwrap());
        stream.push_str(&format!("event: message\ndata: {head}\ndata: {tail}\n\n"));
    } else {
        stream.push_str(&format!("event: message\r\nid: 7\r\ndata: {message}\r\n\r\n"));
    }
    builder.header("content-type", "text/event-stream").body(Body::from(stream)).unwrap()
}

pub(crate) fn open() -> Config {
    Config::default()
}

/// An open fixture, or one that requires `token` as its bearer.
pub(crate) fn config_with_token(token: Option<&str>) -> Config {
    Config { token: token.map(str::to_owned), ..open() }
}

async fn snapshot_of(fixture: &Fixture) -> (Snapshot, Duration) {
    let started = Instant::now();
    let snapshot = mcp_snapshot(&fixture.launch(), SNAPSHOT_BUDGET).await;
    (snapshot, started.elapsed())
}

fn both(snapshot: &Snapshot) -> (Option<&str>, Option<&str>) {
    (snapshot.initialize.as_deref(), snapshot.tools_list.as_deref())
}

const WITHIN_BUDGET: Duration = Duration::from_millis(2100);

// ---- the fixture is stricter than a lenient client --------------------------------------------

#[tokio::test]
async fn the_fixture_refuses_what_the_sdk_refuses() {
    let fixture = Fixture::start(open()).await;
    let url = format!("http://127.0.0.1:{}/mcp", fixture.port);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let initialize = |params: Value| json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":params}).to_string();
    let full = json!({"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name":"t","version":"1"}});
    let post = |accept: &str, content_type: &str, body: String| {
        client.post(&url).header("accept", accept).header("content-type", content_type).body(body)
    };
    let both_types = "application/json, text/event-stream";

    let status = |request: reqwest::RequestBuilder| async move { request.send().await.unwrap().status().as_u16() };
    assert_eq!(status(post("application/json", "application/json", initialize(full.clone()))).await, 406, "one Accept type");
    assert_eq!(status(post("text/event-stream", "application/json", initialize(full.clone()))).await, 406, "the other");
    assert_eq!(status(post(both_types, "text/plain", initialize(full.clone()))).await, 415, "content type");
    assert_eq!(status(post(both_types, "application/json", initialize(json!({})))).await, 400, "params missing");
    let list = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}).to_string();
    assert_eq!(status(post(both_types, "application/json", list.clone())).await, 400, "no session id");
    assert_eq!(status(post(both_types, "application/json", list).header("mcp-session-id", "other")).await, 404, "wrong session");
    assert_eq!(status(client.delete(&url).header("mcp-session-id", "other")).await, 404, "DELETE with a wrong session");
    // Stricter than the SDK: a list before `notifications/initialized` is refused.
    let list = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}).to_string();
    let early = post(both_types, "application/json", list).header("mcp-session-id", SESSION).header("mcp-protocol-version", NEGOTIATED);
    assert_eq!(status(early).await, 400, "tools/list before initialized");
}

// ---- results ---------------------------------------------------------------------------------

#[tokio::test]
async fn json_and_sse_replies_give_the_results_byte_for_byte() {
    for (name, config) in [
        ("json", open()),
        ("sse", Config { sse: true, ..open() }),
        ("sse with an empty event, a comment and another id's event", Config { sse: true, sse_noise: true, ..open() }),
    ] {
        let fixture = Fixture::start(config).await;
        let (snapshot, _) = snapshot_of(&fixture).await;
        assert_eq!(both(&snapshot), (Some(INIT_RESULT), Some(LIST_RESULT)), "{name}");
    }
}

#[tokio::test]
async fn a_result_split_over_two_data_lines_is_joined_and_parsed() {
    let fixture = Fixture::start(Config { sse: true, multiline_sse: true, ..open() }).await;
    let (snapshot, _) = snapshot_of(&fixture).await;
    let (initialize, tools) = both(&snapshot);
    let (initialize, tools) = (initialize.expect("initialize"), tools.expect("tools/list"));
    // The line break sits between members, so the parts equal the fixture's up to that whitespace.
    assert_eq!(serde_json::from_str::<Value>(initialize).unwrap(), serde_json::from_str::<Value>(INIT_RESULT).unwrap());
    assert_eq!(serde_json::from_str::<Value>(tools).unwrap(), serde_json::from_str::<Value>(LIST_RESULT).unwrap());
}

#[tokio::test]
async fn a_json_reply_to_another_request_fails_that_step_only() {
    let fixture = Fixture::start(Config { wrong_id_on_list: true, ..open() }).await;
    let (snapshot, _) = snapshot_of(&fixture).await;
    assert_eq!(both(&snapshot), (Some(INIT_RESULT), None));
    assert!(fixture.closed(), "and the session is still closed");
}

// ---- what the client sends --------------------------------------------------------------------

#[tokio::test]
async fn the_requests_are_the_sdks_handshake_with_the_negotiated_version_and_the_session() {
    for token in [None, Some(TOKEN)] {
        let fixture = Fixture::start(Config { token: token.map(str::to_owned), ..open() }).await;
        let (snapshot, _) = snapshot_of(&fixture).await;
        assert!(snapshot.initialize.is_some() && snapshot.tools_list.is_some(), "token={token:?}");

        let seen = fixture.seen();
        let methods: Vec<_> = seen.iter().map(|s| s.method.as_str()).collect();
        assert_eq!(methods, ["POST", "POST", "POST", "DELETE"], "initialize, initialized, list, close");
        let init = &seen[0].body;
        assert_eq!(init["id"], 1);
        assert_eq!(init["method"], "initialize");
        assert_eq!(init["params"]["protocolVersion"], "2025-11-25", "the pinned revision");
        assert_eq!(MCP_PROTOCOL_VERSION, "2025-11-25");
        assert!(init["params"]["capabilities"].is_object());
        assert_eq!(init["params"]["clientInfo"]["name"], "termflow-handover");
        assert!(init["params"]["clientInfo"]["version"].as_str().is_some_and(|v| !v.is_empty()));
        assert_eq!(seen[1].body["method"], "notifications/initialized");
        assert!(seen[1].body.get("id").is_none(), "a notification has no id");
        assert_eq!((seen[2].body["id"].clone(), seen[2].body["method"].clone()), (json!(2), json!("tools/list")));
        assert_eq!(seen[0].session, None, "initialize opens the session");
        for later in &seen[1..] {
            assert_eq!(later.session.as_deref(), Some(SESSION), "{}: the session id", later.method);
            assert_eq!(later.protocol.as_deref(), Some(NEGOTIATED), "{}: the negotiated version, not the constant", later.method);
        }
        for request in &seen {
            let expected = token.map(|t| format!("Bearer {t}"));
            assert_eq!(request.authorization, expected, "{}: Authorization present iff a token is set", request.method);
        }
        assert!(fixture.closed());
    }
}

#[tokio::test]
async fn the_session_is_closed_after_a_list_error_too() {
    let fixture = Fixture::start(Config { list_error: true, ..open() }).await;
    let (snapshot, _) = snapshot_of(&fixture).await;
    assert_eq!(both(&snapshot), (Some(INIT_RESULT), None), "the error fails that step, keeps the other");
    assert!(fixture.closed());
    assert_eq!(fixture.seen().last().unwrap().method, "DELETE");
}

#[tokio::test]
async fn a_sidecar_error_is_logged_by_its_code_and_never_by_its_body() {
    capture_logs();
    let fixture = Fixture::start(Config { list_error: true, ..open() }).await;
    let (snapshot, _) = snapshot_of(&fixture).await;
    assert_eq!(both(&snapshot), (Some(INIT_RESULT), None), "the snapshot still degrades normally");
    assert!(fixture.closed(), "and the session is closed");

    let lines = captured_logs();
    assert!(lines.iter().any(|l| l.contains("snapshot incomplete: tools/list: the sidecar answered error code -32603")), "{lines:?}");
    for sentinel in [ERROR_MESSAGE_SENTINEL, ERROR_DATA_SENTINEL] {
        assert!(lines.iter().all(|l| !l.contains(sentinel)), "the error body reached the log: {sentinel}");
    }
}

#[tokio::test]
async fn a_refused_initialized_notification_keeps_initialize_and_still_closes_the_session() {
    let fixture = Fixture::start(Config { notify_status: Some(400), ..open() }).await;
    let (snapshot, _) = snapshot_of(&fixture).await;
    assert_eq!(both(&snapshot), (Some(INIT_RESULT), None));
    let seen = fixture.seen();
    assert_eq!(seen.last().unwrap().method, "DELETE");
    assert_eq!(seen.last().unwrap().session.as_deref(), Some(SESSION));
    assert!(seen.iter().all(|s| s.body["method"] != "tools/list"), "no list after a refused initialized");
}

// ---- the budget -------------------------------------------------------------------------------

#[tokio::test]
async fn a_stall_after_initialize_keeps_initialize_within_budget_and_tries_to_close() {
    let fixture = Fixture::start(Config { stall_after_initialize: true, ..open() }).await;
    let (snapshot, took) = snapshot_of(&fixture).await;
    assert_eq!(both(&snapshot), (Some(INIT_RESULT), None));
    assert!(took <= WITHIN_BUDGET, "{took:?}");
    assert_eq!(fixture.seen().last().unwrap().method, "DELETE", "the close was attempted");
    assert!(fixture.closed());
}

#[tokio::test]
async fn a_host_that_never_answers_gives_nothing_within_budget() {
    let fixture = Fixture::start(Config { stall_everything: true, ..open() }).await;
    let (snapshot, took) = snapshot_of(&fixture).await;
    assert_eq!(both(&snapshot), (None, None));
    assert!(took <= WITHIN_BUDGET, "{took:?}");
    assert!(fixture.seen().iter().all(|s| s.method != "DELETE"), "there is no session to close");
}

#[tokio::test]
async fn a_slow_close_keeps_both_parts_within_budget() {
    let fixture = Fixture::start(Config { slow_delete: Duration::from_secs(10), ..open() }).await;
    let (snapshot, took) = snapshot_of(&fixture).await;
    assert_eq!(both(&snapshot), (Some(INIT_RESULT), Some(LIST_RESULT)));
    assert!(took <= WITHIN_BUDGET, "{took:?}");
}

// ---- sizes ------------------------------------------------------------------------------------

#[tokio::test]
async fn an_oversize_tools_list_is_dropped_and_initialize_kept() {
    let huge = format!(r#"{{"pad":"{}"}}"#, "a".repeat(BODY_CAP + 16));
    let fixture = Fixture::start(Config { list_result: Some(huge), ..open() }).await;
    let (snapshot, _) = snapshot_of(&fixture).await;
    assert_eq!(both(&snapshot), (Some(INIT_RESULT), None));
    assert!(fixture.closed());
}

fn spec_with(initialize: usize, tools: usize) -> McpHoldSpec {
    McpHoldSpec {
        port: 4310,
        configured_port: 4300,
        bind_host: "127.0.0.1".into(),
        auth_token: Some("t".repeat(64)),
        reason: McpHoldReason::Offload,
        initialize_result: Some("i".repeat(initialize)),
        tools_list_result: Some("l".repeat(tools)),
    }
}

fn payload_len(spec: &McpHoldSpec, token: &str) -> usize {
    encode(&Frame::Ctrl(Control::HoldMcp { req: u64::MAX, token: token.into(), spec: spec.clone() })).len() - 5
}

#[tokio::test]
async fn two_parts_that_each_fit_but_together_exceed_the_frame_cap_lose_the_tool_list() {
    let spec = spec_with(BODY_CAP - 1, BODY_CAP - 1);
    assert!(payload_len(&spec, "tok") > MAX_FRAME_LEN, "the premise: each part is under the cap, the frame is not");

    let fitted = fit_to_frame(spec.clone(), "tok");

    assert_eq!(fitted.tools_list_result, None, "the tool list goes first");
    assert_eq!(fitted.initialize_result, spec.initialize_result, "initialize is kept");
    assert!(payload_len(&fitted, "tok") <= MAX_FRAME_LEN);
    // The frame that is sent is one the host's reader accepts.
    let (mut writer, mut reader) = tokio::io::duplex(1 << 20);
    let frame = Frame::Ctrl(Control::HoldMcp { req: 1, token: "tok".into(), spec: fitted.clone() });
    let (sent, received) = tokio::join!(write_frame(&mut writer, &frame), read_frame(&mut reader));
    sent.unwrap();
    assert_eq!(received.unwrap(), Some(frame));
}

#[test]
fn a_spec_that_fits_is_left_whole_and_a_token_can_tip_it_over() {
    let spec = spec_with(1000, 2000);
    assert_eq!(fit_to_frame(spec.clone(), "tok"), spec);

    // Only the credential the frame carries is what pushes this one over: the measure includes it.
    let mut edge = spec_with(0, 0);
    edge.tools_list_result = None;
    let base = payload_len(&edge, "");
    edge.initialize_result = Some("i".repeat(MAX_FRAME_LEN - base));
    assert_eq!(payload_len(&edge, ""), MAX_FRAME_LEN, "exactly at the cap");
    assert_eq!(fit_to_frame(edge.clone(), ""), edge, "at the cap is allowed");
    assert_eq!(fit_to_frame(edge.clone(), "x").initialize_result, None, "one byte of credential more and it no longer fits");
}

// ---- the parsing helpers ------------------------------------------------------------------------

#[test]
fn the_raw_member_is_found_whatever_surrounds_it() {
    use super::mcp_snapshot::raw_member as raw;
    assert_eq!(raw(r#"{"a":1,"result":{"x":[1,2,{"y":"}"}]},"b":2}"#, "result"), Some(r#"{"x":[1,2,{"y":"}"}]}"#));
    assert_eq!(raw(r#"{ "result" : "a \" b" }"#, "result"), Some(r#""a \" b""#));
    assert_eq!(raw(r#"{"a":{"result":1},"result":2}"#, "result"), Some("2"), "only a top-level member");
    assert_eq!(raw(r#"{"result":null}"#, "result"), Some("null"), "an escaped key is the same key");
    assert_eq!(raw(r#"{"id":1}"#, "result"), None);
    assert_eq!(raw(r#"{"result":  [ ] }"#, "result"), Some("[ ]"));
}
