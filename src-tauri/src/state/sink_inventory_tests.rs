//! Lexical inventory, not a proof of lifetime safety. Named behavioral tests
//! supplement it; this catches new, unclassified sink functions.
//! Native PID/HWND effects and arbitrary aliases cannot be inventoried reliably
//! by these patterns: the manual sink table remains necessary for those.

use super::source_scan::{fn_spans, matching_brace, without_test_modules};
use std::{collections::BTreeSet, path::Path};
use regex::Regex;

// File, explicitly named functions, qualification mechanism or scope rationale.
const INVENTORY: &[(&str, &[&str], &str)] = &[
    ("api_server/capture.rs", &["resize_with_reflow"], "Registered pc rechecked at host enqueue; retained pc-indexed local master"),
    ("api_server/fleet.rs", &["fleet_local_run"], "new unique process event; deferred input retains exact pc"),
    ("api_server/mod.rs", &["start_api_server"], "owned listener; out of scope network status"),
    ("api_server/terminals/mod.rs", &["create_terminal"], "new unique pc; sorted leaf stripes and Registered authority for shell edges"),
    ("api_server/terminals/mod.rs", &["get_terminal_snapshot"], "exact non-reused pc replay-prefix projection"),
    ("api_server/terminals/mod.rs", &["emit_external_activity", "resize_terminal"], "exact non-reused pc projections/events; Registered host enqueue or retained local master"),
    ("api_server/ws.rs", &["handle_socket"], "owned WebSocket sender; immutable pc payloads"),
    ("automation_commands.rs", &["announce"], "out of scope durable rule UI events"),
    ("automation_store/sql.rs", &["ensure_column", "schema", "set_verbose_until", "sweep_expired_verbose"], "DB mutex; out of scope durable rule config/logs"),
    ("automation_store/sql/methods.rs", &["append", "bump_and_trim", "clear_completed", "delete_rule", "duplicate_automation", "mark_completed", "set_enabled_checked", "touch_target", "write_rule"], "DB mutex/transaction; out of scope durable rules and historical logs"),
    ("canvas_store.rs", &["delete_edge", "delete_edges_for", "insert_edge", "schema", "update_label"], "DB mutex; shell writers retain leaf stripes/current owner; user edits are durable intent"),
    ("commands/config_history.rs", &["merge_config"], "out of scope user command/directory history merge"),
    ("commands/drag.rs", &["begin_global_pane_drag", "claim_global_pane_drag", "resolve_tab_drop", "show_drag_preview"], "native notifications queued by ownership-qualified pg/wi/tx sinks with immutable page receipts; preview geometry is UI intent"),
    ("commands/panes.rs", &["pane_op"], "qualified Settle post-effect schedules shared sweep outside ownership/FIFO"),
    ("commands/terminal.rs", &["create_terminal", "host_fallback", "stage_scrollback"], "new unique/full pc replay and prompt-hook projections; original owner completion"),
    ("commands/terminal.rs", &["register_host_terminal"], "Placing original pc under ownership mutex through index/projection inserts"),
    ("commands/terminal.rs", &["run_create"], "original cg/pc/key and client epoch at publication/enqueue; admission ticket"),
    ("commands/terminal.rs", &["resize_terminal", "write_terminal"], "Registered original pc through host enqueue; retained local master/writer"),
    ("commands/update.rs", &["take_reattach_prompt_hook"], "exact non-reused pc prompt-hook removal"),
    ("commands/update.rs", &["restart_for_update", "restart_keeping_terminals"], "retained quiesce/exit admission and exact clients"),
    ("commands/window.rs", &["reserve_window_id", "record_new_window", "create_detached_window", "open_new_window"], "stable-id prebind owned by build guard; native success commits and failure/unwind compare-restores prior binding"),
    ("commands/window.rs", &["close_all_hosts"], "exit owns closed admission; retained exact clients"),
    ("commands/window.rs", &["flush_all_windows", "open_settings_in_main_window", "set_active_window"], "out of scope window/flush intent; framework objects"),
    ("elevated_host/mod.rs", &["publish", "publish_client"], "slot lock checks exit fence through exact-client/process installation; refused client is cancelled"),
    ("elevated_host/mod.rs", &["clear_client_on"], "manager slot mutex compares exact client epoch while capturing projection snapshot"),
    ("elevated_host/mod.rs", &["shutdown"], "slot-serialized exit fence; bounded connecting coordination and retained exact transport/process"),
    ("elevated_host/mod.rs", &["shutdown_idle"], "connecting plus channel drain; owner/epoch-qualified compare-detach under ownership mutex"),
    ("fabric_manager.rs", &["emit_peer_event"], "out of scope advisory peer status"),
    ("fabric_manager.rs", &["shutdown_fabric", "shutdown_fabric_generation", "start_fabric"], "generation slot compare-take/install; retained actual child"),
    ("canvas_endpoints.rs", &["create_edge"], "deliberate durable leaf intent under sorted leaf stripes"),
    ("history_flush.rs", &["flush_all_history", "flush_dirty_history"], "original full pc; persistence rechecks owner under retained leaf stripe"),
    ("history_store.rs", &["add_command", "add_command_dir", "delete_command", "delete_command_dir", "prune_commands", "prune_dir_usage"], "DB mutex; out of scope global command history"),
    ("history_store.rs", &["delete", "upsert"], "DB mutex inside caller-retained leaf stripe/current pc authority"),
    ("history_store.rs", &["open", "prune", "rename_renderer_id"], "owned schema or deliberate durable leaf intent under DB mutex/stripes"),
    ("identity_index.rs", &["index", "unindex"], "index caller retains Placing authority through synchronous leaf insert; unindex compares exact non-reused pc"),
    ("lib.rs", &["run"], "window intent/framework objects; global exit retains child handles"),
    ("lib.rs", &["shutdown_mcp_server", "shutdown_mcp_generation"], "generation slot compare-take; retained actual child"),
    ("mcp_sidecar.rs", &["start_mcp_legacy", "start_mcp_sidecar"], "generation slot compare-install; retained actual child; advisory status"),
    ("native_notify.rs", &["emit_activation"], "out of scope durable tab notification"),
    ("network_commands.rs", &["rotate_auth_token", "set_network_config", "start_servers", "stop_servers"], "network-operation mutex and owned listeners; out of scope network config"),
    ("output_pipeline.rs", &["spawn_output_consumer", "spawn_pipeline_watchdog"], "retained parser/history and immutable full pc events; advisory diagnostics"),
    ("pty_host_client.rs", &["arm_detach", "attach", "disarm", "resize", "shutdown", "write_stdin"], "exact client-owned FIFO/alive flag; raw compatibility adapters, production shell callers retain ownership qualification"),
    ("pty_host_client.rs", &["attach_confirmed_inner", "spawn_session_inner", "request_authorized"], "original session cg/pc/key plus bound client epoch under ownership mutex through enqueue"),
    ("pty_host_client.rs", &["list_sessions_numbered_within"], "source-client epoch under ownership mutex through numbered FIFO enqueue"),
    ("pty_host_client.rs", &["bind_sessions", "lost", "close_transport"], "exact retained ConnState; authority connect/disconnect compares binding epoch"),
    ("pty_host_client.rs", &["wire_client"], "original reader channel/key/epoch/pc under ownership mutex at offset/output publication"),
    ("pty_manager/spawn.rs", &["spawn_terminal"], "Placing original pc under ownership mutex through projection/index inserts; retained unpublished child"),
    ("session_notify.rs", &["subclass_proc"], "out of scope OS resume notification"),
    ("state/engine_host.rs", &["emit_activity", "emit_changed", "emit_state"], "out of scope rule UI state notifications"),
    ("state/host_adoption.rs", &["adopt"], "retained adoption holder/epoch/client; admission-qualified publication"),
    ("state/host_adoption.rs", &["frozen_connection_lost"], "exact original frozen channel/epoch; successor routes survive"),
    ("state/host_adoption.rs", &["sync", "begin_attempt", "abandon_attempt", "mark_retired", "begin_reconnect", "rerun", "drop"], "barrier mutex; host discovery/retirement/reconnect claim lifetime, not a connection outcome"),
    ("state/host_adoption.rs", &["finish_on", "mark_lost"], "barrier mutex through originating-epoch check and connection outcome mutation; pre-connect failures have no connection origin"),
    ("state/host_adoption/panes.rs", &["reattach_listed"], "original session and client epoch at route publication/post-Attach enqueue"),
    ("state/host_generation.rs", &["notify_terminal_generations"], "out of scope advisory generation refetch notification"),
    ("state/host_keys.rs", &["abort", "apply_exit", "apply_listing", "complete", "connect", "disconnect_inner", "end_staged_exit", "exit_process", "forget", "mark_end", "publish", "restore_route", "send", "stage", "trim"], "ownership/key mutex retained through cell, route, binding and FIFO mutations; exact epoch for publication/detach"),
    ("state/host_keys/delivery.rs", &["delivery_sender"], "immutable FIFO recovery capability; framework callback outside ownership mutex"),
    ("state/host_keys/effects.rs", &["close_original", "publish_route_on", "recover_listed"], "original session or Listed/holder qualification under ownership mutex through route/Close/delivery enqueue"),
    ("state/host_keys/owners.rs", &["write"], "sorted leaf stripes/current Registered pc qualification retained through storage callback"),
    ("state/host_keys/owners.rs", &["abort_create", "admit_create", "explicit_close_locked", "complete_shell", "end_process", "release_stage", "release_unstarted", "remove_held", "set_stage"], "owner row cg/pc and key in one ownership mutex; storage effect retained before row removal"),
    ("state/host_keys/pages.rs", &["begin_restore_participation", "cancel", "commit", "destroy", "end_matching", "register", "register_page", "reserve", "retire_restore_participant", "with_stable_id"], "committed wi/page and startup participation in ownership mutex; shared page-end cleanup and compare-retirement"),
    ("state/host_keys/panes.rs", &["admit_pane", "admitted_work", "apply_pane_op", "bind_pane", "depart_pane", "insert_panes", "pane_op_at"], "sender window/page, exact pi/cg/pc and next-seq qualification under ownership mutex; immutable close pc dispatched to stripe-qualified end_process"),
    ("state/host_keys/pane_payloads.rs", &["begin_pane_drag", "claim_pane_drag", "end_pane_drag", "route_pane_transfer"], "original sender pg/wi/tx and target committed page rechecked under ownership through nonblocking delivery enqueue; immutable page receipts rejected by successor renderers"),
    ("state/host_keys/pane_transfers.rs", &["adopt_panes", "clear_active_drag", "end_pane_pages", "end_transfer_record", "finish_transfer", "remove_transfer_member", "stash_panes", "take_panes"], "original page/tx/member/owner qualification at atomic mutation under ownership mutex; deadlines release ownership only; shell endings remain stripe-qualified"),
    ("state/host_keys/restore.rs", &["forget_pane_holder", "register_pane_holder", "settle_pane_restore", "reap_expired_restore_intents", "settle_restore_markers"], "owner/holder/alias/marker facts in one ownership mutex"),
    ("state/host_lifecycle.rs", &["sibling_arm"], "hold slot mutex; unique checked arm token and exact original clients/quiesce"),
    ("state/host_lifecycle.rs", &["release_host"], "retained exit/quiesce authority and exact client transport"),
    ("state/host_port.rs", &["forget_host"], "unique frozen identity and retired admission; authoritative key/route forget"),
    ("state/host_port.rs", &["announce_recovered"], "immutable authority-qualified delivery after ownership mutex release"),
    ("state/host_port.rs", &["frozen_disconnect", "host_deps", "primary_disconnect"], "exact captured channel/epoch and full pc; compare-take current slot; original-epoch route removal"),
    ("state/host_port.rs", &["publish_current", "publish_frozen"], "retained admission/epoch/unique frozen identity; advisory connected event"),
    ("state/host_retire.rs", &["retire"], "retained channel drain and exact original epoch/client"),
    ("state/host_table.rs", &["publish"], "admission mutex; monotonic epoch; clears only prior-epoch routes"),
    ("state/host_table.rs", &["retire", "retire_when_open"], "retained channel drain epoch under admission mutex; retirement flag controls exact guard release"),
    ("state/host_routes.rs", &["register", "remove_channel", "remove_epoch", "remove_key", "remove_process"], "caller retains ownership mutex through route mutation, or exact non-reused pc/epoch removal"),
    ("state/owner_lifecycle.rs", &["complete_create", "end_shell"], "original owner cg/pc; leaf stripes and ownership retained through storage/removal"),
    ("state/terminals.rs", &["begin_host_restore_sweep"], "startup participants captured as committed wi under ownership; sweep I/O outside ownership"),
    ("window_registry.rs", &["bind", "reserve_id", "drop", "forget", "register", "publish_reserved"], "tracker registry mutex serializes binding retirement and compare-qualified post-build upsert; explicit main binding stays distinct; disk snapshot/write serialized outside registry"),
    ("window_restore.rs", &["restore_windows", "build_restored_window"], "already-built main binding; secondary prebind owned by native build guard"),
    ("window_lifetime.rs", &["commit"], "captured-wi destroy retires participation before scheduling out-of-stream sweep"),
    ("state/terminals.rs", &["init_screen", "feed_screen"], "retained non-reused pc parser; initial publication inside Placing authority"),
    ("state/terminals.rs", &["cleanup_terminal_maps", "teardown_host_terminal"], "exact full pc removals; key offset deletion under authority; shell storage stripe"),
    ("state/terminals.rs", &["ensure_elevated_host_inner"], "connecting serialization; captured epoch compare-clear; retained launched process"),
    ("state/terminals.rs", &["forget_host_terminal"], "original pc removal; queued idle teardown rechecks original epoch/owners/admission"),
    ("state/terminals.rs", &["note_duplicate_sessions"], "out of scope advisory duplicate notice"),
    ("state/types.rs", &["clear_if_current", "install_if_current", "take", "take_if_current"], "generation compare-and-take/install under caller-retained slot mutex; retained actual child returned"),
    ("tray.rs", &["build_tray"], "out of scope window intent; global exit owns retained clients/children"),
    ("updater.rs", &["update_and_restart"], "out of scope legacy deliberate application restart"),
];

