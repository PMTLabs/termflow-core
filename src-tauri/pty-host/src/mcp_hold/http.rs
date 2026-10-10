//! The holder's minimal, bounded HTTP/1.1 layer (plan 054 §4.4): request
//! reading with hard limits, constant-time bearer auth, routing, and reply
//! writing with a per-write deadline.
//!
//! [`handle_connection`] serves exactly one request on a stream and is generic
//! over the stream, so tests drive it over `tokio::io::duplex` and the holder
//! task (054 T5) drives it over accepted sockets. It does no accepting, no
//! permit accounting and no stop handling: the caller owns those. A
//! `GET /mcp` is authenticated and then handed back as [`Handled::Sse`]; the
//! caller decides (SSE semaphore) whether to open it with [`write_sse_open`]
//! or refuse it with [`write_status`], then owns the ping loop.

use super::rpc::{self, handle_body, Piece, RpcEnv, RpcOutcome, Snapshot, Wait};
use std::io;
use std::time::Duration;
use termflow_pty_protocol::McpHoldReason;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::{timeout, timeout_at, Instant};

/// Request line plus headers, including the blank line that ends them.
pub const MAX_HEAD: usize = 16 * 1024;
/// Largest body, by `Content-Length` only.
pub const MAX_BODY: usize = 256 * 1024;
/// A whole request (head and body) must arrive within this.
pub const READ_DEADLINE: Duration = Duration::from_secs(10);
/// Every single write must complete within this.
pub const WRITE_DEADLINE: Duration = Duration::from_secs(5);
/// What the SSE loop writes every 5 s (the caller owns the timer).
pub const SSE_PING: &str = ": ping\n\n";
const SSE_PREAMBLE: &str = ": holding\n\n";
const MAX_SESSION_ID: usize = 128;

/// Everything a connection needs. Built by the holder per connection from
/// shared state; borrowed so nothing is copied per request.
pub struct HoldCtx<'a> {
    /// The sidecar's bearer token; `None` or empty means open.
    pub auth_token: Option<&'a str>,
    pub snapshot: &'a Snapshot,
    pub reason: McpHoldReason,
    /// Sampled once per POST: mode, elapsed and remaining for the wait message.
    /// `Sync`, so the connection future that holds the context is `Send`.
    pub wait: &'a (dyn Fn() -> Wait + Sync),
    /// The fresh session id for `initialize` (a seam; production passes
    /// [`rpc::default_session_id`]).
    pub new_session_id: fn() -> [u8; 16],
}

/// An authenticated `GET /mcp`, not yet answered.
#[derive(Debug, PartialEq, Eq)]
pub struct SseOpen {
    /// The request's `mcp-session-id`, if it was a sane value; echoed back.
    pub session_id: Option<String>,
}

/// What `handle_connection` did with the stream.
#[derive(Debug, PartialEq, Eq)]
pub enum Handled {
    /// A reply was written and the stream shut down.
    Replied,
    /// The stream was dropped without a reply (EOF, deadline, limit, write error).
    Closed,
    /// An authenticated `GET /mcp`; nothing has been written yet.
    Sse(SseOpen),
}

// --- test gauge ------------------------------------------------------------

#[cfg(test)]
thread_local! {
    /// Peak bytes buffered for one connection's input (head buffer plus body).
    /// Thread-local: exact under `#[tokio::test]`'s current-thread runtime.
    pub static BUFFERED_PEAK: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn note_buffered(bytes: usize) {
    #[cfg(test)]
    BUFFERED_PEAK.with(|c| c.set(c.get().max(bytes)));
    #[cfg(not(test))]
    let _ = bytes;
}

// --- request reading -------------------------------------------------------

#[derive(Debug)]
enum Reject {
    /// Drop the connection without a reply.
    Close,
    /// Reply with this status and close.
    Status(u16),
}

#[derive(Default)]
struct Head {
    method: String,
    path: String,
    authorization: Vec<String>,
    session_id: Option<String>,
    content_length: Vec<String>,
    transfer_encoding: bool,
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

fn parse_head(text: &str) -> Result<Head, Reject> {
    let bad = || Reject::Status(400);
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or_else(bad)?;
    let mut parts = request_line.split(' ');
    let (method, target, version) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(m), Some(t), Some(v), None) => (m, t, v),
        _ => return Err(bad()),
    };
    if method.is_empty() || method.len() > 16 || !method.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(bad());
    }
    if !target.starts_with('/') || target.bytes().any(|b| b.is_ascii_control()) {
        return Err(bad());
    }
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(bad());
    }
    let mut head = Head {
        method: method.to_string(),
        path: target.split(['?', '#']).next().unwrap_or("").to_string(),
        ..Head::default()
    };
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(bad());
        };
        if name.is_empty() || !name.bytes().all(is_token_byte) {
            return Err(bad());
        }
        let value = value.trim_matches([' ', '\t']);
        if value.bytes().any(|b| b.is_ascii_control() && b != b'\t') {
            return Err(bad());
        }
        if name.eq_ignore_ascii_case("authorization") {
            head.authorization.push(value.to_string());
        } else if name.eq_ignore_ascii_case("content-length") {
            head.content_length.push(value.to_string());
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            head.transfer_encoding = true;
        } else if name.eq_ignore_ascii_case("mcp-session-id") && head.session_id.is_none() {
            head.session_id = Some(value.to_string());
        }
    }
    Ok(head)
}

/// The body length the head promises, or the status to refuse it with.
fn body_length(head: &Head) -> Result<usize, u16> {
    if head.transfer_encoding {
        return Err(411);
    }
    match head.content_length.as_slice() {
        [] => Ok(0),
        [one] => {
            if one.is_empty() || !one.bytes().all(|b| b.is_ascii_digit()) {
                return Err(400);
            }
            // More digits than any allowed length has is over the cap, never an overflow.
            match one.parse::<usize>() {
                Ok(n) if n <= MAX_BODY => Ok(n),
                _ => Err(413),
            }
        }
        _ => Err(400),
    }
}

/// Reads until the blank line, never buffering more than `MAX_HEAD` plus one
/// read chunk. Returns the head, the buffer, and where the head ends in it.
async fn read_head<R: AsyncRead + Unpin>(r: &mut R) -> Result<(Head, Vec<u8>, usize), Reject> {
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(end) = find_head_end(&buf[..buf.len().min(MAX_HEAD)]) {
            break end;
        }
        if buf.len() >= MAX_HEAD {
            return Err(Reject::Close);
        }
        let n = r.read(&mut chunk).await.map_err(|_| Reject::Close)?;
        if n == 0 {
            return Err(Reject::Close);
        }
        buf.extend_from_slice(&chunk[..n]);
        note_buffered(buf.capacity());
    };
    let text = std::str::from_utf8(&buf[..head_end - 4]).map_err(|_| Reject::Status(400))?;
    let head = parse_head(text)?;
    Ok((head, buf, head_end))
}

