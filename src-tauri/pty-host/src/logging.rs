//! The host's production `log` backend (plan 054 review 295 F2, review 296 R1/R2).
//!
//! The `log` macros are no-ops until a logger is installed, and nothing in this
//! binary installed one, so every `log::` line (the `[MCP-HOLD]` diagnostics,
//! `[CONPTY]`, `[FRAMELOOP]`, rejected-token warnings) was silently dropped.
//! This writes them to stderr, which the app already captures into the host log
//! (`pty_host_client`'s `host.log`) and which the elevated dial-out mode
//! redirects to its own file (`redirect_stdio_to`). No new dependency.
//!
//! Two rules shape it:
//! - **Logging never blocks the caller.** `log` is called from the holder's
//!   tasks and from synchronous control handlers (`ReleaseMcp` logs before its
//!   ack is queued). A stderr write can stall (a full pipe, a slow disk), so the
//!   caller only formats the line and `try_send`s it into a bounded queue; one
//!   writer thread does the I/O. A full queue drops the line and counts it, and
//!   the writer reports the count with its next line.
//! - **Only this repo's crates are logged.** Installing a global logger also
//!   turns on every dependency's `log` calls. portable-pty logs the whole
//!   `CreateProcessW` command line on a failed spawn, arguments included, and
//!   arguments can carry secrets. Records from any other target are dropped.

use log::{Level, LevelFilter, Log, Metadata, Record, SetLoggerError};
use std::fmt::Arguments;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::OnceLock;
use std::time::Duration;

/// Info and above. `debug!`/`trace!` sites (for example the per-read pump
/// diagnostics in `pty-protocol`) stay off.
const LEVEL: LevelFilter = LevelFilter::Info;

/// The crates whose `log` sites were audited (review 295 F2). A record's target
/// defaults to its module path, so this is the crate name or `crate::module`.
const TARGETS: [&str; 2] = ["termflow_pty_host", "termflow_pty_protocol"];

/// Lines waiting for the writer. Bounded: a stalled sink costs at most this many
/// lines of memory, then lines are dropped.
const QUEUE_LINES: usize = 1024;

/// How long `flush` waits for the writer. Only `main`'s exit and tests call it.
const FLUSH_WAIT: Duration = Duration::from_millis(500);

enum Msg {
    Line(String),
    Flush(SyncSender<()>),
}

/// The non-blocking half the callers use; the writer thread owns the sink.
struct Queue {
    tx: SyncSender<Msg>,
    dropped: AtomicU64,
}

impl Queue {
    /// Starts the writer thread over `sink`.
    fn start<W: Write + Send + 'static>(sink: W, capacity: usize) -> std::io::Result<Self> {
        let (tx, rx) = sync_channel(capacity);
        std::thread::Builder::new().name("pty-host-log".into()).spawn(move || write_lines(rx, sink))?;
        Ok(Queue { tx, dropped: AtomicU64::new(0) })
    }

    /// Never blocks: a full queue drops the line and counts it.
    fn submit(&self, line: String) {
        let dropped = self.dropped.swap(0, Ordering::Relaxed);
        let line = if dropped > 0 { format!("{line} ({dropped} earlier log lines dropped)") } else { line };
        if let Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) = self.tx.try_send(Msg::Line(line)) {
            self.dropped.fetch_add(dropped + 1, Ordering::Relaxed);
        }
    }

    /// Waits, at most `FLUSH_WAIT` in total, for the lines queued so far to be written.
    fn flush(&self) {
        let (ack_tx, ack_rx) = sync_channel(1);
        let deadline = std::time::Instant::now() + FLUSH_WAIT;
        let mut msg = Msg::Flush(ack_tx);
        loop {
            match self.tx.try_send(msg) {
                Ok(()) => break,
                Err(TrySendError::Full(back)) if std::time::Instant::now() < deadline => {
                    msg = back;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return,
            }
        }
        let _ = ack_rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()));
    }
}