fn production(source: &str) -> String {
    let mut text = without_test_modules(&source.replace("\r\n", "\n"));
    let test_fn = Regex::new(r"#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+").unwrap();
    // Standalone test-only fixture functions must not inflate production sinks.
    while let Some(found) = test_fn.find(&text) {
        let start = found.start();
        let open = text[found.end()..].find('{').unwrap() + found.end();
        let end = matching_brace(&text, open) + 1;
        text.replace_range(start..end, "");
    }
    code_only(&text)
}

// Mask comments/string literals without moving byte offsets. Literal examples
// and prose must neither satisfy nor trip the inventory.
fn code_only(source: &str) -> String {
    let b = source.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        if b[i] == b'\'' && b.get(i + 2) == Some(&b'\'') {
            i += 3;
            continue;
        }
        if b[i] == b'\'' && b.get(i + 1) == Some(&b'\\') && b.get(i + 3) == Some(&b'\'') {
            i += 4;
            continue;
        }
        if b[i..].starts_with(b"//") {
            i += source[i..].find('\n').unwrap_or(b.len() - i);
        } else if b[i..].starts_with(b"/*") {
            i += 2;
            let mut depth = 1;
            while i < b.len() && depth > 0 {
                if b[i..].starts_with(b"/*") { depth += 1; i += 2; }
                else if b[i..].starts_with(b"*/") { depth -= 1; i += 2; }
                else { i += 1; }
            }
        } else if b[i] == b'"' {
            let hashes = b[..i].iter().rev().take_while(|c| **c == b'#').count();
            let raw = i > hashes && b[i - hashes - 1] == b'r';
            i += 1;
            if raw {
                let close = format!("\"{}", "#".repeat(hashes));
                i += source[i..].find(&close).map_or(b.len() - i, |at| at + close.len());
            } else {
                while i < b.len() && b[i] != b'"' { i += if b[i] == b'\\' { 2 } else { 1 }; }
                i = (i + 1).min(b.len());
            }
        } else { i += 1; continue; }
        for c in &mut out[start..i] { if *c != b'\n' { *c = b' '; } }
    }
    String::from_utf8(out).unwrap()
}

