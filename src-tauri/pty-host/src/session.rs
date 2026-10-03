//! One hosted PTY: the child process, a reader thread that fills the replay
//! ring, and (only while a GUI is attached) streams live output on a BOUNDED
//! event channel.
//!
//! Memory safety (dual-review fixes):
//! - The bounded ring is the ONLY durable output buffer. The live event channel
//!   is bounded; on overflow the reader DROPS the frame (bytes remain in the
//!   ring) and emits one `Data::Gap` so the GUI resyncs from the ring. Nothing
//!   grows without bound.
//! - `attach()` snapshots the ring, emits the replay (and a trailing `Exit` if
//!   the child already died) and flips `attached` — all under the ring lock —
//!   so replay is always queued BEFORE any live frame (correct ordering, no
//!   duplicate, no live-before-replay).
//! - A session is created already-attached for the spawn path (before the
//!   reader can run) so early startup output is streamed, not lost.
//! - `Exit` is durable session state (`exited` tombstone). While detached the
//!   reader does not stream `Exit`; the next `attach()` re-emits it after replay.
//! - Locks recover from poisoning (`into_inner`) so one panicking thread cannot
//!   cascade-crash the whole sidecar.
//!
//! Exit detection: ConPTY does not reliably EOF the reader on child exit, so a
//! waiter thread blocks on `child.wait()` and then closes the master to force
//! reader EOF, after a short grace so conhost can flush final output.

use crate::ring::ReplayRing;
use crate::util::find_utf8_boundary;
use anyhow::Result;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtyPair, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use termflow_pty_protocol::da1::{inheritable_cursor_row, StartupDa1, StartupReplies};
use termflow_pty_protocol::pump::pump_output;
use termflow_pty_protocol::{Data, SpawnSpec};
use tokio::sync::mpsc::Sender;

type MasterSlot = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;

/// Lock a mutex, recovering the guard even if the mutex was poisoned by a
/// panicking holder. The sidecar must survive a worker panic rather than
/// cascade-crash and kill every session.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Open the pseudoconsole. `inherit_cursor` (Windows only; the caller already checked the
/// bundled ConPTY is active) creates it with `PSEUDOCONSOLE_INHERIT_CURSOR`, which makes
/// ConPTY ask the terminal where the cursor is and start the child there. `portable-pty`
/// has no switch for it, hence the vendored crate (`vendor/portable-pty/VENDORED.md`).
fn open_pty(size: PtySize, inherit_cursor: bool) -> Result<PtyPair> {
    #[cfg(windows)]
    if inherit_cursor {
        return portable_pty::win::conpty::ConPtySystem::default().openpty_inheriting_cursor(size);
    }
    #[cfg(not(windows))]
    let _ = inherit_cursor;
    native_pty_system().openpty(size)
}

pub struct Session {
    pub tab_id: String,
    pid: u32,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: MasterSlot,
    ring: Arc<Mutex<ReplayRing>>,
    events: Sender<Data>,
    attached: Arc<AtomicBool>,
    /// True once the child has exited (durable tombstone for late reattach).
    exited: Arc<AtomicBool>,
    /// Latched by the first `kill()`, so a session is never killed twice.
    ///
    /// Teardown kills explicitly and then drops the session, which would
    /// otherwise reach `kill()` a second time through `Drop` — and a second
    /// `taskkill /T /F` for the same pid is precisely the recycled-pid hazard
    /// `exited` exists to prevent, just arrived at by a different route.
    killing: Arc<AtomicBool>,
    /// Set by the kill thread once `kill_process_tree` has RETURNED.
    ///
    /// Makes teardown's actual contract — "this call waited for the kill" —
    /// observable. The child's *death* cannot serve that purpose: it is
    /// asynchronous in the kernel and outside our control. A SIGKILL'd Unix
    /// process stays a zombie (and `kill(pid, 0)` keeps returning 0) until its
    /// waiter thread reaps it, and a Windows process can still report
    /// `STILL_ACTIVE` briefly after `taskkill.exe` exits. Asserting on pid
    /// liveness therefore tests the OS's cleanup schedule, not our behaviour —
    /// which is precisely how it flakes.
    kill_done: Arc<AtomicBool>,
    /// Set by the reader when it found and removed the ConPTY startup DA1 query, just before it
    /// asks for the reply to be sent (plan 050). That is a REQUEST: starting the reply thread,
    /// taking the writer lock and the write itself can each still fail or wait. Diagnostic only;
    /// the inbox ConPTY never asks, so `true` means the modern handshake's query was observed.
    #[cfg_attr(not(test), allow(dead_code))]
    da1_reply_requested: Arc<AtomicBool>,
}

impl Session {
    /// Spawn a hosted PTY. `attached_initial` is set BEFORE the reader thread
    /// starts, so the spawn path (true) streams output from byte 0.
    pub fn spawn(
        tab_id: String,
        spec: &SpawnSpec,
        ring_cap: usize,
        events: Sender<Data>,
        attached_initial: bool,
    ) -> Result<Session> {
        // A restored terminal asks for its child to start on the row its replayed history ends
        // on (see `SpawnSpec::initial_cursor_row`). Honoured only where ConPTY can; the reader's
        // filter below is built from this same answer so the two cannot disagree.
        let cursor_row = inheritable_cursor_row(spec.initial_cursor_row);
        let pair = open_pty(
            PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 },
            cursor_row.is_some(),
        )?;