fn write_lines<W: Write>(rx: Receiver<Msg>, mut sink: W) {
    for msg in rx {
        match msg {
            // Write errors are ignored: a closed stderr must not end logging or panic.
            Msg::Line(line) => {
                let _ = writeln!(sink, "{line}");
                let _ = sink.flush();
            }
            Msg::Flush(ack) => {
                let _ = ack.try_send(());
            }
        }
    }
}

/// One line, in the same `termflow-pty-host: ` voice as the host's `eprintln!`s.
fn format_line(level: Level, args: &Arguments<'_>) -> String {
    format!("termflow-pty-host: [{level}] {args}")
}

/// Whether `target` names one of the audited crates (or a module inside one).
fn audited_target(target: &str) -> bool {
    TARGETS.iter().any(|t| target.strip_prefix(t).is_some_and(|rest| rest.is_empty() || rest.starts_with("::")))
}

struct QueuedLogger {
    queue: OnceLock<Queue>,
}

static LOGGER: QueuedLogger = QueuedLogger { queue: OnceLock::new() };

impl Log for QueuedLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= LEVEL && audited_target(metadata.target())
    }

    fn log(&self, record: &Record<'_>) {
        if self.enabled(record.metadata()) {
            if let Some(queue) = self.queue.get() {
                queue.submit(format_line(record.level(), record.args()));
            }
        }
    }

    fn flush(&self) {
        if let Some(queue) = self.queue.get() {
            queue.flush();
        }
    }
}