fn hits(source: &str) -> BTreeSet<String> {
    let text = production(source);
    // Broad on purpose: constructor/dispatch hits and durable policy sinks are
    // listed too. The function-name inventory must explain, not hide, those hits.
    let pattern = Regex::new(concat!(
        r"Control::(?:Spawn|Attach|AttachAcked|Close|Resize|ArmDetach|Disarm|Shutdown|ListSessions)\b|Data::Stdin\b|",
        r"\b(?:outbound|delivery)\s*\.\s*send\s*\(|\.delivery_sender\(\)\s*\.\s*send\s*\(|AssertUnwindSafe\(deliver\)|",
        r"\.\s*(?:bind_sessions|publish_route_on|restore_route|publish_frame|publish_shell_projection)\s*\(|\.connection\s*=|",
        r"\.\s*(?:resolution|retry_pending|reconnecting|reconnect_again|retired)\s*=|\btake\s*\(\s*&mut\s+\w+\.reconnect_again\s*\)|",
        r"\*self\.(?:client|proc)\s*\.|\*slot\s*=|\b(?:slot|client|proc)\s*\.\s*take\s*\(|self\.current\s*(?:=|\.\s*(?:take|replace)\s*\()|",
        r"\.\s*(?:persist_snapshot|persist_terminal_history|persist_history_snapshot|insert_edge|delete_edges_for|write_shells)\s*\(|",
        r"\.\s*(?:emit|emit_to|execute|execute_batch|close_transport|shutdown_idle|shutdown|clear_client_on|clear_client|install_if_current|clear_if_current|take_if_current)\s*\(|",
        r"\bregistry\s*\.\s*upsert\s*\(|\bself\s*\.\s*bind\s*\(|\.\s*with_stable_id\s*\(|\breserve_window_id\s*\(|\b(?:tracker|windows)\s*\.\s*(?:bind|register|publish_reserved|forget|reserve_id)\s*\(|\bids\s*\.\s*(?:insert|remove|entry)\s*\(|",
        r"\.\s*(?:begin_restore_participation|schedule_host_restore_release)\s*\(|\bself\s*\.\s*(?:building|committed|pages)\s*\.\s*(?:insert|remove|retain|clear)\s*\(|\binner\s*\.\s*panes\s*\.\s*active_drag\s*=|\binner\s*\.\s*panes\s*\.\s*(?:streams|present|holders|incarnation_high|transfers)\s*\.\s*(?:insert|remove|retain|clear|entry|get_mut)\s*\(|",
        r"\b(?:terminals|host_terminals|stream_offsets|host_stream_offsets|writers|masters|screens|screen_history|identity_index|identity|leaf_to_process|shell_writer_channels|ptys|terminal_history|terminal_screens|terminal_focus_reporting|tmux_sessions|terminal_cwds|history_dirty|replay_prefix|host_restore_pending_windows|reattach_prompt_hooks|routes|local_processes|restore_holders|closed_unowned|owners|keys|entries)(?:\(\))?\s*(?:\.\s*(?:lock\(\)|unwrap\(\)|keys\(\)|routes\(\)))?\s*\.\s*(?:insert|remove|remove_key|remove_process|remove_channel|remove_epoch|retain|clear|entry|get_mut|register|index|unindex|connect|disconnect)\s*\("
    )).unwrap();
    let spans = fn_spans(&text);
    pattern.find_iter(&text).filter_map(|hit| {
        spans.iter().filter(|(_, body)| body.contains(&hit.start())).min_by_key(|(_, body)| body.len()).map(|(name, _)| name.clone())
    }).collect()
}

