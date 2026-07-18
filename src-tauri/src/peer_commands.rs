//! Tauri commands that proxy the `termflow-fabric` loopback control API.
//!
//! The renderer never talks to the fabric directly (CSP stays loopback-only and
//! the control plane goes over `invoke()`, not `fetch`). Each command builds a
//! [`FabricClient`](crate::fabric_manager::FabricClient) from
//! `state.fabric_control_port` and proxies exactly one control-API route.
//!
//! This open-core repo has ZERO build dependency on the fabric: when the binary
//! is absent nothing listens on the control port, so requests fail with a
//! connection error. [`fabric_status`] maps that to `{ installed: false }` so the
//! Peers UI can render a neutral "Peering not installed" card instead of an error.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::fabric_manager::{FabricClient, FabricError, FABRIC_PEER_PORT};
use crate::state::AppState;

// --- Wire-contract DTOs (fabric ↔ renderer) --------------------------------
//
// The fabric control API serializes snake_case with grants as `(terminal, level)`
// tuples and a `{ "peers": [...] }` envelope; the renderer's `PeerInfo`/`PairingCode`
// (see `types/electron.d.ts`) expect a bare camelCase array with grants as a
// `Record`. Forwarding the raw `Value` (the old behavior) made `peers.map(...)`
// throw and the Peers panel crash the moment the fabric was installed — even with
// zero peers (review C1) — and surfaced the pairing expiry as a raw
// `expires_in_secs` the UI never read (review L1). We convert at this one boundary
// into typed camelCase DTOs so the renderer receives exactly what it types.

/// One peer as the fabric serializes it on `GET /peers` (snake_case; grants as
/// `[terminal_id, level]` tuples). `#[serde(default)]` keeps deserialization total
/// so a peer missing an optional field degrades instead of failing the whole list.
#[derive(Deserialize)]
struct FabricPeer {
    device_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    addresses: Vec<String>,
    #[serde(default)]
    grants: Vec<(String, String)>,
    #[serde(default)]
    last_seen: Option<i64>,
    #[serde(default)]
    online: bool,
    #[serde(default)]
    os: Option<String>,
    #[serde(default)]
    fleet_exec: bool,
}

/// The `{ "peers": [...] }` envelope the fabric wraps the list in.
#[derive(Deserialize)]
struct FabricPeersEnvelope {
    #[serde(default)]
    peers: Vec<FabricPeer>,
}

/// Renderer-facing peer — matches `PeerInfo` in `types/electron.d.ts` (camelCase
/// keys; grants as a `{ terminalId: level }` map).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfoDto {
    device_id: String,
    name: String,
    addresses: Vec<String>,
    online: bool,
    last_seen: Option<i64>,
    grants: BTreeMap<String, String>,
    os: Option<String>,
    fleet_exec: bool,
}

/// The fabric's `POST /pairing-code` body (snake_case `expires_in_secs`).
#[derive(Deserialize)]
struct FabricPairingCode {
    code: String,
    #[serde(default)]
    expires_in_secs: u64,
}

/// Renderer-facing pairing code — matches `PairingCode` in `types/electron.d.ts`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCodeDto {
    code: String,
    expires_in_secs: u64,
}

/// One staged inbound pairing as the fabric serializes it on `GET /pending-approvals`.
#[derive(Deserialize)]
struct FabricPending {
    device_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    addr: String,
}

/// The `{ "pending": [...] }` envelope for staged approvals.
#[derive(Deserialize)]
struct FabricPendingEnvelope {
    #[serde(default)]
    pending: Vec<FabricPending>,
}

/// Renderer-facing pending pairing request — matches `PeerRequestInfo` in
/// `types/electron.d.ts` (camelCase `deviceId`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRequestDto {
    device_id: String,
    name: String,
    addr: String,
}

/// Convert a raw fabric `GET /peers` body into the renderer's `PeerInfo[]` shape.
/// Pure and total, so it is contract-tested against a canned real fabric response
/// without a live sidecar (the mocked-shape tests that let C1 through never crossed
/// this boundary). A shape mismatch returns `Err` rather than silently yielding an
/// empty list, so future contract drift surfaces loudly.
fn peers_from_fabric(raw: serde_json::Value) -> Result<Vec<PeerInfoDto>, serde_json::Error> {
    let env: FabricPeersEnvelope = serde_json::from_value(raw)?;
    Ok(env
        .peers
        .into_iter()
        .map(|p| PeerInfoDto {
            device_id: p.device_id,
            name: p.name,
            addresses: p.addresses,
            online: p.online,
            last_seen: p.last_seen,
            // The renderer only models `View`/`Control`; a `None` grant is the
            // absence of a key, so drop it rather than emit an invalid level.
            grants: p
                .grants
                .into_iter()
                .filter(|(_, level)| level != "None")
                .collect(),
            os: p.os,
            fleet_exec: p.fleet_exec,
        })
        .collect())
}

