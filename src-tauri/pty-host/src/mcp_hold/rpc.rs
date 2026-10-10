//! JSON-RPC 2.0 handling for the holder (plan 054 §4.4): the nesting/key
//! pre-scan, borrowed (`RawValue`) parsing, the bounded batch visitor, the
//! per-method results and the response budget.
//!
//! Everything here is a pure function of the request body and a small
//! environment ([`RpcEnv`]); the HTTP layer (`http.rs`) and the holder task
//! (054 T5) own sockets and clocks. No `serde_json::Value` tree is ever built:
//! `params` is never parsed, `id` is echoed as the raw bytes it arrived as, and
//! the snapshot results are written from the shared `Arc` without copying.

use super::message::wait_message;
use super::Mode;
use serde::de::{self, Deserializer, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::cell::{Cell, OnceCell};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use termflow_pty_protocol::McpHoldReason;

/// Deepest `[`/`{` nesting a body may have, counting the request object itself.
pub const MAX_DEPTH: usize = 64;
/// Longest object key, in raw bytes between the quotes.
pub const MAX_KEY: usize = 256;
/// Most members read from a batch.
pub const MAX_BATCH: usize = 32;
/// Largest reply the holder will write.
pub const MAX_RESPONSE: usize = 4 * 1024 * 1024;
/// Raw-length limits for the members that are parsed.
const MAX_JSONRPC_RAW: usize = 64;
const MAX_METHOD_RAW: usize = 64;
const MAX_ID_RAW: usize = 128;

const PARSE_ERROR: i32 = -32700;
const INVALID_REQUEST: i32 = -32600;
const INTERNAL_ERROR: i32 = -32603;
const HOLDING_ERROR: i32 = -32000;

/// The two snapshot results the sidecar had when it was offloaded, as validated
/// raw JSON. A result that is not valid JSON is dropped (treated as missing) so
/// the holder can never serve an unparseable reply.
#[derive(Clone, Default)]
pub struct Snapshot {
    pub initialize: Option<Arc<str>>,
    pub tools_list: Option<Arc<str>>,
}

impl Snapshot {
    /// Takes the strings from the `HoldMcp` spec (`std::mem::take` them so the
    /// spec does not retain a second copy).
    pub fn new(initialize: Option<String>, tools_list: Option<String>) -> Self {
        Self { initialize: Self::validated(initialize, "initialize"), tools_list: Self::validated(tools_list, "tools/list") }
    }

    fn validated(raw: Option<String>, what: &str) -> Option<Arc<str>> {
        let raw = raw?;
        match serde_json::from_str::<&RawValue>(&raw) {
            Ok(_) => Some(Arc::from(raw)),
            Err(_) => {
                log::warn!("[MCP-HOLD] {what} snapshot is not valid JSON; treating it as missing");
                None
            }
        }
    }
}

/// What the wait message needs, sampled by the caller once per request.
#[derive(Clone, Copy, Debug)]
pub struct Wait {
    pub mode: Mode,
    pub elapsed: Option<Duration>,
    pub remaining: Option<Duration>,
}

/// Everything `handle_body` needs besides the body.
pub struct RpcEnv<'a> {
    pub snapshot: &'a Snapshot,
    pub reason: McpHoldReason,
    pub wait: Wait,
    /// The fresh `mcp-session-id` for `initialize`; a seam so tests can count calls.
    pub new_session_id: fn() -> [u8; 16],
    /// A short, already-sanitised session id prefix, for log lines only.
    pub session_log: &'a str,
}

