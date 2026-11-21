/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';

jest.mock('../../../api/tauri-bridge', () => ({ __esModule: true, default: {} }));
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../../services/TerminalService', () => ({
  terminalService: { getProcessIdForTerminal: jest.fn(() => 'pc-ready'), beginUserElevatedAttempt: jest.fn() },
}));
jest.mock('../../../services/RunningActivityTracker', () => ({ runningActivityTracker: { notifyViewChangeBurst: jest.fn() } }));
jest.mock('../../../services/canvasGraph', () => ({
  createEdge: jest.fn(async (from: string, to: string) => ({
    id: 'edge-server', from, to, label: null, origin: 'user', createdAt: 1,
  })),
  fetchGraph: jest.fn(async () => null),
  putNodes: jest.fn(async () => {}),
}));
jest.mock('../../Terminal/useDetectedAgent', () => ({ useDetectedAgent: () => ({ agent: null, icon: null }) }));
jest.mock('../../Automation/AutomationMenuSection', () => ({ AutomationMenuSection: () => null }));
jest.mock('../NodeTerminal', () => ({ NodeTerminal: () => null }));
jest.mock('../NodeSnapshot', () => ({ NodeSnapshot: () => null }));
jest.mock('../useCanvasRenderPolicy', () => ({ useCanvasRenderPolicy: () => {} }));
jest.mock('../useWireDrag', () => ({
  useWireDrag: (_rects: unknown, cb: typeof mockPortClick) => {
    mockPortClick = cb;
    return { linking: false, preview: null, onPointerDownCapture: () => {} };
  },
}));

import { store } from '../../../store';
import { button, key, otherProfile, preparePicker, profile, replaceSaved, saved } from '../../../__testFixtures__/sshPickerFixture';
import { CanvasMode } from '../CanvasMode';
import { CanvasProfileMenu } from '../CanvasProfileMenu';
import { NewTabDropdown } from '../../NewTabDropdown';
import { SshConnectionsDialogHost } from '../../Ssh/AllSshConnectionsDialog';
import { openCanvasTab } from '../../../services/openCanvas';
import * as canvasEntry from '../../../services/openCanvas';
import * as settingsEntry from '../../../services/openSettings';
import * as admin from '../../../services/adminTabActions';
import * as sshLaunch from '../../../services/sshLaunch';
import { setEdges, setNodeGeom, setViewport } from '../../../store/slices/canvasSlice';
import { addTab, clearAllTabs, removeTab, setActiveTab } from '../../../store/slices/tabsSlice';
import { addTabTree, removeTabTree } from '../../../store/slices/panesSlice';
import { createEdge } from '../../../services/canvasGraph';
import { terminalService } from '../../../services/TerminalService';
import { NODE_H, NODE_W } from '../canvasGeometry';
import { spawnRectNear } from '../canvasSpawn';
import { inputHandler } from '../../../services/InputHandler';

let mockPortClick: (click: { fromId: string; x: number; y: number; side: 'e' }) => void;
let root: Root;
let container: HTMLDivElement;
let api: ReturnType<typeof preparePicker>;
let launch: jest.SpyInstance;
const sourceRect = { x: 45, y: 80, w: NODE_W, h: NODE_H };
const tab = () => store.getState().tabs.tabs.at(-1)!;
const source = 'tm-source';
const invoker = () => container.querySelector<HTMLButtonElement>('[aria-label="New tab options"]')!;
const canvasMenu = () => document.querySelector('.canvas-profile-menu')!;
const dropdown = () => container.querySelector('.dropdown-menu')!;
const pick = (label: string, parent: ParentNode = document) => act(() => button(label, parent).click());
const render = (ui: React.ReactNode) => act(() =>
  root.render(<Provider store={store}><SshConnectionsDialogHost>{ui}</SshConnectionsDialogHost></Provider>));
const entry = (label: string, scope = dropdown()) => {
  const item = Array.from(scope.querySelectorAll<HTMLElement>('.dropdown-item')).find(el => el.textContent?.includes(label));
  if (!item) throw new Error(`Missing menu item: ${label}`);
  act(() => item.click());
};
const enterPicker = () => {
  pick('All SSH Connections…', canvasMenu());
  expect(canvasMenu()).toBeNull();
  const input = document.querySelector<HTMLInputElement>('[role=combobox]')!;
  expect(document.activeElement).toBe(input);
  return act(async () => { key(input, 'Enter'); });
};

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterAll(() => inputHandler.destroy());

