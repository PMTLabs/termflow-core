/** @jest-environment jsdom */
/** `tauri-bridge` registers listeners at module load and dies outside a Tauri WebView; the tests
 * install their own `window.electronAPI`. TerminalDisplay reads only the Windows build number. */
jest.mock('../../../api/tauri-bridge', () => ({ __esModule: true, default: {}, getWindowsBuildNumber: () => 0 }));
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { store } from '../../../store';
import sshReducer from '../../../store/slices/sshSlice';
import { addTabTree, movePaneWithinTab, removeTabTree, setActiveTabId } from '../../../store/slices/panesSlice';
import { addTab, clearAllTabs, removeTab } from '../../../store/slices/tabsSlice';
import { hydrateCanvas, pruneCanvasGeometry, setEdges, setNodeGeom, setOverlayNode, setViewport } from '../../../store/slices/canvasSlice';
import { setDefaultProfile, setShellProfiles } from '../../../store/slices/settingsSlice';
import { button, key, otherProfile, profile, saved } from '../../../__testFixtures__/sshPickerFixture';
import { sshTwoWindowBridge } from '../../../__testFixtures__/sshTwoWindowBridge';
import { hydrateSsh } from '../../../services/sshHydration';
import { installSshSessionEvents, sshOwnersFromTrees } from '../../../services/sshSessionEvents';
import { PaneIncarnations, installPaneIncarnations, paneIncarnations } from '../../../services/paneIncarnations';
import { clearTabPanesInPlace } from '../../../services/tabPanesStore';
import { terminalService } from '../../../services/TerminalService';
import { inputHandler } from '../../../services/InputHandler';
import { openCanvasTab } from '../../../services/openCanvas';
import type { LaunchAttemptRef, SshConnection, SshReply, SshSessionView } from '../../../types/ssh';
import { CanvasMode } from '../../Canvas/CanvasMode';
import { selectCanvasModel } from '../../Canvas/canvasSelectors';
import { NODE_H, NODE_W } from '../../Canvas/canvasGeometry';
import { spawnRectNear } from '../../Canvas/canvasSpawn';
import { TabManager } from '../../Tabs/TabManager';
import { SshConnectionsPanel } from '../../Settings/SshConnections/SshConnectionsPanel';
import { SshConnectionsDialogHost } from '../AllSshConnectionsDialog';
import { OwnedSshLaunchNotice } from '../OwnedSshLaunchNotice';

import { publishSshCanvasVisible } from '../sshPresentations';
import { buildTabDetachPayload } from '../../Panes/dnd/detach';
import { findLeafByTerminalId } from '../../../store/slices/paneTreeOps';

const SOURCE = 'tm-source';
const sourceRect = { x: 45, y: 35, w: NODE_W, h: NODE_H };
const controls = () => ({
  tabs: store.getState().tabs.tabs.map(t => t.id),
  nodes: selectCanvasModel(store.getState()).nodes.map(n => n.terminalId),
  geometry: store.getState().canvas.nodes,
  edges: store.getState().canvas.edges,
});
const ops = (command: string) => bus.invokes.filter(call => call.command === command);
const owners = () => sshOwnersFromTrees(store.getState().panes.treesByTabId);
const dropdown = () => b.dom.querySelector('.dropdown-menu')!;
const popup = () => document.querySelector('.canvas-profile-menu')!;
const pick = (label: string, scope: ParentNode = document) => act(() => button(label, scope).click());
const labels = (scope: ParentNode) => [...scope.querySelectorAll('.ssh-menu-label')]
  .filter(label => label.querySelector('small')).map(label => label.firstElementChild?.textContent);
