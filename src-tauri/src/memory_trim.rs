//! One visible trim and one subsequent LOW trim per quiet epoch (Windows only).
//! Shells keep running. This reduces resident working sets, not committed GPU memory.
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
    Deactivated,
}
impl Trigger {
    fn delay(self) -> Duration {
        Duration::from_secs(match self {
            Self::Startup => 8,
            Self::Deactivated => 15,
            _ => 3,
        })
    }
    #[cfg(windows)]
    fn name(self) -> &'static str {
        match self {
            Self::Startup => "startup",
            Self::Hidden => "hidden",
            Self::Minimized => "minimized",
            Self::Deactivated => "deactivated",
        }
    }
}
#[derive(Default, Debug, PartialEq, Eq)]
enum Epoch {
    #[default]
    Untrimmed,
    Visible,
    Low,
}
#[derive(Default)]
struct Admission {
    app_focused: bool,
    foreground: bool,
    low: bool,
    dragging: bool,
    stopping: bool,
    produced: u64,
}
#[derive(Default)]
struct Windows {
    count: usize,
    on_screen: bool,
    minimized: bool,
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
    focused: HashSet<String>,
    low_applied: HashSet<String>,
    started: bool,
    off_screen: bool,
    last_mark: u64,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}
impl IdleTrimScheduler {
    fn request(&mut self, trigger: Trigger, now: Instant, produced: u64) -> Option<u64> {
        if trigger == Trigger::Startup {
            if self.started {
                return None;
            }
            self.started = true;
        }
        if self.epoch == Epoch::Low
            || (self.epoch == Epoch::Visible
                && !matches!(trigger, Trigger::Hidden | Trigger::Minimized))
        {
            return None;
        }
        if self
            .pending
            .is_some_and(|(_, deadline)| deadline <= now + trigger.delay())
        {
            return None;
        }
        self.cancel();
        self.last_mark = produced;
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
    fn focus(&mut self, label: &str, focused: bool) {
        if focused {
            self.focused.insert(label.into());
            self.activate();
        } else {
            self.focused.remove(label);
        }
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
        self.focused.remove(label);
        self.low_applied.remove(label);
        self.off_screen = !windows.on_screen;
        if windows.count == 0 && !keep {
            self.cancel();
            return None;
        }
        if windows.count == 0 && keep {
            Some(Trigger::Hidden)
        } else if !windows.on_screen && windows.minimized {
            Some(Trigger::Minimized)
        } else if self.focused.is_empty() && windows.on_screen {
            Some(Trigger::Deactivated)
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
        let output_seen = adm.produced != self.last_mark;
        self.last_mark = adm.produced;
        if adm.stopping || adm.app_focused || adm.foreground {
            self.abandon(generation);
            return None;
        }
        if adm.dragging || (output_seen && !adm.low) {
            self.pending = Some((trigger, now + trigger.delay()));
            return None;
        }
        self.abandon(generation);
        if self.epoch == Epoch::Low || (self.epoch == Epoch::Visible && !adm.low) {
            return None;
        }
        self.off_screen = adm.low;
        self.epoch = if adm.low { Epoch::Low } else { Epoch::Visible };
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
    produced: u64,
) -> Option<u64> {
    if let Some(windows) = windows {
        sync_off_screen(scheduler, windows);
    }
    request_if_present(scheduler, state, trigger, now, produced)
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
    produced: u64,
) -> Option<u64> {
    state?;
    scheduler.request(trigger, now, produced)
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
            UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GA_ROOT},
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
            result.count += 1;
            let visible = w.is_visible().ok()?;
            let minimized = w.is_minimized().ok()?;
            result.on_screen |= visible && !minimized;
            result.minimized |= minimized;
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
        let app = window.app_handle();
        let Some(s) = scheduler(app) else {
            return;
        };
        s.lock().unwrap().focus(window.label(), focused);
        if focused {
            memory_target(app, false);
        } else {
            let none_focused = s.lock().unwrap().focused.is_empty();
            if none_focused && census(app, None).is_some_and(|w| w.on_screen) {
                request(app, Trigger::Deactivated);
            }
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
        // Remove stale labels even if querying a remaining window fails.
        {
            let mut s = s.lock().unwrap();
            s.focused.remove(window.label());
            s.low_applied.remove(window.label());
        }
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
        let (generation, produced, exiting, recovering, restarting, keys) = {
            let state = app.try_state::<AppState>();
            let generation = request_with_census(
                &mut scheduler.lock().unwrap(),
                windows.as_ref(),
                state.as_deref(),
                trigger,
                Instant::now(),
                state
                    .as_ref()
                    .map_or(0, |s| s.output_produced.load(Ordering::Relaxed)),
            );
            let (Some(generation), Some(state)) = (generation, state) else {
                return;
            };
            (
                generation,
                state.output_produced.clone(),
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
                let produced = produced.clone();
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
                        let foreground = unsafe { GetAncestor(GetForegroundWindow(), GA_ROOT) };
                        let mut is_foreground = false;
                        for w in real(&handle) {
                            let Ok(hwnd) = w.hwnd() else {
                                admission.lock().unwrap().abandon(generation);
                                return;
                            };
                            is_foreground |= hwnd == foreground;
                        }
                        let stopping = exiting.load(Ordering::Relaxed)
                            || recovering.load(Ordering::Relaxed)
                            || restarting.load(Ordering::Relaxed);
                        let dragging = keys.pane_drag_active()
                            || handle
                                .get_webview_window(PREVIEW_LABEL)
                                .is_some_and(|w| w.is_visible().unwrap_or(false));
                        let trigger = {
                            let mut s = admission.lock().unwrap();
                            let app_focused = !s.focused.is_empty();
                            s.fire(
                                generation,
                                Instant::now(),
                                Admission {
                                    app_focused,
                                    foreground: is_foreground,
                                    low: !windows.on_screen,
                                    dragging,
                                    stopping,
                                    produced: produced.load(Ordering::Relaxed),
                                },
                            )
                        };
                        if let Some(trigger) = trigger {
                            trim(&handle, trigger, !windows.on_screen);
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
    fn trim(app: &AppHandle, trigger: Trigger, low: bool) {
        if low {
            memory_target(app, true);
        }
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
            low,
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
                    finish_trim(trigger, low, start, browser, mcp, pids, "webview");
                })
                .is_err()
            {
                dispatch_failed();
            }
        }
    }
    fn finish_trim(
        trigger: Trigger,
        low: bool,
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
            "memory_trim: part={} trigger={} low={} processes={} trimmed={} failed={} elapsed_ms={}",
            part,
            trigger.name(),
            low,
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
    const TRIGGERS: [Trigger; 4] = [
        Trigger::Startup,
        Trigger::Hidden,
        Trigger::Minimized,
        Trigger::Deactivated,
    ];
    fn quiet(low: bool, produced: u64) -> Admission {
        Admission {
            low,
            produced,
            ..Default::default()
        }
    }
    #[test]
    fn review_regressions() {
        let now = Instant::now();
        let mut s = IdleTrimScheduler::default();
        let g = s.request(Trigger::Hidden, now, 1).unwrap();
        assert_eq!(s.request(Trigger::Hidden, now, 2), None);
        assert_eq!(s.last_mark, 1);
        assert_eq!(
            s.fire(g, now + Duration::from_secs(2), quiet(false, 2)),
            None
        );
        assert_eq!(s.last_mark, 1);
        assert_eq!(
            s.fire(
                g,
                now + Duration::from_secs(3),
                Admission {
                    dragging: true,
                    produced: 1,
                    ..Default::default()
                }
            ),
            None
        );
        assert!(s.pending.is_some());
        assert_eq!(
            s.fire(g, now + Duration::from_secs(6), quiet(true, 1)),
            Some(Trigger::Hidden)
        );
        assert!(s.off_screen);
        assert_eq!(s.epoch, Epoch::Low);
        s.activate();
        assert!(!s.off_screen);
        assert_eq!(s.epoch, Epoch::Untrimmed);
        assert!(keep_low(&Epoch::Low));
        assert!(!keep_low(&Epoch::Visible));
        assert!(!keep_low(&Epoch::Untrimmed));
        s.low_applied.extend(["A".into(), "B".into()]);
        s.focused.insert("B".into());
        let visible = Windows {
            count: 1,
            on_screen: true,
            minimized: false,
        };
        assert_eq!(s.destroyed("A", &visible, true), None);
        assert!(s.low_applied.contains("B"));
        let minimized = Windows {
            count: 1,
            on_screen: false,
            minimized: true,
        };
        assert_eq!(s.destroyed("A", &minimized, true), Some(Trigger::Minimized));
        let g = s.request(Trigger::Hidden, now, 0).unwrap();
        assert_eq!(s.destroyed("B", &Windows::default(), false), None);
        assert!(s.generation > g);
        assert!(s.pending.is_none());
        s.epoch = Epoch::Low;
        assert_eq!(
            request_with_census(&mut s, Some(&minimized), Some(&()), Trigger::Hidden, now, 0),
            None
        );
        assert!(s.off_screen);
        sync_off_screen(&mut s, &visible);
        assert!(!s.off_screen);
        let mut pids = std::collections::BTreeSet::new();
        insert_nonzero(&mut pids, 0);
        insert_nonzero(&mut pids, 7);
        assert_eq!(pids, std::collections::BTreeSet::from([7]));
        let mut image = wide("msedgewebview2.exe");
        image.extend([65, 66]);
        assert!(image_is(&image, "msedgewebview2.exe"));
    }
    #[test]
    fn exact_delays_and_no_early_fire() {
        for (t, seconds) in TRIGGERS.into_iter().zip([8, 3, 3, 15]) {
            let mut s = IdleTrimScheduler::default();
            let now = Instant::now();
            let g = s.request(t, now, 9).unwrap();
            let deadline = now + Duration::from_secs(seconds);
            assert_eq!(s.pending, Some((t, deadline)));
            assert_eq!(
                s.fire(g, deadline - Duration::from_millis(1), quiet(false, 9)),
                None
            );
            assert_eq!(s.pending, Some((t, deadline)));
            assert_eq!(s.fire(g, deadline, quiet(false, 9)), Some(t));
            assert!(s.pending.is_none());
        }
    }
    #[test]
    fn shorter_replaces_longer_and_stale_generation_cannot_fire() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let old = s.request(Trigger::Deactivated, now, 0).unwrap();
        let new = s
            .request(Trigger::Minimized, now + Duration::from_secs(1), 4)
            .unwrap();
        assert!(new > old);
        assert_eq!(
            s.fire(old, now + Duration::from_secs(20), quiet(true, 4)),
            None
        );
        assert_eq!(
            s.fire(new, now + Duration::from_secs(4), quiet(true, 4)),
            Some(Trigger::Minimized)
        );
    }
    #[test]
    fn rejected_requests_do_not_push_deadline_or_overwrite_output_mark() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let g = s.request(Trigger::Startup, now, 1).unwrap();
        assert_eq!(
            s.request(Trigger::Deactivated, now + Duration::from_secs(2), 2),
            None
        );
        assert_eq!(
            s.request(Trigger::Hidden, now + Duration::from_secs(6), 3),
            None
        );
        assert_eq!(s.last_mark, 1);
        assert_eq!(
            s.pending,
            Some((Trigger::Startup, now + Duration::from_secs(8)))
        );
        assert_eq!(
            s.fire(g, now + Duration::from_secs(8), quiet(false, 3)),
            None
        );
        assert_eq!(s.last_mark, 3);
        assert_eq!(s.pending.unwrap().1, now + Duration::from_secs(16));
    }
    #[test]
    fn activation_alone_invalidates_generation_and_reopens_epoch() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let g = s.request(Trigger::Hidden, now, 0).unwrap();
        s.activate();
        assert!(s.generation > g);
        assert!(s.pending.is_none());
        assert_eq!(
            s.fire(g, now + Duration::from_secs(3), quiet(true, 0)),
            None
        );
        assert_eq!(s.epoch, Epoch::Untrimmed);
    }
    #[test]
    fn focused_and_foreground_drop_every_trigger_without_consuming_epoch() {
        for t in TRIGGERS {
            for foreground in [false, true] {
                let mut s = IdleTrimScheduler::default();
                let now = Instant::now();
                let g = s.request(t, now, 0).unwrap();
                // Output and dragging must NOT override the focus drop.
                let adm = Admission {
                    app_focused: !foreground,
                    foreground,
                    dragging: true,
                    produced: 1,
                    ..Default::default()
                };
                assert_eq!(s.fire(g, now + t.delay(), adm), None);
                assert!(s.pending.is_none());
                assert!(s.generation > g);
                assert_eq!(s.epoch, Epoch::Untrimmed);
                let later = now + Duration::from_secs(20);
                let g = s.request(Trigger::Deactivated, later, 1).unwrap();
                assert_eq!(
                    s.fire(g, later + Duration::from_secs(14), quiet(false, 1)),
                    None
                );
                assert_eq!(
                    s.fire(g, later + Duration::from_secs(15), quiet(false, 1)),
                    Some(Trigger::Deactivated)
                );
            }
        }
    }
    #[test]
    fn stopping_drops_even_with_output_and_drag() {
        for t in TRIGGERS {
            let mut s = IdleTrimScheduler::default();
            let now = Instant::now();
            let g = s.request(t, now, 0).unwrap();
            assert_eq!(
                s.fire(
                    g,
                    now + t.delay(),
                    Admission {
                        stopping: true,
                        dragging: true,
                        produced: 1,
                        ..Default::default()
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
    fn dragging_postpones_same_trigger_even_when_low() {
        for t in TRIGGERS {
            let mut s = IdleTrimScheduler::default();
            let now = Instant::now();
            let g = s.request(t, now, 0).unwrap();
            assert_eq!(
                s.fire(
                    g,
                    now + t.delay(),
                    Admission {
                        dragging: true,
                        low: true,
                        produced: 2,
                        ..Default::default()
                    }
                ),
                None
            );
            assert_eq!(s.pending, Some((t, now + t.delay() * 2)));
            assert_eq!(s.last_mark, 2);
            assert_eq!(s.fire(g, now + t.delay() * 2, quiet(true, 2)), Some(t));
        }
    }
    #[test]
    fn output_needs_a_full_quiet_window_and_postpone_updates_mark() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let t = Trigger::Deactivated;
        let g = s.request(t, now, 10).unwrap();
        assert_eq!(s.fire(g, now + t.delay(), quiet(false, 11)), None);
        assert_eq!(s.last_mark, 11);
        assert_eq!(s.fire(g, now + t.delay() * 2, quiet(false, 12)), None);
        assert_eq!(s.last_mark, 12);
        assert_eq!(
            s.fire(
                g,
                now + t.delay() * 3 - Duration::from_millis(1),
                quiet(false, 12)
            ),
            None
        );
        assert_eq!(s.fire(g, now + t.delay() * 3, quiet(false, 12)), Some(t));
    }
    #[test]
    fn output_while_low_does_not_block_any_trigger() {
        for t in TRIGGERS {
            let mut s = IdleTrimScheduler::default();
            let now = Instant::now();
            let g = s.request(t, now, 0).unwrap();
            assert_eq!(s.fire(g, now + t.delay(), quiet(true, 100)), Some(t));
            assert_eq!(s.last_mark, 100);
            assert_eq!(s.epoch, Epoch::Low);
        }
    }
    #[test]
    fn startup_is_once_even_after_focus_drop() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let g = s.request(Trigger::Startup, now, 0).unwrap();
        s.fire(
            g,
            now + Duration::from_secs(8),
            Admission {
                foreground: true,
                ..Default::default()
            },
        );
        assert_eq!(
            s.request(Trigger::Startup, now + Duration::from_secs(9), 0),
            None
        );
        assert!(s.pending.is_none());
    }
    #[test]
    fn visible_to_low_escalates_once_and_activation_reopens() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let g = s.request(Trigger::Deactivated, now, 0).unwrap();
        assert_eq!(
            s.fire(g, now + Duration::from_secs(15), quiet(false, 0)),
            Some(Trigger::Deactivated)
        );
        assert_eq!(s.epoch, Epoch::Visible);
        assert_eq!(s.request(Trigger::Deactivated, now, 0), None);
        let g = s
            .request(Trigger::Hidden, now + Duration::from_secs(16), 0)
            .unwrap();
        assert_eq!(
            s.fire(g, now + Duration::from_secs(19), quiet(true, 0)),
            Some(Trigger::Hidden)
        );
        assert_eq!(s.epoch, Epoch::Low);
        for t in TRIGGERS {
            assert_eq!(s.request(t, now, 0), None);
        }
        s.activate();
        let g = s.request(Trigger::Deactivated, now, 0).unwrap();
        assert_eq!(
            s.fire(g, now + Duration::from_secs(15), quiet(false, 0)),
            Some(Trigger::Deactivated)
        );
    }
    #[test]
    fn pending_low_trigger_cannot_repeat_visible_trim() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let g = s.request(Trigger::Deactivated, now, 0).unwrap();
        s.fire(g, now + Duration::from_secs(15), quiet(false, 0));
        let g = s.request(Trigger::Minimized, now, 0).unwrap();
        assert_eq!(
            s.fire(g, now + Duration::from_secs(3), quiet(false, 0)),
            None
        );
        assert!(s.pending.is_none());
        assert!(s.generation > g);
        assert_eq!(s.epoch, Epoch::Visible);
    }
    #[test]
    fn focus_switch_cancels_and_destroy_removes_focused_label_and_cache() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        s.focus("A", true);
        s.focus("B", true);
        s.focus("A", false);
        assert_eq!(s.focused, HashSet::from(["B".into()]));
        s.focus("B", false);
        let g = s.request(Trigger::Deactivated, now, 0).unwrap();
        s.focus("A", true);
        assert_eq!(
            s.fire(g, now + Duration::from_secs(15), quiet(false, 0)),
            None
        );
        s.low_applied.insert("A".into());
        s.destroyed("A", &Windows::default(), true);
        assert!(s.focused.is_empty());
        assert!(s.low_applied.is_empty());
    }
    #[test]
    fn resize_only_acts_on_edges() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        let g = s.request(Trigger::Deactivated, now, 0).unwrap();
        let visible = Windows {
            count: 1,
            on_screen: true,
            minimized: false,
        };
        assert_eq!(s.resize(&visible), None);
        assert_eq!(s.generation, g);
        assert!(s.pending.is_some());
        let minimized = Windows {
            count: 1,
            on_screen: false,
            minimized: true,
        };
        assert_eq!(
            s.resize(&minimized),
            Some(Edge::Request(Trigger::Minimized))
        );
        assert_eq!(s.resize(&minimized), None);
        assert_eq!(s.resize(&visible), Some(Edge::Activate));
        assert_eq!(s.resize(&visible), None);
    }
    #[test]
    fn destroyed_reevaluates_all_three_branches_and_non_tray_exit() {
        let mut s = IdleTrimScheduler::default();
        assert_eq!(
            s.destroyed("A", &Windows::default(), true),
            Some(Trigger::Hidden)
        );
        assert_eq!(s.destroyed("A", &Windows::default(), false), None);
        assert_eq!(
            s.destroyed(
                "A",
                &Windows {
                    count: 1,
                    minimized: true,
                    on_screen: false
                },
                false
            ),
            Some(Trigger::Minimized)
        );
        let visible = Windows {
            count: 1,
            on_screen: true,
            minimized: false,
        };
        s.focus("A", true);
        assert_eq!(
            s.destroyed("A", &visible, false),
            Some(Trigger::Deactivated)
        );
        s.focus("B", true);
        assert_eq!(s.destroyed("A", &visible, false), None);
    }
    #[test]
    fn absent_app_state_does_not_accept_or_start_timer() {
        let mut s = IdleTrimScheduler::default();
        let now = Instant::now();
        assert_eq!(
            request_if_present::<()>(&mut s, None, Trigger::Startup, now, 0),
            None
        );
        assert!(s.task.is_none());
        assert!(s.pending.is_none());
        assert!(!s.started);
        assert_eq!(s.generation, 0);
        assert!(request_if_present(&mut s, Some(&()), Trigger::Startup, now, 0).is_some());
    }
    #[tokio::test]
    async fn memory_trim_drop_cancels_task_despite_task_owned_arc() {
        let state = MemoryTrim::default();
        let owner = state.0.clone();
        let g = owner
            .lock()
            .unwrap()
            .request(Trigger::Hidden, Instant::now(), 0)
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
            s.request(Trigger::Deactivated, now, 0);
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            let (tx_ready, rx_ready) = tokio::sync::oneshot::channel();
            s.task = Some(tauri::async_runtime::spawn(async move {
                let _tx = tx;
                let _ = tx_ready.send(());
                std::future::pending::<()>().await;
            }));
            rx_ready.await.unwrap();
            if replace {
                s.request(Trigger::Hidden, now, 0).unwrap();
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
