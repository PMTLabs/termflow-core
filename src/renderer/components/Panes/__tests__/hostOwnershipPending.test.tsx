/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

var activeStore: any;
var activeService: any;
jest.mock('../../../store', () => {
  const actual = jest.requireActual('../../../store');
  return { ...actual, get store() { return activeStore ?? actual.store; } };
});
jest.mock('../../../services/TerminalService', () => {
  const actual = jest.requireActual('../../../services/TerminalService');
  return { ...actual, get terminalService() { return activeService ?? actual.terminalService; } };
});
jest.mock('../../Terminal/TerminalDisplay', () => ({ TerminalDisplay: ({ processId }: any) => <div data-process-id={processId}>Bound {processId}</div> }));
jest.mock('../../Terminal/AgentChip', () => ({ AgentChip: () => null }));
jest.mock('../dnd/usePaneDrag', () => ({ usePaneDrag: () => () => {} }));
jest.mock('../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));

import { TerminalPane } from '../TerminalPane';
import { TerminalServiceClass } from '../../../services/TerminalService';
import tabs, { addTab, setActiveTab } from '../../../store/slices/tabsSlice';
import panes, { addTabTree, removeTabTree, setActiveTabId } from '../../../store/slices/panesSlice';
import settings from '../../../store/slices/settingsSlice';
import zoom from '../../../store/slices/zoomSlice';
import canvas from '../../../store/slices/canvasSlice';
import sessionExit, { markSessionClosed } from '../../../store/slices/sessionExitSlice';
import ui from '../../../store/slices/uiSlice';
import { openNewTabWithDefaultProfile, splitPaneById } from '../../../services/paneActions';
import { runApiCreateMode0 } from '../../../services/apiCreatedTab';
import { planSeeds } from '../../../services/tabTreeSeed';
import { generateId } from '../../../utils/id';

const makeStore = () => configureStore({ reducer: { tabs, panes, settings, zoom, canvas, sessionExit, ui } });
const leaf = (terminalId: string) => ({ id: terminalId, type: 'terminal' as const, terminalId });
const apiFor = (createTerminal: jest.Mock) => ({
  createTerminal, onTerminalData: jest.fn(), onTerminalExit: jest.fn(),
  updateTerminalName: jest.fn().mockResolvedValue(true),
  adoptConsoleWindow: jest.fn().mockResolvedValue(undefined),
  registerRestoringLeaves: jest.fn().mockResolvedValue(undefined),
  forgetRestoringLeaf: jest.fn().mockResolvedValue(undefined),
});
let container: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };
const mount = (id: string) => {
  root.render(<Provider store={activeStore}><TerminalPane paneId={id} terminalId={id} isActive solo onSplit={() => {}} onClose={() => {}} onFocus={() => {}} /></Provider>);
};
const clearGuards = () => {
  (window as any).terminalInitMap?.clear();
  (window as any).terminalInitPromises?.clear();
  (window as any).terminalInitLock?.clear();
};

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  jest.useFakeTimers();
  activeStore = makeStore();
  (window as any).__REDUX_STORE__ = activeStore;
  clearGuards();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
  activeStore = undefined;
  activeService = undefined;
});

function seed(store: ReturnType<typeof makeStore>, tree = leaf('tm-wait') as any, tabId = 'tb-wait') {
  store.dispatch(addTab({ id: tabId, title: 'Waiting tab', shellType: 'default' }));
  store.dispatch(addTabTree({ tabId, tree }));
}
function useService(store: ReturnType<typeof makeStore>, api: ReturnType<typeof apiFor>) {
  (window as any).electronAPI = api;
  return new TerminalServiceClass(() => store.getState().panes.treesByTabId, () => api as any);
}

test('waitingForHost keeps the pane across remount, differs from contention, and offers Retry after the budget', async () => {
  seed(activeStore);
  const create = jest.fn().mockRejectedValue(new Error('host-ownership-pending: listing delayed'));
  const api = apiFor(create);
  activeService = useService(activeStore, api);
  act(() => mount('tm-wait'));
  await flush();
  expect(container.textContent).toContain('Waiting for terminal host');
  expect(container.textContent).not.toContain('Failed to start shell');
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Retry')).toBe(false);
  await act(async () => { await jest.advanceTimersByTimeAsync(500); });
  act(() => root.render(null));
  act(() => mount('tm-wait'));
  await act(async () => { await jest.advanceTimersByTimeAsync(20); });
  expect(container.textContent).toContain('Waiting for terminal host');
  expect(create).toHaveBeenCalledTimes(1);
  await act(async () => { await jest.advanceTimersByTimeAsync(89_480); });
  expect(container.textContent).not.toContain('Failed to start shell');
  expect(activeStore.getState().panes.treesByTabId['tb-wait']).toMatchObject({ terminalId: 'tm-wait' });
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry');
  expect(retry).toBeDefined();
  create.mockResolvedValueOnce('pc-old-host');
  act(() => retry!.click());
  await flush();
  expect(container.querySelector('[data-process-id="pc-old-host"]')).not.toBeNull();
  expect(api.registerRestoringLeaves).not.toHaveBeenCalled();
});

