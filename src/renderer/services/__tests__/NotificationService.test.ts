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

jest.mock('../../store', () => ({ store: { dispatch, getState: () => mockState } }));
jest.mock('../../store/slices/uiSlice', () => ({
  addToast: (p: unknown) => ({ type: 'ui/addToast', payload: p }),
}));
jest.mock('../../store/slices/tabsSlice', () => ({
  setActiveTab: (id: string) => ({ type: 'tabs/setActiveTab', payload: id }),
}));
jest.mock('../windowFocus', () => ({
  isWindowFocused: () => true, // focused → OS-notify path skipped, avoids dynamic import
  onWindowFocusChange: () => () => {},
  startWindowFocusTracking: async () => {},
}));
jest.mock('../../assets/activityChime', () => ({ ACTIVITY_CHIME_DATA_URI: 'data:audio/wav;base64,AAAA' }));

import { notificationService } from '../NotificationService';

const playMock = jest.fn().mockResolvedValue(undefined);
beforeAll(() => {
  (global as any).Audio = jest.fn().mockImplementation(() => ({
    play: playMock,
    volume: 0,
    currentTime: 0,
  }));
});

function bell(tabId: string, causalTime: number): void {
  window.dispatchEvent(new CustomEvent('activity:bell', { detail: { tabId, causalTime } }));
}

const AFTER_SETTLE = () => Date.now() + NOTIF_SETTLE_MS + 5000;

describe('NotificationService', () => {
  beforeEach(() => {
    dispatch.mockClear();
    playMock.mockClear();
    mockState.settings = { notifySoundEnabled: false, notifyToastEnabled: false, notifyOsEnabled: false };
    notificationService.stop();
    notificationService.start();
  });
  afterEach(() => notificationService.stop());

  it('does not fire before the startup settle window (causal time too early)', () => {
    mockState.settings.notifyToastEnabled = true;
    bell('tb-1', 0); // causal output at t=0 ≪ settleUntil
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fires an in-app toast naming the tab when enabled and settled', () => {
    mockState.settings.notifyToastEnabled = true;
    bell('tb-1', AFTER_SETTLE());
    const toast = dispatch.mock.calls.map(([a]) => a).find((a) => a.type === 'ui/addToast');
    expect(toast).toBeTruthy();
    expect(toast.payload.message).toContain('build');
  });

  it('plays the chime when sound is enabled', () => {
    mockState.settings.notifySoundEnabled = true;
    bell('tb-1', AFTER_SETTLE());
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('throttles repeated chimes', () => {
    mockState.settings.notifySoundEnabled = true;
    bell('tb-1', AFTER_SETTLE());
    bell('tb-1', AFTER_SETTLE());
    expect(playMock).toHaveBeenCalledTimes(1); // second is within the throttle window
  });

  it('fires nothing when all channels are disabled', () => {
    bell('tb-1', AFTER_SETTLE());
    expect(dispatch).not.toHaveBeenCalled();
    expect(playMock).not.toHaveBeenCalled();
  });
});
