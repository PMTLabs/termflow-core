use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use serde_json::json;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use futures::{sink::SinkExt, stream::StreamExt};
use crate::state::AppState;

pub(crate) async fn ws_handler(

    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

/// Per-connection WebSocket subscription filter for `output.data` forwarding.
///
/// A freshly-connected client defaults to `All` — it receives every terminal's
/// output, preserving the historical behaviour for existing API clients that
/// never send a `subscribe` message. Once the client sends
/// `{ "type":"subscribe", "terminalIds":[...] }`, the filter narrows to
/// `Only(set)` and forwards output for exactly those terminals (the fabric
/// sidecar always subscribes explicitly, so it gets scoped delivery).
#[derive(Debug, Clone)]
pub(crate) enum SubscriptionFilter {
    All,
    Only(HashSet<String>),
}

impl SubscriptionFilter {
    /// Default filter: forward output for every terminal.
    fn all() -> Self {
        SubscriptionFilter::All
    }

    /// Whether `output.data` for `terminal_id` should be forwarded to this client.
    fn wants(&self, terminal_id: &str) -> bool {
        match self {
            SubscriptionFilter::All => true,
            SubscriptionFilter::Only(ids) => ids.contains(terminal_id),
        }
    }

    /// Narrow the filter to exactly `ids` (invoked on a `subscribe` message).
    fn set(&mut self, ids: Vec<String>) {
        *self = SubscriptionFilter::Only(ids.into_iter().collect());
    }
}

/// Parse the OPTIONAL top-level `terminalIds` array from a `subscribe` message.
///
/// Returns `Some(ids)` ONLY when the field is explicitly present (even if empty), and
/// `None` when it is absent. The distinction matters: an absent field is the legacy
/// pattern-only subscribe (e.g. the shipping terminal-monitor client, which sends only
/// `payload.patterns`), and must leave the filter at `All` — narrowing it to `Only([])`
/// on an absent field would silently drop ALL of that client's live output.
pub(crate) fn parse_subscribe_ids(value: &serde_json::Value) -> Option<Vec<String>> {
    value.get("terminalIds").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect()
    })
}

