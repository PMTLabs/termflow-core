/** @jest-environment jsdom */
jest.mock('../../components/TerminalContainer', () => ({ clearTabPanes: jest.fn() }));

import { configureStore } from '@reduxjs/toolkit';
import tabsReducer, { addTab } from '../../store/slices/tabsSlice';
import panesReducer, { addTabTree } from '../../store/slices/panesSlice';
import canvasReducer from '../../store/slices/canvasSlice';
import { StateManager } from '../StateManager';
import { sessionStateKey } from '../windowScope';
import { restoreTabPanesInPlace } from '../tabPanesStore';
import { pushUndo, __resetLayoutUndoForTests } from '../layoutUndo';
import { captureWorkspaceSnapshot } from '../workspaceSnapshot';
import { TerminalServiceClass } from '../TerminalService';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const leaf = (terminalId: string, sessionKey?: string) => ({ id: `pn-${terminalId}`, type: 'terminal' as const, terminalId, sessionKey });
const makeStore = () => configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer, canvas: canvasReducer } });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const savedLayout = (id = 'saved') => ({
  id, name: id, tabs: [{ id: 'tb-saved', title: 'Saved' }], activeTabId: 'tb-saved',
  activePaneId: 'pn-tm-saved', paneTree: leaf('tm-saved'), treesByTabId: { 'tb-saved': leaf('tm-saved') },
  createdAt: Date.now(), updatedAt: Date.now(),
});
let register: jest.Mock;
let store: ReturnType<typeof makeStore>;

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  __resetLayoutUndoForTests();
  (window as any).__TAB_PANES__ = {};
  (window as any).tabPanes = (window as any).__TAB_PANES__;
  register = jest.fn().mockResolvedValue(undefined);
  (window as any).electronAPI = { registerRestoringLeaves: register };
  store = makeStore();
  (window as any).__REDUX_STORE__ = store;
});
afterEach(() => { jest.useRealTimers(); });

test('loadLayout_and_loadTabScopedLayout_with_saved_tm_leaf_ids_are_registered', async () => {
  const layout = savedLayout();
  localStorage.setItem('auto-terminal-layouts', JSON.stringify([layout]));
  let release!: () => void;
  register.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const loading = StateManager.loadLayout('saved', store.dispatch);
  await jest.advanceTimersByTimeAsync(100);
  expect(register.mock.calls[0][0]).toEqual([{ leafId: 'tm-saved', sessionKey: undefined }]);
  expect(store.getState().tabs.tabs).toHaveLength(0);
  expect(store.getState().panes.treesByTabId).toEqual({});
  release();
  expect(await loading).toBe(true);
  expect(store.getState().panes.treesByTabId['tb-saved']).toMatchObject({ terminalId: 'tm-saved' });

  const scoped = { ...savedLayout('scoped'), scope: 'tab', scopedTabId: 'tb-saved' };
  localStorage.setItem('auto-terminal-layouts', JSON.stringify([scoped]));
  register.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const before = store.getState().panes.treesByTabId;
  const scopedLoading = StateManager.loadTabScopedLayout('scoped', store.dispatch);
  await flush();
  expect(register).toHaveBeenCalledTimes(2);
  expect(register.mock.calls[1][0]).toEqual([{ leafId: 'tm-saved', sessionKey: undefined }]);
  expect(store.getState().panes.treesByTabId).toBe(before);
  release();
  expect(await scopedLoading).toBe(true);
});

