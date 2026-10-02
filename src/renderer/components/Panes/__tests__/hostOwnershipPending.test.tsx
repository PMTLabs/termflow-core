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
import { PaneIncarnations, installPaneIncarnations, type PaneBridge, type PaneRequest } from '../../../services/paneIncarnations';
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
import { detachTabToNewWindow } from '../dnd/detach';
import { StateManager } from '../../../services/StateManager';
import { restoreTabPanesInPlace } from '../../../services/tabPanesStore';
import { pushUndo, __resetLayoutUndoForTests } from '../../../services/layoutUndo';
import { captureWorkspaceSnapshot } from '../../../services/workspaceSnapshot';

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
const mount = (id: string, paneId = id) => {
  root.render(<Provider store={activeStore}><TerminalPane paneId={paneId} terminalId={id} isActive solo onSplit={() => {}} onClose={() => {}} onFocus={() => {}} /></Provider>);
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
  expect(container.textContent).not.toContain('Waiting for terminal host');
  await act(async () => { await jest.advanceTimersByTimeAsync(400); });
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

test('handleRestart surfaces lifecycle busy after its short retry budget', async () => {
  seed(activeStore);
  const create = jest.fn().mockRejectedValue(new Error('LIFECYCLE_BUSY: TermFlow is updating'));
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
  await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
  expect(create).toHaveBeenCalledTimes(21);
  expect(activeStore.getState().ui.toasts).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'warning', message: expect.stringContaining('exiting or updating') }),
  ]));
  expect(api.registerRestoringLeaves).not.toHaveBeenCalled();
  expect(activeStore.getState().sessionExit.byTerminalId['tm-wait']).toBeDefined();
});

test.each([true, false])('the mounted waiting source rebinds its original placement after failed detach with completionBeforeCancel=%s', async beforeCancel => {
  seed(activeStore); seed(activeStore, leaf('tm-control'), 'tb-control');
  const ops: PaneRequest[] = [];
  let complete!: (pc: string) => void;
  let failBuild!: (error: Error) => void;
  const work = jest.fn(() => new Promise<string>(resolve => { complete = resolve; }));
  const bridge = (async (command: string, args: any) => {
    if (command === 'register_page') return { status: 'Registered', wi: 4, pg: 40 };
    if (command === 'create_admitted_terminal') return work(args);
    if (command === 'wait_transfer_taken') return new Promise(() => {});
    ops.push(args.request);
    return { status: 'Ack', result: args.request.op.kind === 'admit_create' ? { status: 'Create', cg: 77 } : { status: 'Ok' } };
  }) as PaneBridge;
  const client = new PaneIncarnations(bridge);
  installPaneIncarnations(client); client.attachStore(activeStore);
  const api = { ...apiFor(jest.fn()), createDetachedWindow: jest.fn(() => new Promise((_resolve, reject) => { failBuild = reject; })) };
  activeService = useService(activeStore, api);
  activeService.registerExistingTerminal('tm-control', 'pc-control');
  const published = jest.spyOn(activeService as any, 'bindProcess');
  try {
    act(() => root.render(<Provider store={activeStore}>
      <TerminalPane paneId="tm-wait" terminalId="tm-wait" isActive onSplit={() => {}} onClose={() => {}} onFocus={() => {}} />
      <TerminalPane paneId="tm-control" terminalId="tm-control" isActive onSplit={() => {}} onClose={() => {}} onFocus={() => {}} />
    </Provider>));
    await flush();
    expect(work).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-process-id="pc-control"]')).not.toBeNull();
    const original = client.capture('tm-wait', 'tm-wait')!;
    const control = client.capture('tm-control', 'tm-control')!;
    const detaching = detachTabToNewWindow({ tabId: 'tb-wait', tabTitle: 'Waiting' }).catch(error => error.message);
    await flush();
    expect(api.createDetachedWindow).toHaveBeenCalledTimes(1);
    expect(ops.filter(request => request.op.kind === 'stash')).toHaveLength(1);
    if (beforeCancel) { await act(async () => complete('pc-original')); await flush(); }
    expect(container.querySelector('[data-process-id="pc-original"]')).toBeNull();
    await act(async () => failBuild(new Error('build refused')));
    await flush();
    expect(await detaching).toBe('build refused');
    expect(client.capture('tm-wait', 'tm-wait')).not.toBe(original);
    expect(client.capture('tm-control', 'tm-control')).toBe(control);
    if (!beforeCancel) {
      expect(container.querySelector('[data-process-id="pc-original"]')).toBeNull();
      expect(ops.filter(request => request.op.kind === 'admit_create')).toHaveLength(1);
      await act(async () => complete('pc-original')); await flush();
    }
    expect(container.querySelectorAll('[data-process-id="pc-original"]')).toHaveLength(1);
    expect(published.mock.calls.filter(([id, pc]) => id === 'tm-wait' && pc === 'pc-original')).toHaveLength(1);
    expect(work).toHaveBeenCalledTimes(1);
    expect(ops.filter(request => request.op.kind === 'bind')).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: { kind: 'bind', pi: await client.capture('tm-wait', 'tm-wait'), pc: 'pc-original', via: 'restore' } }),
    ]));
    expect(activeService.getProcessId('tm-control')).toBe('pc-control');
    expect(api.createTerminal).not.toHaveBeenCalled();
  } finally { published.mockRestore(); client.stop(); installPaneIncarnations(new PaneIncarnations()); }
});

