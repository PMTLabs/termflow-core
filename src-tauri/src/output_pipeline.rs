use crate::pty_manager;
use crate::state::AppState;
use tauri::Emitter;

/// Pure stall detector for the output-pipeline watchdog: returns the updated
/// consecutive-stall tick count. A stall tick is "producers advanced but the
/// consumer heartbeat didn't" — i.e. PTYs are emitting output that nobody is
/// delivering. Any other combination resets the count.
fn stall_ticks(
    produced: u64,
    consumed: u64,
    last_produced: u64,
    last_consumed: u64,
    prev_ticks: u8,
) -> u8 {
    if produced != last_produced && consumed == last_consumed {
        prev_ticks.saturating_add(1)
    } else {
        0
    }
}

/// Spawn the single PTY output consumer (generation-tagged). It drains the
/// broadcast channel and (1) feeds the authoritative vt100 screen parser,
/// (2) appends raw chunks to the history buffer, (3) emits terminal:data to
/// all windows. The watchdog respawns it with a bumped generation if it ever
/// stalls; a superseded instance exits at the generation check below.
pub(crate) fn spawn_output_consumer(state: AppState, generation: u64) {
    let mut rx = state.output_tx.subscribe();
    tauri::async_runtime::spawn(async move {
        log::info!("[PIPELINE] output consumer started (gen {})", generation);
        // Coalesce the renderer emit (terminal:data) so a TUI's back-to-back frames —
        // e.g. codex's redraw followed by its SEPARATE cursor-reposition frame — reach the
        // webview as ONE write. Otherwise the multi-hop IPC spreads them across xterm's
        // paint boundary and the in-between cursor position flickers ("cursor flash"). ONLY
        // the emit is deferred (by at most EMIT_COALESCE_MS): the authoritative screen
        // parser, history, watchdog heartbeat and Lagged handling below all still run
        // per-chunk and in-order. The byte cap flushes a large burst immediately so bulk
        // output never waits on the timer (and the buffer can't grow unbounded).
        const EMIT_COALESCE_MS: u64 = 5;
        const EMIT_FLUSH_BYTES: usize = 16 * 1024;
        let mut emit_buf: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut flush_at: Option<tokio::time::Instant> = None;
        loop {
            // When output is buffered, wait for the next chunk only until the flush
            // deadline — if it elapses first, emit the coalesced batch and loop. When
            // nothing is buffered, block for the next chunk exactly as before.
            let recv_result = match flush_at {
                Some(deadline) => match tokio::time::timeout_at(deadline, rx.recv()).await {
                    Ok(r) => r,
                    Err(_elapsed) => {
                        for (id, data) in emit_buf.drain() {
                            let _ = state.app_handle.emit(
                                "terminal:data",
                                serde_json::json!({ "id": id, "data": data }),
                            );
                        }
                        flush_at = None;
                        continue;
                    }
                },
                None => rx.recv().await,
            };
            // Don't die on Lagged (a transient slow-consumer burst): that would
            // permanently stop feeding the authoritative screen parser AND the
            // terminal:data emit for every terminal. Only stop when the channel
            // is closed (mirrors the SSE path in api_server.rs).
            let payload = match recv_result {
                Ok(payload) => payload,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    // Flush any coalesced output before exiting.
                    for (id, data) in emit_buf.drain() {
                        let _ = state.app_handle.emit(
                            "terminal:data",
                            serde_json::json!({ "id": id, "data": data }),
                        );
                    }
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!(
                        "PTY output listener lagged behind, dropped {} message(s); requesting repaint",
                        n
                    );
                    // Dropped chunks corrupt in-place TUI redraws (the missing
                    // bytes carried erase/cursor sequences). Force the apps to
                    // repaint so the screen parser and xterm self-heal instead
                    // of accumulating stale frames. The pending coalesced emit is
                    // stale now too — drop it; the repaint resyncs.
                    emit_buf.clear();
                    flush_at = None;
                    state.repaint_all_terminals_debounced(2_000);
                    continue;
                }
            };

            // Exit if the watchdog respawned a newer consumer while this one
            // was wedged — a recovered stale instance must not double-process.
            if state
                .consumer_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                != generation
            {
                log::warn!(
                    "[PIPELINE] output consumer gen {} superseded; exiting",
                    generation
                );
                break;
            }

            // Consumer heartbeat for the watchdog.
            state
                .output_consumed
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            let data_str = String::from_utf8_lossy(&payload.data).to_string();

            // Feed the authoritative screen parser with the exact raw bytes.
            // This always reflects the true current screen and is what the
            // client hydrates from on reconnect (no heuristics involved).
            state.feed_screen(&payload.id, &payload.data);

            // Track the shell-reported cwd from OSC 9;9 / OSC 7 sequences (backlog
            // 004). Authoritative for shells whose process cwd isn't live (PowerShell).
            if let Some(cwd) = pty_manager::parse_osc_cwd(&payload.data) {
                if state.terminals.contains_key(&payload.id) {
                    // Only emit when the cwd actually changed, so the renderer's live
                    // cwd map (Stream 4) updates on every `cd` without a per-prompt spam.
                    let changed = state
                        .terminal_cwds
                        .get(&payload.id)
                        .map(|v| *v != cwd)
                        .unwrap_or(true);
                    state.terminal_cwds.insert(payload.id.clone(), cwd.clone());
                    if changed {
                        let _ = state.app_handle.emit(
                            "terminal:cwd",
                            serde_json::json!({ "id": payload.id, "cwd": cwd }),
                        );
                    }
                }
            }

            // Buffer history as raw chunks — ONLY for terminals that still
            // exist. `.entry().or_insert_with()` would silently resurrect the
            // history entry for a terminal that was just closed (a late
            // broadcast chunk arriving after cleanup). The double-check after
            // the insert closes the residual TOCTOU window where
            // cleanup_terminal_state runs between the contains_key above and
            // the entry insert. Mirrors the feed_screen guard (state.rs).
            if state.terminals.contains_key(&payload.id) {
                // Clone the Arc out of the entry and DROP the shard guard at the
                // end of this statement. The inner Mutex below must never be
                // locked while a shard guard is held — that nesting let slow API
                // readers (history render under lock) starve this consumer, and
                // with it output delivery for EVERY terminal (the root cause of
                // the app-wide output stall).
                let history_arc = state
                    .terminal_history
                    .entry(payload.id.clone())
                    .or_insert_with(|| {
                        std::sync::Arc::new(std::sync::Mutex::new(
                            std::collections::VecDeque::new(),
                        ))
                    })
                    .clone();

                // Detect PTY resize refresh patterns that would overwrite content when replayed.
                // Key distinction:
                // - Initial setup: has clear screen (\x1b[2J) - should be STORED
                // - Resize refresh: has window manipulation (ends with 't') then cursor home - should be SKIPPED
                //
                // Resize refresh looks like: \x1b[?25l\x1b[8;20;115t\x1b[HPowerShell...
                // Initial setup looks like: \x1b[?9001h...\x1b[?25l\x1b[2J\x1b[m\x1b[HPowerShell...
                let mut idx = std::cmp::min(100, data_str.len());
                while idx > 0 && !data_str.is_char_boundary(idx) {
                    idx -= 1;
                }
                let check_prefix = &data_str[..idx];

                // Window manipulation (CSI Ps t) followed by cursor home is the key resize indicator
                // Pattern: ...t\x1b[H (e.g., \x1b[8;20;115t\x1b[H)
                let has_window_manip_then_home = check_prefix.contains("t\x1b[H");

                // Also detect hide cursor + cursor home WITHOUT clear screen (resize refresh)
                let has_hide_cursor = check_prefix.contains("\x1b[?25l");
                let has_cursor_home = check_prefix.contains("\x1b[H");
                let has_clear_screen = check_prefix.contains("\x1b[2J");

                // Resize refresh: has hide cursor + cursor home but NO clear screen
                let is_resize_without_clear = has_hide_cursor && has_cursor_home && !has_clear_screen;

                // Skip if:
                // 1. Window manipulation followed by cursor home (definite resize)
                // 2. Hide cursor + cursor home without clear screen (resize redraw)
                let is_full_refresh = has_window_manip_then_home || is_resize_without_clear;

                {
                    // Recover a poisoned mutex instead of skipping: a panic while
                    // holding it can't leave the VecDeque invalid, and silently
                    // skipping would freeze history forever (invisible to the
                    // watchdog, since the heartbeat keeps advancing). Scoped so
                    // the guard drops before the map double-check below.
                    let mut history = match history_arc.lock() {
                        Ok(guard) => guard,
                        Err(poisoned) => {
                            log::warn!(
                                "[PIPELINE] history mutex poisoned for {}; recovering",
                                payload.id
                            );
                            poisoned.into_inner()
                        }
                    };
                    if is_full_refresh {
                        log::debug!(
                            "Full screen refresh pattern detected (len={}, skipping history storage)",
                            data_str.len()
                        );
                        // Skip storing resize refresh chunks to history.
                        // These chunks contain cursor HOME (\x1b[H) which overwrites content
                        // when replayed from API.
                    } else {
                        // Store normal chunks (non-resize-refresh output)
                        history.push_back(data_str.clone());

                        // Cap history at 500 chunks (not lines) to limit memory
                        // Each chunk can contain multiple lines
                        while history.len() > 500 {
                            history.pop_front();
                        }

                        // Also cap total size to ~1MB
                        let mut total_size: usize = history.iter().map(|s| s.len()).sum();
                        while total_size > 1_000_000 && history.len() > 1 {
                            if let Some(removed) = history.pop_front() {
                                total_size -= removed.len();
                            }
                        }
                    }
                }

                // Mark this terminal's scrollback dirty for the next flush. Only when
                // we actually stored a chunk (resize-refresh frames are skipped above
                // and must not trip a write). Harmless if the double-check below then
                // removes the terminal — the flush skips vanished terminals.
                if !is_full_refresh {
                    state.history_dirty.insert(payload.id.clone(), ());
                }

                // Double-check after the insert: cleanup_terminal_state may have
                // run between the contains_key above and the entry insert,
                // orphaning the entry we just (re)created. Either ordering is now
                // covered — cleanup-before-insert is caught here; cleanup-after-here
                // removes the entry itself.
                if !state.terminals.contains_key(&payload.id) {
                    state.terminal_history.remove(&payload.id);
                }
            }

            // Check if test capture is enabled and capture raw output
            if state
                .test_capture_enabled
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                if let Some(test_id) = state.test_capture_id.read().as_ref() {
                    let capture_path = state
                        .test_capture_dir
                        .join(format!("backend-{}-{}.txt", test_id, payload.id));

                    // Append to file (don't overwrite - we want full history)
                    use std::io::Write;
                    if let Ok(mut file) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&capture_path)
                    {
                        let _ = file.write_all(data_str.as_bytes());
                    }
                }
            }

            // Coalesce the renderer emit (see top of loop): buffer per-id and flush on a
            // short deadline, or immediately once large, so a TUI's back-to-back frames
            // reach the webview as one write. feed_screen/history/heartbeat above already
            // ran per-chunk, so the authoritative state is unaffected by this batching.
            emit_buf
                .entry(payload.id.clone())
                .or_default()
                .push_str(&data_str);
            if emit_buf.values().map(|s| s.len()).sum::<usize>() >= EMIT_FLUSH_BYTES {
                for (id, data) in emit_buf.drain() {
                    let _ = state.app_handle.emit(
                        "terminal:data",
                        serde_json::json!({ "id": id, "data": data }),
                    );
                }
                flush_at = None;
            } else if flush_at.is_none() {
                flush_at = Some(
                    tokio::time::Instant::now()
                        + tokio::time::Duration::from_millis(EMIT_COALESCE_MS),
                );
            }
        }
        log::info!("[PIPELINE] output consumer (gen {}) exited", generation);
    });
}

