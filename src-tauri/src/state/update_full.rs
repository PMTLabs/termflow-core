//! The update that closes every terminal.
//!
//! An update that cannot leave the shells running (the release says so, or a host
//! runs from inside the folder the updater replaces) closes all of them. That is
//! only done after the user has been told how many there are and has agreed, and
//! the agreement is bound to what is then true: the release that was downloaded,
//! how many shells are running, whether that count is known, and why the update
//! has to close them. If any of it differs once creation has been stopped, the
//! user is asked again and nothing has happened. The one exception is a full
//! update that has stopped being required by then (a host that forced it is gone):
//! it carries on as an offload, which keeps every terminal, rather than asking the
//! user to confirm closing them.
//!
//! Three stages, only the last of which cannot be undone:
//! 1. *prepare* looks, stops nothing. It refuses what cannot work (other
//!    instances running, a host whose terminals are not known yet) and answers
//!    "needs confirmation" until the confirmation matches.
//! 2. *commit* stops creation, looks again, persists everything that the exit
//!    would not, checks again that no other instance started, and starts the
//!    updater. Any failure up to here releases admission and leaves every host
//!    exactly as it was.
//! 3. *irreversible* closes every host within a bound, then exits; a watchdog on
//!    its own thread ends the process if any of it hangs.
//!
//! A full update never arms a host: the shells are meant to end.
//!
//! Everything runs against [`FullUpdatePort`], which `AppState` implements, so the
//! ordering and the failure policy are testable over fake hosts without a Tauri
//! `AppHandle` or an updater.

use super::host_adoption::listing_is_current;
use super::host_table::Admission;
use super::host_lifecycle::{begin_full_update, origins, owned_hosts, owned_hosts_now, unresolved_refusal};
use super::host_lifecycle::{CloseBounds, LifecyclePort, OwnedHost};
use super::types::AppState;
use super::update_survival::{effective_mode, FullReason, UpdateMode};
use crate::elevated_host::HostChannel;
use crate::net_ports::InstanceRecord;
use crate::update_policy;
use futures::future::join_all;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// When the process is ended regardless, counted from the moment the updater was
/// started. The updater waits 60 s for this process to exit; this stays well
/// inside it.
pub(super) const WATCHDOG_AFTER: Duration = Duration::from_secs(40);
/// What closing the hosts may take once the updater is running: each host gets
/// 8 s to acknowledge, all of them 25 s together, and the elevated host follows.
pub(super) const FULL_CLOSE: CloseBounds =
    CloseBounds { per_host: Duration::from_secs(8), total: Duration::from_secs(25) };
/// How long a host gets to say how many shells it holds.
const SCOPE_LIST_BOUND: Duration = Duration::from_secs(3);
/// How long the updater is looked for after it was started, if it is not seen at
/// once.
const UPDATER_SEARCH: Duration = Duration::from_secs(2);
/// How long it must have been running before it is believed to be: starting a
/// process succeeds before the updater has had any chance to notice a problem of
/// its own (it starts by waiting for this process to exit, so it cannot yet have
/// touched a file), and a process that dies at once is not worth trusting.
const UPDATER_SETTLE: Duration = Duration::from_millis(750);

// ---- what the user agrees to -----------------------------------------------

/// The release that was downloaded and the mode its notes ask for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub version: String,
    pub marker_mode: update_policy::UpdateMode,
}

/// What the user is asked to agree to, as it reaches the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    pub version: String,
    /// Shells that will be closed, as far as it is known; see `unknown`.
    pub shell_count: u32,
    /// At least one host did not say what it holds: the count is a lower bound.
    pub unknown: bool,
    pub reasons: Vec<FullReason>,
}

/// An earlier [`Confirmation`] handed back by the renderer to say it was agreed
/// to. Valid only while it still equals what is true.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmToken {
    /// A confirmation echoed back as it came (`version`) is accepted too.
    #[serde(alias = "version")]
    pub target_version: String,
    pub shell_count: u32,
    pub unknown: bool,
    pub reasons: Vec<FullReason>,
}