/// Installs the logger, writing to stderr. `main` calls this before anything can log.
pub fn init_logging() -> Result<(), String> {
    let queue = Queue::start(std::io::stderr(), QUEUE_LINES).map_err(|e| format!("could not start the log writer: {e}"))?;
    let _ = LOGGER.queue.set(queue);
    log::set_logger(&LOGGER).map_err(|e: SetLoggerError| e.to_string())?;
    log::set_max_level(LEVEL);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    const PROBE_ENV: &str = "TERMFLOW_PTY_HOST_LOGGING_PROBE";
    const PROBE_TEST: &str = "logging::tests::init_logging_installs_a_logger_that_reaches_stderr";
    const SECRET: &str = "SECRET_SENTINEL_7f3a";

    #[test]
    fn lines_say_who_and_how_serious() {
        assert_eq!(format_line(Level::Warn, &format_args!("[MCP-HOLD] hold rejected")), "termflow-pty-host: [WARN] [MCP-HOLD] hold rejected");
        assert_eq!(format_line(Level::Error, &format_args!("x")), "termflow-pty-host: [ERROR] x");
    }

    #[test]
    fn info_from_this_repo_is_enabled_and_nothing_else() {
        let at = |level, target| LOGGER.enabled(&Metadata::builder().level(level).target(target).build());
        for target in ["termflow_pty_host", "termflow_pty_host::mcp_hold::holder", "termflow_pty_protocol::da1"] {
            assert!(at(Level::Error, target) && at(Level::Warn, target) && at(Level::Info, target), "{target}");
            assert!(!at(Level::Debug, target) && !at(Level::Trace, target), "{target}");
        }
        // Review 296 R2: the vendored portable-pty logs a failed spawn's whole command line.
        for target in ["portable_pty::win::psuedocon", "portable_pty", "tokio::net", "termflow_pty_hostile", "termflow_pty_protocolx::a", ""] {
            assert!(!at(Level::Error, target), "{target} must not be logged");
        }
    }

    /// A sink that blocks every write until released, then records what it got.
    #[derive(Clone)]
    struct GatedSink {
        gate: Arc<(Mutex<bool>, std::sync::Condvar)>,
        got: Arc<Mutex<Vec<u8>>>,
    }

    impl GatedSink {
        fn new() -> Self {
            GatedSink { gate: Arc::new((Mutex::new(false), std::sync::Condvar::new())), got: Arc::default() }
        }
        fn open(&self) {
            *self.gate.0.lock().unwrap() = true;
            self.gate.1.notify_all();
        }
        fn text(&self) -> String {
            String::from_utf8(self.got.lock().unwrap().clone()).unwrap()
        }
    }

    impl Write for GatedSink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let (open, cv) = &*self.gate;
            let _guard = cv.wait_while(open.lock().unwrap(), |open| !*open).unwrap();
            self.got.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Review 296 R1: a stalled sink never stalls the caller. With the sink
    /// blocked, far more lines than the queue holds are submitted, and every
    /// `submit` returns at once; the overflow is dropped and counted, not
    /// buffered without bound.
    #[test]
    fn a_blocked_sink_never_blocks_the_caller() {
        let sink = GatedSink::new();
        let queue = Queue::start(sink.clone(), 8).unwrap();
        let started = Instant::now();
        for i in 0..10_000 {
            queue.submit(format!("line {i}"));
        }
        assert!(started.elapsed() < Duration::from_secs(1), "submits blocked for {:?}", started.elapsed());
        // The flush cannot get through a blocked writer either; it gives up at its bound.
        let started = Instant::now();
        queue.flush();
        assert!(started.elapsed() < FLUSH_WAIT + Duration::from_millis(500), "flush took {:?}", started.elapsed());

        sink.open();
        queue.flush(); // the queued lines drain, so "after" finds room
        queue.submit("after".into());
        queue.flush();
        let text = sink.text();
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines.len() <= 8 + 2 + 1, "the queue is bounded, so most lines were dropped: {} written", lines.len());
        assert_eq!(lines.first(), Some(&"line 0"), "queued lines are written in order");
        let last = lines.last().unwrap();
        assert!(last == &"after" || last.starts_with("after ("), "the line submitted after the drain is written: {last}");
        // A pending count rides on the next line that gets in. That is usually
        // "after", but if the writer started late and freed a slot partway
        // through, an earlier line can carry some or all of it (review 297 R6):
        // add up every count.
        let dropped: usize = lines
            .iter()
            .filter_map(|l| l.strip_suffix(" earlier log lines dropped)"))
            .map(|l| l.rsplit(" (").next().unwrap().parse::<usize>().unwrap())
            .sum();
        assert_eq!(dropped + lines.len() - 1, 10_000, "every line is either written or counted as dropped");
    }

    /// The logger is process-global and other tests install their own capture
    /// logger, so the real `init_logging` is exercised in a fresh process: this
    /// same test binary, re-run on only this test.
    #[test]
    fn init_logging_installs_a_logger_that_reaches_stderr() {
        if std::env::var_os(PROBE_ENV).is_some() {
            init_logging().expect("no logger was installed yet");
            assert!(log::log_enabled!(log::Level::Info), "Info must be on after init_logging");
            assert!(!log::log_enabled!(log::Level::Debug), "Debug must stay off");
            log::warn!("[MCP-HOLD] probe line");
            log::debug!("probe debug line");
            // The vendored portable-pty's failed-spawn diagnostic, at its own target.
            log::error!(target: "portable_pty::win::psuedocon", "CreateProcessW `\"shell.exe\" --token {SECRET}` in cwd `None` failed");
            log::logger().flush();
            return;
        }
        let out = Command::new(std::env::current_exe().expect("this test binary"))
            .args(["--exact", PROBE_TEST, "--nocapture", "--test-threads=1"])
            .env(PROBE_ENV, "1")
            .output()
            .expect("re-run this test binary");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "the probe process failed:\n{stderr}\n{}", String::from_utf8_lossy(&out.stdout));
        assert!(stderr.lines().any(|l| l == "termflow-pty-host: [WARN] [MCP-HOLD] probe line"), "{stderr}");
        assert!(!stderr.contains("probe debug line"), "{stderr}");
        assert!(!stderr.contains(SECRET), "a dependency's command-line log reached the host log: {stderr}");
    }
}
