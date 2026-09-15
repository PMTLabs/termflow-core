//! Self-relaunch mechanics for webview-death recovery (plan 044) and the tray
//! "Restart, keep terminals" item: spawn a successor process and hand off
//! across our own `exit(0)`, then have the successor wait out our pid before
//! it takes the single-instance lock.
//!
//! The pure pieces (`relaunch_argv`, `wait_for_pid_exit`) are unit-tested
//! directly; the impure edges (`std::process::Command`, `sysinfo`) are thin
//! wrappers around them so the logic itself needs no live process to exercise.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Marks a relaunched process's argv so the new instance knows which
/// predecessor pid to wait out (see `wait_for_predecessor`).
pub const RELAUNCH_FLAG: &str = "--relaunch-after";

/// Build the argv (WITHOUT argv[0]) for the successor process: `existing`
/// with any previous `--relaunch-after` (either `--relaunch-after <x>` or
/// `--relaunch-after=<x>`) scrubbed, then our own pid inserted. Everything
/// else is preserved in order (profile, ports, headless, …).
///
/// The scrub matters for a crash loop: relaunching a relaunch must not chain
/// a stale `--relaunch-after` pointing at a pid long gone, nor leave two
/// copies of the flag for clap to choke on.
///
/// A `--` ends the options: nothing after it is scrubbed (a positional path
/// that happens to be spelled `--relaunch-after` is a path), and the new pair
/// goes BEFORE it — appended after `--` it would be a second positional, and
/// clap would refuse to start the successor at all.
pub fn relaunch_argv(existing: &[String], our_pid: u32) -> Vec<String> {
    let mut out = Vec::with_capacity(existing.len() + 2);
    let mut i = 0;
    while i < existing.len() {
        let arg = &existing[i];
        if arg == "--" {
            break;
        }
        if arg == RELAUNCH_FLAG {
            // Drop the flag and its value, if a value follows. A `--` is never
            // the value (clap would not have parsed it as one).
            let has_value = i + 1 < existing.len() && existing[i + 1] != "--";
            i += if has_value { 2 } else { 1 };
            continue;
        }
        if arg.starts_with(&format!("{RELAUNCH_FLAG}=")) {
            i += 1;
            continue;
        }
        out.push(arg.clone());
        i += 1;
    }
    out.push(RELAUNCH_FLAG.to_string());
    out.push(our_pid.to_string());
    // The terminator and every positional after it, verbatim.
    out.extend(existing[i..].iter().cloned());
    out
}

/// Spawn a successor `termflow.exe` with our own argv (minus any stale
/// `--relaunch-after`) plus `--relaunch-after <our pid>`. Does not wait on the
/// child — it must outlive this process, which is about to exit — and keeps
/// default stdio.
pub fn spawn_relaunch() -> Result<u32, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let args = relaunch_argv(
        &std::env::args().skip(1).collect::<Vec<_>>(),
        std::process::id(),
    );
    let child = std::process::Command::new(exe)
        .args(&args)
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;
    Ok(child.id())
}

/// The result of waiting for a predecessor process to exit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitOutcome {
    Exited { waited: Duration },
    TimedOut { waited: Duration },
}

/// Poll `alive` until it reports false or `timeout` elapses, sleeping `tick`
/// between checks.
///
/// Checks BEFORE the first sleep: a predecessor that is already gone by the
/// time we look must cost nothing, not one wasted `tick`.
pub fn wait_for_pid_exit(
    mut alive: impl FnMut() -> bool,
    timeout: Duration,
    tick: Duration,
) -> WaitOutcome {
    let start = Instant::now();
    loop {
        if !alive() {
            return WaitOutcome::Exited {
                waited: start.elapsed(),
            };
        }
        let waited = start.elapsed();
        if waited >= timeout {
            return WaitOutcome::TimedOut { waited };
        }
        std::thread::sleep(tick);
    }
}

/// How long a relaunched instance waits for its predecessor to exit before
/// taking the single-instance lock.
///
/// This is a ceiling, not a delay — the wait returns the moment the pid is
/// gone. It has to outlast the predecessor's `RunEvent::Exit`, which flushes
/// every terminal's scrollback (`flush_all_history`, up to 30 s) and shuts two
/// sidecars down before the mutex is released. A ceiling that expires while
/// the mutex is still held is the worst outcome available: the successor
/// relays its argv to a process that is about to die and exits itself — no
/// TermFlow process at all, with the pty-host holding every shell for its
/// 15-minute window. So the ceiling is deliberately far beyond any plausible
/// exit; it exists only so a predecessor that has wedged for good does not
/// leave an invisible successor waiting forever.
const RELAUNCH_WAIT: Duration = Duration::from_secs(300);
const RELAUNCH_TICK: Duration = Duration::from_millis(100);

/// The one-line summary of the last `wait_for_predecessor` call, replayed once
/// logging is live (`replay_outcome`).
///
/// `run()` calls `wait_for_predecessor` immediately after parsing `Args`,
/// which is before `tauri_plugin_log` installs a logger — anything logged
/// directly there goes to the `log` crate's no-op default and is lost. Mirrors
/// `gpu_preference::RESOLUTION` / `log_resolution` for the same reason.
static OUTCOME: OnceLock<String> = OnceLock::new();