impl Confirmation {
    fn matches(&self, token: &ConfirmToken) -> bool {
        token.target_version == self.version
            && token.shell_count == self.shell_count
            && token.unknown == self.unknown
            && token.reasons == self.reasons
    }
}

/// How many shells are running, and whether that is all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Scope {
    shell_count: u32,
    unknown: bool,
}

/// What a full update comes to.
#[derive(Debug)]
pub enum FullRun<I> {
    /// The update is not a full one; `I` is handed back for the offload path.
    Offload(I),
    /// The user has to agree (again) first. Nothing was done.
    NeedsConfirmation(Confirmation),
    /// The updater is running and the process is on its way out.
    Exited,
}

/// What the Settings page is told about an update before it is attempted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub mode: UpdateMode,
    pub reasons: Vec<FullReason>,
}

fn survival_mode(mode: update_policy::UpdateMode) -> UpdateMode {
    match mode {
        update_policy::UpdateMode::Offload => UpdateMode::Offload,
        update_policy::UpdateMode::Full => UpdateMode::Full,
    }
}

// ---- the port --------------------------------------------------------------

/// What a full update needs from the application beyond the hosts.
pub(super) trait FullUpdatePort: LifecyclePort {
    /// Live shells that no pty-host owns: in-process ones and the elevated host's.
    fn local_shells(&self) -> u32;
    /// The other TermFlow instances running now.
    fn live_siblings(&self) -> Result<Vec<InstanceRecord>, String>;
    /// Ask every window to persist its state and wait for them. True when this very
    /// call is what marked the application as exiting: only then does the mark
    /// belong to the caller, and only then may [`Self::abort_flush`] take it back
    /// (a quit that marked it first keeps its own).
    fn flush_windows(&self) -> impl Future<Output = bool> + Send;
    /// The update did not go ahead after it marked the application as exiting.
    fn abort_flush(&self);
    /// Write every terminal's scrollback: the exit hooks are skipped when the
    /// watchdog ends the process.
    fn flush_history(&self) -> impl Future<Output = ()> + Send;
    /// Is the updater that was just started running, and does it stay so?
    fn updater_alive(&self) -> impl Future<Output = bool> + Send;
    /// The file the update crate starts, when this build can tell.
    fn update_exe(&self) -> Option<PathBuf> {
        None
    }
    /// Close every host within `bounds`, then the elevated host.
    fn close_all_hosts(&self, bounds: CloseBounds) -> impl Future<Output = ()> + Send;
    /// Leave through the normal exit.
    fn exit_app(&self);
    /// End the process now, skipping the exit hooks. Called from the watchdog's
    /// own thread.
    fn hard_exit(&self);
    fn watchdog_after(&self) -> Duration {
        WATCHDOG_AFTER
    }
}

// ---- looking -----------------------------------------------------------------

async fn scope_of<P: FullUpdatePort>(port: &P, hosts: &[OwnedHost]) -> Scope {
    let answers = join_all(hosts.iter().map(|host| async move {
        let channel = host.channel?;
        let epoch = port.table().epoch(channel)?;
        let client = host.client.as_ref()?;
        let sessions = client.list_sessions_within(SCOPE_LIST_BOUND).await?;
        Some((channel, epoch, client, sessions))
    }))
    .await;
    let mut shell_count = port.local_shells();
    let mut unknown = false;
    for answer in answers {
        match answer {
            // A fast reply may have become stale while another host was listing.
            Some((channel, epoch, client, sessions))
                if listing_is_current(port.table(), channel, epoch, client, Admission::Open) => {
                let live = sessions.iter().filter(|s| s.alive).count();
                shell_count = shell_count.saturating_add(u32::try_from(live).unwrap_or(u32::MAX));
            }
            // A host that did not answer holds an unknown number: never none.
            _ => unknown = true,
        }
    }
    Scope { shell_count, unknown }
}

