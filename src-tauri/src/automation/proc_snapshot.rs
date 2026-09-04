//! One shared process snapshot for the Automations feature.
//!
//! A `System` behind a mutex with `taken_at` and a 2 s TTL, built inside `spawn_blocking` because
//! `System::new_all()` is 50-200 ms of blocking work and `list_watchable_terminals` is an `async`
//! command. Taken only when at least one enabled rule needs it, mirroring `AgentSchemeTracker.tick()`.
//!
//! It exists because the alternative was three full process enumerations every ~2 s: this feature's
//! own tick plus one `AgentSchemeTracker` per open window. **Only the Automations feature draws from
//! it today** — the targeting tick and the picker — and that is half of plan §4.4's settled ruling
//! (decision 11, ONE shared poll). `get_active_processes` in `api_server.rs` and `AgentSchemeTracker`
//! still enumerate independently, so the situation the ruling exists to prevent is not yet gone; what
//! this module guarantees is that Automations did not make it a fourth. Threading the other two
//! through is M2 residue, tracked as its own item rather than smuggled into a feature commit.
//!
//! **Generic over the payload so the TTL can be tested without enumerating the machine's processes.**
//! A test that had to take a real snapshot to prove the cache works would be measuring the OS, not the
//! cache.

use std::sync::Mutex;

use crate::automation_store::Criterion;

/// How long one scan stands in for the world. Matches `AgentSchemeTracker`'s own poll interval, which
/// is the other thing enumerating processes on this cadence.
pub const SNAPSHOT_TTL_MS: i64 = 2_000;

struct Entry<T> {
    value: T,
    taken_at_ms: i64,
}

/// A value rebuilt at most once per TTL window, shared by every caller in that window.
pub struct ProcSnapshot<T> {
    ttl_ms: i64,
    inner: Mutex<Option<Entry<T>>>,
}

/// The production instantiation.
pub type SystemSnapshot = ProcSnapshot<sysinfo::System>;

impl<T> ProcSnapshot<T> {
    pub fn new(ttl_ms: i64) -> Self {
        Self { ttl_ms, inner: Mutex::new(None) }
    }

    /// Run `f` against a snapshot no older than the TTL, building one with `build` only if the cached
    /// one has expired.
    ///
    /// **`build` runs while the mutex is held**, which is deliberate: the alternative is two callers
    /// arriving in the same window and both paying `System::new_all()`, which is the exact cost this
    /// type exists to remove. The whole call belongs inside `spawn_blocking` at the `AppState` layer —
    /// `System::new_all()` is 50-200 ms and would otherwise stall a tokio worker.
    pub fn with<R>(&self, now_ms: i64, build: impl FnOnce() -> T, f: impl FnOnce(&T) -> R) -> R {
        // A poisoned lock here means a previous `build` panicked. The cached value is still readable
        // and rebuilding is safe, so recover rather than propagating a panic into the evaluation loop.
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = guard.as_ref().is_some_and(|e| {
            // A NEGATIVE age is not freshness, which is why this is a plain `-` inside a range
            // check and NOT `saturating_sub`: that saturates at `i64::MIN`, not at zero, so a wall
            // clock that moved backwards (an NTP correction, or a resume — both of which this app
            // already handles) would read as freshly taken, pinning one snapshot for the length of
            // the correction while every `Command contains` rule matched the world as it was.
            let age = now_ms - e.taken_at_ms;
            (0..self.ttl_ms).contains(&age)
        });
        if !fresh {
            *guard = Some(Entry { value: build(), taken_at_ms: now_ms });
        }
        // `fresh` is true or we just wrote one, so this is always `Some`; the `match` avoids an
        // `unwrap` on a path that runs every evaluation tick.
        match guard.as_ref() {
            Some(entry) => f(&entry.value),
            None => unreachable!("a snapshot was just built"),
        }
    }

    /// When the held snapshot was taken, for callers that report staleness.
    pub fn taken_at_ms(&self) -> Option<i64> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|e| e.taken_at_ms)
    }
}

impl<T> Default for ProcSnapshot<T> {
    fn default() -> Self {
        Self::new(SNAPSHOT_TTL_MS)
    }
}

/// The same question as `scan_needed`, asked of the roster the caller already holds.
///
/// `scan_needed` is pure and well tested; the PREDICATE that fed it was a `rows.iter().any(..)` inside
/// `AppState`'s `EngineHost` impl, which §7.10 says is the one place a gate cannot be reached by a
/// test on Windows. Writing `.all()` there left all eight of `scan_needed`'s assertions passing while
/// `Working folder is under` silently stopped matching every terminal with no OSC cwd — which is the
/// exact fallback that criterion exists for. The adapter now has no predicate of its own.
pub fn scan_needed_for(
    criteria: impl IntoIterator<Item = Criterion>,
    rows: &[crate::automation::roster::RosterRow],
) -> bool {
    scan_needed(criteria, rows.iter().any(|r| r.cwd.is_none()))
}

/// Does anything actually need a process scan this tick?
///
/// The idle gate, mirroring `AgentSchemeTracker.tick()`. Only two criteria can want one, and only one
/// of them always does:
///
/// - `Command contains` reads the command line of every process on the terminal's foreground chain,
///   which exists only in a scan.
/// - `Working folder is under` prefers the OSC cwd and falls back to the process cwd, so it wants a
///   scan **only** when some rostered terminal has not reported one.
///
/// The other three are answered from `state.terminals` alone. A profile whose only enabled rule is
/// `Terminal ID is` must never enumerate the machine's processes.
pub fn scan_needed(criteria: impl IntoIterator<Item = Criterion>, any_missing_cwd: bool) -> bool {
    criteria.into_iter().any(|c| match c {
        Criterion::CommandContains => true,
        Criterion::WorkingFolderUnder => any_missing_cwd,
        Criterion::TabNameContains | Criterion::TerminalIdIs | Criterion::AllTerminals => false,
    })
}

