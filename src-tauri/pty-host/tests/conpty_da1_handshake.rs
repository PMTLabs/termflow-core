//! Plan 050 (T6): the real ConPTY premise the startup-DA1 filter is built on.
//!
//! The sideloaded OpenConsole opens every session with `ESC[1t ESC[c ESC[?1004h ESC[?9001h`
//! and holds the child until it gets a DA1 reply (~3 s timeout). This pins that contract
//! against the REAL pseudoconsole: if a future pin bump changes the handshake, this fails
//! and tells the next person to revisit `termflow_pty_protocol::da1`.
//!
//! Scope: it plays the responder itself, so it does NOT detect removal of the production
//! filter — that is covered by the `Session` tests in `pty-host/src/session.rs` and the
//! `da1` / `pump` unit tests.
//!
//! One `#[test]` in its own process: `portable-pty` resolves kernel32-vs-bundled ConPTY once
//! per process, so the bundled pair is preloaded FIRST and verified by loaded-module state
//! (never by the `TERMFLOW_DISABLE_BUNDLED_CONPTY` env flag alone).
#![cfg(windows)]

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};
use termflow_pty_protocol::da1::DA1_REPLY;

const NONCE: &str = "TF-HANDSHAKE-NONCE-91c2";
const PREAMBLE: &[u8] = b"\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h";

struct Run {
    /// Everything read, in order.
    raw: Vec<u8>,
    /// When the child's marker first appeared (None = never).
    marker_at: Option<Duration>,
    /// When the reply was written (None = none sent).
    replied_at: Option<Duration>,
}

fn drain(rx: &Receiver<Vec<u8>>, raw: &mut Vec<u8>, wait: Duration) {
    if let Ok(chunk) = rx.recv_timeout(wait) {
        raw.extend_from_slice(&chunk);
        while let Ok(more) = rx.try_recv() {
            raw.extend_from_slice(&more);
        }
    }
}

/// Spawn `cmd /D /C echo NONCE` under a fresh pseudoconsole. With `reply`, answer the DA1 query
/// the moment it appears; without, never answer. Observes the child's output positively.
fn run(reply: bool) -> Run {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");
    let t0 = Instant::now();
    let mut cmd = CommandBuilder::new("cmd.exe");
    cmd.args(["/D", "/C", &format!("echo {NONCE}")]);
    let mut child = pair.slave.spawn_command(cmd).expect("spawn cmd.exe");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("reader");
    let mut writer = pair.master.take_writer().expect("writer");
    let (tx, rx) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    let mut r = Run { raw: Vec::new(), marker_at: None, replied_at: None };
    while t0.elapsed() < Duration::from_secs(12) && r.marker_at.is_none() {
        drain(&rx, &mut r.raw, Duration::from_millis(5));
        if reply && r.replied_at.is_none() && r.raw.windows(3).any(|w| w == b"\x1b[c") {
            writer.write_all(DA1_REPLY).expect("write reply");
            writer.flush().expect("flush reply");
            r.replied_at = Some(t0.elapsed());
        }
        if String::from_utf8_lossy(&r.raw).contains(NONCE) {
            r.marker_at = Some(t0.elapsed());
        }
    }
    let _ = child.kill();
    r
}

#[test]
fn bundled_conpty_asks_for_da1_and_waits_for_the_answer() {
    let _ = termflow_pty_protocol::conpty::init_for_current_exe();
    assert!(
        termflow_pty_protocol::conpty::is_bundled_active(),
        "the bundled ConPTY did not load, so this test would exercise the inbox backend. \
         Debug builds find `binaries/conpty` by walking up from the test exe: keep \
         CARGO_TARGET_DIR under src-tauri/ (or unset)."
    );

    // (a) The contract: the whole preamble, exactly, at the start of the stream (joined across
    //     reads, because read boundaries are not write boundaries).
    let answered = run(true);
    let m = answered.marker_at.expect("child output never arrived after the reply");
    let replied = answered.replied_at.expect("the DA1 query never appeared in the stream");
    assert!(
        answered.raw.starts_with(PREAMBLE),
        "ConPTY's startup preamble changed - revisit termflow_pty_protocol::da1: {:?}",
        String::from_utf8_lossy(&answered.raw[..answered.raw.len().min(64)])
    );
    // (c) Answering unblocks the child promptly. Absolute bound, not just "soon after the reply":
    //     a backend that always waits ~3 s would still have its marker right behind our reply.
    let after_reply = m.checked_sub(replied).expect("the marker cannot precede the reply that unblocks it");
    assert!(after_reply < Duration::from_secs(1), "child took {after_reply:?} after the reply");
    let answered_at = m;
    assert!(
        answered_at < Duration::from_millis(1500),
        "the answered run took {answered_at:?}: the reply no longer unblocks ConPTY's ~3 s handshake wait"
    );

    // (b) Not answering stalls it for ~3 s — the reason the filter exists. The child's output must
    //     still arrive eventually, or this would also pass for a child that never ran.
    let stalled = run(false);
    let m = stalled.marker_at.expect("child never ran when the query went unanswered");
    assert!(m >= Duration::from_secs(2), "expected the ~3 s handshake stall, child output came at {m:?}");
    assert!(m < Duration::from_secs(10), "child output at {m:?}");
    assert!(
        m > answered_at + Duration::from_secs(1),
        "unanswered ({m:?}) must be clearly slower than answered ({answered_at:?}): the reply is what unblocks the child"
    );
    println!("CONTRACT-OK unanswered stall = {m:?}, answered = {answered_at:?}");
}
