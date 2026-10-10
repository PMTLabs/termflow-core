//! The `initialize` and `tools/list` snapshot the MCP sidecar's replacement serves (plan 055 §4.5).
//!
//! Speaks the SDK's streamable HTTP faithfully against the sidecar on loopback: `initialize`,
//! `notifications/initialized`, `tools/list`, then a best-effort `DELETE`. The two `result`
//! members are kept byte for byte, so the host serves exactly what the sidecar answered.

use super::types::McpLaunch;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time::{timeout_at, Instant};

/// The MCP protocol revision the SDK the sidecar is built on speaks (1.30.0).
pub(super) const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
/// One total budget for the whole snapshot, body reads and `DELETE` included.
pub(super) const SNAPSHOT_BUDGET: Duration = Duration::from_secs(2);
/// What the closing `DELETE` is always left of the budget.
const DELETE_RESERVE: Duration = Duration::from_millis(200);
/// The most one response body may carry.
pub(super) const BODY_CAP: usize = 4 * 1024 * 1024;

/// What the sidecar answered. A part that was not obtained, or was too large, is `None`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct Snapshot {
    pub initialize: Option<String>,
    pub tools_list: Option<String>,
}

enum Failure {
    Oversize,
    Other(String),
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Failure::Other(message)
    }
}

struct Session {
    id: String,
    protocol: String,
}

struct Endpoint<'a> {
    client: reqwest::Client,
    url: String,
    token: Option<&'a str>,
}

impl Endpoint<'_> {
    fn request(&self, method: reqwest::Method, session: Option<&Session>) -> reqwest::RequestBuilder {
        let mut request = self.client.request(method, &self.url).header("Accept", "application/json, text/event-stream");
        if let Some(token) = self.token {
            request = request.bearer_auth(token);
        }
        if let Some(session) = session {
            request = request.header("mcp-session-id", &session.id).header("MCP-Protocol-Version", &session.protocol);
        }
        request
    }

    fn post(&self, session: Option<&Session>, body: &Value) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::POST, session).header("Content-Type", "application/json").body(body.to_string())
    }
}

/// Ask the sidecar on `launch.port` for its `initialize` and `tools/list` results within `budget`.
/// A failure keeps what was obtained before it: the holder then runs without the missing part.
pub(super) async fn mcp_snapshot(launch: &McpLaunch, budget: Duration) -> Snapshot {
    let started = Instant::now();
    let total = started + budget;
    let steps_deadline = started + budget.saturating_sub(DELETE_RESERVE);
    let Some(client) = crate::network_commands::localhost_client(budget.as_millis() as u64) else {
        log::warn!("[MCP-HOLD] no HTTP client for the snapshot; the holder will have none");
        return Snapshot::default();
    };
    let endpoint = Endpoint { client, url: format!("http://127.0.0.1:{}/mcp", launch.port), token: launch.auth_token.as_deref() };
    let mut snapshot = Snapshot::default();
    let mut session: Option<Session> = None;
    match timeout_at(steps_deadline, run_steps(&endpoint, &mut snapshot, &mut session)).await {
        Ok(Ok(())) => {}
        Ok(Err(failure)) => log::warn!("[MCP-HOLD] snapshot incomplete: {failure}"),
        Err(_) => log::warn!("[MCP-HOLD] snapshot timed out; keeping what was obtained"),
    }
    if let Some(session) = &session {
        // Best effort, and never past the total budget: a sidecar that is slow to close the
        // session must not hold the exit up.
        let _ = timeout_at(total, endpoint.request(reqwest::Method::DELETE, Some(session)).send()).await;
    }
    snapshot
}

async fn run_steps(endpoint: &Endpoint<'_>, out: &mut Snapshot, session: &mut Option<Session>) -> Result<(), String> {
    // 1. initialize
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "termflow-handover", "version": env!("CARGO_PKG_VERSION") },
        },
    });
    let response = endpoint.post(None, &init).send().await.map_err(|e| format!("initialize: {e}"))?;
    if response.status().as_u16() != 200 {
        return Err(format!("initialize answered {}", response.status()));
    }
    let id = response
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or("initialize carried no mcp-session-id")?;
    // Recorded before the body is read: the session exists on the sidecar, so a stalled body must
    // still be closed with a DELETE.
    *session = Some(Session { id, protocol: MCP_PROTOCOL_VERSION.to_owned() });
    let content_type = content_type_of(&response);
    let body = read_body(response).await.map_err(|f| failure_text("initialize", f))?;
    let result = result_of(&content_type, &body, 1).map_err(|e| format!("initialize: {e}"))?;
    let negotiated = serde_json::from_str::<Value>(&result)
        .ok()
        .and_then(|v| v.get("protocolVersion").and_then(Value::as_str).map(str::to_owned));
    if let (Some(session), Some(negotiated)) = (session.as_mut(), negotiated) {
        session.protocol = negotiated;
    }
    out.initialize = Some(result);

    // 2. notifications/initialized
    let notified = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let response = endpoint.post(session.as_ref(), &notified).send().await.map_err(|e| format!("initialized: {e}"))?;
    if response.status().as_u16() != 202 {
        return Err(format!("notifications/initialized answered {}", response.status()));
    }

    // 3. tools/list
    let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
    let response = endpoint.post(session.as_ref(), &list).send().await.map_err(|e| format!("tools/list: {e}"))?;
    if response.status().as_u16() != 200 {
        return Err(format!("tools/list answered {}", response.status()));
    }
    let content_type = content_type_of(&response);
    let body = read_body(response).await.map_err(|f| failure_text("tools/list", f))?;
    out.tools_list = Some(result_of(&content_type, &body, 2).map_err(|e| format!("tools/list: {e}"))?);
    Ok(())
}