test.each(['workspace', 'tab'])('saved tm leaves from a %s layout wait without spawning while unresolved', async scope => {
  const registered = new Set<string>();
  register.mockImplementation(async leaves => leaves.forEach((item: any) => registered.add(item.sessionKey ?? item.leafId)));
  const layout = { ...savedLayout(), scope, scopedTabId: 'tb-saved' };
  localStorage.setItem('auto-terminal-layouts', JSON.stringify([layout]));
  const loading = scope === 'tab'
    ? StateManager.loadTabScopedLayout('saved', store.dispatch)
    : StateManager.loadLayout('saved', store.dispatch);
  await jest.advanceTimersByTimeAsync(100);
  expect(await loading).toBe(true);
  const frames: string[] = [];
  let resolved = false;
  const api = { createTerminal: jest.fn(async (_p, _n, _c, id) => {
    if (registered.has(id) && !resolved) throw 'host-ownership-pending: listing delayed';
    frames.push(registered.has(id) ? 'Attach:old-host' : 'Spawn:current-host');
    return 'pc-old-host';
  }) };
  // Listener wiring uses the webview bridge; the test's create transport is injected separately.
  delete (window as any).electronAPI;
  const service = new TerminalServiceClass(() => store.getState().panes.treesByTabId, () => api as any);
  const create = service.createTerminal('tm-saved');
  await flush();
  expect(frames).toEqual([]);
  expect(service.getHostWaitState('tm-saved')).toBe('waiting');
  resolved = true;
  await jest.advanceTimersByTimeAsync(1000);
  expect(await create).toBe('pc-old-host');
  expect(frames).toEqual(['Attach:old-host']);
});

test('restoreState registers modern and migrated keys before the window mirror mounts', async () => {
  const tree = { id: 'pn-split', type: 'split', direction: 'horizontal', children: [leaf('tm-modern'), leaf('tm-migrated', 'tb-legacy')] };
  localStorage.setItem(sessionStateKey(), JSON.stringify({ ...savedLayout(), timestamp: Date.now(), paneTree: tree, treesByTabId: { 'tb-saved': tree },
    tabPanes: { 'tb-saved': tree } }));
  let release!: () => void;
  register.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const restoring = StateManager.restoreState(store.dispatch);
  await flush();
  expect(register.mock.calls[0][0]).toEqual([
    { leafId: 'tm-modern', sessionKey: undefined }, { leafId: 'tm-migrated', sessionKey: 'tb-legacy' },
  ]);
  expect((window as any).__TAB_PANES__).toEqual({});
  expect(store.getState().tabs.tabs).toHaveLength(0);
  release();
  expect(await restoring).toBe(true);
  expect((window as any).__TAB_PANES__['tb-saved'].children[0].terminalId).toBe('tm-modern');
});

test('revertWorkspace registers snapshot leaves before reinstalling its mirror', async () => {
  store.dispatch(addTab({ id: 'tb-saved', title: 'Saved' }));
  store.dispatch(addTabTree({ tabId: 'tb-saved', tree: leaf('tm-saved') }));
  restoreTabPanesInPlace({ 'tb-saved': leaf('tm-saved') });
  pushUndo(captureWorkspaceSnapshot(store.getState() as any, 'Before'));
  let release!: () => void;
  register.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const reverting = StateManager.revertWorkspace(store.dispatch);
  await jest.advanceTimersByTimeAsync(100);
  expect(register.mock.calls[0][0]).toEqual([{ leafId: 'tm-saved', sessionKey: undefined }]);
  expect(store.getState().tabs.tabs).toHaveLength(0);
  release();
  expect(await reverting).toBe(true);
});

test('failed registration fails closed and automatically retries before mount', async () => {
  localStorage.setItem('auto-terminal-layouts', JSON.stringify([savedLayout()]));
  register.mockRejectedValueOnce(new Error('transport down'));
  const loading = StateManager.loadLayout('saved', store.dispatch);
  await jest.advanceTimersByTimeAsync(100);
  expect(store.getState().panes.treesByTabId).toEqual({});
  expect(store.getState().tabs.tabs).toHaveLength(0);
  await jest.advanceTimersByTimeAsync(999);
  expect(register).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(await loading).toBe(true);
  expect(register).toHaveBeenCalledTimes(2);
});

test('failed restore registration preserves saved state for Retry without mounting leaves', async () => {
  localStorage.setItem(sessionStateKey(), JSON.stringify({ ...savedLayout(), timestamp: Date.now(), tabPanes: { 'tb-saved': leaf('tm-saved') } }));
  register.mockRejectedValue(new Error('transport down'));
  const restoring = StateManager.restoreState(store.dispatch);
  await flush();
  await jest.advanceTimersByTimeAsync(90_000);
  expect(await restoring).toBe(false);
  expect(localStorage.getItem(sessionStateKey())).not.toBeNull();
  expect(store.getState().tabs.tabs).toHaveLength(0);
  expect((window as any).__TAB_PANES__).toEqual({});
});

