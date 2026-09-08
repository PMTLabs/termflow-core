use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::json;
use crate::state::AppState;
use super::terminals::{emit_external_activity, write_data_to_terminal};

// CLI prompt patterns for AI integration
pub(crate) fn get_cli_pattern(cli_type: &str) -> Option<(&'static str, &'static str)> {
    // OS-aware line endings for raw PTY input
    let shell_enter = if cfg!(target_os = "windows") { "\r\n" } else { "\r" };
    
    match cli_type {
        "claude" => Some(("", "\x1b\r\r")), // Escape + two carriage returns (universal for Claude CLI)
        "gemini" | "gemini-probe" => Some(("", "\r")), // Temporary override per user
        // Codex and opencode TUIs submit on a plain CR. Deliberately NOT the copilot
        // pattern: Down-Arrow navigates composer/message history in both, so
        // `\x1b[B\r` risks submitting the wrong buffer. Verified live against
        // codex-cli 0.146.0 and opencode 1.18.9. See the paste/submit race note in
        // `send_prompt_to_terminal` — codex swallows a same-read-chunk CR, opencode
        // does not.
        "codex" | "codex-probe" => Some(("", "\r")),
        "opencode" | "opencode-probe" => Some(("", "\r")),
        "chatgpt" => Some(("", shell_enter)),
        "copilot" | "copilot-probe" => Some(("", "\x1b[B\r")), // Down Arrow + Enter for interactive menu bypass
        "default" | "shell" => {
            if cfg!(target_os = "macos") {
                Some(("", "\r\x0c"))
            } else {
                Some(("", shell_enter))
            }
        },
        _ => {
            if cli_type.ends_with("-probe") {
                Some(("", "\r"))
            } else {
                None
            }
        },
    }
}

/// Which shell dialect a target terminal runs, for sentinel-command wrapping.
/// pwsh/powershell collapse to `PowerShell`; bash/zsh/sh/wsl/dash to `Posix`;
/// cmd.exe to `Cmd` (frozen SENTINEL contract).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellKind {
    PowerShell,
    Posix,
    Cmd,
}

/// Classify a shell from its profile path + name. Unknown shells fall back to
/// the platform default (cmd on Windows, posix elsewhere) — matching
/// `spawn_terminal`'s own last-resort fallback.
pub fn classify_shell_kind(path: &str, name: &str) -> ShellKind {
    let hay = format!("{} {}", path.to_ascii_lowercase(), name.to_ascii_lowercase());
    if hay.contains("powershell") || hay.contains("pwsh") {
        ShellKind::PowerShell
    } else if hay.contains("cmd") {
        ShellKind::Cmd
    } else if hay.contains("bash")
        || hay.contains("zsh")
        || hay.contains("wsl")
        || hay.contains("dash")
        || hay.contains("sh")
    {
        ShellKind::Posix
    } else if cfg!(target_os = "windows") {
        ShellKind::Cmd
    } else {
        ShellKind::Posix
    }
}

/// Wrap `command` so the shell prints a unique done-marker carrying the process
/// exit code on its own output line. The marker text is `@@TFDONE:NONCE:CODE@@`.
/// The variable is left UNEXPANDED in the command text so the terminal's echo of
/// the pasted command (which still shows `$LASTEXITCODE` / `%ERRORLEVEL%` / `$?`,
/// no digits) never matches `sentinel_exit_code`; only the executed output does.
pub fn build_sentinel_command(kind: ShellKind, command: &str, nonce: &str) -> String {
    match kind {
        ShellKind::PowerShell => {
            // $LASTEXITCODE is $null in a fresh session and after any cmdlet (it only tracks
            // EXTERNAL programs; cmdlets set $?). Guard so a NUMERIC code is ALWAYS emitted —
            // otherwise the marker reads "@@TFDONE:N:@@" (empty between the colons),
            // sentinel_exit_code never matches, and the run false-times-out.
            format!(
                "{} ; $c = if ($LASTEXITCODE -ne $null) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }} ; Write-Output \"@@TFDONE:{}:$c@@\"",
                command, nonce
            )
        }
        ShellKind::Posix => {
            format!("{} ; printf \"@@TFDONE:{}:%s@@\\n\" \"$?\"", command, nonce)
        }
        ShellKind::Cmd => {
            // `%ERRORLEVEL%` percent-expands at PARSE time (the stale, pre-command value), so
            // an `&`-chained echo would report the WRONG exit code. Run the marker in a child
            // `cmd /v:on /c` so delayed-expansion `!ERRORLEVEL!` reads the INHERITED
            // post-command exit code. `!...!` is not expanded by the outer shell, so it passes
            // literally to the child (which has delayed expansion enabled).
            format!("{} & cmd /v:on /c \"echo @@TFDONE:{}:!ERRORLEVEL!@@\"", command, nonce)
        }
    }
}

