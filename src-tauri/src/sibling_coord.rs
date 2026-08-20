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
    let Some(port) = rec.api_port else { return Reachability::NoPort };
    match rec.token.as_deref() {
        // An empty token is a MISSING token, not a valid one: sending `Bearer `
        // would read the resulting 401 as the sibling refusing to arm.
        Some(t) if !t.is_empty() => Reachability::Reachable { port, token: t.to_string() },
        _ => Reachability::NoToken,
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

/// What to ask a sibling to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Arm,
    Disarm,
}

impl Action {
    fn path(self) -> &'static str {
        match self {
            Action::Arm => "/api/hotswap/arm",
            Action::Disarm => "/api/hotswap/disarm",
        }
    }
}

/// One request to one sibling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiblingCall {
    pub profile: String,
    pub port: u16,
    pub token: String,
    pub action: Action,
}

/// How long to wait for a sibling to acknowledge. A timeout is a FAILURE, not a
/// pass: proceeding on silence would apply the update over an unarmed sibling,
/// which is the exact outcome this whole mechanism exists to prevent.
pub const SIBLING_CALL_TIMEOUT_SECS: u64 = 5;

/// Ask every sibling to arm. Returns the profiles that armed, in order.
///
/// **Two phases, and the order is the point.** Reachability is decided for ALL
/// siblings before ANY is armed, so a refusal leaves the machine exactly as it
/// found it. Arming as we go and discovering an unreachable sibling third would
/// leave the first two holding a detach window for an update that never ran.
///
/// If a call fails part-way through, the siblings already armed are disarmed
/// before the error is returned — an aborted update must not mutate strangers.
pub async fn arm_siblings<F, Fut>(
    siblings: &[InstanceRecord],
    call: F,
) -> Result<Vec<String>, String>
where
    F: Fn(SiblingCall) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    // Phase 1: can everyone be asked? Nothing is mutated here.
    if let Some(reason) = describe_unarmable(siblings) {
        return Err(reason);
    }

    // Phase 2: ask.
    let mut armed: Vec<String> = Vec::new();
    for s in siblings {
        let Reachability::Reachable { port, token } = reachability(s) else {
            // Unreachable, yet phase 1 passed: the two disagree, which can only
            // mean the record changed underneath us. Treat it as a refusal.
            let _ = disarm_siblings(siblings, &armed, &call).await;
            return Err(format!("{} became unreachable while preparing the update", s.profile));
        };
        let req = SiblingCall {
            profile: s.profile.clone(),
            port,
            token,
            action: Action::Arm,
        };
        match call(req).await {
            Ok(()) => armed.push(s.profile.clone()),
            Err(e) => {
                let msg = format!("{} could not be prepared for the update: {e}", s.profile);
                log::warn!("[UPDATE] {msg}; releasing {} already-armed sibling(s)", armed.len());
                let _ = disarm_siblings(siblings, &armed, &call).await;
                return Err(msg);
            }
        }
    }
    Ok(armed)
}

/// Release the detach windows held by `armed`.
///
/// Best-effort: a sibling we cannot reach to disarm will expire its own window,
/// so a failure here must not mask the error that caused the rollback.
pub async fn disarm_siblings<F, Fut>(
    siblings: &[InstanceRecord],
    armed: &[String],
    call: &F,
) -> Vec<String>
where
    F: Fn(SiblingCall) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let mut released = Vec::new();
    for profile in armed {
        let Some(rec) = siblings.iter().find(|s| &s.profile == profile) else { continue };
        let Reachability::Reachable { port, token } = reachability(rec) else { continue };
        let req = SiblingCall {
            profile: profile.clone(),
            port,
            token,
            action: Action::Disarm,
        };
        match call(req).await {
            Ok(()) => released.push(profile.clone()),
            Err(e) => log::warn!("[UPDATE] could not disarm {profile}: {e} (its window will expire)"),
        }
    }
    released
}

