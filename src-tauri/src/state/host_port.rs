//! `AppState` as the application side of host adoption: how a candidate is
//! connected, what a listing reserves, and where a connected host is published.
//! The ordering and timing rules live in `host_adoption`.

use super::host_adoption::{
    frozen_connection_lost, reconnect_frozen, AdoptionPort, Barrier, ConnectFailure, Opened, PanePort,
    RECONNECT_BACKOFF_MS,
};
use super::host_connect::{connect_existing, endpoint_is_gone, GRACE_ENDPOINT_ONLY, GRACE_LIVE_HOST};
use super::host_registry;
use super::host_table::HostTable;
use super::types::{AppState, FrozenHost};
use crate::elevated_host::{FrozenId, HostChannel};
use crate::pty_host_client::{
    ConnectPlan, HostCandidate, HostConnectionOrigin, HostRole, PtyHostClient, PtyHostDeps,
};
use std::sync::Arc;
use tauri::{Emitter, Runtime};
use termflow_pty_protocol::SessionMeta;

/// Which endpoint to connect to and what the host can do, from its record.
///
/// `shutdown_control` decides whether Exit ANNOUNCES itself to the host
/// (`Control::Shutdown`). The failure modes are asymmetric: announcing to a
/// legacy host costs one undecodable frame, which drops the connection —
/// teardown, for a legacy host — plus a bounded ack wait; NOT announcing to a
/// host that needed it leaves every shell held for its retention window after
/// the user pressed Exit. So this is false only when a record POSITIVELY says
/// the host lacks the capability: no record (legacy, or a record lost after the
/// host started) announces.
struct HostFlags {
    endpoint: String,
    attach_acks: bool,
    shutdown_control: bool,
}

fn host_flags(plan: &ConnectPlan, record_less_endpoint: &str) -> Result<HostFlags, String> {
    match plan {
        ConnectPlan::LegacyOrNone => {
            log::info!("[HOTSWAP] no host discovery record — legacy/none; using {record_less_endpoint}");
            Ok(HostFlags { endpoint: record_less_endpoint.to_owned(), attach_acks: false, shutdown_control: true })
        }
        ConnectPlan::Bootstrap { endpoint, version, instance_id, host_caps, lifecycle: _ } => {
            let attach_acks = host_caps & termflow_pty_protocol::CAP_ATTACH_ACK != 0;
            let shutdown_control = host_caps & termflow_pty_protocol::CAP_SHUTDOWN_CONTROL != 0;
            log::info!(
                "[HOTSWAP] discovered host instance={instance_id:x} proto=v{version} \
                 caps={host_caps:#x} endpoint={endpoint} (attach_acks={attach_acks}, \
                 shutdown_control={shutdown_control})"
            );
            Ok(HostFlags { endpoint: endpoint.clone(), attach_acks, shutdown_control })
        }
        ConnectPlan::Incompatible { instance_id } => {
            // C3: NEVER kill or shadow sessions we can't speak to. Refuse the
            // sidecar path; panes fall back in-process and the running host
            // keeps serving its (old-app) sessions untouched.
            log::error!(
                "[HOTSWAP] running host instance={instance_id:x} shares no protocol \
                 version with this app — leaving its sessions untouched"
            );
            Err("a PTY host from another TermFlow version owns your terminals; \
                 close them there or wait for it to drain before new host-owned terminals"
                .to_string())
        }
    }
}

