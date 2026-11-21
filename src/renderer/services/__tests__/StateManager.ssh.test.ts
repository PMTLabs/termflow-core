/** @jest-environment jsdom */
jest.mock('../../components/TerminalContainer', () => ({
  clearTabPanes: () => jest.requireActual('../tabPanesStore').clearTabPanesInPlace(),
}));
jest.mock('../../api/apiBase', () => ({ apiBase: async () => 'http://fixture.invalid/api' }));
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));

import { store } from '../../store';
import { addTab, clearAllTabs, removeTab, setActiveTab } from '../../store/slices/tabsSlice';
import { addTabTree, movePaneToTab, patchSshPaneTag, removeTabTree, resetPanes, setActiveTabId, type PaneNode } from '../../store/slices/panesSlice';
import { getPaneLeaves } from '../../store/slices/paneTreeOps';
import { expectPaneTags, other, pane, sentinel, split, taggedTree, tags } from '../../__testFixtures__/sshPaneCensus';
import { installRestoreStream } from '../../__testFixtures__/paneRestoreBridge';
import { StateManager, type SavedLayout } from '../StateManager';
import { TerminalServiceClass, terminalService } from '../TerminalService';
import { clearTabPanesInPlace, getTabPanesGlobal } from '../tabPanesStore';
import { installPaneIncarnations, PaneIncarnations } from '../paneIncarnations';
import { __setWindowForTests, layoutUndoKey, sessionStateKey, SLOT_ZERO_ID } from '../windowScope';
import { captureWorkspaceSnapshot, workspaceIdentity } from '../workspaceSnapshot';
import { __resetLayoutUndoForTests, clearUndo, pushUndo } from '../layoutUndo';
import { clearLayoutBaseline, getLayoutBaseline } from '../layoutBaseline';
import { addTabRootedAt } from '../folderTab';
import { openAdminTabWithProfile, takeOptimisticAdminTab } from '../adminTabActions';
import { buildNewTabFields } from '../newTabActions';
import { planSeeds } from '../tabTreeSeed';
import { installSshSessionEvents } from '../sshSessionEvents';
import { collectTabCloseTerminalIds } from '../closeTabs';
import type { SshAPI, SshSessionView } from '../../types/ssh';

const put = (tabId: string, tree: PaneNode | null) => {
  store.dispatch(addTabTree({ tabId, tree }));
  store.dispatch(addTab({ id: tabId, title: tabId, shellType: 'default', icon: '' }));
};
const activate = (id: string) => { store.dispatch(setActiveTab(id)); store.dispatch(setActiveTabId(id)); };
const trees = () => store.getState().panes.treesByTabId;
const layout = (tree: PaneNode, id = 'ssh-layout'): SavedLayout => ({
  id, name: id, tabs: [{ id: 'tb-new', title: 'New' }], activeTabId: 'tb-new',
  paneTree: tree, activePaneId: tree.id, createdAt: 1, updatedAt: 1,
  tabPanes: { 'tb-new': tree }, treesByTabId: { 'tb-new': tree },
});
const fetchBefore = global.fetch;
const terminals = jest.fn();
const launch = jest.fn();
const open = jest.fn();

function clear() {
  store.dispatch(clearAllTabs());
  store.dispatch(resetPanes());
  clearTabPanesInPlace();
}
beforeEach(() => {
  clear();
  localStorage.clear();
  installRestoreStream();
  terminals.mockReset().mockResolvedValue({ terminals: [] });
  launch.mockClear();
  open.mockClear();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: terminals });
  // `new TerminalServiceClass()` subscribes to the global PTY streams on construction, so the
  // stub carries inert subscriptions; the close paths under test use the injected api instead.
  (window as any).electronAPI = {
    ssh: { launchTerminal: launch }, sshSessionOpen: open, onTerminalData: jest.fn(), onTerminalExit: jest.fn(),
  };
});
afterEach(() => {
  for (const id of ['tm-ssh', 'tm-local', 'tm-other', 'tm-moved']) terminalService.detachTerminal(id);
  clear();
  clearUndo();
  clearLayoutBaseline();
  localStorage.clear();
  __setWindowForTests(SLOT_ZERO_ID);
  installPaneIncarnations(new PaneIncarnations());
  global.fetch = fetchBefore;
  delete (window as any).electronAPI;
});

