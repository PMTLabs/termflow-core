/** @jest-environment jsdom */
jest.mock('../../api/tauri-bridge', () => ({ __esModule: true, default: {} }));
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../TerminalService', () => ({ terminalService: {} }));

import { store } from '../../store';
import { removeTab } from '../../store/slices/tabsSlice';
import { removeTabTree } from '../../store/slices/panesSlice';
import { sshLaunchObserved, sshOwnersChanged } from '../../store/slices/sshSessionSlice';
import { clearTabPanesInPlace, getTabPanesGlobal } from '../tabPanesStore';
import { connectAllInTabs, connectSavedInTab } from '../sshConnectAll';
import { preparePicker, replaceSaved, saved } from '../../__testFixtures__/sshPickerFixture';
import type { SshFolder } from '../../types/ssh';

const folder = (id: string, parentId: string | null, order: number): SshFolder => ({ id, parentId, name: id, icon: 'folder', color: 'grey', order });
const insertion = (recent: Promise<{ ok: true } | { ok: false; message: string }>) => ({ ok: true as const, tabId: 't', paneId: 'p', terminalId: 'tm', placement: { kind: 'tab' as const }, recent });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const emptyReply = { revision: 0, view: { revision: 0, folders: [], connections: [], loadError: null } };
let api: ReturnType<typeof preparePicker>;

const openedTabs = (before: Set<string>) => store.getState().tabs.tabs.filter(t => !before.has(t.id));
const tagOf = (tabId: string) => (getTabPanesGlobal()[tabId] as { ssh?: { connectionId: string }; name?: string; terminalId?: string });

beforeEach(() => { api = preparePicker(); });
afterEach(() => {
  for (const tab of store.getState().tabs.tabs) store.dispatch(removeTab(tab.id));
  for (const id of Object.keys(store.getState().panes.treesByTabId)) store.dispatch(removeTabTree(id));
  clearTabPanesInPlace();
});

test('connect_all_uses_right_clicked_folder_descendants_in_tree_order_not_search_results', async () => {
  // Reverse the tree-order walk (or flatten every connection) in sshSlice.selectFolderConnectionIds.
  replaceSaved([
    saved('a2', { folderId: 'f1', order: 1 }),
    saved('s1', { folderId: 'f1-sub', order: 0 }),
    saved('s0', { folderId: 'f1-sub', order: 1 }),
    saved('b1', { folderId: 'f2', order: 0 }),
    saved('top', { folderId: null, order: 2 }),
  ], [folder('f1', null, 0), folder('f1-sub', 'f1', 0), folder('f2', null, 1)]);
  const launch = jest.fn((_id: string) => insertion(Promise.resolve({ ok: true as const })));
  const summary = await connectAllInTabs('f1', launch);
  expect(launch.mock.calls).toEqual([['s1'], ['s0'], ['a2']]);
  expect(summary).toMatchObject({ folderId: 'f1', attempted: 3, started: 3, failures: [], recentFailures: [] });
});

test('duplicate_pending_click_enqueues_once_per_id', async () => {
  // Remove the inFlight guard at the top of connectAllInTabs.
  replaceSaved([saved('a', { folderId: 'f1', order: 0 }), saved('b', { folderId: 'f1', order: 1 })], [folder('f1', null, 0)]);
  const settle: Array<() => void> = [];
  const launch = jest.fn((_id: string) => insertion(new Promise(resolve => { settle.push(() => resolve({ ok: true as const })); })));
  const first = connectAllInTabs('f1', launch);
  const duplicate = await connectAllInTabs('f1', launch);
  expect(duplicate).toBeNull();
  expect(launch.mock.calls).toEqual([['a']]);
  settle[0](); await flush(); settle[1]();
  expect(await first).toMatchObject({ attempted: 2, started: 2 });
  expect(launch.mock.calls).toEqual([['a'], ['b']]);
  // A later, deliberate click is a new set.
  const second = connectAllInTabs('f1', launch);
  await flush(); settle[2](); await flush(); settle[3]();
  await second;
  expect(launch.mock.calls).toEqual([['a'], ['b'], ['a'], ['b']]);
});