/// Scan decoded terminal output for THIS run's done-marker and return the exit
/// code. Equivalent to the regex `@@TFDONE:NONCE:(-?\d+)@@` but dependency-free:
/// finds `@@TFDONE:NONCE:`, then parses the signed integer up to the closing
/// `@@`. A non-numeric token (the command echo's literal variable) fails the
/// parse and the scan continues, so only the executed output line matches.
pub fn sentinel_exit_code(haystack: &str, nonce: &str) -> Option<i32> {
    let needle = format!("@@TFDONE:{}:", nonce);
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(&needle) {
        let start = from + rel + needle.len();
        let rest = &haystack[start..];
        if let Some(end) = rest.find("@@") {
            if let Ok(code) = rest[..end].parse::<i32>() {
                return Some(code);
            }
        }
        from = start;
    }
    None
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutePromptReq {
    pub(crate) prompt: String,
    #[serde(default = "default_cli_type")]
    pub(crate) cli_type: String,
    pub(crate) submission_signal: Option<String>,
    pub(crate) custom_pattern: Option<CustomPattern>,
}

#[derive(serde::Deserialize, Clone)]
pub(crate) struct CustomPattern {
    separator: Option<String>,
    end_indicator: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchExecuteReq {
    terminal_ids: Vec<String>,
    prompt: String,
    #[serde(default = "default_cli_type")]
    cli_type: String,
    submission_signal: Option<String>,
    custom_pattern: Option<CustomPattern>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchInputReq {
    terminal_ids: Vec<String>,
    data: String,
}

pub(crate) fn default_cli_type() -> String {
    "copilot".to_string()
}

/// Dedup terminal ids preserving first-seen order, so a fan-out never writes
/// the same content to one terminal twice.
pub(crate) fn dedup_preserve_order(ids: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    ids.iter().filter(|id| seen.insert((*id).clone())).cloned().collect()
}

/// Send a prompt (with its CLI-specific submit sequence) to a single terminal.
/// Shared by the single-id `/execute` handler and the batch `/batch/execute`
/// handler. On success returns the JSON body the single-id handler returns;
/// on failure returns `(status, message)`.
pub(crate) async fn send_prompt_to_terminal<R: tauri::Runtime>(
    state: &AppState<R>,
    id: &str,
    payload: &ExecutePromptReq,
) -> Result<serde_json::Value, (StatusCode, String)> {
    use crate::automation::send::{deliver, SubmitPattern, TerminalWriter};

    // Does this id name a terminal at all? Host-owned terminals have no local writer and route their
    // writes to the sidecar instead. Asked with `contains_key` rather than `get`, because a `get`
    // guard used in an `if` condition lives to the end of the whole `if`/`else` — i.e. across the
    // `.await`s below. Holding a DashMap shard guard across those blocked a concurrent create/close
    // of every terminal hashing to the same shard for the full sleep duration (up to ~48 s in probe
    // mode), which is a stall this function was fixed for once already. Each individual write now
    // takes and releases the guard synchronously inside the `TerminalWriter` impl.
    if !state.shell_writer_channels.contains_key(id) && !state.is_host_owned(id) {
        return Err((StatusCode::NOT_FOUND, "Terminal not found".to_string()));
    }
    {
        // Determine pattern
        let (separator, end_indicator) = if let Some(signal) = &payload.submission_signal {
            ("", signal.as_str())
        } else if payload.cli_type == "custom" {
            if let Some(custom) = &payload.custom_pattern {
                (
                    custom.separator.as_deref().unwrap_or(""),
                    custom.end_indicator.as_str(),
                )
            } else {
                return Err((StatusCode::BAD_REQUEST, "Custom pattern requires end_indicator".to_string()));
            }
        } else if let Some((sep, end)) = get_cli_pattern(&payload.cli_type) {
            (sep, end)
        } else {
            return Err((StatusCode::BAD_REQUEST, format!("Unknown CLI type: {}", payload.cli_type)));
        };

        // The request is well-formed and will be dispatched to a valid terminal —
        // flash its tab. Placed after the validation above so a rejected (400)
        // request does not flash (see design spec 029 §5).
        emit_external_activity(state, id);

        // The paste / 500 ms gap / focus-in / submit core lives in `automation::send::deliver`, so the
        // Automations engine and this handler share ONE implementation of it (plan §7.10). What stays
        // here is what is HTTP-specific: the 404 above, the pattern sources and their 400s, the tab
        // flash, the probe modes, and the response bodies.
        //
        // A probe asks `deliver` NOT to submit: that yields exactly the prefix the probe wants —
        // paste, the gap, focus-in — and the loop below then supplies each candidate submit sequence
        // itself. It is the same `submit: false` the Automations "answer a confirmation" rule uses to
        // type a `1` without pressing Enter.
        let writer: &dyn TerminalWriter = state;
        let is_probe = payload.cli_type.ends_with("-probe");
        deliver(
            writer,
            id,
            &payload.cli_type,
            SubmitPattern { separator, end_indicator },
            &payload.prompt,
            !is_probe,
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

        // Handle Probing if requested (any cli_type ending in -probe)
        if is_probe {
            log::debug!("Starting submission probe for CLI type: {} on terminal {}", payload.cli_type, id);
            let sequences = [
                ("\x1b[I\r", "Focus In + CR (\\x1b[I\\r)"),
                ("\x1b[B\r", "Down Arrow + CR"),
                ("\u{001b}[13;5u", "Ctrl + Enter (\\u001b[13;5u)"),
                ("\x1bOM", "Keypad Enter (\\x1bOM)"),
                ("\r", "Single CR (\\r)"),
                ("\n", "Single LF (\\n)"),
                ("\r\n", "CRLF (\\r\\n)"),
                ("\x04", "Ctrl + D (EOF)"),
                ("\x1b[A\r", "Up Arrow + CR"),
                ("\x1b[24;1R", "Simulated Cursor Position (\\x1b[24;1R)"),
                ("\x1b[?1;2c", "Simulated Device Attributes (\\x1b[?1;2c)"),
                ("\x1b[0n", "Simulated Status OK (\\x1b[0n)"),
                ("\x1b[24;1R\r", "Cursor Pos + Enter"),
                ("\x1b[201~\r", "End Paste + CR (\\x1b[201~\\r)"),
                ("\r\r", "Double CR (\\r\\r)"),
                ("\n\n", "Double LF (\\n\\n)"),
            ];

            for (seq, desc) in sequences {
                log::debug!("  Attempting submission: {} (bytes: {:?})", desc, seq.as_bytes());
                if let Err(e) = writer.write(id, seq.as_bytes()) {
                    log::warn!("    Failed to write sequence: {}", e);
                    break;
                }
                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
            }

            return Ok(json!({
                "success": true,
                "status": "Probe completed",
                "terminalId": id,
                "cliType": payload.cli_type
            }));
        }

        Ok(json!({
            "success": true,
            "prompt": payload.prompt,
            "cliType": payload.cli_type
        }))
    }
}

pub(crate) async fn execute_prompt(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<ExecutePromptReq>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    match send_prompt_to_terminal(&state, &id, &payload).await {
        Ok(body) => (StatusCode::OK, Json(body)),
        Err((code, msg)) => (code, Json(json!({ "error": msg }))),
    }
}


/// Fan out one prompt to several terminals. Always returns HTTP 200 with a
/// per-terminal `results` array; a single bad id never blocks the others.
pub(crate) async fn batch_execute_prompt(
    State(state): State<AppState>,
    Json(body): Json<BatchExecuteReq>,
) -> impl IntoResponse {
    if body.terminal_ids.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "terminalIds must be a non-empty array" })));
    }
    // An empty prompt is a valid "bare submit" fan-out (press Enter on every
    // target's composer), matching single-id execute_prompt's semantics.
    // Validate the request-global submit pattern ONCE, before fanning out. An
    // unknown cliType or a missing custom pattern is a malformed request (the
    // pattern is identical for every id), not a per-terminal failure — so return
    // 400 for the whole batch, matching single-id execute_prompt's semantics.
    if body.submission_signal.is_none() {
        if body.cli_type == "custom" {
            if body.custom_pattern.is_none() {
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Custom pattern requires end_indicator" })));
            }
        } else if get_cli_pattern(&body.cli_type).is_none() {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": format!("Unknown CLI type: {}", body.cli_type) })));
        }
    }

    // Pairs of (id the caller sent, id our maps use). The RESPONSE must echo the
    // caller's id: a client that sent tm- and got pc- back cannot correlate the
    // result with its request, and the pc- is meaningless to it after a restart.
    let ids: Vec<(String, String)> = dedup_preserve_order(&body.terminal_ids)
        .iter().map(|i| (i.clone(), state.resolve_ref(i))).collect();
    let req = ExecutePromptReq {
        prompt: body.prompt.clone(),
        cli_type: body.cli_type.clone(),
        submission_signal: body.submission_signal.clone(),
        custom_pattern: body.custom_pattern.clone(),
    };

    let mut results = Vec::with_capacity(ids.len());
    let mut succeeded = 0usize;
    for (requested, resolved) in &ids {
        match send_prompt_to_terminal(&state, resolved, &req).await {
            Ok(_) => {
                succeeded += 1;
                results.push(json!({ "terminalId": requested, "success": true }));
            }
            Err((_, msg)) => {
                results.push(json!({ "terminalId": requested, "success": false, "error": msg }));
            }
        }
    }

    let total = ids.len();
    (StatusCode::OK, Json(json!({
        "results": results,
        "summary": { "total": total, "succeeded": succeeded, "failed": total - succeeded }
    })))
}

