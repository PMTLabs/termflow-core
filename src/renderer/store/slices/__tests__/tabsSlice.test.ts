import tabsReducer, { addTab, removeTab, markTabExited, clearTabExited, setActiveTab, flagTabActivity, markUnseenOutput, setRunningTabs, setTabColorSchema, setTabTitleColor, updateTabTitle, setAutoTabTitle } from '../tabsSlice';

const stateWithTwoTabs = () => {
  let state = tabsReducer(undefined, { type: '@@INIT' } as any);
  state = tabsReducer(state, addTab({ id: 'tb-1', title: 'A', shellType: 'default' }));
  state = tabsReducer(state, addTab({ id: 'tb-2', title: 'B', shellType: 'default' }));
  // addTab auto-activates the last-added tab, so tb-2 is active and tb-1 is inactive.
  return state;
};

describe('tabsSlice markTabExited', () => {
  it('marks only the matching tab as exited and records its exit code', () => {
    const next = tabsReducer(stateWithTwoTabs(), markTabExited({ tabId: 'tb-1', exitCode: 0 }));
    expect(next.tabs.find(t => t.id === 'tb-1')?.exited).toBe(true);
    expect(next.tabs.find(t => t.id === 'tb-1')?.exitCode).toBe(0);
    expect(next.tabs.find(t => t.id === 'tb-2')?.exited).toBeUndefined();
  });

  it('records a non-zero exit code', () => {
    const next = tabsReducer(stateWithTwoTabs(), markTabExited({ tabId: 'tb-1', exitCode: 1 }));
    expect(next.tabs.find(t => t.id === 'tb-1')?.exitCode).toBe(1);
  });

  it('records a null exit code when unknown', () => {
    const next = tabsReducer(stateWithTwoTabs(), markTabExited({ tabId: 'tb-1', exitCode: null }));
    expect(next.tabs.find(t => t.id === 'tb-1')?.exited).toBe(true);
    expect(next.tabs.find(t => t.id === 'tb-1')?.exitCode).toBeNull();
  });

  it('is a no-op for an unknown tab id (e.g. a tab already removed)', () => {
    const next = tabsReducer(stateWithTwoTabs(), markTabExited({ tabId: 'tb-missing', exitCode: 0 }));
    expect(next.tabs.every(t => !t.exited)).toBe(true);
  });
});

describe('tabsSlice clearTabExited', () => {
  it('clears the exited mark and exit code for the matching tab only (restart-in-place)', () => {
    let state = tabsReducer(stateWithTwoTabs(), markTabExited({ tabId: 'tb-1', exitCode: 0 }));
    state = tabsReducer(state, markTabExited({ tabId: 'tb-2', exitCode: 0 }));
    const next = tabsReducer(state, clearTabExited('tb-1'));
    expect(next.tabs.find(t => t.id === 'tb-1')?.exited).toBe(false);
    expect(next.tabs.find(t => t.id === 'tb-1')?.exitCode).toBeUndefined();
    expect(next.tabs.find(t => t.id === 'tb-2')?.exited).toBe(true);
  });

  it('is a no-op for an unknown tab id (e.g. a split pane id)', () => {
    const next = tabsReducer(stateWithTwoTabs(), clearTabExited('tm-99'));
    expect(next.tabs.every(t => !t.exited)).toBe(true);
  });
});

