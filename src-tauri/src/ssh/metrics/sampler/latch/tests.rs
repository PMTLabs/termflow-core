use super::*;
use crate::ssh::{
    metrics::sampler::{EventSink, MetricsEvent, State},
    session::{ExecOutput, SessionError},
};

const NONCE: &str = "0123456789abcdef0123456789abcdef";

fn completed(exit: u32, stdout: &[u8]) -> ExecOutcome {
    ExecOutcome {
        result: Ok(ExecOutput {
            exit,
            stdout: stdout.to_vec(),
            stderr: Vec::new(),
        }),
        cleanup_failure: None,
    }
}

#[test]
fn latch_trigger_table() {
    let framing = format!("banner\n__TFM_{NONCE}_V1_BEGIN__\r\n");
    let capture = include_bytes!("../../fixtures/windows.txt");
    for (exit, stdout, expected) in [
        (0, &b""[..], false),
        (1, &b"shell error"[..], true),
        (125, &b""[..], false),
        (126, &b""[..], true),
        (1, framing.as_bytes(), false),
        (1, &capture[..], false),
    ] {
        assert_eq!(should_probe_windows(exit, stdout), expected, "exit {exit}");
    }
    let failed = completed(1, b"");
    let first = Collector::FirstPosix;
    assert_eq!(first.read(&completed(125, b""), NONCE).1, Collector::Posix);
    assert_eq!(
        first.read(&completed(1, framing.as_bytes()), NONCE).1,
        Collector::Posix
    );
    let (reading, probe) = first.read(&failed, NONCE);
    assert!(matches!(
        reading,
        Reading::Unavailable("Metrics command failed")
    ));
    assert_eq!(probe, Collector::ProbeWindows);
    let (reading, fallback) = probe.read(&failed, NONCE);
    assert!(matches!(
        reading,
        Reading::Unavailable("Metrics command failed")
    ));
    assert_eq!(fallback, Collector::Posix);
    assert_eq!(fallback.read(&failed, NONCE).1, Collector::Posix);
    assert_eq!(
        probe.read(&SessionError::TimedOut.into(), NONCE).1,
        Collector::Posix
    );
    assert_eq!(
        probe.read(&completed(0, capture), NONCE).1,
        Collector::Windows
    );

    struct IgnoreEvents;
    impl EventSink for IgnoreEvents {
        fn emit(&self, _: &'static str, _: MetricsEvent<'_>) {}
    }
    let mut state = State::default();
    state.sync_generation("id", &IgnoreEvents, 1);
    for latched in [
        Collector::ProbeWindows,
        Collector::Windows,
        Collector::Posix,
    ] {
        state.collector = latched;
        let generation = state.generation.unwrap();
        state.sync_generation("id", &IgnoreEvents, generation);
        assert_eq!(state.collector, latched);
        state.sync_generation("id", &IgnoreEvents, generation + 1);
        assert_eq!(state.collector, first);
    }
}
