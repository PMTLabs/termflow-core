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
import { addTabTree, movePaneToTab, patchSshPaneTag, removeTabTree, splitPaneInTab, type PaneNode } from '../../store/slices/panesSlice';
import { CANVAS_SHELL_TYPE } from '../tabKinds';
import { installPaneIncarnations, PaneIncarnations, type PaneBridge, type PaneResult } from '../paneIncarnations';
import { terminalService, TerminalServiceClass } from '../TerminalService';
import { launchSshConnection, reconnectSshTerminal } from '../sshLaunch';
import { sshOwnersChanged } from '../../store/slices/sshSessionSlice';
import { observeOwnedSshLaunch } from '../sshLaunchAttempt';
import { getTabPanesGlobal, clearTabPanesInPlace } from '../tabPanesStore';
import type { LaunchAttemptRef, LaunchSnapshot, SshSessionView } from '../../types/ssh';
import { buildCanvasModel } from '../../components/Canvas/canvasSelectors';
import { useSurfaceRelocation } from '../../components/Terminal/useSurfaceRelocation';
import { clearSurfaceHost, setSurfaceHost } from '../surfaceHosts';
import { applyReattachByToken } from '../../components/Panes/dnd/detach';
import { expectPaneTags, pane, split, sentinel, other } from '../../__testFixtures__/sshPaneCensus';
import { key } from '../../__testFixtures__/sshPickerFixture';
import { AllSshConnectionsDialog } from '../../components/Ssh/AllSshConnectionsDialog';
import { launchSshInTab } from '../sshPicker';
import { connectAllInTabs, connectSavedInTab } from '../sshConnectAll';

const tag = { connectionId: 'saved', browserCollapsed: false, followCd: false, hiddenMetrics: [] };
const defaultShell = { id: 'default-shell', name: 'Local Shell', path: '/native/default', args: [], env: { SOURCE: 'default' }, cwd: '/default-cwd' };
const profiles = [{ ...defaultShell, id: 'first', cwd: '/first' }, defaultShell, { ...defaultShell, id: 'saved', cwd: '/connection' }];
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const rect = { x: 10, y: 20, w: 340, h: 210 };
const canvas = { kind: 'canvas' as const, rect, sourceTerminalId: 'tm-source' };
const makeSnapshot = (terminalId: string, connectionId: string, attempt: LaunchAttemptRef): LaunchSnapshot =>
  ({ terminalId, connectionId, attempt, stage: 'preparing', revision: 1, launchSeq: 1 });

/** `backend` (T10) models the Rust pane registry: a remounted live leaf is Existing, an explicit close
 *  retires its session, and a transfer take returns `transfer.payload`. Off, every op keeps its fixed reply. */