const query = <T extends HTMLElement = HTMLElement>(scope: ParentNode, selector: string) => {
  const element = scope.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

let bus: ReturnType<typeof sshTwoWindowBridge>;
let a: ReturnType<typeof rootInBody>;
let b: ReturnType<typeof rootInBody>;
let stop: (() => void)[];
let originalBridge: typeof window.electronAPI;
const localTerminals = new Set<string>();
function rootInBody() {
  const dom = document.body.appendChild(document.createElement('div'));
  const root: Root = createRoot(dom);
  return { dom, root };
}

async function setup(connections: SshConnection[], opts: { holdGet?: boolean; source?: boolean } = {}) {
  // Production services use the renderer's singleton. B uses that real window
  // store; A has a separate Redux store running the same SSH slice reducer.
  const aStore = configureStore({ reducer: { ssh: sshReducer } });
  const revision = store.getState().ssh.revision + 1;
  const initial: SshReply = { revision, view: { revision, folders: [], connections, loadError: null } };
  bus = sshTwoWindowBridge(initial, (id, connection) => owners()[id] === connection);
  originalBridge = window.electronAPI;
  window.electronAPI = bus.B.api as unknown as typeof window.electronAPI;
  const panes = new PaneIncarnations(bus.B.api.paneInvoke);
  installPaneIncarnations(panes);
  panes.attachStore(store);
  const aHydration = hydrateSsh(bus.A.api.ssh, aStore.dispatch);
  const bHydration = hydrateSsh(bus.B.api.ssh, store.dispatch);
  stop.push(aHydration.stop, bHydration.stop, installSshSessionEvents(store, window.electronAPI));
  await act(async () => {}); // listeners are installed and both gets are in flight
  await act(async () => {
    expect(bus.invokes.filter(call => call.command === 'ssh_store_get').map(call => call.window)).toEqual(['A', 'B']);
    bus.held.release('A:get', 0, initial);
    if (opts.holdGet) bus.B.emit('ssh-store:changed', initial);
    else bus.held.release('B:get', 0, initial);
    store.dispatch(setShellProfiles([otherProfile, profile]));
    store.dispatch(setDefaultProfile(profile.id));
    store.dispatch(hydrateCanvas({ viewport: { x: 0, y: 0, z: 1 }, dynamicSpacing: false }));
    if (opts.source) {
      store.dispatch(setNodeGeom({ id: SOURCE, rect: sourceRect }));
      store.dispatch(addTabTree({ tabId: 'source-tab', tree: { id: 'source-pane', type: 'terminal', terminalId: SOURCE } }));
      store.dispatch(addTab({ id: 'source-tab', title: 'Source', shellType: profile.id, icon: '' }));
    }
    openCanvasTab();
  });
  window.electronAPI = bus.A.api as unknown as typeof window.electronAPI;
  await act(async () => a.root.render(<Provider store={aStore}><SshConnectionsPanel /></Provider>));
  window.electronAPI = bus.B.api as unknown as typeof window.electronAPI;
  renderB();
  return { initial, aStore, bHydration };
}

function renderB(notice?: React.ReactNode) {
  act(() => b.root.render(<Provider store={store}><SshConnectionsDialogHost>
    <TabManager /><CanvasMode />{notice}
  </SshConnectionsDialogHost></Provider>));
}
function openTabMenu() {
  act(() => query<HTMLButtonElement>(b.dom, '[aria-label="New tab options"]').click());
  expect(dropdown()).not.toBeNull();
}
function openBackground() {
  act(() => {
    query(b.dom, '.canvas-viewport').dispatchEvent(new MouseEvent('contextmenu', {
      clientX: 370, clientY: 240, button: 2, bubbles: true, cancelable: true,
    }));
  });
  expect(popup().textContent).toContain('New terminal here');
}
function openConnector() {
  act(() => { store.dispatch(setViewport({ x: 0, y: 0, z: 1 })); });
  act(() => {
    const port = query(b.dom, `[data-terminal-id="${SOURCE}"] [data-port="e"]`);
    port.dispatchEvent(new MouseEvent('pointerdown', { clientX: 60, clientY: 60, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 60, clientY: 60 }));
  });
  expect(popup().textContent).toContain('Connect a new terminal');
}
async function dismissCanvasMenu() {
  await act(async () => {
    // CanvasMenu intentionally arms its outside/key listeners on the next frame.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    key(window, 'Escape');
  });
  expect(popup()).toBeNull();
}

// Exercise the actual mount-side service with the canonical leaf, without
// opening an xterm canvas in jsdom. It uses real pane admission and the real SSH
// coordinator; only the native result comes from the bridge fixture.
async function mountShell(connectionId: string) {
  const tab = store.getState().tabs.tabs.at(-1)!;
  const tree = store.getState().panes.treesByTabId[tab.id]!;
  const id = tree.terminalId!;
  expect(id).toMatch(/^tm-/);
  expect(tree.ssh?.connectionId).toBe(connectionId);
  expect(tab.shellType).toBe(profile.id);
  localTerminals.add(id);
  let pc = '';
  await act(async () => {
    pc = await terminalService.createTerminal(id, tab.shellType, tab.title, undefined, undefined, undefined,
      tab.id, undefined, false, 'Mount', tree.id, tree.ssh?.connectionId);
  });
  expect(pc).toMatch(/^pc-/);
  return { id, tabId: tab.id, paneId: tree.id, pc };
}

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
});
beforeEach(() => { a = rootInBody(); b = rootInBody(); stop = []; });
afterEach(async () => {
  await act(async () => { b.root.unmount(); a.root.unmount(); });
  stop.forEach(dispose => dispose());
  installPaneIncarnations(new PaneIncarnations());
  for (const id of localTerminals) terminalService.detachTerminal(id);
  localTerminals.clear();
  for (const tabId of Object.keys(store.getState().panes.treesByTabId)) store.dispatch(removeTabTree(tabId));
  store.dispatch(clearAllTabs());
  store.dispatch(setEdges([]));
  store.dispatch(pruneCanvasGeometry({ terminalIds: [], tabIds: [] }));
  clearTabPanesInPlace();
  window.electronAPI = originalBridge;
  a.dom.remove(); b.dom.remove();
  jest.useRealTimers();
});
afterAll(() => inputHandler.destroy());

