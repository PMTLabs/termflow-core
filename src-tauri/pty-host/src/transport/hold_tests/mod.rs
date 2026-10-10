//! Plan 054 T5/T7: the MCP holder through the real `serve_with_clock`.
//!
//! A fake active-time clock drives the host's Local deadline and the holder's
//! hard cap. Real shells, a real pipe or socket for the "GUI", and real
//! loopback TCP for the agent side.
//!
//! **Paused-time tests and real I/O.** Under `start_paused` tokio advances the
//! clock whenever the runtime is idle, including while it waits for a socket or
//! a pipe, and that would fire a deadline spuriously. So every test client here
//! is wrapped in [`Busy`]: while it waits it re-wakes itself, the runtime is
//! never idle, and time moves only when a test calls `tokio::time::advance`.

mod bounds;
mod compat;
mod lifecycle;
mod limits;

use super::*;
use crate::mcp_hold::holder::{gauges, STOP_BOUND};
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::task::{Context, Poll};
use termflow_pty_protocol::{
    ArmDetachPurpose, Control, Data, Frame, McpHeld, McpHoldReason, McpHoldSpec, Response, SessionMeta, SpawnSpec,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;

pub(super) const HOST_TOKEN: &str = "tok";
/// The sidecar's bearer token. A sentinel: `token_never_logged_or_served` greps for it.
pub(super) const BEARER: &str = "bearer-S3NT1NEL-7f3c9a21-do-not-leak";
pub(super) const INIT: &str =
    r#"{ "protocolVersion":"2025-03-26","capabilities":{"tools":{ }},"serverInfo":{"name":"termflow-mcp","version":"9.9.9"} }"#;
pub(super) const TOOLS: &str = r#"{"tools":[ {"name":"list_terminals","inputSchema":{"type":"object","properties":{ }}} ]}"#;
pub(super) const SNAPSHOT_BYTES: usize = INIT.len() + TOOLS.len();

// --- clock -----------------------------------------------------------------

#[derive(Clone)]
pub(super) struct Clock(Arc<Mutex<Option<Duration>>>);

impl Clock {
    pub fn new(secs: u64) -> Self {
        Self(Arc::new(Mutex::new(Some(Duration::from_secs(secs)))))
    }
    pub fn set(&self, secs: u64) {
        *self.0.lock().unwrap() = Some(Duration::from_secs(secs));
    }
    pub fn fail(&self) {
        *self.0.lock().unwrap() = None;
    }
}

impl ActiveClock for Clock {
    fn now(&self) -> Option<Duration> {
        *self.0.lock().unwrap()
    }
}

// --- the busy adapter ------------------------------------------------------

pub(super) struct Busy<S> {
    pub inner: S,
    pub limit: Duration,
    since: Option<std::time::Instant>,
}

impl<S> Busy<S> {
    pub fn new(inner: S) -> Self {
        Self { inner, limit: Duration::from_secs(15), since: None }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Busy<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        match Pin::new(&mut self.inner).poll_read(cx, buf) {
            Poll::Pending => {
                let since = *self.since.get_or_insert_with(std::time::Instant::now);
                if since.elapsed() >= self.limit {
                    self.since = None;
                    return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
                }
                std::thread::sleep(Duration::from_micros(300));
                cx.waker().wake_by_ref();
                Poll::Pending
            }
            ready => {
                self.since = None;
                ready
            }
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Busy<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Let the runtime run for `real` wall-clock time without ever going idle.
pub(super) async fn pump(real: Duration) {
    let end = std::time::Instant::now() + real;
    while std::time::Instant::now() < end {
        tokio::task::yield_now().await;
        std::thread::sleep(Duration::from_micros(300));
    }
}

/// Pump until `f` holds or `real` has passed. Returns whether it held.
pub(super) async fn pump_until(real: Duration, mut f: impl FnMut() -> bool) -> bool {
    let end = std::time::Instant::now() + real;
    loop {
        if f() {
            return true;
        }
        if std::time::Instant::now() >= end {
            return false;
        }
        tokio::task::yield_now().await;
        std::thread::sleep(Duration::from_micros(300));
    }
}

/// Advance virtual time (paused tests) in steps, pumping real time in between
/// so every task woken by a step has run before the next one.
pub(super) async fn advance(by: Duration) {
    let step = Duration::from_millis(250);
    let mut left = by;
    while !left.is_zero() {
        let d = left.min(step);
        tokio::time::advance(d).await;
        pump(Duration::from_millis(3)).await;
        left -= d;
    }
    pump(Duration::from_millis(20)).await;
}

// --- logs ------------------------------------------------------------------

thread_local! {
    static LOG_LINES: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

struct CaptureLogger;

impl log::Log for CaptureLogger {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        LOG_LINES.with(|l| l.borrow_mut().push(format!("{}", record.args())));
    }
    fn flush(&self) {}
}

static LOGGER: CaptureLogger = CaptureLogger;

/// Installs the capture logger (once per process); lines are kept per thread,
/// and every `#[tokio::test]` runs on its own thread.
pub(super) fn capture_logs() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);
}

pub(super) fn log_lines() -> Vec<String> {
    LOG_LINES.with(|l| l.borrow().clone())
}

// --- the host --------------------------------------------------------------

static NEXT_ENDPOINT: AtomicUsize = AtomicUsize::new(0);

pub(super) fn unique_endpoint(tag: &str) -> Endpoint {
    let n = NEXT_ENDPOINT.fetch_add(1, Ordering::Relaxed);
    #[cfg(windows)]
    {
        Endpoint(format!(r"\\.\pipe\termflow-test-{}-hold-{tag}-{n}", std::process::id()))
    }
    #[cfg(unix)]
    {
        Endpoint(format!("/tmp/termflow-test-{}/hold-{tag}-{n}.sock", std::process::id()))
    }
}

thread_local! {
    /// Set by `Host::start` when the test runs under paused time.
    static PAUSED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn runtime_is_paused() -> bool {
    let before = tokio::time::Instant::now();
    std::thread::sleep(Duration::from_millis(2));
    tokio::time::Instant::now() == before
}

/// The holder's state sampled by the spawned wrapper in the same poll in which
/// `serve_with_clock` resolved: nothing, not even the test's own waiter, ran in
/// between (review 295 F4).
#[derive(Debug)]
pub(super) struct AtReturn {
    pub live_tasks: usize,
    pub task_ends: Vec<&'static str>,
}

thread_local! {
    static AT_RETURN: std::cell::RefCell<Option<AtReturn>> = const { std::cell::RefCell::new(None) };
}

/// What was sampled when the last `serve_with_clock` of this test resolved.
pub(super) fn at_return() -> AtReturn {
    AT_RETURN.with(|c| c.borrow_mut().take()).expect("serve_with_clock has not returned yet")
}

pub(super) struct Host {
    pub ep: Endpoint,
    pub srv: tokio::task::JoinHandle<io::Result<()>>,
}

impl Host {
    pub fn start(tag: &str, clock: &Clock) -> Self {
        capture_logs();
        PAUSED.with(|p| p.set(runtime_is_paused()));
        let ep = unique_endpoint(tag);
        let served = serve_with_clock(ep.clone(), Some(HOST_TOKEN.into()), true, None, Arc::new(clock.clone()));
        let srv = tokio::spawn(async move {
            let result = served.await;
            AT_RETURN.with(|c| {
                *c.borrow_mut() = Some(AtReturn { live_tasks: gauges::live_tasks(), task_ends: gauges::task_ends() });
            });
            result
        });
        Self { ep, srv }
    }

    pub async fn gui(&self) -> Gui {
        Gui::connect(&self.ep).await
    }

    pub fn finished(&self) -> bool {
        self.srv.is_finished()
    }

    pub async fn wait_finished(&self, real: Duration) -> bool {
        pump_until(real, || self.srv.is_finished()).await
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.srv.abort();
    }
}

// --- the GUI stand-in ------------------------------------------------------

pub(super) enum Next {
    Frame(Frame),
    Eof,
    Timeout,
}

pub(super) struct Gui {
    pub io: Busy<ClientStream>,
    req: u64,
}

impl Gui {
    pub async fn connect(ep: &Endpoint) -> Self {
        let end = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(c) = connect(ep).await {
                return Self { io: Busy::new(c), req: 0 };
            }
            assert!(std::time::Instant::now() < end, "the host never offered its endpoint");
            pump(Duration::from_millis(5)).await;
            // The host retries a failed accept after a virtual 100 ms; under
            // paused time nothing else would ever move that timer.
            if PAUSED.with(std::cell::Cell::get) {
                tokio::time::advance(Duration::from_millis(25)).await;
            }
        }
    }

    pub fn req(&mut self) -> u64 {
        self.req += 1;
        self.req
    }

    pub async fn send(&mut self, c: Control) {
        write_frame(&mut self.io, &Frame::Ctrl(c)).await.expect("write a frame to the host");
    }

    pub async fn next(&mut self, limit: Duration) -> Next {
        self.io.limit = limit;
        match read_frame(&mut self.io).await {
            Ok(Some(f)) => Next::Frame(f),
            Ok(None) => Next::Eof,
            Err(e) if e.kind() == io::ErrorKind::TimedOut => Next::Timeout,
            Err(_) => Next::Eof,
        }
    }

    /// The next response frame (data frames are skipped); `None` on EOF or timeout.
    pub async fn resp_within(&mut self, limit: Duration) -> Option<Response> {
        let end = std::time::Instant::now() + limit;
        loop {
            let left = end.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return None;
            }
            match self.next(left).await {
                Next::Frame(Frame::Resp(r)) => return Some(r),
                Next::Frame(_) => {}
                Next::Eof | Next::Timeout => return None,
            }
        }
    }

    pub async fn resp(&mut self) -> Response {
        self.resp_within(Duration::from_secs(15)).await.expect("a response from the host")
    }

    /// Nothing at all (no response, no data) arrives within `limit`.
    pub async fn silent_for(&mut self, limit: Duration) -> bool {
        matches!(self.next(limit).await, Next::Timeout)
    }

    pub async fn arm_local(&mut self) {
        let req = self.req();
        self.send(Control::ArmDetach {
            req,
            timeout_secs: 600,
            token: HOST_TOKEN.into(),
            purpose: Some(ArmDetachPurpose::Local),
        })
        .await;
        assert!(matches!(self.resp().await, Response::ArmAck { req: r, .. } if r == req));
    }

    pub async fn hold(&mut self, spec: McpHoldSpec) -> Response {
        let req = self.req();
        self.send(Control::HoldMcp { req, token: HOST_TOKEN.into(), spec }).await;
        let r = self.resp().await;
        assert!(matches!(&r, Response::McpHoldAck { req: q, .. } if *q == req), "{r:?}");
        r
    }

    pub async fn hold_accepted(&mut self, spec: McpHoldSpec) {
        assert_eq!(self.hold(spec).await, Response::McpHoldAck { req: self.req, accepted: true, reason: None });
    }

    pub async fn claim(&mut self) -> Option<McpHeld> {
        let req = self.req();
        self.send(Control::ClaimMcp { req, token: HOST_TOKEN.into() }).await;
        match self.resp().await {
            Response::McpClaimAck { req: r, held } if r == req => held,
            other => panic!("expected McpClaimAck, got {other:?}"),
        }
    }

    pub async fn release(&mut self) -> bool {
        let req = self.req();
        self.send(Control::ReleaseMcp { req, token: HOST_TOKEN.into() }).await;
        match self.resp().await {
            Response::McpReleaseAck { req: r, was_holding } if r == req => was_holding,
            other => panic!("expected McpReleaseAck, got {other:?}"),
        }
    }

    pub async fn list(&mut self) -> Vec<SessionMeta> {
        let req = self.req();
        self.send(Control::ListSessions { req, token: Some(HOST_TOKEN.into()) }).await;
        match self.resp().await {
            Response::SessionList { req: r, sessions } if r == req => sessions,
            other => panic!("expected SessionList, got {other:?}"),
        }
    }

    pub async fn spawn(&mut self, tab: &str) -> u32 {
        let req = self.req();
        self.send(Control::Spawn { req, tab_id: tab.into(), spec: persist_spec() }).await;
        match self.resp().await {
            Response::Spawned { req: r, pid, .. } if r == req => pid,
            other => panic!("expected Spawned, got {other:?}"),
        }
    }

    /// Type an arithmetic command into `tab` and wait for its result in the
    /// output. The result (`4002`) is not in what was typed, so only a shell that
    /// is alive and attached can produce it.
    pub async fn shell_echoes(&mut self, tab: &str) -> bool {
        let (typed, expect) = probe_input();
        write_frame(&mut self.io, &Frame::Data(Data::Stdin { tab_id: tab.into(), bytes: typed.as_bytes().to_vec() }))
            .await
            .expect("write stdin");
        let end = std::time::Instant::now() + Duration::from_secs(15);
        let mut seen = String::new();
        while std::time::Instant::now() < end {
            match self.next(end - std::time::Instant::now()).await {
                Next::Frame(Frame::Data(Data::Stdout { tab_id, bytes, .. })) if tab_id == tab => {
                    seen.push_str(&String::from_utf8_lossy(&bytes));
                    if seen.contains(expect) {
                        return true;
                    }
                }
                Next::Frame(_) => {}
                Next::Eof | Next::Timeout => return false,
            }
        }
        false
    }

    /// Reattach `tab` live from its current tail, the way an adopting GUI does.
    pub async fn attach_tail(&mut self, tab: &str) {
        let tail = self.list().await.into_iter().find(|s| s.tab_id == tab).map_or(0, |s| s.tail_offset);
        let req = self.req();
        self.send(Control::Attach { req, tab_id: tab.into(), from_offset: tail }).await;
    }
}

fn persist_spec() -> SpawnSpec {
    #[cfg(windows)]
    let (shell, args) = ("cmd.exe", vec!["/k".to_string(), "echo persist".to_string()]);
    #[cfg(unix)]
    let (shell, args) = ("/bin/sh", vec!["-c".to_string(), "echo persist; exec /bin/sh".to_string()]);
    SpawnSpec {
        shell: shell.into(),
        args,
        env: vec![],
        env_remove: vec![],
        cwd: None,
        cols: 80,
        rows: 24,
        initial_cursor_row: None,
    }
}

fn probe_input() -> (&'static str, &'static str) {
    #[cfg(windows)]
    {
        ("set /a 4000+2\r\n", "4002")
    }
    #[cfg(unix)]
    {
        ("echo $((4000+2))\n", "4002")
    }
}

pub(super) fn pid_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the pid exists.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: plain Win32 queries; the handle is closed on every path.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(h, &mut code) != 0;
            CloseHandle(h);
            ok && code == STILL_ACTIVE as u32
        }
    }
}

