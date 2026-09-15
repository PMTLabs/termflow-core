//! Recovery from a dead WebView2 **browser** process (plan 044).
//!
//! This is not a renderer crash the DOM can recover from — the whole
//! `ICoreWebView2` host process is gone. Every window's webview goes hollow:
//! the DOM, the tab strip, the terminal canvas — all of it — disappears,
//! though the OS window frame itself lingers, and so does the tray icon (it
//! lives in the Rust process, not the webview). Tauri/wry never recreate a
//! dead `ICoreWebView2`; the only way back to a working UI is a whole new
//! process.
//!
//! That is survivable here specifically because the pty-host is a *separate*
//! process that keeps every shell alive independent of ours — the same
//! hot-swap hold `restart_for_update` and the tray's "Restart, keep
//! terminals" item use (plan 044 T1). A relaunch that adopts those sessions
//! looks, to the user, like the app blinked, not like they lost their work.
//!
//! `ProcessFailed` fires once PER WINDOW, but every window shares ONE browser
//! process — one death fires N handlers. `AppState::recovering` is what keeps
//! that from relaunching N times over.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::Manager;

use crate::commands::{self, FlushPolicy};
use crate::native_notify::show_info_toast;
use crate::state::AppState;

/// Below this uptime, a death is judged to be the SAME failure repeating (a
/// crash loop) rather than a new one-off death — see `decide`.
pub const LOOP_GUARD: Duration = Duration::from_secs(60);

pub const TOAST_TITLE: &str = "TermFlow";
pub const TOAST_RESTORING: &str = "TermFlow's display crashed. Restoring your terminals…";
pub const TOAST_CRASHED_AGAIN: &str =
    "TermFlow's display crashed again. When ready, right-click the tray icon → Restart, keep terminals.";
pub const TOAST_FAILED: &str =
    "TermFlow could not restore automatically. Your terminals are still running; check the log.";
pub const TOAST_RESTART_FAILED: &str =
    "TermFlow could not restart. Your terminals are still running; check the log.";

/// Report a FAILED `restart_keeping_terminals` to the user. Called only by
/// the caller that OWNED the run — the one that won `restart_in_flight`. The
/// tray item and the automatic path can both start the same restart for one
/// death; whichever loses gets `RESTART_IN_FLIGHT` and must stay silent, so
/// if the winner then fails, the winner is the only one left to say so. A
/// failure that only reached the log would leave "Restoring your terminals…"
/// as the user's last word from a process that is still hollow.
///
/// This does NOT re-open `AppState::recovering`. One browser death queues one
/// `ProcessFailed` callback per window; if the first one's restart fails
/// fast (no pty-host, preflight error), a sibling window's callback is still
/// on its way and would otherwise swap the cleared latch back to `true`,
/// classify the same death as new, and repeat the toast and the arm. The
/// latch is per death, not per attempt; the tray item never consults it, so
/// the user can still retry from there.
pub fn report_restart_failure(app: &tauri::AppHandle, body: &str, err: &str) {
    log::error!("[RECOVERY] restart keeping terminals failed: {err}");
    if let Err(e) = show_info_toast(app, TOAST_TITLE, body) {
        log::warn!("[RECOVERY] toast failed: {e}");
    }
}

/// What `on_browser_died` should do about one `BROWSER_PROCESS_EXITED` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryDecision {
    /// Another window's handler is already driving recovery for this death —
    /// every window shares one browser process, so N windows fire N handlers
    /// for the SAME death.
    Ignore,
    /// Too soon after this process started to try an automatic relaunch: a
    /// relaunch that itself dies within `LOOP_GUARD` would spin forever.
    /// Leave the (still tray-operable) process alone and hand off to the
    /// user via the tray's "Restart, keep terminals" item instead.
    NotifyOnly,
    /// Relaunch automatically.
    Relaunch,
}

/// Pure policy, kept separate from the COM/async plumbing so it is unit
/// testable without a live WebView2.
///
/// `already_recovering` wins over the uptime guard: a second window's handler
/// firing moments after the first must never be treated as a NEW death just
/// because uptime also happens to be low (e.g. right after boot, when both
/// conditions can hold at once).
pub fn decide(uptime: Duration, already_recovering: bool) -> RecoveryDecision {
    if already_recovering {
        return RecoveryDecision::Ignore;
    }
    if uptime < LOOP_GUARD {
        return RecoveryDecision::NotifyOnly;
    }
    RecoveryDecision::Relaunch
}