test('user-created tab, UI split and API-created leaf never register restore intent', async () => {
  const create = jest.fn(async (_p, _n, _c, id) => `pc-${id}`);
  const api = apiFor(create);
  activeService = useService(activeStore, api);
  activeStore.dispatch({ type: 'settings/setShellProfiles', payload: [{ id: 'default', name: 'Default shell' }] });
  openNewTabWithDefaultProfile();
  const tab = activeStore.getState().tabs.tabs[0];
  const [plan] = planSeeds([tab], activeStore.getState().panes.treesByTabId, {});
  activeStore.dispatch(addTabTree({ tabId: tab.id, tree: plan.tree }));
  activeStore.dispatch(setActiveTabId(tab.id));
  const userLeaf = plan.tree!;
  act(() => mount(userLeaf.terminalId!));
  await flush();
  expect(create).toHaveBeenCalledTimes(1);

  await act(async () => { await splitPaneById(userLeaf.id, 'horizontal'); });
  const splitTree = activeStore.getState().panes.treesByTabId[tab.id];
  const splitLeaf = splitTree.children.find((child: any) => child.terminalId !== userLeaf.terminalId);
  act(() => root.render(null));
  act(() => mount(splitLeaf.terminalId));
  await flush();
  expect(create).toHaveBeenCalledTimes(2);

  runApiCreateMode0({ processId: 'pc-api-created', rendererTerminalId: 'tm-api-created', owningTabId: 'tb-api-created' }, {
    dispatch: activeStore.dispatch, generateId, defaultProfile: 'default',
    registerExistingTerminal: (id, pid) => activeService.registerExistingTerminal(id, pid),
    tabPanes: {}, tabExists: () => false, activateOnApiCreate: false, tabCount: 1,
    addTab, addTabTree, setActiveTab, setActiveTabId, titleColorForTerminal: () => undefined,
  });
  act(() => mount('tm-api-created'));
  await flush();
  expect(container.querySelector('[data-process-id="pc-api-created"]')).not.toBeNull();
  expect(create).toHaveBeenCalledTimes(2);
  expect(api.registerRestoringLeaves).not.toHaveBeenCalled();
});

test('host-session-contended is a startup failure, not a host ownership wait', async () => {
  seed(activeStore);
  const create = jest.fn().mockRejectedValue(new Error('host-session-contended: already bound'));
  activeService = useService(activeStore, apiFor(create));
  act(() => mount('tm-wait'));
  await flush();
  expect(container.textContent).toContain('Failed to start shell');
  expect(container.textContent).not.toContain('Waiting for terminal host');
  await act(async () => { await jest.advanceTimersByTimeAsync(8000); });
  expect(create).toHaveBeenCalledTimes(1);
});

test('handleRestart surfaces a host-ownership-pending toast and never registers restart intent', async () => {
  seed(activeStore);
  const create = jest.fn().mockRejectedValue('host-ownership-pending: unresolved owner');
  const api = apiFor(create);
  activeService = useService(activeStore, api);
  activeService.registerExistingTerminal('tm-wait', 'pc-ended');
  activeStore.dispatch(markSessionClosed({ terminalId: 'tm-wait', exitCode: 0 }));
  act(() => mount('tm-wait'));
  await flush();
  const restart = [...container.querySelectorAll('button')].find(button => button.textContent === 'Restart');
  expect(restart).toBeDefined();
  act(() => restart!.click());
  await flush();
  await act(async () => { await jest.advanceTimersByTimeAsync(90_000); });
  expect(activeStore.getState().ui.toasts).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'warning', message: expect.stringContaining('Waiting for terminal host') }),
  ]));
  expect(api.registerRestoringLeaves).not.toHaveBeenCalled();
});

test('move_a_waiting_pane_to_another_window_does_not_spawn_and_binds_in_the_destination', async () => {
  const sourceStore = activeStore;
  const destinationStore = makeStore();
  const tree = { id: 'pn-split', type: 'split' as const, direction: 'horizontal' as const, children: [leaf('tm-live'), leaf('tm-wait')] };
  seed(sourceStore, tree, 'tb-source');
  let resolved = false;
  const frames: Array<{ webview: string; frame: string; leaf: string }> = [];
  const createFor = (webview: string) => jest.fn(async (_p, _n, _c, id) => {
    if (!resolved) throw new Error('host-ownership-pending: frozen host listing delayed');
    frames.push({ webview, frame: 'Attach:old-host', leaf: id });
    return 'pc-old-host';
  });
  const sourceApi = apiFor(createFor('source'));
  const destinationApi = apiFor(createFor('destination'));
  const sourceService = useService(sourceStore, sourceApi);
  const destinationService = useService(destinationStore, destinationApi);
  sourceService.registerExistingTerminal('tm-live', 'pc-live');
  activeService = sourceService;
  act(() => mount('tm-wait'));
  await flush();
  await act(async () => { await jest.advanceTimersByTimeAsync(500); });
  act(() => root.render(null));
  act(() => sourceStore.dispatch(removeTabTree('tb-source')));
  sourceService.detachTerminal('tm-wait');
  sourceService.detachTerminal('tm-live');
  seed(destinationStore, tree, 'tb-destination');
  destinationService.attachExistingTerminal('tm-live', 'pc-live');
  activeStore = destinationStore;
  activeService = destinationService;
  (window as any).__REDUX_STORE__ = destinationStore;
  (window as any).electronAPI = destinationApi;
  act(() => mount('tm-wait'));
  await flush();
  expect(container.textContent).toContain('Waiting for terminal host');
  resolved = true;
  await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
  await flush();
  expect(frames).toEqual([{ webview: 'destination', frame: 'Attach:old-host', leaf: 'tm-wait' }]);
  expect(sourceApi.createTerminal).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-process-id="pc-old-host"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Failed to start shell');
  expect(destinationService.getProcessId('tm-wait')).toBe('pc-old-host');
  expect(sourceService.getProcessId('tm-wait')).toBeUndefined();
  expect(sourceApi.forgetRestoringLeaf).not.toHaveBeenCalled();
  expect(destinationApi.forgetRestoringLeaf).not.toHaveBeenCalled();
});