// --- the agent side --------------------------------------------------------

/// A free ephemeral port on `host` (bound and released).
pub(super) fn free_port(host: &str) -> u16 {
    std::net::TcpListener::bind((host, 0)).expect("bind an ephemeral port").local_addr().unwrap().port()
}

pub(super) fn spec(port: u16, bind_host: &str) -> McpHoldSpec {
    McpHoldSpec {
        port,
        configured_port: port.wrapping_sub(3),
        bind_host: bind_host.into(),
        auth_token: Some(BEARER.into()),
        reason: McpHoldReason::Relaunch,
        initialize_result: Some(INIT.into()),
        tools_list_result: Some(TOOLS.into()),
    }
}

pub(super) fn held(port: u16, bind_host: &str) -> McpHeld {
    McpHeld { port, configured_port: port.wrapping_sub(3), bind_host: bind_host.into() }
}

pub(super) fn probe_addr(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

/// A TCP connection to the port, `None` if it is refused.
pub(super) fn dial(port: u16) -> Option<Busy<TcpStream>> {
    let s = std::net::TcpStream::connect_timeout(&probe_addr(port), Duration::from_millis(500)).ok()?;
    s.set_nonblocking(true).ok()?;
    Some(Busy::new(TcpStream::from_std(s).ok()?))
}

pub(super) fn refuses(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(&probe_addr(port), Duration::from_millis(500)).is_err()
}

pub(super) struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Resp {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    /// The wait text of a `tools/call` reply.
    pub fn wait_text(&self) -> Option<String> {
        let v: serde_json::Value = serde_json::from_str(&self.body).ok()?;
        Some(v["result"]["content"][0]["text"].as_str()?.to_string())
    }
}

pub(super) fn parse_resp(raw: &[u8]) -> Option<Resp> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split(' ').nth(1)?.parse().ok()?;
    let headers = lines.filter_map(|l| l.split_once(": ")).map(|(n, v)| (n.to_string(), v.to_string())).collect();
    Some(Resp { status, headers, body: String::from_utf8_lossy(&raw[split + 4..]).into_owned() })
}