/// Turn a control-API failure into a clear, user-facing `Err(String)`. Connection
/// refused / timeout means the fabric isn't running (peering not installed / not up
/// yet); anything else surfaces the fabric's OWN explanation.
///
/// The non-2xx arm used to report only `fabric returned {status}`, which is why a
/// pairing failure reached the user as an unactionable "502 Bad Gateway": the fabric
/// always says why in its `{"error": ...}` body (e.g. "pairing not enabled" on the
/// remote), and [`FabricError`] now carries that through. The renderer classifies the
/// resulting message into guidance (see `classifyPairError` in `AddPeerModal.tsx`), so
/// the fabric's wording must survive verbatim here. `op` names the failed command so
/// the renderer can attribute it.
fn control_err(op: &str, e: FabricError) -> String {
    if e.is_connect() {
        format!("{op}: peering fabric is not running (connection refused)")
    } else if e.is_timeout() {
        format!("{op}: peering fabric did not respond (timeout)")
    } else {
        format!("{op}: {e}")
    }
}

/// Whether a fabric `/health` body belongs to this app instance. A fabric that reports
/// an `owner_id` must match ours; a fabric that reports none (older build) is accepted for
/// backward compatibility. Pure, so the ownership guard is unit-testable (review H6).
fn health_owner_matches(health: &serde_json::Value, my_instance_id: &str) -> bool {
    match health.get("owner_id").and_then(|v| v.as_str()) {
        Some(owner) => owner == my_instance_id,
        None => true,
    }
}

/// Report whether the peering fabric is reachable, and (if so) its `/health` body.
///
/// - Reachable → `{ "installed": true, "peerPort": …, ...health }` (the fabric's health
///   fields merged onto the `installed` flag). `peerPort` is the inbound listener remote
///   peers dial — the one port a user must open to pair across a router — and is sourced
///   from [`FABRIC_PEER_PORT`], the same constant the core hands the fabric via
///   `fabric_env`, so the Peers panel can never advertise a port the fabric isn't on.
/// - Connection refused / unreachable / timeout → `Ok({ "installed": false })`
///   (NOT an `Err`), so the absent-fabric path is a normal, non-error UI state.
/// - Any other failure (e.g. the fabric answered `/health` with a 5xx) → `Err`.
#[tauri::command]
pub async fn fabric_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let client = FabricClient::new(state.fabric_control_port);
    match client.get("/health").await {
        Ok(health) => {
            // Guard against driving ANOTHER instance's fabric (review H6): if the fabric
            // reports an owner id it must be ours. A mismatch means we reached a different
            // instance's fabric (a stale/shared control port), so report "not installed"
            // rather than exposing its peers/pairing to this renderer.
            if !health_owner_matches(&health, &state.instance_id) {
                return Ok(serde_json::json!({ "installed": false }));
            }
            let mut obj = health.as_object().cloned().unwrap_or_default();
            obj.insert("installed".to_string(), serde_json::Value::Bool(true));
            obj.insert("peerPort".to_string(), serde_json::json!(FABRIC_PEER_PORT));
            Ok(serde_json::Value::Object(obj))
        }
        // Nothing listening on the control port (fabric not installed / not yet up)
        // or a blackholed port that timed out → treat as "not installed", not an error.
        Err(e) if e.is_connect() || e.is_timeout() => {
            Ok(serde_json::json!({ "installed": false }))
        }
        Err(e) => Err(format!("fabric_status failed: {}", e)),
    }
}

/// List known peers with their online status and per-terminal grants.
/// GET `/peers` → converted to the renderer's camelCase `PeerInfo[]` shape.
#[tauri::command]
pub async fn peers_list(state: State<'_, AppState>) -> Result<Vec<PeerInfoDto>, String> {
    let client = FabricClient::new(state.fabric_control_port);
    let raw = client.get("/peers").await.map_err(|e| control_err("peers_list", e))?;
    peers_from_fabric(raw).map_err(|e| format!("peers_list: unexpected fabric response: {e}"))
}

