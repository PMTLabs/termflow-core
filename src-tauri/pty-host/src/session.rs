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
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use termflow_pty_protocol::{Data, SpawnSpec};
use tokio::sync::mpsc::Sender;

type MasterSlot = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;

/// Lock a mutex, recovering the guard even if the mutex was poisoned by a
/// panicking holder. The sidecar must survive a worker panic rather than
/// cascade-crash and kill every session.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
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
        let sys = native_pty_system();
        let pair = sys.openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

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

        let reader = pair.master.try_clone_reader()?;
        let writer = Arc::new(Mutex::new(pair.master.take_writer()?));
        let master: MasterSlot = Arc::new(Mutex::new(Some(pair.master)));
        let ring = Arc::new(Mutex::new(ReplayRing::new(ring_cap)));
        let attached = Arc::new(AtomicBool::new(attached_initial));
        let exited = Arc::new(AtomicBool::new(false));

        // Waiter: on child exit, wait a short grace so conhost flushes final
        // output, then drop the master to force the reader to observe EOF.
        let master_w = master.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            std::thread::sleep(Duration::from_millis(75));
            *lock(&master_w) = None;
        });

        // Reader: drain output into the ring; stream live (bounded) while
        // attached; emit Exit after the loop when attached.
        let ring_r = ring.clone();
        let attached_r = attached.clone();
        let exited_r = exited.clone();
        let events_r = events.clone();
        let id_r = tab_id.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            let mut pending: Vec<u8> = Vec::new();
            // True after a live frame was dropped under backpressure; the next
            // successful send is preceded by a Gap so the GUI resyncs.
            let mut lost = false;
            loop {
                match reader.read(&mut buf) {
                    Ok(n) if n > 0 => {
                        let mut data = if pending.is_empty() {
                            buf[..n].to_vec()
                        } else {
                            let mut combined = std::mem::take(&mut pending);
                            combined.extend_from_slice(&buf[..n]);
                            combined
                        };
                        let valid_end = find_utf8_boundary(&data);
                        if valid_end < data.len() {
                            pending = data[valid_end..].to_vec(); // ≤3 bytes
                            data.truncate(valid_end);
                        }
                        if data.is_empty() {
                            continue;
                        }
                        // Ring push + attached-check + live send are serialized
                        // with attach() on the ring lock, so a byte is either in
                        // the reattach snapshot OR streamed live, never both.
                        let mut r = lock(&ring_r);
                        let off = r.tail();
                        r.push(&data);
                        if attached_r.load(Ordering::Acquire) {
                            lost = stream_live(&events_r, &id_r, off, data, lost);
                        }
                        drop(r);
                    }
                    _ => {
                        if !pending.is_empty() {
                            let mut r = lock(&ring_r);
                            let off = r.tail();
                            let tail = std::mem::take(&mut pending);
                            r.push(&tail);
                            if attached_r.load(Ordering::Acquire) {
                                let _ = stream_live(&events_r, &id_r, off, tail, lost);
                            }
                            drop(r);
                        }
                        exited_r.store(true, Ordering::Release);
                        // Only stream Exit if attached; while detached (Hold) the
                        // tombstone is the durable signal and attach() re-emits
                        // Exit after replay on reconnect.
                        if attached_r.load(Ordering::Acquire) {
                            let _ = events_r.try_send(Data::Exit {
                                tab_id: id_r.clone(),
                                exit_cwd: None,
                            });
                        }
                        break;
                    }
                }
            }
        });

        Ok(Session {
            tab_id,
            pid,
            writer,
            master,
            ring,
            events,
            attached,
            exited,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn is_alive(&self) -> bool {
        !self.exited.load(Ordering::Acquire)
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

    pub fn replay_from(&self, offset: u64) -> (u64, Vec<u8>, bool) {
        let snap = lock(&self.ring).snapshot_from(offset);
        (snap.start_offset, snap.bytes, snap.gap)
    }

    /// Kill the child process tree — but NEVER for a session known to have
    /// exited: the OS may have reused its PID, and taskkill'ing a recycled PID
    /// would kill an unrelated process tree.
    pub fn kill(&self) {
        if self.exited.load(Ordering::Acquire) {
            return;
        }
        crate::util::kill_process_tree(self.pid);
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
        // Close/teardown kills the child (unless already exited — PID reuse).
        // Sessions kept alive across a hot-swap hold are NOT dropped.
        self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc::channel;

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
}