// Terminal primitives list their lexical guards; orchestration entries name the
// shared teardown they must call. This is a lexical census, not a dataflow proof.
const LIFECYCLE_REMOVERS: &[(&str, &str, &[&str])] = &[
    ("state/host_keys/owners.rs", "abort_create", &["release_stage", "outcome.send_replace"]),
    ("state/host_keys/owners.rs", "complete_shell", &["end_staged_exit", "settle_pane_restore"]),
    ("state/host_keys/owners.rs", "end_process", &["mark_end", "outcome.send_replace"]),
    ("state/host_keys/owners.rs", "remove_held", &["OwnerState::Held"]),
    ("state/host_keys/owners.rs", "release_unstarted", &["!r.started", "outcome.send_replace"]),
    ("state/host_keys/owners.rs", "release_idle_owner", &["remove_held", "release_unstarted"]),
    ("state/host_keys/owners.rs", "explicit_close_locked", &["settle_pane_restore", "remove_transfer_member", "remove_held", "release_unstarted"]),
    ("state/host_keys/owners.rs", "close_leaf_locked", &["explicit_close_locked(inner, leaf.into(), policy)"]),
    ("state/host_keys/owners.rs", "close_process", &["explicit_close_locked(&mut inner, leaf, policy)"]),
    ("state/host_keys/panes.rs", "apply_pane_op", &["forget_pane_holder", "close_leaf_locked", "end_pages_locked", "settle_restore_participant"]),
    ("state/host_keys/panes.rs", "admit_pane", &["shell_of", "holders.remove"]),
    ("state/host_keys/panes.rs", "bind_pane", &["bindable", "holders.remove"]),
    ("state/host_keys/panes.rs", "depart_pane", &["release_idle_owner"]),
    ("state/host_keys/panes.rs", "admitted_work", &["window_pages.sender", "Owner::Pane"]),
    ("state/host_keys/panes.rs", "close_process_reap", &["if reap", "close_leaf_locked"]),
    ("state/host_keys/panes.rs", "pane_op_at", &["apply_pane_op", "expire_transfers_locked"]),
    ("state/host_keys/pane_payloads.rs", "begin_pane_drag", &["delivery_sender", "expire_transfers_locked", "ActiveDrag", "ended(token)"]),
    ("state/host_keys/pane_payloads.rs", "route_pane_transfer", &["delivery_sender", "expire_transfers_locked"]),
    ("state/host_keys/pane_payloads.rs", "verify_transfer_source", &["expire_transfers_locked"]),
    ("state/host_keys/pane_payloads.rs", "claim_pane_drag", &["clear_active_drag"]),
    ("state/host_keys/pane_payloads.rs", "end_pane_drag", &["clear_active_drag"]),
    ("state/host_keys/pane_transfers.rs", "stash_panes", &["remove_transfer_member"]),
    ("state/host_keys/pane_transfers.rs", "take_panes", &["finish_transfer"]),
    ("state/host_keys/pane_transfers.rs", "adopt_panes", &["release_idle_owner", "end_transfer_record"]),
    ("state/host_keys/pane_transfers.rs", "cancel_panes", &["finish_transfer"]),
    ("state/host_keys/pane_transfers.rs", "clear_active_drag", &["active_drag.as_deref", "active_drag.take", "drag.delivery.send(drag.ended)"]),
    ("state/host_keys/pane_transfers.rs", "end_transfer_record", &["clear_active_drag", "taken.send_replace"]),
    ("state/host_keys/pane_transfers.rs", "finish_transfer", &["end_transfer_record", "release_idle_owner"]),
    ("state/host_keys/pane_transfers.rs", "expire_transfers_locked", &["finish_transfer"]),
    ("state/host_keys/pane_transfers.rs", "expire_transfers", &["expire_transfers_locked"]),
    ("state/host_keys/pane_transfers.rs", "end_pane_pages", &["release_idle_owner", "finish_transfer", "clear_active_drag"]),
    ("state/host_keys/pane_transfers.rs", "remove_transfer_member", &["end_transfer_record"]),
    ("state/host_keys/restore.rs", "register_pane_holder", &["OwnerState::Registered", "OwnerState::Closing"]),
    ("state/host_keys/restore.rs", "forget_pane_holder", &["transfers.values", "!authorized"]),
    ("state/host_keys/restore.rs", "settle_pane_restore", &["row.owner"]),
    ("state/host_keys/restore.rs", "settle_restore_markers", &["intersects"]),
    ("state/host_keys/restore.rs", "reap_expired_restore_intents", &["m.live"]),
    ("state/host_keys/pages.rs", "drop", &["drop(self.stable_id.take())", "window_pages.cancel"]),
    ("state/host_keys/pages.rs", "cancel", &["building.get"]),
    ("state/host_keys/pages.rs", "commit", &["cancel"]),
    ("state/host_keys/pages.rs", "end_matching", &["pages.remove"]),
    ("state/host_keys/pages.rs", "destroy", &["retire_restore_participant", "end_matching"]),
    ("state/host_keys/pages.rs", "retire_restore_participant", &["host_restore_pending_windows.get"]),
    ("state/host_keys/pages.rs", "settle_restore_participant", &["latest_page", "retire_restore_participant"]),
    ("state/host_keys/pages.rs", "settle", &["end_matching"]),
    ("state/host_keys/pages.rs", "begin_restore_participation", &["committed.get"]),
    ("state/host_keys/pages.rs", "destroy_window", &["end_pages_locked"]),
    ("state/host_keys/pages.rs", "end_pages_locked", &["end_pane_pages"]),
    ("window_registry.rs", "bind", &["registry.lock()", "ids.insert"]),
    ("window_registry.rs", "reserve_id", &["registry.lock()", "ids.insert", "WindowIdGuard"]),
    ("window_registry.rs", "drop", &["registry.lock()", "self.committed", "entry.get() != &self.id", "self.previous.take", "entry.insert", "entry.remove"]),
    ("window_registry.rs", "forget", &["registry.lock()", "ids.remove", "registry.remove"]),
    ("window_registry.rs", "register", &["registry.lock()", "ids.insert", "registry.upsert"]),
    ("window_registry.rs", "publish_reserved", &["registry.lock()", "id_for_label(&record.label).as_deref() != Some(&record.id)", "registry.upsert"]),
    ("commands/window.rs", "record_new_window", &["windows.publish_reserved"]),
    ("window_restore.rs", "restore_windows", &["tracker.publish_reserved(record)", "tracker.register(slot0)"]),
];