/// The real HTTP call, addressed at the RECORD's port (never the configured one).
pub async fn http_call(req: SiblingCall) -> Result<(), String> {
    let url = format!("{}{}", sibling_base_url(req.port), req.action.path());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(SIBLING_CALL_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", req.token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {}", resp.status()))
    }
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

    // ---- arm_siblings ----

    use std::sync::{Arc, Mutex};

    /// Records every call, and can be told to fail the Nth arm.
    #[derive(Clone, Default)]
    struct Recorder {
        calls: Arc<Mutex<Vec<SiblingCall>>>,
        fail_arm_number: Option<usize>,
    }

    impl Recorder {
        fn failing_on(n: usize) -> Self {
            Self { calls: Arc::new(Mutex::new(Vec::new())), fail_arm_number: Some(n) }
        }
        fn call(&self) -> impl Fn(SiblingCall) -> std::future::Ready<Result<(), String>> + '_ {
            move |req: SiblingCall| {
                let mut calls = self.calls.lock().unwrap();
                let arm_count = calls.iter().filter(|c| c.action == Action::Arm).count() + 1;
                let is_arm = req.action == Action::Arm;
                calls.push(req);
                let fail = is_arm && self.fail_arm_number == Some(arm_count);
                std::future::ready(if fail { Err("refused".to_string()) } else { Ok(()) })
            }
        }
        fn armed(&self) -> Vec<String> {
            self.calls.lock().unwrap().iter()
                .filter(|c| c.action == Action::Arm).map(|c| c.profile.clone()).collect()
        }
        fn disarmed(&self) -> Vec<String> {
            self.calls.lock().unwrap().iter()
                .filter(|c| c.action == Action::Disarm).map(|c| c.profile.clone()).collect()
        }
        fn ports(&self) -> Vec<u16> {
            self.calls.lock().unwrap().iter().map(|c| c.port).collect()
        }
    }

    #[tokio::test]
    async fn every_reachable_sibling_is_armed_and_reported() {
        let r = Recorder::default();
        let armed = arm_siblings(&[rec("rel.alt", 41, Some(42035), Some("tok"))], r.call())
            .await
            .expect("a reachable sibling must not block");
        assert_eq!(armed, vec!["rel.alt".to_string()]);
        assert_eq!(r.ports(), vec![42035], "must target the RECORD's port, never the configured one");
    }

    #[tokio::test]
    async fn no_siblings_arms_nothing_and_succeeds() {
        let r = Recorder::default();
        assert_eq!(arm_siblings(&[], r.call()).await.unwrap(), Vec::<String>::new());
        assert!(r.armed().is_empty());
    }

    #[tokio::test]
    async fn an_unreachable_sibling_refuses_and_names_itself() {
        let r = Recorder::default();
        let err = arm_siblings(&[rec("rel.elevated.high", 9, None, None)], r.call())
            .await
            .expect_err("an unarmable sibling must refuse");
        assert!(err.contains("rel.elevated.high"), "must name it: {err}");
    }

    /// **The ordering that matters.** The reachable sibling is FIRST, so an
    /// arm-as-you-go loop would arm it before discovering the second cannot be
    /// asked — leaving a stranger holding a window for an update that never ran.
    #[tokio::test]
    async fn refusal_is_all_or_nothing_and_arms_nothing_first() {
        let r = Recorder::default();
        let err = arm_siblings(
            &[
                rec("rel.alt", 41, Some(42035), Some("tok")),
                rec("rel.elevated.high", 9, None, None),
            ],
            r.call(),
        )
        .await
        .expect_err("must refuse");
        assert!(err.contains("rel.elevated.high"), "{err}");
        assert!(r.armed().is_empty(), "nothing may be armed before the check completes");
    }

    /// A failure part-way through must put back what it already touched.
    /// Asserted by COUNTING the disarm calls against the armed set — a
    /// final-state check cannot see a sibling left armed by an early return.
    #[tokio::test]
    async fn a_failing_arm_disarms_whatever_was_already_armed() {
        let r = Recorder::failing_on(2);
        let err = arm_siblings(
            &[
                rec("a", 1, Some(1001), Some("t")),
                rec("b", 2, Some(1002), Some("t")),
            ],
            r.call(),
        )
        .await
        .expect_err("must refuse");
        assert!(err.contains("b"), "{err}");
        assert_eq!(r.armed(), vec!["a".to_string(), "b".to_string()], "both were attempted");
        assert_eq!(
            r.disarmed(),
            vec!["a".to_string()],
            "the already-armed sibling must be released, not left holding a window"
        );
    }

    /// The failing sibling itself is NOT disarmed — it never armed, and calling
    /// disarm on it would report a spurious success for work never done.
    #[tokio::test]
    async fn the_sibling_that_failed_to_arm_is_not_disarmed() {
        let r = Recorder::failing_on(1);
        let _ = arm_siblings(&[rec("a", 1, Some(1001), Some("t"))], r.call()).await;
        assert!(r.disarmed().is_empty(), "nothing armed, so nothing to release");
    }

    #[test]
    fn the_action_paths_match_the_routes() {
        assert_eq!(Action::Arm.path(), "/api/hotswap/arm");
        assert_eq!(Action::Disarm.path(), "/api/hotswap/disarm");
    }
}
