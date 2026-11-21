/** @jest-environment jsdom */
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';

jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../components/Settings/SettingsPage', () => ({ SettingsPage: () => null }));
jest.mock('../../components/Canvas/CanvasMode', () => ({ CanvasMode: () => null }));
jest.mock('../../components/Panes/dnd/usePaneDrag', () => ({ usePaneDrag: () => () => {} }));
jest.mock('../../components/Terminal/AgentChip', () => ({ AgentChip: () => null }));
jest.mock('../../components/Terminal/TerminalDisplay', () => ({
  TerminalDisplay: ({ processId }: { processId: string }) => <div data-process-id={processId} />,
  cleanupTerminalCache: jest.fn(),
}));

import { TerminalContainer } from '../../components/TerminalContainer';
import { store } from '../../store';
import { setDefaultProfile, setShellProfiles } from '../../store/slices/settingsSlice';
import { applyView } from '../../store/slices/sshSlice';
import { markSessionClosed } from '../../store/slices/sessionExitSlice';
import { addTab, removeTab } from '../../store/slices/tabsSlice';
import { removeTabTree } from '../../store/slices/panesSlice';
import { CANVAS_SHELL_TYPE } from '../tabKinds';
import { installPaneIncarnations, PaneIncarnations, type PaneBridge, type PaneResult } from '../paneIncarnations';
import { terminalService, TerminalServiceClass } from '../TerminalService';
import { launchSshConnection } from '../sshLaunch';
import { observeOwnedSshLaunch } from '../sshLaunchAttempt';
import { getTabPanesGlobal, clearTabPanesInPlace } from '../tabPanesStore';
import type { LaunchAttemptRef, LaunchSnapshot, SshSessionView } from '../../types/ssh';

const tag = { connectionId: 'saved', browserCollapsed: false, followCd: false, hiddenMetrics: [] };
const defaultShell = { id: 'default-shell', name: 'Local Shell', path: '/native/default', args: [], env: { SOURCE: 'default' }, cwd: '/default-cwd' };
const profiles = [{ ...defaultShell, id: 'first', cwd: '/first' }, defaultShell, { ...defaultShell, id: 'saved', cwd: '/connection' }];
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const rect = { x: 10, y: 20, w: 340, h: 210 };
const canvas = { kind: 'canvas' as const, rect, sourceTerminalId: 'tm-source' };
const makeSnapshot = (terminalId: string, connectionId: string, attempt: LaunchAttemptRef): LaunchSnapshot =>
  ({ terminalId, connectionId, attempt, stage: 'preparing', revision: 1, launchSeq: 1 });

function harness(admission: PaneResult = { status: 'Create', cg: 7 }, attach = false) {
  let generation = 0;
  const sessions = new Map<string, SshSessionView>();
  const snapshots = new Map<string, LaunchSnapshot>();
  const open = (terminalId: string, connectionId: string): SshSessionView => {
    const view: SshSessionView = { terminalId, connectionId, generation: ++generation, state: 'needs-hostkey',
      revision: 1, gate: 'pending', promptId: 'prompt-target' };
    sessions.set(terminalId, view);
    return view;
  };
  const takeReattachPromptHook = jest.fn().mockResolvedValue(null);
  if (attach) takeReattachPromptHook.mockResolvedValueOnce({ promptHook: false, atPrompt: false });
  const api = {
    setDefaultProfile: jest.fn(), createTerminal: jest.fn().mockResolvedValue('pc-legacy'), takeReattachPromptHook,
    onTerminalData: jest.fn(), onTerminalExit: jest.fn(), updateTerminalName: jest.fn().mockResolvedValue(true),
    sshSessionOpen: jest.fn(async (id: string, connection: string) => open(id, connection)),
    sshSessionReconnect: jest.fn(async (id: string) => open(id, sessions.get(id)!.connectionId)),
    sshSessionState: jest.fn(async (id: string) => {
      if (!sessions.has(id)) throw { code: 'not-found' };
      return sessions.get(id)!;
    }),
    ssh: {
      markUsed: jest.fn().mockRejectedValue({ code: 'StoreUnavailable' }),
      launchTerminal: jest.fn(async (id: string, connection: string, attempt: LaunchAttemptRef) => {
        const snapshot = makeSnapshot(id, connection, attempt);
        snapshots.set(id, snapshot);
        return snapshot;
      }),
      terminalLaunchState: jest.fn(async (id: string, attempt: LaunchAttemptRef) => {
        if (!snapshots.has(id)) throw { code: 'NotFound' };
        return { ...snapshots.get(id)!, attempt };
      }),
      cancelTerminalLaunch: jest.fn(),
    },
  };
  (window as any).electronAPI = api;
  let pc = 0;
  const create = jest.fn(async (_request: object) => `pc-${++pc}`);
  const bridge = (async (cmd: string, args: any) => {
    if (cmd === 'register_page') return { status: 'Registered', pg: 41, wi: 5 };
    if (cmd === 'create_admitted_terminal') return create(args.request);
    return { status: 'Ack', result: args.request.op.kind === 'admit_create' ? admission : { status: 'Ok' } };
  }) as PaneBridge;
  const client = new PaneIncarnations(bridge);
  installPaneIncarnations(client);
  client.attachStore(store);
  store.dispatch(setShellProfiles(profiles));
  store.dispatch(setDefaultProfile(defaultShell.id));
  store.dispatch(applyView({ revision: store.getState().ssh.revision + 1, view: {
    revision: store.getState().ssh.revision + 1, folders: [], loadError: null, connections: [{
      id: 'saved', name: 'Saved destination', host: 'host', user: 'user', port: 22, auth: 'agent',
      identityFile: null, folderId: null, jumpConnectionId: null, extraOptions: [], bookmarked: false,
      order: 0, lastUsedAt: null, hasSavedSecret: false,
    }],
  } }));
  return { api, client, create };
}