beforeEach(() => {
  jest.clearAllMocks();
  api = preparePicker();
  launch = jest.spyOn(sshLaunch, 'launchSshConnection');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  admin.__setAdminTabSupportForTests({ supported: false, reason: 'not-windows' });
  store.dispatch(setEdges([]));
  store.dispatch(setViewport({ x: 0, y: 0, z: 1 }));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const id of Object.keys(store.getState().panes.treesByTabId)) store.dispatch(removeTabTree(id));
  store.dispatch(clearAllTabs());
  jest.restoreAllMocks();
});

function background(x: number, y: number) {
  act(() => { container.querySelector('.canvas-viewport')!.dispatchEvent(new MouseEvent('contextmenu', {
    clientX: x, clientY: y, bubbles: true, cancelable: true, button: 2,
  })); });
  expect(canvasMenu()).not.toBeNull();
}

function mountCanvas(withSource = false) {
  if (withSource) {
    store.dispatch(addTabTree({ tabId: 'source-tab', tree: { id: 'source-pane', type: 'terminal', terminalId: source } }));
    store.dispatch(setNodeGeom({ id: source, rect: sourceRect }));
    store.dispatch(addTab({ id: 'source-tab', title: 'Source', shellType: profile.id, icon: '' }));
  }
  openCanvasTab();
  const canvas = store.getState().tabs.activeTabId;
  render(<CanvasMode />);
  return canvas;
}

test('bookmark_event_updates_both_open_menus', () => {
  // SshConnectionsMenuSection: replace the live useSelector rows with an on-open snapshot.
  const onPick = jest.fn();
  render(<><NewTabDropdown /><CanvasProfileMenu x={5} y={8} header="New terminal here"
    onPick={onPick} onClose={jest.fn()} captureSsh={() => ({ launch: jest.fn(), invoker: null })} /></>);
  act(() => invoker().click());
  act(() => { replaceSaved([saved('one', { bookmarked: true })]); });
  expect(button('one', dropdown()).textContent).toContain('tester@one.example · Top level');
  expect(button('one', canvasMenu()).textContent).toContain('tester@one.example · Top level');
  act(() => { replaceSaved([saved('two', { bookmarked: true })]); });
  for (const menu of [dropdown(), canvasMenu()]) {
    expect(menu.textContent).not.toContain('one.example');
    expect(button('two', menu)).toBeTruthy();
    expect(button('All SSH Connections…', menu)).toBeTruthy();
  }
  expect(launch).not.toHaveBeenCalled();
});

test('bookmark_deleted_while_menu_open_does_not_launch_stale_id', () => {
  // SshConnectionsMenuSection: remove the authoritative store .some(...) check in pick.
  replaceSaved([saved('old', { bookmarked: true })]);
  render(<NewTabDropdown />);
  act(() => invoker().click());
  const old = button('old', dropdown());
  act(() => { replaceSaved([]); old.click(); });
  expect(launch).not.toHaveBeenCalled();
  expect(api.ssh.markUsed).not.toHaveBeenCalled();
  expect(old.isConnected).toBe(false);
});

test('canvas_background_ssh_uses_captured_point_and_keeps_canvas_active', async () => {
  // CanvasMode: use the cleared spawnMenu in place of ssh.menu; sshLaunch: activate the inserted tab or write geometry second.
  replaceSaved([saved('server')]);
  const canvas = mountCanvas();
  const vp = store.getState().canvas.viewport;
  background(370, 240);
  const geometryOnInsertion: unknown[] = [];
  const unsubscribe = store.subscribe(() => {
    const state = store.getState();
    const newTab = state.tabs.tabs.find(t => t.title === 'server');
    if (newTab && !geometryOnInsertion.length) {
      const leaf = state.panes.treesByTabId[newTab.id]?.terminalId;
      geometryOnInsertion.push(leaf && state.canvas.nodes[leaf]);
    }
  });
  try { await enterPicker(); } finally { unsubscribe(); }
  const rect = { x: (370 - vp.x) / vp.z - NODE_W / 2, y: (240 - vp.y) / vp.z - NODE_H / 2, w: NODE_W, h: NODE_H };
  expect(launch.mock.calls).toEqual([['server', { kind: 'canvas', rect, sourceTerminalId: undefined }]]);
  expect(tab()).toMatchObject({ shellType: profile.id, title: 'server', isActive: false });
  expect(store.getState().tabs.activeTabId).toBe(canvas);
  expect(geometryOnInsertion).toEqual([expect.objectContaining(rect)]);
  expect(createEdge).not.toHaveBeenCalled();
});

