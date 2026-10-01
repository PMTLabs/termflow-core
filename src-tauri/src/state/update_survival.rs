//! Whether an update can leave the running pty-hosts alive.
//!
//! The updater swaps the whole install root and kills every process running
//! from inside it. A host that lives outside the root (the runtime directory)
//! survives that and can be offloaded; a host started from inside it cannot, and
//! a host whose origin could not be determined has to be assumed to be inside.
//! Either forces a full restart even when the release itself allows offloading.

use std::fmt;

/// How an update treats the terminals that are running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateMode {
    /// The hosts are armed and keep the shells alive across the swap.
    Offload,
    /// Everything is closed and the update is applied to a clean slate.
    Full,
}

/// Why an update has to be a full restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FullReason {
    /// The release says it cannot be offloaded from this version.
    Marker,
    /// The named host runs from inside the install root and would be killed.
    HostInPayload(String),
    /// Where the named host runs from could not be determined.
    HostOriginUnknown(String),
}

impl fmt::Display for FullReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FullReason::Marker => write!(f, "this release cannot be applied while terminals are kept running"),
            FullReason::HostInPayload(host) => {
                write!(f, "{host} runs from inside the application folder and would be closed by the update")
            }
            FullReason::HostOriginUnknown(host) => {
                write!(f, "it could not be determined where {host} runs from, so it may be closed by the update")
            }
        }
    }
}

/// Where one host runs from, as the lifecycle code collected it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostOrigin {
    pub name: String,
    /// `Some(true)` inside the install root, `Some(false)` outside, `None` unknown.
    pub exe_in_payload: Option<bool>,
}

/// The mode an update actually runs in: the release's own mode, forced to a full
/// restart by any host that cannot survive the swap. An unknown origin fails
/// closed. Hosts are reported in the order given, so a reason list is stable.
pub fn effective_mode(marker_mode: UpdateMode, hosts: &[HostOrigin]) -> (UpdateMode, Vec<FullReason>) {
    let mut reasons = Vec::new();
    if marker_mode == UpdateMode::Full {
        reasons.push(FullReason::Marker);
    }
    for host in hosts {
        match host.exe_in_payload {
            Some(false) => {}
            Some(true) => reasons.push(FullReason::HostInPayload(host.name.clone())),
            None => reasons.push(FullReason::HostOriginUnknown(host.name.clone())),
        }
    }
    let mode = if reasons.is_empty() { UpdateMode::Offload } else { UpdateMode::Full };
    (mode, reasons)
}

/// The reasons as one sentence for a refusal or a notice.
pub fn describe_reasons(reasons: &[FullReason]) -> String {
    reasons.iter().map(ToString::to_string).collect::<Vec<_>>().join("; ")
}