/// One request on a fresh connection, read until the server closes. `None` if
/// the port refuses; an empty vector if the server accepted and said nothing
/// within `limit`.
pub(super) async fn exchange(port: u16, request: &[u8], limit: Duration) -> Option<Vec<u8>> {
    let mut s = dial(port)?;
    s.limit = limit;
    s.write_all(request).await.ok()?;
    let mut out = Vec::new();
    let _ = s.read_to_end(&mut out).await;
    Some(out)
}

pub(super) fn tools_call_request(token: Option<&str>, session: &str) -> Vec<u8> {
    let body = r#"{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"list_terminals","arguments":{}}}"#;
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nmcp-session-id: {session}\r\n{auth}Content-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// A `tools/call` with the right token and an old session id.
pub(super) async fn call(port: u16) -> Option<Resp> {
    parse_resp(&exchange(port, &tools_call_request(Some(BEARER), "old-session-id"), Duration::from_secs(3)).await?)
}

/// The wait text the holder gives now, if it answers.
pub(super) async fn wait_text(port: u16) -> Option<String> {
    call(port).await?.wait_text()
}

/// Polls until the holder answers a `tools/call`, up to `real`.
pub(super) async fn wait_answers(port: u16, real: Duration) -> bool {
    let end = std::time::Instant::now() + real;
    while std::time::Instant::now() < end {
        if wait_text(port).await.is_some() {
            return true;
        }
        pump(Duration::from_millis(10)).await;
    }
    false
}

/// Polls until the wait text satisfies `f`, up to `real`; returns the last text seen.
pub(super) async fn wait_text_where(port: u16, real: Duration, f: impl Fn(&str) -> bool) -> Option<String> {
    let end = std::time::Instant::now() + real;
    let mut last = None;
    while std::time::Instant::now() < end {
        if let Some(t) = wait_text(port).await {
            if f(&t) {
                return Some(t);
            }
            last = Some(t);
        }
        pump(Duration::from_millis(10)).await;
    }
    panic!("the wait text never matched; last seen: {last:?}");
}

pub(super) async fn wait_refuses(port: u16, real: Duration) -> bool {
    pump_until(real, || refuses(port)).await
}

/// An open `GET /mcp` stream.
pub(super) struct Sse {
    pub io: Busy<TcpStream>,
    pub seen: Vec<u8>,
}

pub(super) enum Read {
    Data,
    Eof,
    Timeout,
}

impl Sse {
    pub async fn open(port: u16, session: &str) -> Option<Self> {
        let mut io = dial(port)?;
        let req = format!(
            "GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\nmcp-session-id: {session}\r\nAuthorization: Bearer {BEARER}\r\n\r\n"
        );
        io.write_all(req.as_bytes()).await.ok()?;
        Some(Self { io, seen: Vec::new() })
    }

    pub async fn read_some(&mut self, limit: Duration) -> Read {
        self.io.limit = limit;
        let mut buf = [0u8; 2048];
        match self.io.read(&mut buf).await {
            Ok(0) => Read::Eof,
            Ok(n) => {
                self.seen.extend_from_slice(&buf[..n]);
                Read::Data
            }
            Err(e) if e.kind() == io::ErrorKind::TimedOut => Read::Timeout,
            Err(_) => Read::Eof,
        }
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.seen).into_owned()
    }

    /// Reads until what has been seen contains `needle`.
    pub async fn read_until(&mut self, needle: &str, limit: Duration) -> bool {
        let end = std::time::Instant::now() + limit;
        while !self.text().contains(needle) {
            let left = end.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() || !matches!(self.read_some(left).await, Read::Data) {
                return self.text().contains(needle);
            }
        }
        true
    }

    /// The stream has ended (EOF or reset), within `limit`.
    pub async fn ends_within(&mut self, limit: Duration) -> bool {
        let end = std::time::Instant::now() + limit;
        loop {
            let left = end.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return false;
            }
            match self.read_some(left).await {
                Read::Eof => return true,
                Read::Data => {}
                Read::Timeout => return false,
            }
        }
    }
}

