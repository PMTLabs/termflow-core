//! Process-wide panic hook.
//!
//! Installs a global hook that records the panic's message, location, and a
//! backtrace via `log` (so it lands in TermFlow.log) *before* delegating to the
//! previous hook (which prints to stderr). This does NOT prevent the crash — a
//! panic still unwinds/aborts — but it turns "silent death with an empty log"
//! into an actionable record.
//!
//! Note on scope: this only helps for Rust *panics*. Native/FFI memory faults
//! (heap corruption, access violations) are OS fail-fasts that bypass every
//! user-mode handler and cannot be logged here — those are guarded against by
//! the release smoke test (`scripts/smoke-test-release.mjs`) and by preferring
//! safe wrappers over hand-rolled `unsafe`.

use std::any::Any;

/// Extract a human-readable message from a panic payload.
///
/// `panic!("literal")` yields a `&str` payload; `panic!("{x}")` and
/// `.expect(String)` yield a `String`. Anything else (a non-string
/// `panic_any`) has no textual form, so we label it rather than guess.
fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Compose the single-line-prefixed report that gets logged. Kept pure (no
/// `PanicHookInfo`, no globals) so it is directly unit-testable.
fn format_report(location: Option<String>, message: &str, backtrace: &str) -> String {
    let location = location.unwrap_or_else(|| "<unknown location>".to_string());
    format!("panic at {location}: {message}\n{backtrace}")
}

/// Install the global panic hook. Idempotent-safe to call more than once: each
/// call chains the hook that was previously installed, so no report is lost.
///
/// Call this as the very first thing in `run()` — before any work that could
/// panic — so a panic during startup is still captured.
pub fn install() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        let message = panic_message(info.payload());
        // force_capture() ignores RUST_BACKTRACE so we always get frames, even
        // in a release build launched by a double-click.
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        log::error!("{}", format_report(location, &message, &backtrace));
        // Chain the previous hook (default = stderr) so behaviour is additive.
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_from_str_payload() {
        let payload: Box<dyn Any + Send> = Box::new("boom");
        assert_eq!(panic_message(&*payload), "boom");
    }

    #[test]
    fn message_from_string_payload() {
        let payload: Box<dyn Any + Send> = Box::new(String::from("kaboom {details}"));
        assert_eq!(panic_message(&*payload), "kaboom {details}");
    }

    #[test]
    fn message_from_non_string_payload_is_labeled() {
        let payload: Box<dyn Any + Send> = Box::new(42u32);
        assert_eq!(panic_message(&*payload), "<non-string panic payload>");
    }

    #[test]
    fn report_includes_location_message_and_backtrace() {
        let report = format_report(Some("src/foo.rs:12:5".to_string()), "boom", "BT-FRAMES");
        assert!(report.contains("src/foo.rs:12:5"), "location missing: {report}");
        assert!(report.contains("boom"), "message missing: {report}");
        assert!(report.contains("BT-FRAMES"), "backtrace missing: {report}");
    }

    #[test]
    fn report_falls_back_when_location_unknown() {
        let report = format_report(None, "boom", "BT");
        assert!(report.contains("<unknown location>"), "fallback missing: {report}");
    }
}
