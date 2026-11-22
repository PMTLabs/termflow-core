//! The pure parts of the lifecycle rules: which mode an update runs in given where
//! the hosts run from, and what the retention of several hosts adds up to.

use super::*;

fn origin(name: &str, exe_in_payload: Option<bool>) -> HostOrigin {
    HostOrigin { name: name.into(), exe_in_payload }
}

#[test]
fn host_in_payload_or_unknown_forces_full_with_reason() {
    let hosts = [origin("safe", Some(false)), origin("inside", Some(true)), origin("mystery", None)];
    let (mode, reasons) = effective_mode(UpdateMode::Offload, &hosts);
    assert_eq!(mode, UpdateMode::Full, "an unmarked release is still a full restart when a host cannot survive");
    assert_eq!(
        reasons,
        vec![FullReason::HostInPayload("inside".into()), FullReason::HostOriginUnknown("mystery".into())],
        "each reason names its own host, the safe one is not named, and an unknown origin fails closed"
    );
}

#[test]
fn an_unknown_origin_alone_forces_full() {
    let (mode, reasons) = effective_mode(UpdateMode::Offload, &[origin("only", None)]);
    assert_eq!((mode, reasons), (UpdateMode::Full, vec![FullReason::HostOriginUnknown("only".into())]));
}

#[test]
fn the_marker_and_a_host_both_count() {
    let (mode, reasons) = effective_mode(UpdateMode::Full, &[origin("inside", Some(true))]);
    assert_eq!(mode, UpdateMode::Full);
    assert_eq!(reasons, vec![FullReason::Marker, FullReason::HostInPayload("inside".into())]);
}

#[test]
fn the_marker_alone_forces_full_even_when_every_host_is_safe() {
    let (mode, reasons) = effective_mode(UpdateMode::Full, &[origin("a", Some(false)), origin("b", Some(false))]);
    assert_eq!((mode, reasons), (UpdateMode::Full, vec![FullReason::Marker]));
}

#[test]
fn safe_hosts_and_no_marker_stay_offload() {
    let (mode, reasons) = effective_mode(UpdateMode::Offload, &[origin("a", Some(false)), origin("b", Some(false))]);
    assert_eq!((mode, reasons), (UpdateMode::Offload, vec![]));
    let (mode, reasons) = effective_mode(UpdateMode::Offload, &[]);
    assert_eq!((mode, reasons), (UpdateMode::Offload, vec![]), "no host at all adds no reason");
}

#[test]
fn the_refusal_text_carries_every_reason_by_host_name() {
    let hosts = [origin("terminal host A", Some(true)), origin("terminal host B", None)];
    let reasons = effective_mode(UpdateMode::Offload, &hosts).1;
    let text = describe_reasons(&reasons);
    assert!(text.contains("terminal host A") && text.contains("terminal host B"), "{text}");
}

fn bounded(secs: u64) -> HostRetention {
    HostRetention::Bounded { active_secs: secs }
}

#[test]
fn retention_ordering() {
    use HostRetention::{Indefinite, Unknown};
    assert_eq!(worst_retention([Indefinite, Indefinite]), Indefinite);
    assert_eq!(worst_retention([Indefinite, bounded(900)]), bounded(900), "bounded is worse than indefinite");
    assert_eq!(worst_retention([bounded(900), Indefinite]), bounded(900), "whichever order they come in");
    assert_eq!(worst_retention([bounded(900), bounded(60), bounded(300)]), bounded(60), "the shortest bound");
    assert_eq!(worst_retention([Indefinite, bounded(900), Unknown]), Unknown, "unknown beats everything");
    assert_eq!(worst_retention([Unknown, Indefinite]), Unknown);
    assert_eq!(worst_retention([]), Unknown, "no host promises nothing, which is not indefinite");
}
