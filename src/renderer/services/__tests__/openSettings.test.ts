/**
 * @jest-environment jsdom
 */
import { addTab, setActiveTab } from '../../store/slices/tabsSlice';

const dispatch = jest.fn();
const mockState: { tabs: { tabs: Array<{ id: string; shellType: string; isActive: boolean }> } } = {
  tabs: { tabs: [] },
};
jest.mock('../../store', () => ({
  store: { getState: () => mockState, dispatch: (a: unknown) => dispatch(a) },
}));

let eventListeners: Record<string, (event: any) => void> = {};
const mockListen = jest.fn((event: string, cb: (e: any) => void) => {
  eventListeners[event] = cb;
  return Promise.resolve(() => {
    delete eventListeners[event];
  });
});

jest.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, cb: (e: any) => void) => mockListen(event, cb),
}));

let currentWindowLabel = 'main';
jest.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: currentWindowLabel }),
}));

import {
  openSettingsTab,
  installSettingsRouting,
  __resetSettingsRoutingForTest,
} from '../openSettings';


describe('openSettingsTab (single-instance Settings)', () => {
  beforeEach(() => {
    dispatch.mockClear();
    mockState.tabs.tabs = [];
  });

  it('creates a Settings tab when none exists', () => {
    mockState.tabs.tabs = [{ id: 'tb-1', shellType: 'default', isActive: true }];

    openSettingsTab();

    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0][0];
    expect(action.type).toBe(addTab.type);
    expect(action.payload).toMatchObject({ shellType: 'settings', title: 'Settings' });
  });

  it('activates the existing Settings tab instead of creating a second one', () => {
    mockState.tabs.tabs = [
      { id: 'tb-1', shellType: 'default', isActive: true },
      { id: 'tab-settings-123', shellType: 'settings', isActive: false },
    ];

    openSettingsTab();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(setActiveTab('tab-settings-123'));
  });

  it('is a no-op when the Settings tab is already active', () => {
    mockState.tabs.tabs = [{ id: 'tab-settings-123', shellType: 'settings', isActive: true }];

    openSettingsTab();

    expect(dispatch).not.toHaveBeenCalled();
  });
  it('a second open activates the tab the first one created, rather than adding another', () => {
    // The gear's whole contract (`plan/013` Task 21): click it twice, get one Settings tab.
    //
    // The two branches are each covered above, but only from a hand-built state — nothing
    // exercised the SEQUENCE, where the second call has to find the tab the first one made.
    // Task 21's own version of this test read `store.getState()` directly; `../../store` is
    // mocked here with a no-op dispatch, so the tab list never changes and the assertion
    // would have been against an empty array. Reflecting the created tab back in by hand is
    // what the real reducer does, and is what makes the two calls actually connect.
    mockState.tabs.tabs = [{ id: 'tb-1', shellType: 'default', isActive: true }];

    openSettingsTab();
    const created = dispatch.mock.calls[0][0].payload as { id: string };
    expect(created.id).toBeTruthy();

    mockState.tabs.tabs = [
      { id: 'tb-1', shellType: 'default', isActive: false },
      { id: created.id, shellType: 'settings', isActive: false },
    ];
    dispatch.mockClear();

    openSettingsTab();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(setActiveTab(created.id));
    expect(mockState.tabs.tabs.filter((t) => t.shellType === 'settings')).toHaveLength(1);
  });

  it('forwards category and detail to openSettingsInMainWindow when available', async () => {
    const mockOpen = jest.fn().mockResolvedValue(undefined);
    (window as any).electronAPI = { openSettingsInMainWindow: mockOpen };

    openSettingsTab('automations', 'list');

    expect(mockOpen).toHaveBeenCalledWith('automations', 'list');
    delete (window as any).electronAPI;
  });

  it('routes automations:list locally to requestAutomationList', async () => {
    const { consumePendingAutomationList } = await import('../automationEditorHost');
    consumePendingAutomationList(); // clear initial

    openSettingsTab('automations', 'list');

    expect(consumePendingAutomationList()).toBe(true);
  });

  it('routes automations:log:<id> locally to requestAutomationLog', async () => {
    const { consumePendingAutomationLog } = await import('../automationEditorHost');
    consumePendingAutomationLog(); // clear initial

    openSettingsTab('automations', 'log:rule-custom-1');

    expect(consumePendingAutomationLog()).toBe('rule-custom-1');
  });

  describe('installSettingsRouting (cross-window receiver)', () => {
    beforeEach(() => {
      __resetSettingsRoutingForTest();
      eventListeners = {};
      mockListen.mockClear();
      currentWindowLabel = 'main';
    });

    it('subscribes to settings:open event and routes automations:list when targeted', async () => {
      const { consumePendingAutomationList } = await import('../automationEditorHost');
      consumePendingAutomationList();

      await installSettingsRouting();

      expect(mockListen).toHaveBeenCalledWith('settings:open', expect.any(Function));
      const handler = eventListeners['settings:open'];
      expect(handler).toBeDefined();

      // Emit synthetic cross-window event for this window
      handler({ payload: { target: 'main', category: 'automations', detail: 'list' } });

      expect(consumePendingAutomationList()).toBe(true);
    });

    it('routes automations:log:<id> when targeted with log detail', async () => {
      const { consumePendingAutomationLog } = await import('../automationEditorHost');
      consumePendingAutomationLog();

      await installSettingsRouting();

      const handler = eventListeners['settings:open'];
      handler({ payload: { target: 'main', category: 'automations', detail: 'log:rule-cross-99' } });

      expect(consumePendingAutomationLog()).toBe('rule-cross-99');
    });

    it('ignores settings:open when payload target does not match current window', async () => {
      const { consumePendingAutomationList, consumePendingAutomationLog } = await import('../automationEditorHost');
      consumePendingAutomationList();
      consumePendingAutomationLog();

      await installSettingsRouting();

      const handler = eventListeners['settings:open'];
      handler({ payload: { target: 'window-2', category: 'automations', detail: 'list' } });

      expect(consumePendingAutomationList()).toBe(false);
      expect(consumePendingAutomationLog()).toBeNull();
    });
  });
});