/// List inbound pairings staged for the user's Accept/Decline. GET `/pending-approvals`
/// → renderer's camelCase `PeerRequestInfo[]`. Used to hydrate the consent queue on mount
/// / reconnect so a missed one-shot event isn't lost (review M4).
#[tauri::command]
pub async fn pending_approvals_list(
    state: State<'_, AppState>,
) -> Result<Vec<PeerRequestDto>, String> {
    let client = FabricClient::new(state.fabric_control_port);
    let raw = client
        .get("/pending-approvals")
        .await
        .map_err(|e| control_err("pending_approvals_list", e))?;
    let env: FabricPendingEnvelope = serde_json::from_value(raw)
        .map_err(|e| format!("pending_approvals_list: unexpected fabric response: {e}"))?;
    Ok(env
        .pending
        .into_iter()
        .map(|p| PeerRequestDto { device_id: p.device_id, name: p.name, addr: p.addr })
        .collect())
}

/// Mint a short-lived pairing code for an inbound peer to use with `peer_add`.
/// POST `/pairing-code` → renderer's camelCase `PairingCode` (`expiresInSecs`).
#[tauri::command]
pub async fn pairing_code_create(state: State<'_, AppState>) -> Result<PairingCodeDto, String> {
    let client = FabricClient::new(state.fabric_control_port);
    let raw = client
        .post("/pairing-code", serde_json::Value::Null)
        .await
        .map_err(|e| control_err("pairing_code_create", e))?;
    let fc: FabricPairingCode = serde_json::from_value(raw)
        .map_err(|e| format!("pairing_code_create: unexpected fabric response: {e}"))?;
    Ok(PairingCodeDto { code: fc.code, expires_in_secs: fc.expires_in_secs })
}

/// Dial a remote peer at `address` and pair with it using its `code`.
/// POST `/peers/add` `{ address, code }`.
#[tauri::command]
pub async fn peer_add(
    state: State<'_, AppState>,
    address: String,
    code: String,
) -> Result<serde_json::Value, String> {
    let client = FabricClient::new(state.fabric_control_port);
    client
        .post("/peers/add", serde_json::json!({ "address": address, "code": code }))
        .await
        .map_err(|e| control_err("peer_add", e))
}

/// Resolve a pending inbound pairing request: `accept` = true adds the peer,
/// false declines it. POST `/peers/approve` `{ device_id, accept }`.
#[tauri::command]
pub async fn peer_approve(
    state: State<'_, AppState>,
    device_id: String,
    accept: bool,
) -> Result<serde_json::Value, String> {
    let client = FabricClient::new(state.fabric_control_port);
    client
        .post(
            "/peers/approve",
            serde_json::json!({ "device_id": device_id, "accept": accept }),
        )
        .await
        .map_err(|e| control_err("peer_approve", e))
}