fn lifecycle_removers(source: &str) -> BTreeSet<String> {
    let text = production(source);
    let pattern = Regex::new(concat!(
        r"\b(?:transfers|members|holders|present|streams|incarnation_high|closed_unowned|owners|building|committed|pages|host_restore_pending_windows)\s*\.\s*(?:remove|retain|clear)\s*\(|",
        r"\bstable_id\s*\.\s*take\s*\(|\bids\s*\.\s*(?:insert|remove|entry)\s*\(|\bactive_drag\s*\.\s*take\s*\(|",
        r"\b(?:tracker|windows)\s*\.\s*(?:register|publish_reserved)\s*\(|\bregistry\s*\.\s*upsert\s*\(|",
        r"\bcommitted\s*\.\s*insert\s*\(|\brow\s*\.\s*(?:owner|state|started|admitted_pg)\s*=|\bactive_drag\s*=\s*None\b|",
        r"\b(?:remove_held|release_unstarted|release_idle_owner|end_transfer_record|clear_active_drag|finish_transfer|end_pages_locked|end_matching|retire_restore_participant|close_leaf_locked|explicit_close_locked|remove_transfer_member|forget_pane_holder|depart_pane|settle_pane_restore|end_pane_pages|apply_pane_op|expire_transfers_locked)\s*\("
    )).unwrap();
    let spans = fn_spans(&text);
    pattern.find_iter(&text).filter_map(|hit| spans.iter()
        .filter(|(_, range)| range.contains(&hit.start())).min_by_key(|(_, range)| range.len())
        .map(|(name, _)| name.clone())).collect()
}