fn confirmation(target: &Target, scope: Scope, reasons: Vec<FullReason>) -> Confirmation {
    Confirmation { version: target.version.clone(), shell_count: scope.shell_count, unknown: scope.unknown, reasons }
}

fn live_siblings_refusal<P: FullUpdatePort>(port: &P) -> Result<(), String> {
    let siblings = port.live_siblings()?;
    crate::sibling_coord::describe_live_siblings(&siblings).map_or(Ok(()), Err)
}

// ---- the transaction -----------------------------------------------------------

/// Run the update for `target` if it has to close every terminal; otherwise give
/// `info` back untouched. `launch` starts the updater with `info`; it is the one
/// step after which the shells are as good as gone.
pub(super) async fn run_full<P, I, L, Fut>(
    port: &P,
    target: &Target,
    confirm: Option<ConfirmToken>,
    info: I,
    launch: L,
) -> Result<FullRun<I>, String>
where
    P: FullUpdatePort,
    I: Send,
    L: FnOnce(I) -> Fut + Send,
    Fut: Future<Output = Result<(), String>> + Send,
{
    log::info!("[GEN] preparing update {} (marker mode {:?}, confirmed={})",
        target.version, target.marker_mode, confirm.is_some());
    // Prepare: nothing is stopped, nothing is changed.
    let hosts = owned_hosts(port).await;
    let marker = survival_mode(target.marker_mode);
    let (mode, reasons) = effective_mode(marker, &origins(&hosts));
    if mode == UpdateMode::Offload {
        return Ok(FullRun::Offload(info));
    }
    live_siblings_refusal(port)?;
    // An unreached host may be armed from an earlier offload and would survive the
    // restart and be adopted again, which is not what a full update is for. (A host
    // that drops from here on is caught by the count turning unknown at commit.)
    if let Some(reason) = unresolved_refusal(&hosts) {
        return Err(reason);
    }
    let asked = confirmation(target, scope_of(port, &hosts).await, reasons);
    let Some(token) = confirm.filter(|token| asked.matches(token)) else {
        return Ok(FullRun::NeedsConfirmation(asked));
    };

    // Commit: stop creation, and look again at what was agreed to.
    let hold = begin_full_update(port).await?;
    let (_, reasons) = effective_mode(marker, &origins(hold.hosts()));
    let now = confirmation(target, scope_of(port, hold.hosts()).await, reasons);
    if now.reasons.is_empty() {
        // Nothing demands a full update any more (the host that did has gone, or is
        // no longer inside the folder): the terminals can stay running, which asks
        // less of the user than what they agreed to. Admission reopens.
        log::info!("[UPDATE] no longer needs to close the terminals; applying it as an offload");
        return Ok(FullRun::Offload(info));
    }
    if !now.matches(&token) {
        log::info!("[UPDATE] what was agreed to changed while creation was being stopped; asking again");
        return Ok(FullRun::NeedsConfirmation(now));
    }

    let flushed_by_us = port.flush_windows().await;
    port.flush_history().await;
    // After the flushes, which can take seconds: an instance started while the
    // user decided, or during them, would have its window closed by the updater.
    // Nothing is armed for it, so the only answer is not to go ahead.
    if let Err(reason) = live_siblings_refusal(port) {
        log::warn!("[UPDATE] refused: {reason}");
        abort(port, flushed_by_us, None);
        return Err(reason);
    }
    if let Err(e) = launch(info).await {
        log::warn!("[UPDATE] the updater could not be started ({e}); nothing was closed");
        abort(port, flushed_by_us, None);
        return Err(e);
    }
    // From here the process has a limited time to leave: the updater waits for it.
    // The watchdog starts with the updater, before anything that could stall.
    let cancelled = Arc::new(AtomicBool::new(false));
    start_watchdog(port, port.watchdog_after(), cancelled.clone());
    if !port.updater_alive().await {
        log::warn!("[UPDATE] the updater is not running; nothing was closed");
        abort(port, flushed_by_us, Some(&cancelled));
        return Err("the updater did not start, so nothing was changed; try again".to_string());
    }

    // Irreversible. Admission stays closed until the process is gone.
    //
    // Declared residual risk: a host that does not take its shutdown in time is
    // closed without one, and a host treats a connection that just ends as a crash:
    // it keeps its shells for a while, and one that runs outside the folder the
    // updater replaces can be adopted again by the new version. A full update then
    // has not closed everything. A host that misses its shutdown inside the bound is
    // logged by name where the closure notices it (see `exit_hosts_within`; a host
    // whose listing never came back is only counted), and the bound is what keeps the app from outliving the
    // updater's wait for it.
    hold.commit();
    log::info!("[UPDATE] updater running; closing every terminal host and exiting");
    port.close_all_hosts(FULL_CLOSE).await;
    port.exit_app();
    Ok(FullRun::Exited)
}