test.each(['background', 'active', 'attach', 'closed', 'canvas', 'moved', 'cancelled', 'swapped', 'fresh'])('restored SSH launch: %s', async scenario => {
  const connection = saved('restore');
  await setup([connection]);
  const tabId = 'restore-tab';
  const paneId = 'restore-pane';
  const id = 'tm-restored';
  const background = store.getState().tabs.activeTabId!;
  const launchCounts = () => ['ssh_session_open', 'ssh_terminal_launch'].map(command =>
    ops(command).filter(call => call.args?.terminalId === id).length);
  await act(async () => {
    paneIncarnations.prepare([{ paneId, leaf: id, restore: scenario !== 'fresh' }]);
    store.dispatch(addTabTree({ tabId, tree: {
      id: paneId, type: 'terminal', terminalId: id, ssh: { connectionId: connection.id, browserCollapsed: true, followCd: false, hiddenMetrics: [] },
    } }));
    store.dispatch(addTab({ id: tabId, title: tabId, shellType: profile.id, icon: '' }));
    store.dispatch(setActiveTabId(scenario === 'active' ? tabId : background));
  });
  if (scenario === 'attach') {
    // A hookless surviving shell still has a reattach seed.
    window.electronAPI = { ...window.electronAPI, takeReattachPromptHook: async () => ({ promptHook: false, atPrompt: false }) };
  }
  const shell = await mountShell(connection.id);
  if (scenario === 'attach') expect(store.getState().sshSession.byTerminal[id]?.reattachedProcessId).toBe(shell.pc);
  // Only a restored pane waits; a new SSH pane in a background tab launches at once.
  const immediate = scenario === 'active' || scenario === 'fresh';
  expect(launchCounts()).toEqual(immediate ? [1, 1] : [0, 0]);
  const deferred = !immediate && scenario !== 'attach';
  // Only this pane's tab or this pane's Canvas node counts as its activation.
  const unrelated = 'unrelated-tab';
  await act(async () => {
    store.dispatch(addTabTree({ tabId: unrelated, tree: { id: 'unrelated-pane', type: 'terminal', terminalId: 'tm-unrelated' } }));
    store.dispatch(addTab({ id: unrelated, title: unrelated, shellType: profile.id, icon: '' }));
    if (scenario !== 'active') store.dispatch(setActiveTabId(unrelated));
    publishSshCanvasVisible('tm-unrelated', true)();
    publishSshCanvasVisible(id, false)();
  });
  expect(launchCounts()).toEqual(immediate ? [1, 1] : [0, 0]);
  // A pane carried to another window before activation tells that window to launch it.
  expect(buildTabDetachPayload(tabId, tabId)!.terminals[0].sshLaunchDeferred).toBe(deferred ? true : undefined);
  if (scenario === 'cancelled') {
    // A cancelled drag re-mints the pane's owner and rebinds the same process.
    const before = paneIncarnations.capture(id, paneId);
    await act(async () => {
      await paneIncarnations.cancel('tx-cancelled', [{ paneId, leaf: id, restore: true }], new Map([[id, shell.pc]]));
    });
    expect(paneIncarnations.capture(id, paneId)).not.toBe(before);
    expect(launchCounts()).toEqual([0, 0]);
  }
  if (scenario === 'swapped') {
    // A center drop swaps leaves: the terminal now lives under the other pane id.
    await act(async () => {
      const leaf = store.getState().panes.treesByTabId[tabId]!;
      store.dispatch(addTabTree({ tabId, tree: { id: 'swap-split', type: 'split', direction: 'horizontal', children: [
        leaf, { id: 'swap-pane', type: 'terminal', terminalId: 'tm-swap' },
      ] } as any }));
      store.dispatch(movePaneWithinTab({ tabId, sourcePaneId: paneId, targetPaneId: 'swap-pane', zone: 'center' }));
    });
    expect(findLeafByTerminalId(store.getState().panes.treesByTabId, id)?.id).toBe('swap-pane');
    expect(launchCounts()).toEqual([0, 0]);
  }
  if (scenario === 'moved') {
    // The receiving window's first launch query starts it, before any activation.
    await act(async () => {
      terminalService.stashCarriedSshLaunch(id, 'pc-other');
      await terminalService.querySshLaunch(id, paneId, paneIncarnations.capture(id, paneId)!, shell.pc, connection.id, () => true);
      expect(launchCounts()).toEqual([0, 0]); // A carried flag for another process is not this one's.
      terminalService.stashCarriedSshLaunch(id, shell.pc);
      await terminalService.querySshLaunch(id, paneId, paneIncarnations.capture(id, paneId)!, shell.pc, connection.id, () => true);
    });
    expect(launchCounts()).toEqual([1, 1]);
  }
  let retract: (() => void) | undefined;
  await act(async () => {
    if (scenario === 'closed') store.dispatch(removeTabTree(tabId));
    if (scenario === 'canvas') retract = publishSshCanvasVisible(id, true);
    else store.dispatch(setActiveTabId(tabId));
  });
  const expected = scenario === 'attach' || scenario === 'closed' ? [0, 0] : [1, 1];
  expect(launchCounts()).toEqual(expected);
  if (scenario !== 'closed') expect(buildTabDetachPayload(tabId, tabId)!.terminals[0].sshLaunchDeferred).toBeUndefined();
  await act(async () => {
    retract?.();
    store.dispatch(setActiveTabId(background));
    store.dispatch(setActiveTabId(tabId));
  });
  expect(launchCounts()).toEqual(expected);
});