test('deleted_mid_batch_reports_named_failure_and_preserves_other_tabs', async () => {
  // sshLaunch.launchSshConnection must re-resolve the id in the store at dispatch time (the find on state.ssh.view.connections).
  const all = [
    saved('a', { name: 'Alpha', folderId: 'f1', order: 0 }),
    saved('b', { name: 'Beta', folderId: 'f1', order: 1 }),
    saved('c', { name: 'Gamma', folderId: 'f1', order: 2 }),
  ];
  replaceSaved(all, [folder('f1', null, 0)]);
  api.ssh.markUsed.mockImplementation(((id: string) => {
    if (id === 'a') replaceSaved(all.filter(c => c.id !== 'b'), [folder('f1', null, 0)]);
    return Promise.resolve(emptyReply);
  }) as any);
  const before = new Set(store.getState().tabs.tabs.map(t => t.id));
  const summary = await connectAllInTabs('f1');
  expect(summary).toMatchObject({
    attempted: 3, started: 2,
    failures: [{ id: 'b', name: 'Beta', message: 'This saved SSH connection is unavailable.' }],
  });
  expect(summary!.message).toContain('Beta');
  expect(summary!.message).not.toMatch(/all connected/i);
  expect(openedTabs(before).map(t => tagOf(t.id).ssh!.connectionId)).toEqual(['a', 'c']);
  expect(api.ssh.markUsed.mock.calls).toEqual([['a'], ['c']]);
});

test('cancelled_trust_counts_attempt_but_not_connection_success', async () => {
  // Break the attempt/connected split: count a started tab as connected in summarize(), or skip markUsed in launchSshConnection.
  replaceSaved([saved('a', { name: 'Alpha', folderId: 'f1', order: 0 })], [folder('f1', null, 0)]);
  api.ssh.markUsed.mockResolvedValue(emptyReply as never);
  const before = new Set(store.getState().tabs.tabs.map(t => t.id));
  const summary = await connectAllInTabs('f1');
  const [tab] = openedTabs(before);
  const terminalId = tagOf(tab.id).terminalId!;
  // The user cancels the host-key prompt for that pane.
  store.dispatch(sshOwnersChanged({ [terminalId]: 'a' }));
  store.dispatch(sshLaunchObserved({
    terminalId, connectionId: 'a', stage: 'cancelled', revision: 1, launchSeq: 1,
    attempt: { sessionGeneration: 1, attemptReceipt: { generation: 1, gate: 'blocked' }, processIncarnation: 'p', ownerIncarnation: 'o' },
  } as never));
  expect(api.ssh.markUsed.mock.calls).toEqual([['a']]);
  expect(summary).toMatchObject({ attempted: 1, started: 1, failures: [] });
  expect(summary).not.toHaveProperty('connected');
  expect(summary!.message).not.toMatch(/connected/i);
  expect(store.getState().sshLaunch.byTerminal[terminalId].stage).toBe('cancelled');
  expect(store.getState().sshSession.byTerminal[terminalId].session).toBeUndefined();
});

test('mark_used_error_does_not_overwrite_bookmark_or_claim_connected', async () => {
  // In sshLaunch.launchSshConnection, make the markUsed rejection handler apply a view or report ok:true.
  replaceSaved([saved('a', { bookmarked: true, lastUsedAt: null })]);
  const viewBefore = store.getState().ssh.view;
  const revisionBefore = store.getState().ssh.revision;
  api.ssh.markUsed.mockRejectedValue(new Error('disk full') as never);
  const before = new Set(store.getState().tabs.tabs.map(t => t.id));
  const outcome = await connectSavedInTab('a');
  expect(outcome).toEqual({ error: null, recentFailed: true });
  expect(api.ssh.markUsed.mock.calls).toEqual([['a']]);
  expect(store.getState().ssh.view).toBe(viewBefore);
  expect(store.getState().ssh.revision).toBe(revisionBefore);
  expect(store.getState().ssh.view.connections.find(c => c.id === 'a')).toMatchObject({ bookmarked: true, lastUsedAt: null });
  const [tab] = openedTabs(before);
  expect(store.getState().sshSession.byTerminal[tagOf(tab.id).terminalId!]?.session).toBeUndefined();
});