/// A piece of a reply body. A reply is written piece by piece, never
/// concatenated, so a large shared snapshot is never copied per connection.
#[derive(Clone)]
pub enum Piece {
    Static(&'static str),
    Owned(String),
    Shared(Arc<str>),
}

impl Piece {
    pub fn as_bytes(&self) -> &[u8] {
        match self {
            Piece::Static(s) => s.as_bytes(),
            Piece::Owned(s) => s.as_bytes(),
            Piece::Shared(s) => s.as_bytes(),
        }
    }
}

pub fn pieces_len(pieces: &[Piece]) -> usize {
    pieces.iter().map(|p| p.as_bytes().len()).sum()
}

/// What to send back for a POST body.
pub enum RpcOutcome {
    /// Notifications only: `202` with no body.
    NoContent,
    /// A JSON body, and the fresh session id (hex) when an `initialize` was answered.
    Json { body: Vec<Piece>, new_session: Option<String> },
}

// --- test gauges -----------------------------------------------------------
//
// Thread-local, so they are exact under the current-thread runtime that
// `#[tokio::test]` uses. Tests reset them before a case.

#[cfg(test)]
thread_local! {
    /// How many times serde was run on request data (top-level and per member).
    pub static SERDE_RUNS: Cell<usize> = const { Cell::new(0) };
    /// How many batch members the bounded visitor pulled.
    pub static BATCH_MEMBERS: Cell<usize> = const { Cell::new(0) };
}

fn note_serde_run() {
    #[cfg(test)]
    SERDE_RUNS.with(|c| c.set(c.get() + 1));
}

fn note_batch_member() {
    #[cfg(test)]
    BATCH_MEMBERS.with(|c| c.set(c.get() + 1));
}

// --- session ids -----------------------------------------------------------

/// 128 bits from two OS-seeded `RandomState` hashers over a counter and the
/// time. Not a secret: the holder accepts any session id.
pub fn default_session_id() -> [u8; 16] {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut out = [0u8; 16];
    for (half, chunk) in out.chunks_exact_mut(8).enumerate() {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(n);
        h.write_u128(t);
        h.write_u8(half as u8);
        chunk.copy_from_slice(&h.finish().to_be_bytes());
    }
    out
}

pub fn session_id_hex(id: &[u8; 16]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(32);
    for b in id {
        let _ = write!(s, "{b:02x}");
    }
    s
}

// --- pre-scan --------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum Scan {
    Ok,
    /// Nested deeper than [`MAX_DEPTH`].
    TooDeep,
    /// An object key longer than [`MAX_KEY`] raw bytes.
    KeyTooLong,
    /// A string with no closing quote.
    Unterminated,
}

const fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

/// One byte-level pass, aware of strings and escapes, run before serde sees
/// the body: it measures the maximum `[`/`{` depth and rejects any object key
/// (a string followed by `:`) longer than [`MAX_KEY`]. With both limits
/// serde's scratch buffer for keys stays under about 1 KiB.
pub fn prescan(body: &[u8]) -> Scan {
    let len = body.len();
    let mut depth = 0usize;
    let mut i = 0usize;
    while i < len {
        match body[i] {
            b'"' => {
                let start = i + 1;
                i = start;
                loop {
                    if i >= len {
                        return Scan::Unterminated;
                    }
                    match body[i] {
                        b'\\' => i += 2,
                        b'"' => break,
                        _ => i += 1,
                    }
                }
                let end = i;
                i += 1;
                if end - start > MAX_KEY {
                    let mut j = i;
                    while j < len && is_ws(body[j]) {
                        j += 1;
                    }
                    if j < len && body[j] == b':' {
                        return Scan::KeyTooLong;
                    }
                }
            }
            b'[' | b'{' => {
                depth += 1;
                if depth > MAX_DEPTH {
                    return Scan::TooDeep;
                }
                i += 1;
            }
            b']' | b'}' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            _ => i += 1,
        }
    }
    Scan::Ok
}

// --- parsing ---------------------------------------------------------------

/// A present field, even `null`. `Option<&RawValue>` alone would turn
/// `"id":null` into "absent" and make a null-id request look like a notification.
fn present<'de, D>(d: D) -> Result<Option<&'de RawValue>, D::Error>
where
    D: Deserializer<'de>,
{
    <&RawValue>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
struct Req<'a> {
    #[serde(borrow, default, deserialize_with = "present")]
    jsonrpc: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    method: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    id: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    params: Option<&'a RawValue>,
}

/// A valid request object.
struct Msg<'a> {
    /// The raw bytes of `id`, `None` for a notification.
    id: Option<&'a str>,
    method: String,
}

/// Validates a parsed object against the contract of plan §4.4.
fn validate<'a>(req: &Req<'a>) -> Option<Msg<'a>> {
    let jsonrpc = req.jsonrpc?.get();
    if jsonrpc.len() > MAX_JSONRPC_RAW || serde_json::from_str::<String>(jsonrpc).ok()? != "2.0" {
        return None;
    }
    let method_raw = req.method?.get();
    if method_raw.len() > MAX_METHOD_RAW {
        return None;
    }
    let method = serde_json::from_str::<String>(method_raw).ok()?;
    let id = match req.id {
        None => None,
        Some(raw) => {
            let raw = raw.get();
            let first = *raw.as_bytes().first()?;
            let kind_ok = first == b'"' || first == b'-' || first.is_ascii_digit() || raw == "null";
            if raw.len() > MAX_ID_RAW || !kind_ok {
                return None;
            }
            Some(raw)
        }
    };
    if let Some(params) = req.params {
        if !matches!(params.get().as_bytes().first(), Some(b'{' | b'[')) {
            return None;
        }
    }
    Some(Msg { id, method })
}

