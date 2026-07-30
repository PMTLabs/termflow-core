/**
 * @jest-environment jsdom
 */
import { NOTIF_SETTLE_MS } from '../notificationLogic';

const dispatch = jest.fn();
const mockState: {
  settings: { notifySoundEnabled: boolean; notifyToastEnabled: boolean; notifyOsEnabled: boolean };
  tabs: { activeTabId: string | null; tabs: Array<{ id: string; title: string; hasUnseenOutput?: boolean }> };
  ui: { toasts: Array<{ id: string; tabId?: string; message?: string }> };
} = {
  settings: { notifySoundEnabled: false, notifyToastEnabled: false, notifyOsEnabled: false },
  tabs: { activeTabId: null, tabs: [{ id: 'tb-1', title: 'build', hasUnseenOutput: true }] },
  ui: { toasts: [] },
};

// Holder so tests can fire the store-change callback the service subscribes with.
const storeSub: { cb: (() => void) | null } = { cb: null };

jest.mock('../../store', () => ({
  store: {
    dispatch,
    getState: () => mockState,
    subscribe: (cb: () => void) => { storeSub.cb = cb; return () => { storeSub.cb = null; }; },
  },
}));
jest.mock('../../store/slices/uiSlice', () => ({
  addToast: (p: unknown) => ({ type: 'ui/addToast', payload: p }),
  dismissTabToasts: (p: unknown) => ({ type: 'ui/dismissTabToasts', payload: p }),
}));
jest.mock('../../store/slices/tabsSlice', () => ({
  setActiveTab: (id: string) => ({ type: 'tabs/setActiveTab', payload: id }),
}));
jest.mock('../../assets/activityChime', () => ({ ACTIVITY_CHIME_DATA_URI: 'data:audio/wav;base64,AAAA' }));

const invokeMock = jest.fn().mockResolvedValue(true);
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
jest.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));

import { notificationService } from '../NotificationService';

const playMock = jest.fn().mockResolvedValue(undefined);
beforeAll(() => {
  (global as any).Audio = jest.fn().mockImplementation(() => ({ play: playMock, volume: 0, currentTime: 0 }));
});