/// Install the `ProcessFailed` hook on a window's WebView2 instance. No-op on
/// non-Windows platforms — `ProcessFailed` is a WebView2-specific event.
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        ICoreWebView2ProcessFailedEventArgs,
    };
    use webview2_com::ProcessFailedEventHandler;

    let label = window.label().to_string();
    let outer_label = label.clone();
    let app = window.app_handle().clone();
    let result = window.with_webview(move |webview| unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[RECOVERY] CoreWebView2() unavailable for '{label}': {e}");
                return;
            }
        };

        let handler_label = label.clone();
        let handler_app = app.clone();
        let handler = ProcessFailedEventHandler::create(Box::new(move |wv, args: Option<ICoreWebView2ProcessFailedEventArgs>| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            args.ProcessFailedKind(&mut kind)?;

            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                log::error!(
                    "[RECOVERY] ProcessFailed kind=BROWSER_PROCESS_EXITED window={handler_label}"
                );
                tauri::async_runtime::spawn(on_browser_died(handler_app.clone()));
            } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                log::warn!(
                    "[RECOVERY] ProcessFailed kind=RENDER_PROCESS_EXITED window={handler_label} → Reload"
                );
                if let Some(wv) = wv {
                    if let Err(e) = wv.Reload() {
                        log::warn!("[RECOVERY] Reload failed for '{handler_label}': {e}");
                    }
                }
            } else {
                log::warn!(
                    "[RECOVERY] ProcessFailed kind={} ignored window={handler_label}",
                    kind.0
                );
            }
            Ok(())
        }));

        let mut token: i64 = 0;
        if let Err(e) = core.add_ProcessFailed(&handler, &mut token) {
            log::warn!("[RECOVERY] add_ProcessFailed failed for '{label}': {e}");
            return;
        }
        log::info!("[RECOVERY] hook installed for window {label}");
    });

    if let Err(e) = result {
        log::warn!("[RECOVERY] with_webview failed for '{outer_label}': {e}");
    }
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {}