/// Back out after the windows were flushed, and call off the watchdog if one was
/// started.
fn abort<P: FullUpdatePort>(port: &P, flushed_by_us: bool, watchdog: Option<&AtomicBool>) {
    if let Some(cancelled) = watchdog {
        cancelled.store(true, Ordering::SeqCst);
    }
    if flushed_by_us {
        port.abort_flush();
    }
}

/// End the process `after` from now whatever the runtime is doing, unless it was
/// called off by then. On a thread of its own: a stalled Tokio runtime must not be
/// able to stop it.
fn start_watchdog<P: FullUpdatePort>(port: &P, after: Duration, cancelled: Arc<AtomicBool>) {
    let port = port.clone();
    let started = std::thread::Builder::new().name("update-watchdog".to_string()).spawn(move || {
        std::thread::sleep(after);
        if cancelled.load(Ordering::SeqCst) {
            return;
        }
        log::error!("[UPDATE] still running {} s after the updater started; ending the process", after.as_secs());
        port.hard_exit();
    });
    if let Err(e) = started {
        log::error!("[UPDATE] could not start the watchdog: {e}");
    }
}

// ---- availability -----------------------------------------------------------------

/// What an update would do now, from what is already known: the mode the last
/// check found, and where the hosts run from. An offload has to pass
/// `offload_preflight`. A full update is not subject to what that refuses
/// (in-process shells, a host that cannot be armed or would not survive), so
/// none of it is asked; the one refusal that still applies is other running
/// instances.
pub(super) fn availability<P: FullUpdatePort>(
    port: &P,
    marker_mode: update_policy::UpdateMode,
    offload_preflight: impl FnOnce() -> Result<(), String>,
) -> Result<Availability, String> {
    let hosts = owned_hosts_now(port);
    let (mode, reasons) = effective_mode(survival_mode(marker_mode), &origins(&hosts));
    log::debug!("[GEN] update availability: {mode:?}, reasons={reasons:?}");
    match mode {
        UpdateMode::Offload => offload_preflight()?,
        UpdateMode::Full => live_siblings_refusal(port)?,
    }
    Ok(Availability { mode, reasons })
}

// ---- AppState -----------------------------------------------------------------------

/// Is this process the updater that was started for us? It is `Update` (the name
/// differs by platform) called with `--waitPid <this pid>`. When its command line
/// cannot be read it counts only if it is the very file the update crate starts:
/// any other process named `update…` whose arguments are hidden (a service, an
/// elevated process) says nothing about ours.
pub(super) fn is_our_updater(
    name: &str,
    exe: Option<&Path>,
    args: &[String],
    my_pid: &str,
    update_exe: Option<&Path>,
) -> bool {
    if !name.to_ascii_lowercase().starts_with("update") {
        return false;
    }
    if args.is_empty() {
        return match (exe, update_exe) {
            (Some(exe), Some(update_exe)) => same_file(exe, update_exe),
            _ => false,
        };
    }
    args.windows(2).any(|pair| pair[0].eq_ignore_ascii_case("--waitPid") && pair[1] == my_pid)
}