// --- wait texts ------------------------------------------------------------

pub(super) fn absent_text(ago: &str) -> String {
    format!(
        "TermFlow is restarting (restart, {ago} ago). Your terminals are still running. Wait about 30 \
         seconds and retry this call. Do not recreate terminals; they will be reattached when TermFlow \
         is back."
    )
}

pub(super) fn handback_text(elapsed: &str) -> String {
    format!(
        "TermFlow is starting again after restart ({elapsed}). Your terminals are still running. Retry \
         this call in a few seconds."
    )
}

pub(super) fn late_text(ago: &str, minutes: u64) -> String {
    format!(
        "TermFlow has not been reopened yet (restart, {ago} ago). Your terminals are still running but \
         will be closed in about {minutes} minutes unless TermFlow is reopened. Retry later; do not \
         recreate terminals."
    )
}

/// The common start of most tests: spawn the shells, arm Local, accept the
/// hold, drop the pipe (the GUI exits). Returns the shells' pids.
pub(super) async fn offload(host: &Host, spec: McpHoldSpec, tabs: &[&str]) -> Vec<u32> {
    let mut gui = host.gui().await;
    let mut pids = Vec::new();
    for tab in tabs {
        pids.push(gui.spawn(tab).await);
    }
    gui.arm_local().await;
    gui.hold_accepted(spec).await;
    drop(gui);
    pids
}