fn lifecycle_violations(file: &str, source: &str) -> Vec<String> {
    let text = production(source);
    let spans = fn_spans(&text);
    lifecycle_removers(source).into_iter().filter(|name| {
        let Some((_, _, helpers)) = LIFECYCLE_REMOVERS.iter().find(|(path, allowed, _)| *path == file && *allowed == name) else { return true; };
        let (_, range) = spans.iter().find(|(found, _)| found == name).unwrap();
        helpers.iter().any(|helper| !text[range.clone()].contains(helper))
    }).collect()
}

#[test]
fn entity_removers_are_listed_with_their_auxiliary_teardown() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut corpus = Vec::new();
    sources(&root, &root, &mut corpus);
    // These entities live in this table; unrelated maps called `pages` are not
    // ownership pages. A new sibling table file is included automatically.
    let corpus: Vec<_> = corpus.into_iter().filter(|(file, _)| file.starts_with("state/host_keys/") || ["window_registry.rs", "commands/window.rs", "window_restore.rs"].contains(&file.as_str())).collect();
    for required in ["pages.rs", "panes.rs", "pane_transfers.rs", "owners.rs", "restore.rs", "pane_payloads.rs"] {
        assert!(corpus.iter().any(|(file, _)| file.ends_with(required)), "missing {required}");
    }
    for (file, source) in &corpus {
        assert!(lifecycle_violations(file, source).is_empty(), "unlisted remover or missing auxiliary teardown in {file}: {:?}", lifecycle_violations(file, source));
    }
    for (file, name, _) in LIFECYCLE_REMOVERS {
        let (_, source) = corpus.iter().find(|(path, _)| path == file).unwrap();
        assert!(lifecycle_removers(source).contains(*name), "stale remover {file}:{name}");
    }
}

