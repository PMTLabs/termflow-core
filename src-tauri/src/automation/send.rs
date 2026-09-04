//! Delivering an automation's message into a terminal.
//!
//! Two things live here, and they are separated for one reason: **the engine must be unit-testable
//! without a Tauri `AppHandle`** (plan §7.10).
//!
//! - **`TerminalWriter`** — the port. `fn write(&self, pc: &str, bytes: &[u8]) -> Result<()>`. Its
//!   `AppState` implementation encapsulates the "local writer or `host_write`" choice, which appeared
//!   four separate times inside `send_prompt_to_terminal` before this module existed. Tests use a
//!   recording fake, which §10.17 already assumed existed when it asserted "the fake terminal's write
//!   log is empty".
//! - **`deliver(writer, pc, cli_type, pattern, message, submit)`** — the sequence: bracketed paste,
//!   the load-bearing 500 ms gap, focus-in, then the submit pattern.
//!
//! **`deliver` is lifted OUT of `api_server::send_prompt_to_terminal`, which now calls it** — one
//! implementation, two callers. Neither re-implementing the sequence in the engine nor calling
//! `send_prompt_to_terminal` from it was acceptable: the first is `two-implementations-one-fix` on a
//! sequence whose 500 ms gap carries a verified comment about Codex absorbing a CR that arrives in the
//! same read chunk, and the second takes `&AppState<R>` and would drag the whole send path behind an
//! `AppHandle`.
//!
//! `submit` is `false` for the mockup's *Answer a confirmation* template, which types `1` and must NOT
//! press Enter. A send path that always submits breaks that one template while every other passes.
//! The HTTP handler's probe modes use the same `false` to get the paste/gap/focus-in prefix and then
//! supply their own candidate submit sequences.
//!
//! The send checks the engine's `stopping` flag **before its first write, never between the paste and
//! the submit**, so a quit either leaves the send unstarted or lets it finish. Plan §2.1, §2.5.
//!
//! **M0.4 landed the extraction and the port; M3 lands the engine's caller.**

use std::time::Duration;

/// How long the paste is given to land before the submit sequence follows it.
///
/// **Load-bearing, not cosmetic.** TUIs that implement paste-burst handling (Codex, verified against
/// codex-cli 0.146.0) absorb a CR that arrives in the SAME read chunk as the bracketed-paste
/// terminator, leaving the text sitting unsubmitted in the composer. A busy CLI that has stopped
/// draining its input pipe can still coalesce the two reads despite this delay — which is why an empty
/// `message` (a bare submit) exists as the recovery path.
pub const PASTE_SUBMIT_GAP_MS: u64 = 500;

/// One terminal-bound write, addressed by **`pc-` process id**.
///
/// Plan §7.4: the engine holds the durable `tm-` leaf, and every `AppState` map behind this port is
/// keyed by the per-run `pc-` id. The join happens **before** this port is reached, never inside it —
/// a port that resolved its own argument could not be handed a `pc-` by a test.
pub trait TerminalWriter: Send + Sync {
    /// Write raw bytes to `pc`'s PTY. `Err` carries a human-readable reason for the log; every caller
    /// treats all reasons alike (§10.8: a closed terminal and a failed write produce the same one log
    /// entry and the same arm-state rollback), so the error deliberately has no variants to match on.
    fn write(&self, pc: &str, bytes: &[u8]) -> Result<(), String>;
}

/// The two strings that submit a prompt: an optional `separator` written first, then the
/// `end_indicator` that actually presses Enter.
///
/// Resolved by the caller, not here — the HTTP handler has three sources for it (an explicit
/// `submission_signal`, a caller-supplied `custom_pattern`, or `get_cli_pattern`) and two of them
/// produce a 400 rather than a pattern, which is an HTTP concern.
#[derive(Debug, Clone, Copy)]
pub struct SubmitPattern<'a> {
    pub separator: &'a str,
    pub end_indicator: &'a str,
}