test('a pane carried in but not yet mounted stays owed when it moves on (A to B to C)', async () => {
  const tabId = 'relay-tab';
  const id = 'tm-relay';
  localTerminals.add(id);
  await act(async () => {
    store.dispatch(addTabTree({ tabId, tree: { id: 'relay-pane', type: 'terminal', terminalId: id } }));
    store.dispatch(addTab({ id: tabId, title: tabId, shellType: profile.id, icon: '' }));
  });
  // Window B: attached from A's payload, launch still owed, never mounted.
  terminalService.attachExistingTerminal(id, 'pc-relay');
  terminalService.stashCarriedSshLaunch(id, 'pc-relay');
  expect(buildTabDetachPayload(tabId, tabId)!.terminals[0].sshLaunchDeferred).toBe(true);
  // Only for that process, and gone once B lets the pane go.
  terminalService.attachExistingTerminal(id, 'pc-later');
  expect(buildTabDetachPayload(tabId, tabId)!.terminals[0].sshLaunchDeferred).toBeUndefined();
  terminalService.attachExistingTerminal(id, 'pc-relay');
  terminalService.detachTerminal(id);
  terminalService.attachExistingTerminal(id, 'pc-relay');
  expect(buildTabDetachPayload(tabId, tabId)!.terminals[0].sshLaunchDeferred).toBeUndefined();
});

