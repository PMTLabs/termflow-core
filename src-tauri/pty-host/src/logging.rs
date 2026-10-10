//! The host's production `log` backend (plan 054 review 295 F2).
//!
//! The `log` macros are no-ops until a logger is installed, and nothing in this
//! binary installed one, so every `log::` line (the `[MCP-HOLD]` diagnostics,
//! `[CONPTY]`, `[FRAMELOOP]`, rejected-token warnings) was silently dropped.
//! This writes them to stderr, which the app already captures into the host log
//! (`pty_host_client`'s `host.log`) and which the elevated dial-out mode
//! redirects to its own file (`redirect_stdio_to`). No new dependency.

use log::{Level, LevelFilter, Log, Metadata, Record, SetLoggerError};
use std::fmt::Arguments;
use std::io::Write;

/// Info and above. `debug!`/`trace!` sites (for example the per-read pump
/// diagnostics in `pty-protocol`) stay off.
const LEVEL: LevelFilter = LevelFilter::Info;

struct StderrLogger;

static LOGGER: StderrLogger = StderrLogger;

/// One line, in the same `termflow-pty-host: ` voice as the host's `eprintln!`s.
fn format_line(level: Level, args: &Arguments<'_>) -> String {
    format!("termflow-pty-host: [{level}] {args}")
}

impl Log for StderrLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= LEVEL
    }

    fn log(&self, record: &Record<'_>) {
        if self.enabled(record.metadata()) {
            // Not `eprintln!`: it panics when stderr is closed, and a logger must not.
            let _ = writeln!(std::io::stderr().lock(), "{}", format_line(record.level(), record.args()));
        }
    }

    fn flush(&self) {}
}

/// Installs the stderr logger. `main` calls this before anything can log.
pub fn init_logging() -> Result<(), SetLoggerError> {
    log::set_logger(&LOGGER)?;
    log::set_max_level(LEVEL);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const PROBE_ENV: &str = "TERMFLOW_PTY_HOST_LOGGING_PROBE";
    const PROBE_TEST: &str = "logging::tests::init_logging_installs_a_logger_that_reaches_stderr";

    #[test]
    fn lines_say_who_and_how_serious() {
        assert_eq!(format_line(Level::Warn, &format_args!("[MCP-HOLD] hold rejected")), "termflow-pty-host: [WARN] [MCP-HOLD] hold rejected");
        assert_eq!(format_line(Level::Error, &format_args!("x")), "termflow-pty-host: [ERROR] x");
    }

    #[test]
    fn info_is_enabled_and_debug_is_not() {
        let at = |level| StderrLogger.enabled(&Metadata::builder().level(level).build());
        assert!(at(Level::Error) && at(Level::Warn) && at(Level::Info));
        assert!(!at(Level::Debug) && !at(Level::Trace));
    }

    /// The logger is process-global and other tests install their own capture
    /// logger, so the real `init_logging` is exercised in a fresh process: this
    /// same test binary, re-run on only this test.
    #[test]
    fn init_logging_installs_a_logger_that_reaches_stderr() {
        if std::env::var_os(PROBE_ENV).is_some() {
            init_logging().expect("no logger was installed yet");
            assert!(log::log_enabled!(log::Level::Info), "Info must be on after init_logging");
            assert!(!log::log_enabled!(log::Level::Debug), "Debug must stay off");
            log::warn!("[MCP-HOLD] probe line");
            log::debug!("probe debug line");
            return;
        }
        let out = Command::new(std::env::current_exe().expect("this test binary"))
            .args(["--exact", PROBE_TEST, "--nocapture", "--test-threads=1"])
            .env(PROBE_ENV, "1")
            .output()
            .expect("re-run this test binary");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "the probe process failed:\n{stderr}\n{}", String::from_utf8_lossy(&out.stdout));
        assert!(stderr.lines().any(|l| l == "termflow-pty-host: [WARN] [MCP-HOLD] probe line"), "{stderr}");
        assert!(!stderr.contains("probe debug line"), "{stderr}");
    }
}