/// Watchdog: every 3s compare the producer/consumer counters; two consecutive
/// "produced advanced but consumed didn't" ticks (~6s of stalled delivery while
/// terminals are actively producing) trigger auto-heal — bump the generation,
/// respawn the consumer, notify the renderer, and force a repaint so terminals
/// visibly recover the frames lost while stalled.
pub(crate) fn spawn_pipeline_watchdog(state: AppState) {
    tauri::async_runtime::spawn(async move {
        let mut last_produced = 0u64;
        let mut last_consumed = 0u64;
        let mut ticks = 0u8;
        // Consecutive heals with zero consumer progress in between. If the
        // respawned consumer wedges on the same root cause every time, stop
        // spawning (each heal leaks the wedged task) and leave a loud log.
        let mut heals_without_progress = 0u32;
        const MAX_FRUITLESS_HEALS: u32 = 10;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let produced = state
                .output_produced
                .load(std::sync::atomic::Ordering::Relaxed);
            let consumed = state
                .output_consumed
                .load(std::sync::atomic::Ordering::Relaxed);
            if consumed != last_consumed {
                // Consumer made progress — healing (if any) worked.
                heals_without_progress = 0;
            }
            ticks = stall_ticks(produced, consumed, last_produced, last_consumed, ticks);
            last_produced = produced;
            last_consumed = consumed;
            if ticks >= 2 {
                ticks = 0;
                if heals_without_progress >= MAX_FRUITLESS_HEALS {
                    if heals_without_progress == MAX_FRUITLESS_HEALS {
                        heals_without_progress += 1;
                        log::error!(
                            "[PIPELINE] consumer still stalled after {} heals; auto-heal disabled (restart the app)",
                            MAX_FRUITLESS_HEALS
                        );
                    }
                    continue;
                }
                heals_without_progress += 1;
                let gen = state
                    .consumer_generation
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                    + 1;
                log::error!(
                    "[PIPELINE] output consumer stalled (produced={} consumed={}); auto-heal engaging (gen {})",
                    produced,
                    consumed,
                    gen
                );
                spawn_output_consumer(state.clone(), gen);
                if let Err(e) = state.app_handle.emit(
                    "terminal:pipeline-healed",
                    serde_json::json!({ "generation": gen }),
                ) {
                    log::warn!("[PIPELINE] failed to emit pipeline-healed: {}", e);
                }
                // interval 0 = always repaint, but stamp the debounce window so
                // a Lagged event right after the heal doesn't double-jiggle.
                state.repaint_all_terminals_debounced(0);
            }
        }
    });
}

#[cfg(test)]
mod pipeline_tests {
    use super::stall_ticks;

    #[test]
    fn stall_tick_increments_when_producing_but_not_consuming() {
        // produced advanced, consumed frozen -> tick
        assert_eq!(stall_ticks(10, 5, 8, 5, 0), 1);
        assert_eq!(stall_ticks(12, 5, 10, 5, 1), 2);
    }

    #[test]
    fn stall_ticks_reset_when_consumer_advances() {
        // consumer moved -> healthy, reset
        assert_eq!(stall_ticks(12, 6, 10, 5, 1), 0);
    }

    #[test]
    fn stall_ticks_reset_when_idle() {
        // nothing produced -> not a stall (idle terminals are fine)
        assert_eq!(stall_ticks(10, 5, 10, 5, 1), 0);
    }

    #[test]
    fn stall_ticks_saturate_instead_of_overflowing() {
        assert_eq!(stall_ticks(10, 5, 8, 5, u8::MAX), u8::MAX);
    }
}