test('sshCrossWindowSave_updatesBothMenus_withoutReload', async () => {
  const { initial, aStore, bHydration } = await setup([saved('anchor', { bookmarked: true }), saved('new', { order: 1 })], { holdGet: true, source: true });
  openTabMenu(); openBackground();
  expect(labels(dropdown())).toEqual(['anchor']);
  expect(labels(popup())).toEqual(['anchor']);

  window.electronAPI = bus.A.api as unknown as typeof window.electronAPI;
  await act(async () => query<HTMLButtonElement>(a.dom, '[aria-label="Bookmark new"]').click());
  window.electronAPI = bus.B.api as unknown as typeof window.electronAPI;
  expect(ops('ssh_set_bookmark')).toEqual([{ window: 'A', command: 'ssh_set_bookmark', args: { id: 'new', bookmarked: true } }]);
  expect(aStore.getState().ssh.revision).toBe(initial.revision + 1);
  expect(store.getState().ssh.revision).toBe(initial.revision);
  act(() => bus.B.emit('ssh-store:changed', bus.mutations[0]));
  expect(labels(dropdown())).toEqual(['anchor', 'new']);
  expect(labels(popup())).toEqual(['anchor', 'new']);
  await act(async () => { bus.held.release('B:get', 0, initial); await bHydration.ready; });
  expect(labels(dropdown())).toEqual(['anchor', 'new']);
  expect(labels(popup())).toEqual(['anchor', 'new']);
  await dismissCanvasMenu(); openConnector();
  expect(labels(popup())).toEqual(['anchor', 'new']);
  act(() => bus.B.emit('ssh-store:changed', initial));
  expect(labels(dropdown())).toEqual(['anchor', 'new']);
  expect(labels(popup())).toEqual(['anchor', 'new']);
  await dismissCanvasMenu(); openBackground();
  expect(labels(popup())).toEqual(['anchor', 'new']);
  await dismissCanvasMenu();
  pick('new', dropdown());
  const { id } = await mountShell('new');
  expect(ops('ssh_session_open')).toEqual([{ window: 'B', command: 'ssh_session_open', args: { terminalId: id, connectionId: 'new' } }]);
  expect(ops('ssh_terminal_launch').map(call => [call.window, call.args?.terminalId, call.args?.connectionId])).toEqual([['B', id, 'new']]);
  expect(bus.admitted).toEqual([id]);
  expect(ops('ssh_store_get').map(call => call.window)).toEqual(['A', 'B']);
  expect(ops('ssh_store_reload')).toEqual([]);
});

test('sshMenu_bookmarkParity_twoContexts', async () => {
  await setup([saved('alpha', { bookmarked: true, order: 8 }), saved('not-starred', { order: 0 }),
    saved('zulu', { bookmarked: true, order: 2 }), saved('middle', { bookmarked: true, order: 4 })], { source: true });
  openTabMenu(); openBackground();
  // The fixture uses id as the visible name. Expected order is neither input nor alphabetical order.
  expect(labels(dropdown())).toEqual(['zulu', 'middle', 'alpha']);
  expect(labels(popup())).toEqual(['zulu', 'middle', 'alpha']);
  expect(labels(dropdown()).length).toBeGreaterThan(0);
  expect(labels(popup()).length).toBeGreaterThan(0);
  await dismissCanvasMenu(); openConnector();
  expect(labels(popup())).toEqual(['zulu', 'middle', 'alpha']);
  expect(labels(popup()).length).toBeGreaterThan(0);
});