test.each(['load', 'revert'])('a %s with the same leaf waits for an old create without borrowing its init lock', async action => {
  seed(activeStore);
  let complete!: (pc: string) => void;
  const work = jest.fn(() => new Promise<string>(resolve => { complete = resolve; }));
  const ops: PaneRequest[] = [];
  const client = new PaneIncarnations((async (command: string, args: any) => {
    if (command === 'register_page') return { status: 'Registered', wi: 4, pg: 40 };
    if (command === 'create_admitted_terminal') return work();
    ops.push(args.request);
    return { status: 'Ack', result: args.request.op.kind === 'admit_create' ? { status: 'Create', cg: 77 } : { status: 'Ok' } };
  }) as PaneBridge);
  installPaneIncarnations(client); client.attachStore(activeStore);
  activeService = useService(activeStore, apiFor(jest.fn()));
  localStorage.clear(); __resetLayoutUndoForTests();
  const tree = leaf('tm-wait');
  localStorage.setItem('auto-terminal-layouts', JSON.stringify([{ id: 'same', name: 'same', tabs: [{ id: 'tb-wait', title: 'Waiting' }], activeTabId: 'tb-wait', activePaneId: tree.id, paneTree: tree, treesByTabId: { 'tb-wait': tree }, createdAt: Date.now(), updatedAt: Date.now() }]));
  restoreTabPanesInPlace({ 'tb-wait': tree });
  pushUndo(captureWorkspaceSnapshot(activeStore.getState(), 'Before'));
  const oldFetch = global.fetch; global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
  try {
    act(() => mount('tm-wait')); await flush();
    expect(work).toHaveBeenCalledTimes(1);
    const old = client.capture('tm-wait', 'tm-wait');
    let replacement!: Promise<boolean>;
    act(() => {
      replacement = action === 'load' ? StateManager.loadLayout('same', activeStore.dispatch) : StateManager.revertWorkspace(activeStore.dispatch);
      root.render(null);
    });
    await act(async () => jest.advanceTimersByTimeAsync(100));
    expect(await replacement).toBe(true);
    const restoredPaneId = activeStore.getState().panes.treesByTabId['tb-wait'].id;
    act(() => mount('tm-wait', restoredPaneId)); await flush();
    expect(client.capture('tm-wait', restoredPaneId)).not.toBe(old);
    expect(container.querySelector('[data-process-id="pc-original"]')).toBeNull();
    await act(async () => complete('pc-original')); await flush();
    expect(container.querySelectorAll('[data-process-id="pc-original"]')).toHaveLength(1);
    expect(work).toHaveBeenCalledTimes(1);
    expect(ops.filter(request => request.op.kind === 'admit_create')).toHaveLength(1);
  } finally { global.fetch = oldFetch; client.stop(); installPaneIncarnations(new PaneIncarnations()); }
});