impl<R: Runtime> AppState<R> {
    /// The callbacks every host connection shares: wire its Exit/Gap into
    /// cleanup + emit / repaint, and translate the host's session keys into our
    /// process ids. Only what happens when the connection drops differs.
    fn host_deps(&self, lifecycle_token: String, channel: HostChannel, epoch: u64, on_disconnect: Arc<dyn Fn() + Send + Sync>) -> PtyHostDeps {
        let st_exit = self.clone();
        let st_gap = self.clone();
        PtyHostDeps {
            lifecycle_token,
            output_tx: self.output_tx.clone(),
            output_produced: self.output_produced.clone(),
            on_exit: Arc::new(move |process_id: String, session_key: String, exit_cwd: Option<String>| {
                // Mirror the in-process reader's exit path: capture cwd (from the
                // sidecar or our own OSC tracking), clean up, notify the UI.
                let cwd = exit_cwd
                    .or_else(|| st_exit.terminal_cwds.get(&process_id).map(|r| r.value().clone()));
                // Persist the final parser state BEFORE cleanup discards it — the
                // periodic flush only runs every 30s, so without this the session's
                // last moments never reach the history store. Takes the PROCESS id
                // and derives the history key from the terminal's leaf itself.
                st_exit.persist_terminal_history(&process_id, chrono::Utc::now().timestamp_millis());
                st_exit.forget_host_terminal(&process_id);
                // Ring bookkeeping is keyed by the SESSION, not the process: it is
                // the host's own offset and lives in the host's id space.
                st_exit.host_stream_offsets.remove(&session_key);
                st_exit.forget_host_session_claim_if_owner(&session_key, &process_id);
                // Drop the identity lookups LAST among the removals but before the
                // emit — a leaked entry would route a later terminal's output at a
                // process id that no longer exists.
                st_exit.identity.unindex(&process_id);
                st_exit.cleanup_terminal_state(&process_id);
                let _ = st_exit.app_handle.emit(
                    "terminal:exit",
                    serde_json::json!({ "id": process_id, "exitCode": 0, "cwd": cwd }),
                );
                // Same as the in-process path: release the app window if a dialog
                // this shell owned took it down with it (see console_window).
                crate::console_window::unstick_all(&st_exit.app_handle);
            }),
            on_gap: Arc::new(move |process_id: String| {
                st_gap.host_repaint(&process_id);
            }),
            // Session key -> process id. The host speaks its own id space; every
            // inbound frame is translated here before it reaches our maps
            // (design 014 §A3). An unknown session is DROPPED, never echoed.
            resolve_process: {
                let st = self.clone();
                Arc::new(move |k: &str| host_registry::resolve_inbound(&st.host_terminals, &st.host_table, channel, epoch, k))
            },
            on_disconnect,
            stream_offsets: self.host_stream_offsets.clone(),
        }
    }

    /// Drop handler of the primary connection generation `my_gen`.
    fn primary_disconnect(&self, my_gen: u64) -> Arc<dyn Fn() + Send + Sync> {
        let st_disc = self.clone();
        Arc::new(move || {
            // Only act if THIS connection is still the current one — a stale
            // old client's disconnect must not clobber a reconnected client.
            if st_disc.pty_host_gen.load(std::sync::atomic::Ordering::Acquire) != my_gen {
                return;
            }
            // Pipe died (sleep/wake, sidecar crash, …). Do NOT tear the
            // sessions down here: the host may be alive and holding every
            // shell (it Holds while armed / children live). Drop the dead
            // client, then reconnect-first; only sessions the host no longer
            // has — or a failed reconnect — are torn down.
            log::warn!("[HOTSWAP] pty-host pipe dropped (gen {my_gen}); trying in-place reconnect");
            st_disc.host_table.routes().remove_channel(HostChannel::Primary);
            *st_disc.pty_host.lock().unwrap_or_else(|e| e.into_inner()) = None;
            // The Settings Updates panel caches an offload verdict that is a
            // function of this connection; tell it the answer changed.
            let _ = st_disc.app_handle.emit("pty-host:disconnected", ());
            let st = st_disc.clone();
            tauri::async_runtime::spawn(async move {
                st.reconnect_after_pipe_drop().await;
            });
        })
    }