/// Type `message` into `pc` and, if `submit`, press its CLI's Enter.
///
/// The sequence, in order:
/// 1. **bracketed paste** (`CSI 200~ … CSI 201~`) of `message`, with every newline normalised to `\r`,
///    so an embedded newline is inserted as literal multi-line input rather than submitting each line
///    as its own command. Skipped entirely when `message` is empty — that is the deliberate "bare
///    submit" that presses Enter on a composer which already holds text.
/// 2. the **[`PASTE_SUBMIT_GAP_MS`] gap**.
/// 3. **focus-in** (`CSI I`), in case the CLI implements focus tracking (`CSI ?1004h`) and is ignoring
///    input because it believes it is blurred. Best-effort: its failure is not the send's failure,
///    which is what `send_prompt_to_terminal` did before the extraction.
/// 4. the **submit**, when `submit` is true.
/// The form an echo needle is recorded in (plan §2.6).
///
/// Runs of ASCII whitespace collapse to one space and the ends are trimmed. A terminal re-wraps and
/// re-indents what it echoes, so comparing the raw message against the raw window would miss on any
/// message long enough to wrap — which is most of them, the canonical one being a sentence.
pub fn normalise(message: &str) -> String {
    message.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub async fn deliver(
    writer: &dyn TerminalWriter,
    pc: &str,
    cli_type: &str,
    pattern: SubmitPattern<'_>,
    message: &str,
    submit: bool,
) -> Result<(), String> {
    if !message.is_empty() {
        let inner = message.replace("\r\n", "\r").replace('\n', "\r");
        writer.write(pc, format!("\x1b[200~{}\x1b[201~", inner).as_bytes())?;
        tokio::time::sleep(Duration::from_millis(PASTE_SUBMIT_GAP_MS)).await;
    }

    let _ = writer.write(pc, b"\x1b[I");

    if !submit {
        return Ok(());
    }

    // These three write the end indicator with NO separator, while every other CLI writes both.
    //
    // With today's `get_cli_pattern` the branch is a no-op: claude, gemini and copilot all carry an
    // empty separator, and the only two other pattern sources — an explicit `submission_signal`, and
    // `custom_pattern`, which requires `cli_type == "custom"` — cannot pair a non-empty separator with
    // one of these three names. It is kept because that is a coincidence between two functions, not an
    // invariant: give claude a separator in `get_cli_pattern` and the asymmetry becomes live again.
    // The difference between an agent submitting and an agent receiving a stray keystroke is one
    // `separator`, so it is pinned by a test rather than left to a reader to re-derive.
    if cli_type == "gemini" || cli_type == "claude" || cli_type == "copilot" {
        writer.write(pc, pattern.end_indicator.as_bytes())?;
        return Ok(());
    }

    if !pattern.separator.is_empty() {
        let _ = writer.write(pc, pattern.separator.as_bytes());
    }
    writer.write(pc, pattern.end_indicator.as_bytes())?;
    Ok(())
}

/// The one production implementation of the port.
///
/// Resolves the writer **per call** rather than once per send. That is not an oversight: the port's
/// own signature takes `pc` per write, because the engine holds one writer and sends to many
/// terminals over the life of the app. It is also the safer shape — the DashMap shard guard is
/// acquired and dropped inside a synchronous method and so can never be held across `deliver`'s
/// `.await`, which is the stall this send path was fixed for once already (a held shard guard blocked
/// create/close of every terminal hashing to the same shard for the full sleep).
///
/// Two failures that `send_prompt_to_terminal` used to swallow are now returned:
/// a terminal that disappears mid-send, and `host_write` refusing because the sidecar is
/// disconnected. Both used to report `{"success": true}` for input that went nowhere — the exact
/// outcome `AppState::host_write`'s own doc comment says its `bool` exists to prevent. The engine
/// cannot log `failed` and roll an arm state back on a send it was told succeeded.
impl<R: tauri::Runtime> TerminalWriter for crate::state::AppState<R> {
    fn write(&self, pc: &str, bytes: &[u8]) -> Result<(), String> {
        use std::io::Write as _;
        // Local writer first, matching the order `send_prompt_to_terminal` used. Clone the Arc out so
        // the shard guard is released before the inner Mutex is locked.
        let local = self.shell_writer_channels.get(pc).map(|r| r.clone());
        if let Some(wm) = local {
            let mut writer = wm
                .lock()
                .map_err(|_| "terminal writer mutex poisoned".to_string())?;
            writer.write_all(bytes).map_err(|e| e.to_string())?;
            let _ = writer.flush();
            return Ok(());
        }
        if self.host_write(pc, bytes) {
            return Ok(());
        }
        Err(format!("terminal {} has no writer", pc))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records every write with the **virtual** instant it happened at, so a test can assert the
    /// 500 ms gap actually elapsed. Under `#[tokio::test(start_paused = true)]` the runtime
    /// auto-advances its clock to the next timer, so this costs no wall-clock time.
    struct RecordingWriter {
        writes: Mutex<Vec<(String, Vec<u8>, tokio::time::Instant)>>,
        /// Write number (1-based) that returns `Err`; every other write succeeds.
        fail_on: Option<usize>,
    }

    impl RecordingWriter {
        fn new() -> Self {
            Self { writes: Mutex::new(Vec::new()), fail_on: None }
        }
        fn failing_on(nth: usize) -> Self {
            Self { writes: Mutex::new(Vec::new()), fail_on: Some(nth) }
        }
        /// Every write's bytes, in order, as lossy UTF-8.
        fn log(&self) -> Vec<String> {
            self.writes
                .lock()
                .unwrap()
                .iter()
                .map(|(_, b, _)| String::from_utf8_lossy(b).into_owned())
                .collect()
        }
        fn targets(&self) -> Vec<String> {
            self.writes.lock().unwrap().iter().map(|(pc, _, _)| pc.clone()).collect()
        }
        fn instants(&self) -> Vec<tokio::time::Instant> {
            self.writes.lock().unwrap().iter().map(|(_, _, at)| *at).collect()
        }
    }

    impl TerminalWriter for RecordingWriter {
        fn write(&self, pc: &str, bytes: &[u8]) -> Result<(), String> {
            let mut writes = self.writes.lock().unwrap();
            let nth = writes.len() + 1;
            // Recorded even when it fails: a test asserting "the submit was never written" must be
            // able to tell a refused write from an absent one.
            writes.push((pc.to_string(), bytes.to_vec(), tokio::time::Instant::now()));
            if self.fail_on == Some(nth) {
                return Err(format!("write {} refused", nth));
            }
            Ok(())
        }
    }

    const DEFAULT: SubmitPattern<'static> = SubmitPattern { separator: "", end_indicator: "\r" };

    /// The whole sequence for the ordinary case, asserted as an exact list rather than a spot check:
    /// paste, focus-in, submit — nothing else, in that order, all to the same `pc-`.
    #[tokio::test(start_paused = true)]
    async fn delivers_paste_then_focus_then_submit() {
        let w = RecordingWriter::new();
        deliver(&w, "pc-1", "default", DEFAULT, "hello", true).await.unwrap();

        assert_eq!(w.log(), vec!["\x1b[200~hello\x1b[201~", "\x1b[I", "\r"]);
        assert_eq!(w.targets(), vec!["pc-1", "pc-1", "pc-1"]);
    }

    /// The gap is the one part of this sequence whose removal is silent — the text simply sits
    /// unsubmitted in a Codex composer. Assert it in virtual time so a mutant that drops the sleep
    /// fails here rather than in a live terminal.
    #[tokio::test(start_paused = true)]
    async fn waits_the_full_gap_between_paste_and_submit() {
        let w = RecordingWriter::new();
        deliver(&w, "pc-1", "default", DEFAULT, "hello", true).await.unwrap();

        assert_eq!(w.log(), vec!["\x1b[200~hello\x1b[201~", "\x1b[I", "\r"]);
        let at = w.instants();
        assert!(
            at[1].duration_since(at[0]) >= Duration::from_millis(PASTE_SUBMIT_GAP_MS),
            "focus-in landed {:?} after the paste, less than the {} ms gap",
            at[1].duration_since(at[0]),
            PASTE_SUBMIT_GAP_MS
        );
    }

    /// Newlines inside the message are literal input, never Enter — that is what the bracketed paste
    /// is for. Both spellings collapse to `\r`, and the single submit is the one written after.
    #[tokio::test(start_paused = true)]
    async fn normalises_newlines_inside_the_paste() {
        let w = RecordingWriter::new();
        deliver(&w, "pc-1", "default", DEFAULT, "a\r\nb\nc", true).await.unwrap();

        assert_eq!(w.log()[0], "\x1b[200~a\rb\rc\x1b[201~");
    }

    /// `submit: false` — the *Answer a confirmation* template types `1` and must not press Enter, and
    /// the HTTP probe modes need the same prefix before supplying their own candidates.
    #[tokio::test(start_paused = true)]
    async fn submit_false_types_without_pressing_enter() {
        let w = RecordingWriter::new();
        deliver(&w, "pc-1", "default", DEFAULT, "1", false).await.unwrap();

        assert_eq!(w.log(), vec!["\x1b[200~1\x1b[201~", "\x1b[I"]);
    }

    /// An empty message is a deliberate bare submit — the recovery when a TUI swallowed the first
    /// Enter. No paste, and therefore no gap, but the submit still lands.
    #[tokio::test(start_paused = true)]
    async fn empty_message_is_a_bare_submit() {
        let w = RecordingWriter::new();
        deliver(&w, "pc-1", "default", DEFAULT, "", true).await.unwrap();

        assert_eq!(w.log(), vec!["\x1b[I", "\r"]);
    }

    /// The `gemini | claude | copilot` asymmetry, as a table over both sides of the branch. With
    /// today's `get_cli_pattern` no caller can reach a non-empty separator on those three names, so
    /// this test is the **only** thing that would notice if that changed — which is exactly why the
    /// branch is not deleted as dead.
    #[tokio::test(start_paused = true)]
    async fn separator_is_suppressed_for_the_three_agent_clis() {
        let pattern = SubmitPattern { separator: "\x1b", end_indicator: "\r" };
        for cli in ["gemini", "claude", "copilot"] {
            let w = RecordingWriter::new();
            deliver(&w, "pc-1", cli, pattern, "hi", true).await.unwrap();
            assert_eq!(
                w.log(),
                vec!["\x1b[200~hi\x1b[201~", "\x1b[I", "\r"],
                "{} must submit with the end indicator alone",
                cli
            );
        }
        for cli in ["default", "shell", "codex", "opencode", "custom"] {
            let w = RecordingWriter::new();
            deliver(&w, "pc-1", cli, pattern, "hi", true).await.unwrap();
            assert_eq!(
                w.log(),
                vec!["\x1b[200~hi\x1b[201~", "\x1b[I", "\x1b", "\r"],
                "{} must write the separator before the end indicator",
                cli
            );
        }
    }

    /// A refused paste aborts the send. Without the `?` a failed paste still submits, which presses
    /// Enter on whatever the composer happened to be holding.
    #[tokio::test(start_paused = true)]
    async fn a_refused_paste_never_reaches_the_submit() {
        let w = RecordingWriter::failing_on(1);
        let err = deliver(&w, "pc-1", "default", DEFAULT, "hello", true).await.unwrap_err();

        assert_eq!(err, "write 1 refused");
        assert_eq!(w.log(), vec!["\x1b[200~hello\x1b[201~"]);
    }

    /// A refused submit is the send's failure — the engine logs `failed` and rolls the arm state back
    /// on this, so it must not be swallowed the way focus-in is.
    #[tokio::test(start_paused = true)]
    async fn a_refused_submit_fails_the_send() {
        let w = RecordingWriter::failing_on(3);
        let err = deliver(&w, "pc-1", "default", DEFAULT, "hello", true).await.unwrap_err();

        assert_eq!(err, "write 3 refused");
        // The log assertion is what makes "write 3" mean the SUBMIT. Without it the oracle names its
        // subject by position alone, and an implementation with a spurious extra write before the
        // submit — failing there, then swallowing the real submit's error — passes.
        assert_eq!(w.log(), vec!["\x1b[200~hello\x1b[201~", "\x1b[I", "\r"]);
    }

    /// Focus-in is best-effort, and stays best-effort: `send_prompt_to_terminal` ignored its result
    /// before the extraction, and a CLI that does not implement focus tracking is not a failed send.
    #[tokio::test(start_paused = true)]
    async fn a_refused_focus_in_does_not_fail_the_send() {
        let w = RecordingWriter::failing_on(2);
        deliver(&w, "pc-1", "default", DEFAULT, "hello", true).await.unwrap();

        assert_eq!(w.log(), vec!["\x1b[200~hello\x1b[201~", "\x1b[I", "\r"]);
    }
}