pub(crate) async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    log::info!("New WebSocket connection established");
    
    // Send welcome message immediately
    let welcome = json!({
        "id": "welcome",
        "success": true,
        "data": { "version": "0.1.0", "mode": "tauri" }
    });
    if let Err(e) = sender.send(Message::Text(welcome.to_string())).await {
        log::warn!("Failed to send welcome message: {}", e);
        return;
    }

    let mut rx = state.output_tx.subscribe();
    let (tx_internal, mut rx_internal) = tokio::sync::mpsc::channel(100);

    // Per-connection output subscription filter, shared between this receiver
    // loop (which narrows it on a `subscribe` message) and the sender task
    // (which gates each `output.data` forward). Defaults to All.
    let filter = Arc::new(Mutex::new(SubscriptionFilter::all()));
    let sender_filter = Arc::clone(&filter);

    // Task to handle sending messages to the client
    let sender_task = tokio::spawn(async move {
        log::info!("[WS] Starting sender task, subscribed to broadcast channel");
        loop {
            tokio::select! {
                // Outgoing PTY data
                result = rx.recv() => {
                    match result {
                        Ok(msg) => {
                            // Per-connection subscription gating: skip terminals this
                            // client hasn't subscribed to. A client that never sent a
                            // `subscribe` stays `All` and receives everything. The lock
                            // guard is dropped before any `.await` below.
                            let wants = sender_filter
                                .lock()
                                .map(|f| f.wants(&msg.id))
                                .unwrap_or(true);
                            if !wants {
                                continue;
                            }

                            let data_str = String::from_utf8_lossy(&msg.data);

                            // Forward EVERY chunk to the WS client — including the
                            // hide-cursor + cursor-home redraws that full-screen TUIs
                            // (Claude Code, copilot, vim) emit on each keystroke.
                            // Previously these were dropped here as "resize refresh",
                            // which starved the web monitor of live updates and left it
                            // ~1s behind (it could only catch up via snapshot polling).
                            // The desktop app already emits all of it unconditionally
                            // ("Always emit data … so xterm.js can render TUI apps
                            // properly", lib.rs), and mirror mode sizes the monitor's
                            // xterm to the backend, so these chunks render correctly
                            // instead of garbling. The resize-refresh heuristic remains
                            // where it belongs — gating HISTORY storage in lib.rs.
                            let json = json!({
                                "type": "event",
                                "event": {
                                    "type": "output.data",
                                    "terminalId": msg.id,
                                    "data": {
                                        "content": data_str
                                    }
                                },
                                "timestamp": chrono::Utc::now().to_rfc3339()
                            });
                            if let Err(e) = sender.send(Message::Text(json.to_string())).await {
                                log::warn!("[WS] Failed to send message: {}", e);
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            // Slow consumer falling behind — can fire thousands of times/sec under
                            // heavy PTY output; keep it off the warn level.
                            log::debug!("[WS] Broadcast lagged, dropped {} message(s)", n);
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            log::warn!("[WS] Broadcast channel closed");
                            break;
                        }
                    }
                }
                // Outgoing responses from internal handler (heartbeats, subscriptions)
                Some(resp) = rx_internal.recv() => {
                    if let Err(_) = sender.send(Message::Text(resp)).await {
                        break;
                    }
                }
                else => break,
            }
        }
        log::info!("[WS] Sender task ending");
    });

    // Loop for receiving messages from client
    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                let msg_id = value["id"].as_str().unwrap_or("");
                let msg_type = value["type"].as_str().unwrap_or("");
                
                match msg_type {
                    "heartbeat" => {
                        let resp = json!({
                            "id": msg_id,
                            "success": true,
                        });
                        let _ = tx_internal.send(resp.to_string()).await;
                    }
                    "subscribe" => {
                        // Narrow this connection's output filter to the requested terminals
                        // — but ONLY when `terminalIds` is explicitly present
                        // (`{ "type":"subscribe", "terminalIds":[...] }`). When the field is
                        // absent (legacy pattern-only subscribe, e.g. the terminal-monitor
                        // client sending just `payload.patterns`), leave the filter at `All`
                        // so the connection keeps receiving every terminal's output.
                        // Normalised: the filter is matched against ChannelPayload.id,
                        // which is a pc- process id, but a client subscribes with the
                        // tm- id the API reported to it. Unnormalised, the filter matches
                        // nothing and the socket goes silent (design 014 A3).
                        let ids = parse_subscribe_ids(&value)
                            .map(|l| l.iter().map(|i| state.resolve_ref(i)).collect::<Vec<_>>());
                        if let Some(ref list) = ids {
                            if let Ok(mut f) = filter.lock() {
                                f.set(list.clone());
                            }
                        }
                        let resp = json!({
                            "id": msg_id,
                            "success": true,
                            "data": { "terminalIds": ids }
                        });
                        let _ = tx_internal.send(resp.to_string()).await;
                    }
                    "command" => {
                        let action = value["payload"]["action"].as_str().unwrap_or("");
                        match action {
                            "terminal:input" => {
                                // Normalised for the same reason as the REST handlers:
                                // a client sends the tm- id it was given, the maps are
                                // keyed by pc- (design 014 A3).
                                let terminal_id = &state.resolve_ref(
                                    value["payload"]["terminalId"].as_str().unwrap_or(""),
                                );
                                let data = value["payload"]["data"].as_str().unwrap_or("");

                                use std::io::Write;
                                // Host-owned terminals route to the sidecar; else
                                // write to the local writer (parity with the REST/
                                // Tauri input paths).
                                let write_result: Result<(), String> = if state
                                    .host_write(terminal_id, data.as_bytes())
                                {
                                    Ok(())
                                } else {
                                    // Clone the Arc, dropping the shard guard before locking.
                                    let writer_arc = state
                                        .shell_writer_channels
                                        .get(terminal_id)
                                        .map(|r| r.clone());
                                    match writer_arc {
                                        Some(writer_mutex) => match writer_mutex.lock() {
                                            Ok(mut writer) => writer
                                                .write_all(data.as_bytes())
                                                .map_err(|e| e.to_string()),
                                            Err(_) => Err("writer mutex poisoned".to_string()),
                                        },
                                        None => Err("terminal not found".to_string()),
                                    }
                                };

                                // WS input is an external channel (like the REST paths) —
                                // tag the last-write source so an agent ended via WS stays
                                // sticky rather than reverting. Writer guard already dropped.
                                if write_result.is_ok() {
                                    if let Some(mut t) = state.terminals.get_mut(terminal_id) {
                                        t.last_input_source = Some("api".to_string());
                                        t.last_input_at = Some(chrono::Utc::now().timestamp_millis());
                                    }
                                }

                                let resp = match write_result {
                                    Ok(()) => json!({ "id": msg_id, "success": true }),
                                    Err(e) => {
                                        // Previously discarded — the client saw success
                                        // while input was silently dropped (broken pipe).
                                        log::warn!("[WS] terminal:input write failed for {}: {}", terminal_id, e);
                                        json!({ "id": msg_id, "success": false, "error": e })
                                    }
                                };
                                let _ = tx_internal.send(resp.to_string()).await;
                            }
                            _ => {
                                let resp = json!({
                                    "id": msg_id,
                                    "success": true,
                                });
                                let _ = tx_internal.send(resp.to_string()).await;
                            }
                        }
                    }
                    _ => {
                        // Echo success for other message types to keep client happy
                        if !msg_id.is_empty() {
                            let resp = json!({
                                "id": msg_id,
                                "success": true,
                            });
                            let _ = tx_internal.send(resp.to_string()).await;
                        }
                    }
                }
            }
        }
    }
    
    log::info!("WebSocket connection closed");
    sender_task.abort();
}



