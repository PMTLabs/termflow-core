import { store } from '../store';
import { addTab, setActiveTab } from '../store/slices/tabsSlice';

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
 * Open the Settings page, enforcing a single instance.
 *
 * Settings is modelled as a tab with `shellType === 'settings'` (rendered by
 * SettingsPage in TerminalContainer). This is the ONE place that decides whether
 * to reuse the existing Settings tab or create a new one, so every entry point
 * (the Ctrl/Cmd+, hotkey, the New-Tab dropdown) keeps the invariant that at most
 * one Settings tab exists.
 *
 * If a Settings tab is already open it is simply activated (no second tab); if it
 * is already the active tab this is a no-op. No settings-dirty guard is needed
 * here — that guard only fires when *leaving* a dirty Settings tab, and we are
 * navigating *to* Settings.
 *
 * Pass `category` to also jump to a specific Settings section (mounted tab: via a
 * DOM event it already listens for; fresh tab: via the pending-category hand-off).
 */
export function openSettingsTab(category?: string): void {
  const { tabs } = store.getState().tabs;
  const existing = tabs.find(tab => tab.shellType === 'settings');

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
      shellType: 'settings',
      icon: '⚙️',
    }),
  );
}