test('canvas_connector_popup_selection_keeps_source_wire_and_leaf_id', async () => {
  // CanvasMode: remove sourceTerminalId in the placement or pass result.tabId instead of result.terminalId as leafId.
  replaceSaved([saved('server')]);
  const canvas = mountCanvas(true);
  act(() => mockPortClick({ fromId: source, x: 60, y: 80, side: 'e' }));
  await enterPicker();
  const target = store.getState().panes.treesByTabId[tab().id].terminalId!;
  expect(launch.mock.calls).toEqual([['server', {
    kind: 'canvas', rect: spawnRectNear(sourceRect, [sourceRect], 0), sourceTerminalId: source,
  }]]);
  expect(target).toMatch(/^tm-/);
  expect(target).not.toBe(tab().id);
  expect(jest.mocked(createEdge).mock.calls).toEqual([[source, target]]);
  expect(store.getState().canvas.edges).toEqual([
    { id: 'edge-server', from: source, to: target, label: null, origin: 'user', createdAt: 1 },
  ]);
  expect(store.getState().canvas.overlayId).toBe(target);
  expect(store.getState().tabs.activeTabId).toBe(canvas);
});

test('vanished_connector_source_cannot_create_unwired_ssh_tab', async () => {
  // CanvasMode: remove the live source-model lookup or allow a source-less connector to fall back to background placement.
  replaceSaved([saved('server')]);
  const canvas = mountCanvas(true);
  act(() => mockPortClick({ fromId: source, x: 60, y: 80, side: 'e' }));
  pick('All SSH Connections…', canvasMenu());
  act(() => { store.dispatch(removeTabTree('source-tab')); store.dispatch(removeTab('source-tab')); });
  const search = document.querySelector<HTMLInputElement>('[role=combobox]')!;
  await act(async () => { key(search, 'Enter'); });
  expect(document.querySelector('[role=alert]')?.textContent).toContain('source terminal');
  expect(store.getState().tabs.tabs.map(t => t.id)).toEqual([canvas]);
  expect(launch).not.toHaveBeenCalled();
  expect(createEdge).not.toHaveBeenCalled();
});

test('plus_and_ctrl_shift_t_remain_local_with_same_default_and_unique_title', () => {
  // NewTabDropdown / InputHandler: replace either shared default resolution with the first profile or route either through SSH.
  replaceSaved([saved('server', { bookmarked: true })]);
  store.dispatch(addTab({ id: 'existing', title: profile.name, shellType: profile.id, icon: '' }));
  render(<NewTabDropdown />);
  act(() => container.querySelector<HTMLButtonElement>('.new-tab-button')!.click());
  act(() => { key(window, 't', { ctrlKey: true, shiftKey: true }); });
  expect(store.getState().tabs.tabs.slice(-2).map(({ title, shellType, icon }) => ({ title, shellType, icon }))).toEqual([
    { title: 'Local Shell 1', shellType: profile.id, icon: '🖥️' },
    { title: 'Local Shell 2', shellType: profile.id, icon: '🖥️' },
  ]);
  expect(launch).not.toHaveBeenCalled();
});