enum TopError {
    Parse,
    Invalid,
}

/// Parse one JSON text that is expected to be an object.
fn parse_object(text: &str) -> Result<Req<'_>, serde_json::Error> {
    note_serde_run();
    serde_json::from_str::<Req>(text)
}

struct BatchVisitor<'f> {
    too_large: &'f Cell<bool>,
}

impl<'de> Visitor<'de> for BatchVisitor<'_> {
    type Value = Vec<&'de RawValue>;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a JSON-RPC batch")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut members = Vec::new();
        while let Some(member) = seq.next_element::<&'de RawValue>()? {
            note_batch_member();
            if members.len() == MAX_BATCH {
                self.too_large.set(true);
                return Err(de::Error::custom("batch too large"));
            }
            members.push(member);
        }
        Ok(members)
    }
}

enum Batch<'a> {
    Members(Vec<&'a RawValue>),
    TooLarge,
    Unparsable,
}

fn parse_batch(text: &str) -> Batch<'_> {
    note_serde_run();
    let too_large = Cell::new(false);
    let mut de = serde_json::Deserializer::from_str(text);
    let parsed = de.deserialize_seq(BatchVisitor { too_large: &too_large });
    if too_large.get() {
        return Batch::TooLarge;
    }
    match parsed {
        Ok(members) if de.end().is_ok() => Batch::Members(members),
        _ => Batch::Unparsable,
    }
}

// --- replies ---------------------------------------------------------------

fn error_entry(id: Option<&str>, code: i32, message_json: Piece) -> Vec<Piece> {
    vec![
        Piece::Owned(format!(
            r#"{{"jsonrpc":"2.0","id":{},"error":{{"code":{code},"message":"#,
            id.unwrap_or("null")
        )),
        message_json,
        Piece::Static("}}"),
    ]
}