/// Is the process found at the predecessor's pid still the predecessor?
///
/// Windows recycles pids quickly, so "the pid exists" is not identity. Two
/// more facts pin it: the name must start with `termflow` (case-insensitive;
/// an unrelated process that inherited the pid must not make us wait out the
/// full ceiling), and it must have STARTED NO LATER THAN WE DID — our
/// predecessor spawned us, so any TermFlow process that appeared at that pid
/// after our own start is a different generation, not the one we are waiting
/// for. `sysinfo` reports start times in whole seconds, so a reuse inside
/// the same second as our own start is the one case this still waits on.
pub fn is_predecessor(name: &str, its_start_secs: u64, our_start_secs: u64) -> bool {
    name.to_ascii_lowercase().starts_with("termflow") && its_start_secs <= our_start_secs
}

/// Wait (≤ `RELAUNCH_WAIT`) for `pid` — our predecessor in a self-relaunch —
/// to exit before this process takes the single-instance lock, so we do not
/// relay to a process that is on its way out and vanish along with it.
///
/// `alive` is `is_predecessor` over a fresh `sysinfo` probe each tick: the
/// wait ends the moment the pid is gone, renamed, or reused by a process
/// younger than we are.
pub fn wait_for_predecessor(pid: u32) {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let mut sys = System::new();
    let target = Pid::from_u32(pid);
    let ours = Pid::from_u32(std::process::id());
    sys.refresh_processes(ProcessesToUpdate::Some(&[ours]), true);
    // If our own start time is unavailable, accept any start time rather
    // than treat the real predecessor as gone (the wait would then be a
    // no-op and we would relay to it and vanish — the failure this wait
    // exists to prevent).
    let our_start = sys.process(ours).map(|p| p.start_time()).unwrap_or(u64::MAX);
    let alive = || {
        sys.refresh_processes(ProcessesToUpdate::Some(&[target]), true);
        sys.process(target)
            .map(|p| is_predecessor(&p.name().to_string_lossy(), p.start_time(), our_start))
            .unwrap_or(false)
    };
    let outcome = wait_for_pid_exit(alive, RELAUNCH_WAIT, RELAUNCH_TICK);
    let line = match outcome {
        WaitOutcome::Exited { waited } => {
            format!("waited {} ms for predecessor pid {pid}: exited", waited.as_millis())
        }
        WaitOutcome::TimedOut { waited } => {
            // A timeout means the predecessor still holds the single-instance
            // mutex: the lock plugin will relay to it and exit this process
            // before any logger exists, so `replay_outcome` never runs. stderr
            // is the only channel left.
            let line = format!("waited {} ms for predecessor pid {pid}: timed out", waited.as_millis());
            eprintln!("TermFlow: [RECOVERY] {line}");
            line
        }
    };
    let _ = OUTCOME.set(line);
}

