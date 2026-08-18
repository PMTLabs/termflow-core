import { addTab, setActiveTab } from '../../store/slices/tabsSlice';

const dispatch = jest.fn();
const mockState: { tabs: { tabs: Array<{ id: string; shellType: string; isActive: boolean }> } } = {
  tabs: { tabs: [] },
};
jest.mock('../../store', () => ({
  store: { getState: () => mockState, dispatch: (a: unknown) => dispatch(a) },
}));

import { openSettingsTab } from '../openSettings';

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
});
