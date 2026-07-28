// Activity notification service (Stream 1). Listens for `activity:bell` events (emitted
// by RunningActivityTracker ONLY for background tabs that pass all its suppression) and
// fires the user's enabled channels: an in-app chime, an in-app toast, and/or an OS
// notification when no app window is focused.
//
// Channels are independent (each gated by its own setting). De-dup is inherent: the
// tracker rings each tab's bell at most once per unseen episode. A causal-time gate
// (see notificationLogic) keeps the service quiet until the app has settled after
// startup and during repaint bursts.
import { store } from '../store';
import { addToast, dismissTabToasts } from '../store/slices/uiSlice';
import { NOTIF_SETTLE_MS, shouldNotify } from './notificationLogic';
import { ACTIVITY_CHIME_DATA_URI } from '../assets/activityChime';
import { startWindowFocusTracking } from './windowFocus';

const SOUND_THROTTLE_MS = 1500; // min gap between chimes so a flurry doesn't machine-gun
const BURST_MS = 1500; // suppress notifications this long after a visibility/session burst

interface BellDetail {
  tabId: string;
  causalTime: number;
}

class NotificationService {
  private started = false;
  private settleUntil = 0;
  private burstUntil = 0;
  private audio: HTMLAudioElement | null = null;
  private lastSoundAt = -Infinity;
  private lastActiveTabId: string | null = null; // to detect activeTab changes
  // NOTE: this service never changes the active tab. Navigating to the belled tab is
  // reserved for an explicit click on the OS notification, which the backend reports as
  // `notification:activated` (handled in App.tsx). Returning to the app by any other
  // means — clicking the window, alt-tab, restoring from the taskbar — must leave the
  // user exactly where they were working.
  private cleanups: Array<() => void> = [];

  start(): void {
    if (this.started) return;
    this.started = true;
    this.settleUntil = Date.now() + NOTIF_SETTLE_MS;
    void startWindowFocusTracking();

    const onBell = (e: Event) => this.handleBell((e as CustomEvent).detail as BellDetail);
    window.addEventListener('activity:bell', onBell);
    this.cleanups.push(() => window.removeEventListener('activity:bell', onBell));

    // Bump the burst gate on the same signals the tracker uses, as belt-and-suspenders
    // on causal time (a repaint burst just after settle shouldn't slip through).
    const onVis = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        this.burstUntil = Date.now() + BURST_MS;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', onVis));

    // A window resize sends SIGWINCH → every TUI repaints; the tracker suppresses that
    // for the sweep/bell, so mirror it here too (a 1–2 tab repaint below the tracker's
    // batch threshold could otherwise clear the gate and fire a spurious sound/toast).
    const onResize = () => { this.burstUntil = Date.now() + BURST_MS; };
    window.addEventListener('resize', onResize);
    this.cleanups.push(() => window.removeEventListener('resize', onResize));

    // Once the user opens a tab (via the OS-notification click or a plain tab click),
    // its in-app activity toast is redundant — dismiss it so the
    // sticky toast doesn't linger after the activity has been seen. The store fires on
    // every change; we act only when activeTabId actually changes to a tab that still
    // has a toast (avoids needless re-renders).
    this.lastActiveTabId = store.getState().tabs.activeTabId;
    const unsubActive = store.subscribe(() => {
      const active = store.getState().tabs.activeTabId;
      if (active === this.lastActiveTabId) return;
      this.lastActiveTabId = active;
      if (active && store.getState().ui.toasts.some((t) => t.tabId === active)) {
        store.dispatch(dismissTabToasts({ tabId: active }));
      }
    });
    this.cleanups.push(unsubActive);
  }

  stop(): void {
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.lastSoundAt = -Infinity;
    this.lastActiveTabId = null;
    this.burstUntil = 0;
    if (this.audio) {
      try { this.audio.pause(); } catch { /* ignore */ }
      this.audio = null;
    }
    this.started = false;
  }

  /** External signal (from App's session:reconnect listener) that a repaint burst is
   *  under way — suppress notifications briefly, matching the tracker. */
  notifyReconnectBurst(): void {
    this.burstUntil = Date.now() + BURST_MS;
  }

  private handleBell(detail: BellDetail): void {
    if (!detail || typeof detail.tabId !== 'string') return;
    if (!shouldNotify(detail.causalTime, { settleUntil: this.settleUntil, burstUntil: this.burstUntil })) {
      return;
    }
    const s = store.getState().settings;
    const tabTitle = store.getState().tabs.tabs.find((t) => t.id === detail.tabId)?.title ?? 'a terminal';

    if (s.notifySoundEnabled) this.playChime();
    if (s.notifyToastEnabled) {
      // Sticky + tagged with the tab: it stays until the user clicks to close OR opens
      // the tab (see the activeTab subscription in start()), so a notification that
      // arrives while they're away isn't missed on return, yet doesn't linger once seen.
      store.dispatch(addToast({
        message: `New activity in "${tabTitle}"`,
        type: 'info',
        sticky: true,
        tabId: detail.tabId,
      }));
    }
    if (s.notifyOsEnabled) {
      // Do NOT pre-gate on this window's isWindowFocused(): that per-window cached flag
      // (windowFocus.ts, seeded true + updated only via onFocusChanged) can get stuck
      // true — a missed/late focus event, a multi-window setup, or an init race — and
      // would then silently drop EVERY OS notification. The backend
      // (show_activity_notification) does the AUTHORITATIVE app-wide focus check and
      // skips the notification when any window is focused, so double-notify is still
      // prevented.
      this.showOsNotification(detail.tabId, tabTitle);
    }
  }

  private playChime(): void {
    const now = Date.now();
    if (now - this.lastSoundAt < SOUND_THROTTLE_MS) return;
    this.lastSoundAt = now;
    try {
      if (!this.audio) {
        this.audio = new Audio(ACTIVITY_CHIME_DATA_URI);
        this.audio.volume = 0.5;
      }
      this.audio.currentTime = 0;
      void this.audio.play().catch(() => { /* autoplay/user-gesture policy — ignore */ });
    } catch {
      /* Audio unavailable — ignore */
    }
  }

  private async showOsNotification(tabId: string, tabTitle: string): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      // The return value is deliberately ignored. It reports only that a notification was
      // *attempted* (false = suppressed because a window was focused) — no platform here
      // can confirm the user saw one, so there is nothing to act on. The destination
      // travels with the notification itself, so only a real click on it moves the user.
      await invoke<boolean>('show_activity_notification', {
        windowLabel: getCurrentWindow().label,
        tabId,
        title: `Activity in "${tabTitle}"`,
      });
    } catch (e) {
      console.error('NotificationService: OS notification failed', e);
    }
  }
}

export const notificationService = new NotificationService();