const launch = (placement?: typeof canvas) => {
  const result = launchSshConnection('saved', placement);
  if (!result.ok) throw new Error(result.error.message);
  return result;
};
let root: ReturnType<typeof createRoot> | undefined;
let element: HTMLDivElement;
function render() {
  element = document.createElement('div');
  document.body.appendChild(element);
  root = createRoot(element);
  root.render(<StrictMode><Provider store={store}><TerminalContainer /></Provider></StrictMode>);
}
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  element?.remove();
  installPaneIncarnations(new PaneIncarnations());
  for (const tab of store.getState().tabs.tabs) store.dispatch(removeTab(tab.id));
  for (const [id, tree] of Object.entries(store.getState().panes.treesByTabId)) {
    if (tree?.terminalId) terminalService.detachTerminal(tree.terminalId);
    store.dispatch(removeTabTree(id));
  }
  clearTabPanesInPlace();
  delete (window as any).electronAPI;
});

test('tagged_tree_exists_before_first_terminal_mount', async () => {
  const h = harness();
  store.dispatch(addTab({ id: 'tb-canvas', title: 'Canvas', shellType: CANVAS_SHELL_TYPE, icon: '' }));
  // Observe the very first synchronous tab publication, when a renderer may mount it.
  const atPublication = jest.fn();
  const stop = store.subscribe(() => {
    const state = store.getState();
    const tab = state.tabs.tabs.find(t => t.shellType === defaultShell.id);
    if (!tab || atPublication.mock.calls.length) return;
    const tree = state.panes.treesByTabId[tab.id];
    atPublication(tree?.ssh, getTabPanesGlobal()[tab.id]?.ssh, tree?.terminalId && state.canvas.nodes[tree.terminalId]);
  });
  try {
    await act(async () => { render(); });
    await act(async () => {
      const result = launch(canvas);
      expect(result.placement).toEqual(canvas);
      expect(store.getState().tabs.activeTabId).toBe('tb-canvas');
      await flush();
    });
    expect(atPublication.mock.calls).toEqual([[tag, tag, rect]]);
    expect(element.querySelector('[data-process-id="pc-1"]')).not.toBeNull();
    expect(h.api.ssh.markUsed.mock.calls).toEqual([['saved']]);
  } finally { stop(); }
});

test('ssh_uses_configured_default_not_connection_or_first_profile', async () => {
  const h = harness();
  let tabId = '';
  await act(async () => { render(); tabId = launch().tabId; await flush(); });
  expect(h.create.mock.calls).toEqual([[expect.objectContaining({ profile: 'default-shell', cwd: '/default-cwd', name: 'Local Shell', owningTabId: tabId })]]);
  expect(store.getState().tabs.tabs.find(tab => tab.id === tabId)?.title).toBe('Local Shell');
});