test('sshMenu_deletedSelection_neverLaunches', async () => {
  const { initial } = await setup([saved('survivor', { bookmarked: true }), saved('removed', { bookmarked: true, order: 1 })]);
  openTabMenu(); pick('survivor', dropdown());
  const tab = await mountShell('survivor');
  openBackground(); pick('survivor', popup());
  const canvas = await mountShell('survivor');
  expect(ops('ssh_session_open').map(call => call.args)).toEqual([tab, canvas].map(({ id }) => ({ terminalId: id, connectionId: 'survivor' })));
  expect(bus.admitted).toEqual([tab.id, canvas.id]);
  expect(bus.writes.map(write => write.terminalId)).toEqual([tab.id, canvas.id]);
  act(() => { store.dispatch(setOverlayNode(null)); });
  openTabMenu(); openBackground();
  const staleTab = button('removed', dropdown());
  const staleCanvas = button('removed', popup());
  const before = controls();
  const opens = ops('ssh_session_open'); const launches = ops('ssh_terminal_launch');
  const writes = [...bus.writes];
  const deletion = await bus.A.api.ssh.deleteConnection({ id: 'removed' });
  expect(deletion.revision).toBe(initial.revision + 1);
  await act(async () => {
    bus.B.emit('ssh-store:changed', deletion);
    // Same event turn: stale DOM, but the authoritative Redux row is already gone.
    expect(staleTab.isConnected && staleCanvas.isConnected).toBe(true);
    staleTab.click(); staleCanvas.click();
  });
  expect(labels(dropdown())).toEqual(['survivor']);
  expect(labels(popup())).toEqual(['survivor']);
  expect(ops('ssh_session_open')).toEqual(opens);
  expect(ops('ssh_terminal_launch')).toEqual(launches);
  expect(bus.writes).toEqual(writes);
  expect(controls()).toEqual(before);
});