test('a newer replacement supersedes a load waiting at the registration await', async () => {
  const a = savedLayout('A');
  const b = { ...savedLayout('B'), tabs: [{ id: 'tb-B', title: 'B' }], activeTabId: 'tb-B', paneTree: leaf('tm-B'), treesByTabId: { 'tb-B': leaf('tm-B') } };
  localStorage.setItem('auto-terminal-layouts', JSON.stringify([a, b]));
  let release!: () => void;
  register.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const first = StateManager.loadLayout('A', store.dispatch);
  await jest.advanceTimersByTimeAsync(100);
  const second = StateManager.loadLayout('B', store.dispatch);
  await jest.advanceTimersByTimeAsync(100);
  expect(await second).toBe(true);
  release();
  expect(await first).toBe(false);
  expect(store.getState().tabs.tabs.map(tab => tab.id)).toEqual(['tb-B']);
  expect(store.getState().panes.treesByTabId).toEqual({ 'tb-B': expect.objectContaining({ terminalId: 'tm-B' }) });
});

test('superseding a failed registration during backoff stops its retries and prevents stale mounting', async () => {
  const a = savedLayout('A');
  const b = { ...savedLayout('B'), tabs: [{ id: 'tb-B', title: 'B' }], activeTabId: 'tb-B', paneTree: leaf('tm-B'), treesByTabId: { 'tb-B': leaf('tm-B') } };
  localStorage.setItem('auto-terminal-layouts', JSON.stringify([a, b]));
  register.mockRejectedValueOnce(new Error('transport down'));
  const first = StateManager.loadLayout('A', store.dispatch);
  await jest.advanceTimersByTimeAsync(100);
  expect(register).toHaveBeenCalledTimes(1);
  const second = StateManager.loadLayout('B', store.dispatch);
  await jest.advanceTimersByTimeAsync(100);
  expect(await second).toBe(true);
  await jest.advanceTimersByTimeAsync(900);
  expect(await first).toBe(false);
  expect(register).toHaveBeenCalledTimes(2);
  expect(store.getState().tabs.tabs.map(tab => tab.id)).toEqual(['tb-B']);
});

test('a tab-scoped registration await cannot mount on top of a newer workspace replacement', async () => {
  localStorage.setItem('auto-terminal-layouts', JSON.stringify([savedLayout('scoped'), savedLayout('workspace')]));
  let release!: () => void;
  register.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const scoped = StateManager.loadTabScopedLayout('scoped', store.dispatch);
  await flush();
  const workspace = StateManager.loadLayout('workspace', store.dispatch);
  await jest.advanceTimersByTimeAsync(100);
  expect(await workspace).toBe(true);
  const before = store.getState();
  release();
  expect(await scoped).toBe(false);
  expect(store.getState()).toBe(before);
});

test('user-created, API-created and split-created fresh leaves do not register', async () => {
  store.dispatch(addTab({ id: 'tb-fresh', title: 'User tab' }));
  store.dispatch(addTabTree({ tabId: 'tb-fresh', tree: {
    id: 'pn-split', type: 'split', direction: 'horizontal', children: [leaf('tm-user'), leaf('tm-api'), leaf('tm-split')],
  } }));
  delete (window as any).electronAPI;
  const api = { createTerminal: jest.fn().mockResolvedValue('pc-fresh') };
  const service = new TerminalServiceClass(() => store.getState().panes.treesByTabId, () => api as any);
  await Promise.all(['tm-user', 'tm-api', 'tm-split'].map(id => service.createTerminal(id)));
  expect(api.createTerminal).toHaveBeenCalledTimes(3);
  expect(register).not.toHaveBeenCalled();
});