/// Fan out a raw write to several terminals. Always returns HTTP 200 with a
/// per-terminal `results` array.
pub(crate) async fn batch_write_terminal(
    State(state): State<AppState>,
    Json(body): Json<BatchInputReq>,
) -> impl IntoResponse {
    if body.terminal_ids.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "terminalIds must be a non-empty array" })));
    }

    // Same as batch execute: resolve for the lookup, echo what the caller sent.
    let ids: Vec<(String, String)> = dedup_preserve_order(&body.terminal_ids)
        .iter().map(|i| (i.clone(), state.resolve_ref(i))).collect();
    let mut results = Vec::with_capacity(ids.len());
    let mut succeeded = 0usize;
    for (requested, resolved) in &ids {
        match write_data_to_terminal(&state, resolved, &body.data) {
            Ok(()) => {
                succeeded += 1;
                results.push(json!({ "terminalId": requested, "success": true }));
            }
            Err((_, msg)) => {
                results.push(json!({ "terminalId": requested, "success": false, "error": msg }));
            }
        }
    }

    let total = ids.len();
    (StatusCode::OK, Json(json!({
        "results": results,
        "summary": { "total": total, "succeeded": succeeded, "failed": total - succeeded }
    })))
}



#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dedup_preserve_order_keeps_first_occurrence() {
        let input = vec![
            "a".to_string(), "b".to_string(), "a".to_string(),
            "c".to_string(), "b".to_string(),
        ];
        assert_eq!(dedup_preserve_order(&input), vec!["a", "b", "c"]);
    }

    #[test]
    fn test_dedup_preserve_order_empty() {
        let input: Vec<String> = vec![];
        assert!(dedup_preserve_order(&input).is_empty());
    }

    #[test]
    fn build_sentinel_command_per_shell() {
        assert_eq!(
            build_sentinel_command(ShellKind::PowerShell, "Get-Date", "N1"),
            "Get-Date ; $c = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 } ; Write-Output \"@@TFDONE:N1:$c@@\""
        );
        assert_eq!(
            build_sentinel_command(ShellKind::Posix, "ls -la", "N1"),
            "ls -la ; printf \"@@TFDONE:N1:%s@@\\n\" \"$?\""
        );
        assert_eq!(
            build_sentinel_command(ShellKind::Cmd, "dir", "N1"),
            "dir & cmd /v:on /c \"echo @@TFDONE:N1:!ERRORLEVEL!@@\""
        );
    }

    // NOTE for Task H2's integration test: exercise a REAL non-zero exit (e.g. a command
    // that exits 3) AND a PowerShell cmdlet (e.g. `Get-Date`) end-to-end, asserting the
    // captured exitCode is correct — the unit test above only checks the wrapper string,
    // which cannot catch cmd.exe parse-time expansion or PowerShell's $null $LASTEXITCODE.

    #[test]
    fn get_cli_pattern_submits_agent_tuis_with_a_plain_cr() {
        // Regression guard: codex/opencode must NOT inherit copilot's Down-Arrow
        // (`\x1b[B\r`), which navigates message history in both TUIs.
        assert_eq!(get_cli_pattern("codex"), Some(("", "\r")));
        assert_eq!(get_cli_pattern("opencode"), Some(("", "\r")));
        assert_eq!(get_cli_pattern("copilot"), Some(("", "\x1b[B\r")));
        // Unknown types still reject, so a typo'd cliType fails loudly (400)
        // rather than silently sending the wrong keystrokes.
        assert_eq!(get_cli_pattern("codexx"), None);
    }

    #[test]
    fn classify_shell_kind_maps_common_shells() {
        assert_eq!(
            classify_shell_kind(
                "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                "Windows PowerShell"
            ),
            ShellKind::PowerShell
        );
        assert_eq!(classify_shell_kind("/usr/bin/pwsh", "PowerShell"), ShellKind::PowerShell);
        assert_eq!(
            classify_shell_kind("C:\\Windows\\System32\\cmd.exe", "Command Prompt"),
            ShellKind::Cmd
        );
        assert_eq!(classify_shell_kind("/bin/bash", "bash"), ShellKind::Posix);
        assert_eq!(classify_shell_kind("/bin/zsh", "zsh"), ShellKind::Posix);
        assert_eq!(classify_shell_kind("/bin/sh", "sh"), ShellKind::Posix);
    }

    #[test]
    fn sentinel_ignores_command_echo_and_reads_output() {
        let nonce = "deadbeef";
        // The echoed pasted command still carries the LITERAL $LASTEXITCODE token
        // (no digits between the colons) so it must NOT match.
        let echo = "pwsh> Get-Item x ; Write-Output \"@@TFDONE:deadbeef:$LASTEXITCODE@@\"";
        assert_eq!(sentinel_exit_code(echo, nonce), None);
        // The real executed output line carries the substituted number.
        let out = format!("{}\r\n@@TFDONE:deadbeef:0@@\r\n", echo);
        assert_eq!(sentinel_exit_code(&out, nonce), Some(0));
    }

    #[test]
    fn sentinel_parses_negative_exit_code() {
        assert_eq!(sentinel_exit_code("x\n@@TFDONE:n9:-1@@\n", "n9"), Some(-1));
        assert_eq!(sentinel_exit_code("no marker here", "n9"), None);
    }


    // Regression guard for backlog 013: the writer value is `Arc<Mutex<..>>`, so a
    // send path clones the Arc and drops the DashMap shard guard before the long
    // inner-lock hold (the send/probe sleeps). This proves that once the Arc is
    // cloned out, a `remove` on the SAME shard proceeds even while the inner
    // writer lock is held — i.e. no shard guard is held across the hold. Under the
    // old bare-`Mutex` layout the caller kept the `Ref`, and this same-thread
    // `remove` on the same shard would deadlock instead of returning.
    #[test]
    fn test_writer_arc_lets_concurrent_remove_proceed_during_send() {
        use dashmap::DashMap;
        use std::io::Write;
        use std::sync::{Arc, Mutex};

        type Writer = Arc<Mutex<Box<dyn Write + Send>>>;
        let map: DashMap<String, Writer> = DashMap::new();
        let sink: Box<dyn Write + Send> = Box::new(Vec::<u8>::new());
        map.insert("term-1".to_string(), Arc::new(Mutex::new(sink)));

        // Send path: clone the Arc, dropping the shard guard.
        let writer_arc = map.get("term-1").map(|r| r.clone()).expect("writer present");
        // Simulate the mid-send state: inner writer lock held.
        let mut writer = writer_arc.lock().expect("inner lock");
        writer.write_all(b"in-flight prompt").expect("write");

        // A concurrent close removes the entry from the SAME shard. With the shard
        // guard already dropped this returns immediately (no deadlock).
        let removed = map.remove("term-1");
        assert!(removed.is_some(), "remove should proceed while a send holds the writer");
        drop(removed); // the closed terminal's map entry (and its Arc) is gone

        // The cloned Arc outlives the removal — the in-flight send still owns a
        // valid writer, and the map is now empty for the next lookup.
        drop(writer);
        assert_eq!(Arc::strong_count(&writer_arc), 1, "map's Arc dropped by remove");
        assert!(map.get("term-1").is_none(), "next write surfaces as Terminal not found");
    }

    // Integration guard for backlog 013 that drives the REAL `send_prompt_to_terminal`
    // handler (not a local re-implementation). It builds an `AppState<MockRuntime>` via
    // `tauri::test::mock_app()`, starts an in-flight send (which sleeps ~500 ms mid-send),
    // then times a concurrent same-shard `remove`. With the fix the send holds no DashMap
    // shard guard across its `.await`, so the remove returns immediately; the pre-fix code
    // held the shard read-guard across the sleep and this remove would block for the
    // remaining send duration — which this test's timing assertion catches.
    //
    // Gated behind the `integration-tests` feature because it needs tauri's `test`
    // feature (mock_app). Enabling that feature breaks the Rust test *binary* at loader
    // time on Windows (STATUS_ENTRYPOINT_NOT_FOUND), so this runs on Linux/macOS only:
    //   cargo test --features integration-tests
    // See docs/guides for the CI pipeline that exercises it.
    #[cfg(feature = "integration-tests")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_send_prompt_does_not_block_concurrent_removal() {
        use std::io::Write;
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};
        use tokio::sync::oneshot;

        // A sink that fires a one-shot the first time the send writes to it. This is a
        // DETERMINISTIC sync point (no arbitrary sleep): the write only happens after
        // `send_prompt_to_terminal` has cloned the writer Arc and dropped the DashMap
        // Ref, so the test can start the concurrent remove exactly then. In the pre-fix
        // code the write fires while the Ref is still held, so the subsequent remove
        // blocks on the shard lock through the 500 ms sleep — still caught below.
        struct SignalOnWrite {
            started: Option<oneshot::Sender<()>>,
        }
        impl Write for SignalOnWrite {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                if let Some(tx) = self.started.take() {
                    let _ = tx.send(());
                }
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let app = tauri::test::mock_app();
        let (tx, _rx) = tokio::sync::broadcast::channel(16);
        let state = AppState::new(
            tx,
            app.handle().clone(),
            crate::app_config::NetworkConfig::defaults(),
        );

        let id = "term-block-test".to_string();
        let (started_tx, started_rx) = oneshot::channel();
        let sink: Box<dyn Write + Send> = Box::new(SignalOnWrite { started: Some(started_tx) });
        state
            .shell_writer_channels
            .insert(id.clone(), Arc::new(Mutex::new(sink)));

        // Task A: a real in-flight send. cli_type "copilot" writes the prompt (fires the
        // signal), then sleeps 500 ms (the focus-in delay) before the end indicator.
        let state_a = state.clone();
        let id_a = id.clone();
        let sender = tokio::spawn(async move {
            let payload = ExecutePromptReq {
                prompt: "hello".to_string(),
                cli_type: "copilot".to_string(),
                submission_signal: None,
                custom_pattern: None,
            };
            send_prompt_to_terminal(&state_a, &id_a, &payload).await
        });

        // Deterministic barrier: proceed only once the send's first write lands — i.e.
        // the Arc has been cloned, the shard Ref dropped, and the send is now in its
        // 500 ms sleep. Bounded so a hang fails loudly instead of blocking forever.
        tokio::time::timeout(Duration::from_secs(5), started_rx)
            .await
            .expect("send did not reach its first write within 5s")
            .expect("send task dropped the signal sender");

        // A concurrent close removes the same-shard entry. Timed on a blocking thread so
        // a regression shows up as real wall-clock block: the pre-fix code holds the
        // shard read-guard through the 500 ms sleep (remove blocks ~500 ms); the fixed
        // code returns in microseconds. The 250 ms threshold sits well between the two.
        let start = Instant::now();
        let removed = tokio::task::spawn_blocking({
            let state = state.clone();
            let id = id.clone();
            move || state.shell_writer_channels.remove(&id).is_some()
        })
        .await
        .unwrap();
        let elapsed = start.elapsed();

        assert!(removed, "entry should have been present to remove");
        assert!(
            elapsed < Duration::from_millis(250),
            "same-shard remove blocked for {:?} — a writer path is holding the DashMap \
             shard guard across an .await (backlog 013 regression)",
            elapsed
        );

        // **Changed deliberately by the §7.10 send extraction: a send whose terminal vanishes
        // mid-flight now REPORTS that, where it used to answer `{"success": true}`.**
        //
        // Before the extraction this handler cloned the writer `Arc` once, up front, so an in-flight
        // send went on writing into a terminal already removed from the map and still returned 200 —
        // telling an MCP agent its prompt had been submitted to a terminal that no longer exists.
        // `TerminalWriter` resolves per write instead (see that impl's own doc comment), which both
        // keeps the shard guard out of the `.await`s — the property this test is NAMED for, asserted
        // above and still true — and lets the submit refuse.
        //
        // The assertion here used to be `result.is_ok()`, justified by a comment about the MECHANISM
        // ("still owns its cloned Arc") rather than by any stated contract. It stayed green on every
        // local run because this test is `#[cfg(feature = "integration-tests")]` and only Linux CI
        // compiles that feature — so the behaviour change was invisible until CI said otherwise.
        let result = sender.await.unwrap();
        let (status, message) = result
            .expect_err("a send whose terminal was removed mid-flight must not report success");
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        // The SPECIFIC refusal, not merely "some error": without this the assertion would also pass
        // if the send had failed at its very first write — i.e. if the barrier above never worked and
        // nothing was ever delivered — which is the opposite of the scenario under test.
        assert!(
            message.contains("has no writer"),
            "expected the missing-writer refusal, got {:?}",
            message
        );
    }


}