function bell(tabId: string, causalTime: number): void {
  window.dispatchEvent(new CustomEvent('activity:bell', { detail: { tabId, causalTime } }));
}
const AFTER_SETTLE = () => Date.now() + NOTIF_SETTLE_MS + 5000;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('NotificationService — in-app channels', () => {
  beforeEach(() => {
    dispatch.mockClear();
    playMock.mockClear();
    mockState.settings = { notifySoundEnabled: false, notifyToastEnabled: false, notifyOsEnabled: false };
    mockState.tabs = { activeTabId: null, tabs: [{ id: 'tb-1', title: 'build', hasUnseenOutput: true }] };
    mockState.ui = { toasts: [] };
    notificationService.stop();
    notificationService.start();
  });
  afterEach(() => notificationService.stop());

  it('does not fire before the startup settle window (causal time too early)', () => {
    mockState.settings.notifyToastEnabled = true;
    bell('tb-1', 0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fires a sticky, tab-tagged in-app toast naming the tab when enabled and settled', () => {
    mockState.settings.notifyToastEnabled = true;
    bell('tb-1', AFTER_SETTLE());
    const toast = dispatch.mock.calls.map(([a]) => a).find((a) => a.type === 'ui/addToast');
    expect(toast?.payload.message).toContain('build');
    // Activity toasts stay until the user clicks to close (sticky: no auto-dismiss)...
    expect(toast?.payload.sticky).toBe(true);
    // ...and are tagged with their tab so opening it auto-dismisses the toast.
    expect(toast?.payload.tabId).toBe('tb-1');
  });

  it('dismisses a tab\'s in-app toast when that tab becomes active (e.g. OS-notification click)', () => {
    // A toast exists for tb-1; the user opens tb-1 (activeTabId changes) → dismiss it.
    mockState.ui.toasts = [{ id: 'x', tabId: 'tb-1', message: 'New activity in "build"' }];
    mockState.tabs.activeTabId = 'tb-1';
    storeSub.cb?.(); // simulate the store change reaching the service
    const dismiss = dispatch.mock.calls.map(([a]) => a).find((a) => a.type === 'ui/dismissTabToasts');
    expect(dismiss?.payload.tabId).toBe('tb-1');
  });

  it('does NOT dismiss when the newly active tab has no toast (no needless dispatch)', () => {
    mockState.ui.toasts = [{ id: 'x', tabId: 'tb-1' }];
    mockState.tabs.activeTabId = 'tb-2'; // a different tab, no toast for it
    storeSub.cb?.();
    const dismiss = dispatch.mock.calls.map(([a]) => a).find((a) => a.type === 'ui/dismissTabToasts');
    expect(dismiss).toBeUndefined();
  });

  it('plays the chime when sound is enabled, throttling repeats', () => {
    mockState.settings.notifySoundEnabled = true;
    bell('tb-1', AFTER_SETTLE());
    bell('tb-1', AFTER_SETTLE());
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('fires nothing when all channels are disabled', () => {
    bell('tb-1', AFTER_SETTLE());
    expect(dispatch).not.toHaveBeenCalled();
    expect(playMock).not.toHaveBeenCalled();
  });
});

describe('NotificationService — OS notification (never steals the active tab)', () => {
  beforeEach(() => {
    dispatch.mockClear();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(true);
    mockState.settings = { notifySoundEnabled: false, notifyToastEnabled: false, notifyOsEnabled: true };
    mockState.tabs = { activeTabId: null, tabs: [{ id: 'tb-1', title: 'build', hasUnseenOutput: true }] };
    mockState.ui = { toasts: [] };
    notificationService.stop();
    notificationService.start();
  });
  afterEach(() => notificationService.stop());

  it('requests an OS notification when a background-tab bell fires', async () => {
    bell('tb-1', AFTER_SETTLE());
    await flush();
    expect(invokeMock).toHaveBeenCalledWith('show_activity_notification', expect.objectContaining({ tabId: 'tb-1' }));
  });

  it('does not pre-gate on renderer focus state (the backend is the authority)', async () => {
    // The renderer must not try to second-guess whether the app is focused: a stale
    // per-window flag would silently drop every OS notification. The backend does the
    // authoritative app-wide check.
    bell('tb-1', AFTER_SETTLE());
    await flush();
    expect(invokeMock).toHaveBeenCalledWith('show_activity_notification', expect.objectContaining({ tabId: 'tb-1' }));
  });

  // THE INVARIANT: this service never changes the active tab, by any mechanism.
  //
  // It used to switch tabs whenever the window regained focus, so clicking the app
  // window yanked the user off the tab they were working in. Returning to the app is not
  // consent to be moved. Navigation belongs solely to an explicit click on the OS
  // notification, which arrives as the backend's `notification:activated` event and is
  // handled in App.tsx.
  //
  // Asserted against the whole surface rather than against a focus listener specifically:
  // the old test could only catch a refocus regression, while this catches ANY future
  // mechanism that reintroduces auto-navigation here.
  it('never dispatches setActiveTab, through any path', async () => {
    // Drive everything the service reacts to: a bell with all channels on, a shown
    // notification, a suppressed one, and a store change.
    mockState.settings = { notifySoundEnabled: true, notifyToastEnabled: true, notifyOsEnabled: true };
    bell('tb-1', AFTER_SETTLE());
    await flush();

    invokeMock.mockResolvedValue(false); // backend suppressed it (a window was focused)
    bell('tb-1', AFTER_SETTLE());
    await flush();

    mockState.tabs = { activeTabId: 'tb-1', tabs: [{ id: 'tb-1', title: 'build', hasUnseenOutput: true }] };
    storeSub.cb?.();
    await flush();

    const navs = dispatch.mock.calls.map(([a]) => a).filter((a) => a.type === 'tabs/setActiveTab');
    expect(navs).toEqual([]);
  });
});