/// Revoke a peer: drop its record, links, and pinned cert. DELETE `/peers/{device_id}`.
#[tauri::command]
pub async fn peer_revoke(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<serde_json::Value, String> {
    let client = FabricClient::new(state.fabric_control_port);
    client
        .delete(&format!("/peers/{}", device_id))
        .await
        .map_err(|e| control_err("peer_revoke", e))
}

/// Set (or clear) a peer's grant for one terminal. `level` is `"View"` /
/// `"Control"` / `"None"` on the wire. POST `/peers/{device_id}/grants`
/// `{ terminal_id, level }`.
#[tauri::command]
pub async fn peer_set_grant(
    state: State<'_, AppState>,
    device_id: String,
    terminal_id: String,
    level: String,
) -> Result<serde_json::Value, String> {
    let client = FabricClient::new(state.fabric_control_port);
    client
        .post(
            &format!("/peers/{}/grants", device_id),
            serde_json::json!({ "terminal_id": terminal_id, "level": level }),
        )
        .await
        .map_err(|e| control_err("peer_set_grant", e))
}

/// Toggle whether a peer may create-and-run NEW fleet terminals on this machine
/// (`fleet_exec`, default OFF, revocable). POST `/peers/{device_id}/fleet`
/// `{ enabled }`. This is the single per-peer consent for `FleetExec` with no
/// target terminal; per-terminal grants still gate exec against an existing one.
#[tauri::command]
pub async fn peer_set_fleet_exec(
    state: State<'_, AppState>,
    device_id: String,
    enabled: bool,
) -> Result<(), String> {
    let client = FabricClient::new(state.fabric_control_port);
    client
        .post(
            &format!("/peers/{}/fleet", device_id),
            serde_json::json!({ "enabled": enabled }),
        )
        .await
        .map_err(|e| control_err("peer_set_fleet_exec", e))?;
    Ok(())
}

/// Toggle whether this machine accepts inbound pairing requests.
/// POST `/accept-peers` `{ enabled }`.
#[tauri::command]
pub async fn set_accept_peers(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let client = FabricClient::new(state.fabric_control_port);
    client
        .post("/accept-peers", serde_json::json!({ "enabled": enabled }))
        .await
        .map_err(|e| control_err("set_accept_peers", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The exact body `control_api::list_peers` serializes (envelope + snake_case +
    /// grant tuples), captured here as the contract so a fabric-side rename fails
    /// this test instead of crashing the panel at runtime.
    fn canned_peers_body() -> serde_json::Value {
        json!({
            "peers": [
                {
                    "device_id": "dev-abc",
                    "name": "workstation",
                    "addresses": ["100.64.0.2", "192.168.1.5:8790"],
                    "grants": [["pc-term-1", "View"], ["pc-term-2", "Control"], ["pc-term-3", "None"]],
                    "last_seen": 1_752_000_000_i64,
                    "online": true,
                    "os": "windows",
                    "fleet_exec": true
                }
            ]
        })
    }

    #[test]
    fn maps_real_fabric_peers_body_to_camelcase_dto() {
        let dtos = peers_from_fabric(canned_peers_body()).expect("valid body");
        assert_eq!(dtos.len(), 1);
        // Serialize the way Tauri returns it to the renderer and assert the exact
        // camelCase keys `PeerInfo` reads.
        let v = serde_json::to_value(&dtos[0]).unwrap();
        assert_eq!(v["deviceId"], "dev-abc");
        assert_eq!(v["name"], "workstation");
        assert_eq!(v["online"], true);
        assert_eq!(v["os"], "windows");
        assert_eq!(v["fleetExec"], true);
        assert_eq!(v["lastSeen"], 1_752_000_000_i64);
        // Grants become a `{ terminalId: level }` map; the `None` grant is dropped.
        assert_eq!(v["grants"]["pc-term-1"], "View");
        assert_eq!(v["grants"]["pc-term-2"], "Control");
        assert!(v["grants"].get("pc-term-3").is_none(), "None grant must be dropped");
        assert!(v.get("expires_in_secs").is_none());
    }

    #[test]
    fn empty_peers_envelope_yields_empty_list_not_crash() {
        // The precise C1 crash case: zero peers still arrives wrapped in `{peers:[]}`.
        let dtos = peers_from_fabric(json!({ "peers": [] })).expect("valid body");
        assert!(dtos.is_empty());
    }

    #[test]
    fn wrong_shape_with_data_is_a_loud_error_not_a_silent_drop() {
        // A bare array of peer objects (the shape the renderer *used* to assume)
        // must not silently vanish — carrying real peer data in the wrong envelope
        // surfaces as an error rather than dropping the peers.
        let bare_array = json!([{ "device_id": "dev-abc", "name": "workstation" }]);
        assert!(peers_from_fabric(bare_array).is_err());
    }

    #[test]
    fn health_owner_gates_foreign_fabric() {
        // Our own fabric → accepted.
        assert!(health_owner_matches(
            &json!({ "status": "ok", "owner_id": "inst-A" }),
            "inst-A"
        ));
        // Another instance's fabric → rejected (H6 hijack guard).
        assert!(!health_owner_matches(
            &json!({ "status": "ok", "owner_id": "inst-B" }),
            "inst-A"
        ));
        // Older fabric without an owner id → accepted (backward compatible).
        assert!(health_owner_matches(&json!({ "status": "ok" }), "inst-A"));
    }

    #[test]
    fn pairing_code_field_is_renamed_to_camelcase() {
        let fc: FabricPairingCode =
            serde_json::from_value(json!({ "code": "1234-5678", "expires_in_secs": 300 })).unwrap();
        let dto = PairingCodeDto { code: fc.code, expires_in_secs: fc.expires_in_secs };
        let v = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["code"], "1234-5678");
        assert_eq!(v["expiresInSecs"], 300);
        assert!(v.get("expires_in_secs").is_none());
    }
}
