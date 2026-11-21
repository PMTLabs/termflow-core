/** @jest-environment jsdom */
import { store } from '..';
import { addTabTree, patchSshPaneTag, resetPanes, setActiveTabId, setPaneTree } from '../slices/panesSlice';
import { clearTabPanesInPlace, getTabPanesGlobal } from '../../services/tabPanesStore';
import { expectPaneTags, pane, split, sentinel, other, tags } from '../../__testFixtures__/sshPaneCensus';

afterEach(() => { store.dispatch(resetPanes()); clearTabPanesInPlace(); });

test('background_ssh_preferences_survive_tab_switch_and_mirror_save', () => {
  store.dispatch(setActiveTabId('tb-active'));
  store.dispatch(setPaneTree(split('front', pane('local'), pane('other', other))));
  const active = store.getState().panes.paneTree;
  const concurrent = { ...sentinel, connectionId: 'newer-connection', hiddenMetrics: ['ram', 'nfs'] as const };
  const ssh = { ...concurrent, hiddenMetrics: [...concurrent.hiddenMetrics] };
  const background = split('back', pane('ssh', ssh), pane('second-local'));
  store.dispatch(addTabTree({ tabId: 'tb-background', tree: background }));
  const patch = { browserPath: '/srv/next', followCd: false };
  store.dispatch(patchSshPaneTag({
    terminalId: 'tm-ssh', patch: { ...patch, hiddenMetrics: ['cpu'], connectionId: 'stale' } as typeof patch,
  }));
  const updatedTag = { ...ssh, ...patch };
  const expected = {
    'tb-active': active,
    'tb-background': split('back', pane('ssh', updatedTag), pane('second-local')),
  };
  expect(store.getState().panes.paneTree).toBe(active);
  expect(JSON.stringify(store.getState().panes.treesByTabId)).toBe(JSON.stringify(expected));
  expect(JSON.stringify(getTabPanesGlobal())).toBe(JSON.stringify(expected));
  store.dispatch(setActiveTabId('tb-background'));
  expect(JSON.stringify(store.getState().panes.paneTree)).toBe(JSON.stringify(expected['tb-background']));
  expectPaneTags(Object.values(getTabPanesGlobal()), { ...tags, 'tm-ssh': updatedTag }, ['tm-local', 'tm-second-local']);
});
