/** @jest-environment jsdom */
import { configureStore } from '@reduxjs/toolkit';
import tabsReducer from '../../store/slices/tabsSlice';
import panesReducer from '../../store/slices/panesSlice';
import { addTabRootedAt } from '../folderTab';
import { takeInitialCwd } from '../initialCwd';
import { planSeeds } from '../tabTreeSeed';

const FOLDER = 'D:\\work\\repo';

function run(extra: Record<string, unknown> = {}) {
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } });
  const tab = { id: 'tb-folder', title: 'PowerShell', shellType: 'powershell', icon: '🖥️', ...extra };
  addTabRootedAt(store.dispatch, tab as never, FOLDER);
  const state = store.getState();
  return { state, tab, leaf: state.panes.treesByTabId[tab.id] as any };
}

describe('addTabRootedAt — "Open in TermFlow" starts the terminal in the folder', () => {
  beforeEach(() => {
    (window as any).tabPanes = {};
  });

  it('keys the start folder by the root leaf terminalId, the id TerminalPane looks up', () => {
    const { leaf, tab } = run();
    expect(leaf.terminalId).toMatch(/^tm-/);
    // The pre-fix bug keyed it by the tab id, which no pane ever asks for.
    expect(takeInitialCwd(tab.id)).toBeUndefined();
    expect(takeInitialCwd(leaf.terminalId)).toBe(FOLDER);
  });

  it('leaves a tree TerminalContainer will not re-seed over', () => {
    const { state } = run();
    expect(planSeeds(state.tabs.tabs as never, state.panes.treesByTabId as never, (window as any).tabPanes)).toEqual([]);
  });

  it('builds the leaf the way tabTreeSeed would, elevated included', () => {
    const { leaf, tab } = run({ elevated: true });
    expect(leaf).toMatchObject({
      type: 'terminal',
      seededForTabId: tab.id,
      name: 'PowerShell',
      shellType: 'powershell',
      elevated: true,
    });
  });

  it('adds exactly one tab and makes it active', () => {
    const { state, tab } = run();
    expect(state.tabs.tabs.map(t => t.id)).toEqual([tab.id]);
    expect(state.tabs.activeTabId).toBe(tab.id);
  });
});