fn failure_text(step: &str, failure: Failure) -> String {
    match failure {
        Failure::Oversize => format!("{step} reply is over {BODY_CAP} bytes; dropped"),
        Failure::Other(e) => format!("{step}: {e}"),
    }
}

fn content_type_of(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// The body, read up to [`BODY_CAP`]: a reply that is bigger is `Oversize`, not truncated.
async fn read_body(mut response: reqwest::Response) -> Result<String, Failure> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| Failure::Other(e.to_string()))? {
        if body.len() + chunk.len() > BODY_CAP {
            return Err(Failure::Oversize);
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| Failure::Other("reply is not UTF-8".into()))
}

/// The raw `result` of the JSON-RPC response to request `id`, from a JSON or an SSE reply. An
/// `error` member, a response to another id or a reply without a response is a failure.
fn result_of(content_type: &str, body: &str, id: u64) -> Result<String, String> {
    let wanted = json!(id);
    if content_type.starts_with("text/event-stream") {
        for data in sse_data(body) {
            let Ok(message) = serde_json::from_str::<Value>(&data) else { continue };
            if message.get("id") == Some(&wanted) {
                return response_result(&message, &data);
            }
        }
        return Err(format!("no response to request {id} in the event stream"));
    }
    let message = serde_json::from_str::<Value>(body).map_err(|e| format!("reply is not JSON: {e}"))?;
    if message.get("id") != Some(&wanted) {
        return Err(format!("reply answers another request than {id}"));
    }
    response_result(&message, body)
}

fn response_result(message: &Value, text: &str) -> Result<String, String> {
    if let Some(error) = message.get("error") {
        return Err(format!("the sidecar answered an error: {error}"));
    }
    raw_member(text, "result").map(str::to_owned).ok_or_else(|| "the response has no result".to_string())
}

/// The `data` of each SSE event, in order: multi-line data is joined with `\n`, comment lines and
/// every other field are ignored, and an event without data is skipped.
fn sse_data(body: &str) -> Vec<String> {
    fn flush(data: &mut Vec<String>, events: &mut Vec<String>) {
        let joined = data.join("\n");
        data.clear();
        if !joined.is_empty() {
            events.push(joined);
        }
    }
    let text = body.replace("\r\n", "\n").replace('\r', "\n");
    let (mut events, mut data) = (Vec::new(), Vec::new());
    for line in text.split('\n') {
        if line.is_empty() {
            flush(&mut data, &mut events);
        } else if !line.starts_with(':') {
            let (field, value) = line.split_once(':').map_or((line, ""), |(f, v)| (f, v.strip_prefix(' ').unwrap_or(v)));
            if field == "data" {
                data.push(value.to_owned());
            }
        }
    }
    flush(&mut data, &mut events);
    events
}

/// The text of the top-level member `key` of the JSON object `json`, exactly as written. `json`
/// must already be known to be a valid JSON object; only the member's extent is found here.
pub(super) fn raw_member<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let bytes = json.as_bytes();
    let skip = |mut i: usize| {
        while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
            i += 1;
        }
        i
    };
    let mut i = skip(0);
    if bytes.get(i) != Some(&b'{') {
        return None;
    }
    i += 1;
    loop {
        i = skip(i);
        match bytes.get(i)? {
            b'}' => return None,
            b',' => {
                i += 1;
                continue;
            }
            b'"' => {}
            _ => return None,
        }
        let name_end = string_end(bytes, i)?;
        let name: String = serde_json::from_str(&json[i..name_end]).ok()?;
        i = skip(name_end);
        if bytes.get(i) != Some(&b':') {
            return None;
        }
        i = skip(i + 1);
        let value_end = value_end(bytes, i)?;
        if name == key {
            return Some(&json[i..value_end]);
        }
        i = value_end;
    }
}

/// The index just past the string literal that opens at `start`.
fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while let Some(&b) = bytes.get(i) {
        match b {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// The index just past the JSON value that starts at `start`.
fn value_end(bytes: &[u8], start: usize) -> Option<usize> {
    match *bytes.get(start)? {
        b'"' => string_end(bytes, start),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut i = start;
            while let Some(&b) = bytes.get(i) {
                match b {
                    b'"' => {
                        i = string_end(bytes, i)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(i + 1);
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            None
        }
        _ => {
            let mut i = start;
            while bytes.get(i).is_some_and(|b| !matches!(b, b',' | b'}' | b']') && !b.is_ascii_whitespace()) {
                i += 1;
            }
            Some(i)
        }
    }
}