#[cfg(test)]
mod tests {
    use super::*;

    // The per-connection WS subscription filter: default `All` forwards every
    // terminal; after a `subscribe` it narrows to exactly the requested ids.
    #[test]
    fn subscription_filter_scopes_terminals() {
        let mut sub = SubscriptionFilter::all(); // default: everything
        assert!(sub.wants("tb-1"));
        assert!(sub.wants("anything"));

        sub.set(vec!["tb-2".into()]); // after subscribe
        assert!(!sub.wants("tb-1"));
        assert!(sub.wants("tb-2"));

        // Re-subscribing replaces the set rather than accumulating.
        sub.set(vec!["tb-3".into(), "tb-4".into()]);
        assert!(!sub.wants("tb-2"));
        assert!(sub.wants("tb-3"));
        assert!(sub.wants("tb-4"));

        // An empty subscribe scopes to nothing (opt-out of all output).
        sub.set(vec![]);
        assert!(!sub.wants("tb-3"));
    }

    // Regression: a `subscribe` WITHOUT a top-level `terminalIds` field (the shipping
    // terminal-monitor client sends only `payload.patterns`) must NOT narrow the filter.
    // The absent-vs-empty distinction lives in the handler's parse step, which the
    // `subscription_filter_scopes_terminals` test above does not exercise (it drives
    // `SubscriptionFilter::set` directly). Conflating the two — as the old
    // `value["terminalIds"].as_array()...unwrap_or_default()` did — yielded `Only([])` and
    // dropped ALL live output for that client.
    #[test]
    fn subscribe_without_terminal_ids_keeps_all() {
        // Pattern-only subscribe: no top-level terminalIds → parses to None → filter stays All.
        let pattern_only = json!({
            "type": "subscribe",
            "payload": { "patterns": ["output.data", "process.*"] }
        });
        assert_eq!(parse_subscribe_ids(&pattern_only), None, "absent terminalIds → None");

        let mut filter = SubscriptionFilter::all();
        if let Some(ids) = parse_subscribe_ids(&pattern_only) {
            filter.set(ids);
        }
        assert!(matches!(filter, SubscriptionFilter::All), "absent field leaves the filter at All");
        assert!(filter.wants("tb-anything"), "All still forwards every terminal's output");

        // An explicit `terminalIds` DOES narrow — including an explicit empty array
        // (opt-out), which is a deliberate scope-to-nothing distinct from the absent case.
        let scoped = json!({ "type": "subscribe", "terminalIds": ["tb-1", "tb-2"] });
        let ids = parse_subscribe_ids(&scoped).expect("present terminalIds → Some");
        filter.set(ids);
        assert!(filter.wants("tb-1"));
        assert!(!filter.wants("tb-3"));

        assert_eq!(
            parse_subscribe_ids(&json!({ "type": "subscribe", "terminalIds": [] })),
            Some(vec![]),
            "explicit empty array is Some([]) (opt-out), never None"
        );
    }


}