fn same_file(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

/// One look at the process table for the updater. The update crate keeps no handle
/// to the process it starts, so it is found. Names are read for every process, but
/// command lines and image paths only for the few that could be it: reading them
/// for all is the heavy part of a process scan.
fn updater_running(update_exe: Option<&Path>) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let candidates: Vec<Pid> = sys
        .processes()
        .iter()
        .filter(|(_, process)| process.name().to_string_lossy().to_ascii_lowercase().starts_with("update"))
        .map(|(pid, _)| *pid)
        .collect();
    if candidates.is_empty() {
        return false;
    }
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&candidates),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always).with_exe(UpdateKind::Always),
    );
    let me = std::process::id().to_string();
    candidates.iter().filter_map(|pid| sys.process(*pid)).any(|process| {
        let args: Vec<String> = process.cmd().iter().map(|a| a.to_string_lossy().to_string()).collect();
        is_our_updater(&process.name().to_string_lossy(), process.exe(), &args, &me, update_exe)
    })
}

/// Believe the updater is running only if it is seen (within `search`) and is
/// still there after `settle`. `probe` is one look.
pub(super) async fn confirm_running<F, Fut>(settle: Duration, search: Duration, probe: F) -> bool
where
    F: Fn() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + search;
    while !probe().await {
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    tokio::time::sleep(settle).await;
    probe().await
}

impl FullUpdatePort for AppState {
    fn local_shells(&self) -> u32 {
        let in_process = self.terminals.iter().filter(|t| !self.host_terminals.contains_key(t.key())).count();
        let elevated = self.host_terminals.iter().filter(|t| *t.value() == HostChannel::Elevated).count();
        u32::try_from(in_process + elevated).unwrap_or(u32::MAX)
    }

    fn live_siblings(&self) -> Result<Vec<InstanceRecord>, String> {
        crate::net_ports::live_siblings_now(&crate::profile::current().key())
            .map_err(|e| format!("cannot enumerate sibling instances: {e}"))
    }

    async fn flush_windows(&self) -> bool {
        crate::commands::flush_all_windows(&self.app_handle).await
    }

    fn abort_flush(&self) {
        self.exiting.store(false, Ordering::SeqCst);
    }

    async fn flush_history(&self) {
        let state = self.clone();
        if let Err(e) = tokio::task::spawn_blocking(move || crate::flush_all_history(&state)).await {
            log::error!("[UPDATE] the history flush did not finish: {e}");
        }
    }

    async fn updater_alive(&self) -> bool {
        let update_exe = self.update_exe();
        confirm_running(UPDATER_SETTLE, UPDATER_SEARCH, || {
            let update_exe = update_exe.clone();
            async move {
                tokio::task::spawn_blocking(move || updater_running(update_exe.as_deref())).await.unwrap_or(false)
            }
        })
        .await
    }

    fn update_exe(&self) -> Option<PathBuf> {
        #[cfg(feature = "velopack-updates")]
        {
            crate::updater::update_exe_path()
        }
        #[cfg(not(feature = "velopack-updates"))]
        {
            None
        }
    }

    async fn close_all_hosts(&self, bounds: CloseBounds) {
        crate::commands::close_all_hosts(&self.app_handle, Some(bounds)).await;
    }

    fn exit_app(&self) {
        self.app_handle.exit(0);
    }

    fn hard_exit(&self) {
        std::process::exit(0);
    }
}

impl AppState {
    /// Run the update if it has to close every terminal; see [`run_full`].
    pub async fn run_full_update<I, L, Fut>(
        &self,
        target: &Target,
        confirm: Option<ConfirmToken>,
        info: I,
        launch: L,
    ) -> Result<FullRun<I>, String>
    where
        I: Send,
        L: FnOnce(I) -> Fut + Send,
        Fut: Future<Output = Result<(), String>> + Send,
    {
        run_full(self, target, confirm, info, launch).await
    }

    /// What an update would do now; see [`availability`].
    pub fn update_availability(
        &self,
        marker_mode: update_policy::UpdateMode,
        offload_preflight: impl FnOnce() -> Result<(), String>,
    ) -> Result<Availability, String> {
        availability(self, marker_mode, offload_preflight)
    }
}