test('a moved waiting pane joins the original placement through the stream and mounts its exact process', async () => {
  const sourceStore = activeStore;
  seed(sourceStore);
  const ops: PaneRequest[] = [];
  const work: Array<{ pg: number; cg: number; leaf: string }> = [];
  const completions: Array<(pc: string) => void> = [];
  const descriptor = { paneId: 'tm-wait', leaf: 'tm-wait' };
  const bridge = (pg: number): PaneBridge => (async (command: string, args: any) => {
    if (command === 'register_page') return { status: 'Registered', wi: pg, pg };
    if (command === 'create_admitted_terminal') {
      work.push(args.request);
      return new Promise<string>(resolve => completions.push(resolve));
    }
    if (command !== 'pane_op') throw new Error(`unexpected ${command}`);
    const request = args.request as PaneRequest;
    ops.push(request);
    const result = request.op.kind === 'take' ? { status: 'Taken', payload: { panes: [descriptor] } }
      : request.op.kind === 'admit_create' ? { status: pg === 40 ? 'Create' : 'Join', cg: 77 }
      : { status: 'Ok' };
    return { status: 'Ack', result };
  }) as PaneBridge;
  const source = new PaneIncarnations(bridge(40));
  const destination = new PaneIncarnations(bridge(41));
  const api = apiFor(jest.fn());
  const sourceService = new TerminalServiceClass(() => sourceStore.getState().panes.treesByTabId, () => api as any, () => source);
  sourceService.registerExistingTerminal('tm-control', 'pc-control');
  try {
    const pending = sourceService.createTerminal('tm-wait', 'default', undefined, undefined, undefined, undefined, 'tb-wait', undefined, false, 'Mount', 'tm-wait');
    await flush();
    expect(work).toHaveLength(1);
    await source.stash('tx-wait', [descriptor]);
    act(() => sourceStore.dispatch(removeTabTree('tb-wait')));
    const destinationStore = makeStore();
    activeStore = destinationStore;
    (window as any).__REDUX_STORE__ = destinationStore;
    (window as any).electronAPI = api;
    installPaneIncarnations(destination);
    activeService = new TerminalServiceClass(() => destinationStore.getState().panes.treesByTabId, () => api as any, () => destination);
    await destination.installTransfer('tx-wait', [descriptor], () => { seed(destinationStore); });
    act(() => mount('tm-wait'));
    await flush();
    expect(work.map(({ pg, cg, leaf }) => ({ pg, cg, leaf }))).toEqual([
      { pg: 40, cg: 77, leaf: 'tm-wait' }, { pg: 41, cg: 77, leaf: 'tm-wait' },
    ]);
    expect(container.textContent).not.toContain('Failed to start shell');
    expect(container.querySelector('[data-process-id="pc-old-host"]')).toBeNull();
    await act(async () => { completions.forEach(resolve => resolve('pc-old-host')); });
    await flush();
    expect(await pending).toBe('');
    expect(container.querySelector('[data-process-id="pc-old-host"]')).not.toBeNull();
    expect(activeService.getProcessId('tm-wait')).toBe('pc-old-host');
    expect(sourceService.getProcessId('tm-wait')).toBeUndefined();
    expect(sourceService.getProcessId('tm-control')).toBe('pc-control');
    expect(ops.map(({ op }) => op.kind)).toEqual(['enter', 'admit_create', 'stash', 'take', 'adopt', 'admit_create']);
    expect(api.createTerminal).not.toHaveBeenCalled();
  } finally {
    source.stop();
    installPaneIncarnations(new PaneIncarnations());
  }
});