describe('tabsSlice flagTabActivity', () => {
  // stateWithTwoTabs() leaves tb-2 active and tb-1 inactive.
  it('flags a non-active tab (tb-1) and bumps its activityTick', () => {
    const next = tabsReducer(stateWithTwoTabs(), flagTabActivity({ tabId: 'tb-1' }));
    const tab = next.tabs.find(t => t.id === 'tb-1');
    expect(tab?.hasBackgroundActivity).toBe(true);
    expect(tab?.activityTick).toBe(1);
  });

  it('increments activityTick on repeated interactions', () => {
    let state = tabsReducer(stateWithTwoTabs(), flagTabActivity({ tabId: 'tb-1' }));
    state = tabsReducer(state, flagTabActivity({ tabId: 'tb-1' }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.activityTick).toBe(2);
  });

  it('is a no-op for the currently active tab (tb-2)', () => {
    const next = tabsReducer(stateWithTwoTabs(), flagTabActivity({ tabId: 'tb-2' }));
    const tab = next.tabs.find(t => t.id === 'tb-2');
    expect(tab?.hasBackgroundActivity).toBeUndefined();
    expect(tab?.activityTick).toBeUndefined();
  });

  it('is a no-op for an unknown tab id', () => {
    const next = tabsReducer(stateWithTwoTabs(), flagTabActivity({ tabId: 'tb-missing' }));
    expect(next.tabs.every(t => !t.hasBackgroundActivity)).toBe(true);
  });
});

describe('tabsSlice markUnseenOutput', () => {
  // stateWithTwoTabs() leaves tb-2 active and tb-1 inactive.
  it('flags a non-active tab (tb-1) as having unseen output', () => {
    const next = tabsReducer(stateWithTwoTabs(), markUnseenOutput({ tabId: 'tb-1' }));
    expect(next.tabs.find(t => t.id === 'tb-1')?.hasUnseenOutput).toBe(true);
  });

  it('is idempotent (no tick / extra state) on repeated marks', () => {
    let state = tabsReducer(stateWithTwoTabs(), markUnseenOutput({ tabId: 'tb-1' }));
    state = tabsReducer(state, markUnseenOutput({ tabId: 'tb-1' }));
    const tab = state.tabs.find(t => t.id === 'tb-1');
    expect(tab?.hasUnseenOutput).toBe(true);
    expect(tab?.activityTick).toBeUndefined(); // unlike flagTabActivity, no animation tick
  });

  it('is a no-op for the currently active tab (tb-2)', () => {
    const next = tabsReducer(stateWithTwoTabs(), markUnseenOutput({ tabId: 'tb-2' }));
    expect(next.tabs.find(t => t.id === 'tb-2')?.hasUnseenOutput).toBeUndefined();
  });

  it('is a no-op for an unknown tab id', () => {
    const next = tabsReducer(stateWithTwoTabs(), markUnseenOutput({ tabId: 'tb-missing' }));
    expect(next.tabs.every(t => !t.hasUnseenOutput)).toBe(true);
  });
});

describe('tabsSlice setActiveTab clears activity', () => {
  it('clears hasBackgroundActivity on the tab being activated', () => {
    // tb-1 is inactive; flag it, then activate it → flag clears.
    let state = tabsReducer(stateWithTwoTabs(), flagTabActivity({ tabId: 'tb-1' }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.hasBackgroundActivity).toBe(true);
    state = tabsReducer(state, setActiveTab('tb-1'));
    expect(state.tabs.find(t => t.id === 'tb-1')?.hasBackgroundActivity).toBe(false);
  });

  it('clears hasUnseenOutput on the tab being activated (viewing = seen)', () => {
    let state = tabsReducer(stateWithTwoTabs(), markUnseenOutput({ tabId: 'tb-1' }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.hasUnseenOutput).toBe(true);
    state = tabsReducer(state, setActiveTab('tb-1'));
    expect(state.tabs.find(t => t.id === 'tb-1')?.hasUnseenOutput).toBe(false);
  });
});

describe('tabsSlice removeTab clears activity on the newly-activated tab', () => {
  it('clears hasBackgroundActivity when closing the active tab promotes a flagged tab', () => {
    // tb-2 is active, tb-1 inactive. Flag tb-1, then close tb-2 → tb-1 is promoted to active.
    let state = tabsReducer(stateWithTwoTabs(), flagTabActivity({ tabId: 'tb-1' }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.hasBackgroundActivity).toBe(true);
    state = tabsReducer(state, removeTab('tb-2'));
    const promoted = state.tabs.find(t => t.id === 'tb-1');
    expect(promoted?.isActive).toBe(true);
    expect(promoted?.hasBackgroundActivity).toBe(false);
  });

  it('clears hasUnseenOutput when closing the active tab promotes a flagged tab', () => {
    let state = tabsReducer(stateWithTwoTabs(), markUnseenOutput({ tabId: 'tb-1' }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.hasUnseenOutput).toBe(true);
    state = tabsReducer(state, removeTab('tb-2'));
    const promoted = state.tabs.find(t => t.id === 'tb-1');
    expect(promoted?.isActive).toBe(true);
    expect(promoted?.hasUnseenOutput).toBe(false);
  });
});

describe('tabsSlice setRunningTabs', () => {
  it('sets isRunning true for listed tabs and false for the rest', () => {
    let state = tabsReducer(stateWithTwoTabs(), setRunningTabs(['tb-1']));
    expect(state.tabs.find(t => t.id === 'tb-1')?.isRunning).toBe(true);
    expect(state.tabs.find(t => t.id === 'tb-2')?.isRunning).toBe(false);
    state = tabsReducer(state, setRunningTabs([]));
    expect(state.tabs.every(t => !t.isRunning)).toBe(true);
  });

  it('sets isRunning on the active tab too (no active-tab guard)', () => {
    const state = tabsReducer(stateWithTwoTabs(), setRunningTabs(['tb-2'])); // tb-2 is active
    expect(state.tabs.find(t => t.id === 'tb-2')?.isRunning).toBe(true);
  });
});

describe('tabsSlice setTabColorSchema', () => {
  it('sets a per-tab color schema override on the matching tab only', () => {
    const next = tabsReducer(stateWithTwoTabs(), setTabColorSchema({ id: 'tb-1', colorSchemaId: 'dracula' }));
    expect(next.tabs.find(t => t.id === 'tb-1')?.colorSchemaId).toBe('dracula');
    expect(next.tabs.find(t => t.id === 'tb-2')?.colorSchemaId).toBeUndefined();
  });

  it('clears the override ("Use Settings Default") when called with undefined', () => {
    let state = tabsReducer(stateWithTwoTabs(), setTabColorSchema({ id: 'tb-1', colorSchemaId: 'dracula' }));
    state = tabsReducer(state, setTabColorSchema({ id: 'tb-1', colorSchemaId: undefined }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.colorSchemaId).toBeUndefined();
  });

  it('is a no-op for an unknown tab id', () => {
    const next = tabsReducer(stateWithTwoTabs(), setTabColorSchema({ id: 'tb-missing', colorSchemaId: 'dracula' }));
    expect(next.tabs.every(t => !t.colorSchemaId)).toBe(true);
  });
});

describe('tabsSlice setTabTitleColor', () => {
  it('sets a per-tab title color override on the matching tab only', () => {
    const next = tabsReducer(stateWithTwoTabs(), setTabTitleColor({ id: 'tb-1', titleColor: '#ff5555' }));
    expect(next.tabs.find(t => t.id === 'tb-1')?.titleColor).toBe('#ff5555');
    expect(next.tabs.find(t => t.id === 'tb-2')?.titleColor).toBeUndefined();
  });

  it('clears the override ("Reset to Default") when called with undefined', () => {
    let state = tabsReducer(stateWithTwoTabs(), setTabTitleColor({ id: 'tb-1', titleColor: '#ff5555' }));
    state = tabsReducer(state, setTabTitleColor({ id: 'tb-1', titleColor: undefined }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.titleColor).toBeUndefined();
  });

  it('is a no-op for an unknown tab id', () => {
    const next = tabsReducer(stateWithTwoTabs(), setTabTitleColor({ id: 'tb-missing', titleColor: '#ff5555' }));
    expect(next.tabs.every(t => !t.titleColor)).toBe(true);
  });
});

describe('tabsSlice setAutoTabTitle / updateTabTitle interaction', () => {
  it('setAutoTabTitle updates the title on a tab that has never been manually renamed', () => {
    const next = tabsReducer(stateWithTwoTabs(), setAutoTabTitle({ id: 'tb-1', title: 'npm run build' }));
    expect(next.tabs.find(t => t.id === 'tb-1')?.title).toBe('npm run build');
  });

  it('updateTabTitle (manual rename) pins the tab so a later setAutoTabTitle is ignored', () => {
    let state = tabsReducer(stateWithTwoTabs(), updateTabTitle({ id: 'tb-1', title: 'My Tab' }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.titleIsCustom).toBe(true);
    state = tabsReducer(state, setAutoTabTitle({ id: 'tb-1', title: 'vim' }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.title).toBe('My Tab');
  });

  it('setAutoTabTitle does not pin the tab — further auto updates keep applying', () => {
    let state = tabsReducer(stateWithTwoTabs(), setAutoTabTitle({ id: 'tb-1', title: 'vim' }));
    state = tabsReducer(state, setAutoTabTitle({ id: 'tb-1', title: 'npm' }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.title).toBe('npm');
    expect(state.tabs.find(t => t.id === 'tb-1')?.titleIsCustom).toBeUndefined();
  });

  it('setAutoTabTitle is a no-op for an unknown tab id', () => {
    const next = tabsReducer(stateWithTwoTabs(), setAutoTabTitle({ id: 'tb-missing', title: 'vim' }));
    expect(next.tabs.map(t => t.title)).toEqual(['A', 'B']);
  });
});

describe('tabsSlice addTab insertAfterId (context-menu "New Tab" insert-after)', () => {
  // Three tabs so we can insert into the middle: order tb-1, tb-2, tb-3.
  const threeTabs = () => {
    let state = stateWithTwoTabs();
    state = tabsReducer(state, addTab({ id: 'tb-3', title: 'C', shellType: 'default' }));
    return state;
  };

  it('inserts the new tab immediately AFTER the given tab and activates it', () => {
    const next = tabsReducer(threeTabs(), addTab({ id: 'tb-new', title: 'N', shellType: 'default', insertAfterId: 'tb-1' }));
    expect(next.tabs.map(t => t.id)).toEqual(['tb-1', 'tb-new', 'tb-2', 'tb-3']);
    expect(next.activeTabId).toBe('tb-new');
    expect(next.tabs.find(t => t.id === 'tb-new')?.isActive).toBe(true);
    // Every other tab is deactivated, none reordered.
    expect(next.tabs.filter(t => t.isActive).map(t => t.id)).toEqual(['tb-new']);
  });

  it('inserts after the LAST tab correctly (equivalent to append at the end)', () => {
    const next = tabsReducer(threeTabs(), addTab({ id: 'tb-new', title: 'N', shellType: 'default', insertAfterId: 'tb-3' }));
    expect(next.tabs.map(t => t.id)).toEqual(['tb-1', 'tb-2', 'tb-3', 'tb-new']);
  });

  it('falls back to append when insertAfterId is not found', () => {
    const next = tabsReducer(threeTabs(), addTab({ id: 'tb-x', title: 'X', shellType: 'default', insertAfterId: 'tb-missing' }));
    expect(next.tabs.map(t => t.id)).toEqual(['tb-1', 'tb-2', 'tb-3', 'tb-x']);
  });

  it('appends (unchanged) when insertAfterId is omitted — other entry points keep appending', () => {
    const next = tabsReducer(threeTabs(), addTab({ id: 'tb-z', title: 'Z', shellType: 'default' }));
    expect(next.tabs.map(t => t.id)).toEqual(['tb-1', 'tb-2', 'tb-3', 'tb-z']);
  });

  it('does not persist insertAfterId onto the stored Tab object', () => {
    const next = tabsReducer(threeTabs(), addTab({ id: 'tb-y', title: 'Y', shellType: 'default', insertAfterId: 'tb-1' }));
    expect((next.tabs.find(t => t.id === 'tb-y') as Record<string, unknown>).insertAfterId).toBeUndefined();
  });
});