    /// Drop handler of a frozen host's connection `epoch`. A superseded
    /// connection does nothing; the current one marks the host unknown again and
    /// reconnects that one host, leaving every other host's panes alone.
    fn frozen_disconnect(&self, id: FrozenId, epoch: u64, endpoint: String) -> Arc<dyn Fn() + Send + Sync> {
        let st = self.clone();
        Arc::new(move || {
            if frozen_connection_lost(&st.host_table, &st.host_barrier, id, epoch, &endpoint) {
                log::warn!("[GEN] connection to terminal host {endpoint} dropped; trying to reconnect it");
                let _ = st.app_handle.emit("pty-host:disconnected", ());
                let st = st.clone();
                tauri::async_runtime::spawn(async move {
                    reconnect_frozen(&st, id, epoch, RECONNECT_BACKOFF_MS).await;
                });
            }
        })
    }

    async fn connect_current(&self, candidate: &HostCandidate) -> Result<Opened, String> {
        // RP-1: install the host into the update-stable runtime dir and run it
        // from there (outside the swapped app payload) so it survives an update.
        let launch = crate::pty_host_client::resolve_host_launch().ok_or_else(|| {
            "pty-host sidecar executable could not be resolved (set TERMFLOW_PTY_HOST_BIN)".to_string()
        })?;
        let token = crate::pty_host_client::resolve_token();

        // RP-2 discovery: the advertisement was read BEFORE touching the wire, so
        // we never speak an incompatible protocol at a host and never force-kill
        // sessions we can't control (design 003 §10.3, C3). No record ⇒ legacy
        // host (or none) on the current endpoint — v1 as today.
        let record = candidate.record.clone();
        match crate::pty_host_client::host_build_disposition(record.as_ref(), launch.build_id.as_deref()) {
            crate::pty_host_client::HostBuildDisposition::Current => {}
            crate::pty_host_client::HostBuildDisposition::Stale { observed, expected } => log::warn!(
                "[HOTSWAP] adopting stale pty-host build {observed} (expected {expected}); close these terminals, then restart TermFlow"
            ),
            crate::pty_host_client::HostBuildDisposition::Unknown => log::warn!(
                "[HOTSWAP] adopting pty-host with no build identity; close these terminals, then restart TermFlow"
            ),
        }
        let plan = crate::pty_host_client::plan_connection(record);
        let flags = host_flags(&plan, &candidate.endpoint)?;

        // Generation for this connection: on_disconnect only nulls `pty_host` if
        // its generation is still current (a dead old client can't clobber a new).
        let my_gen = self.pty_host_gen.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
        let deps = self.host_deps(token.clone(), HostChannel::Primary, my_gen, self.primary_disconnect(my_gen));
        // Advertised host pid (if any): connect_or_spawn refuses to spawn a
        // duplicate host while this pid is alive (sleep/wake duplicate-host bug).
        let (mut client, origin) = crate::pty_host_client::connect_or_spawn(
            &launch.path,
            launch.build_id.as_deref(),
            &flags.endpoint,
            &token,
            candidate.pid,
            deps,
        )
        .await
        .map_err(|e| e.to_string())?;
        client.set_attach_acks(flags.attach_acks);
        // A host we spawned ourselves (this build's bundled sidecar, installed
        // under its own content hash by `resolve_host_launch`) announces too.
        client.set_shutdown_control(flags.shutdown_control || origin == HostConnectionOrigin::SpawnedHere);
        client.set_lifecycle(plan.retention_for(origin));
        client.set_advertised_build_id(candidate.record.as_ref().and_then(|r| r.build_id.clone()));
        Ok(Opened { client, epoch: my_gen, build_id: launch.build_id })
    }

