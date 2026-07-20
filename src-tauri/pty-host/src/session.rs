//! One hosted PTY: the child process, a reader thread that fills the replay
//! ring, and (only while a GUI is attached) streams live output on the event
//! channel.
//!
//! Backpressure safety: the ring is bounded and always filled; the event
//! channel is fed ONLY while attached, so a detached session during a hot-swap
//! cannot grow memory without bound.
//!
//! Exit detection: ConPTY does NOT reliably EOF the output reader when the
//! child exits (the pseudoconsole stays open as long as the master handle
//! lives). So a dedicated waiter thread blocks on `child.wait()` and, once the
//! child is gone, drops the master to close the ConPTY — which makes the reader
//! observe EOF, flush any final bytes, and emit `Data::Exit`. This mirrors the
//! ordering guarantee of the in-process path (all output, then exit).

use crate::ring::ReplayRing;
use crate::util::find_utf8_boundary;
use anyhow::Result;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use termflow_pty_protocol::{Data, SpawnSpec};
use tokio::sync::mpsc::UnboundedSender;

type MasterSlot = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;

pub struct Session {
    pub tab_id: String,
    pid: u32,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// `None` once the waiter has closed the ConPTY after child exit (or after
    /// an explicit kill). Guarded so `resize` and the waiter don't race.
    master: MasterSlot,
    ring: Arc<Mutex<ReplayRing>>,
    /// While false, the reader still fills the ring but does NOT push live bytes
    /// onto the event channel (detached hold — no unbounded growth).
    attached: Arc<AtomicBool>,
    /// True once the child has exited (tombstone kept for late reattach).
    exited: Arc<AtomicBool>,
}

