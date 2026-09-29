//! Plan 049 (T4): does a console child actually get its OSC 11 colour query
//! answered through the pseudoconsole?
//!
//! We play the frontend: watch the pty output for the child's `OSC 11 ; ?` and
//! answer it the way xterm.js does. The child (PowerShell, reading the console
//! input queue like Codex's `ReadConsoleInputW` loop) prints what it received
//! and how long the round trip took.
//!
//! Inbox ConPTY drops the query, so with `TERMFLOW_DISABLE_BUNDLED_CONPTY=1`
//! the child times out; with the bundled pair it gets the exact colour we sent.
//! ConPTY resolution is once-per-process, so run the two modes as two runs:
//!   cargo test --test conpty_osc_probe                       (bundled: must answer)
//!   $env:TERMFLOW_DISABLE_BUNDLED_CONPTY=1; cargo test ...   (inbox: expects timeout)
#![cfg(windows)]

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::time::{Duration, Instant};

/// Writes the query, then reads console input until the reply's `ESC \` terminator
/// (or 4 s), and reports `MS=<elapsed> GOT=[<reply with ESC shown as <ESC>>]`.
const CHILD: &str = "$e=[char]27; [Console]::Out.Write($e+']11;?'+$e+'\\'); \
    $sw=[Diagnostics.Stopwatch]::StartNew(); $b=''; \
    while($sw.ElapsedMilliseconds -lt 4000 -and -not $b.EndsWith('\\')){ \
      if([Console]::KeyAvailable){$b+=[Console]::ReadKey($true).KeyChar}else{Start-Sleep -Milliseconds 5} }; \
    $ms=$sw.ElapsedMilliseconds; \
    Start-Sleep -Milliseconds 100; \
    Write-Output ('MS='+$ms+' GOT=['+$b.Replace([string]$e,'<ESC>')+']')";

/// Run the child under a fresh pseudoconsole, answering its bg query with `reply`.
/// Returns (child's full output, whether the query reached us).
fn probe(reply_rgb: &str) -> (String, bool) {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");
    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", CHILD]);
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("reader");
    let mut writer = pair.master.take_writer().expect("writer");
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(15);
    let (mut out, mut answered) = (Vec::<u8>::new(), false);
    while Instant::now() < deadline {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(50)) {
            out.extend_from_slice(&chunk);
            let text = String::from_utf8_lossy(&out);
            if !answered && text.contains("\x1b]11;?") {
                writer.write_all(format!("\x1b]11;rgb:{reply_rgb}\x1b\\").as_bytes()).unwrap();
                writer.flush().unwrap();
                answered = true;
            }
            // The report is one complete line: wait for its newline.
            if text.rfind("GOT=[").is_some_and(|i| text[i..].contains('\n')) {
                break;
            }
        }
        if child.try_wait().ok().flatten().is_some() && rx.try_recv().is_err() {
            break;
        }
    }
    let _ = child.kill();
    (String::from_utf8_lossy(&out).into_owned(), answered)
}

#[test]
fn child_receives_the_frontend_background_colour() {
    let _ = termflow_pty_protocol::conpty::init_for_current_exe();
    let bundled = !termflow_pty_protocol::conpty::disabled();

    // Two distinct "themes" (dark / light), same process, same ConPTY.
    for rgb in ["1e1e/1e1e/1e1e", "fafa/fafa/fafa"] {
        let (out, forwarded) = probe(rgb);
        // The child's own report line: what it read back, and how long it took.
        let line = out
            .lines()
            .find(|l| l.contains("GOT=["))
            .unwrap_or_else(|| panic!("child never reported (did it start?).\n{out}"));
        if bundled {
            assert!(forwarded, "modern ConPTY must forward OSC 11;? to the frontend.\n{out}");
            // ONE assertion ties the colour to the child's completed response
            // (ESC ] 11 ; rgb:<theme> ESC \), so a stray echo elsewhere cannot satisfy it.
            let want = format!("GOT=[<ESC>]11;rgb:{rgb}<ESC>\\]");
            assert!(line.contains(&want), "child must read back exactly {want:?}.\n{out}");
            let ms: u64 = line
                .split("MS=")
                .nth(1)
                .and_then(|r| r.split_whitespace().next())
                .and_then(|n| n.parse().ok())
                .expect("child reports MS=");
            // Codex gives up after 250 ms; the harness answers instantly, so the
            // ConPTY round trip itself must fit well inside that.
            assert!(ms < 250, "query->reply took {ms} ms.\n{out}");
            eprintln!("theme {rgb}: child saw the reply in {ms} ms");
        } else {
            assert!(!forwarded, "inbox ConPTY is expected to drop the query.\n{out}");
            // Positive evidence the child ran, asked, and timed out empty-handed.
            assert!(line.contains("GOT=[]"), "child must time out with nothing.\n{out}");
        }
    }
}