test('sshCanvas_connectorLaunch_wiresMintedTerminalOrNothingOnCancel', async () => {
  jest.useFakeTimers();
  await setup([saved('destination', { bookmarked: true })], { source: true });
  localTerminals.add(SOURCE);
  await act(async () => {
    expect(await terminalService.createTerminal(SOURCE, profile.id, 'Source', undefined, undefined, undefined,
      'source-tab', undefined, false, 'Mount', 'source-pane')).toMatch(/^pc-/);
  });
  const canvasId = store.getState().tabs.activeTabId;
  const startPicker = () => { openConnector(); pick('All SSH Connections…', popup()); };
  startPicker(); pick('Connect', query(document, '.ssh-picker'));
  const first = await mountShell('destination');
  await act(async () => { jest.advanceTimersByTime(100); });
  const firstEdge = { id: 'server-1', from: SOURCE, to: first.id, origin: 'user', label: null, createdAt: 1 };
  expect(first.id).not.toBe(SOURCE);
  expect(first.id).not.toBe(first.tabId);
  expect(store.getState().canvas.nodes[first.id]).toEqual(spawnRectNear(sourceRect, [sourceRect], 0));
  expect(store.getState().tabs.activeTabId).toBe(canvasId);
  expect(store.getState().canvas.edges).toEqual([firstEdge]);
  expect(bus.serverEdges).toEqual([firstEdge]);
  expect(ops('POST /canvas/edges').map(call => call.args?.body)).toEqual([{ from: SOURCE, to: first.id, label: null }]);

  act(() => { store.dispatch(setOverlayNode(null)); });
  const beforeCancel = controls();
  startPicker(); pick('Cancel', query(document, '.ssh-picker'));
  expect(document.querySelector('.ssh-picker')).toBeNull();
  expect(controls()).toEqual(beforeCancel);
  expect(bus.serverEdges).toEqual([firstEdge]);

  bus.holdEdgeReplies();
  startPicker(); pick('Connect', query(document, '.ssh-picker'));
  const second = await mountShell('destination');
  await act(async () => { jest.advanceTimersByTime(100); });
  expect(second.id).not.toBe(first.id);
  const secondEdge = { ...firstEdge, id: 'server-2', to: second.id, createdAt: 2 };
  expect(bus.held.calls('edge-reply')).toEqual([[secondEdge]]);
  expect(bus.serverEdges).toEqual([firstEdge, secondEdge]);
  const replaced = store.getState().panes.treesByTabId[second.tabId]!;
  const oldOwner = paneIncarnations.capture(second.id, second.paneId);
  await act(async () => {
    await terminalService.closeTerminal(second.id, oldOwner);
    store.dispatch(addTabTree({ tabId: second.tabId, tree: { ...replaced, id: 'replacement-pane' } }));
    store.dispatch(setOverlayNode(null));
  });
  const newOwner = paneIncarnations.capture(second.id, 'replacement-pane');
  expect(newOwner).toBeDefined();
  expect(newOwner).not.toBe(oldOwner); // same durable leaf, different admitted copy
  await act(async () => bus.held.release('edge-reply'));
  expect(store.getState().canvas.edges).toEqual([firstEdge]);
  expect(bus.serverEdges).toEqual([firstEdge]);
  const posted = [firstEdge, secondEdge].map(({ from, to, label }) => ({ from, to, label }));
  expect(ops('POST /canvas/edges').map(call => call.args?.body)).toEqual(posted);

  // Lose the source AFTER the picker succeeded, while the native create reply
  // is outstanding. The new terminal survives as a standalone tab and node.
  bus.holdCreateReplies();
  const survivingTabs = controls().tabs.filter(id => id !== 'source-tab');
  const priorUiEdges = [...controls().edges];
  const priorServerEdges = [...bus.serverEdges];
  startPicker(); pick('Connect', query(document, '.ssh-picker'));
  const third = selectCanvasModel(store.getState()).nodes.find(n => ![SOURCE, first.id, second.id].includes(n.terminalId))!;
  expect(third.terminalId).toMatch(/^tm-/);
  localTerminals.add(third.terminalId);
  let creating!: Promise<string>;
  await act(async () => {
    creating = terminalService.createTerminal(third.terminalId, profile.id, third.title, undefined, undefined, undefined,
      third.tabId, undefined, false, 'Mount', third.paneId, 'destination');
  });
  expect(bus.held.calls('create-reply')).toEqual([[third.terminalId, expect.stringMatching(/^pc-/)]]);
  await act(async () => {
    // Remove the source from this window without asking the server to delete
    // its already-committed edge; this isolates the pending connector result.
    store.dispatch(removeTabTree('source-tab')); store.dispatch(removeTab('source-tab'));
    jest.advanceTimersByTime(100);
  });
  const [, processId] = bus.held.calls('create-reply')[0];
  await act(async () => { bus.held.release('create-reply'); expect(await creating).toBe(processId); });
  await act(async () => { jest.advanceTimersByTime(100); });
  expect(terminalService.getProcessIdForTerminal(third.terminalId)).toBe(processId);
  expect(controls().tabs).toEqual([...survivingTabs, third.tabId]);
  expect([...controls().nodes].sort()).toEqual([first.id, second.id, third.terminalId].sort());
  expect(controls().edges).toEqual(priorUiEdges);
  expect(bus.serverEdges).toEqual(priorServerEdges);
  expect(ops('POST /canvas/edges').map(call => call.args?.body)).toEqual(posted);
});