#[test]
fn planted_entity_remover_and_missing_shared_teardown_are_rejected() {
    for body in ["inner.panes.transfers.remove(tx);", "inner.panes.active_drag = None;", "inner.panes.holders.remove(pi);",
        "inner.closed_unowned.clear();", "inner.owners.remove(leaf);", "self.pages.remove(pg);", "self.host_restore_pending_windows.remove(label);",
        "row.owner = Owner::Orphaned;", "row.started = false;", "self.ids.insert(label, id);", "self.ids.remove(label);", "self.ids.entry(label);"] {
        let planted = format!("fn new_remover() {{ {body} }}");
        assert_eq!(lifecycle_violations("state/host_keys/new.rs", &planted), vec!["new_remover"]);
    }
    let missing = "fn end_transfer_record() { inner.panes.transfers.remove(tx); }";
    assert_eq!(lifecycle_violations("state/host_keys/pane_transfers.rs", missing), vec!["end_transfer_record"]);
    let missing_notice = "fn clear_active_drag() { if inner.panes.active_drag.as_deref() == Some(tx) { inner.panes.active_drag.take(); } }";
    assert_eq!(lifecycle_violations("state/host_keys/pane_transfers.rs", missing_notice), vec!["clear_active_drag"]);
    let missing_binding_rollback = "fn drop() { self.tracker.ids.entry(self.label.clone()); }";
    assert_eq!(lifecycle_violations("window_registry.rs", missing_binding_rollback), vec!["drop"]);
    let missing_close_obligations = "fn explicit_close_locked() { Self::release_unstarted(inner, leaf); row.state = OwnerState::Closing(shell); }";
    assert_eq!(lifecycle_violations("state/host_keys/owners.rs", missing_close_obligations), vec!["explicit_close_locked"]);
    let missing_publication_compare = "fn publish_reserved() { let mut registry = self.registry.lock(); registry.upsert(record); }";
    assert_eq!(lifecycle_violations("window_registry.rs", missing_publication_compare), vec!["publish_reserved"]);
    let fresh_bind_after_build = "fn record_new_window() { state.windows.register(record); }";
    assert_eq!(lifecycle_violations("commands/window.rs", fresh_bind_after_build), vec!["record_new_window"]);
    let restored_fresh_bind = "fn restore_windows() { tracker.register(slot0); tracker.register(record); }";
    assert_eq!(lifecycle_violations("window_restore.rs", restored_fresh_bind), vec!["restore_windows"]);
    assert!(lifecycle_removers("#[cfg(test)] mod tests { fn fixture() { inner.owners.clear(); } }").is_empty());
}