        let mut cmd = CommandBuilder::new(&spec.shell);
        cmd.args(&spec.args);
        for k in &spec.env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        if let Some(dir) = &spec.cwd {
            if !dir.is_empty() {
                cmd.cwd(dir);
            }
        }

        let mut child = pair.slave.spawn_command(cmd)?;
        let pid = child.process_id().unwrap_or(0);
        drop(pair.slave);

        let pair_reader = pair.master.try_clone_reader()?;
        let writer = Arc::new(Mutex::new(pair.master.take_writer()?));
        let master: MasterSlot = Arc::new(Mutex::new(Some(pair.master)));
        let ring = Arc::new(Mutex::new(ReplayRing::new(ring_cap)));
        let attached = Arc::new(AtomicBool::new(attached_initial));
        let exited = Arc::new(AtomicBool::new(false));
        let da1_reply_requested = Arc::new(AtomicBool::new(false));

        // Waiter: on child exit, wait a short grace so conhost flushes final
        // output, then drop the master to force the reader to observe EOF.
        let master_w = master.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            std::thread::sleep(Duration::from_millis(75));
            *lock(&master_w) = None;
        });

        // Reader: drain output into the ring; stream live (bounded) while
        // attached; emit Exit after the loop when attached. The loop itself is
        // `pump_output` (shared with the in-process fallback reader, plan 050):
        // it applies the ConPTY startup-handshake filter, the UTF-8 carry and the
        // ordered EOF/error tail.
        let shared = ReaderShared {
            ring: ring.clone(),
            attached: attached.clone(),
            exited: exited.clone(),
            events: events.clone(),
            tab_id: tab_id.clone(),
            writer: writer.clone(),
            da1_reply_requested: da1_reply_requested.clone(),
        };
        std::thread::spawn(move || run_reader(pair_reader, shared, StartupDa1::for_spawn(cursor_row)));

        Ok(Session {
            tab_id,
            pid,
            writer,
            master,
            ring,
            events,
            attached,
            exited,
            killing: Arc::new(AtomicBool::new(false)),
            kill_done: Arc::new(AtomicBool::new(false)),
            da1_reply_requested,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn is_alive(&self) -> bool {
        !self.exited.load(Ordering::Acquire)
    }

    /// Whether the modern ConPTY's startup DA1 query was found, removed and its reply requested
    /// (not that the reply was written). Test-only, like `kill_done_flag`: production never reads it.
    #[cfg(test)]
    pub fn startup_da1_reply_requested(&self) -> bool {
        self.da1_reply_requested.load(Ordering::Acquire)
    }

    pub fn set_attached(&self, on: bool) {
        self.attached.store(on, Ordering::Release);
    }

    /// Reattach: under the ring lock, emit a Gap (if bytes were evicted), the
    /// replay snapshot, then enable live streaming — and, if the child already
    /// exited, a trailing Exit. Doing all of this before releasing the lock
    /// guarantees the GUI receives replay strictly before any live frame.
    pub fn attach(&self, from_offset: u64) {
        let r = lock(&self.ring);
        let snap = r.snapshot_from(from_offset);
        if snap.gap {
            let _ = self.events.try_send(Data::Gap {
                tab_id: self.tab_id.clone(),
                at_offset: snap.start_offset,
            });
        }
        if !snap.bytes.is_empty() {
            let _ = self.events.try_send(Data::Stdout {
                tab_id: self.tab_id.clone(),
                offset: snap.start_offset,
                bytes: snap.bytes,
            });
        }
        self.attached.store(true, Ordering::Release);
        let exited = self.exited.load(Ordering::Acquire);
        drop(r);
        if exited {
            let _ = self.events.try_send(Data::Exit {
                tab_id: self.tab_id.clone(),
                exit_cwd: None,
            });
        }
    }

    pub fn write_stdin(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut w = lock(&self.writer);
        w.write_all(bytes)?;
        w.flush()
    }

    pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        let g = lock(&self.master);
        match g.as_ref() {
            Some(m) => m
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string())),
            None => Ok(()), // already exited
        }
    }

    pub fn ring_head(&self) -> u64 {
        lock(&self.ring).head()
    }

    pub fn ring_tail(&self) -> u64 {
        lock(&self.ring).tail()
    }

    #[cfg(test)]
    pub fn replay_from(&self, offset: u64) -> (u64, Vec<u8>, bool) {
        let snap = lock(&self.ring).snapshot_from(offset);
        (snap.start_offset, snap.bytes, snap.gap)
    }

    /// Start killing the child process tree, returning the thread doing the
    /// work. `None` means nothing was started: the child already exited, or a
    /// kill is already in flight.
    ///
    /// NEVER kills a session known to have exited: the OS may have reused its
    /// PID, and taskkill'ing a recycled PID would kill an unrelated tree.
    ///
    /// Backgrounded because the usual caller is `Drop`, reached via
    /// `Control::Close` on the single connection-reader loop
    /// (`transport::run_connection`). `kill_process_tree` blocks on
    /// `taskkill /T /F` (1-3s+ for a shell's whole tree), and that loop cannot
    /// read the NEXT frame — e.g. the `Spawn` for a tab opened right after this
    /// close — until the handler returns.
    ///
    /// The handle is returned rather than dropped because *one* caller must not
    /// outlive the kill: `SessionManager::tear_down_sessions` exits the process
    /// moments later, and an unstarted kill thread dies with it (see there).
    pub fn kill(&self) -> Option<std::thread::JoinHandle<()>> {
        if self.exited.load(Ordering::Acquire) {
            return None;
        }
        if self.killing.swap(true, Ordering::AcqRel) {
            return None; // already killing — see the `killing` field doc
        }
        let pid = self.pid;
        let done = self.kill_done.clone();
        Some(std::thread::spawn(move || {
            crate::util::kill_process_tree(pid);
            done.store(true, Ordering::Release);
        }))
    }

    /// Observe whether this session's kill has finished — see `kill_done`.
    /// Cloned out because teardown drops the `Session` it belongs to.
    ///
    /// Test-only, like `SessionManager::set_teardown_grace`: production never
    /// reads the flag, only writes it, so ungated this is a `dead_code`
    /// warning. Gating is hygiene, not a CI requirement — rust-tests.yml sets
    /// no `RUSTFLAGS` and the crate has no `deny(warnings)`, so warnings do
    /// not fail the build.
    #[cfg(test)]
    pub fn kill_done_flag(&self) -> Arc<AtomicBool> {
        self.kill_done.clone()
    }
}