test('profile_admin_canvas_settings_items_keep_existing_handlers', () => {
  // NewTabDropdown / CanvasProfileMenu: route any original onClick to the SSH capture/picker, or drop original handler arguments/order.
  admin.__setAdminTabSupportForTests({ supported: true, reason: 'ok' });
  const elevate = jest.spyOn(admin, 'openAdminTabWithProfile');
  const canvasOpen = jest.spyOn(canvasEntry, 'openCanvasTab');
  const settingsOpen = jest.spyOn(settingsEntry, 'openSettingsTab');
  const openDropdown = () => act(() => invoker().click());
  render(<NewTabDropdown />);
  openDropdown();
  expect(dropdown().querySelector('.profile-icon')?.textContent).toBe('🐚');
  entry(otherProfile.name);
  expect(tab()).toMatchObject({ title: otherProfile.name, shellType: otherProfile.id, icon: '🖥️', isActive: true });
  expect(launch).not.toHaveBeenCalled();

  openDropdown();
  entry(profile.name, Array.from(dropdown().querySelectorAll('.dropdown-section'))
    .find(el => el.textContent?.startsWith('Open Admin Tab'))!);
  expect(elevate.mock.calls).toEqual([[profile, undefined]]);
  expect(terminalService.beginUserElevatedAttempt).toHaveBeenCalledTimes(1);
  expect(tab()).toMatchObject({ title: profile.name, shellType: profile.id, elevated: true, isActive: true });
  expect(launch).not.toHaveBeenCalled();

  openDropdown();
  entry('Canvas');
  expect(canvasOpen.mock.calls).toEqual([[]]);
  const canvas = store.getState().tabs.activeTabId;
  expect(store.getState().tabs.tabs.find(t => t.id === canvas)?.title).toBe('Canvas');
  expect(launch).not.toHaveBeenCalled();

  openDropdown();
  entry('Settings');
  expect(settingsOpen.mock.calls).toEqual([[]]);
  const settings = tab().id;
  expect(tab()).toMatchObject({ title: 'Settings', isActive: true, icon: '⚙️' });
  act(() => { store.dispatch(setActiveTab(canvas!)); });
  openDropdown();
  entry('Settings');
  expect(settingsOpen.mock.calls).toEqual([[], []]);
  expect(store.getState().tabs.activeTabId).toBe(settings);
  expect(store.getState().tabs.tabs.filter(t => t.title === 'Settings')).toHaveLength(1);
  expect(launch).not.toHaveBeenCalled();

  const order: string[] = [];
  const onClose = jest.fn(() => { order.push('close'); });
  const onPick = jest.fn(() => { order.push('pick'); });
  const capture = jest.fn();
  render(<CanvasProfileMenu x={5} y={8} header="New terminal here" onPick={onPick} onClose={onClose} captureSsh={capture} />);
  pick(otherProfile.name, canvasMenu());
  expect(onClose.mock.calls).toEqual([[]]);
  expect(onPick.mock.calls).toEqual([[otherProfile]]);
  expect(order).toEqual(['close', 'pick']);
  expect(capture).not.toHaveBeenCalled();

  act(() => { store.dispatch(setActiveTab(canvas!)); });
  render(<CanvasMode />);
  const vp = store.getState().canvas.viewport;
  background(370, 240);
  pick(otherProfile.name, canvasMenu());
  expect(tab()).toMatchObject({ title: 'Other Shell 1', shellType: otherProfile.id, icon: '🖥️', isActive: false });
  const leaf = store.getState().panes.treesByTabId[tab().id].terminalId!;
  expect(store.getState().canvas.nodes[leaf]).toMatchObject({
    x: (370 - vp.x) / vp.z - NODE_W / 2, y: (240 - vp.y) / vp.z - NODE_H / 2, w: NODE_W, h: NODE_H,
  });
  expect(store.getState().tabs.activeTabId).toBe(canvas);
  expect(api.ssh.markUsed).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

test('ac8_existing_new_tab_shortcuts_and_profiles_unchanged', () => {
  // NewTabDropdown (`+` handler / profile row onClick) and InputHandler (Ctrl+Shift+T): resolve anything but
  // resolveDefaultProfile, change buildNewTabFields titles, or route any of them through the SSH launcher.
  replaceSaved([saved('server', { bookmarked: true }), saved('other-host')]);
  store.dispatch(addTab({ id: 'existing', title: profile.name, shellType: profile.id, icon: '' }));
  const opened = () => store.getState().tabs.tabs.slice(1).map(({ title, shellType, icon, isActive }) => ({ title, shellType, icon, isActive }));
  render(<NewTabDropdown />);
  act(() => container.querySelector<HTMLButtonElement>('.new-tab-button')!.click());
  act(() => { key(window, 't', { ctrlKey: true, shiftKey: true }); });
  // Every profile row, in menu order, with the SSH section rendered alongside it.
  const rows = () => Array.from(dropdown().querySelector('.dropdown-section')!.querySelectorAll<HTMLElement>('.dropdown-item'));
  act(() => invoker().click());
  expect(dropdown().textContent).toContain('All SSH Connections…');
  expect(rows().map(row => row.querySelector('.profile-name')?.textContent)).toEqual([otherProfile.name, profile.name]);
  for (const index of [0, 1]) {
    if (index) act(() => invoker().click());
    act(() => rows()[index].click());
  }
  // develop: default profile (not first), "+N" unique titles, the generic icon, the new tab active.
  expect(opened()).toEqual([
    { title: 'Local Shell 1', shellType: profile.id, icon: '🖥️', isActive: true },
    { title: 'Local Shell 2', shellType: profile.id, icon: '🖥️', isActive: true },
    { title: otherProfile.name, shellType: otherProfile.id, icon: '🖥️', isActive: true },
    { title: 'Local Shell 3', shellType: profile.id, icon: '🖥️', isActive: true },
  ].map((tab, i, all) => ({ ...tab, isActive: i === all.length - 1 })));
  // Zero SSH calls of any kind, and no tagged trees.
  expect(launch).not.toHaveBeenCalled();
  expect(api.ssh.launchTerminal).not.toHaveBeenCalled();
  expect(api.ssh.markUsed).not.toHaveBeenCalled();
  expect(api.sshSessionOpen).not.toHaveBeenCalled();
  expect(api.sshSessionState).not.toHaveBeenCalled();
  expect(Object.values(store.getState().panes.treesByTabId).filter(tree => JSON.stringify(tree ?? null).includes('"ssh"'))).toEqual([]);
});
