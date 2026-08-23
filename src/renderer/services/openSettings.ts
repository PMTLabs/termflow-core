import { store } from '../store';
import { addTab, setActiveTab } from '../store/slices/tabsSlice';
import { SETTINGS_SHELL_TYPE } from './tabKinds';

// A category the newly-opened SettingsPage should navigate to on mount (e.g. the
// tray "Peers…" item opens Settings pointed at Peers). Consumed exactly once by
// SettingsPage's mount effect — a fresh Settings tab isn't rendered yet when
// openSettingsTab returns, so a DOM event would race the mount; this hand-off is
// race-free. An already-open Settings tab is navigated via the DOM event below.
let pendingSettingsCategory: string | null = null;

/** Take (and clear) the pending category set by an `openSettingsTab(category)` call. */
export function consumePendingSettingsCategory(): string | null {
  const c = pendingSettingsCategory;
  pendingSettingsCategory = null;
  return c;
}

/**
 * Open (or activate) the Settings tab in THIS window's own store — the actual
 * tab-creation logic. Called directly when there's no Tauri bridge (tests, plain
 * browser dev server — only ever one window there), and otherwise only from
 * `installSettingsRouting` below, in whichever window the backend names as the
 * current main window.
 *
 * If a Settings tab is already open (in this window) it is simply activated (no
 * second tab); if it is already the active tab this is a no-op. No settings-dirty
 * guard is needed here — that guard only fires when *leaving* a dirty Settings
 * tab, and we are navigating *to* Settings.
 *
 * Pass `category` to also jump to a specific Settings section (mounted tab: via a
 * DOM event it already listens for; fresh tab: via the pending-category hand-off).
 */
function openSettingsLocally(category?: string): void {
  const { tabs } = store.getState().tabs;
  const existing = tabs.find(tab => tab.shellType === SETTINGS_SHELL_TYPE);

  if (existing) {
    if (!existing.isActive) {
      store.dispatch(setActiveTab(existing.id));
    }
    // The SettingsPage is already mounted — tell it to switch category.
    if (category) {
      window.dispatchEvent(new CustomEvent('settings:goto-category', { detail: category }));
    }
    return;
  }

  if (category) {
    pendingSettingsCategory = category;
  }
  store.dispatch(
    addTab({
      id: `tab-settings-${Date.now()}`,
      title: 'Settings',
      shellType: SETTINGS_SHELL_TYPE,
      icon: '⚙️',
    }),
  );
}

/**
 * Open the Settings page, enforcing a single instance AND a single HOST WINDOW.
 *
 * TermFlow supports multiple windows, each with its own independent Redux store —
 * without routing through one designated window, a Settings tab opened from
 * window B would only ever exist (and only ever apply its edits) there. Every
 * call instead asks the backend which window is currently "main" (the boot
 * window, or whichever window was promoted after it closed — see
 * `resolve_main_window_label` in state.rs) and broadcasts `settings:open`;
 * `installSettingsRouting` below is what actually opens/activates the tab, in
 * whichever window turns out to be the target, and the backend focuses that
 * window so the user sees it land regardless of where they triggered it from.
 *
 * Falls back to opening locally when there's no Tauri bridge (tests, plain
 * browser dev server) — there's only ever one window in that case anyway.
 */
export function openSettingsTab(category?: string): void {
  // No `window` at all outside a browser/webview (e.g. this module under a
  // node-environment unit test) — same "only one window anyway" case as no
  // Tauri bridge.
  const api = typeof window === 'undefined' ? undefined : window.electronAPI;
  if (!api?.openSettingsInMainWindow) {
    openSettingsLocally(category);
    return;
  }
  api.openSettingsInMainWindow(category).catch((err) => {
    console.error('openSettingsInMainWindow failed; opening locally instead', err);
    openSettingsLocally(category);
  });
}

let routingInstalled = false;

/**
 * Wire up THIS window to react to `settings:open` broadcasts (see
 * `openSettingsTab` above) — call once per window boot. Idempotent.
 */
export function installSettingsRouting(): void {
  if (routingInstalled) return;
  routingInstalled = true;
  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const myLabel = getCurrentWindow().label;
      await listen('settings:open', (event: any) => {
        const p = event?.payload;
        if (!p || typeof p !== 'object' || p.target !== myLabel) return;
        openSettingsLocally(typeof p.category === 'string' ? p.category : undefined);
      });
    } catch {
      // Not under Tauri — nothing to route (openSettingsTab already falls back
      // to opening locally in that case).
    }
  })();
}