// --- the first tests -------------------------------------------------------

/// AC4, AC6, AC8 through the real transport: a POST of `tools/call` with an old
/// session id and the token gets the "restart" wait text, and a wrong token
/// does not get past the door.
#[tokio::test]
async fn holder_answers_while_gui_absent() {
    let clock = Clock::new(0);
    let host = Host::start("answers", &clock);
    let port = free_port("127.0.0.1");
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    assert!(wait_answers(port, Duration::from_secs(10)).await, "the holder never answered");

    let reply = call(port).await.expect("an answer");
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("content-type"), Some("application/json"));
    assert_eq!(reply.wait_text().as_deref(), Some(absent_text("0s").as_str()));
    let envelope: serde_json::Value = serde_json::from_str(&reply.body).unwrap();
    assert_eq!(envelope["id"], 17);
    assert_eq!(envelope["result"]["isError"], true);

    let wrong = exchange(port, &tools_call_request(Some("not-the-token"), "old-session-id"), Duration::from_secs(3))
        .await
        .and_then(|raw| parse_resp(&raw))
        .expect("a reply to the wrong token");
    assert_eq!(wrong.status, 401);
    assert!(!wrong.body.contains(BEARER));
}

/// A stand-in holds the SAME address for 300 ms. Before it lets go no request
/// is answered by the holder; after, the holder answers.
#[tokio::test]
async fn holder_binds_after_port_frees() {
    let clock = Clock::new(0);
    let host = Host::start("binds-after", &clock);
    let port = free_port("127.0.0.1");
    let stand_in = std::net::TcpListener::bind(("127.0.0.1", port)).expect("the stand-in takes the port");
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;

    let held_for = std::time::Instant::now();
    pump(Duration::from_millis(150)).await;
    let early = exchange(port, &tools_call_request(Some(BEARER), "old"), Duration::from_millis(120)).await;
    assert_eq!(early, Some(Vec::new()), "the stand-in accepts the connection and says nothing");
    let attempts_while_held = gauges::bind_attempts();
    assert!(attempts_while_held >= 1, "the holder must be trying");

    let hold_left = Duration::from_millis(300).saturating_sub(held_for.elapsed());
    pump(hold_left).await;
    drop(stand_in);
    assert!(wait_answers(port, Duration::from_secs(5)).await, "the holder never took the freed port");
    assert!(gauges::bind_attempts() > attempts_while_held, "it bound on a RETRY after the port freed");
    assert_eq!(wait_text(port).await.as_deref(), Some(absent_text("0s").as_str()));
}

