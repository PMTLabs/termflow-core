//! Coordinating an update with the OTHER TermFlow instances on this machine.
//!
//! Design 014 Part B. Velopack's `Update.exe apply --root …` kills every process
//! running from under the install root — not just the one that asked. A sibling
//! profile (`rel.alt` while you are in `rel`) therefore loses its **GUI** to our
//! update.
//!
//! It does **not** lose its shells to the update. `pty_host_client::resolve_host_path`
//! copies the host binary into a content-addressed per-user runtime dir precisely
//! so it survives a payload swap, so a sibling's pty-host is never under the
//! install root. Its shells die for one reason only: **it never armed**.
//!
//! That makes the old refuse-on-sibling behaviour a coordination gap rather than
//! a safety floor. We ask each sibling to arm, then proceed — and refuse only
//! when a sibling genuinely cannot be asked.

use crate::net_ports::InstanceRecord;

/// Can we ask this sibling to arm?
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reachability {
    /// Serving an API we hold a token for.
    Reachable { port: u16, token: String },
    /// Running, but serving no API. An ELEVATED instance does this by default
    /// (design 009 D5: it serves neither port unless asked).
    NoPort,
    /// Serving, but we cannot read its token. An elevated instance's record
    /// carries a no-read-up mandatory label, so a medium-integrity process of
    /// the same user cannot read it — unreachable BY DESIGN, not by accident.
    NoToken,
}

/// Whether — and how — a sibling can be asked to arm.
///
/// Deliberately a pure function of the record: the decision is testable without
/// a socket, and the socket work in `arm_siblings` has nothing to decide.
pub fn reachability(rec: &InstanceRecord) -> Reachability {
    match (rec.api_port, rec.token.as_deref()) {
        (None, _) => Reachability::NoPort,
        (Some(_), None) => Reachability::NoToken,
        (Some(_), Some(t)) if t.is_empty() => Reachability::NoToken,
        (Some(port), Some(t)) => Reachability::Reachable { port, token: t.to_string() },
    }
}

/// Why an update must not proceed, or `None` if every sibling can be armed.
///
/// Names the offending instances: "an instance is running" without a name leaves
/// the user hunting for which window to close.
pub fn describe_unarmable(siblings: &[InstanceRecord]) -> Option<String> {
    let mut blocked: Vec<String> = siblings
        .iter()
        .filter_map(|s| match reachability(s) {
            Reachability::Reachable { .. } => None,
            Reachability::NoPort => {
                Some(format!("{} (pid {}) is not serving an API", s.profile, s.pid))
            }
            Reachability::NoToken => {
                Some(format!("{} (pid {}) has an unreadable token", s.profile, s.pid))
            }
        })
        .collect();
    if blocked.is_empty() {
        return None;
    }
    blocked.sort();
    Some(format!(
        "Cannot update while another TermFlow instance cannot be prepared: {}. \
         Updating would close it and lose its terminals. Close it and try again.",
        blocked.join(", ")
    ))
}

/// The base URL for a sibling's API.
///
/// **From the RECORD's port, never the configured one.** `default_api_port()`
/// reads only `is_dev()`, so every release profile is *configured* for the same
/// port; the first to start binds it and the rest walk forward. Routing by the
/// configured port does not fail — it succeeds against the WRONG instance, quite
/// possibly ourselves. PR #43 removed exactly this bug from six consumers.
pub fn sibling_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(profile: &str, pid: u32, api_port: Option<u16>, token: Option<&str>) -> InstanceRecord {
        InstanceRecord {
            profile: profile.into(),
            pid,
            api_port,
            mcp_port: None,
            token: token.map(str::to_string),
        }
    }

    #[test]
    fn a_serving_sibling_with_a_token_is_reachable() {
        assert_eq!(
            reachability(&rec("rel.alt", 41, Some(42035), Some("tok"))),
            Reachability::Reachable { port: 42035, token: "tok".into() }
        );
    }

    /// An elevated instance serves no port unless asked (design 009 D5).
    #[test]
    fn a_sibling_without_a_port_is_unreachable() {
        assert_eq!(reachability(&rec("rel.elevated.high", 9, None, Some("tok"))), Reachability::NoPort);
    }

    /// An elevated record's token is behind a no-read-up label, so a medium
    /// instance reads the record but not the token.
    #[test]
    fn a_sibling_whose_token_we_cannot_read_is_unreachable() {
        assert_eq!(reachability(&rec("rel.elevated.high", 9, Some(42037), None)), Reachability::NoToken);
    }

    /// An empty token is a missing token, not a valid one — otherwise we would
    /// send `Bearer ` and read the 401 as the sibling refusing to arm.
    #[test]
    fn an_empty_token_counts_as_unreadable() {
        assert_eq!(reachability(&rec("rel.alt", 41, Some(42035), Some(""))), Reachability::NoToken);
    }

    #[test]
    fn no_siblings_means_nothing_blocks() {
        assert_eq!(describe_unarmable(&[]), None);
    }

    /// THE acceptance criterion: a reachable `rel.alt` must not block `rel`.
    #[test]
    fn a_reachable_sibling_does_not_block_an_update() {
        assert_eq!(describe_unarmable(&[rec("rel.alt", 41, Some(42035), Some("tok"))]), None);
    }

    #[test]
    fn an_unreachable_sibling_blocks_and_names_itself() {
        let msg = describe_unarmable(&[rec("rel.elevated.high", 9, None, Some("t"))])
            .expect("an unarmable sibling must block");
        assert!(msg.contains("rel.elevated.high (pid 9)"), "must name it: {msg}");
        assert!(msg.contains("not serving an API"), "must say WHY: {msg}");
    }

    /// One unreachable sibling blocks even when others are fine — the update is
    /// all-or-nothing, because a partial arm still loses somebody's shells.
    #[test]
    fn one_unreachable_sibling_blocks_the_whole_update() {
        let msg = describe_unarmable(&[
            rec("rel.alt", 41, Some(42035), Some("tok")),
            rec("rel.elevated.high", 9, None, None),
        ])
        .expect("must block");
        assert!(msg.contains("rel.elevated.high"), "got: {msg}");
        assert!(!msg.contains("rel.alt"), "a reachable sibling must not be named: {msg}");
    }

    /// The record's port wins. A configured-port URL would address whichever
    /// instance won the bind — possibly ourselves (PR #43).
    #[test]
    fn the_base_url_uses_the_records_port() {
        assert_eq!(sibling_base_url(42035), "http://127.0.0.1:42035");
        assert_ne!(sibling_base_url(42035), sibling_base_url(42031));
    }
}