#[cfg(test)]
mod predicate_tests {
    use super::*;
    use crate::automation::roster::RosterRow;

    fn row(cwd: Option<&str>) -> RosterRow {
        RosterRow {
            terminal_id: Some("tm-1".into()),
            process_id: "pc-1".into(),
            name: "Terminal-powershell".into(),
            shell: "powershell".into(),
            pid: 1,
            display_label: None,
            cwd: cwd.map(str::to_string),
            command_lines: Vec::new(),
        }
    }

    /// §10.13's predicate, which used to live inside `AppState` where no Windows test can reach it.
    ///
    /// `.any()` written as `.all()` leaves every one of `scan_needed`'s own assertions passing while
    /// `Working folder is under` stops matching every terminal with no OSC cwd — which is the exact
    /// fallback that criterion exists for. Both directions are here, because "one terminal is missing
    /// its cwd" and "every terminal is" have to give different answers for the bug to be visible.
    #[test]
    fn the_cwd_fallback_is_needed_when_any_terminal_lacks_one() {
        let some_missing = [row(Some("D:/a")), row(None)];
        let none_missing = [row(Some("D:/a")), row(Some("D:/b"))];

        assert!(
            scan_needed_for([Criterion::WorkingFolderUnder], &some_missing),
            "one terminal with no cwd is the whole reason for the scan"
        );
        assert!(!scan_needed_for([Criterion::WorkingFolderUnder], &none_missing));

        // The rows never matter for the criteria that do not read a cwd.
        assert!(scan_needed_for([Criterion::CommandContains], &none_missing));
        assert!(!scan_needed_for([Criterion::TabNameContains], &some_missing));
        assert!(!scan_needed_for([], &some_missing));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// §10.13 — two reads inside the TTL share ONE scan.
    #[test]
    fn two_reads_inside_the_ttl_share_one_snapshot() {
        let builds = Cell::new(0u32);
        let snap: ProcSnapshot<u32> = ProcSnapshot::new(2_000);
        let build = || {
            builds.set(builds.get() + 1);
            builds.get()
        };

        let a = snap.with(1_000, build, |v| *v);
        let b = snap.with(2_500, build, |v| *v);
        assert_eq!(builds.get(), 1, "a second read inside the TTL must not rescan");
        assert_eq!(a, b, "and it must see the same snapshot");
        assert_eq!(snap.taken_at_ms(), Some(1_000), "taken_at is the FIRST read's time, not the last");
    }

    #[test]
    fn a_read_past_the_ttl_rebuilds_once() {
        let builds = Cell::new(0u32);
        let snap: ProcSnapshot<u32> = ProcSnapshot::new(2_000);
        let build = || {
            builds.set(builds.get() + 1);
            builds.get()
        };

        snap.with(1_000, build, |_| ());
        snap.with(2_999, build, |_| ());
        assert_eq!(builds.get(), 1, "999 ms later is still inside a 2 s window");
        snap.with(3_000, build, |_| ());
        assert_eq!(builds.get(), 2, "exactly at the TTL the snapshot is stale");
        assert_eq!(snap.taken_at_ms(), Some(3_000));
        snap.with(3_500, build, |_| ());
        assert_eq!(builds.get(), 2, "and the new window starts from the rebuild");
    }

    /// A backwards wall clock must not pin a snapshot forever. `saturating_sub` on `i64` would go
    /// negative and read as "fresh" — the same shape as the rate-limit defect the store's own review
    /// found.
    #[test]
    fn a_backwards_clock_rebuilds_rather_than_freezing_the_snapshot() {
        let builds = Cell::new(0u32);
        let snap: ProcSnapshot<u32> = ProcSnapshot::new(2_000);
        let build = || {
            builds.set(builds.get() + 1);
            builds.get()
        };
        snap.with(10_000, build, |_| ());
        snap.with(1_000, build, |_| ());
        assert_eq!(builds.get(), 2, "a clock that moved backwards means the snapshot is not fresh");
    }

    /// §10.13's second half — the idle gate. A profile whose only enabled rule is `Terminal ID is`
    /// never enumerates the machine's processes.
    #[test]
    fn the_idle_gate_scans_only_for_the_criteria_that_need_it() {
        assert!(!scan_needed([Criterion::TerminalIdIs], false));
        assert!(!scan_needed([Criterion::TerminalIdIs], true));
        assert!(!scan_needed([Criterion::TabNameContains, Criterion::AllTerminals], true));
        assert!(scan_needed([Criterion::CommandContains], false), "the cmdline exists only in a scan");
        assert!(scan_needed([Criterion::TerminalIdIs, Criterion::CommandContains], false));
        assert!(
            !scan_needed([Criterion::WorkingFolderUnder], false),
            "every terminal reported an OSC cwd — nothing to fall back to"
        );
        assert!(
            scan_needed([Criterion::WorkingFolderUnder], true),
            "a terminal with no OSC cwd needs the process cwd"
        );
        assert!(!scan_needed([], true), "no enabled rules, no scan");
    }
}