test.each([
  [SLOT_ZERO_ID, false], [SLOT_ZERO_ID, true], ['detached', false], ['detached', true],
] as const)('session_save_restore_roundtrips_tag_in_active_background_and_detached_windows (%s live=%s)', async (windowId, live) => {
  __setWindowForTests(windowId);
  put('tb-active', split('active', pane('ssh', sentinel), pane('local')));
  put('tb-background', pane('other', other));
  put('tb-empty', null);
  activate('tb-active');
  const key = sessionStateKey();
  StateManager.saveState();
  const saved = JSON.parse(localStorage.getItem(key)!);
  expectPaneTags([saved.paneTree], { 'tm-ssh': sentinel }, ['tm-local']);
  expectPaneTags(Object.values(saved.tabPanes as Record<string, PaneNode | null>), tags, ['tm-local']);
  expect(saved.tabPanes['tb-empty']).toBeNull();
  if (windowId !== SLOT_ZERO_ID) expect(localStorage.getItem('auto-terminal-state')).toBeNull();
  clear();
  if (live) terminals.mockResolvedValue({ terminals: [
    { terminalId: 'tm-ssh', id: 'pc-ssh' }, { terminalId: 'tm-other', id: 'pc-other' },
  ] });
  expect(await StateManager.restoreState(store.dispatch)).toBe(true);
  expectPaneTags(Object.values(trees()), tags, ['tm-local']);
  expectPaneTags(Object.values(getTabPanesGlobal()), tags, ['tm-local']);
  expect(trees()['tb-empty']).toBeNull();
  expect(store.getState().tabs.activeTabId).toBe('tb-active');
  expect(terminalService.getProcessId('tm-ssh')).toBe(live ? 'pc-ssh' : undefined);
  expect(terminalService.getProcessId('tm-other')).toBe(live ? 'pc-other' : undefined);
  expect(open).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

test('legacy_leaf_migration_keeps_ssh_tag_in_all_three_tree_maps', () => {
  const tree = taggedTree();
  tree.children![0] = { ...tree.children![0], terminalId: 'tb-old' };
  const clean: SavedLayout = (StateManager as any).sanitizeLayoutData(layout(tree));
  const migrated = clean.paneTree.children[0].terminalId;
  expect(migrated).toMatch(/^tm-/);
  for (const mirror of [clean.paneTree, clean.tabPanes!['tb-new'], clean.treesByTabId!['tb-new']]) {
    expect(mirror.children[0]).toMatchObject({ terminalId: migrated, sessionKey: 'tb-old' });
    expectPaneTags([mirror], { [migrated]: sentinel, 'tm-other': other }, ['tm-local']);
  }
});

test.each(['workspace', 'tab'] as const)('named_layout_save_update_load_preserves_tag_in_both_scopes (%s)', async scope => {
  put('tb-ssh', taggedTree());
  put('tb-background', pane('background', other));
  activate('tb-ssh');
  const id = await StateManager.saveLayout('SSH', undefined, { scope, tabId: 'tb-ssh' });
  const local = ['tm-local'];
  const savedTags = scope === 'workspace' ? { ...tags, 'tm-background': other } : tags;
  const exported = (): SavedLayout => JSON.parse(StateManager.exportLayouts())[0];
  expectPaneTags(Object.values(exported().treesByTabId!), savedTags, local);
  expect(exported()).not.toHaveProperty('sshSession');
  expect(exported()).not.toHaveProperty('sshLaunch');
  store.dispatch(patchSshPaneTag({ terminalId: 'tm-ssh', patch: { browserPath: '/srv/updated' } }));
  const updated = { ...savedTags, 'tm-ssh': { ...sentinel, browserPath: '/srv/updated' } };
  expect(await StateManager.updateLayout(id)).toBe(true);
  expectPaneTags(Object.values(exported().treesByTabId!), updated, local);
  clear();
  expect(await (scope === 'tab' ? StateManager.loadTabScopedLayout(id, store.dispatch) : StateManager.loadLayout(id, store.dispatch))).toBe(true);
  expectPaneTags(Object.values(trees()), updated, local);
});

test('tab_layout_collision_remints_leaf_not_connection_or_preferences', async () => {
  const existing = { ...pane('ssh'), id: 'pn-owner' };
  put('tb-owner', existing);
  const saved: SavedLayout = { ...layout(taggedTree()), scope: 'tab', scopedTabId: 'tb-new' };
  expect(StateManager.importLayouts(JSON.stringify([saved]))).toBe(1);
  expect(await StateManager.loadTabScopedLayout(saved.id, store.dispatch)).toBe(true);
  expect(trees()['tb-owner']).toEqual(existing);
  const migrated = getPaneLeaves(trees()['tb-new']).find(node => node.id === 'pn-ssh')!;
  expect(migrated.terminalId).toMatch(/^tm-/);
  expect(migrated.terminalId).not.toBe('tm-ssh');
  expect(migrated.sessionKey).toBeUndefined();
  expectPaneTags(Object.values(trees()), { [migrated.terminalId!]: sentinel, 'tm-other': other }, ['tm-ssh', 'tm-local']);
});

test('layout_import_export_validates_ssh_without_losing_valid_preferences', async () => {
  const tree = taggedTree();
  const dirty = {
    ...tree, ssh: sentinel, children: [
      { ...tree.children![0], ssh: { ...sentinel, hiddenMetrics: ['nfs', 'future-key', 'nfs', 'cpu'], attemptReceipt: 'DROP' } },
      tree.children![1],
      { ...pane('invalid'), ssh: { connectionId: 'saved', browserCollapsed: 'not-a-boolean', password: 'DROP' }, sshLaunchConnectionId: 'saved' },
      { ...pane('unavailable'), ssh: { connectionId: 'missing' } },
    ],
  };
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const saved = layout(dirty as unknown as PaneNode);
    expect(StateManager.importLayouts(JSON.stringify([saved]))).toBe(1);
    const json = StateManager.exportLayouts();
    expect(json).not.toContain('DROP');
    expect(json).not.toContain('sshLaunchConnectionId');
    const exported = JSON.parse(json)[0];
    const expected = { ...tags, 'tm-unavailable': { connectionId: 'missing', browserCollapsed: false, followCd: false, hiddenMetrics: [] } };
    for (const mirror of [exported.paneTree, exported.tabPanes['tb-new'], exported.treesByTabId['tb-new']]) {
      expectPaneTags([mirror], expected, ['tm-local', 'tm-invalid']);
    }
    expect(await StateManager.loadLayout(saved.id, store.dispatch)).toBe(true);
    expectPaneTags(Object.values(trees()), expected, ['tm-local', 'tm-invalid']);
    expect(warn).toHaveBeenCalledWith('Ignoring invalid persisted SSH pane metadata.');
    expect(open).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

test.each(['in memory', 'reloaded undo slot'] as const)(
  'workspace_revert_restores_ssh_preferences_and_dirty_identity (%s)', async transport => {
    put('tb-ssh', taggedTree());
    activate('tb-ssh');
    const snapshot = captureWorkspaceSnapshot(store.getState(), 'original');
    const identity = workspaceIdentity(snapshot);
    pushUndo(snapshot);
    if (transport === 'reloaded undo slot') {
      const key = layoutUndoKey();
      const raw = localStorage.getItem(key)!;
      localStorage.setItem(key, raw.replace(/\["nfs","cpu"\]/g, '["nfs","future","cpu","nfs"]'));
      __resetLayoutUndoForTests();
    }
    store.dispatch(patchSshPaneTag({ terminalId: 'tm-ssh', patch: { browserPath: '/a/different/path', followCd: false } }));
    expect(workspaceIdentity(captureWorkspaceSnapshot(store.getState(), 'modified'))).not.toBe(identity);
    expectPaneTags(Object.values(snapshot.treesByTabId), tags, ['tm-local']);
    expectPaneTags(Object.values(snapshot.tabPanes), tags, ['tm-local']);
    expect(await StateManager.revertWorkspace(store.dispatch)).toBe(true);
    expectPaneTags(Object.values(trees()), tags, ['tm-local']);
    const after = workspaceIdentity(captureWorkspaceSnapshot(store.getState(), 'reverted'));
    expect(getLayoutBaseline()).toBe(after);
    expect(after).not.toMatch(/sshSession|sshLaunch|attemptReceipt/);
  },
);

test.each(['tab', 'window', 'workspace'] as const)(
  'all_close_paths_remove_exact_ssh_session_map_not_moved_panes (%s)', async scope => {
    put('tb-closing', taggedTree());
    put('tb-keeper', null);
    const query = jest.fn(async (terminalId: string): Promise<SshSessionView> => ({
      terminalId, connectionId: terminalId === 'tm-ssh' ? 'saved' : 'other',
      state: 'connected', generation: 1, revision: 1, gate: 'verified',
    }));
    const stop = installSshSessionEvents(store, {
      onSshSessionState: async () => () => {}, sshSessionState: query,
    } as unknown as SshAPI);
    try {
      await Promise.resolve();
      await Promise.resolve();
      const before = store.getState().sshSession.byTerminal;
      expect(before).toEqual({
        'tm-ssh': { connectionId: 'saved', session: await query('tm-ssh') },
        'tm-other': { connectionId: 'other', session: await query('tm-other') },
      });
      query.mockClear();
      store.dispatch(movePaneToTab({
        sourceTabId: 'tb-closing', sourcePaneId: 'pn-ssh', targetTabId: 'tb-keeper', targetPaneId: '', zone: 'right',
      }));
      expect(store.getState().sshSession.byTerminal['tm-ssh']).toBe(before['tm-ssh']);
      expect(query).not.toHaveBeenCalled();

      const close = jest.fn().mockResolvedValue(true);
      const service = new TerminalServiceClass(trees, () => ({ closeTerminal: close } as any), () => new PaneIncarnations());
      for (const id of ['tm-ssh', 'tm-local', 'tm-other']) service.registerExistingTerminal(id, 'pc-' + id);
      for (const id of collectTabCloseTerminalIds(trees()['tb-closing'], 'tb-closing')) await service.closeTerminal(id);
      expect(close.mock.calls).toEqual([['pc-tm-local'], ['pc-tm-other']]);
      expect(service.getProcessId('tm-ssh')).toBe('pc-tm-ssh');

      if (scope === 'tab') {
        store.dispatch(removeTab('tb-closing'));
        store.dispatch(removeTabTree('tb-closing'));
      } else if (scope === 'window') {
        // The handed-off pane is no longer part of the closing window.
        const moved = trees()['tb-keeper'];
        clear();
        expectPaneTags([moved], { 'tm-ssh': sentinel });
      } else {
        // Replace with a layout containing the keeper only.
        const saved = layout(trees()['tb-keeper']!);
        StateManager.importLayouts(JSON.stringify([saved]));
        expect(await StateManager.loadLayout(saved.id, store.dispatch)).toBe(true);
      }
      if (scope === 'window') {
        expect(store.getState().sshSession.byTerminal).toEqual({});
        expectPaneTags(Object.values(trees()), {});
      } else {
        expectPaneTags(Object.values(trees()), { 'tm-ssh': sentinel });
        expect(store.getState().sshSession.byTerminal['tm-ssh']?.connectionId).toBe('saved');
        expect(Object.keys(store.getState().sshSession.byTerminal)).toEqual(['tm-ssh']);
      }
    } finally { stop(); }
  },
);

test('folder_admin_default_and_reset_roots_are_local', () => {
  put('tb-ssh', taggedTree());
  activate('tb-ssh');
  const profile = { id: 'default', name: 'Default', path: 'fixture', args: [], env: {} };
  addTabRootedAt(store.dispatch, { ...buildNewTabFields(profile, []), id: 'tb-folder' }, '/local/folder');
  openAdminTabWithProfile(profile);
  const admin = store.getState().tabs.activeTabId!;
  takeOptimisticAdminTab(admin);
  store.dispatch(addTab({ ...buildNewTabFields(profile, []), id: 'tb-default' }));
  const seed = () => planSeeds(store.getState().tabs.tabs, trees(), getTabPanesGlobal()).forEach(plan => store.dispatch(addTabTree(plan)));
  seed();
  const locals = ['tb-folder', admin, 'tb-default'].map(id => trees()[id]!.terminalId!);
  locals.forEach(id => expect(id).toMatch(/^tm-/));
  expect(trees()[admin]?.elevated).toBe(true);
  expectPaneTags(Object.values(trees()), tags, ['tm-local', ...locals]);
  expect(StateManager.resetToDefaultLayout(store.dispatch)).toBe(true);
  seed();
  const [root] = Object.values(trees());
  expect(root?.terminalId).toMatch(/^tm-/);
  expectPaneTags([root], {}, [root!.terminalId!]);
});