/// Handle one `BROWSER_PROCESS_EXITED` event: decide what to do (via
/// `decide`) and either notify or relaunch. Spawned onto the async runtime
/// (`tauri::async_runtime::spawn`) so the COM callback that reported the
/// death — which runs on the UI thread and must never block — can return
/// immediately; see `install`.
pub async fn on_browser_died(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        log::error!("[RECOVERY] AppState not managed; cannot recover");
        return;
    };

    let already = state.recovering.swap(true, Ordering::SeqCst);
    let uptime = state.started_at.elapsed();
    match decide(uptime, already) {
        RecoveryDecision::Ignore => {
            log::info!("[RECOVERY] browser death already being handled");
        }
        RecoveryDecision::NotifyOnly => {
            log::warn!(
                "[RECOVERY] decision=NotifyOnly uptime={uptime:?} (< LOOP_GUARD) — leaving the process for the tray"
            );
            if let Err(e) = show_info_toast(&app, TOAST_TITLE, TOAST_CRASHED_AGAIN) {
                log::warn!("[RECOVERY] toast failed: {e}");
            }
            // The latch deliberately STAYS set — here and on every other arm.
            // Every window shares the one dead browser process, so a second
            // window's handler arrives right behind this one and must land on
            // `Ignore`, not on a second toast or a second arm. Nothing
            // legitimate re-enters afterwards: no webview is left to fail again,
            // and the tray restart never consults this flag.
        }
        RecoveryDecision::Relaunch => {
            log::error!("[RECOVERY] decision=Relaunch uptime={uptime:?}");
            if let Err(e) = show_info_toast(&app, TOAST_TITLE, TOAST_RESTORING) {
                log::warn!("[RECOVERY] toast failed: {e}");
            }
            match commands::restart_keeping_terminals(app.clone(), FlushPolicy::Skip).await {
                Ok(()) => {
                    // process is exiting
                }
                // Busy is not failure: the tray item beat us to the same restart
                // (the user clicked while this was arming). That run owns the
                // exit; a "could not restore" toast over it would be a lie.
                Err(e) if e == commands::RESTART_IN_FLIGHT => {
                    log::info!("[RECOVERY] {e}; leaving it to that run");
                }
                Err(e) => report_restart_failure(&app, TOAST_FAILED, &e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decide_notify_only_just_under_the_guard() {
        assert_eq!(
            decide(Duration::from_secs(59), false),
            RecoveryDecision::NotifyOnly
        );
    }

    #[test]
    fn decide_relaunches_at_exactly_the_guard() {
        // Boundary: exactly LOOP_GUARD relaunches, it does not NotifyOnly.
        assert_eq!(
            decide(Duration::from_secs(60), false),
            RecoveryDecision::Relaunch
        );
    }

    #[test]
    fn decide_relaunches_well_past_the_guard() {
        assert_eq!(
            decide(Duration::from_secs(600), false),
            RecoveryDecision::Relaunch
        );
    }

    #[test]
    fn decide_ignores_when_already_recovering_even_long_after_boot() {
        assert_eq!(
            decide(Duration::from_secs(600), true),
            RecoveryDecision::Ignore
        );
    }

    #[test]
    fn decide_already_recovering_wins_over_the_guard() {
        // already_recovering=true must win even when uptime alone would also
        // have said NotifyOnly — it is not "whichever condition is worse".
        assert_eq!(
            decide(Duration::from_secs(1), true),
            RecoveryDecision::Ignore
        );
    }

    /// `report_restart_failure` is the ONLY place a restart failure reaches the
    /// user, so it must log and toast the given body — and it must NOT touch
    /// the per-death latch: a sibling window's queued callback would re-run
    /// the whole recovery for the same death if it did. `source()` strips
    /// comments AND dead blocks, so a body that only says these things inside
    /// `if false { }` does not pass.
    #[test]
    fn report_restart_failure_toasts_the_given_body_and_leaves_the_latch_set() {
        let src = source("webview_recovery.rs");
        let at = src
            .find("pub fn report_restart_failure")
            .expect("report_restart_failure must exist");
        let body = block_at(&src, at);
        assert!(
            call_args(body, "show_info_toast(").contains("body"),
            "must toast the caller's body, not a fixed text. Body:\n{body}"
        );
        assert!(body.contains("log::error!"), "must log the error. Body:\n{body}");
        assert!(
            !body.contains("recovering") && !body.contains("store(false"),
            "must not re-open the per-death latch. Body:\n{body}"
        );
        // The whole module (production half — the tests below name the
        // pattern to forbid it): nothing anywhere clears the latch.
        let production = &src[..src.find("#[cfg(test)]").expect("test module marker")];
        assert!(
            !production.contains("recovering.store(false"),
            "no path in webview_recovery may clear `recovering`"
        );
    }

    /// Pins the exact wording so any future change is a deliberate edit here,
    /// not an incidental drift.
    #[test]
    fn toast_texts_are_the_agreed_ones() {
        assert_eq!(
            TOAST_RESTORING,
            "TermFlow's display crashed. Restoring your terminals…"
        );
        assert_eq!(
            TOAST_CRASHED_AGAIN,
            "TermFlow's display crashed again. When ready, right-click the tray icon → Restart, keep terminals."
        );
        assert_eq!(
            TOAST_FAILED,
            "TermFlow could not restore automatically. Your terminals are still running; check the log."
        );
        assert_eq!(
            TOAST_RESTART_FAILED,
            "TermFlow could not restart. Your terminals are still running; check the log."
        );
    }

    /// `file` is a path under `src/`, e.g. `"lib.rs"` or `"commands/window.rs"`.
    fn source(file: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(file);
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
            .replace("\r\n", "\n");
        strip_dead_blocks(&strip_comments(&raw))
    }

    /// Remove `if false { … }` and `#[cfg(any())] { … }` blocks so a call that
    /// exists only in unreachable code does not satisfy a wiring scan — the
    /// same precaution `commands/window.rs`'s tests take.
    fn strip_dead_blocks(src: &str) -> String {
        let mut out = src.to_string();
        loop {
            let at = match (out.find("if false"), out.find("#[cfg(any())]")) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            };
            let Some(at) = at else { break };
            let end = at + block_at(&out[at..], 0).len() + out[at..].find('{').unwrap();
            out.replace_range(at..end, "");
        }
        out
    }

    #[test]
    fn source_scan_ignores_dead_blocks() {
        let stripped = strip_dead_blocks(
            "fn f() {\n    if false {\n        show_info_toast(app, t, body);\n    }\n    #[cfg(any())] { log::error!(\"x\"); }\n    live();\n}\n",
        );
        assert!(!stripped.contains("show_info_toast"), "{stripped}");
        assert!(!stripped.contains("log::error"), "{stripped}");
        assert!(stripped.contains("live();"), "{stripped}");
    }

    /// Every assertion below scans source TEXT, and this module's own doc
    /// comments describe the very calls it looks for. A commented-out
    /// `webview_recovery::install(&main);` — whether behind `//` or wrapped in
    /// a `/* ... */` block — still contains the substring, so BOTH comment
    /// forms are removed before any `contains`/`matches` — the same
    /// precaution `commands/window.rs`'s wiring tests take.
    fn strip_comments(code: &str) -> String {
        // Block comments first (non-nested, may span lines): a `//` living
        // inside a `/* ... */` block must not defeat block-comment removal by
        // only clipping to end-of-line and leaving the rest of the block behind.
        let mut without_block = String::with_capacity(code.len());
        let mut rest = code;
        while let Some(start) = rest.find("/*") {
            without_block.push_str(&rest[..start]);
            match rest[start + 2..].find("*/") {
                Some(end) => rest = &rest[start + 2 + end + 2..],
                None => {
                    // Unterminated block comment: drop the remainder.
                    rest = "";
                    break;
                }
            }
        }
        without_block.push_str(rest);

        without_block
            .lines()
            .map(|line| match line.find("//") {
                Some(i) => &line[..i],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The comment stripping is what makes the wiring tests mean anything:
    /// prove it removes a commented-out install call (both `//` and
    /// `/* ... */`, including a multi-line block) and keeps a live one.
    #[test]
    fn source_scan_ignores_commented_out_calls() {
        let stripped = strip_comments(
            "    // crate::webview_recovery::install(&main);\n    crate::webview_recovery::install(&w);\n",
        );
        assert_eq!(stripped.matches("webview_recovery::install(").count(), 1);

        let block_stripped = strip_comments(
            "    /* crate::webview_recovery::install(&main); */\n    crate::webview_recovery::install(&w);\n",
        );
        assert_eq!(
            block_stripped.matches("webview_recovery::install(").count(),
            1,
            "a block-commented install call must be stripped: {block_stripped}"
        );

        let multiline_stripped = strip_comments(
            "/*\n    crate::webview_recovery::install(&main);\n*/\ncrate::webview_recovery::install(&w);\n",
        );
        assert_eq!(
            multiline_stripped.matches("webview_recovery::install(").count(),
            1,
            "a multi-line block-commented install call must be stripped: {multiline_stripped}"
        );
    }

    /// The automatic path runs against a DEAD renderer: it must pass
    /// `FlushPolicy::Skip`, or every recovery eats the 1.5 s flush timeout
    /// waiting for an ack that cannot come (plan 044 R3). The tray path,
    /// which presumes a live renderer, is pinned in `tray.rs`'s own tests.
    ///
    /// Checks EVERY `restart_keeping_terminals(` call in the body, not just
    /// the first: an unreachable first call passing `Skip` must not hide a
    /// second, real call that passes `Renderer`.
    #[test]
    fn automatic_recovery_skips_the_renderer_flush() {
        let src = source("webview_recovery.rs");
        let at = src
            .find("pub async fn on_browser_died")
            .expect("on_browser_died must exist");
        let body = block_at(&src, at);
        let calls = all_call_args(body, "restart_keeping_terminals(");
        assert!(
            !calls.is_empty(),
            "on_browser_died must call restart_keeping_terminals at least once. Body:\n{body}"
        );
        for args in &calls {
            assert!(
                args.contains("FlushPolicy::Skip"),
                "every restart_keeping_terminals call in on_browser_died must pass \
                 FlushPolicy::Skip (the renderer is presumed dead); got args: {args}"
            );
            assert!(
                !args.contains("FlushPolicy::Renderer"),
                "the automatic path must not ask a dead renderer to flush: {args}"
            );
        }
    }

    /// A restart the tray started first is BUSY, not FAILED: the failure
    /// report (log + toast) must be reserved for a real error.
    ///
    /// Requires the busy check to be an actual match GUARD — `Err(e) if e ==
    /// ... RESTART_IN_FLIGHT ... =>` in that order within one arm header —
    /// not merely three fragments found anywhere in the body (a dead
    /// `if e == RESTART_IN_FLIGHT && false {}` ahead of a single generic
    /// `Err(e) =>` arm would satisfy a fragment-only check).
    #[test]
    fn a_restart_already_in_flight_is_not_reported_as_a_failure() {
        let src = source("webview_recovery.rs");
        let at = src
            .find("pub async fn on_browser_died")
            .expect("on_browser_died must exist");
        let body = block_at(&src, at);

        let guard_at = body
            .find("Err(e) if e == ")
            .expect("the busy arm must read `Err(e) if e == ...`");
        let header = &body[guard_at..];
        let purpose_at = header
            .find("RESTART_IN_FLIGHT")
            .expect("the busy guard must compare against RESTART_IN_FLIGHT");
        header[purpose_at..]
            .find("=>")
            .expect("the busy arm header must end in `=>` after the RESTART_IN_FLIGHT comparison");

        let failed_at = body
            .find("report_restart_failure(")
            .expect("on_browser_died must still report a real failure");
        assert!(
            guard_at < failed_at,
            "the in-flight arm must be matched BEFORE the generic failure arm. Body:\n{body}"
        );
        let busy_arm = block_at(body, guard_at);
        assert!(
            !busy_arm.contains("report_restart_failure") && !busy_arm.contains("store(false"),
            "the in-flight arm must neither report a failure nor reset the latch. Arm:\n{busy_arm}"
        );

        // The GENERIC arm (distinct header shape from the guarded one above)
        // must be the one that reports. It need not be a `{ }` block (it
        // currently is not — a bare `Err(e) => report_restart_failure(...),`
        // expression arm), so scan a short window after its header rather
        // than brace-counting a block that may not exist.
        let generic_at = body
            .find("Err(e) =>")
            .expect("a plain `Err(e) =>` arm must exist alongside the guarded one");
        let arm_tail = &body[generic_at..(generic_at + 200).min(body.len())];
        assert!(
            arm_tail.contains("report_restart_failure("),
            "the generic Err(e) arm must call report_restart_failure. Arm:\n{arm_tail}"
        );
        assert!(
            call_args(body, "report_restart_failure(").contains("TOAST_FAILED"),
            "the automatic path reports with the automatic-restore wording"
        );
    }

    /// Every byte offset in `src` where `needle` starts.
    fn all_indices(src: &str, needle: &str) -> Vec<usize> {
        let mut out = Vec::new();
        let mut start = 0;
        while let Some(i) = src[start..].find(needle) {
            out.push(start + i);
            start += i + needle.len();
        }
        out
    }

    /// The `{ ... }` block whose opening brace is the first one at-or-after
    /// byte offset `at`, found by counting brace depth (not a naive
    /// next-`}`) so a nested block inside does not truncate the match early.
    fn block_at(src: &str, at: usize) -> &str {
        let open = src[at..]
            .find('{')
            .map(|i| at + i)
            .unwrap_or_else(|| panic!("no `{{` at-or-after byte {at}"));
        let mut depth = 0i32;
        for (i, c) in src[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &src[open..open + i + 1];
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces starting at byte {open}");
    }

    /// The text of the call arguments (balanced-paren scan) for the first
    /// call to `anchor` (which must end in `(`) found in `src`.
    fn call_args<'a>(src: &'a str, anchor: &str) -> &'a str {
        assert!(anchor.ends_with('('), "anchor must end with '(': {anchor}");
        let anchor_at = src
            .find(anchor)
            .unwrap_or_else(|| panic!("anchor `{anchor}` not found in:\n{src}"));
        let open = anchor_at + anchor.len() - 1;
        let mut depth = 0i32;
        for (i, c) in src[open..].char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return &src[open + 1..open + i];
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced parens after anchor `{anchor}`");
    }

    /// The call-argument text (balanced-paren scan) for EVERY call to
    /// `anchor` in `src`, not just the first — an unreachable/dead first call
    /// must not hide a second, real call from a check that only ever looked
    /// at the first occurrence.
    fn all_call_args<'a>(src: &'a str, anchor: &str) -> Vec<&'a str> {
        assert!(anchor.ends_with('('), "anchor must end with '(': {anchor}");
        all_indices(src, anchor)
            .into_iter()
            .map(|anchor_at| {
                let open = anchor_at + anchor.len() - 1;
                let mut depth = 0i32;
                for (i, c) in src[open..].char_indices() {
                    match c {
                        '(' => depth += 1,
                        ')' => {
                            depth -= 1;
                            if depth == 0 {
                                return &src[open + 1..open + i];
                            }
                        }
                        _ => {}
                    }
                }
                panic!("unbalanced parens after anchor `{anchor}`");
            })
            .collect()
    }

    /// Every real-window build site must install the recovery hook.
    /// `commands/drag.rs` builds the ephemeral drag-preview window, which
    /// must NOT get it (there is no session there worth recovering, and it
    /// is torn down/rebuilt constantly during a drag).
    ///
    /// Per-function, not aggregate: an aggregate count of 2 across
    /// `commands/window.rs` cannot tell "one install in each of
    /// `create_detached_window`/`open_new_window`" from "two installs in one
    /// of them and zero in the other" (e.g. the detached-window install
    /// removed and duplicated into `open_new_window`). Each function's own
    /// body is checked for exactly one `webview_recovery::install(` call.
    #[test]
    fn every_real_window_site_installs_the_recovery_hook() {
        // lib.rs's main window comes from tauri.conf.json (no
        // `WebviewWindowBuilder::new` there) — check the `get_webview_window`
        // setup block installs the hook instead. `get_webview_window("main")`
        // also appears in the unrelated headless-hide branch, so pick the
        // occurrence whose block is the one that installs context_menu (the
        // established per-window hook site this one sits next to).
        let lib = source("lib.rs");
        let anchor = "get_webview_window(\"main\")";
        let candidates = all_indices(&lib, anchor);
        assert!(!candidates.is_empty(), "anchor `{anchor}` not found in lib.rs");
        let main_setup_block = candidates
            .iter()
            .map(|&at| block_at(&lib, at))
            .find(|block| block.contains("context_menu::install(&main)"))
            .unwrap_or_else(|| {
                panic!("no `{anchor}` block containing context_menu::install(&main) found in lib.rs")
            });
        assert!(
            main_setup_block.contains("webview_recovery::install"),
            "the main-window setup block must install the recovery hook. Block:\n{main_setup_block}"
        );

        let window = source("commands/window.rs");
        for signature in ["pub async fn create_detached_window(", "pub fn open_new_window("] {
            let at = window
                .find(signature)
                .unwrap_or_else(|| panic!("`{signature}` not found in commands/window.rs"));
            let body = block_at(&window, at);
            let count = body.matches("webview_recovery::install(").count();
            assert_eq!(
                count, 1,
                "`{signature}` must install the recovery hook exactly once; found {count}. Body:\n{body}"
            );
        }

        let restore = source("window_restore.rs");
        let restore_signature = "fn build_restored_window(";
        let restore_at = restore
            .find(restore_signature)
            .expect("`fn build_restored_window(` not found in window_restore.rs");
        let restore_body = block_at(&restore, restore_at);
        let restore_count = restore_body.matches("webview_recovery::install(").count();
        assert_eq!(
            restore_count, 1,
            "window_restore.rs's build_restored_window must install the recovery hook \
             exactly once; found {restore_count}. Body:\n{restore_body}"
        );

        let drag = source("commands/drag.rs");
        assert!(
            !drag.contains("webview_recovery::install"),
            "commands/drag.rs builds the ephemeral drag-preview window and must NOT \
             install the recovery hook"
        );
    }

    /// The `ProcessFailed` handler runs on the UI thread inside COM (see the
    /// module doc / `install`) and must hand off to the async runtime rather
    /// than await or block inline. This rejects only the KNOWN blocking
    /// shapes listed below — it is a regression guard against those specific
    /// patterns, not a general proof that the handler never blocks: a
    /// blocking call of a shape not in this list would still sail through.
    #[test]
    fn handler_never_blocks_the_ui_thread() {
        let src = source("webview_recovery.rs");
        let body = call_args(&src, "ProcessFailedEventHandler::create(");
        assert!(
            body.contains("async_runtime::spawn"),
            "the ProcessFailed handler must hand off to the async runtime. Body:\n{body}"
        );
        for forbidden in [
            "thread::sleep",
            ".recv(",
            ".lock()",
            ".blocking_",
            "block_on",
            ".await",
            ".join(",
        ] {
            assert!(
                !body.contains(forbidden),
                "the ProcessFailed handler must never block the UI thread \
                 (found `{forbidden}`). Body:\n{body}"
            );
        }
    }
}