impl Session {
    pub fn spawn(
        tab_id: String,
        spec: &SpawnSpec,
        ring_cap: usize,
        events: UnboundedSender<Data>,
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
        // Drop the slave so the child owns the only slave end — required for the
        // ConPTY to ever signal completion.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = Arc::new(Mutex::new(pair.master.take_writer()?));
        let master: MasterSlot = Arc::new(Mutex::new(Some(pair.master)));
        let ring = Arc::new(Mutex::new(ReplayRing::new(ring_cap)));
        let attached = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));

        // Waiter thread: block on the child, then close the ConPTY so the reader
        // observes EOF. This is the reliable exit signal.
        let master_w = master.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            if let Ok(mut g) = master_w.lock() {
                *g = None; // drop the master → ConPTY closes → reader EOFs
            }
        });

        // Reader thread: drain output into the ring; stream live only while
        // attached; emit Exit after the loop ends (all output delivered first).
        let ring_r = ring.clone();
        let attached_r = attached.clone();
        let exited_r = exited.clone();
        let id_r = tab_id.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(n) if n > 0 => {
                        // Carry incomplete trailing UTF-8 across reads so the
                        // GUI's from_utf8_lossy never sees a split character.
                        let mut data = if pending.is_empty() {
                            buf[..n].to_vec()
                        } else {
                            let mut combined = std::mem::take(&mut pending);
                            combined.extend_from_slice(&buf[..n]);
                            combined
                        };
                        let valid_end = find_utf8_boundary(&data);
                        if valid_end < data.len() {
                            pending = data[valid_end..].to_vec();
                            data.truncate(valid_end);
                        }
                        if data.is_empty() {
                            continue;
                        }
                        // Push and the attached-check happen UNDER the ring lock
                        // so they serialize with `attach()` (snapshot + flip
                        // `attached` under the same lock). That makes "snapshot
                        // through N, then live from N" atomic: a byte is either
                        // in the reattach snapshot OR streamed live, never both.
                        let mut r = ring_r.lock().unwrap();
                        let off = r.tail();
                        r.push(&data);
                        if attached_r.load(Ordering::Acquire) {
                            let _ = events.send(Data::Stdout {
                                tab_id: id_r.clone(),
                                offset: off,
                                bytes: data,
                            });
                        }
                        drop(r);
                    }
                    _ => {
                        // EOF or error: flush remaining bytes, tombstone, notify.
                        if !pending.is_empty() {
                            let mut r = ring_r.lock().unwrap();
                            let off = r.tail();
                            r.push(&pending);
                            if attached_r.load(Ordering::Acquire) {
                                let _ = events.send(Data::Stdout {
                                    tab_id: id_r.clone(),
                                    offset: off,
                                    bytes: std::mem::take(&mut pending),
                                });
                            }
                            drop(r);
                        }
                        exited_r.store(true, Ordering::Release);
                        // exit_cwd is None: the sidecar does not parse OSC cwd —
                        // the GUI fills it from its own tracking on receipt.
                        let _ = events.send(Data::Exit {
                            tab_id: id_r.clone(),
                            exit_cwd: None,
                        });
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

    /// Atomically snapshot the ring from `from_offset` and enable live
    /// streaming, under the ring lock, so the returned snapshot and the
    /// subsequent live stream do not overlap or drop bytes.
    /// Returns `(start_offset, bytes, gap)`.
    pub fn attach(&self, from_offset: u64) -> (u64, Vec<u8>, bool) {
        let r = self.ring.lock().unwrap();
        let snap = r.snapshot_from(from_offset);
        self.attached.store(true, Ordering::Release);
        drop(r);
        (snap.start_offset, snap.bytes, snap.gap)
    }

    pub fn write_stdin(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(bytes)?;
        w.flush()
    }

    pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        let g = self.master.lock().unwrap();
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
        self.ring.lock().unwrap().head()
    }

    pub fn ring_tail(&self) -> u64 {
        self.ring.lock().unwrap().tail()
    }

    /// Snapshot retained bytes from `offset`. Returns (start_offset, bytes, gap).
    pub fn replay_from(&self, offset: u64) -> (u64, Vec<u8>, bool) {
        let snap = self.ring.lock().unwrap().snapshot_from(offset);
        (snap.start_offset, snap.bytes, snap.gap)
    }

    /// Kill the child process tree (taskkill /T /F on Windows), mirroring the
    /// in-process path's `kill_process_tree`.
    pub fn kill(&self) {
        crate::util::kill_process_tree(self.pid);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Dropping a Session (Close or teardown) kills its child. Sessions kept
        // alive across a hot-swap hold are NOT dropped, so their children live.
        self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc::unbounded_channel;

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

    /// Collect events until Exit, bounded so a regression fails fast instead of
    /// hanging the suite.
    async fn drain_until_exit(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<Data>,
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
        let (tx, mut rx) = unbounded_channel();
        let sess = Session::spawn("tab-1".into(), &echo_spec(), 4096, tx).unwrap();
        sess.set_attached(true);
        assert!(sess.pid() > 0, "real pid recorded");

        let (seen, got_exit) = drain_until_exit(&mut rx).await;
        assert!(got_exit, "Exit must fire on child exit");
        assert!(String::from_utf8_lossy(&seen).contains("hi"));
        let (_start, bytes, _gap) = sess.replay_from(0);
        assert!(String::from_utf8_lossy(&bytes).contains("hi"));
    }

    #[tokio::test]
    async fn detached_session_fills_ring_without_streaming() {
        let (tx, mut rx) = unbounded_channel();
        let sess = Session::spawn("tab-2".into(), &echo_spec(), 4096, tx).unwrap();
        // Not attached: no Stdout should arrive, but Exit still fires and the
        // ring still fills (the reader always drains the PTY).
        let (seen, got_exit) = drain_until_exit(&mut rx).await;
        assert!(got_exit, "Exit fires even while detached");
        assert!(seen.is_empty(), "no live stream while detached");
        let (_s, bytes, _g) = sess.replay_from(0);
        assert!(
            String::from_utf8_lossy(&bytes).contains("hi"),
            "ring still filled while detached"
        );
    }
}
