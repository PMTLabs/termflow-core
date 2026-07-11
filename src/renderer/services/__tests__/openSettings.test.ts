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
});