test.each(['canvas', 'tab'] as const)('sshLaunch_trustGate_ordersEveryHop (%s)', async (surface) => {
  await setup([saved('target', { bookmarked: true })]);
  const targetPrompt: Partial<SshSessionView> = { state: 'needs-hostkey', gate: 'blocked', promptId: 'target-key',
    promptTarget: { connectionId: 'target', host: 'target.example', port: 2202, user: 'tester', hop: 'target' },
    hostKey: { algorithm: 'ssh-ed25519', fingerprintSha256: 'SHA256:target', changed: false },
    knownHostsPaths: { jump: '/private/jump', target: '/private/target' } };
  const spawn = async (view: Partial<SshSessionView>) => {
    bus.opening(view);
    act(() => { store.dispatch(setOverlayNode(null)); });
    if (surface === 'canvas') { openBackground(); pick('target', popup()); }
    else { openTabMenu(); pick('target', dropdown()); }
    const shell = await mountShell('target');
    const owner = paneIncarnations.capture(shell.id, shell.paneId)!;
    const pi = await owner;
    const session = bus.sessions.get(shell.id)!;
    const attempt: LaunchAttemptRef = {
      sessionGeneration: session.generation!, processIncarnation: shell.pc, ownerIncarnation: pi,
      attemptReceipt: { gate: session.gate, generation: session.generation!, ...(session.knownHostsPaths ? { knownHostsPaths: session.knownHostsPaths } : {}) },
    };
    expect(ops('ssh_terminal_launch').filter(call => call.args?.terminalId === shell.id)).toEqual([
      { window: 'B', command: 'ssh_terminal_launch', args: { terminalId: shell.id, connectionId: 'target', attempt } },
    ]);
    expect(bus.order.filter(step => step.endsWith(`:${shell.id}`)).slice(0, 3)).toEqual([
      `tagged:${shell.id}`, `ssh_session_open:${shell.id}`, `gate:${session.gate}:${shell.id}`,
    ]);
    await act(async () => renderB(<OwnedSshLaunchNotice key={shell.id} terminalId={shell.id} paneId={shell.paneId}
      owner={owner} processId={shell.pc} connectionId="target" />));
    return { ...shell, attempt };
  };
  const notice = () => query(document, '.ssh-launch-notice');
  const network = await spawn({ state: 'error', gate: 'network-error' });
  expect(bus.admitted).toEqual([network.id]);
  expect(bus.writes).toEqual([{ terminalId: network.id, processId: network.pc, data: 'native-ssh:target' }]);

  const pending = await spawn({ state: 'needs-secret', gate: 'pending', secretKind: 'passphrase',
    promptId: 'jump-secret', promptTarget: { connectionId: 'jump', host: 'jump.example', port: 2201, user: 'relay', hop: 'jump' } });
  const stillWaiting = () => {
    expect(bus.admitted).toEqual([network.id]);
    expect(bus.writes.map(write => write.terminalId)).toEqual([network.id]);
    expect(ops('ssh_terminal_launch').filter(call => call.args?.terminalId === pending.id)).toHaveLength(1);
  };
  expect(store.getState().sshSession.byTerminal[pending.id].session).toMatchObject({ state: 'needs-secret', gate: 'pending', promptId: 'jump-secret' });
  stillWaiting();
  await act(async () => bus.transition(pending.id, { state: 'connected', gate: 'pending', promptId: undefined }));
  stillWaiting(); // public state cannot substitute for a receipt
  await act(async () => bus.transition(pending.id, targetPrompt));
  expect(notice().textContent).toContain('Unknown SSH host key');
  stillWaiting();
  await act(async () => button('Trust', notice()).click());
  expect(ops('ssh_session_trust_host').map(call => call.args)).toEqual([{ terminalId: pending.id, accept: true,
    generation: pending.attempt.sessionGeneration, promptId: 'target-key' }]);
  expect(bus.admitted).toEqual([network.id, pending.id]);
  const writes = [...bus.writes];
  expect(writes.map(write => write.terminalId)).toEqual([network.id, pending.id]);
  expect(bus.order.filter(step => step.endsWith(`:${pending.id}`)).slice(-2)).toEqual([
    `gate:verified:${pending.id}`, `ssh_terminal_launch:${pending.id}`,
  ]);

  const cancelled = await spawn(targetPrompt);
  await act(async () => button('Cancel', notice()).click());
  expect(ops('ssh_terminal_cancel_launch').map(call => call.args)).toEqual([{ terminalId: cancelled.id, attempt: cancelled.attempt }]);
  await act(async () => bus.transition(cancelled.id, { state: 'connected', gate: 'verified' }));
  await spawn({ ...targetPrompt, state: 'error', gate: 'blocked', hostKey: { ...targetPrompt.hostKey!, changed: true } });
  expect(notice().textContent).toContain('SSH launch blocked');
  expect([...notice().querySelectorAll('button')].map(control => control.textContent)).toEqual(['Retry']);
  expect(bus.admitted).toEqual([network.id, pending.id]);
  expect(bus.writes).toEqual(writes);
});
