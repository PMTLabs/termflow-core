/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { SshMenus } from '../SshConnections/SshMenus';
import { TOOLTIP_DWELL_MS } from '../../../hooks/useTooltipDwell';
import type { SshConnection, SshFolder, SshStoreApi, SshView } from '../../../types/ssh';

const folder = (id: string, parentId: string | null, order: number): SshFolder => ({ id, parentId, name: id, icon: 'server', color: 'sky', order });
const conn = (id: string, folderId: string | null, order: number): SshConnection => ({ id, folderId, name: id, host: `${id}.example`, port: 22, user: '', auth: 'agent', identityFile: null, jumpConnectionId: null, extraOptions: [], bookmarked: false, order, lastUsedAt: null, hasSavedSecret: false });
const selected = folder('f-selected', null, 0);
const clicked = folder('f-clicked', null, 1);
const empty = folder('f-empty', null, 2);
const view: SshView = { revision: 1, folders: [selected, clicked, empty, folder('f-child', 'f-clicked', 0)], connections: [conn('sel-1', 'f-selected', 0), conn('deep', 'f-child', 0)], loadError: null };
let root: Root; let host: HTMLDivElement; let onConnectAll: jest.Mock; let onConnect: jest.Mock;
const item = (label: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(b => b.querySelector('.context-menu-label')?.textContent?.trim() === label);
  if (!found) throw Error(`Missing ${label}`);
  return found;
};
function mount(row: SshFolder | SshConnection, kind: 'folder' | 'connection' = 'folder') {
  act(() => root.render(<SshMenus target={{ x: 1, y: 2, row, kind }} view={view} api={{} as SshStoreApi} commit={async operation => { await operation(); }} onClose={jest.fn()} onFolder={jest.fn()} onConnection={jest.fn()} onRename={jest.fn()} onConnect={onConnect} onConnectAll={onConnectAll} />));
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  onConnectAll = jest.fn();
  onConnect = jest.fn();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

test('empty_folder_is_disabled', async () => {
  // SshMenus: drop `enabled:connectIds.length > 0` from the Connect all in tabs item.
  mount(empty);
  expect(item('Connect all in tabs').disabled).toBe(true);
  expect(item('Connect all in tabs').title).toBe('This folder has no connections');
  await act(async () => item('Connect all in tabs').click());
  expect(onConnectAll).toHaveBeenCalledTimes(0);
});

test('folder_connect_all_targets_the_right_clicked_folder_id_not_the_selection', async () => {
  // SshMenus: pass a different folder (e.g. the selection) to onConnectAll.
  mount(clicked);
  expect(item('Connect all in tabs').disabled).toBe(false);
  // An enabled row's tooltip is withheld until the menu's hover dwell elapses (ContextMenu's
  // `useTooltipDwell`); a disabled row shows it at once, which is why the empty case above can
  // read `title` straight away. Earn the dwell the way a user would: hover, then wait.
  jest.useFakeTimers();
  try {
    act(() => { item('Connect all in tabs').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    act(() => { jest.advanceTimersByTime(TOOLTIP_DWELL_MS + 50); });
    expect(item('Connect all in tabs').title).toBe('Open 1 connection in new tabs');
  } finally { jest.useRealTimers(); }
  await act(async () => item('Connect all in tabs').click());
  expect(onConnectAll.mock.calls).toEqual([['f-clicked']]);
  expect(onConnect).toHaveBeenCalledTimes(0);
});

test('connection_row_menu_connect_passes_the_clicked_saved_id', async () => {
  // SshMenus: call onConnect with a different id than row.id.
  mount(view.connections[1], 'connection');
  await act(async () => item('Connect').click());
  expect(onConnect.mock.calls).toEqual([['deep']]);
  expect(onConnectAll).toHaveBeenCalledTimes(0);
});
