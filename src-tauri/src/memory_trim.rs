//! One working-set trim per off-screen epoch (Windows only): after TermFlow is hidden to the
//! tray or minimized to the taskbar, or after a start that leaves nothing on screen. A
//! visible window is never trimmed, even behind another app. Shells keep running. This
//! reduces resident working sets, not committed GPU memory.
#![cfg_attr(not(windows), allow(dead_code))]

use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    Startup,
    Hidden,
    Minimized,
}
impl Trigger {
    fn delay(self) -> Duration {
        Duration::from_secs(match self {
            Self::Startup => 8,
            _ => 3,
        })
    }
    #[cfg(windows)]
    fn name(self) -> &'static str {
        match self {
            Self::Startup => "startup",
            Self::Hidden => "hidden",
            Self::Minimized => "minimized",
        }
    }
}
#[derive(Default, Debug, PartialEq, Eq)]
enum Epoch {
    #[default]
    Untrimmed,
    Low,
}
#[derive(Default)]
struct Admission {
    low: bool,
    dragging: bool,
    stopping: bool,
}
#[derive(Default)]
struct Windows {
    count: usize,
    on_screen: bool,
    minimized: bool,
}
impl Windows {
    fn add(&mut self, visible: bool, minimized: bool) {
        self.count += 1;
        self.on_screen |= visible && !minimized;
        self.minimized |= minimized;
    }
    // Shared with tests: "low" (allowed to trim) means no window is on screen.
    fn admission(&self, dragging: bool, stopping: bool) -> Admission {
        Admission {
            low: !self.on_screen,
            dragging,
            stopping,
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
enum Edge {
    Activate,
    Request(Trigger),
}

#[derive(Default)]
struct IdleTrimScheduler {
    generation: u64,
    pending: Option<(Trigger, Instant)>,
    epoch: Epoch,
    low_applied: HashSet<String>,
    started: bool,
    off_screen: bool,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}
impl IdleTrimScheduler {
    fn request(&mut self, trigger: Trigger, now: Instant) -> Option<u64> {
        if trigger == Trigger::Startup {
            if self.started {
                return None;
            }
            self.started = true;
        }
        if self.epoch == Epoch::Low {
            return None;
        }
        if self
            .pending
            .is_some_and(|(_, deadline)| deadline <= now + trigger.delay())
        {
            return None;
        }
        self.cancel();
        self.pending = Some((trigger, now + trigger.delay()));
        Some(self.generation)
    }
    fn cancel(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.generation += 1;
        self.pending = None;
    }
    // A queued main-thread closure must also lose its admission on cancellation.
    fn abandon(&mut self, generation: u64) {
        if generation == self.generation {
            self.pending = None;
            self.generation += 1;
            self.task.take();
        }
    }
    fn activate(&mut self) {
        self.cancel();
        self.epoch = Epoch::Untrimmed;
        self.off_screen = false;
    }
    fn resize(&mut self, windows: &Windows) -> Option<Edge> {
        let was = self.off_screen;
        self.off_screen = !windows.on_screen;
        match (was, self.off_screen) {
            (true, false) => Some(Edge::Activate),
            (false, true) if windows.minimized => Some(Edge::Request(Trigger::Minimized)),
            _ => None,
        }
    }
    fn destroyed(&mut self, label: &str, windows: &Windows, keep: bool) -> Option<Trigger> {
        self.low_applied.remove(label);
        self.off_screen = !windows.on_screen;
        if windows.count == 0 && !keep {
            self.cancel();
            None
        } else if windows.count == 0 {
            Some(Trigger::Hidden)
        } else if !windows.on_screen && windows.minimized {
            Some(Trigger::Minimized)
        } else {
            None
        }
    }
    fn fire(&mut self, generation: u64, now: Instant, adm: Admission) -> Option<Trigger> {
        if generation != self.generation {
            return None;
        }
        let (trigger, deadline) = self.pending?;
        if now < deadline {
            return None;
        }
        // Trim only while nothing is on screen. A window still visible behind another app
        // stays resident, so returning to it never pages back in. Focus and foreground are
        // not consulted: Windows can leave a minimized window as the foreground window.
        if adm.stopping || !adm.low {
            self.abandon(generation);
            return None;
        }
        if adm.dragging {
            self.pending = Some((trigger, now + trigger.delay()));
            return None;
        }
        self.abandon(generation);
        if self.epoch == Epoch::Low {
            return None;
        }
        self.off_screen = true;
        self.epoch = Epoch::Low;
        Some(trigger)
    }
}
impl Drop for IdleTrimScheduler {
    fn drop(&mut self) {
        self.cancel();
    }
}
#[derive(Default)]
pub struct MemoryTrim(Arc<Mutex<IdleTrimScheduler>>);
impl Drop for MemoryTrim {
    fn drop(&mut self) {
        self.0.lock().unwrap().cancel();
    }
}

fn keep_low(epoch: &Epoch) -> bool {
    *epoch == Epoch::Low
}

fn sync_off_screen(s: &mut IdleTrimScheduler, windows: &Windows) {
    s.off_screen = !windows.on_screen;
}

fn request_with_census<T>(
    scheduler: &mut IdleTrimScheduler,
    windows: Option<&Windows>,
    state: Option<&T>,
    trigger: Trigger,
    now: Instant,
) -> Option<u64> {
    if let Some(windows) = windows {
        sync_off_screen(scheduler, windows);
    }
    request_if_present(scheduler, state, trigger, now)
}

fn insert_nonzero(pids: &mut std::collections::BTreeSet<u32>, pid: u32) {
    if pid != 0 {
        pids.insert(pid);
    }
}

// Keep the absent-state guard shared with tests, without enabling tauri/test on Windows.
fn request_if_present<T>(
    scheduler: &mut IdleTrimScheduler,
    state: Option<&T>,
    trigger: Trigger,
    now: Instant,
) -> Option<u64> {
    state?;
    scheduler.request(trigger, now)
}

#[cfg(not(windows))]
pub fn request(_: &tauri::AppHandle, _: Trigger) {}
#[cfg(not(windows))]
pub fn activate(_: &tauri::AppHandle) {}
#[cfg(not(windows))]
pub fn focused(_: &tauri::Window, _: bool) {}
#[cfg(not(windows))]
pub fn resized(_: &tauri::Window) {}
#[cfg(not(windows))]
pub fn destroyed(_: &tauri::Window) {}
#[cfg(not(windows))]
pub fn on_page_load(_: &tauri::Webview, _: tauri::webview::PageLoadEvent) {}
#[cfg(windows)]
pub use platform::{activate, destroyed, focused, on_page_load, request, resized};

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::{
        commands::PREVIEW_LABEL,
        state::{AppState, McpProcessHandle},
    };
    use std::{collections::BTreeSet, sync::atomic::Ordering};
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::{
        core::Interface,
        Win32::{
            Foundation::{CloseHandle, ERROR_NO_MORE_FILES},
            System::{Diagnostics::ToolHelp::*, Memory::*, Threading::*},
        },
    };

    fn scheduler(app: &AppHandle) -> Option<Arc<Mutex<IdleTrimScheduler>>> {
        app.try_state::<MemoryTrim>().map(|s| s.0.clone())
    }
    fn real(app: &AppHandle) -> Vec<tauri::WebviewWindow> {
        app.webview_windows()
            .into_values()
            .filter(|w| w.label() != PREVIEW_LABEL)
            .collect()
    }
    fn census(app: &AppHandle, exclude: Option<&str>) -> Option<Windows> {
        let mut result = Windows::default();
        for w in real(app).into_iter().filter(|w| Some(w.label()) != exclude) {
            result.add(w.is_visible().ok()?, w.is_minimized().ok()?);
        }
        Some(result)
    }
    pub fn activate(app: &AppHandle) {
        if let Some(s) = scheduler(app) {
            s.lock().unwrap().activate();
            memory_target(app, false);
        }
    }
    pub fn focused(window: &tauri::Window, focused: bool) {
        if window.label() == PREVIEW_LABEL {
            return;
        }
        // Losing focus while on screen never trims; gaining it ends an off-screen epoch.
        if focused {
            activate(window.app_handle());
        }
    }
    pub fn resized(window: &tauri::Window) {
        if window.label() == PREVIEW_LABEL {
            return;
        }
        let app = window.app_handle();
        let (Some(s), Some(windows)) = (scheduler(app), census(app, None)) else {
            return;
        };
        let edge = s.lock().unwrap().resize(&windows);
        match edge {
            Some(Edge::Activate) => activate(app),
            Some(Edge::Request(t)) => request(app, t),
            None => {}
        }
    }
    pub fn destroyed(window: &tauri::Window) {
        if window.label() == PREVIEW_LABEL {
            return;
        }
        let app = window.app_handle();
        let Some(s) = scheduler(app) else {
            return;
        };
        // Remove the stale label even if querying a remaining window fails.
        s.lock().unwrap().low_applied.remove(window.label());
        let Some(windows) = census(app, Some(window.label())) else {
            return;
        };
        let keep = app.tray_by_id("main-tray").is_some()
            && app
                .try_state::<AppState>()
                .is_some_and(|s| s.keep_running_in_background.load(Ordering::Relaxed));
        let trigger = s.lock().unwrap().destroyed(window.label(), &windows, keep);
        if let Some(t) = trigger {
            request(app, t);
        }
    }
    pub fn on_page_load(webview: &tauri::Webview, event: tauri::webview::PageLoadEvent) {
        if webview.label() != PREVIEW_LABEL && event == tauri::webview::PageLoadEvent::Finished {
            request(webview.app_handle(), Trigger::Startup);
        }
    }
    pub fn request(app: &AppHandle, trigger: Trigger) {
        let Some(scheduler) = scheduler(app) else {
            return;
        };
        // Hide may not emit Resized; sync even if the request is rejected.
        let windows = census(app, None);
        // Clone every Arc before spawning; never keep a managed State across await.
        let (generation, exiting, recovering, restarting, keys) = {
            let state = app.try_state::<AppState>();
            let generation = request_with_census(
                &mut scheduler.lock().unwrap(),
                windows.as_ref(),
                state.as_deref(),
                trigger,
                Instant::now(),
            );
            let (Some(generation), Some(state)) = (generation, state) else {
                return;
            };
            (
                generation,
                state.exiting.clone(),
                state.recovering.clone(),
                state.restart_in_flight.clone(),
                state.host_table.keys().clone(),
            )
        };
        let owner = scheduler.clone();
        let app = app.clone();
        let task = tauri::async_runtime::spawn(async move {
            loop {
                let deadline = {
                    let s = scheduler.lock().unwrap();
                    if s.generation != generation {
                        return;
                    }
                    s.pending.map(|(_, d)| d)
                };
                let Some(deadline) = deadline else {
                    return;
                };
                tokio::time::sleep_until(deadline.into()).await;
                let handle = app.clone();
                let admission = scheduler.clone();
                let exiting = exiting.clone();
                let recovering = recovering.clone();
                let restarting = restarting.clone();
                let keys = keys.clone();
                let (tx, rx) = tokio::sync::oneshot::channel();
                if app
                    .run_on_main_thread(move || {
                        let Some(windows) = census(&handle, None) else {
                            admission.lock().unwrap().abandon(generation);
                            return;
                        };
                        let stopping = exiting.load(Ordering::Relaxed)
                            || recovering.load(Ordering::Relaxed)
                            || restarting.load(Ordering::Relaxed);
                        let dragging = keys.pane_drag_active()
                            || handle
                                .get_webview_window(PREVIEW_LABEL)
                                .is_some_and(|w| w.is_visible().unwrap_or(false));
                        let trigger = admission.lock().unwrap().fire(
                            generation,
                            Instant::now(),
                            windows.admission(dragging, stopping),
                        );
                        if let Some(trigger) = trigger {
                            trim(&handle, trigger);
                        }
                        let _ = tx.send(());
                    })
                    .is_err()
                    || rx.await.is_err()
                {
                    scheduler.lock().unwrap().abandon(generation);
                    return;
                }
            }
        });
        let mut s = owner.lock().unwrap();
        if s.generation == generation && s.pending.is_some() {
            s.task = Some(task);
        } else {
            task.abort();
        }
    }
    fn warn(stage: &'static str, error: windows::core::Error) {
        log::warn!(
            "memory_trim: {} failed hresult={:#010x}",
            stage,
            error.code().0 as u32
        );
    }
    fn dispatch_failed() {
        log::warn!(
            "memory_trim: dispatch failed hresult={:#010x}",
            0x80004005u32
        );
    }
    fn memory_target(app: &AppHandle, low: bool) {
        let Some(s) = scheduler(app) else {
            return;
        };
        for window in real(app) {
            let label = window.label().to_string();
            if s.lock().unwrap().low_applied.contains(&label) == low {
                continue;
            }
            let s = s.clone();
            if window
                .with_webview(move |webview| unsafe {
                    // A queued LOW must not undo an activation that overtook it.
                    if keep_low(&s.lock().unwrap().epoch) != low {
                        return;
                    }
                    let result = (|| {
                        let core = webview
                            .controller()
                            .CoreWebView2()?
                            .cast::<ICoreWebView2_19>()?;
                        core.SetMemoryUsageTargetLevel(if low {
                            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                        } else {
                            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                        })?;
                        let mut s = s.lock().unwrap();
                        if low && !keep_low(&s.epoch) {
                            core.SetMemoryUsageTargetLevel(
                                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
                            )?;
                        } else if low {
                            s.low_applied.insert(label);
                        } else {
                            s.low_applied.remove(&label);
                        }
                        Ok(())
                    })();
                    if let Err(e) = result {
                        warn("memory_target", e);
                    }
                })
                .is_err()
            {
                dispatch_failed();
            }
        }
    }
    // Only an admitted off-screen trim gets here, so the WebViews also go LOW.
    fn trim(app: &AppHandle, trigger: Trigger) {
        memory_target(app, true);
        let mcp = app.try_state::<AppState>().and_then(|s| {
            s.mcp_process.lock().ok().and_then(|slot| {
                slot.current().and_then(|p| match &p.handle {
                    McpProcessHandle::Sidecar { child, .. } => Some(child.pid()),
                    McpProcessHandle::Legacy(_) => None,
                })
            })
        });
        // Host and verified MCP do not depend on WebView dispatch succeeding.
        finish_trim(
            trigger,
            Instant::now(),
            0,
            mcp,
            BTreeSet::from([std::process::id()]),
            "host",
        );
        let window = real(app).into_iter().next().or_else(|| {
            app.get_webview_window(PREVIEW_LABEL)
                .filter(|w| w.is_visible().is_ok())
        });
        if let Some(window) = window {
            if window
                .with_webview(move |webview| unsafe {
                    let start = Instant::now();
                    let mut pids = BTreeSet::new();
                    let mut browser = 0;
                    let result: windows::core::Result<()> = (|| {
                        let core = webview.controller().CoreWebView2()?;
                        core.BrowserProcessId(&mut browser)?;
                        insert_nonzero(&mut pids, browser);
                        let infos = core
                            .cast::<ICoreWebView2_2>()?
                            .Environment()?
                            .cast::<ICoreWebView2Environment8>()?
                            .GetProcessInfos()?;
                        let mut count = 0;
                        infos.Count(&mut count)?;
                        for i in 0..count {
                            let result: windows::core::Result<()> = (|| {
                                let mut pid = 0;
                                infos.GetValueAtIndex(i)?.ProcessId(&mut pid)?;
                                if pid > 0 {
                                    pids.insert(pid as u32);
                                }
                                Ok(())
                            })(
                            );
                            if let Err(e) = result {
                                warn("process_info", e);
                            }
                        }
                        Ok(())
                    })();
                    if let Err(e) = result {
                        warn("discovery", e);
                    }
                    finish_trim(trigger, start, browser, mcp, pids, "webview");
                })
                .is_err()
            {
                dispatch_failed();
            }
        }
    }
    fn finish_trim(
        trigger: Trigger,
        start: Instant,
        browser: u32,
        mcp: Option<u32>,
        mut pids: BTreeSet<u32>,
        part: &str,
    ) {
        if let Err(e) =
            supplemental_processes(browser, if part == "host" { mcp } else { None }, &mut pids)
        {
            warn("snapshot", e);
        }
        if part == "webview" {
            pids.remove(&std::process::id());
            if let Some(pid) = mcp {
                pids.remove(&pid);
            }
        }
        let (trimmed, failed) = trim_processes(&pids);
        log::info!(
            "memory_trim: part={} trigger={} processes={} trimmed={} failed={} elapsed_ms={}",
            part,
            trigger.name(),
            pids.len(),
            trimmed,
            failed,
            start.elapsed().as_millis()
        );
    }
    pub(super) fn supplemental_processes(
        browser: u32,
        mcp: Option<u32>,
        pids: &mut BTreeSet<u32>,
    ) -> windows::core::Result<()> {
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?;
            let result = (|| {
                let mut entry = PROCESSENTRY32W {
                    dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                    ..Default::default()
                };
                let mut next = Process32FirstW(snapshot, &mut entry);
                loop {
                    match next {
                        Ok(()) => {
                            if is_browser_child(
                                browser,
                                entry.th32ParentProcessID,
                                &entry.szExeFile,
                            ) || is_mcp_child(
                                mcp,
                                std::process::id(),
                                entry.th32ProcessID,
                                entry.th32ParentProcessID,
                                &entry.szExeFile,
                            ) {
                                pids.insert(entry.th32ProcessID);
                            }
                        }
                        Err(e)
                            if e.code()
                                == windows::core::HRESULT::from_win32(ERROR_NO_MORE_FILES.0) =>
                        {
                            return Ok(())
                        }
                        Err(e) => return Err(e),
                    }
                    next = Process32NextW(snapshot, &mut entry);
                }
            })();
            let _ = CloseHandle(snapshot);
            result
        }
    }
    pub(super) fn trim_processes(pids: &BTreeSet<u32>) -> (usize, usize) {
        let mut trimmed = 0;
        for &pid in pids {
            let result = unsafe {
                if pid == std::process::id() {
                    SetProcessWorkingSetSizeEx(
                        GetCurrentProcess(),
                        usize::MAX,
                        usize::MAX,
                        SETPROCESSWORKINGSETSIZEEX_FLAGS(0),
                    )
                } else {
                    OpenProcess(
                        PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
                        false,
                        pid,
                    )
                    .and_then(|handle| {
                        let result = SetProcessWorkingSetSizeEx(
                            handle,
                            usize::MAX,
                            usize::MAX,
                            SETPROCESSWORKINGSETSIZEEX_FLAGS(0),
                        );
                        let _ = CloseHandle(handle);
                        result
                    })
                }
            };
            match result {
                Ok(()) => trimmed += 1,
                Err(e) => warn("working_set", e),
            }
        }
        (trimmed, pids.len() - trimmed)
    }
}
fn image_is(image: &[u16], expected: &str) -> bool {
    let end = image.iter().position(|&c| c == 0).unwrap_or(image.len());
    String::from_utf16_lossy(&image[..end]).eq_ignore_ascii_case(expected)
}
fn is_browser_child(browser: u32, parent: u32, image: &[u16]) -> bool {
    browser != 0 && parent == browser && image_is(image, "msedgewebview2.exe")
}
fn is_mcp_child(recorded: Option<u32>, host: u32, pid: u32, parent: u32, image: &[u16]) -> bool {
    recorded == Some(pid) && parent == host && image_is(image, "termflow-mcp-server.exe")
}

#[cfg(test)]
mod tests {
    use super::*;
    const TRIGGERS: [Trigger; 3] = [Trigger::Startup, Trigger::Hidden, Trigger::Minimized];
    fn off_screen() -> Admission {
        Admission {
            low: true,
            ..Default::default()
        }
    }
    fn visible() -> Windows {
        Windows {
            count: 1,
            on_screen: true,
            minimized: false,
        }
    }
    fn minimized() -> Windows {
        Windows {
            count: 1,
            on_screen: false,
            minimized: true,
        }
    }
    #[test]
    fn review_regressions() {
        let now = Instant::now();
        let mut s = IdleTrimScheduler::default();
        let g = s.request(Trigger::Hidden, now).unwrap();
        assert_eq!(s.request(Trigger::Hidden, now), None);
        assert_eq!(s.fire(g, now + Duration::from_secs(2), off_screen()), None);
        assert!(s.pending.is_some());
        assert_eq!(
            s.fire(
                g,
                now + Duration::from_secs(3),
                Admission {
                    dragging: true,
                    low: true,
                    ..Default::default()
                }
            ),
            None
        );
        assert!(s.pending.is_some());
        assert_eq!(
            s.fire(g, now + Duration::from_secs(6), off_screen()),
            Some(Trigger::Hidden)
        );
        assert!(s.off_screen);
        assert_eq!(s.epoch, Epoch::Low);
        s.activate();
        assert!(!s.off_screen);
        assert_eq!(s.epoch, Epoch::Untrimmed);
        assert!(keep_low(&Epoch::Low));
        assert!(!keep_low(&Epoch::Untrimmed));
        s.low_applied.extend(["A".into(), "B".into()]);
        assert_eq!(s.destroyed("A", &visible(), true), None);
        assert!(s.low_applied.contains("B"));
        assert_eq!(
            s.destroyed("A", &minimized(), true),
            Some(Trigger::Minimized)
        );
        let g = s.request(Trigger::Hidden, now).unwrap();
        assert_eq!(s.destroyed("B", &Windows::default(), false), None);
        assert!(s.generation > g);
        assert!(s.pending.is_none());
        s.epoch = Epoch::Low;
        assert_eq!(
            request_with_census(&mut s, Some(&minimized()), Some(&()), Trigger::Hidden, now),
            None
        );
        assert!(s.off_screen);
        sync_off_screen(&mut s, &visible());
        assert!(!s.off_screen);
        let mut pids = std::collections::BTreeSet::new();
        insert_nonzero(&mut pids, 0);
        insert_nonzero(&mut pids, 7);
        assert_eq!(pids, std::collections::BTreeSet::from([7]));
        // A trim already taken this epoch cannot repeat from a pending request.
        let mut s = IdleTrimScheduler::default();
        let g = s.request(Trigger::Hidden, now).unwrap();
        s.epoch = Epoch::Low;
        assert_eq!(s.fire(g, now + Duration::from_secs(3), off_screen()), None);
        assert!(s.pending.is_none());
        let mut image = wide("msedgewebview2.exe");
        image.extend([65, 66]);
        assert!(image_is(&image, "msedgewebview2.exe"));
    }
    #[test]
    fn census_fold_and_admission_see_any_window_on_screen() {
        let mut w = Windows::default();
        w.add(false, false); // hidden to the tray
        assert!(!w.on_screen && !w.minimized);
        assert!(w.admission(false, false).low);
        w.add(true, true); // minimized to the taskbar
        assert!(!w.on_screen && w.minimized);
        assert!(w.admission(false, false).low);
        w.add(true, false); // on screen, focused or behind another app
        assert_eq!(w.count, 3);
        assert!(w.on_screen);
        let adm = w.admission(true, true);
        assert!(!adm.low && adm.dragging && adm.stopping);
        let mut w = Windows::default();
        w.add(true, false);
        w.add(true, true);
        assert!(w.on_screen && w.minimized);
    }
    #[test]
    fn exact_delays_and_no_early_fire() {
        for (t, seconds) in TRIGGERS.into_iter().zip([8, 3, 3]) {
            let mut s = IdleTrimScheduler::default();
            let now = Instant::now();
            let g = s.request(t, now).unwrap();
            let deadline = now + Duration::from_secs(seconds);
            assert_eq!(s.pending, Some((t, deadline)));
            assert_eq!(
                s.fire(g, deadline - Duration::from_millis(1), off_screen()),
                None
            );
            assert_eq!(s.pending, Some((t, deadline)));
            assert_eq!(s.fire(g, deadline, off_screen()), Some(t));
            assert!(s.pending.is_none());
        }
    }
    #[test]
    fn shorter_replaces_longer_and_stale_generation_cannot_fire() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let old = s.request(Trigger::Startup, now).unwrap();
        let new = s
            .request(Trigger::Minimized, now + Duration::from_secs(1))
            .unwrap();
        assert!(new > old);
        assert_eq!(
            s.fire(old, now + Duration::from_secs(20), off_screen()),
            None
        );
        assert_eq!(
            s.fire(new, now + Duration::from_secs(4), off_screen()),
            Some(Trigger::Minimized)
        );
    }
    #[test]
    fn rejected_requests_do_not_push_deadline() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        s.request(Trigger::Startup, now).unwrap();
        assert_eq!(
            s.request(Trigger::Hidden, now + Duration::from_secs(6)),
            None
        );
        assert_eq!(
            s.pending,
            Some((Trigger::Startup, now + Duration::from_secs(8)))
        );
    }
    #[test]
    fn activation_alone_invalidates_generation_and_reopens_epoch() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let g = s.request(Trigger::Hidden, now).unwrap();
        s.activate();
        assert!(s.generation > g);
        assert!(s.pending.is_none());
        assert_eq!(s.fire(g, now + Duration::from_secs(3), off_screen()), None);
        assert_eq!(s.epoch, Epoch::Untrimmed);
    }
    /// User rule 2026-11-03: TermFlow behind another app is still in use; only the tray
    /// or the taskbar trims it.
    #[test]
    fn a_window_on_screen_drops_every_trigger_without_consuming_epoch() {
        for t in TRIGGERS {
            for dragging in [false, true] {
                let mut s = IdleTrimScheduler::default();
                let now = Instant::now();
                let g = s.request(t, now).unwrap();
                let adm = Admission {
                    dragging,
                    ..Default::default()
                };
                assert_eq!(s.fire(g, now + t.delay(), adm), None);
                assert!(s.pending.is_none());
                assert!(s.generation > g);
                assert_eq!(s.epoch, Epoch::Untrimmed);
                assert!(!s.off_screen);
                // The epoch stays open: a later minimize still trims.
                let later = now + Duration::from_secs(20);
                let g = s.request(Trigger::Minimized, later).unwrap();
                assert_eq!(
                    s.fire(g, later + Duration::from_secs(3), off_screen()),
                    Some(Trigger::Minimized)
                );
            }
        }
    }
    #[test]
    fn stopping_drops_even_while_off_screen_and_dragging() {
        for t in TRIGGERS {
            let mut s = IdleTrimScheduler::default();
            let now = Instant::now();
            let g = s.request(t, now).unwrap();
            assert_eq!(
                s.fire(
                    g,
                    now + t.delay(),
                    Admission {
                        stopping: true,
                        dragging: true,
                        low: true,
                    }
                ),
                None
            );
            assert!(s.pending.is_none());
            assert!(s.generation > g);
            assert_eq!(s.epoch, Epoch::Untrimmed);
        }
    }
    #[test]
    fn dragging_postpones_same_trigger_while_off_screen() {
        for t in TRIGGERS {
            let mut s = IdleTrimScheduler::default();
            let now = Instant::now();
            let g = s.request(t, now).unwrap();
            assert_eq!(
                s.fire(
                    g,
                    now + t.delay(),
                    Admission {
                        dragging: true,
                        low: true,
                        ..Default::default()
                    }
                ),
                None
            );
            assert_eq!(s.pending, Some((t, now + t.delay() * 2)));
            assert_eq!(s.fire(g, now + t.delay() * 2, off_screen()), Some(t));
        }
    }
    #[test]
    fn startup_is_once_even_when_dropped_on_screen() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let g = s.request(Trigger::Startup, now).unwrap();
        assert_eq!(
            s.fire(g, now + Duration::from_secs(8), Admission::default()),
            None
        );
        assert_eq!(
            s.request(Trigger::Startup, now + Duration::from_secs(9)),
            None
        );
        assert!(s.pending.is_none());
    }
    #[test]
    fn low_epoch_trims_once_and_activation_reopens() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let g = s.request(Trigger::Hidden, now).unwrap();
        assert_eq!(
            s.fire(g, now + Duration::from_secs(3), off_screen()),
            Some(Trigger::Hidden)
        );
        assert_eq!(s.epoch, Epoch::Low);
        for t in TRIGGERS {
            assert_eq!(s.request(t, now), None);
        }
        s.activate();
        let g = s.request(Trigger::Minimized, now).unwrap();
        assert_eq!(
            s.fire(g, now + Duration::from_secs(3), off_screen()),
            Some(Trigger::Minimized)
        );
    }
    #[test]
    fn resize_only_acts_on_edges() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let g = s.request(Trigger::Startup, now).unwrap();
        assert_eq!(s.resize(&visible()), None);
        assert_eq!(s.generation, g);
        assert!(s.pending.is_some());
        assert_eq!(
            s.resize(&minimized()),
            Some(Edge::Request(Trigger::Minimized))
        );
        assert_eq!(s.resize(&minimized()), None);
        assert_eq!(s.resize(&visible()), Some(Edge::Activate));
        assert_eq!(s.resize(&visible()), None);
    }
    #[test]
    fn destroyed_reevaluates_branches_and_non_tray_exit() {
        let mut s = IdleTrimScheduler::default();
        assert_eq!(
            s.destroyed("A", &Windows::default(), true),
            Some(Trigger::Hidden)
        );
        assert_eq!(s.destroyed("A", &Windows::default(), false), None);
        assert_eq!(
            s.destroyed("A", &minimized(), false),
            Some(Trigger::Minimized)
        );
        // A window still on screen means no trim, focused or not.
        assert_eq!(s.destroyed("A", &visible(), false), None);
        assert_eq!(s.destroyed("A", &visible(), true), None);
        s.low_applied.insert("A".into());
        s.destroyed("A", &Windows::default(), true);
        assert!(s.low_applied.is_empty());
    }
    #[test]
    fn absent_app_state_does_not_accept_or_start_timer() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        assert_eq!(
            request_if_present::<()>(&mut s, None, Trigger::Startup, now),
            None
        );
        assert!(s.task.is_none());
        assert!(s.pending.is_none());
        assert!(!s.started);
        assert_eq!(s.generation, 0);
        assert!(request_if_present(&mut s, Some(&()), Trigger::Startup, now).is_some());
    }
    #[tokio::test]
    async fn memory_trim_drop_cancels_task_despite_task_owned_arc() {
        let state = MemoryTrim::default();
        let owner = state.0.clone();
        let g = owner
            .lock()
            .unwrap()
            .request(Trigger::Hidden, Instant::now())
            .unwrap();
        let held = owner.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        owner.lock().unwrap().task = Some(tauri::async_runtime::spawn(async move {
            let _held = held;
            let _tx = tx;
            let _ = started.send(());
            std::future::pending::<()>().await;
        }));
        ready.await.unwrap();
        drop(state);
        tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .unwrap()
            .unwrap_err();
        let s = owner.lock().unwrap();
        assert!(s.generation > g);
        assert!(s.pending.is_none());
        assert!(s.task.is_none());
    }
    #[tokio::test]
    async fn scheduler_drop_and_replacement_abort_owned_tasks() {
        for replace in [false, true] {
            let mut s = IdleTrimScheduler::default();
            let now = Instant::now();
            s.request(Trigger::Startup, now);
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            let (tx_ready, rx_ready) = tokio::sync::oneshot::channel();
            s.task = Some(tauri::async_runtime::spawn(async move {
                let _tx = tx;
                let _ = tx_ready.send(());
                std::future::pending::<()>().await;
            }));
            rx_ready.await.unwrap();
            if replace {
                s.request(Trigger::Hidden, now).unwrap();
            } else {
                drop(s);
            }
            tokio::time::timeout(Duration::from_secs(2), rx)
                .await
                .unwrap()
                .unwrap_err();
        }
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }
    #[test]
    fn browser_filter_requires_exact_image_and_direct_parent() {
        assert!(is_browser_child(7, 7, &wide("MSEDGEWEBVIEW2.EXE")));
        assert!(!is_browser_child(7, 8, &wide("msedgewebview2.exe")));
        assert!(!is_browser_child(7, 7, &wide("other.exe")));
        assert!(!is_browser_child(0, 0, &wide("msedgewebview2.exe")));
    }
    #[test]
    fn mcp_filter_requires_recorded_pid_direct_parent_and_exact_image() {
        assert!(is_mcp_child(
            Some(9),
            7,
            9,
            7,
            &wide("TERMFLOW-MCP-SERVER.EXE")
        ));
        for (recorded, pid, parent, image) in [
            (None, 9, 7, "termflow-mcp-server.exe"),
            (Some(9), 10, 7, "termflow-mcp-server.exe"),
            (Some(9), 9, 8, "termflow-mcp-server.exe"),
            (Some(9), 9, 7, "node.exe"),
            (Some(9), 9, 7, "termflow-pty-host.exe"),
        ] {
            assert!(!is_mcp_child(recorded, 7, pid, parent, &wide(image)));
        }
    }
    #[cfg(windows)]
    #[test]
    fn toolhelp_snapshot_and_current_test_process_trim_succeed() {
        let mut pids = std::collections::BTreeSet::new();
        platform::supplemental_processes(0, None, &mut pids).unwrap();
        assert!(pids.is_empty());
        assert_eq!(
            platform::trim_processes(&std::collections::BTreeSet::from([std::process::id()])),
            (1, 0)
        );
    }
}
