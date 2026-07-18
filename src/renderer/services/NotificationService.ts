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
import { addToast } from '../store/slices/uiSlice';
import { setActiveTab } from '../store/slices/tabsSlice';
import { NOTIF_SETTLE_MS, shouldNotify } from './notificationLogic';
import { ACTIVITY_CHIME_DATA_URI } from '../assets/activityChime';
import { isWindowFocused, onWindowFocusChange, startWindowFocusTracking } from './windowFocus';

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
  // Tabs we requested an OS notification for while this window was unfocused, still
  // unseen. On focus regain we switch to the most recent — the "return to the app and
  // land on the right tab" path (desktop notification plugins expose no click callback).
  private pendingOsTabs: string[] = [];
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

    this.cleanups.push(onWindowFocusChange((focused) => {
      if (focused) this.routePendingOnFocus();
    }));
  }

  stop(): void {
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.pendingOsTabs = [];
    this.lastSoundAt = -Infinity;
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
      store.dispatch(addToast({ message: `New activity in "${tabTitle}"`, type: 'info' }));
    }
    if (s.notifyOsEnabled && !isWindowFocused()) {
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
      const shown = await invoke<boolean>('show_activity_notification', {
        windowLabel: getCurrentWindow().label,
        tabId,
        title: `Activity in "${tabTitle}"`,
      });
      // Queue for return-to-app routing ONLY when a toast was actually shown (backend
      // suppresses it if any window is focused). Otherwise a later, unrelated re-focus
      // would force-switch to a tab the user was never notified about.
      if (shown) this.pendingOsTabs = [...this.pendingOsTabs.filter((id) => id !== tabId), tabId];
    } catch (e) {
      console.error('NotificationService: OS notification failed', e);
    }
  }

  private routePendingOnFocus(): void {
    if (this.pendingOsTabs.length === 0) return;
    const tabs = store.getState().tabs.tabs;
    // Only tabs that are still unseen (user hasn't already opened them another way),
    // most-recent last.
    const stillUnseen = this.pendingOsTabs.filter((id) =>
      tabs.some((t) => t.id === id && t.hasUnseenOutput),
    );
    this.pendingOsTabs = [];
    const target = stillUnseen[stillUnseen.length - 1];
    if (target) store.dispatch(setActiveTab(target));
  }
}

export const notificationService = new NotificationService();