    async fn connect_frozen(&self, candidate: &HostCandidate, id: FrozenId, epoch: u64) -> Result<Opened, ConnectFailure> {
        let plan = crate::pty_host_client::plan_connection(candidate.record.clone());
        let flags = host_flags(&plan, &candidate.endpoint)?;
        let deps = self.host_deps(
            crate::pty_host_client::resolve_token(),
            HostChannel::Frozen(id),
            epoch,
            self.frozen_disconnect(id, epoch, candidate.endpoint.clone()),
        );
        let grace = if candidate.pid.is_some() { GRACE_LIVE_HOST } else { GRACE_ENDPOINT_ONLY };
        let mut client = connect_existing(&flags.endpoint, grace, deps).await.map_err(|e| ConnectFailure {
            reason: format!("could not connect to terminal host {}: {e}", candidate.endpoint),
            endpoint_gone: endpoint_is_gone(&e),
        })?;
        client.set_attach_acks(flags.attach_acks);
        client.set_shutdown_control(flags.shutdown_control);
        client.set_lifecycle(plan.retention_for(HostConnectionOrigin::Adopted));
        let build_id = candidate.record.as_ref().and_then(|r| r.build_id.clone());
        client.set_advertised_build_id(build_id.clone());
        Ok(Opened { client, epoch, build_id })
    }
}

impl<R: Runtime> AdoptionPort for AppState<R> {
    fn table(&self) -> &HostTable {
        &self.host_table
    }

    fn barrier(&self) -> &Barrier {
        &self.host_barrier
    }

    fn single_flight(&self) -> &tokio::sync::Mutex<()> {
        &self.pty_host_connecting
    }

    async fn discover(&self) -> Vec<HostCandidate> {
        // Reads records and probes processes and pipes: not for an async worker.
        tokio::task::spawn_blocking(crate::pty_host_client::discover_hosts)
            .await
            .unwrap_or_else(|e| {
                log::error!("[GEN] host discovery failed: {e}");
                Vec::new()
            })
    }

    fn current_endpoint(&self) -> String {
        crate::pty_host_client::current_host_paths().endpoint
    }

    fn current_client(&self) -> Option<PtyHostClient> {
        self.pty_host_clone()
    }

    fn frozen_hosts(&self) -> Vec<FrozenHost> {
        host_registry::frozen_hosts_snapshot(&self.frozen_hosts)
    }

    fn next_frozen_id(&self) -> FrozenId {
        AppState::next_frozen_id(self)
    }

    async fn connect(
        &self,
        candidate: &HostCandidate,
        role: HostRole,
        frozen: Option<(FrozenId, u64)>,
    ) -> Result<Opened, ConnectFailure> {
        match (role, frozen) {
            (HostRole::Frozen, Some((id, epoch))) => self.connect_frozen(candidate, id, epoch).await,
            _ => self.connect_current(candidate).await.map_err(ConnectFailure::from),
        }
    }