/// A stand-in occupies the port: `ClaimMcp` still reports what is held (not
/// `None`); once the stand-in goes the holder binds and answers; after release
/// nothing listens.
#[tokio::test]
async fn claim_during_bind_retry_reports_held_then_binds() {
    let clock = Clock::new(0);
    let host = Host::start("claim-retry", &clock);
    let port = free_port("127.0.0.1");
    let stand_in = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;
    pump(Duration::from_millis(250)).await;

    let mut gui = host.gui().await;
    assert_eq!(gui.claim().await, Some(held(port, "127.0.0.1")));
    drop(stand_in);
    let text = wait_text_where(port, Duration::from_secs(5), |t| t.contains("starting again")).await;
    assert_eq!(text, Some(handback_text("0s")));

    assert!(gui.release().await);
    pump(Duration::from_millis(1500)).await;
    assert!(refuses(port), "nothing listens 1.5 s after the release");
}

/// A stranger keeps the address for the whole test. The holder keeps retrying
/// quietly, the live shell is untouched, and a claim reports `held` from the spec.
#[tokio::test]
async fn bind_never_succeeds_and_sessions_are_untouched() {
    let clock = Clock::new(0);
    let host = Host::start("never-binds", &clock);
    let port = free_port("127.0.0.1");
    let _stranger = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    offload(&host, spec(port, "127.0.0.1"), &["t1"]).await;

    pump(Duration::from_millis(1300)).await;
    let attempts = gauges::bind_attempts();
    assert!(attempts >= 8, "the holder keeps retrying (every 100 ms for the first 10 s): {attempts}");
    let failing = log_lines().iter().filter(|l| l.contains("still failing")).count();
    assert_eq!(failing, 1, "a failing bind is logged once per 30 s, not per attempt");

    let mut gui = host.gui().await;
    assert_eq!(gui.claim().await, Some(held(port, "127.0.0.1")));
    gui.attach_tail("t1").await;
    assert!(gui.shell_echoes("t1").await, "the live shell still echoes");
    assert!(gui.release().await);
}