function harness(admission: PaneResult = { status: 'Create', cg: 7 }, attach = false, take?: PaneResult, backend = false) {
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
    writeToTerminal: jest.fn(), closeTerminal: jest.fn(),
    sshSessionTrustHost: jest.fn().mockResolvedValue(undefined), sshSessionSubmitSecret: jest.fn().mockResolvedValue(undefined),
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
  const leaves = new Map<string, string>();
  const live = new Map<string, string>();
  const transfer: { payload?: any } = {};
  const create = jest.fn(async (request: any) => {
    const id = `pc-${++pc}`;
    if (backend) live.set(request.leaf, id);
    return id;
  });
  const bridge = (async (cmd: string, args: any) => {
    if (cmd === 'register_page') return { status: 'Registered', pg: 41, wi: 5 };
    if (cmd === 'create_admitted_terminal') return create(args.request);
    const kind = args.request.op.kind;
    if (backend) {
      const op = args.request.op;
      const key = (pi: { pg: number; seq: number }) => `${pi.pg}:${pi.seq}`;
      if (kind === 'enter' || kind === 'adopt') for (const p of op.panes ?? op.pairs) leaves.set(key(p.pi), p.leaf);
      const leaf = op.pi ? leaves.get(key(op.pi)) : undefined;
      if (kind === 'admit_create' && op.mode === 'Mount' && leaf && live.has(leaf)) {
        return { status: 'Ack', result: { status: 'Existing', pc: live.get(leaf)! } };
      }
      if (kind === 'close' && leaf) { live.delete(leaf); sessions.delete(leaf); snapshots.delete(leaf); }
      if (kind === 'take') return { status: 'Ack', result: { status: 'Taken', payload: transfer.payload } };
    }
    return { status: 'Ack', result: kind === 'admit_create' ? admission : kind === 'take' ? take : { status: 'Ok' } };
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
  return { api, client, create, snapshots, sessions, bridge, live, transfer };
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

test('ssh_root_preseed_keeps_full_tag_and_default_profile', async () => {
  const h = harness();
  store.dispatch(addTab({ id: 'tb-neighbors', title: 'Neighbors', shellType: 'neighbors', icon: '', isActive: false }));
  store.dispatch(addTabTree({ tabId: 'tb-neighbors', tree: split('neighbors', pane('local'), pane('other', other)) }));
  const published = jest.fn();
  const stop = store.subscribe(() => {
    const { tabs, panes } = store.getState();
    const tab = tabs.tabs.find(t => t.shellType === defaultShell.id);
    if (tab && !published.mock.calls.length) {
      published(panes.treesByTabId[tab.id], getTabPanesGlobal()[tab.id]);
    }
  });
  try {
    const placed = launch();
    const expected = { ...tag };
    expect(published.mock.calls[0][0]).toMatchObject({ terminalId: placed.terminalId, shellType: defaultShell.id, ssh: expected });
    expect(published.mock.calls[0][1]).toEqual(published.mock.calls[0][0]);
    expect(placed.terminalId).toMatch(/^tm-/);
    // New launches must begin with defaults. Exercise nondefaults on that same
    // leaf before first mount, including an independently set metric preference.
    const leaf = store.getState().panes.treesByTabId[placed.tabId]!;
    store.dispatch(addTabTree({ tabId: placed.tabId, tree: { ...leaf, ssh: { ...expected, hiddenMetrics: [...sentinel.hiddenMetrics] } } }));
    store.dispatch(patchSshPaneTag({
      terminalId: placed.terminalId,
      patch: { browserCollapsed: true, browserPath: '/srv/a b', followCd: true },
    }));
    await act(async () => { render(); await flush(); });
    const expectedTags = { [placed.terminalId]: sentinel, 'tm-other': other };
    expectPaneTags(Object.values(store.getState().panes.treesByTabId), expectedTags, ['tm-local']);
    expectPaneTags(Object.values(getTabPanesGlobal()), expectedTags, ['tm-local']);
    // Only the ssh leaf is under test; the neighbour tab's local leaf creates on its own.
    expect(h.create.mock.calls.filter(([request]) => request.leaf === placed.terminalId)).toEqual([[expect.objectContaining({
      leaf: placed.terminalId, profile: defaultShell.id, cwd: defaultShell.cwd, sshLaunchConnectionId: 'saved',
    })]]);
  } finally { stop(); }
});

test('missing_saved_connection_remains_unavailable_without_creating_a_shell', async () => {
  const h = harness();
  store.dispatch(addTabTree({ tabId: 'tb-unavailable', tree: pane('ssh', { ...sentinel, connectionId: 'missing' }) }));
  store.dispatch(addTab({ id: 'tb-unavailable', title: 'Unavailable', shellType: defaultShell.id, icon: '' }));
  await act(async () => { render(); await flush(); });
  expect(element.textContent).toContain('This saved SSH connection is unavailable.');
  expectPaneTags(Object.values(store.getState().panes.treesByTabId), {
    'tm-ssh': { ...sentinel, connectionId: 'missing' },
  });
  expect(h.create).not.toHaveBeenCalled();
  expect(h.api.createTerminal).not.toHaveBeenCalled();
  expect(h.api.sshSessionOpen).not.toHaveBeenCalled();
});

test('adopted_ssh_without_a_live_descriptor_does_not_launch_on_mount', async () => {
  const tree = pane('ssh', sentinel);
  const h = harness({ status: 'Create', cg: 7 }, false, {
    status: 'Taken', payload: {
      panes: [{ paneId: tree.id, leaf: tree.terminalId!, restore: false }],
      ui: { kind: 'pane', tabId: 'tb-transferred', tabTitle: 'Transfer', paneTree: tree, terminals: [] },
    },
  });
  await applyReattachByToken('transfer');
  expect(h.client.isAdopted(h.client.capture('tm-ssh', 'pn-ssh')!)).toBe(true);
  await act(async () => { render(); await flush(); });
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.create.mock.calls[0][0]).not.toHaveProperty('sshLaunchConnectionId');
  expect(h.api.sshSessionOpen).not.toHaveBeenCalled();
  expectPaneTags(Object.values(store.getState().panes.treesByTabId), { 'tm-ssh': sentinel });
});

test('adopted_live_ssh_queries_runtime_without_retyping', async () => {
  const tree = pane('ssh', sentinel);
  const h = harness({ status: 'Create', cg: 7 }, false, {
    status: 'Taken', payload: {
      panes: [{ paneId: tree.id, leaf: 'tm-ssh', restore: false }],
      ui: { kind: 'pane', tabId: 'tb-transferred', tabTitle: 'Transfer', paneTree: tree,
        terminals: [{ terminalId: 'tm-ssh', processId: 'pc-transferred' }] },
    },
  });
  Object.assign(h.api, { onSshLaunchState: jest.fn(async () => () => {}) });
  h.sessions.set('tm-ssh', { terminalId: 'tm-ssh', connectionId: 'saved', state: 'connected',
    generation: 4, revision: 1, gate: 'verified' });
  h.api.ssh.terminalLaunchState.mockResolvedValueOnce({
    terminalId: 'tm-ssh', connectionId: 'saved', stage: 'running', launchSeq: 1, revision: 1,
    attempt: { sessionGeneration: 4, attemptReceipt: { generation: 4, gate: 'verified' },
      processIncarnation: 'pc-transferred', ownerIncarnation: { pg: 41, seq: 1 } },
  });
  store.dispatch(addTab({ id: 'tb-neighbors', title: 'Neighbors', shellType: 'neighbors', icon: '', isActive: false }));
  store.dispatch(addTabTree({ tabId: 'tb-neighbors', tree: split('neighbors', pane('local'), pane('other', other)) }));
  await applyReattachByToken('transfer');
  await act(async () => { render(); await flush(); });
  expect(h.api.sshSessionState).toHaveBeenCalledWith('tm-ssh');
  expect(h.api.ssh.terminalLaunchState).toHaveBeenCalledWith('tm-ssh', expect.objectContaining({
    processIncarnation: 'pc-transferred', sessionGeneration: 4,
  }));
  // The neighbour tab's own local leaf is a legitimate create; the adopted ssh leaf must not be.
  expect(h.create.mock.calls.filter(([request]) => request.leaf === 'tm-ssh')).toEqual([]);
  expect(h.api.sshSessionOpen).not.toHaveBeenCalled();
  expect(h.api.ssh.launchTerminal).not.toHaveBeenCalled();
  expectPaneTags(Object.values(store.getState().panes.treesByTabId), {
    'tm-ssh': sentinel, 'tm-other': other,
  }, ['tm-local']);
});

function RelocationProbe({ terminalId, surface }: { terminalId: string; surface: HTMLElement }) {
  const engineRef = React.useRef({
    relocateTo: (target: HTMLElement) => { target.appendChild(surface); return 'relocated' as const; },
  });
  const paneRef = React.useRef<HTMLDivElement>(null);
  useSurfaceRelocation({ terminalId, engineRef, paneRef, onRelocated() {}, onAborted() {} });
  return <div data-relocation-home ref={paneRef} />;
}

test.each(['background', 'connector'] as const)(
  'canvas_spawn_and_relocation_keep_one_tagged_terminal_identity (%s)', async gesture => {
    const h = harness();
    store.dispatch(addTab({ id: 'tb-canvas', title: 'Canvas', shellType: CANVAS_SHELL_TYPE, icon: '' }));
    const localTree = split('neighbors', pane('local'), pane('other', other));
    store.dispatch(addTab({ id: 'tb-neighbors', title: 'Neighbors', shellType: 'neighbors', icon: '', isActive: false }));
    store.dispatch(addTabTree({ tabId: 'tb-neighbors', tree: localTree }));
    const placement = gesture === 'connector' ? { ...canvas, sourceTerminalId: 'tm-local' }
      : { kind: 'canvas' as const, rect };
    const result = launchSshConnection('saved', placement);
    if (!result.ok) throw new Error(result.error.message);
    const leaf = store.getState().panes.treesByTabId[result.tabId]!;
    store.dispatch(addTabTree({ tabId: result.tabId, tree: { ...leaf, ssh: sentinel } }));
    await act(async () => { render(); await flush(); });
    const node = buildCanvasModel(store.getState()).nodes.find(n => n.terminalId === result.terminalId)!;
    expect(node).toMatchObject({ terminalId: result.terminalId, tabId: result.tabId, rect });
    expect(node).not.toHaveProperty('ssh');
    expect(store.getState().tabs.activeTabId).toBe('tb-canvas');

    const host = document.body.appendChild(document.createElement('div'));
    const home = document.body.appendChild(document.createElement('div'));
    const surface = document.createElement('div');
    const probe = createRoot(home);
    try {
      await act(async () => { probe.render(<RelocationProbe terminalId={result.terminalId} surface={surface} />); });
      expect(home.contains(surface)).toBe(true);
      await act(async () => setSurfaceHost(node.terminalId, host));
      expect(host.firstChild).toBe(surface);
      expectPaneTags(Object.values(store.getState().panes.treesByTabId), {
        [result.terminalId]: sentinel, 'tm-other': other,
      }, ['tm-local']);
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.api.sshSessionOpen.mock.calls).toEqual([[result.terminalId, 'saved']]);
      await act(async () => clearSurfaceHost(node.terminalId, host));
      expect(home.contains(surface)).toBe(true);
    } finally {
      await act(async () => { clearSurfaceHost(node.terminalId, host); probe.unmount(); });
      home.remove();
      host.remove();
    }
  },
);

test('ssh_uses_configured_default_not_connection_or_first_profile', async () => {
  const h = harness();
  let tabId = '';
  await act(async () => { render(); tabId = launch().tabId; await flush(); });
  // The profile ('saved' id collides with the connection id on purpose) decides shell/cwd; the tab is titled by the connection.
  expect(h.create.mock.calls).toEqual([[expect.objectContaining({ profile: 'default-shell', cwd: '/default-cwd', name: 'Saved destination', owningTabId: tabId })]]);
  expect(store.getState().tabs.tabs.find(tab => tab.id === tabId)?.title).toBe('Saved destination');
});

test('stale_default_falls_back_like_an_ordinary_new_tab', async () => {
  const h = harness();
  store.dispatch(setDefaultProfile('missing'));
  let tabId = '';
  await act(async () => { render(); tabId = launch().tabId; await flush(); });
  // resolveDefaultProfile: a stale default id resolves to the first profile, exactly as the "+" button does.
  expect(h.create.mock.calls).toEqual([[expect.objectContaining({ profile: 'first', cwd: '/first', owningTabId: tabId })]]);
});

test('missing_default_profiles_creates_nothing', () => {
  const h = harness();
  store.dispatch(setShellProfiles([]));
  store.dispatch(setDefaultProfile('missing'));
  const before = store.getState();
  const mirror = { ...getTabPanesGlobal() };
  expect(launchSshConnection('saved', canvas)).toMatchObject({ ok: false, error: { code: 'MissingDefaultProfile' } });
  expect(store.getState()).toBe(before);
  expect(getTabPanesGlobal()).toEqual(mirror);
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
  // The mounted launch notice only observes (queries) when the native bridge can push launch state.
  Object.assign(h.api, { onSshLaunchState: jest.fn(async () => () => {}) });
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
  // The mounted launch notice only observes (queries) when the native bridge can push launch state.
  Object.assign(h.api, { onSshLaunchState: jest.fn(async () => () => {}) });
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

test('attempt_receipt_carries_the_session_error_code_with_its_reason', async () => {
  const { api } = harness();
  api.sshSessionOpen.mockImplementationOnce(async (terminalId: string, connectionId: string) => ({
    terminalId, connectionId, generation: 5, state: 'error', revision: 1, gate: 'blocked',
    reason: 'Host key changed', errorCode: 'host-key-changed' }));
  await observeOwnedSshLaunch(api, { terminalId: 'tm-code', connectionId: 'saved', processIncarnation: 'pc-code',
    owner: Promise.resolve({ pg: 41, seq: 1 }), current: () => true }, 'open');
  expect(api.ssh.launchTerminal.mock.calls[0][2].attemptReceipt).toEqual({
    generation: 5, gate: 'blocked', reason: 'Host key changed', errorCode: 'host-key-changed' });
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

test('reconnectSshTerminal gets a fresh generation for the exact same shell and terminal', async () => {
  const { api, snapshots, create } = harness();
  let leaf = '';
  await act(async () => { render(); leaf = launch().terminalId; await flush(); });
  const prior = snapshots.get(leaf)!;
  snapshots.set(leaf, { ...prior, stage: 'ended' });
  api.ssh.launchTerminal.mockImplementationOnce(async (terminalId, connectionId, attempt) =>
    ({ ...makeSnapshot(terminalId, connectionId, attempt), stage: 'typed' }));
  let result;
  await act(async () => { result = await reconnectSshTerminal(leaf); });
  expect(result).toEqual({ ok: true, snapshot: expect.objectContaining({ terminalId: leaf, stage: 'typed' }) });
  expect(api.sshSessionReconnect.mock.calls).toEqual([[leaf]]);
  expect(api.ssh.launchTerminal.mock.calls[1]).toEqual([leaf, 'saved', {
    ...prior.attempt, sessionGeneration: 2, attemptReceipt: { generation: 2, gate: 'pending' },
  }]);
  expect(create).toHaveBeenCalledTimes(1);
  expect(api.writeToTerminal).not.toHaveBeenCalled();
  expect(api.closeTerminal).not.toHaveBeenCalled();
});

test('reconnectSshTerminal refuses a running login without writing or killing', async () => {
  const { api, snapshots } = harness();
  let leaf = '';
  await act(async () => { render(); leaf = launch().terminalId; await flush(); });
  snapshots.set(leaf, { ...snapshots.get(leaf)!, stage: 'running' });
  expect(await reconnectSshTerminal(leaf)).toEqual({ ok: false, error: {
    code: 'NotAtPrompt', message: 'Return to the local prompt to reconnect',
  } });
  expect(api.ssh.terminalLaunchState).toHaveBeenCalledTimes(1);
  expect(api.sshSessionReconnect).not.toHaveBeenCalled();
  expect(api.ssh.launchTerminal).toHaveBeenCalledTimes(1); // initial start only
  expect(api.writeToTerminal).not.toHaveBeenCalled();
  expect(api.closeTerminal).not.toHaveBeenCalled();
});

test('native prompt timeout maps to NotAtPrompt without a renderer input or teardown', async () => {
  const { api, snapshots } = harness();
  let leaf = '';
  await act(async () => { render(); leaf = launch().terminalId; await flush(); });
  snapshots.set(leaf, { ...snapshots.get(leaf)!, stage: 'ended' });
  jest.useFakeTimers();
  try {
    api.ssh.terminalLaunchState.mockImplementationOnce(async () => snapshots.get(leaf)!);
    api.ssh.terminalLaunchState.mockImplementationOnce(async (_id, attempt) => ({
      ...makeSnapshot(leaf, 'saved', attempt), stage: 'error',
      error: { code: 'Timeout', message: 'native readiness expired' },
    }));
    let result;
    await act(async () => {
      const pending = reconnectSshTerminal(leaf);
      await flush();
      jest.advanceTimersByTime(250);
      result = await pending;
    });
    expect(result).toEqual({ ok: false, error: { code: 'NotAtPrompt', message: 'Return to the local prompt to reconnect' } });
    expect(api.ssh.launchTerminal).toHaveBeenCalledTimes(2);
    expect(api.writeToTerminal).not.toHaveBeenCalled();
    expect(api.closeTerminal).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

test('mounted notice sends exact native prompt identity and cancels the qualified attempt', async () => {
  const { api, sessions, snapshots } = harness();
  const bridge = Object.assign(api, { onSshLaunchState: jest.fn().mockResolvedValue(() => {}) });
  let leaf = '';
  await act(async () => {
    render(); leaf = launch().terminalId;
    store.dispatch(sshOwnersChanged({ [leaf]: 'saved' }));
    await flush();
  });
  const attempt = snapshots.get(leaf)!.attempt;
  // Force a prompt switch without changing generation. Qualified reads, never the event payload,
  // carry the revised prompt and current owner.
  const receive = bridge.onSshLaunchState.mock.calls.at(-1)![0];
  const view = sessions.get(leaf)!;
  const promptTarget = { connectionId: 'saved', user: 'alice', host: 'target.test', port: 22, hop: 'target' as const };
  const findButton = (name: string) => [...element.querySelectorAll('button')].find(b => b.textContent === name)!;
  await act(async () => {
    sessions.set(leaf, { ...view, revision: 2, promptTarget, promptId: 'jump',
      hostKey: { algorithm: 'ssh-ed25519', changed: false, fingerprintSha256: 'SHA256:fixture' } });
    receive({ terminalId: leaf, state: 'typed' }); await flush();
  });
  await act(async () => findButton('Trust').click());
  expect(api.sshSessionTrustHost.mock.calls).toEqual([[leaf, true, { generation: 1, promptId: 'jump' }]]);
  await act(async () => {
    sessions.set(leaf, { ...view, revision: 3, promptTarget, promptId: 'target', state: 'needs-secret' });
    receive({ terminalId: leaf, state: 'typed' }); await flush();
  });
  await act(async () => findButton('Continue').click());
  expect(api.sshSessionSubmitSecret.mock.calls).toEqual([[leaf, '', false, { generation: 1, promptId: 'target' }]]);
  await act(async () => findButton('Cancel').click());
  expect(api.ssh.cancelTerminalLaunch.mock.calls).toEqual([[leaf, attempt]]);
  expect(api.ssh.launchTerminal).toHaveBeenCalledTimes(1);
  act(() => { store.dispatch(sshOwnersChanged({})); });
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

test('ssh_launch_all_surfaces_restore_move_reconnect_exact_owner_map', async () => {
  // Mutation targets: splitLeafInTree/survivingLeaf (tag copied to the new sibling or lost); movePaneToTab or
  // applyDetachPayload dropping `ssh`; TerminalService opening/launching (not querying) an Existing or adopted
  // SSH leaf; observeOwnedSshLaunch 'reconnect' not taking the fresh generation; closeTerminal not closing the pane.
  const h = harness(undefined, false, undefined, true);
  Object.assign(h.api, { onSshLaunchState: jest.fn(async () => () => {}) });
  const ids = ['tab-host', 'canvas-host', 'picker-host', 'single-host', 'batch-a', 'batch-b'];
  const revision = store.getState().ssh.revision + 1;
  store.dispatch(applyView({ revision, view: { revision, loadError: null,
    folders: [{ id: 'f-batch', parentId: null, name: 'Batch', icon: '', color: '', order: 0 }],
    connections: ids.map((id, order) => ({
      id, name: `Saved ${id}`, host: `${id}.test`, user: 'user', port: 22, auth: 'agent' as const, identityFile: null,
      folderId: id.startsWith('batch') ? 'f-batch' : null, jumpConnectionId: null, extraOptions: [] as [string, string][],
      bookmarked: false, order, lastUsedAt: null, hasSavedSecret: false,
    })),
  } }));

  type Owners = Record<string, { connectionId: string; sessionGeneration: number | undefined }>;
  const leavesOf = (node: PaneNode | null | undefined, out: PaneNode[] = []): PaneNode[] => {
    if (node?.type === 'terminal') out.push(node);
    else node?.children?.forEach(child => leavesOf(child, out));
    return out;
  };
  const trees = () => store.getState().panes.treesByTabId;
  const tabOf = (terminalId: string) => Object.entries(trees()).find(([, tree]) =>
    leavesOf(tree).some(leaf => leaf.terminalId === terminalId))![0];
  const paneOf = (terminalId: string) => leavesOf(trees()[tabOf(terminalId)]).find(leaf => leaf.terminalId === terminalId)!;
  const paneOwners = (): Owners => Object.fromEntries(Object.values(trees()).flatMap(tree => leavesOf(tree))
    .filter(leaf => leaf.ssh).map(leaf => [leaf.terminalId!, {
      connectionId: leaf.ssh!.connectionId, sessionGeneration: h.sessions.get(leaf.terminalId!)?.generation,
    }]));
  const backendOwners = (): Owners => Object.fromEntries([...h.sessions].map(([id, view]) =>
    [id, { connectionId: view.connectionId, sessionGeneration: view.generation }]));
  const local: string[] = [];
  const expectOwners = (expected: Owners) => {
    expect(paneOwners()).toStrictEqual(expected);
    expect(backendOwners()).toStrictEqual(expected);
    for (const [id, owner] of Object.entries(expected)) {
      const last = h.api.ssh.launchTerminal.mock.calls.filter(([terminalId]) => terminalId === id).at(-1);
      expect(last?.[2].sessionGeneration).toBe(owner.sessionGeneration);
    }
    expectPaneTags(Object.values(trees()), Object.fromEntries(Object.entries(expected)
      .map(([id, owner]) => [id, { ...tag, connectionId: owner.connectionId }])), local);
  };
  const calls = (open: number, launches: number, creates: number) => {
    expect(h.api.sshSessionOpen).toHaveBeenCalledTimes(open);
    expect(h.api.ssh.launchTerminal).toHaveBeenCalledTimes(launches);
    expect(h.create).toHaveBeenCalledTimes(creates);
  };
  const launched: Record<string, string> = {};
  const surface = async (expected: number, run: () => unknown) => {
    const before = new Set(Object.keys(paneOwners()));
    await act(async () => { await run(); await flush(); });
    const added = Object.keys(paneOwners()).filter(id => !before.has(id));
    expect(added).toHaveLength(expected);
    for (const id of added) launched[id] = paneOf(id).ssh!.connectionId;
    return added;
  };

  await act(async () => { render(); await flush(); });
  // 1. Every launch surface: tab menu, Canvas placement, picker, Settings single, Settings folder batch.
  const [tabHost] = await surface(1, () => expect(launchSshInTab('tab-host')).toBeNull());
  const [canvasHost] = await surface(1, () => expect(launchSshConnection('canvas-host', { kind: 'canvas', rect }).ok).toBe(true));
  const pickerHost = document.body.appendChild(document.createElement('div'));
  const picker = createRoot(pickerHost);
  const closePicker = jest.fn();
  await act(async () => {
    picker.render(<Provider store={store}><AllSshConnectionsDialog request={{ invoker: null, launch: launchSshInTab }} onClose={closePicker} /></Provider>);
  });
  const [pickerTerminal] = await surface(1, () => { key(document.querySelector('input[role="combobox"]')!, 'Enter'); });
  expect(closePicker).toHaveBeenCalledTimes(1);
  await act(async () => { picker.unmount(); });
  pickerHost.remove();
  const [single] = await surface(1, async () => expect(await connectSavedInTab('single-host')).toEqual({ error: null, recentFailed: true }));
  await surface(2, async () => expect(await connectAllInTabs('f-batch')).toMatchObject({ attempted: 2, started: 2, failures: [] }));
  expect(Object.values(launched).sort()).toEqual([...ids.filter(id => id !== 'picker-host'), launched[pickerTerminal]].sort());
  expect(launched).toMatchObject({ [tabHost]: 'tab-host', [canvasHost]: 'canvas-host', [single]: 'single-host' });
  const afterLaunch = backendOwners();
  expect(Object.fromEntries(Object.entries(afterLaunch).map(([id, owner]) => [id, owner.connectionId]))).toStrictEqual(launched);
  expect(Object.values(afterLaunch).map(owner => owner.sessionGeneration).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  expectOwners(afterLaunch);
  calls(6, 6, 6);

  // 2. Restore the persisted layout (JSON round trip) over the still-live backend: attach, never re-type.
  const persisted = JSON.parse(JSON.stringify({ tabs: store.getState().tabs.tabs, trees: trees() }));
  await act(async () => { root?.unmount(); });
  root = undefined;
  element.remove();
  await act(async () => {
    for (const saved of persisted.tabs) store.dispatch(removeTab(saved.id));
    for (const [id, tree] of Object.entries(persisted.trees)) {
      leavesOf(tree as PaneNode).forEach(leaf => terminalService.detachTerminal(leaf.terminalId!));
      store.dispatch(removeTabTree(id));
    }
    clearTabPanesInPlace();
    await flush();
  });
  expect(paneOwners()).toStrictEqual({});
  expect(backendOwners()).toStrictEqual(afterLaunch);
  await act(async () => {
    for (const saved of persisted.tabs) {
      store.dispatch(addTabTree({ tabId: saved.id, tree: persisted.trees[saved.id] }));
      store.dispatch(addTab(saved));
    }
    render();
    await flush();
  });
  expectOwners(afterLaunch);
  calls(6, 6, 6);

  // 3. Split the tab-surface SSH pane: the new sibling is a plain local terminal.
  const splitTab = tabOf(tabHost);
  await act(async () => {
    store.dispatch(splitPaneInTab({ tabId: splitTab, paneId: paneOf(tabHost).id, direction: 'horizontal', shellType: defaultShell.id }));
    await flush();
  });
  const sibling = leavesOf(trees()[splitTab]).find(leaf => leaf.terminalId !== tabHost)!.terminalId!;
  local.push(sibling);
  expectOwners(afterLaunch);
  calls(6, 6, 7);
  expect(h.create.mock.calls[6][0]).toMatchObject({ leaf: sibling });
  expect(h.create.mock.calls[6][0]).not.toHaveProperty('sshLaunchConnectionId');

  // 4. Move the SSH pane into another tab, then detach the Settings-single tab and adopt it back.
  const batchTab = tabOf(Object.keys(launched).find(id => launched[id] === 'batch-a')!);
  await act(async () => {
    store.dispatch(movePaneToTab({ sourceTabId: splitTab, sourcePaneId: paneOf(tabHost).id,
      targetTabId: batchTab, targetPaneId: leavesOf(trees()[batchTab])[0].id, zone: 'right' }));
    await flush();
  });
  expect(tabOf(tabHost)).toBe(batchTab);
  expect(tabOf(sibling)).toBe(splitTab);
  expectOwners(afterLaunch);
  calls(6, 6, 7);

  const detachedTab = tabOf(single);
  const detachedTree = JSON.parse(JSON.stringify(trees()[detachedTab]));
  await act(async () => {
    terminalService.detachTerminal(single);
    store.dispatch(removeTab(detachedTab));
    store.dispatch(removeTabTree(detachedTab));
    await flush();
  });
  const { [single]: away, ...remaining } = afterLaunch;
  expect(paneOwners()).toStrictEqual(remaining);
  expect(backendOwners()).toStrictEqual(afterLaunch);
  h.transfer.payload = {
    panes: [{ paneId: detachedTree.id, leaf: single, restore: false }],
    ui: { kind: 'pane', tabId: 'tb-transferred', tabTitle: 'Transfer', paneTree: detachedTree,
      terminals: [{ terminalId: single, processId: h.live.get(single) }] },
  };
  await act(async () => { await applyReattachByToken('t10-detach'); await flush(); });
  expect(paneOf(single).ssh).toEqual({ ...tag, connectionId: away.connectionId });
  expectOwners(afterLaunch);
  calls(6, 6, 7);

  // 5. Reconnect the moved pane: same terminal, the fresh generation, one more typed launch.
  h.snapshots.set(tabHost, { ...h.snapshots.get(tabHost)!, stage: 'ended' });
  h.api.ssh.launchTerminal.mockImplementationOnce(async (terminalId, connectionId, attempt) =>
    ({ ...makeSnapshot(terminalId, connectionId, attempt), stage: 'typed' }));
  let reconnected;
  await act(async () => { reconnected = await reconnectSshTerminal(tabHost); await flush(); });
  expect(reconnected).toEqual({ ok: true, snapshot: expect.objectContaining({ terminalId: tabHost, stage: 'typed' }) });
  const afterReconnect = { ...afterLaunch, [tabHost]: { connectionId: 'tab-host', sessionGeneration: 7 } };
  expectOwners(afterReconnect);
  calls(6, 7, 7);
  expect(h.api.sshSessionReconnect.mock.calls).toEqual([[tabHost]]);

  // 6. Close the Canvas-placed pane: its owner is retired; nobody else changes.
  const canvasTab = tabOf(canvasHost);
  await act(async () => {
    await terminalService.closeTerminal(canvasHost);
    store.dispatch(removeTab(canvasTab));
    store.dispatch(removeTabTree(canvasTab));
    await flush();
  });
  const { [canvasHost]: closed, ...afterClose } = afterReconnect;
  expect(closed.connectionId).toBe('canvas-host');
  expectOwners(afterClose);
  calls(6, 7, 7);
});
