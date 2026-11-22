//! The wait message the holder gives agents (plan 054 §4.5, AC4/AC5).
//!
//! A pure function: the same inputs always give the same text, so the holder
//! can compute it per request from its clock without any state.

use super::Mode;
use std::time::Duration;
use termflow_pty_protocol::McpHoldReason;

/// Active time after which the wording changes from "restarting" to "has not
/// been reopened yet". The host tears the shells down at 900 s of active time,
/// so 600 s leaves the agent a final ten-minute warning.
pub const LATE_AFTER_SECS: u64 = 600;

fn reason_phrase(reason: McpHoldReason) -> &'static str {
    match reason {
        McpHoldReason::Offload => "Offload & Close",
        McpHoldReason::OffloadUpdate => "update",
        McpHoldReason::Relaunch => "restart",
    }
}

/// `2m10s`, `11m05s`; under a minute just `45s`.
fn format_elapsed(d: Duration) -> String {
    let secs = d.as_secs();
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m{:02}s", secs / 60, secs % 60)
    }
}

/// ` in about 3 minutes`, ` in less than a minute`, or nothing when the host
/// has no established deadline.
fn closed_in_phrase(remaining: Option<Duration>) -> String {
    match remaining.map(|r| r.as_secs() / 60) {
        None => String::new(),
        Some(0) => " in less than a minute".to_string(),
        Some(1) => " in about 1 minute".to_string(),
        Some(n) => format!(" in about {n} minutes"),
    }
}