async fn read_body<R: AsyncRead + Unpin>(
    r: &mut R,
    buf: &[u8],
    buf_capacity: usize,
    head_end: usize,
    len: usize,
) -> Result<Vec<u8>, Reject> {
    let mut body = Vec::with_capacity(len);
    note_buffered(buf_capacity + body.capacity());
    let already = &buf[head_end..];
    body.extend_from_slice(&already[..already.len().min(len)]);
    let mut chunk = [0u8; 8192];
    while body.len() < len {
        let want = (len - body.len()).min(chunk.len());
        let n = r.read(&mut chunk[..want]).await.map_err(|_| Reject::Close)?;
        if n == 0 {
            return Err(Reject::Close);
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Ok(body)
}

// --- auth ------------------------------------------------------------------

/// Constant-time equality of two byte strings (same shape as `safeEqual` in
/// `mcp-server/src/index.ts`: lengths first, then every byte folded together).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Exactly one `Authorization: Bearer <token>` header with the right token.
fn authorized(head: &Head, token: &str) -> bool {
    let [value] = head.authorization.as_slice() else {
        return false;
    };
    let Some(prefix) = value.get(..7) else {
        return false;
    };
    prefix.eq_ignore_ascii_case("bearer ") && ct_eq(&value.as_bytes()[7..], token.as_bytes())
}

// --- replies ---------------------------------------------------------------

struct Reply {
    status: u16,
    content_type: Option<&'static str>,
    extra: Vec<(&'static str, String)>,
    body: Vec<Piece>,
}

impl Reply {
    fn status(status: u16) -> Self {
        Self { status, content_type: None, extra: Vec::new(), body: Vec::new() }
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        411 => "Length Required",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

/// One write with the per-write deadline.
pub async fn write_deadline<W: AsyncWrite + Unpin>(w: &mut W, bytes: &[u8]) -> io::Result<()> {
    match timeout(WRITE_DEADLINE, w.write_all(bytes)).await {
        Ok(r) => r,
        Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "write deadline")),
    }
}

async fn write_reply<W: AsyncWrite + Unpin>(w: &mut W, reply: &Reply) -> io::Result<()> {
    let len = rpc::pieces_len(&reply.body);
    let mut head = format!("HTTP/1.1 {} {}\r\n", reply.status, reason_phrase(reply.status));
    if let Some(ct) = reply.content_type {
        head.push_str(&format!("Content-Type: {ct}\r\n"));
    }
    for (name, value) in &reply.extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!("Content-Length: {len}\r\nConnection: close\r\n\r\n"));
    write_deadline(w, head.as_bytes()).await?;
    for piece in &reply.body {
        write_deadline(w, piece.as_bytes()).await?;
    }
    timeout(WRITE_DEADLINE, w.flush()).await.unwrap_or(Ok(()))
}

/// Writes a body-less status reply and shuts the stream down. For the caller's
/// own refusals (the ninth SSE stream gets `503`).
pub async fn write_status<W: AsyncWrite + Unpin>(w: &mut W, status: u16) -> io::Result<()> {
    let r = write_reply(w, &Reply::status(status)).await;
    let _ = timeout(WRITE_DEADLINE, w.shutdown()).await;
    r
}

/// Opens the event stream: the headers (echoing the session id) and the
/// `: holding` comment. The caller then writes [`SSE_PING`] every 5 s until stop.
pub async fn write_sse_open<W: AsyncWrite + Unpin>(w: &mut W, open: &SseOpen) -> io::Result<()> {
    let mut head = String::from(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n",
    );
    if let Some(id) = &open.session_id {
        head.push_str(&format!("mcp-session-id: {id}\r\n"));
    }
    head.push_str("\r\n");
    head.push_str(SSE_PREAMBLE);
    write_deadline(w, head.as_bytes()).await?;
    timeout(WRITE_DEADLINE, w.flush()).await.unwrap_or(Ok(()))
}

// --- the connection --------------------------------------------------------

/// A session id worth echoing: visible ASCII, bounded. Anything else is simply
/// not echoed (and can never reach a header line).
fn clean_session_id(raw: Option<&str>) -> Option<String> {
    let id = raw?;
    (!id.is_empty() && id.len() <= MAX_SESSION_ID && id.bytes().all(|b| (0x21..=0x7e).contains(&b)))
        .then(|| id.to_string())
}

fn session_log_prefix(id: Option<&str>) -> String {
    id.map(|s| s.chars().take(8).collect()).unwrap_or_else(|| "-".to_string())
}

/// Serves one request on `stream`. Never panics on input; a parse error or
/// limit breach affects only this stream.
pub async fn handle_connection<S>(stream: &mut S, ctx: &HoldCtx<'_>) -> Handled
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let deadline = Instant::now() + READ_DEADLINE;
    let read = timeout_at(deadline, read_head(stream)).await;
    let (head, buf, head_end) = match read {
        Ok(Ok(parts)) => parts,
        Ok(Err(Reject::Status(s))) => return reply_and_close(stream, Reply::status(s)).await,
        Ok(Err(Reject::Close)) | Err(_) => return Handled::Closed,
    };
    let length = match body_length(&head) {
        Ok(n) => n,
        Err(s) => return reply_and_close(stream, Reply::status(s)).await,
    };

    // /health is open and carries nothing sensitive.
    if head.method == "GET" && head.path == "/health" {
        let mut r = Reply::status(200);
        r.content_type = Some("application/json");
        r.body = vec![Piece::Static(r#"{"status":"holding","server":"termflow-mcp"}"#)];
        return reply_and_close(stream, r).await;
    }
    if let Some(token) = ctx.auth_token.filter(|t| !t.is_empty()) {
        if !authorized(&head, token) {
            let mut r = Reply::status(401);
            r.extra.push(("WWW-Authenticate", "Bearer".to_string()));
            return reply_and_close(stream, r).await;
        }
    }

    let session = clean_session_id(head.session_id.as_deref());
    match (head.method.as_str(), head.path.as_str()) {
        ("POST", "/mcp") => {
            let body = match timeout_at(deadline, read_body(stream, &buf, buf.capacity(), head_end, length)).await {
                Ok(Ok(b)) => b,
                Ok(Err(Reject::Status(s))) => return reply_and_close(stream, Reply::status(s)).await,
                Ok(Err(Reject::Close)) | Err(_) => return Handled::Closed,
            };
            drop(buf);
            let log_prefix = session_log_prefix(session.as_deref());
            let env = RpcEnv {
                snapshot: ctx.snapshot,
                reason: ctx.reason,
                wait: (ctx.wait)(),
                new_session_id: ctx.new_session_id,
                session_log: &log_prefix,
            };
            let reply = match handle_body(&body, &env) {
                RpcOutcome::NoContent => Reply::status(202),
                RpcOutcome::Json { body, new_session } => {
                    let mut r = Reply::status(200);
                    r.content_type = Some("application/json");
                    // A fresh id for initialize; otherwise the client's own, echoed.
                    if let Some(id) = new_session.or(session) {
                        r.extra.push(("mcp-session-id", id));
                    }
                    r.body = body;
                    r
                }
            };
            reply_and_close(stream, reply).await
        }
        ("GET", "/mcp") => Handled::Sse(SseOpen { session_id: session }),
        ("DELETE", "/mcp") => reply_and_close(stream, Reply::status(200)).await,
        _ => reply_and_close(stream, Reply::status(404)).await,
    }
}

async fn reply_and_close<S>(stream: &mut S, reply: Reply) -> Handled
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let ok = write_reply(stream, &reply).await.is_ok();
    let _ = timeout(WRITE_DEADLINE, stream.shutdown()).await;
    if ok {
        Handled::Replied
    } else {
        Handled::Closed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_hold::Mode;
    use std::cell::Cell;

    const TOKEN: &str = "s3cr3t-bearer-0123456789";
    // Unusual key order and whitespace on purpose: the holder must serve these bytes verbatim.
    const INIT: &str = r#"{ "serverInfo" : {"version":"1.2.3" ,"name":"termflow-mcp"},   "protocolVersion":"2025-03-26" ,"capabilities":{"tools":{ } } }"#;
    const TOOLS: &str = r#"{"tools":[ {"name":"list_terminals" ,"inputSchema":{"type":"object","properties":{ }}} ]}"#;

    fn early(ago: &str) -> String {
        format!(
            "TermFlow is restarting (Offload & Close, {ago} ago). Your terminals are still running. \
             Wait about 30 seconds and retry this call. Do not recreate terminals; they will be \
             reattached when TermFlow is back."
        )
    }

    fn late_3_minutes() -> String {
        "TermFlow has not been reopened yet (Offload & Close, 11m05s ago). Your terminals are still \
         running but will be closed in about 3 minutes unless TermFlow is reopened. Retry later; do \
         not recreate terminals."
            .to_string()
    }

    fn json_str(s: &str) -> String {
        serde_json::to_string(s).unwrap()
    }

    fn ok(id: &str, result: &str) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#)
    }

    fn err(id: &str, code: i32, message: &str) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":{code},"message":{}}}}}"#, json_str(message))
    }

    fn tools_call_result(text: &str) -> String {
        format!(r#"{{"content":[{{"type":"text","text":{}}}],"isError":true}}"#, json_str(text))
    }

    fn fixed_id() -> [u8; 16] {
        [0xab; 16]
    }

    thread_local! {
        static ID_CALLS: Cell<u8> = const { Cell::new(0) };
    }

    /// Returns [1;16], then [2;16], ... and counts its calls.
    fn counting_id() -> [u8; 16] {
        ID_CALLS.with(|c| {
            c.set(c.get() + 1);
            [c.get(); 16]
        })
    }

    struct Resp {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Resp {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
        }
        fn count(&self, name: &str) -> usize {
            self.headers.iter().filter(|(n, _)| n == name).count()
        }
        fn text(&self) -> String {
            String::from_utf8(self.body.clone()).unwrap()
        }
    }

    fn parse_resp(raw: &[u8]) -> Option<Resp> {
        if raw.is_empty() {
            return None;
        }
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("response has a head");
        let head = std::str::from_utf8(&raw[..split]).unwrap();
        let body = raw[split + 4..].to_vec();
        let mut lines = head.split("\r\n");
        let status: u16 = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
        let headers = lines
            .map(|l| {
                let (n, v) = l.split_once(": ").expect("header line");
                (n.to_ascii_lowercase(), v.to_string())
            })
            .collect();
        let resp = Resp { status, headers, body };
        if let Some(cl) = resp.header("content-length") {
            assert_eq!(cl.parse::<usize>().unwrap(), resp.body.len(), "Content-Length matches the body");
        }
        Some(resp)
    }

    /// A `Cell` that is `Sync`, because the wait closure must be.
    struct SyncCell<T>(std::sync::Mutex<T>);

    impl<T: Copy> SyncCell<T> {
        fn new(v: T) -> Self {
            Self(std::sync::Mutex::new(v))
        }
        fn get(&self) -> T {
            *self.0.lock().unwrap()
        }
        fn set(&self, v: T) {
            *self.0.lock().unwrap() = v;
        }
    }

    struct Fx {
        snapshot: Snapshot,
        token: Option<&'static str>,
        mode: SyncCell<Mode>,
        elapsed: SyncCell<u64>,
        remaining: SyncCell<Option<u64>>,
        id_fn: fn() -> [u8; 16],
    }

    impl Fx {
        fn new() -> Self {
            Self {
                snapshot: Snapshot::new(Some(INIT.to_string()), Some(TOOLS.to_string())),
                token: None,
                mode: SyncCell::new(Mode::Absent),
                elapsed: SyncCell::new(130),
                remaining: SyncCell::new(Some(770)),
                id_fn: fixed_id,
            }
        }

        fn with_token(mut self) -> Self {
            self.token = Some(TOKEN);
            self
        }

        /// One request over a fresh stream. A `Sse` outcome is opened the way the holder will.
        async fn exchange(&self, request: Vec<u8>) -> (Handled, Vec<u8>) {
            self.exchange_with(request, false, usize::MAX).await
        }

        /// `half_close`: the client shuts its write side after sending (a peer that hung up).
        /// `piece`: the client sends this many bytes at a time, yielding in between, so the
        /// server's reads land on arbitrary boundaries.
        async fn exchange_with(&self, request: Vec<u8>, half_close: bool, piece: usize) -> (Handled, Vec<u8>) {
            BUFFERED_PEAK.with(|c| c.set(0));
            let (mut client, mut server) = tokio::io::duplex(64 * 1024);
            let wait = || Wait {
                mode: self.mode.get(),
                elapsed: Some(Duration::from_secs(self.elapsed.get())),
                remaining: self.remaining.get().map(Duration::from_secs),
            };
            let ctx = HoldCtx {
                auth_token: self.token,
                snapshot: &self.snapshot,
                reason: McpHoldReason::Offload,
                wait: &wait,
                new_session_id: self.id_fn,
            };
            let serve = async {
                let handled = handle_connection(&mut server, &ctx).await;
                if let Handled::Sse(open) = &handled {
                    write_sse_open(&mut server, open).await.unwrap();
                }
                drop(server);
                handled
            };
            // The client never closes its side: it reads until the server is done.
            let talk = async {
                for part in request.chunks(piece) {
                    if client.write_all(part).await.is_err() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
                if half_close {
                    let _ = client.shutdown().await;
                }
                let mut out = Vec::new();
                let _ = client.read_to_end(&mut out).await;
                out
            };
            let (handled, out) = tokio::join!(serve, talk);
            let peak = BUFFERED_PEAK.with(Cell::get);
            assert!(peak < 300 * 1024, "buffered {peak} bytes for one connection");
            (handled, out)
        }

        async fn send(&self, request: Vec<u8>) -> Resp {
            let (_, raw) = self.exchange(request).await;
            parse_resp(&raw).expect("a reply")
        }

        async fn post(&self, body: &str, session: Option<&str>) -> Resp {
            self.send(post_req(body.as_bytes(), session, self.token_header())).await
        }

        fn token_header(&self) -> Option<String> {
            self.token.map(|t| format!("Authorization: Bearer {t}\r\n"))
        }

        /// A valid ping on a fresh stream must still be answered.
        async fn assert_still_serving(&self) {
            let r = self.post(r#"{"jsonrpc":"2.0","id":99,"method":"ping"}"#, None).await;
            assert_eq!(r.status, 200);
            assert_eq!(r.text(), ok("99", "{}"));
        }
    }

    fn post_req(body: &[u8], session: Option<&str>, extra: Option<String>) -> Vec<u8> {
        let mut head = String::from("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n");
        if let Some(s) = session {
            head.push_str(&format!("mcp-session-id: {s}\r\n"));
        }
        if let Some(e) = extra {
            head.push_str(&e);
        }
        head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        let mut out = head.into_bytes();
        out.extend_from_slice(body);
        out
    }

    fn bare_req(method: &str, path: &str, extra: &str) -> Vec<u8> {
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{extra}\r\n").into_bytes()
    }

    fn ping(id: &str) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"ping"}}"#)
    }

    fn call(id: &str) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"list_terminals","arguments":{{}}}}}}"#)
    }

    // --- the plan's named tests -------------------------------------------

    #[tokio::test]
    async fn initialize_serves_snapshot_bytes_and_fresh_session_id() {
        let mut fx = Fx::new();
        fx.id_fn = counting_id;
        ID_CALLS.with(|c| c.set(0));

        for (n, raw_id) in [r#""abc""#, "7", "1e2", "12345678901234567890123"].into_iter().enumerate() {
            let r = fx
                .post(&format!(r#"{{"jsonrpc":"2.0","id":{raw_id},"method":"initialize","params":{{}}}}"#), None)
                .await;
            assert_eq!(r.status, 200);
            assert_eq!(r.header("content-type"), Some("application/json"));
            assert_eq!(r.header("connection"), Some("close"));
            // The snapshot bytes, exactly, inside the envelope with the id echoed as sent.
            assert_eq!(r.text(), ok(raw_id, INIT));
            assert!(r.text().contains(INIT));
            // One fresh id per initialize, hex-encoded: [n+1; 16].
            assert_eq!(ID_CALLS.with(Cell::get) as usize, n + 1);
            let hex = format!("{:02x}", n + 1).repeat(16);
            assert_eq!(r.header("mcp-session-id"), Some(hex.as_str()));
            assert_eq!(r.count("mcp-session-id"), 1);
        }
        // A batch holding two initializes mints one id, and answers both.
        let before = ID_CALLS.with(Cell::get);
        let both = r#"[{"jsonrpc":"2.0","id":1,"method":"initialize"},{"jsonrpc":"2.0","id":2,"method":"initialize"}]"#;
        let r = fx.post(both, None).await;
        assert_eq!(r.text(), format!("[{},{}]", ok("1", INIT), ok("2", INIT)));
        assert_eq!(ID_CALLS.with(Cell::get), before + 1);
        let hex = format!("{:02x}", before + 1).repeat(16);
        assert_eq!(r.header("mcp-session-id"), Some(hex.as_str()));
        // tools/list does not mint a session id.
        let before = ID_CALLS.with(Cell::get);
        let r = fx.post(r#"{"jsonrpc":"2.0","id":"t","method":"tools/list"}"#, None).await;
        assert_eq!(ID_CALLS.with(Cell::get), before);
        assert_eq!(r.header("mcp-session-id"), None);
        assert_eq!(r.text(), ok(r#""t""#, TOOLS));
    }

    #[tokio::test]
    async fn old_and_fresh_session_ids_get_identical_results() {
        let fx = Fx::new();
        let init = fx.post(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#, None).await;
        let fresh = init.header("mcp-session-id").unwrap().to_string();
        assert_eq!(fresh, "ab".repeat(16));

        for (method, expect_result) in [
            ("tools/call", tools_call_result(&early("2m10s"))),
            ("tools/list", TOOLS.to_string()),
            ("ping", "{}".to_string()),
        ] {
            let body = format!(r#"{{"jsonrpc":"2.0","id":5,"method":"{method}","params":{{"name":"x"}}}}"#);
            let with_fresh = fx.post(&body, Some(&fresh)).await;
            let with_old = fx.post(&body, Some("session-from-before-the-restart-7f3a")).await;
            let with_none = fx.post(&body, None).await;
            assert_eq!(with_fresh.status, 200);
            assert_eq!(with_old.status, 200, "{method} with an old session id is never 404");
            assert_eq!(with_none.status, 200);
            assert_eq!(with_old.body, with_fresh.body);
            assert_eq!(with_none.body, with_fresh.body);
            assert_eq!(with_old.text(), ok("5", &expect_result));
        }
    }

    #[tokio::test]
    async fn first_time_client_handshake() {
        let mut fx = Fx::new();
        fx.id_fn = counting_id;
        ID_CALLS.with(|c| c.set(0));

        let init = fx.post(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#, None).await;
        assert_eq!(init.status, 200);
        assert_eq!(init.text(), ok("0", INIT));
        let sid = init.header("mcp-session-id").unwrap().to_string();
        assert_eq!(sid, "01".repeat(16));

        let initialized = fx.post(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, Some(&sid)).await;
        assert_eq!(initialized.status, 202);
        assert!(initialized.body.is_empty());
        assert_eq!(initialized.header("content-length"), Some("0"));

        let list = fx.post(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, Some(&sid)).await;
        assert_eq!(list.status, 200);
        assert_eq!(list.text(), ok("1", TOOLS));
        assert_eq!(list.header("mcp-session-id"), Some(sid.as_str()));

        let call_r = fx.post(&call("2"), Some(&sid)).await;
        assert_eq!(call_r.status, 200);
        assert_eq!(call_r.text(), ok("2", &tools_call_result(&early("2m10s"))));
        assert_eq!(call_r.header("mcp-session-id"), Some(sid.as_str()));
        // Only the initialize minted an id.
        assert_eq!(ID_CALLS.with(Cell::get), 1);
    }

    #[tokio::test]
    async fn tools_call_text_follows_the_clock() {
        let fx = Fx::new();
        fx.elapsed.set(130);
        let a = fx.post(&call(r#""c-1""#), None).await;
        assert_eq!(a.status, 200);
        assert_eq!(a.text(), ok(r#""c-1""#, &tools_call_result(&early("2m10s"))));

        fx.elapsed.set(665);
        fx.remaining.set(Some(235));
        let b = fx.post(&call("17"), None).await;
        assert_eq!(b.text(), ok("17", &tools_call_result(&late_3_minutes())));
        assert_ne!(a.text(), b.text());

        // Handback has its own wording.
        fx.mode.set(Mode::Handback);
        fx.elapsed.set(206);
        let c = fx.post(&call("18"), None).await;
        let handback = "TermFlow is starting again after Offload & Close (3m26s). Your terminals are still \
                        running. Retry this call in a few seconds.";
        assert_eq!(c.text(), ok("18", &tools_call_result(handback)));

        // ping is `{}` with the same id, whatever the clock says.
        for id in [r#""p""#, "3", "1.50", "null"] {
            let r = fx.post(&ping(id), None).await;
            assert_eq!(r.status, 200);
            assert_eq!(r.text(), ok(id, "{}"));
        }
        // An unknown method is the -32000 wait text.
        let u = fx.post(r#"{"jsonrpc":"2.0","id":4,"method":"resources/list"}"#, None).await;
        assert_eq!(u.status, 200);
        assert_eq!(u.text(), err("4", -32000, handback));
    }

    #[tokio::test]
    async fn batch_semantics() {
        let fx = Fx::new();
        let invalid = |id: &str| err(id, -32600, "Invalid Request");
        let tools_call = ok("3", &tools_call_result(&early("2m10s")));

        // [valid ping, 42, notification, valid tools/call]
        let body = format!(
            r#"[{},42,{{"jsonrpc":"2.0","method":"notifications/initialized"}},{}]"#,
            ping("1"),
            call("3")
        );
        let r = fx.post(&body, None).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.header("content-type"), Some("application/json"));
        assert_eq!(r.text(), format!("[{},{},{}]", ok("1", "{}"), invalid("null"), tools_call));

        // An all-notification batch is 202 with no body.
        let r = fx
            .post(
                r#"[{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","method":"x/y","params":[]}]"#,
                None,
            )
            .await;
        assert_eq!(r.status, 202);
        assert!(r.body.is_empty());

        // An empty batch is a single -32600 object.
        let r = fx.post("[]", None).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.text(), invalid("null"));
        let r = fx.post("  [ ]  ", None).await;
        assert_eq!(r.text(), invalid("null"));

        // Garbage JSON is -32700 with id null.
        for garbage in ["garbage", "{", r#"{"jsonrpc":"2.0","id":1,"method":"ping""#, "[1,", "[{]", r#"{"a":1} x"#, ""] {
            let r = fx.post(garbage, None).await;
            assert_eq!(r.status, 200, "{garbage:?}");
            assert_eq!(r.text(), err("null", -32700, "Parse error"), "{garbage:?}");
        }
        // Invalid UTF-8 is unparsable too.
        let r = fx.send(post_req(b"{\"a\":\"\xff\xfe\"}", None, None)).await;
        assert_eq!(r.text(), err("null", -32700, "Parse error"));

        // A single invalid object is -32600 with id null (never the offending id).
        for bad in [
            r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#,
            r#"{"id":1,"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":1}"#,
            r#"{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":[1],"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":true,"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":7}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":"text"}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":null}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"ping","id":2}"#,
            "42",
            r#""text""#,
            "null",
            "true",
        ] {
            let r = fx.post(bad, None).await;
            assert_eq!(r.status, 200, "{bad}");
            assert_eq!(r.text(), invalid("null"), "{bad}");
        }
        // A single notification is 202; params may be an object or an array.
        for note in [
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            r#"{"jsonrpc":"2.0","method":"tools/call","params":[1]}"#,
        ] {
            let r = fx.post(note, None).await;
            assert_eq!(r.status, 202, "{note}");
            assert!(r.body.is_empty());
        }
        // A null id is a request, not a notification.
        let r = fx.post(&ping("null"), None).await;
        assert_eq!(r.text(), ok("null", "{}"));
    }

    #[tokio::test]
    async fn missing_snapshot_is_per_method() {
        let mut fx = Fx::new();
        let wait = early("2m10s");

        fx.snapshot = Snapshot::new(None, Some(TOOLS.to_string()));
        let r = fx.post(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#, None).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.text(), err("1", -32000, &wait));
        assert_eq!(r.header("mcp-session-id"), None, "no session is minted without a snapshot");
        let r = fx.post(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, None).await;
        assert_eq!(r.text(), ok("2", TOOLS));
        let r = fx.post(&call("3"), None).await;
        assert_eq!(r.text(), ok("3", &tools_call_result(&wait)));
        let r = fx.post(&ping("4"), None).await;
        assert_eq!(r.text(), ok("4", "{}"));

        fx.snapshot = Snapshot::new(Some(INIT.to_string()), None);
        let r = fx.post(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#, None).await;
        assert_eq!(r.text(), ok("1", INIT));
        assert!(r.header("mcp-session-id").is_some());
        let r = fx.post(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, None).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.text(), err("2", -32000, &wait));
        let r = fx.post(&call("3"), None).await;
        assert_eq!(r.text(), ok("3", &tools_call_result(&wait)));
        let r = fx.post(&ping("4"), None).await;
        assert_eq!(r.text(), ok("4", "{}"));

        // A snapshot that is not JSON is dropped, never served.
        fx.snapshot = Snapshot::new(Some("{not json".to_string()), Some("[1,2".to_string()));
        let r = fx.post(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#, None).await;
        assert_eq!(r.text(), err("1", -32000, &wait));
        let r = fx.post(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, None).await;
        assert_eq!(r.text(), err("2", -32000, &wait));
    }

    #[tokio::test]
    async fn bearer_token_enforced() {
        let fx = Fx::new().with_token();
        let good = format!("Authorization: Bearer {TOKEN}\r\n");
        // Same length as TOKEN, differing only in the last byte.
        let mut same_len = TOKEN.to_string();
        same_len.pop();
        same_len.push('X');
        assert_eq!(same_len.len(), TOKEN.len());

        // The correct token: POST, GET (SSE) and DELETE all succeed.
        let r = fx.send(post_req(ping("1").as_bytes(), None, Some(good.clone()))).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.text(), ok("1", "{}"));
        let (handled, raw) = fx.exchange(bare_req("GET", "/mcp", &format!("{good}mcp-session-id: old-sess\r\n"))).await;
        assert_eq!(handled, Handled::Sse(SseOpen { session_id: Some("old-sess".to_string()) }));
        let sse = parse_resp(&raw).unwrap();
        assert_eq!(sse.status, 200);
        assert_eq!(sse.header("content-type"), Some("text/event-stream"));
        assert_eq!(sse.header("mcp-session-id"), Some("old-sess"));
        assert_eq!(sse.text(), ": holding\n\n");
        let r = fx.send(bare_req("DELETE", "/mcp", &good)).await;
        assert_eq!(r.status, 200);
        assert!(r.body.is_empty());
        // The scheme is case-insensitive and header whitespace is trimmed, but spaces inside
        // the credential make it a different token.
        let r = fx.send(post_req(ping("2").as_bytes(), None, Some(format!("authorization:   bearer   {TOKEN}  \r\n")))).await;
        assert_eq!(r.status, 401);
        let r = fx.send(post_req(ping("2").as_bytes(), None, Some(format!("authorization:\tbearer {TOKEN}\t\r\n")))).await;
        assert_eq!(r.status, 200);

        let bad_headers: Vec<(&str, String)> = vec![
            ("no header", String::new()),
            ("wrong token", "Authorization: Bearer nope\r\n".to_string()),
            ("same-length wrong token", format!("Authorization: Bearer {same_len}\r\n")),
            ("same-length wrong first byte", format!("Authorization: Bearer X{}\r\n", &TOKEN[1..])),
            ("same-length wrong middle byte", format!("Authorization: Bearer {}X{}\r\n", &TOKEN[..10], &TOKEN[11..])),
            ("prefix of the token", format!("Authorization: Bearer {}\r\n", &TOKEN[..TOKEN.len() - 1])),
            ("token with a suffix", format!("Authorization: Bearer {TOKEN}x\r\n")),
            ("Basic", format!("Authorization: Basic {TOKEN}\r\n")),
            ("no scheme", format!("Authorization: {TOKEN}\r\n")),
            ("empty bearer", "Authorization: Bearer \r\n".to_string()),
            ("two headers", format!("{good}{good}")),
            ("good then wrong", format!("{good}Authorization: Bearer nope\r\n")),
        ];
        for (label, header) in &bad_headers {
            let expect = |r: &Resp, what: &str| {
                assert_eq!(r.status, 401, "{what} with {label}");
                assert!(r.body.is_empty(), "{what} with {label}");
                assert_eq!(r.header("www-authenticate"), Some("Bearer"));
                assert_eq!(r.header("connection"), Some("close"));
            };
            let extra = (!header.is_empty()).then(|| header.clone());
            expect(&fx.send(post_req(ping("1").as_bytes(), None, extra)).await, "POST");
            expect(&fx.send(bare_req("GET", "/mcp", header)).await, "GET");
            expect(&fx.send(bare_req("DELETE", "/mcp", header)).await, "DELETE");
            expect(&fx.send(bare_req("GET", "/nowhere", header)).await, "GET /nowhere");
        }
        // A rejected GET never reaches the SSE hand-off.
        let (handled, _) = fx.exchange(bare_req("GET", "/mcp", "")).await;
        assert_eq!(handled, Handled::Replied);

        // /health needs no token and carries nothing but its fixed body.
        for extra in ["", "Authorization: Bearer wrong\r\n", good.as_str()] {
            let r = fx.send(bare_req("GET", "/health", extra)).await;
            assert_eq!(r.status, 200);
            assert_eq!(r.header("content-type"), Some("application/json"));
            let body = r.text();
            assert_eq!(body, r#"{"status":"holding","server":"termflow-mcp"}"#);
            assert!(!body.contains(TOKEN));
            assert!(!body.contains("protocolVersion") && !body.contains("list_terminals"));
            assert!(!body.contains("instanceId"));
        }
        // With a good token an unknown route is 404, and the wrong method on /health too.
        assert_eq!(fx.send(bare_req("GET", "/nowhere", &good)).await.status, 404);
        assert_eq!(fx.send(bare_req("POST", "/health", &format!("{good}Content-Length: 0\r\n"))).await.status, 404);

        // An empty or absent token means open.
        let mut open = Fx::new();
        for token in [None, Some("")] {
            open.token = token;
            assert_eq!(open.send(bare_req("DELETE", "/mcp", "")).await.status, 200);
            assert_eq!(open.send(post_req(ping("1").as_bytes(), None, None)).await.status, 200);
        }
    }

    // Literals, not the production constants: a test built from a constant cannot catch the constant moving.
    const HEAD_LIMIT: usize = 16384;
    const BODY_LIMIT: usize = 262_144;
    const READ_LIMIT: Duration = Duration::from_secs(10);
    const WRITE_LIMIT: Duration = Duration::from_secs(5);

    fn padded_ping(total: usize) -> Vec<u8> {
        let mut body = ping("1").into_bytes();
        assert!(body.len() <= total);
        body.resize(total, b' ');
        body
    }

    #[tokio::test(start_paused = true)]
    async fn request_limits() {
        let fx = Fx::new();

        // A body exactly at the cap is accepted.
        let r = fx.send(post_req(&padded_ping(BODY_LIMIT), None, None)).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.text(), ok("1", "{}"));
        fx.assert_still_serving().await;

        // Cap + 1 is refused with 413 and an empty body.
        let r = fx.send(post_req(&padded_ping(BODY_LIMIT + 1), None, None)).await;
        assert_eq!(r.status, 413);
        assert!(r.body.is_empty());
        assert_eq!(r.header("connection"), Some("close"));
        fx.assert_still_serving().await;
        // Far over the cap, and a length too large for any integer: still 413, nothing allocated.
        let r = fx.send(b"POST /mcp HTTP/1.1\r\nContent-Length: 4294967296\r\n\r\n".to_vec()).await;
        assert_eq!(r.status, 413);
        let r = fx.send(b"POST /mcp HTTP/1.1\r\nContent-Length: 99999999999999999999999999\r\n\r\n".to_vec()).await;
        assert_eq!(r.status, 413);
        fx.assert_still_serving().await;

        // Chunked is 411, whatever else is there.
        let r = fx
            .send(b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n".to_vec())
            .await;
        assert_eq!(r.status, 411);
        assert!(r.body.is_empty());
        let r = fx
            .send(b"POST /mcp HTTP/1.1\r\ntransfer-encoding: chunked\r\nContent-Length: 2\r\n\r\n{}".to_vec())
            .await;
        assert_eq!(r.status, 411);
        fx.assert_still_serving().await;

        // Any repeated Content-Length is 400, equal or conflicting.
        let r = fx
            .send(b"POST /mcp HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}".to_vec())
            .await;
        assert_eq!(r.status, 400);
        let r = fx
            .send(b"POST /mcp HTTP/1.1\r\nContent-Length: 2\r\ncontent-length: 3\r\n\r\n{}x".to_vec())
            .await;
        assert_eq!(r.status, 400);
        fx.assert_still_serving().await;

        // Head (request line, headers and the blank line) of exactly 16 KiB is accepted.
        let prefix = "GET /health HTTP/1.1\r\nX-Pad: ";
        let head_of = |total: usize| {
            let pad = total - prefix.len() - 4;
            format!("{prefix}{}\r\n\r\n", "a".repeat(pad)).into_bytes()
        };
        let exact = head_of(HEAD_LIMIT);
        assert_eq!(exact.len(), 16 * 1024);
        let r = fx.send(exact).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.text(), r#"{"status":"holding","server":"termflow-mcp"}"#);
        fx.assert_still_serving().await;
        // One byte more is closed without a reply, however the bytes are split across reads.
        for piece in [usize::MAX, 1000, 4097, 333] {
            let (handled, raw) = fx.exchange_with(head_of(HEAD_LIMIT + 1), false, piece).await;
            assert_eq!(handled, Handled::Closed, "piece {piece}");
            assert!(raw.is_empty(), "piece {piece}");
            let r = parse_resp(&fx.exchange_with(head_of(HEAD_LIMIT), false, piece).await.1).unwrap();
            assert_eq!(r.status, 200, "an exact-limit head split into pieces of {piece}");
        }
        fx.assert_still_serving().await;
        // A request line over the cap is closed.
        let (handled, raw) = fx.exchange(format!("GET /{} HTTP/1.1\r\n\r\n", "a".repeat(20_000)).into_bytes()).await;
        assert_eq!(handled, Handled::Closed);
        assert!(raw.is_empty());
        // So is a huge head that never ends.
        let (handled, raw) = fx.exchange(vec![b'a'; 100_000]).await;
        assert_eq!(handled, Handled::Closed);
        assert!(raw.is_empty());
        fx.assert_still_serving().await;

        // A truncated body is closed at READ_DEADLINE, not before and not after.
        let start = Instant::now();
        let (handled, raw) = fx
            .exchange(b"POST /mcp HTTP/1.1\r\nContent-Length: 100\r\n\r\n{\"jsonrpc\"".to_vec())
            .await;
        assert_eq!(handled, Handled::Closed);
        assert!(raw.is_empty());
        assert_eq!(start.elapsed(), READ_LIMIT);
        fx.assert_still_serving().await;
        // A peer that hangs up is closed at once, without waiting for the deadline.
        for partial in [
            &b""[..],
            b"POST /mcp HTTP/1.1\r\nContent-Le",
            b"POST /mcp HTTP/1.1\r\nContent-Length: 100\r\n\r\n{}",
        ] {
            let start = Instant::now();
            let (handled, raw) = fx.exchange_with(partial.to_vec(), true, usize::MAX).await;
            assert_eq!(handled, Handled::Closed);
            assert!(raw.is_empty());
            assert_eq!(start.elapsed(), Duration::ZERO);
        }
        fx.assert_still_serving().await;
        // A head that stalls mid-way is closed at the same deadline.
        let start = Instant::now();
        let (handled, _) = fx.exchange(b"POST /mcp HTTP/1.1\r\nContent-Le".to_vec()).await;
        assert_eq!(handled, Handled::Closed);
        assert_eq!(start.elapsed(), READ_LIMIT);
        fx.assert_still_serving().await;
    }

    #[tokio::test(start_paused = true)]
    async fn garbage_requests_never_panic() {
        let fx = Fx::new();
        let long_header = format!("GET /health HTTP/1.1\r\n{}: x\r\n\r\n", "N".repeat(5000));
        let table: Vec<(&str, Vec<u8>, Option<u16>)> = vec![
            ("empty", b"".to_vec(), None),
            ("lone CRLFs", b"\r\n\r\n".to_vec(), Some(400)),
            ("binary", b"\x00\x01\x02\xff\xfe\r\n\r\n".to_vec(), Some(400)),
            ("non-utf8 header", b"GET /health HTTP/1.1\r\nX: \xff\xfe\r\n\r\n".to_vec(), Some(400)),
            ("no terminator", b"GET".to_vec(), None),
            ("request line only", b"GET /mcp HTTP/1.1\r\n".to_vec(), None),
            ("bare LF framing", b"GET /health HTTP/1.1\n\n".to_vec(), None),
            ("one word", b"FOO\r\n\r\n".to_vec(), Some(400)),
            ("two words", b"GET /mcp\r\n\r\n".to_vec(), Some(400)),
            ("four words", b"GET /mcp HTTP/1.1 extra\r\n\r\n".to_vec(), Some(400)),
            ("lowercase method", b"get /mcp HTTP/1.1\r\n\r\n".to_vec(), Some(400)),
            ("http 2", b"GET /mcp HTTP/2.0\r\n\r\n".to_vec(), Some(400)),
            ("absolute target", b"GET http://x/mcp HTTP/1.1\r\n\r\n".to_vec(), Some(400)),
            ("header without colon", b"GET /mcp HTTP/1.1\r\nNoColonHere\r\n\r\n".to_vec(), Some(400)),
            ("empty header name", b"GET /mcp HTTP/1.1\r\n: v\r\n\r\n".to_vec(), Some(400)),
            ("space in header name", b"GET /mcp HTTP/1.1\r\nBad Name: v\r\n\r\n".to_vec(), Some(400)),
            ("obs-fold", b"GET /mcp HTTP/1.1\r\nX: a\r\n b\r\n\r\n".to_vec(), Some(400)),
            ("control char in value", b"GET /mcp HTTP/1.1\r\nX: a\x01b\r\n\r\n".to_vec(), Some(400)),
            ("lone CR in value", b"GET /mcp HTTP/1.1\r\nX: a\rb\r\n\r\n".to_vec(), Some(400)),
            ("CL not a number", b"POST /mcp HTTP/1.1\r\nContent-Length: abc\r\n\r\n".to_vec(), Some(400)),
            ("CL negative", b"POST /mcp HTTP/1.1\r\nContent-Length: -1\r\n\r\n".to_vec(), Some(400)),
            ("CL empty", b"POST /mcp HTTP/1.1\r\nContent-Length:\r\n\r\n".to_vec(), Some(400)),
            ("CL plus", b"POST /mcp HTTP/1.1\r\nContent-Length: +2\r\n\r\n{}".to_vec(), Some(400)),
            ("CL huge", b"POST /mcp HTTP/1.1\r\nContent-Length: 99999999999999999999999\r\n\r\n".to_vec(), Some(413)),
            ("CL longer than body", b"POST /mcp HTTP/1.1\r\nContent-Length: 10\r\n\r\n{}".to_vec(), None),
            ("POST with no body", b"POST /mcp HTTP/1.1\r\n\r\n".to_vec(), Some(200)),
            ("invalid utf8 body", b"POST /mcp HTTP/1.1\r\nContent-Length: 4\r\n\r\n\xff\xfe\xfd\xfc".to_vec(), Some(200)),
            ("json null body", b"POST /mcp HTTP/1.1\r\nContent-Length: 4\r\n\r\nnull".to_vec(), Some(200)),
            ("brace body", b"POST /mcp HTTP/1.1\r\nContent-Length: 1\r\n\r\n}".to_vec(), Some(200)),
            ("unknown verb", b"BREW /mcp HTTP/1.1\r\n\r\n".to_vec(), Some(404)),
            ("unknown path", b"GET /nothing HTTP/1.1\r\n\r\n".to_vec(), Some(404)),
            ("long header name", long_header.into_bytes(), Some(200)),
            ("mcp path with query", b"DELETE /mcp?x=1 HTTP/1.1\r\n\r\n".to_vec(), Some(200)),
            ("tls hello", b"\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03".to_vec(), None),
        ];
        for (label, bytes, expected) in table {
            let start = Instant::now();
            let (_, raw) = fx.exchange(bytes).await;
            assert!(start.elapsed() <= READ_LIMIT, "{label} outlived the read deadline");
            match (expected, parse_resp(&raw)) {
                (None, None) => {}
                (Some(status), Some(resp)) => assert_eq!(resp.status, status, "{label}"),
                (e, r) => panic!("{label}: expected {e:?}, got {:?}", r.map(|r| r.status)),
            }
            fx.assert_still_serving().await;
        }
    }

    #[tokio::test]
    async fn json_budgets() {
        let fx = Fx::new();
        let reset = || {
            rpc::SERDE_RUNS.with(|c| c.set(0));
            rpc::BATCH_MEMBERS.with(|c| c.set(0));
        };
        let runs = || rpc::SERDE_RUNS.with(Cell::get);
        let members = || rpc::BATCH_MEMBERS.with(Cell::get);
        let invalid = err("null", -32600, "Invalid Request");
        let wait = early("2m10s");
        let wait_reply = |id: &str| ok(id, &tools_call_result(&wait));
        let call_with = |id: &str, params: &str| {
            format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{params}}}"#)
        };

        // --- batch size ---
        let mut big = String::from("[");
        big.push_str(&"1,".repeat(131_070));
        big.push_str("1]");
        assert!(big.len() <= BODY_LIMIT && big.len() > BODY_LIMIT - 16);
        reset();
        let r = fx.post(&big, None).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.text(), err("null", -32600, "batch too large"));
        assert!(members() <= 33, "the batch visitor read {} members", members());
        assert_eq!(members(), 33);

        let batch_of = |n: usize| format!("[{}]", (1..=n).map(|i| ping(&i.to_string())).collect::<Vec<_>>().join(","));
        reset();
        let r = fx.post(&batch_of(32), None).await;
        assert_eq!(r.status, 200);
        let expected: Vec<String> = (1..=32).map(|i| ok(&i.to_string(), "{}")).collect();
        assert_eq!(r.text(), format!("[{}]", expected.join(",")));
        assert_eq!(members(), 32);
        reset();
        let r = fx.post(&batch_of(33), None).await;
        assert_eq!(r.text(), err("null", -32600, "batch too large"));
        fx.assert_still_serving().await;

        // --- id length: 128 raw bytes is the limit ---
        let id128 = format!("\"{}\"", "a".repeat(126));
        let id129 = format!("\"{}\"", "a".repeat(127));
        assert_eq!((id128.len(), id129.len()), (128, 129));
        let r = fx.post(&ping(&id128), None).await;
        assert_eq!(r.text(), ok(&id128, "{}"));
        let r = fx.post(&ping(&id129), None).await;
        assert_eq!(r.text(), invalid);

        // --- nesting: the request object counts as level 1, the limit is 64 ---
        let nested = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
        let r = fx.post(&call_with("1", &nested(63)), None).await;
        assert_eq!(r.text(), wait_reply("1"), "63 levels of params (64 with the object) is allowed");
        let r = fx.post(&call_with("1", &nested(64)), None).await;
        assert_eq!(r.text(), invalid, "64 levels of params is 65 deep");
        let r = fx.post(&call_with("1", &nested(65)), None).await;
        assert_eq!(r.text(), invalid);
        // Depth counts objects and arrays alike, and closers bring it back down.
        let r = fx.post(&call_with("2", &format!("{{\"a\":{}}}", nested(61))), None).await;
        assert_eq!(r.text(), wait_reply("2"));
        let r = fx.post(&call_with("2", &format!("{{\"a\":{},\"b\":{}}}", nested(61), nested(61))), None).await;
        assert_eq!(r.text(), wait_reply("2"), "siblings do not add up");

        // --- a near-cap pile of `[` is refused before serde runs ---
        let pile = format!("{}{}", "[".repeat(125_000), "]".repeat(125_000));
        assert_eq!(pile.len(), 250_000);
        reset();
        let r = fx.post(&pile, None).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.text(), invalid);
        assert_eq!((runs(), members()), (0, 0), "serde must not run on a too-deep body");
        reset();
        let deep_params = format!("{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":{}}}", "[".repeat(125_000));
        let r = fx.post(&deep_params, None).await;
        assert_eq!(r.text(), invalid);
        assert_eq!((runs(), members()), (0, 0));
        // For contrast, a normal request does run serde (the gauge is live).
        reset();
        fx.assert_still_serving().await;
        assert!(runs() >= 1);

        // --- brackets inside strings are not nesting ---
        let brackets = format!("{}{}", "[".repeat(100), "{".repeat(100));
        let in_string = call_with("11", &format!(r#"{{"arguments":"{brackets}"}}"#));
        let escaped_quotes = call_with("12", &format!(r#"{{"arguments":"x\"{}\"{}"}}"#, "[".repeat(100), "{".repeat(100)));
        let backslash_end = call_with("13", r#"{"a":"a\\","b":[[[1]]]}"#);
        let backslash_end_deep = call_with("14", &format!(r#"{{"a":"a\\","b":{}}}"#, nested(60)));
        let unicode_escape = call_with("15", &format!("{{\"a\":\"\\u005b{}\\u007b\"}}", "[".repeat(100)));
        let long_value = call_with("16", &format!(r#"{{"a":"{}"}}"#, "v".repeat(5_000)));
        for (label, body, id) in [
            ("brackets in a string", &in_string, "11"),
            ("escaped quotes", &escaped_quotes, "12"),
            ("string ending in an escaped backslash", &backslash_end, "13"),
            ("escaped backslash then deep nesting", &backslash_end_deep, "14"),
            ("unicode escapes", &unicode_escape, "15"),
            ("long string value", &long_value, "16"),
        ] {
            let r = fx.post(body, None).await;
            assert_eq!(r.status, 200, "{label}");
            assert_eq!(r.text(), wait_reply(id), "{label}");
        }
        // The same inside a batch.
        let r = fx.post(&format!("[{},{},{}]", ping("1"), in_string, backslash_end), None).await;
        assert_eq!(r.text(), format!("[{},{},{}]", ok("1", "{}"), wait_reply("11"), wait_reply("13")));
        // A real nesting after an escaped-backslash string is still counted.
        let r = fx.post(&call_with("17", &format!(r#"{{"a":"a\\","b":{}}}"#, nested(64))), None).await;
        assert_eq!(r.text(), invalid);
        // A string with no closing quote is a parse error.
        let r = fx.post(r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"a":"abc"#, None).await;
        assert_eq!(r.text(), err("null", -32700, "Parse error"));
        let r = fx.post(r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"a":"abc\"}}"#, None).await;
        assert_eq!(r.text(), err("null", -32700, "Parse error"), "an escaped closing quote does not close the string");

        // --- object keys: 256 raw bytes at most, and serde never sees longer ones ---
        let key = |n: usize| format!(r#"{{"jsonrpc":"2.0","id":1,"method":"ping","{}":1}}"#, "k".repeat(n));
        let r = fx.post(&key(256), None).await;
        assert_eq!(r.text(), ok("1", "{}"));
        reset();
        let r = fx.post(&key(257), None).await;
        assert_eq!(r.text(), invalid);
        assert_eq!(runs(), 0);
        // A 300-byte string VALUE is not a key.
        let r = fx.post(&call_with("1", &format!(r#"{{"a":"{}"}}"#, "v".repeat(300))), None).await;
        assert_eq!(r.text(), wait_reply("1"));
        // 120 000 escaped backslashes (240 KB on the wire) as an unknown key at depth 1.
        let evil = format!("{{\"{}\":1}}", "\\\\".repeat(120_000));
        assert!(evil.len() > 240_000 && evil.len() <= BODY_LIMIT);
        reset();
        let r = fx.post(&evil, None).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.text(), invalid);
        assert_eq!(runs(), 0, "serde must not decode an oversized key");
        // The key rule also holds with whitespace before the colon, and inside a batch member.
        let spaced = format!("{{\"{}\" \r\n\t: 1}}", "k".repeat(300));
        reset();
        assert_eq!(fx.post(&spaced, None).await.text(), invalid);
        assert_eq!(runs(), 0);
        reset();
        assert_eq!(fx.post(&format!("[{}]", key(300)), None).await.text(), invalid);
        assert_eq!(runs(), 0);

        // --- response budget ---
        let mut fx = Fx::new();
        let snap = format!(r#"{{"pad":"{}"}}"#, "x".repeat(200 * 1024));
        fx.snapshot = Snapshot::new(Some(INIT.to_string()), Some(snap.clone()));
        let list = |i: usize| format!(r#"{{"jsonrpc":"2.0","id":{i},"method":"tools/list"}}"#);
        let batch_lists = |n: usize| format!("[{}]", (1..=n).map(list).collect::<Vec<_>>().join(","));
        let r = fx.post(&batch_lists(30), None).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.text(), err("null", -32603, "response too large"));
        // A single tools/list gets the full snapshot.
        let r = fx.post(&list(1), None).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.text(), ok("1", &snap));
        assert!(r.body.len() > 200 * 1024);
        // 20 of them still fit under 4 MiB, and are all served.
        let r = fx.post(&batch_lists(20), None).await;
        let expected: Vec<String> = (1..=20).map(|i| ok(&i.to_string(), &snap)).collect();
        assert_eq!(r.text(), format!("[{}]", expected.join(",")));
        assert!(r.body.len() < rpc::MAX_RESPONSE);
        // A single reply over the budget carries the request's id.
        fx.snapshot = Snapshot::new(Some("\"".to_string() + &"y".repeat(rpc::MAX_RESPONSE) + "\""), None);
        let r = fx.post(r#"{"jsonrpc":"2.0","id":"big","method":"initialize"}"#, None).await;
        assert_eq!(r.text(), err(r#""big""#, -32603, "response too large"));
        assert_eq!(r.header("mcp-session-id"), None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_reader_that_never_reads_is_dropped_at_the_write_deadline() {
        let mut fx = Fx::new();
        let snap = format!(r#"{{"pad":"{}"}}"#, "x".repeat(200 * 1024));
        fx.snapshot = Snapshot::new(None, Some(snap));
        let wait = || Wait { mode: Mode::Absent, elapsed: Some(Duration::from_secs(1)), remaining: None };
        let ctx = HoldCtx {
            auth_token: None,
            snapshot: &fx.snapshot,
            reason: McpHoldReason::Offload,
            wait: &wait,
            new_session_id: fixed_id,
        };
        // A tiny pipe and a client that sends its request and then never reads.
        let (mut client, mut server) = tokio::io::duplex(1024);
        client.write_all(&post_req(br#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, None, None)).await.unwrap();
        let start = Instant::now();
        let handled = handle_connection(&mut server, &ctx).await;
        assert_eq!(handled, Handled::Closed);
        assert_eq!(start.elapsed(), WRITE_LIMIT);
        drop(client);
    }

    #[tokio::test]
    async fn session_id_is_echoed_only_when_it_is_safe() {
        let fx = Fx::new();
        // A sane id is echoed on every POST; an over-long or non-ASCII one is dropped, not echoed.
        let long = "s".repeat(129);
        for (sid, echoed) in [("abc-123", true), (long.as_str(), false), ("two words", false), ("caf\u{e9}", false)] {
            let r = fx.send(post_req(ping("1").as_bytes(), None, Some(format!("mcp-session-id: {sid}\r\n")))).await;
            assert_eq!(r.status, 200);
            assert_eq!(r.header("mcp-session-id"), echoed.then_some(sid));
            assert_eq!(r.text(), ok("1", "{}"));
        }
        // Without one, none is invented outside initialize.
        let r = fx.post(&ping("1"), None).await;
        assert_eq!(r.header("mcp-session-id"), None);
    }
}