    fn apply_listing(&self, channel: HostChannel, client: &PtyHostClient, sessions: Option<&[SessionMeta]>) {
        // The host this listing speaks for. Its answer settles only the closes
        // owed to it and is compared only against the sessions it owns.
        // Record sessions that survived a hot-swap (tab_id -> pid) so
        // create_host_terminal reattaches instead of respawning. `None` means
        // the host did not answer — treat as unknown, never as empty.
        match sessions {
            None => log::warn!(
                "[HOTSWAP] host {} did not answer ListSessions during connect; \
                 adoption queue left unchanged",
                host_label(channel)
            ),
            Some([]) => {
                log::info!(
                    "[HOTSWAP] host {} reports no surviving sessions (fresh host or clean start)",
                    host_label(channel)
                );
                // Authoritative for THIS host: nothing left for it to close.
                self.prune_pending_closes(channel);
            }
            Some(surviving) => {
                log::info!(
                    "[HOTSWAP] host {} holds {} surviving session(s): {}",
                    host_label(channel),
                    surviving.len(),
                    surviving
                        .iter()
                        .map(|m| format!("{}(pid {}, alive={})", m.tab_id, m.pid, m.alive))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                let duplicates = host_registry::apply_answered_listing(
                    &host_registry::ListingMaps {
                        host_terminals: &self.host_terminals,
                        terminals: &self.terminals,
                        host_session_claims: &self.host_session_claims,
                        host_close_pending: &self.host_close_pending,
                        closed_unowned: &self.closed_unowned,
                    },
                    channel,
                    client,
                    surviving,
                    std::time::Instant::now(),
                );
                self.note_duplicate_sessions(&duplicates);
                // Any remaining tombstone owed to this host names a session its
                // (authoritative) list doesn't have — moot, drop them. Other
                // hosts' tombstones are theirs to settle.
                self.prune_pending_closes(channel);
            }
        }
    }

    fn publish_current(&self, client: &PtyHostClient) -> Result<(), String> {
        // Never leave a client published whose pipe dropped during setup — its
        // on_disconnect fired while `pty_host` was still None, so nothing else
        // would ever null it and every caller would hold a dead client forever
        // (review 007 C-1b). Publish FIRST, then re-check: if the drop raced
        // in between, we null our own publication; if it fires later, the
        // normal generation-guarded on_disconnect nulls it.
        *self.pty_host.lock().unwrap_or_else(|e| e.into_inner()) = Some(client.clone());
        if !client.is_alive() {
            *self.pty_host.lock().unwrap_or_else(|e| e.into_inner()) = None;
            return Err("pty-host connection lost during setup".to_string());
        }
        // Connecting is LAZY (the first host terminal gets here) and the Settings
        // Updates panel caches `hotswap_available`, so a Settings tab restored
        // onto Updates sampled "pty-host not connected — nothing to keep alive"
        // at mount — seconds before the reattach — and kept Offload disabled for
        // as long as the panel stayed open. Every window re-samples on this.
        let _ = self.app_handle.emit("pty-host:connected", ());
        Ok(())
    }

    fn publish_frozen(&self, host: FrozenHost) {
        self.add_frozen_host(host);
        let _ = self.app_handle.emit("pty-host:connected", ());
    }

    fn frozen_adopted(&self, id: FrozenId) {
        super::host_retire::start_ticker(self, id);
    }
}

impl<R: Runtime> PanePort for AppState<R> {
    fn panes_on(&self, channel: HostChannel) -> std::collections::HashMap<String, String> {
        self.host_sessions_by_key(channel)
    }

    fn registered_on_any_channel(&self, session_key: &str) -> bool {
        self.session_registered_on_any_channel(session_key)
    }

    fn pane_is_host_owned(&self, process_id: &str) -> bool {
        self.host_terminals.contains_key(process_id)
    }

    fn saved_offsets(&self) -> std::collections::HashMap<String, u64> {
        self.host_stream_offsets.iter().map(|e| (e.key().clone(), *e.value())).collect()
    }

    fn pane_size(&self, process_id: &str) -> (u16, u16) {
        self.terminals.get(process_id).map(|t| (t.cols, t.rows)).unwrap_or((80, 24))
    }

    fn teardown_pane(&self, process_id: &str) {
        self.teardown_host_terminal(process_id);
    }

    fn announce_recovered(&self, session_key: &str) {
        let leaf_id = format!("tm-{}", uuid::Uuid::new_v4().simple());
        if let Err(e) = self.app_handle.emit("api:createTerminalTab", serde_json::json!({
            "name": "Recovered terminal", "profile": "default", "processId": leaf_id,
            "rendererTerminalId": leaf_id, "sessionKey": session_key,
            "targetWindow": self.resolve_active_window_label(),
        })) {
            log::warn!("[HOTSWAP] failed to surface recovered session {session_key}: {e}");
        }
    }

    fn forget_host(&self, id: FrozenId) {
        let channel = HostChannel::Frozen(id);
        self.host_table.routes().remove_channel(channel);
        self.remove_frozen_host(id);
        // What was owed to a host that no longer exists can never be delivered,
        // and a session reserved on it is gone with it.
        self.prune_pending_closes(channel);
        host_registry::forget_reserved_claims_on(&self.host_session_claims, channel);
    }
}

fn host_label(channel: HostChannel) -> String {
    match channel {
        HostChannel::Frozen(id) => format!("frozen#{}", id.0),
        other => format!("{other:?}").to_lowercase(),
    }
}