/// Everything the reader thread shares with its [`Session`].
struct ReaderShared {
    ring: Arc<Mutex<ReplayRing>>,
    attached: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    events: Sender<Data>,
    tab_id: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    da1_reply_requested: Arc<AtomicBool>,
}

/// The reader thread body, over any `Read` so it is testable without a PTY.
///
/// Ring push + attached-check + live send are serialized with `attach()` on the
/// ring lock, so a byte is either in the reattach snapshot OR streamed live, never
/// both. The ConPTY startup DA1 query is removed BEFORE the ring push, so neither
/// replay nor the renderer ever sees it; its reply is sent from its own thread (never
/// under the ring lock, never blocking this loop on the writer mutex).
fn run_reader<R: Read>(mut reader: R, sh: ReaderShared, mut da1: StartupDa1) {
    // True after a live frame was dropped under backpressure; the next
    // successful send is preceded by a Gap so the GUI resyncs.
    let mut lost = false;
    let mut replies = StartupReplies::new(sh.writer.clone(), sh.tab_id.clone());
    pump_output(
        &mut reader,
        find_utf8_boundary,
        &mut da1,
        |reply| {
            if reply.da1 {
                sh.da1_reply_requested.store(true, Ordering::Release);
            }
            replies.send(reply);
        },
        |data| {
            let mut r = lock(&sh.ring);
            let off = r.tail();
            r.push(&data);
            if sh.attached.load(Ordering::Acquire) {
                lost = stream_live(&sh.events, &sh.tab_id, off, data, lost);
            }
            drop(r);
        },
    );
    sh.exited.store(true, Ordering::Release);
    // Only stream Exit if attached; while detached (Hold) the tombstone is the
    // durable signal and attach() re-emits Exit after replay on reconnect.
    if sh.attached.load(Ordering::Acquire) {
        let _ = sh.events.try_send(Data::Exit { tab_id: sh.tab_id.clone(), exit_cwd: None });
    }
}

/// Emit one live output chunk on the bounded channel. If a previous frame was
/// dropped (`lost`), first emit a Gap so the GUI resyncs from the ring. On
/// overflow the chunk is dropped (bytes remain in the ring) and `lost` is
/// returned true. Never blocks — safe to call under the ring lock.
fn stream_live(
    events: &Sender<Data>,
    tab_id: &str,
    offset: u64,
    bytes: Vec<u8>,
    lost: bool,
) -> bool {
    if lost {
        // Announce the discontinuity first; if the channel is still full, keep
        // `lost` set (return true) and drop this chunk too (ring retains it).
        if events
            .try_send(Data::Gap {
                tab_id: tab_id.to_string(),
                at_offset: offset,
            })
            .is_err()
        {
            return true;
        }
    }
    if events
        .try_send(Data::Stdout {
            tab_id: tab_id.to_string(),
            offset,
            bytes,
        })
        .is_err()
    {
        return true; // dropped under backpressure; ring still has the bytes
    }
    false
}

impl Drop for Session {
    fn drop(&mut self) {
        // Close kills the child (unless already exited — PID reuse). Sessions
        // kept alive across a hot-swap hold are NOT dropped.
        //
        // Fire-and-forget is right HERE and only here: this process keeps
        // running after an interactive close, so the thread finishes. The
        // teardown path cannot rely on that and kills explicitly first — which
        // latches `killing`, making this a no-op rather than a second kill.
        let _ = self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc::channel;

    /// A child that stays alive long enough to be killed deliberately, so a
    /// test about killing cannot pass because the child had already exited.
    fn sleep_spec() -> SpawnSpec {
        let (shell, args) = if cfg!(windows) {
            ("cmd.exe", vec!["/c".to_string(), "ping -n 60 127.0.0.1 >NUL".to_string()])
        } else {
            ("/bin/sh", vec!["-c".to_string(), "sleep 60".to_string()])
        };
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

    /// Teardown kills explicitly and THEN drops the session, so `kill` is
    /// reached twice for one child. The second must do nothing: a repeat
    /// `taskkill /T /F` on a pid the OS may already have recycled is exactly the
    /// hazard the `exited` tombstone guards against, arrived at by another
    /// route. `exited` cannot cover this one — it is still false in the window
    /// between the first kill starting and the child actually dying.
    #[test]
    fn a_second_kill_is_a_no_op() {
        let (tx, _rx) = channel(1024);
        let sess =
            Session::spawn("tab-kill-once".into(), &sleep_spec(), 4096, tx, false).unwrap();
        let first = sess.kill();
        assert!(first.is_some(), "the first kill must actually start one");
        assert!(
            sess.kill().is_none(),
            "a second kill started another taskkill for the same pid"
        );
        if let Some(h) = first {
            let _ = h.join();
        }
    }

    fn echo_spec() -> SpawnSpec {
        if cfg!(windows) {
            SpawnSpec {
                shell: "cmd.exe".into(),
                args: vec!["/c".into(), "echo hi".into()],
                env: vec![],
                env_remove: vec![],
                cwd: None,
                cols: 80,
                rows: 24,
                initial_cursor_row: None,
            }
        } else {
            SpawnSpec {
                shell: "/bin/sh".into(),
                args: vec!["-c".into(), "echo hi".into()],
                env: vec![],
                env_remove: vec![],
                cwd: None,
                cols: 80,
                rows: 24,
                initial_cursor_row: None,
            }
        }
    }

    async fn drain_until_exit(
        rx: &mut tokio::sync::mpsc::Receiver<Data>,
    ) -> (Vec<u8>, bool) {
        let mut seen = Vec::new();
        let mut got_exit = false;
        let _ = tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(d) = rx.recv().await {
                match d {
                    Data::Stdout { bytes, .. } => seen.extend(bytes),
                    Data::Exit { .. } => {
                        got_exit = true;
                        break;
                    }
                    _ => {}
                }
            }
        })
        .await;
        (seen, got_exit)
    }