/// Log the outcome of `wait_for_predecessor`, if it ran this launch. Call from
/// the app `setup` closure, right after logging is live (see
/// `gpu_preference::log_resolution` for the identical pattern).
pub fn replay_outcome() {
    if let Some(line) = OUTCOME.get() {
        log::info!("[RECOVERY] {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bare trailing `--relaunch-after` (value missing — a hand-typed or
    /// truncated argv) must be dropped, not carried forward as a dangling flag
    /// that clap would then reject on the successor.
    #[test]
    fn relaunch_argv_drops_a_trailing_bare_flag() {
        let existing = vec!["--profile".to_string(), "work".to_string(), "--relaunch-after".to_string()];
        assert_eq!(
            relaunch_argv(&existing, 7),
            vec!["--profile", "work", "--relaunch-after", "7"]
        );
    }


    /// `termflow.exe -- <path>` is a valid launch. The pair must land BEFORE
    /// the terminator (after it, clap reads it as a second positional and the
    /// successor fails to parse), and a positional that merely looks like the
    /// flag is a path, not a stale option.
    #[test]
    fn relaunch_argv_keeps_the_terminator_and_everything_after_it() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            relaunch_argv(&s(&["--", "C:\\proj"]), 7),
            vec!["--relaunch-after", "7", "--", "C:\\proj"]
        );
        assert_eq!(
            relaunch_argv(&s(&["--profile", "work", "--", "--relaunch-after"]), 7),
            vec!["--profile", "work", "--relaunch-after", "7", "--", "--relaunch-after"],
            "a positional spelled like the flag is a path and must survive"
        );
        assert_eq!(
            relaunch_argv(&s(&["--relaunch-after", "99", "--", "--relaunch-after=99"]), 7),
            vec!["--relaunch-after", "7", "--", "--relaunch-after=99"],
            "the stale pair before `--` is scrubbed; the same spelling after it is kept"
        );
        assert_eq!(
            relaunch_argv(&s(&["--relaunch-after", "--", "x"]), 7),
            vec!["--relaunch-after", "7", "--", "x"],
            "a bare flag must not swallow the terminator as its value"
        );
    }

    #[test]
    fn is_predecessor_requires_the_name_and_an_older_or_equal_start() {
        assert!(is_predecessor("termflow.exe", 100, 100));
        assert!(is_predecessor("TermFlow.exe", 99, 100));
        assert!(is_predecessor("termflow", 1, 100));
        assert!(
            !is_predecessor("termflow.exe", 101, 100),
            "a TermFlow process younger than us at that pid is a reused pid, not our predecessor"
        );
        assert!(!is_predecessor("explorer.exe", 1, 100));
        assert!(!is_predecessor("", 1, 100));
        assert!(
            is_predecessor("termflow.exe", 101, u64::MAX),
            "unknown own start time must accept any start (wait, never skip)"
        );
    }

    #[test]
    fn relaunch_argv_appends_the_pair() {
        let existing = vec!["--profile".to_string(), "work".to_string()];
        let out = relaunch_argv(&existing, 4242);
        assert_eq!(out, vec!["--profile", "work", "--relaunch-after", "4242"]);
    }

    #[test]
    fn relaunch_argv_drops_a_stale_relaunch_after_pair() {
        let existing = vec![
            "--profile".to_string(),
            "work".to_string(),
            "--relaunch-after".to_string(),
            "99".to_string(),
        ];
        let out = relaunch_argv(&existing, 4242);
        assert_eq!(
            out,
            vec!["--profile", "work", "--relaunch-after", "4242"],
            "must not chain a stale --relaunch-after from a crash loop"
        );
    }

    #[test]
    fn relaunch_argv_drops_the_equals_form() {
        let existing = vec!["--relaunch-after=99".to_string(), "--headless".to_string()];
        let out = relaunch_argv(&existing, 4242);
        assert_eq!(out, vec!["--headless", "--relaunch-after", "4242"]);
    }

    #[test]
    fn relaunch_argv_preserves_order_of_everything_else() {
        let existing = vec![
            "--profile".to_string(),
            "work".to_string(),
            "--headless".to_string(),
        ];
        let out = relaunch_argv(&existing, 7);
        assert_eq!(
            out,
            vec!["--profile", "work", "--headless", "--relaunch-after", "7"]
        );
    }

    #[test]
    fn wait_for_pid_exit_returns_exited_immediately_when_already_dead() {
        let tick = Duration::from_millis(50);
        let mut probes = 0u32;
        let outcome = wait_for_pid_exit(
            || {
                probes += 1;
                false
            },
            Duration::from_secs(5),
            tick,
        );
        match outcome {
            WaitOutcome::Exited { waited } => {
                assert_eq!(probes, 1, "must probe exactly once before returning");
                // `waited < tick` alone let a sleep of up to `tick` (e.g. a
                // sleep-before-first-probe bug) still pass; the probe is a
                // closure that returns immediately, so nothing should cost
                // more than a handful of microseconds.
                assert!(
                    waited < Duration::from_millis(5),
                    "must not have slept at all: {waited:?}"
                );
            }
            other => panic!("expected Exited, got {other:?}"),
        }
    }

    #[test]
    fn wait_for_pid_exit_returns_exited_once_alive_flips_false() {
        let mut calls = 0;
        let outcome = wait_for_pid_exit(
            || {
                calls += 1;
                calls < 3
            },
            Duration::from_secs(5),
            Duration::from_millis(5),
        );
        assert!(matches!(outcome, WaitOutcome::Exited { .. }));
        assert_eq!(calls, 3, "must have checked on the 3rd call before returning");
    }

    #[test]
    fn wait_for_pid_exit_times_out_when_alive_never_flips() {
        let timeout = Duration::from_millis(60);
        let tick = Duration::from_millis(10);
        let mut probes = 0u32;
        let started = Instant::now();
        let outcome = wait_for_pid_exit(
            || {
                probes += 1;
                true
            },
            timeout,
            tick,
        );
        // `waited >= timeout` alone let a multi-second wait for a 60 ms
        // timeout still pass; also bound it from above (with CI slack) and
        // bound the number of probes actually taken.
        match outcome {
            WaitOutcome::TimedOut { waited } => {
                assert!(waited >= timeout);
                assert!(
                    waited < timeout + 2 * tick + Duration::from_millis(50),
                    "must not wait far longer than the timeout: {waited:?}"
                );
            }
            other => panic!("expected TimedOut, got {other:?}"),
        }
        let elapsed = started.elapsed();
        assert!(elapsed >= timeout);
        assert!(
            elapsed < timeout + 2 * tick + Duration::from_millis(250),
            "wall-clock must not run far longer than the timeout (CI slack allowed): {elapsed:?}"
        );
        let max_probes = (timeout.as_millis() / tick.as_millis()) as u32 + 2;
        assert!(
            probes >= 2 && probes <= max_probes,
            "expected a bounded number of probes (2..={max_probes}), got {probes}"
        );
    }
}