test('missing_default_profiles_creates_nothing', () => {
  const h = harness();
  for (const shells of [profiles, []]) {
    store.dispatch(setShellProfiles(shells));
    store.dispatch(setDefaultProfile('missing'));
    const before = store.getState();
    const mirror = { ...getTabPanesGlobal() };
    expect(launchSshConnection('saved', canvas)).toMatchObject({ ok: false, error: { code: 'MissingDefaultProfile' } });
    expect(store.getState()).toBe(before);
    expect(getTabPanesGlobal()).toEqual(mirror);
  }
  expect(h.create).not.toHaveBeenCalled();
  expect(h.api.ssh.markUsed).not.toHaveBeenCalled();
});

test('legacy_and_admitted_create_both_carry_same_launch_metadata', async () => {
  const h = harness();
  await act(async () => { render(); launch(); await flush(); });
  const legacyClient = new PaneIncarnations();
  const legacy = new TerminalServiceClass(() => store.getState().panes.treesByTabId, () => window.electronAPI, () => legacyClient);
  const tab = store.getState().tabs.tabs[0];
  const tree = store.getState().panes.treesByTabId[tab.id]!;
  await legacy.createTerminal(tree.terminalId!, defaultShell.id, tab.title, defaultShell.cwd, undefined, undefined, tab.id,
    undefined, false, 'Mount', tree.id, tree.ssh?.connectionId);
  expect(h.create.mock.calls[0][0]).toMatchObject({ leaf: tree.terminalId, sshLaunchConnectionId: 'saved' });
  expect(h.api.createTerminal.mock.calls[0]).toEqual([defaultShell.id, tab.title, defaultShell.cwd, tree.terminalId,
    undefined, undefined, tab.id, undefined, false, 'saved']);
  expect(h.api.sshSessionOpen).toHaveBeenCalledTimes(1); // legacy has no acknowledged owner
});

test('join_existing_host_attach_and_strictmode_write_once', async () => {
  const h = harness();
  const paneCreate = jest.spyOn(terminalService, 'createTerminal');
  try {
    await act(async () => { render(); launch(); await flush(); });
    expect(paneCreate).toHaveBeenCalledTimes(1);
  } finally { paneCreate.mockRestore(); }
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.api.sshSessionOpen).toHaveBeenCalledTimes(1);
  const [leaf, connection, attempt] = h.api.ssh.launchTerminal.mock.calls[0];
  expect(h.api.ssh.launchTerminal.mock.calls).toEqual([[leaf, 'saved', {
    sessionGeneration: 1, attemptReceipt: { generation: 1, gate: 'pending' },
    processIncarnation: 'pc-1', ownerIncarnation: { pg: 41, seq: 1 },
  }]]);
  expect(connection).toBe('saved');
  expect(h.api.ssh.terminalLaunchState.mock.calls).toEqual([[leaf, attempt]]);
});

test.each<[PaneResult, boolean, boolean]>([
  [{ status: 'Existing', pc: 'pc-existing' }, false, false],
  [{ status: 'Join', cg: 7 }, false, true],
  [{ status: 'Create', cg: 7 }, true, true],
])('reuse does not open or launch (%j, hostAttach=%s)', async (admission, attach, invokesCreate) => {
  const h = harness(admission, attach);
  await act(async () => { render(); launch(); await flush(); });
  expect(h.create).toHaveBeenCalledTimes(invokesCreate ? 1 : 0);
  if (admission.status === 'Join') expect(h.create.mock.calls[0][0]).not.toHaveProperty('sshLaunchConnectionId');
  expect(h.api.sshSessionState).toHaveBeenCalledTimes(1);
  expect(h.api.sshSessionOpen).not.toHaveBeenCalled();
  expect(h.api.ssh.launchTerminal).not.toHaveBeenCalled();
});