    #[tokio::test]
    async fn session_streams_when_attached_and_fills_ring() {
        let (tx, mut rx) = channel(1024);
        let sess = Session::spawn("tab-1".into(), &echo_spec(), 4096, tx, true).unwrap();
        assert!(sess.pid() > 0, "real pid recorded");

        let (seen, got_exit) = drain_until_exit(&mut rx).await;
        assert!(got_exit, "Exit must fire on child exit");
        assert!(String::from_utf8_lossy(&seen).contains("hi"));
        let (_start, bytes, _gap) = sess.replay_from(0);
        assert!(String::from_utf8_lossy(&bytes).contains("hi"));
    }

    // Task 3.2: resize is OS-neutral (portable-pty ioctl); confirm the Unix
    // path succeeds on a live child and is a benign no-op after it exits.
    #[cfg(unix)]
    #[tokio::test]
    async fn unix_resize_succeeds_then_noop_after_exit() {
        let (tx, _rx) = channel(1024);
        let spec = SpawnSpec {
            shell: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 5".into()],
            env: vec![],
            env_remove: vec![],
            cwd: None,
            cols: 80,
            rows: 24,
            initial_cursor_row: None,
        };
        let sess = Session::spawn("tab-resize".into(), &spec, 4096, tx, true).unwrap();
        sess.resize(120, 40).expect("resize a live pty succeeds");
        sess.kill();
        // After the child exits the master slot is cleared; resize is a no-op Ok.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while sess.is_alive() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(sess.resize(100, 30).is_ok(), "resize after exit is a no-op Ok");
    }

    #[tokio::test]
    async fn detached_session_fills_ring_without_streaming() {
        let (tx, mut rx) = channel(1024);
        // attached_initial = false: no Stdout/Exit should stream, but the ring
        // still fills and the tombstone is set.
        let sess = Session::spawn("tab-2".into(), &echo_spec(), 4096, tx, false).unwrap();
        let mut got_stream = false;
        let _ = tokio::time::timeout(Duration::from_secs(8), async {
            while let Some(d) = rx.recv().await {
                match d {
                    Data::Stdout { .. } | Data::Exit { .. } => {
                        got_stream = true;
                        break;
                    }
                    _ => {}
                }
            }
        })
        .await;
        assert!(!got_stream, "no live stream while detached");
        // Ring still filled; tombstone set after the child exits.
        let (_s, bytes, _g) = sess.replay_from(0);
        assert!(String::from_utf8_lossy(&bytes).contains("hi"));
    }

    #[tokio::test]
    async fn reattach_replays_then_reemits_exit_for_dead_session() {
        let (tx, mut rx) = channel(1024);
        // Start detached; let the child run + exit into the ring/tombstone.
        let sess = Session::spawn("tab-3".into(), &echo_spec(), 4096, tx, false).unwrap();
        // Wait for exit tombstone.
        let _ = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if !sess.is_alive() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        // Now reattach: expect replay bytes, then an Exit.
        sess.attach(0);
        let (seen, got_exit) = drain_until_exit(&mut rx).await;
        assert!(String::from_utf8_lossy(&seen).contains("hi"), "replayed");
        assert!(got_exit, "Exit re-emitted after replay on reattach");
    }

    /// M3: killing a session must reap the child's whole process group, not
    /// just the shell pid — otherwise background jobs / subshells are orphaned.
    #[cfg(unix)]
    #[tokio::test]
    async fn killing_session_reaps_background_descendant() {
        let (tx, mut rx) = channel(1024);
        // Shell starts a long background sleep, prints its pid, then stays alive.
        let spec = SpawnSpec {
            shell: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "sleep 300 & echo BGPID=$!; sleep 300".into(),
            ],
            env: vec![],
            env_remove: vec![],
            cwd: None,
            cols: 80,
            rows: 24,
            initial_cursor_row: None,
        };
        let sess = Session::spawn("tab-bg".into(), &spec, 8192, tx, true).unwrap();