fn sources(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if path.file_name().is_none_or(|name| name != "tests") { sources(&path, root, out); }
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy();
        if path.extension().is_none_or(|e| e != "rs") || name.ends_with("_tests.rs")
            || matches!(name.as_ref(), "tests.rs" | "fake_hosts.rs" | "test_host.rs") { continue; }
        out.push((path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), std::fs::read_to_string(&path).unwrap()));
    }
}

fn unlisted(file: &str, source: &str) -> Vec<String> {
    hits(source).into_iter().filter(|name| !INVENTORY.iter().any(|(path, names, mechanism)|
        *path == file && names.contains(&name.as_str()) && !mechanism.is_empty())).collect()
}

#[test]
fn new_sink_functions_must_be_qualified_and_listed() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut corpus = Vec::new();
    sources(&root, &root, &mut corpus);
    corpus.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(corpus.len() > 100, "wrong inventory root");
    for expected in ["pty_host_client.rs", "state/host_keys/effects.rs", "elevated_host/mod.rs", "mcp_sidecar.rs"] {
        assert!(corpus.iter().any(|(file, _)| file == expected), "missing {expected}");
    }
    let mut unknown = Vec::new();
    for (file, source) in &corpus {
        for name in unlisted(file, source) { unknown.push(format!("{file}:{name}")); }
    }
    assert!(unknown.is_empty(), "New lexical sinks: qualify at the owning authority/effect boundary (or document retained capability/out-of-scope rationale), add the named function and mechanism to INVENTORY, and add a behavioral gate.\n{}", unknown.join("\n"));
    for (file, names, mechanism) in INVENTORY {
        assert!(!mechanism.is_empty());
        let source = &corpus.iter().find(|(path, _)| path == file).unwrap().1;
        let found = hits(source);
        for name in *names { assert!(found.contains(*name), "stale inventory entry {file}:{name}"); }
    }
}

#[test]
fn planted_wire_projection_store_route_emit_and_lifecycle_sinks_are_detected() {
    for (name, body) in [
        ("new_wire", "queue.send(Frame::Ctrl(Control::Close { tab_id: key }));"),
        ("new_projection", "terminals.insert(pc, terminal);"),
        ("new_store", "db.execute(sql, values);"),
        ("new_route", "routes.register(channel, key, pc, epoch);"),
        ("new_emit", "app.emit(event, payload);"),
        ("new_lifecycle", "transport.close_transport().await;"),
        ("new_barrier_result", "entry.resolution = Resolution::Resolved;"),
        ("new_barrier_retry", "entry.retry_pending = true;"),
        ("new_barrier_claim", "entry.reconnecting = false; entry.reconnect_again = true;"),
        ("new_barrier_retirement", "entry.retired = true;"),
        ("new_barrier_rerun", "std::mem::take(&mut entry.reconnect_again);"),
        ("new_page_remover", "self.pages.remove(&pg);"),
        ("new_window_remover", "self.committed.remove(label);"),
        ("new_drag_remover", "inner.panes.active_drag = None;"),
        ("new_transfer_remover", "inner.panes.transfers.remove(tx);"),
        ("new_holder_remover", "inner.panes.holders.remove(pi);"),
        ("new_sweep_remover", "self.host_restore_pending_windows.remove(label);"),
        ("new_binding_writer", "self.ids.insert(label, id);"),
        ("new_binding_remover", "self.ids.remove(label);"),
        ("new_binding_reservation", "tracker.reserve_id(label, id);"),
        ("new_token_ended_notice", "drag.delivery.send(drag.ended);"),
        ("new_guarded_publication", "tracker.publish_reserved(record);"),
    ] {
        let planted = format!("async fn {name}() {{ {body} }}");
        assert_eq!(unlisted("new_sink.rs", &planted), vec![name]);
    }
    assert!(hits("#[cfg(test)] mod tests { fn fixture() { terminals.insert(pc, t); } }").is_empty());
    assert!(hits("#[cfg(test)] fn fixture() { terminals.insert(pc, t); }").is_empty());
    assert!(hits("fn ordinary() { let value = 1; // app.emit(event, value)\n }").is_empty());
    assert!(hits("fn ordinary() { let example = \"app.emit(event, value)\"; }").is_empty());
}