test('fresh_restart_carries_tag_but_no_stale_ticket', async () => {
  const h = harness();
  let leaf = '';
  await act(async () => { render(); leaf = launch().terminalId; await flush(); });
  await act(async () => { store.dispatch(markSessionClosed({ terminalId: leaf, exitCode: 0 })); });
  const restart = element.querySelector<HTMLButtonElement>('.session-closed-banner__button--primary');
  expect(restart?.textContent).toBe('Restart');
  await act(async () => { restart!.click(); await flush(); });
  expect(h.create.mock.calls.map(([request]) => request)).toEqual([1, 2].map(() => expect.objectContaining({ sshLaunchConnectionId: 'saved' })));
  expect(h.api.sshSessionOpen.mock.calls).toEqual([[leaf, 'saved']]);
  expect(h.api.sshSessionReconnect.mock.calls).toEqual([[leaf]]);
  expect(h.api.ssh.launchTerminal.mock.calls.map(([, , attempt]) => attempt)).toEqual([1, 2].map(n => ({
    sessionGeneration: n, attemptReceipt: { generation: n, gate: 'pending' },
    processIncarnation: `pc-${n}`, ownerIncarnation: { pg: 41, seq: 1 },
  })));
});

test('delayed_old_launch_cannot_join_successor_attempt', async () => {
  const { api } = harness();
  const leaf = 'tm-race';
  let resolveOld!: (snapshot: LaunchSnapshot) => void;
  api.ssh.launchTerminal.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  let pc = 'pc-old';
  const old = observeOwnedSshLaunch(api, { terminalId: leaf, connectionId: 'saved', processIncarnation: pc,
    owner: Promise.resolve({ pg: 41, seq: 1 }), current: () => pc === 'pc-old' }, 'open');
  await flush();
  const oldAttempt = api.ssh.launchTerminal.mock.calls[0][2];
  pc = 'pc-new';
  const next = await observeOwnedSshLaunch(api, { terminalId: leaf, connectionId: 'saved', processIncarnation: pc,
    owner: Promise.resolve({ pg: 42, seq: 1 }), current: () => pc === 'pc-new' }, 'restart');
  resolveOld(makeSnapshot(leaf, 'saved', oldAttempt));
  expect(await old).toBeUndefined();
  expect(next?.snapshot?.attempt).toEqual({ sessionGeneration: 2, attemptReceipt: { generation: 2, gate: 'pending' },
    processIncarnation: 'pc-new', ownerIncarnation: { pg: 42, seq: 1 } });
  expect(next?.session.promptId).toBe('prompt-target');
});

test('remount_queries_same_process_with_current_owner_and_session_receipt', async () => {
  const { api } = harness();
  const target = { terminalId: 'tm-adopted', connectionId: 'saved', processIncarnation: 'pc-same', current: () => true };
  const source = await observeOwnedSshLaunch(api, { ...target, owner: Promise.resolve({ pg: 41, seq: 5 }) }, 'open');
  const acquired = await observeOwnedSshLaunch(api, { ...target, owner: Promise.resolve({ pg: 42, seq: 1 }) }, 'query');
  expect(api.sshSessionOpen.mock.calls).toEqual([['tm-adopted', 'saved']]);
  expect(api.sshSessionReconnect).not.toHaveBeenCalled();
  expect(api.ssh.launchTerminal).toHaveBeenCalledTimes(1);
  const attempt = { ...source!.snapshot!.attempt, ownerIncarnation: { pg: 42, seq: 1 } };
  expect(api.ssh.terminalLaunchState.mock.calls).toEqual([['tm-adopted', attempt]]);
  expect(acquired?.snapshot).toEqual({ ...source!.snapshot, attempt });
});

test('displacement_during_open_receipt_never_invokes_launch', async () => {
  const { api } = harness();
  let resolveOpen!: (view: SshSessionView) => void;
  api.sshSessionOpen.mockImplementationOnce(() => new Promise(resolve => { resolveOpen = resolve; }));
  let mounted = true;
  const pending = observeOwnedSshLaunch(api, { terminalId: 'tm-open', connectionId: 'saved', processIncarnation: 'pc-old',
    owner: Promise.resolve({ pg: 41, seq: 1 }), current: () => mounted }, 'open');
  await flush();
  mounted = false;
  resolveOpen({ terminalId: 'tm-open', connectionId: 'saved', generation: 1, state: 'connecting', gate: 'pending' });
  expect(await pending).toBeUndefined();
  expect(api.ssh.launchTerminal).not.toHaveBeenCalled();
});