/// The text of the tool-call error and of the `-32000` error.
///
/// - `elapsed` is the active time since the holder started; `None` when the
///   clock could not be sampled, in which case the time is left out of the
///   text (plan §4.4 "Clock failures").
/// - `remaining` is the host's current deadline minus now, saturating at zero;
///   `None` when no deadline is established, which omits the "closed in" phrase.
/// - `Mode::Stop` is never answered (connections are closed on stop); it reads
///   as `Absent` so the function stays total.
pub fn wait_message(
    mode: Mode,
    reason: McpHoldReason,
    elapsed: Option<Duration>,
    remaining: Option<Duration>,
) -> String {
    let why = reason_phrase(reason);
    match mode {
        Mode::Handback => match elapsed {
            Some(e) => format!(
                "TermFlow is starting again after {why} ({}). Your terminals are still running. \
                 Retry this call in a few seconds.",
                format_elapsed(e)
            ),
            None => format!(
                "TermFlow is starting again after {why}. Your terminals are still running. \
                 Retry this call in a few seconds."
            ),
        },
        Mode::Absent | Mode::Stop => match elapsed {
            Some(e) if e.as_secs() >= LATE_AFTER_SECS => format!(
                "TermFlow has not been reopened yet ({why}, {} ago). Your terminals are still \
                 running but will be closed{} unless TermFlow is reopened. Retry later; do not \
                 recreate terminals.",
                format_elapsed(e),
                closed_in_phrase(remaining)
            ),
            Some(e) => format!(
                "TermFlow is restarting ({why}, {} ago). Your terminals are still running. Wait \
                 about 30 seconds and retry this call. Do not recreate terminals; they will be \
                 reattached when TermFlow is back.",
                format_elapsed(e)
            ),
            None => format!(
                "TermFlow is restarting ({why}). Your terminals are still running. Wait about \
                 30 seconds and retry this call. Do not recreate terminals; they will be \
                 reattached when TermFlow is back."
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn secs(s: u64) -> Option<Duration> {
        Some(Duration::from_secs(s))
    }

    fn absent(reason: McpHoldReason, elapsed: Option<u64>, remaining: Option<u64>) -> String {
        wait_message(Mode::Absent, reason, elapsed.map(Duration::from_secs), remaining.map(Duration::from_secs))
    }

    #[test]
    fn wording_switches_at_exactly_600_seconds() {
        use McpHoldReason::Offload;
        let early = |ago: &str| {
            format!(
                "TermFlow is restarting (Offload & Close, {ago} ago). Your terminals are still \
                 running. Wait about 30 seconds and retry this call. Do not recreate terminals; \
                 they will be reattached when TermFlow is back."
            )
        };
        let late = |ago: &str, closed: &str| {
            format!(
                "TermFlow has not been reopened yet (Offload & Close, {ago} ago). Your terminals \
                 are still running but will be closed{closed} unless TermFlow is reopened. Retry \
                 later; do not recreate terminals."
            )
        };

        assert_eq!(absent(Offload, Some(0), Some(900)), early("0s"));
        assert_eq!(absent(Offload, Some(130), Some(770)), early("2m10s"));
        assert_eq!(absent(Offload, Some(599), Some(301)), early("9m59s"));
        // The remaining time is irrelevant before the switch.
        assert_eq!(absent(Offload, Some(599), None), early("9m59s"));
        assert_eq!(absent(Offload, Some(600), Some(300)), late("10m00s", " in about 5 minutes"));
        assert_eq!(absent(Offload, Some(665), Some(235)), late("11m05s", " in about 3 minutes"));
        assert_eq!(absent(Offload, Some(665), Some(420)), late("11m05s", " in about 7 minutes"));
        assert_eq!(absent(Offload, Some(899), Some(1)), late("14m59s", " in less than a minute"));
        assert_eq!(absent(Offload, Some(900), Some(0)), late("15m00s", " in less than a minute"));
        assert_eq!(absent(Offload, Some(665), None), late("11m05s", ""));
        // Minutes are floored, and one minute is singular.
        assert_eq!(absent(Offload, Some(700), Some(119)), late("11m40s", " in about 1 minute"));
        assert_eq!(absent(Offload, Some(700), Some(59)), late("11m40s", " in less than a minute"));
        assert_eq!(absent(Offload, Some(700), Some(60)), late("11m40s", " in about 1 minute"));
    }

    #[test]
    fn each_reason_has_its_own_wording() {
        let early = |reason, why: &str| {
            assert_eq!(
                absent(reason, Some(130), Some(770)),
                format!(
                    "TermFlow is restarting ({why}, 2m10s ago). Your terminals are still running. \
                     Wait about 30 seconds and retry this call. Do not recreate terminals; they \
                     will be reattached when TermFlow is back."
                )
            );
        };
        early(McpHoldReason::Offload, "Offload & Close");
        early(McpHoldReason::OffloadUpdate, "update");
        early(McpHoldReason::Relaunch, "restart");

        let late = |reason, why: &str| {
            assert_eq!(
                absent(reason, Some(665), Some(235)),
                format!(
                    "TermFlow has not been reopened yet ({why}, 11m05s ago). Your terminals are \
                     still running but will be closed in about 3 minutes unless TermFlow is \
                     reopened. Retry later; do not recreate terminals."
                )
            );
        };
        late(McpHoldReason::Offload, "Offload & Close");
        late(McpHoldReason::OffloadUpdate, "update");
        late(McpHoldReason::Relaunch, "restart");

        let handback = |reason, why: &str| {
            assert_eq!(
                wait_message(Mode::Handback, reason, secs(206), secs(500)),
                format!(
                    "TermFlow is starting again after {why} (3m26s). Your terminals are still \
                     running. Retry this call in a few seconds."
                )
            );
        };
        handback(McpHoldReason::Offload, "Offload & Close");
        handback(McpHoldReason::OffloadUpdate, "update");
        handback(McpHoldReason::Relaunch, "restart");
    }

    #[test]
    fn handback_wording_keeps_reason_elapsed_and_terminals() {
        // The exact example from the plan.
        assert_eq!(
            wait_message(Mode::Handback, McpHoldReason::Offload, secs(206), secs(694)),
            "TermFlow is starting again after Offload & Close (3m26s). Your terminals are still \
             running. Retry this call in a few seconds."
        );
        // Handback never switches to the late wording, however long it has been.
        assert_eq!(
            wait_message(Mode::Handback, McpHoldReason::Relaunch, secs(899), secs(1)),
            "TermFlow is starting again after restart (14m59s). Your terminals are still \
             running. Retry this call in a few seconds."
        );
        // Under a minute reads as seconds only.
        assert_eq!(
            wait_message(Mode::Handback, McpHoldReason::OffloadUpdate, secs(5), None),
            "TermFlow is starting again after update (5s). Your terminals are still running. \
             Retry this call in a few seconds."
        );
    }

    #[test]
    fn unknown_elapsed_omits_the_time() {
        assert_eq!(
            wait_message(Mode::Absent, McpHoldReason::Offload, None, secs(100)),
            "TermFlow is restarting (Offload & Close). Your terminals are still running. Wait \
             about 30 seconds and retry this call. Do not recreate terminals; they will be \
             reattached when TermFlow is back."
        );
        assert_eq!(
            wait_message(Mode::Handback, McpHoldReason::Offload, None, secs(100)),
            "TermFlow is starting again after Offload & Close. Your terminals are still running. \
             Retry this call in a few seconds."
        );
    }
}
