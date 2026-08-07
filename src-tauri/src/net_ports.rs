//! Port selection for an instance that may not be the only one running.
//!
//! Two rules, both learned the hard way:
//!
//! 1. **Bind as you pick, and keep what you bound.** `bind_reuseaddr` sets
//!    `SO_REUSEADDR` (required for the hot-restart rebind), so a bind SUCCEEDS
//!    even when another process already holds the port — bind failure cannot
//!    detect a conflict. Probing then binding leaves a window in between, and
//!    with per-profile instances two apps starting together is normal rather
//!    than a freak race. So the picker returns the LISTENER, which the server
//!    then consumes; nothing re-binds the port afterwards.
//!
//! 2. **Configured is not effective.** A fallback port must never be written
//!    back to the config, or the user's chosen port silently drifts every time
//!    a sibling happens to hold it. `AppState` therefore carries both.

use crate::network_commands::{bind_reuseaddr, probe_port_owner, PortOwner};

/// How many consecutive ports to try before giving up.
pub const DEFAULT_SPAN: u16 = 20;

/// A port and whatever was acquired for it.
#[derive(Debug)]
pub struct Picked<T> {
    pub port: u16,
    pub bound: T,
}

/// The ports this instance ACTUALLY serves on, which may differ from the
/// configured ones when a sibling instance got there first. Settings shows both;
/// only the configured values are ever persisted.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveEndpoints {
    /// `None` until the API has actually bound, or when it is suppressed.
    pub api_port: Option<u16>,
    /// `None` until the MCP sidecar has been given a port, or when suppressed.
    pub mcp_port: Option<u16>,
}

/// The ports to try, in order. Stops at `u16::MAX` rather than wrapping.
pub fn candidates(start: u16, span: u16) -> impl Iterator<Item = u16> {
    (0..span).map_while(move |i| start.checked_add(i))
}

/// Take the first port `acquire` accepts. Pure, so the selection rule is
/// testable without a network.
pub fn pick_bound_with<T>(
    start: u16,
    span: u16,
    mut acquire: impl FnMut(u16) -> Option<T>,
) -> Option<Picked<T>> {
    for port in candidates(start, span) {
        if let Some(bound) = acquire(port) {
            return Some(Picked { port, bound });
        }
    }
    None
}

/// Bind the first free port at or after `start`, and RETURN the listener.
///
/// A port answering `/health` with someone else's instance id is skipped without
/// binding: `SO_REUSEADDR` would let us steal it, and stealing the API port
/// silently reroutes the other instance's MCP tool calls into this app.
pub async fn bind_api_listener(
    host: [u8; 4],
    start: u16,
    span: u16,
    own_id: &str,
) -> Option<Picked<tokio::net::TcpListener>> {
    for port in candidates(start, span) {
        if probe_port_owner(port, own_id).await == PortOwner::OwnedByOther {
            log::info!("[NET] port {port} is owned by another instance; trying the next");
            continue;
        }
        let addr = std::net::SocketAddr::from((host, port));
        match bind_reuseaddr(addr) {
            Ok(listener) => {
                if port != start {
                    log::warn!(
                        "[NET] configured API port {start} was unavailable; serving on {port} \
                         instead (the configured value is unchanged)"
                    );
                }
                return Some(Picked { port, bound: listener });
            }
            Err(e) => log::warn!("[NET] bind {addr} failed: {e}; trying the next port"),
        }
    }
    log::error!("[NET] no free API port in {start}..{}", start.saturating_add(span));
    None
}

/// Choose an MCP port. Unlike the API we cannot hold this socket — the sidecar
/// is a separate process that binds it itself — so this is a probe, and the
/// identity check in `wait_for_mcp_health` is what actually proves we got it.
pub async fn pick_mcp_port(start: u16, span: u16, own_id: &str) -> Option<u16> {
    for port in candidates(start, span) {
        if probe_port_owner(port, own_id).await != PortOwner::OwnedByOther {
            if port != start {
                log::warn!(
                    "[NET] configured MCP port {start} was unavailable; using {port} instead \
                     (the configured value is unchanged)"
                );
            }
            return Some(port);
        }
    }
    log::error!("[NET] no free MCP port in {start}..{}", start.saturating_add(span));
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_configured_port_is_preferred_when_free() {
        let p = pick_bound_with(42031, 20, |_| Some(())).unwrap();
        assert_eq!(p.port, 42031);
    }

    #[test]
    fn a_taken_port_advances_to_the_next_free_one() {
        let p = pick_bound_with(42031, 20, |port| (port >= 42033).then_some(())).unwrap();
        assert_eq!(p.port, 42033);
    }

    #[test]
    fn an_exhausted_range_reports_failure_rather_than_binding_wildly() {
        assert!(pick_bound_with(42031, 3, |_| None::<()>).is_none());
    }

    #[test]
    fn the_range_is_exactly_span_ports_long() {
        // An off-by-one here means a sibling instance silently steals a port the
        // user configured for something else.
        assert_eq!(candidates(100, 3).collect::<Vec<_>>(), vec![100, 101, 102]);
        assert_eq!(candidates(100, 0).count(), 0);
    }

    #[test]
    fn the_range_stops_at_the_top_of_the_port_space() {
        // start + span overflows u16; wrapping would retry port 0 and below.
        assert_eq!(
            candidates(u16::MAX - 1, 5).collect::<Vec<_>>(),
            vec![u16::MAX - 1, u16::MAX]
        );
    }

    #[test]
    fn the_listener_is_carried_out_with_the_port() {
        // The whole point of bind-and-retain: the caller must receive the bound
        // resource, not just a number it has to bind again.
        let p = pick_bound_with(42031, 5, |port| Some(format!("socket-{port}"))).unwrap();
        assert_eq!(p.bound, "socket-42031");
    }

    #[test]
    fn effective_endpoints_can_say_unavailable() {
        // An elevated instance may serve neither, so both must be optional.
        let e = EffectiveEndpoints::default();
        assert_eq!(e.api_port, None);
        assert_eq!(e.mcp_port, None);
    }
}
