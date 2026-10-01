/** @jest-environment jsdom */
jest.mock('../../components/TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
import { configureStore } from '@reduxjs/toolkit';
import panesReducer, { addTabTree, resetPanes } from '../../store/slices/panesSlice';
import tabsReducer, { addTab } from '../../store/slices/tabsSlice';
import canvasReducer from '../../store/slices/canvasSlice';
import { attachPaneDepartureSync, beginPaneReplacement, endPaneReplacement } from '../paneDepartures';
import { StateManager } from '../StateManager';
import { TerminalServiceClass } from '../TerminalService';
import { makeBindingHost } from '../__testFixtures__/shellBindingHost';

const leaf = (terminalId: string) => ({ id: `pn-${terminalId}`, type: 'terminal' as const, terminalId });
const makeStore = () => configureStore({ reducer: { panes: panesReducer, tabs: tabsReducer, canvas: canvasReducer } });
beforeEach(() => { localStorage.clear(); delete (window as any).electronAPI; });

// Drive the real loader and store differ, with a gate at registration before overwrite.
test.each([false, true])('tab-scoped replacement releases omitted live leaves and preserves retained background leaves (empty=%s)', async empty => {
  const store = makeStore();
  const host = makeBindingHost();
  const api = host.apiFor('window');
  const service = new TerminalServiceClass(() => store.getState().panes.treesByTabId, () => api as any);
  store.dispatch(addTab({ id: 'tb-target', title: 'Target', isActive: true }));
  store.dispatch(addTabTree({ tabId: 'tb-target', tree: leaf('tm-p') }));
  store.dispatch(addTab({ id: 'tb-background', title: 'Background' }));
  store.dispatch(addTabTree({ tabId: 'tb-background', tree: leaf('tm-q') }));
  host.seed('tm-p', 'pc-p', 'window');
  host.seed('tm-q', 'pc-q', 'window');
  service.registerExistingTerminal('tm-p', 'pc-p');
  service.registerExistingTerminal('tm-q', 'pc-q');
  await Promise.resolve(); await Promise.resolve();
  const stop = attachPaneDepartureSync(store, id => service.detachTerminal(id));
  (window as any).__REDUX_STORE__ = store;
  let resume!: () => void;
  const tree = empty ? null : leaf('tm-new');
  localStorage.setItem('auto-terminal-layouts', JSON.stringify([{ id: 'layout', name: 'Layout', scope: 'tab', scopedTabId: 'tb-target',
    tabs: [{ id: 'tb-target', title: 'Target' }], activeTabId: 'tb-target', treesByTabId: { 'tb-target': tree },
    paneTree: tree, createdAt: Date.now(), updatedAt: Date.now() }]));
  (window as any).electronAPI = { beginShellRestore: jest.fn(() => new Promise<void>(resolve => { resume = resolve; })),
    registerRestoringLeaves: jest.fn().mockResolvedValue(undefined) };
  const loading = StateManager.loadTabScopedLayout('layout', store.dispatch);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(host.holder('tm-p')).toBe('window');
  resume();
  expect(await loading).toBe(true);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(api.releaseShellBinding).toHaveBeenCalledWith('tm-p');
  expect(api.releaseShellBinding).not.toHaveBeenCalledWith('tm-q');
  expect(service.getProcessId('tm-p')).toBeUndefined();
  expect(service.getProcessId('tm-q')).toBe('pc-q');
  expect(host.holder('tm-p')).toBeUndefined();
  expect(host.holder('tm-q')).toBe('window');
  expect(host.closed).toEqual([]);
  stop();
});

test('replacement and same-window regrouping retain the exact holder through intermediate empty trees', async () => {
  const store = makeStore();
  store.dispatch(addTabTree({ tabId: 'old', tree: leaf('tm-p') }));
  const detach = jest.fn();
  const stop = attachPaneDepartureSync(store, detach);
  beginPaneReplacement();
  store.dispatch(resetPanes());
  await Promise.resolve();
  expect(detach).not.toHaveBeenCalled();
  store.dispatch(addTabTree({ tabId: 'new', tree: leaf('tm-p') }));
  endPaneReplacement();
  await Promise.resolve();
  expect(detach).not.toHaveBeenCalled();
  store.dispatch(resetPanes());
  await Promise.resolve();
  expect(detach.mock.calls).toEqual([['tm-p']]);
  stop();
});