test('clearCurrentState cancels a waiting leaf by absence without forgetting its restore intent', async () => {
  store.dispatch(addTab({ id: 'tb-wait', title: 'Waiting' }));
  store.dispatch(addTabTree({ tabId: 'tb-wait', tree: leaf('tm-wait') }));
  const api = {
    createTerminal: jest.fn().mockRejectedValue('host-ownership-pending: delayed'),
    forgetRestoringLeaf: jest.fn().mockResolvedValue(undefined),
  };
  delete (window as any).electronAPI;
  const service = new TerminalServiceClass(() => store.getState().panes.treesByTabId, () => api as any);
  const creating = service.createTerminal('tm-wait');
  await flush();
  (StateManager as any).clearCurrentState(store.dispatch);
  await jest.advanceTimersByTimeAsync(1000);
  expect(await creating).toBe('');
  expect(api.createTerminal).toHaveBeenCalledTimes(1);
  expect(api.forgetRestoringLeaf).not.toHaveBeenCalled();
});

/** Census the install operations, not a hand-written list of layout-loader names. */
function unregisteredInstallers(source: string): string[] {
  const ast = ts.createSourceFile('StateManager.ts', source, ts.ScriptTarget.Latest, true);
  const failures: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.body) {
      const calls: ts.CallExpression[] = [];
      const walk = (child: ts.Node) => {
        if (ts.isCallExpression(child)) calls.push(child);
        ts.forEachChild(child, walk);
      };
      walk(node.body);
      const name = (call: ts.CallExpression) => ts.isPropertyAccessExpression(call.expression)
        ? call.expression.name.text : call.expression.getText(ast);
      const installs = calls.filter(call => ['addTabTree', 'restoreTabPanesInPlace', 'populateWorkspace'].includes(name(call)));
      if (installs.length) {
        const first = installs[0];
        const registration = calls.find(call => name(call) === 'registerRestoringTrees' && call.pos < first.pos);
        const awaited = (call: ts.CallExpression) => ts.isAwaitExpression(call.parent);
        if (!(registration && awaited(registration)) && !(name(first) === 'populateWorkspace' && awaited(first))) {
          failures.push('name' in node && node.name ? node.name.getText(ast) : '(anonymous helper)');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return failures;
}

test('persisted tree installer census requires registration before every install operation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'StateManager.ts'), 'utf8');
  expect(unregisteredInstallers(source)).toEqual([]);
  // Prove an installer nobody named in this test cannot evade the census.
  expect(unregisteredInstallers('class Loader { newInstaller(data, dispatch) { dispatch(addTabTree({ tree: data.paneTree })); } }')).toEqual(['newInstaller']);
  expect(unregisteredInstallers('function newHelper(data, dispatch) { dispatch(addTabTree({ tree: data.paneTree })); }')).toEqual(['newHelper']);

  // Classify every other renderer tree installer as fresh, already-bound, or a move.
  // Counts pin the operations, so adding an installer even to an existing file needs classification.
  const renderer = path.join(__dirname, '..', '..');
  const otherInstallers: Record<string, number> = {};
  const scan = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') scan(filename);
      } else if (/\.tsx?$/.test(filename) && !filename.endsWith('StateManager.ts')) {
        const ast = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
        let installs = 0;
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node)) {
            const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(ast);
            if (['addTabTree', 'restoreTabPanesInPlace', 'populateWorkspace'].includes(name)) installs++;
          }
          ts.forEachChild(node, visit);
        };
        visit(ast);
        if (installs) otherInstallers[path.relative(renderer, filename).replace(/\\/g, '/')] = installs;
      }
    }
  };
  scan(renderer);
  expect(otherInstallers).toEqual({
    'App.tsx': 1, // recovered host session, already reserved
    'services/apiCreatedTab.ts': 1, // fresh API leaf
    'services/restoreHiddenAgentTerminals.ts': 1, // already-bound live process
    'components/Canvas/CanvasMode.tsx': 1, // moves an existing leaf
    'components/TerminalContainer.tsx': 2, // mirror adoption / fresh tree seeding
    'components/Panes/dnd/detach.ts': 1, // cross-window handoff, not a close or a layout load
  });
});
