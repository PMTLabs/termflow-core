/**
 * @jest-environment jsdom
 */
import { NOTIF_SETTLE_MS } from '../notificationLogic';

const dispatch = jest.fn();
const mockState: {
  settings: { notifySoundEnabled: boolean; notifyToastEnabled: boolean; notifyOsEnabled: boolean };
  tabs: { tabs: Array<{ id: string; title: string; hasUnseenOutput?: boolean }> };
} = {
  settings: { notifySoundEnabled: false, notifyToastEnabled: false, notifyOsEnabled: false },
  tabs: { tabs: [{ id: 'tb-1', title: 'build', hasUnseenOutput: true }] },
};

// Controllable window-focus mock so tests can drive the OS path and focus-regain routing.
let mockFocused = true;
let focusCb: ((f: boolean) => void) | null = null;

jest.mock('../../store', () => ({ store: { dispatch, getState: () => mockState } }));
jest.mock('../../store/slices/uiSlice', () => ({
  addToast: (p: unknown) => ({ type: 'ui/addToast', payload: p }),
}));
jest.mock('../../store/slices/tabsSlice', () => ({
  setActiveTab: (id: string) => ({ type: 'tabs/setActiveTab', payload: id }),
}));
jest.mock('../windowFocus', () => ({
  isWindowFocused: () => mockFocused,
  onWindowFocusChange: (cb: (f: boolean) => void) => {
    focusCb = cb;
    return () => { focusCb = null; };
  },
  startWindowFocusTracking: async () => {},
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
    mockFocused = true;
    mockState.settings = { notifySoundEnabled: false, notifyToastEnabled: false, notifyOsEnabled: false };
    notificationService.stop();
    notificationService.start();
  });
  afterEach(() => notificationService.stop());

  it('does not fire before the startup settle window (causal time too early)', () => {
    mockState.settings.notifyToastEnabled = true;
    bell('tb-1', 0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fires a sticky in-app toast naming the tab when enabled and settled', () => {
    mockState.settings.notifyToastEnabled = true;
    bell('tb-1', AFTER_SETTLE());
    const toast = dispatch.mock.calls.map(([a]) => a).find((a) => a.type === 'ui/addToast');
    expect(toast?.payload.message).toContain('build');
    // Activity toasts stay until the user clicks to close (sticky: no auto-dismiss).
    expect(toast?.payload.sticky).toBe(true);
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

describe('NotificationService — OS notification + return-to-app routing', () => {
  beforeEach(() => {
    dispatch.mockClear();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(true);
    mockState.settings = { notifySoundEnabled: false, notifyToastEnabled: false, notifyOsEnabled: true };
    mockState.tabs = { tabs: [{ id: 'tb-1', title: 'build', hasUnseenOutput: true }] };
    mockFocused = false; // app not focused → OS path eligible
    notificationService.stop();
    notificationService.start();
  });
  afterEach(() => notificationService.stop());

  it('requests an OS notification only when this window is unfocused', async () => {
    bell('tb-1', AFTER_SETTLE());
    await flush();
    expect(invokeMock).toHaveBeenCalledWith('show_activity_notification', expect.objectContaining({ tabId: 'tb-1' }));
  });

  it('does NOT request an OS notification when the window is focused', async () => {
    mockFocused = true;
    bell('tb-1', AFTER_SETTLE());
    await flush();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('routes to the belled tab on focus regain when a toast was shown', async () => {
    bell('tb-1', AFTER_SETTLE());
    await flush(); // let showOsNotification resolve (shown=true → tab queued)
    dispatch.mockClear();
    focusCb?.(true); // window regains focus
    const nav = dispatch.mock.calls.map(([a]) => a).find((a) => a.type === 'tabs/setActiveTab');
    expect(nav?.payload).toBe('tb-1');
  });

  it('does NOT queue a tab for routing when the backend suppressed the toast', async () => {
    invokeMock.mockResolvedValue(false); // backend suppressed (another window focused)
    bell('tb-1', AFTER_SETTLE());
    await flush();
    dispatch.mockClear();
    focusCb?.(true);
    expect(dispatch).not.toHaveBeenCalled(); // nothing queued → no forced tab switch
  });

  it('only routes to a tab that is still unseen', async () => {
    bell('tb-1', AFTER_SETTLE());
    await flush();
    mockState.tabs = { tabs: [{ id: 'tb-1', title: 'build', hasUnseenOutput: false }] }; // user already saw it
    dispatch.mockClear();
    focusCb?.(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