        // Read the background child's pid from the stream.
        let mut buf = String::new();
        let bg_pid: i32 = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match rx.recv().await {
                    Some(Data::Stdout { bytes, .. }) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        if let Some(rest) = buf.split("BGPID=").nth(1) {
                            let digits: String =
                                rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                            if !digits.is_empty() {
                                if let Ok(p) = digits.parse() {
                                    return p;
                                }
                            }
                        }
                    }
                    Some(_) => {}
                    None => return 0,
                }
            }
        })
        .await
        .expect("did not read BGPID in time");
        assert!(bg_pid > 0, "captured background child pid");

        // The background child is alive before the kill.
        assert_eq!(
            unsafe { libc::kill(bg_pid, 0) },
            0,
            "background child should be alive before kill"
        );

        // Kill the session; the process-group kill must reap the background child.
        sess.kill();

        let reaped = tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                if unsafe { libc::kill(bg_pid, 0) } != 0 {
                    return true; // ESRCH ⇒ gone
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .unwrap_or(false);
        assert!(
            reaped,
            "process-group kill must reap the background descendant (pid {bg_pid})"
        );
    }

    // ---- plan 050: the ConPTY startup DA1 handshake -------------------------

    use std::collections::VecDeque;
    use std::sync::atomic::AtomicBool as Flag;
    use std::time::Instant;
    use termflow_pty_protocol::da1::DA1_REPLY;
    use tokio::sync::mpsc::Receiver;

    /// Reads one scripted chunk per call, then EOF.
    struct Script(VecDeque<Vec<u8>>);
    impl Script {
        fn new(chunks: &[&[u8]]) -> Self {
            Script(chunks.iter().map(|c| c.to_vec()).collect())
        }
    }
    impl Read for Script {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            match self.0.pop_front() {
                None => Ok(0),
                Some(v) => {
                    out[..v.len()].copy_from_slice(&v);
                    Ok(v.len())
                }
            }
        }
    }

    /// A writer that records what reaches the PTY's input.
    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);
    impl Write for Captured {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn wait_for(cond: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        cond()
    }

    const PRE: &[u8] = b"\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h";
    const PRE_STRIPPED: &[u8] = b"\x1b[1t\x1b[?1004h\x1b[?9001h";

    /// A `Session` assembled from fakes, plus the reader's input writer and the GUI channel.
    /// `run_reader` is executed inline, so the ring and `exited` are settled on return.
    fn fake_session(
        chunks: &[&[u8]],
        attached: bool,
        armed: bool,
    ) -> (Session, Receiver<Data>, Captured) {
        let (tx, rx) = channel(1024);
        let cap = Captured::default();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(cap.clone())));
        let ring = Arc::new(Mutex::new(ReplayRing::new(1 << 16)));
        let (attached, exited, answered) = (
            Arc::new(Flag::new(attached)),
            Arc::new(Flag::new(false)),
            Arc::new(Flag::new(false)),
        );
        run_reader(
            Script::new(chunks),
            ReaderShared {
                ring: ring.clone(),
                attached: attached.clone(),
                exited: exited.clone(),
                events: tx.clone(),
                tab_id: "tab-fake".into(),
                writer: writer.clone(),
                da1_reply_requested: answered.clone(),
            },
            StartupDa1::new(armed),
        );
        let sess = Session {
            tab_id: "tab-fake".into(),
            pid: 0,
            writer,
            master: Arc::new(Mutex::new(None)),
            ring,
            events: tx,
            attached,
            exited,
            killing: Arc::new(Flag::new(true)), // nothing to kill: Drop must not taskkill pid 0
            kill_done: Arc::new(Flag::new(false)),
            da1_reply_requested: answered,
        };
        (sess, rx, cap)
    }

    fn drain(rx: &mut Receiver<Data>) -> Vec<Data> {
        let mut v = Vec::new();
        while let Ok(d) = rx.try_recv() {
            v.push(d);
        }
        v
    }

    #[test]
    fn startup_query_is_answered_once_and_never_reaches_the_live_stream() {
        let (sess, mut rx, cap) = fake_session(
            &[b"\x1b[1t", b"\x1b[c\x1b[?1004h", b"\x1b[?9001h", b"banner\r\n"],
            true,
            true,
        );
        assert!(sess.startup_da1_reply_requested());
        assert!(wait_for(|| *cap.0.lock().unwrap() == DA1_REPLY), "exactly one reply reaches the PTY input");

        let mut want = PRE_STRIPPED.to_vec();
        want.extend_from_slice(b"banner\r\n");
        let (mut bytes, mut next, mut exits) = (Vec::new(), 0u64, 0);
        for d in drain(&mut rx) {
            match d {
                Data::Stdout { tab_id, offset, bytes: b, .. } => {
                    assert_eq!(tab_id, "tab-fake", "frames are routed by tab_id in the client");
                    assert_eq!(offset, next, "live offsets are contiguous");
                    next += b.len() as u64;
                    bytes.extend(b);
                }
                Data::Exit { tab_id, .. } => {
                    assert_eq!(tab_id, "tab-fake");
                    exits += 1;
                }
                other => panic!("unexpected frame {other:?}"),
            }
        }
        assert_eq!(bytes, want, "everything but the query is forwarded, in order");
        assert_eq!(exits, 1);
        assert_eq!(sess.replay_from(0), (0, want, false), "the ring holds the same filtered stream");
    }

    #[test]
    fn a_detached_session_replays_the_filtered_stream_with_the_right_offsets() {
        let (sess, mut rx, cap) =
            fake_session(&[b"\x1b[1t\x1b", b"[c\x1b[?1004h\x1b[?9001h", b"banner\r\n"], false, true);
        let mut want = PRE_STRIPPED.to_vec();
        want.extend_from_slice(b"banner\r\n");
        assert!(drain(&mut rx).is_empty(), "nothing is streamed while detached");
        assert_eq!(sess.replay_from(0), (0, want.clone(), false));

        sess.attach(0);
        let frames = drain(&mut rx);
        match &frames[..] {
            [Data::Stdout { tab_id, offset: 0, bytes, .. }, Data::Exit { tab_id: exit_tab, .. }] => {
                assert_eq!((tab_id.as_str(), exit_tab.as_str()), ("tab-fake", "tab-fake"));
                assert_eq!(bytes, &want)
            }
            other => panic!("attach(0) must replay the whole filtered ring then Exit: {other:?}"),
        }
        sess.attach(9);
        match &drain(&mut rx)[..] {
            [Data::Stdout { tab_id, offset: 9, bytes, .. }, Data::Exit { tab_id: exit_tab, .. }] => {
                assert_eq!((tab_id.as_str(), exit_tab.as_str()), ("tab-fake", "tab-fake"));
                assert_eq!(bytes, &want[9..])
            }
            other => panic!("attach(9) must replay the exact suffix: {other:?}"),
        }
        assert!(wait_for(|| cap.0.lock().unwrap().len() == DA1_REPLY.len()));
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(*cap.0.lock().unwrap(), DA1_REPLY, "replay must not trigger a second answer");
    }

    #[test]
    fn a_disarmed_reader_leaves_the_query_alone() {
        let (sess, mut rx, cap) = fake_session(&[PRE], true, false);
        assert!(!sess.startup_da1_reply_requested());
        let (mut got, mut next, mut exits) = (Vec::new(), 0u64, 0);
        for d in drain(&mut rx) {
            match d {
                Data::Stdout { tab_id, offset, bytes, .. } => {
                    assert_eq!(tab_id, "tab-fake", "frames are routed by tab_id in the client");
                    assert_eq!(offset, next, "live offsets are contiguous");
                    next += bytes.len() as u64;
                    got.extend(bytes);
                }
                Data::Exit { tab_id, .. } => {
                    assert_eq!(tab_id, "tab-fake");
                    exits += 1;
                }
                other => panic!("unexpected frame {other:?}"),
            }
        }
        assert_eq!(got, PRE);
        assert_eq!(exits, 1);
        std::thread::sleep(Duration::from_millis(50));
        assert!(cap.0.lock().unwrap().is_empty(), "inbox ConPTY: nothing is answered");
    }

    #[test]
    fn a_writer_lock_held_by_input_does_not_stall_output() {
        let (tx, _rx) = channel(1024);
        let cap = Captured::default();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(cap.clone())));
        let ring = Arc::new(Mutex::new(ReplayRing::new(1 << 16)));
        let guard = writer.lock().unwrap(); // an in-flight input write
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let shared = ReaderShared {
            ring: ring.clone(),
            attached: Arc::new(Flag::new(true)),
            exited: Arc::new(Flag::new(false)),
            events: tx,
            tab_id: "tab-blocked".into(),
            writer: writer.clone(),
            da1_reply_requested: Arc::new(Flag::new(false)),
        };
        std::thread::spawn(move || {
            run_reader(Script::new(&[PRE, b"after the query\r\n"]), shared, StartupDa1::new(true));
            let _ = done_tx.send(());
        });
        assert!(
            done_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "the reader must finish draining while the writer mutex is held"
        );
        let mut want = PRE_STRIPPED.to_vec();
        want.extend_from_slice(b"after the query\r\n");
        assert_eq!(ring.lock().unwrap().snapshot_from(0).bytes, want);
        assert!(cap.0.lock().unwrap().is_empty(), "the reply is still waiting for the lock");
        drop(guard);
        assert!(wait_for(|| *cap.0.lock().unwrap() == DA1_REPLY), "reply lands once the lock is free");
    }

    /// The production half of this file: everything before the test module.
    fn production_source() -> String {
        let src = include_str!("session.rs").replace("\r\n", "\n");
        let cut = src.find("#[cfg(test)]\nmod tests").expect("test module marker");
        src[..cut].to_string()
    }

    /// Spellings that drain a reader without going through the pump.
    fn private_read_spellings(code: &str) -> Vec<&'static str> {
        [".read(", ".read_exact(", ".read_to_end(", ".read_to_string(", ".bytes()", "io::copy("]
            .into_iter()
            .filter(|s| code.contains(s))
            .collect()
    }

    /// A SOURCE-PRESENCE check (it cannot prove reachability); the route itself is pinned by the
    /// fresh-process real-ConPTY test below on Windows. It fixes the PTY reader handle's whole life:
    /// bound from `try_clone_reader`, then handed to `run_reader` together with the platform filter,
    /// and named nowhere else, so it cannot be swapped for another reader or drained privately.
    #[test]
    fn the_host_reader_runs_the_shared_pump_with_the_platform_filter() {
        let code: String = production_source()
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let flat = code.split_whitespace().collect::<Vec<_>>().join(" ");
        for needle in [
            "let pair_reader = pair.master.try_clone_reader()?;",
            "std::thread::spawn(move || run_reader(pair_reader, shared, StartupDa1::for_spawn(cursor_row)));",
            "pump_output( &mut reader, find_utf8_boundary, &mut da1,",
            "StartupReplies::new(sh.writer.clone(), sh.tab_id.clone())",
            "replies.send(reply);",
        ] {
            assert!(flat.contains(needle), "session.rs must contain `{needle}` outside comments");
        }
        assert_eq!(flat.matches("pair_reader").count(), 2, "the PTY reader handle is bound once and passed once");
        assert_eq!(flat.matches("try_clone_reader").count(), 1, "a second cloned PTY reader could drain output outside the pump");
        assert_eq!(private_read_spellings(&code), Vec::<&str>::new(), "a private read loop bypasses the pump");
        // Calibration: the detector does go dirty.
        assert_eq!(private_read_spellings("let n = r.read(&mut b)?;"), vec![".read("]);
    }

    /// Re-execute this test binary running ONLY the body test `body`, in a fresh process, and
    /// require it to print `marker`. `portable-pty` resolves kernel32-vs-bundled ONCE per
    /// process, so running a real-ConPTY test in the shared test process could certify whichever
    /// backend an earlier test happened to open: the child preloads the bundled pair BEFORE any
    /// `openpty`.
    #[cfg(windows)]
    fn run_in_fresh_process(body: &str, marker: &str) {
        // Output goes to files (not pipes) so the parent can poll for a deadline without a
        // pipe-buffer deadlock; the body's own 12 s loop does not bound `Session::spawn` or teardown.
        /// Kills and reaps the child and removes the output files on EVERY exit path, including
        /// a panic while the files are being created or the child polled.
        struct Cleanup {
            paths: Vec<std::path::PathBuf>,
            child: Option<std::process::Child>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Some(c) = self.child.as_mut() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                for p in &self.paths {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
        let dir = std::env::temp_dir();
        let (out_path, err_path) = (
            dir.join(format!("tf-da1-{body}-{}.out", std::process::id())),
            dir.join(format!("tf-da1-{body}-{}.err", std::process::id())),
        );
        let mut guard = Cleanup { paths: vec![out_path.clone(), err_path.clone()], child: None };
        let (out_file, err_file) = (std::fs::File::create(&out_path).unwrap(), std::fs::File::create(&err_path).unwrap());
        guard.child = Some(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([body, "--nocapture", "--test-threads=1"])
                .env("TF_DA1_CHILD", "1")
                .stdout(out_file)
                .stderr(err_file)
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(60);
        let status = loop {
            if let Some(st) = guard.child.as_mut().unwrap().try_wait().unwrap() {
                break Some(st);
            }
            if Instant::now() >= deadline {
                break None; // the guard kills and reaps it
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let text = format!(
            "{}\n{}",
            std::fs::read_to_string(&out_path).unwrap_or_default(),
            std::fs::read_to_string(&err_path).unwrap_or_default()
        );
        let status = status.unwrap_or_else(|| panic!("fresh-process test `{body}` hung (killed after 60 s):\n{text}"));
        assert!(status.success(), "fresh-process test `{body}` failed:\n{text}");
        assert!(text.contains(marker), "child did not report success (vacuous pass?):\n{text}");
    }

    #[cfg(windows)]
    #[test]
    fn bundled_conpty_handshake_is_answered_by_the_host_session() {
        if std::env::var_os("TF_DA1_CHILD").is_some() {
            return; // the child runs the body below, not this driver
        }
        run_in_fresh_process("fresh_process_bundled_handshake_body", "DA1-FRESH-OK");
    }

    #[cfg(windows)]
    #[test]
    fn bundled_conpty_starts_the_child_on_the_row_the_spec_asks_for() {
        if std::env::var_os("TF_DA1_CHILD").is_some() {
            return;
        }
        run_in_fresh_process("fresh_process_inherit_cursor_body", "INHERIT-FRESH-OK");
    }

    #[cfg(windows)]
    #[test]
    fn fresh_process_bundled_handshake_body() {
        if std::env::var_os("TF_DA1_CHILD").is_none() {
            return; // only meaningful in the dedicated child process
        }
        let _ = termflow_pty_protocol::conpty::init_for_current_exe();
        assert!(
            termflow_pty_protocol::conpty::is_bundled_active(),
            "the bundled ConPTY did not load, so this test would certify the inbox backend. \
             Debug builds find the pair by walking up from the test exe to `binaries/conpty`; \
             keep CARGO_TARGET_DIR under src-tauri/ (or unset)."
        );
        let nonce = "TF-DA1-NONCE-7f3a";
        let spec = SpawnSpec {
            shell: "cmd.exe".into(),
            args: vec!["/D".into(), "/C".into(), format!("echo {nonce}")],
            env: vec![],
            env_remove: vec![],
            cwd: None,
            cols: 100,
            rows: 30,
            initial_cursor_row: None,
        };
        let (tx, mut rx) = channel(1024);
        let t0 = Instant::now();
        let sess = Session::spawn("tab-da1-real".into(), &spec, 1 << 16, tx, true).unwrap();

        let (mut all, mut next, mut t_reply, mut t_nonce) = (Vec::<u8>::new(), 0u64, None, None);
        while t0.elapsed() < Duration::from_secs(12) {
            if t_reply.is_none() && sess.startup_da1_reply_requested() {
                t_reply = Some(t0.elapsed());
            }
            match rx.try_recv() {
                Ok(Data::Stdout { tab_id, offset, bytes, .. }) => {
                    assert_eq!(tab_id, "tab-da1-real", "frames are routed by tab_id in the client");
                    assert_eq!(offset, next, "offsets must stay contiguous");
                    next += bytes.len() as u64;
                    all.extend(bytes);
                    if t_nonce.is_none() && String::from_utf8_lossy(&all).contains(nonce) {
                        t_nonce = Some(t0.elapsed());
                    }
                }
                Ok(Data::Exit { tab_id, .. }) => {
                    assert_eq!(tab_id, "tab-da1-real");
                    break;
                }
                Ok(other) => panic!("unexpected frame from a healthy session: {other:?}"),
                Err(_) => std::thread::sleep(Duration::from_millis(2)),
            }
        }
        if t_reply.is_none() && sess.startup_da1_reply_requested() {
            t_reply = Some(t0.elapsed());
        }
        let (t_reply, t_nonce) = (
            t_reply.expect("no reply to the modern ConPTY's startup DA1 was ever requested"),
            t_nonce.expect("the child's output never arrived"),
        );
        let text = String::from_utf8_lossy(&all).into_owned();
        assert!(!all.windows(3).any(|w| w == b"\x1b[c"), "the query must not be forwarded: {text:?}");
        assert!(all.starts_with(b"\x1b[1t"), "the rest of the preamble is preserved: {text:?}");
        assert!(text.contains("\u{1b}[?1004h\u{1b}[?9001h"), "mode sets survive: {text:?}");
        assert_eq!(sess.replay_from(0).1, all, "the ring equals the forwarded stream");
        assert!(
            t_nonce.saturating_sub(t_reply) < Duration::from_secs(1),
            "child output {:?} after the reply (reply requested at {t_reply:?})",
            t_nonce.saturating_sub(t_reply)
        );
        assert!(t_nonce < Duration::from_millis(2500), "un-fixed ConPTY stalls >= 3 s; got {t_nonce:?}");
        println!("DA1-FRESH-OK reply_requested_at={t_reply:?} child_output_at={t_nonce:?}");
    }

    /// Spawn `echo NONCE` through a real `Session` asking for `initial_cursor_row`, and return
    /// (everything the host forwarded, time of the nonce). The host answers ConPTY's startup
    /// queries itself, so a passing run needs no renderer.
    #[cfg(windows)]
    fn forwarded_stream(row: Option<u16>, nonce: &str) -> (Vec<u8>, Duration) {
        let spec = SpawnSpec {
            shell: "cmd.exe".into(),
            args: vec!["/D".into(), "/C".into(), format!("echo {nonce}")],
            env: vec![],
            env_remove: vec![],
            cwd: None,
            cols: 100,
            rows: 30,
            initial_cursor_row: row,
        };
        let (tx, mut rx) = channel(1024);
        let t0 = Instant::now();
        let sess = Session::spawn("tab-inherit-real".into(), &spec, 1 << 16, tx, true).unwrap();
        let (mut all, mut t_nonce) = (Vec::<u8>::new(), None);
        while t0.elapsed() < Duration::from_secs(12) {
            match rx.try_recv() {
                Ok(Data::Stdout { bytes, .. }) => {
                    all.extend(bytes);
                    if t_nonce.is_none() && String::from_utf8_lossy(&all).contains(nonce) {
                        t_nonce = Some(t0.elapsed());
                    }
                }
                Ok(Data::Exit { .. }) => break,
                Ok(other) => panic!("unexpected frame from a healthy session: {other:?}"),
                Err(_) => std::thread::sleep(Duration::from_millis(2)),
            }
        }
        assert_eq!(sess.replay_from(0).1, all, "the ring equals the forwarded stream");
        (all, t_nonce.expect("the child's output never arrived"))
    }

    /// The whole host-side feature against the REAL bundled ConPTY: a pseudoconsole created
    /// inheriting row 12 asks `ESC[6n`, the host's reader answers it (stripping the query),
    /// and ConPTY then starts the child on row 12 — visible as `ESC[12;1H` ahead of its output.
    /// The `None` run is the control: it must NOT move the cursor, and must not have been
    /// created inheriting (no `ESC[6n` answered, no stall). Without it a ConPTY that always
    /// positioned at row 12 would pass.
    #[cfg(windows)]
    #[test]
    fn fresh_process_inherit_cursor_body() {
        if std::env::var_os("TF_DA1_CHILD").is_none() {
            return; // only meaningful in the dedicated child process
        }
        let _ = termflow_pty_protocol::conpty::init_for_current_exe();
        assert!(
            termflow_pty_protocol::conpty::is_bundled_active(),
            "the bundled ConPTY did not load, so this test would certify the inbox backend. \
             Keep CARGO_TARGET_DIR under src-tauri/ (or unset)."
        );
        assert!(termflow_pty_protocol::da1::inherit_cursor_supported());
        let nonce = "TF-INHERIT-NONCE-5c1e";

        let (with_row, t_with) = forwarded_stream(Some(12), nonce);
        let text = String::from_utf8_lossy(&with_row).into_owned();
        let at_row = text.find("\u{1b}[12;1H").unwrap_or_else(|| panic!("ConPTY never positioned the child on row 12: {text:?}"));
        let at_nonce = text.find(nonce).unwrap();
        assert!(at_row < at_nonce, "the child's output must follow the positioning: {text:?}");
        assert!(!with_row.windows(4).any(|w| w == b"\x1b[6n"), "the cursor query must not be forwarded: {text:?}");
        assert!(!with_row.windows(3).any(|w| w == b"\x1b[c"), "the DA1 query must not be forwarded: {text:?}");
        assert!(t_with < Duration::from_millis(2500), "un-answered ConPTY stalls >= 3 s; got {t_with:?}");

        let (plain, _) = forwarded_stream(None, nonce);
        let text = String::from_utf8_lossy(&plain).into_owned();
        assert!(!text.contains("\u{1b}[12;1H"), "a spec without a row must start on row 1: {text:?}");

        println!("INHERIT-FRESH-OK with_row_at={t_with:?}");
    }
}