fn result_entry(id: &str, result: Vec<Piece>) -> Vec<Piece> {
    let mut out = Vec::with_capacity(result.len() + 2);
    out.push(Piece::Owned(format!(r#"{{"jsonrpc":"2.0","id":{id},"result":"#)));
    out.extend(result);
    out.push(Piece::Static("}"));
    out
}

fn invalid_request() -> Vec<Piece> {
    error_entry(None, INVALID_REQUEST, Piece::Static(r#""Invalid Request""#))
}

fn response_too_large(id: Option<&str>) -> Vec<Piece> {
    error_entry(id, INTERNAL_ERROR, Piece::Static(r#""response too large""#))
}

fn single(entry: Vec<Piece>) -> RpcOutcome {
    RpcOutcome::Json { body: entry, new_session: None }
}

/// Per-body state: the wait text is built once, and the first answered
/// `initialize` gets the fresh session id.
struct Answerer<'e, 'a> {
    env: &'e RpcEnv<'a>,
    wait_json: OnceCell<Arc<str>>,
    new_session: Option<String>,
}

impl Answerer<'_, '_> {
    /// The wait message as a JSON string literal (with quotes).
    fn wait_text(&self) -> Arc<str> {
        self.wait_json
            .get_or_init(|| {
                let w = self.env.wait;
                let text = wait_message(w.mode, self.env.reason, w.elapsed, w.remaining);
                // A `str` always serialises.
                Arc::from(serde_json::to_string(&text).unwrap_or_else(|_| "\"TermFlow is restarting.\"".into()))
            })
            .clone()
    }

    fn holding_error(&self, id: &str) -> Vec<Piece> {
        error_entry(Some(id), HOLDING_ERROR, Piece::Shared(self.wait_text()))
    }

    /// The reply entry for a request (`None` for a notification).
    fn answer(&mut self, msg: &Msg<'_>) -> Option<Vec<Piece>> {
        let id = msg.id?;
        log::info!("[MCP-HOLD] rpc {:?} session {}", msg.method, self.env.session_log);
        let snapshot = self.env.snapshot;
        Some(match msg.method.as_str() {
            "initialize" => match &snapshot.initialize {
                Some(result) => {
                    if self.new_session.is_none() {
                        self.new_session = Some(session_id_hex(&(self.env.new_session_id)()));
                    }
                    result_entry(id, vec![Piece::Shared(result.clone())])
                }
                None => self.holding_error(id),
            },
            "tools/list" => match &snapshot.tools_list {
                Some(result) => result_entry(id, vec![Piece::Shared(result.clone())]),
                None => self.holding_error(id),
            },
            "tools/call" => result_entry(
                id,
                vec![
                    Piece::Static(r#"{"content":[{"type":"text","text":"#),
                    Piece::Shared(self.wait_text()),
                    Piece::Static(r#"}],"isError":true}"#),
                ],
            ),
            "ping" => result_entry(id, vec![Piece::Static("{}")]),
            _ => self.holding_error(id),
        })
    }

    fn finish(self, body: Vec<Piece>) -> RpcOutcome {
        RpcOutcome::Json { body, new_session: self.new_session }
    }
}

/// Handles one POST body. Never panics on input and never builds a JSON tree.
pub fn handle_body(body: &[u8], env: &RpcEnv<'_>) -> RpcOutcome {
    match prescan(body) {
        Scan::Ok => {}
        Scan::TooDeep | Scan::KeyTooLong => return single(invalid_request()),
        Scan::Unterminated => return single(error_entry(None, PARSE_ERROR, Piece::Static(r#""Parse error""#))),
    }
    let parse_error = || single(error_entry(None, PARSE_ERROR, Piece::Static(r#""Parse error""#)));
    let Ok(text) = std::str::from_utf8(body) else {
        return parse_error();
    };
    let mut answerer = Answerer { env, wait_json: OnceCell::new(), new_session: None };
    match text.bytes().find(|b| !is_ws(*b)) {
        None => parse_error(),
        Some(b'[') => handle_batch(text, &mut answerer, parse_error),
        Some(b'{') => {
            let top = parse_object(text)
                .map_err(|e| if e.is_data() { TopError::Invalid } else { TopError::Parse })
                .and_then(|req| validate(&req).ok_or(TopError::Invalid).map(|m| answer_single(&mut answerer, &m)));
            match top {
                Ok(Some(body)) => answerer.finish(body),
                Ok(None) => RpcOutcome::NoContent,
                Err(TopError::Invalid) => single(invalid_request()),
                Err(TopError::Parse) => parse_error(),
            }
        }
        Some(_) => {
            // A scalar: valid JSON is an invalid request, anything else a parse error.
            note_serde_run();
            if serde_json::from_str::<&RawValue>(text).is_ok() {
                single(invalid_request())
            } else {
                parse_error()
            }
        }
    }
}

fn answer_single(answerer: &mut Answerer<'_, '_>, msg: &Msg<'_>) -> Option<Vec<Piece>> {
    let entry = answerer.answer(msg)?;
    if pieces_len(&entry) > MAX_RESPONSE {
        // The error replaces the whole reply, including the session id it would have minted.
        answerer.new_session = None;
        return Some(response_too_large(msg.id));
    }
    Some(entry)
}

fn handle_batch(text: &str, answerer: &mut Answerer<'_, '_>, parse_error: impl Fn() -> RpcOutcome) -> RpcOutcome {
    let members = match parse_batch(text) {
        Batch::Members(m) => m,
        Batch::TooLarge => {
            return single(error_entry(None, INVALID_REQUEST, Piece::Static(r#""batch too large""#)));
        }
        Batch::Unparsable => return parse_error(),
    };
    if members.is_empty() {
        return single(invalid_request());
    }
    let mut out: Vec<Piece> = vec![Piece::Static("[")];
    let mut total = 2usize; // the two brackets
    let mut answered = 0usize;
    for member in members {
        let entry = if member.get().starts_with('{') {
            match parse_object(member.get()).ok().and_then(|req| validate(&req)) {
                Some(msg) => answerer.answer(&msg),
                None => Some(invalid_request()),
            }
        } else {
            Some(invalid_request())
        };
        let Some(entry) = entry else { continue };
        total += pieces_len(&entry) + usize::from(answered > 0); // plus the separator
        if total > MAX_RESPONSE {
            return single(response_too_large(None));
        }
        if answered > 0 {
            out.push(Piece::Static(","));
        }
        out.extend(entry);
        answered += 1;
    }
    if answered == 0 {
        return RpcOutcome::NoContent;
    }
    out.push(Piece::Static("]"));
    let new_session = answerer.new_session.take();
    RpcOutcome::Json { body: out, new_session }
}
