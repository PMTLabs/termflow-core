import tabsReducer, { addTab, removeTab, markTabExited, clearTabExited, setActiveTab, flagTabActivity, markUnseenOutput, markTabSeen, setRunningActivity, setTabColorSchema, setTabTitleColor, setTabMuted, updateTabTitle, setAutoTabTitle } from '../tabsSlice';

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

describe('tabsSlice setRunningActivity', () => {
  // Req 8 (plan/020 §2): ONE action writes BOTH the tab-level `isRunning` and the new
  // per-pane `runningTerminalIds`, so the two levels can never disagree for a frame.
  it('sets isRunning true for listed tabs and false for the rest', () => {
    let state = tabsReducer(stateWithTwoTabs(), setRunningActivity({ tabIds: ['tb-1'], terminalIds: [] }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.isRunning).toBe(true);
    expect(state.tabs.find(t => t.id === 'tb-2')?.isRunning).toBe(false);
    state = tabsReducer(state, setRunningActivity({ tabIds: [], terminalIds: [] }));
    expect(state.tabs.every(t => !t.isRunning)).toBe(true);
  });

  it('sets isRunning on the active tab too (no active-tab guard)', () => {
    const state = tabsReducer(stateWithTwoTabs(), setRunningActivity({ tabIds: ['tb-2'], terminalIds: [] })); // tb-2 is active
    expect(state.tabs.find(t => t.id === 'tb-2')?.isRunning).toBe(true);
  });

  it('sets runningTerminalIds on the slice in the SAME action', () => {
    const state = tabsReducer(
      stateWithTwoTabs(),
      setRunningActivity({ tabIds: ['tb-1'], terminalIds: ['tm-1'] }),
    );
    expect(state.runningTerminalIds).toEqual(['tm-1']);
  });

  /**
   * The acceptance shape at the slice level: a tab with one busy pane out of two must end up
   * with `isRunning === true` on the TAB while `runningTerminalIds` names ONLY the busy pane.
   * Asserting the COUNT (not just membership) so a reducer that marked every terminal busy —
   * e.g. by accident spreading tabIds into terminalIds — fails this test.
   */
  it('a tab with one busy pane of two: tab-level true, runningTerminalIds has exactly one entry', () => {
    const state = tabsReducer(
      stateWithTwoTabs(),
      setRunningActivity({ tabIds: ['tb-1'], terminalIds: ['tm-1'] }),
    );
    expect(state.tabs.find(t => t.id === 'tb-1')?.isRunning).toBe(true);
    expect(state.runningTerminalIds).toHaveLength(1);
    expect(state.runningTerminalIds).toContain('tm-1');
    expect(state.runningTerminalIds).not.toContain('tm-2');
  });

  it('replaces the previous runningTerminalIds wholesale rather than merging', () => {
    let state = tabsReducer(stateWithTwoTabs(), setRunningActivity({ tabIds: ['tb-1'], terminalIds: ['tm-1', 'tm-2'] }));
    state = tabsReducer(state, setRunningActivity({ tabIds: [], terminalIds: [] }));
    expect(state.runningTerminalIds).toEqual([]);
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

describe('tabsSlice setTabMuted', () => {
  it('mutes the matching tab only', () => {
    const next = tabsReducer(stateWithTwoTabs(), setTabMuted({ id: 'tb-1', muted: true }));
    expect(next.tabs.find(t => t.id === 'tb-1')?.notifyMuted).toBe(true);
    expect(next.tabs.find(t => t.id === 'tb-2')?.notifyMuted).toBeUndefined();
  });

  it('unmute deletes the flag (back to inherit-default)', () => {
    let state = tabsReducer(stateWithTwoTabs(), setTabMuted({ id: 'tb-1', muted: true }));
    state = tabsReducer(state, setTabMuted({ id: 'tb-1', muted: false }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.notifyMuted).toBeUndefined();
  });

  it('muting clears any pending unseen-output bell on that tab', () => {
    // tb-1 is inactive; flag it unseen, then mute → the stale bell is cleared.
    let state = tabsReducer(stateWithTwoTabs(), markUnseenOutput({ tabId: 'tb-1' }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.hasUnseenOutput).toBe(true);
    state = tabsReducer(state, setTabMuted({ id: 'tb-1', muted: true }));
    expect(state.tabs.find(t => t.id === 'tb-1')?.hasUnseenOutput).toBe(false);
  });

  it('is a no-op for an unknown tab id', () => {
    const next = tabsReducer(stateWithTwoTabs(), setTabMuted({ id: 'tb-missing', muted: true }));
    expect(next.tabs.every(t => !t.notifyMuted)).toBe(true);
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

  /**
   * `cmd.exe` announces its own full path as its OSC title, so a "Command Prompt" tab renamed
   * itself to `C:\WINDOWS\system32\cmd.exe` a frame after opening — and Canvas Mode labels a
   * group frame with its tab's title, which is where it was finally noticed (2026-08-17).
   *
   * The rule itself lives in `services/autoTitle` with its own table of near-misses; what is
   * pinned here is that the reducer consults it, and that refusing means KEEPING the name
   * already in place rather than blanking it.
   */
  it('setAutoTabTitle refuses a title that is only the shell executable', () => {
    const next = tabsReducer(
      stateWithTwoTabs(),
      setAutoTabTitle({ id: 'tb-1', title: 'C:\\WINDOWS\\system32\\cmd.exe' }),
    );
    expect(next.tabs.find(t => t.id === 'tb-1')?.title).toBe('A');
  });

  it('setAutoTabTitle refuses an empty title rather than leaving a nameless tab', () => {
    const next = tabsReducer(stateWithTwoTabs(), setAutoTabTitle({ id: 'tb-1', title: '   ' }));
    expect(next.tabs.find(t => t.id === 'tb-1')?.title).toBe('A');
  });

  it('setAutoTabTitle still adopts a working directory, which is the useful case', () => {
    // Paired with the refusals above: a guard that rejected anything path-shaped would pass
    // both of them and silently throw away every informative title a shell sets.
    const dir = 'C:\\Users\\user\\projects';
    const next = tabsReducer(stateWithTwoTabs(), setAutoTabTitle({ id: 'tb-1', title: dir }));
    expect(next.tabs.find(t => t.id === 'tb-1')?.title).toBe(dir);
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

/**
 * `addTab insertAtStart` — the placement Canvas Mode needs (`plan/024` Req 3).
 *
 * `insertAfterId` cannot express "first": there is no tab to be after. The reducer therefore
 * grew a third placement rather than a sentinel, and the case that matters is the one where
 * both hints arrive at once — a caller that asks for two contradictory positions has to get a
 * defined one, not whichever branch happens to be written first.
 */
describe('tabsSlice addTab insertAtStart (Canvas Mode takes the first position)', () => {
  const threeTabs = () => {
    let state = stateWithTwoTabs();
    state = tabsReducer(state, addTab({ id: 'tb-3', title: 'C', shellType: 'default' }));
    return state;
  };
  const ids = (s: ReturnType<typeof tabsReducer>) => s.tabs.map(t => t.id);

  it('puts the new tab at the front and activates it', () => {
    const next = tabsReducer(threeTabs(), addTab({ id: 'tb-new', title: 'N', shellType: 'default', insertAtStart: true }));
    expect(ids(next)).toEqual(['tb-new', 'tb-1', 'tb-2', 'tb-3']);
    expect(next.activeTabId).toBe('tb-new');
  });

  it('still appends when insertAtStart is false or omitted', () => {
    expect(ids(tabsReducer(threeTabs(), addTab({ id: 'tb-a', title: 'A', shellType: 'default', insertAtStart: false }))))
      .toEqual(['tb-1', 'tb-2', 'tb-3', 'tb-a']);
    expect(ids(tabsReducer(threeTabs(), addTab({ id: 'tb-b', title: 'B', shellType: 'default' }))))
      .toEqual(['tb-1', 'tb-2', 'tb-3', 'tb-b']);
  });

  // Precedence, stated in the reducer and pinned here: "first" is a position, "after X" is a
  // relationship, and a caller passing both has already contradicted itself.
  it('wins over insertAfterId when both are supplied', () => {
    const next = tabsReducer(threeTabs(), addTab({
      id: 'tb-new', title: 'N', shellType: 'default', insertAtStart: true, insertAfterId: 'tb-2',
    }));
    expect(ids(next)).toEqual(['tb-new', 'tb-1', 'tb-2', 'tb-3']);
  });

  it('does not persist insertAtStart onto the stored Tab object', () => {
    const next = tabsReducer(threeTabs(), addTab({ id: 'tb-y', title: 'Y', shellType: 'default', insertAtStart: true }));
    expect((next.tabs.find(t => t.id === 'tb-y') as Record<string, unknown>).insertAtStart).toBeUndefined();
  });

  // The restore path adds tabs with isActive:false; front-insertion must not smuggle activation in.
  it('respects isActive:false, as the restore path relies on', () => {
    const next = tabsReducer(threeTabs(), addTab({
      id: 'tb-r', title: 'R', shellType: 'default', insertAtStart: true, isActive: false,
    }));
    expect(ids(next)[0]).toBe('tb-r');
    expect(next.tabs.find(t => t.id === 'tb-r')?.isActive).toBe(false);
    expect(next.activeTabId).toBe('tb-3');
  });
});

/**
 * `markTabSeen` — reading a tab without activating it (`plan/024` Req 2).
 *
 * Until Canvas Mode, "seen" and "active" were the same event, so clearing lived inside
 * `setActiveTab`. The overlay shows one terminal at 1:1 while the CANVAS tab is active, so a
 * terminal can be read in full and keep its bell. This is the edge that says so.
 */
describe('tabsSlice markTabSeen', () => {
  const belled = () => {
    let state = stateWithTwoTabs();                       // tb-2 active
    state = tabsReducer(state, markUnseenOutput({ tabId: 'tb-1' }));
    state = tabsReducer(state, flagTabActivity({ tabId: 'tb-1' }));
    return state;
  };

  it('clears both seen-flags on the named tab', () => {
    const before = belled();
    expect(before.tabs.find(t => t.id === 'tb-1')?.hasUnseenOutput).toBe(true);
    expect(before.tabs.find(t => t.id === 'tb-1')?.hasBackgroundActivity).toBe(true);

    const next = tabsReducer(before, markTabSeen({ tabId: 'tb-1' }));
    expect(next.tabs.find(t => t.id === 'tb-1')?.hasUnseenOutput).toBe(false);
    expect(next.tabs.find(t => t.id === 'tb-1')?.hasBackgroundActivity).toBe(false);
  });

  // The whole point: it does NOT move the user. Clearing via setActiveTab would have yanked
  // them off the canvas to mark a background tab read.
  it('does not change which tab is active', () => {
    const next = tabsReducer(belled(), markTabSeen({ tabId: 'tb-1' }));
    expect(next.activeTabId).toBe('tb-2');
    expect(next.tabs.find(t => t.id === 'tb-1')?.isActive).toBe(false);
  });

  it('leaves other tabs alone', () => {
    let state = belled();
    state = tabsReducer(state, markUnseenOutput({ tabId: 'tb-1' }));
    const next = tabsReducer(state, markTabSeen({ tabId: 'tb-1' }));
    // tb-2 is active so it was never belled; assert the negative can't come from tb-1's clear.
    expect(next.tabs.find(t => t.id === 'tb-2')?.hasUnseenOutput).toBeFalsy();
  });

  it('is a no-op for an unknown tab', () => {
    const before = belled();
    const next = tabsReducer(before, markTabSeen({ tabId: 'tb-missing' }));
    expect(next.tabs.find(t => t.id === 'tb-1')?.hasUnseenOutput).toBe(true);
  });
});

/**
 * The extracted `markSeen` helper, pinned through its three callers.
 *
 * These two lines used to be copy-pasted into `setActiveTab` and `removeTab`; `markTabSeen` was
 * about to make a third copy. The risk is a copy that clears one flag and not the other, which
 * leaves a tab half-read — the bell gone but the amber dot still flashing, or the reverse. So
 * every caller is asserted on BOTH flags rather than on the one it was written for.
 */
describe('tabsSlice "seen" clearing is one rule across every caller', () => {
  const belled = (tabId: string) => {
    let state = stateWithTwoTabs();
    state = tabsReducer(state, addTab({ id: 'tb-3', title: 'C', shellType: 'default' }));
    state = tabsReducer(state, markUnseenOutput({ tabId }));
    state = tabsReducer(state, flagTabActivity({ tabId }));
    return state;
  };
  const flags = (s: ReturnType<typeof tabsReducer>, id: string) => {
    const t = s.tabs.find(x => x.id === id);
    return { unseen: !!t?.hasUnseenOutput, activity: !!t?.hasBackgroundActivity };
  };

  it('setActiveTab clears both', () => {
    const next = tabsReducer(belled('tb-1'), setActiveTab('tb-1'));
    expect(flags(next, 'tb-1')).toEqual({ unseen: false, activity: false });
  });

  it('markTabSeen clears both', () => {
    const next = tabsReducer(belled('tb-1'), markTabSeen({ tabId: 'tb-1' }));
    expect(flags(next, 'tb-1')).toEqual({ unseen: false, activity: false });
  });

  it('removeTab clears both on the tab it auto-activates', () => {
    // tb-3 is active (last added); removing it activates its neighbour tb-2. Bell tb-2 first so
    // the auto-activation has something to clear.
    let state = belled('tb-2');
    state = tabsReducer(state, setActiveTab('tb-3'));
    state = tabsReducer(state, markUnseenOutput({ tabId: 'tb-2' }));
    state = tabsReducer(state, flagTabActivity({ tabId: 'tb-2' }));
    expect(flags(state, 'tb-2')).toEqual({ unseen: true, activity: true });

    const next = tabsReducer(state, removeTab('tb-3'));
    expect(next.activeTabId).toBe('tb-2');
    expect(flags(next, 'tb-2')).toEqual({ unseen: false, activity: false });
  });
});
