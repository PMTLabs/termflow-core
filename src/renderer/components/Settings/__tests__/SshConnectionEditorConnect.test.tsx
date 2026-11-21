/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';

jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../../services/TerminalService', () => ({ terminalService: {} }));

import { store } from '../../../store';
import { removeTab } from '../../../store/slices/tabsSlice';
import { removeTabTree } from '../../../store/slices/panesSlice';
import { clearTabPanesInPlace, getTabPanesGlobal } from '../../../services/tabPanesStore';
import { button, preparePicker, replaceSaved, saved } from '../../../__testFixtures__/sshPickerFixture';
import { SshConnectionsPanel } from '../SshConnections/SshConnectionsPanel';

const flush = async () => { await act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); }); };
let root: Root; let container: HTMLDivElement; let api: ReturnType<typeof preparePicker>; let upsert: jest.Mock;
const tabIds = () => store.getState().tabs.tabs.map(t => t.id);
const footer = () => [...document.querySelectorAll('.confirm-dialog-footer button')].map(b => b.textContent);
const dialog = () => document.querySelector<HTMLElement>('.confirm-dialog')!;
const nameInput = () => container.querySelector<HTMLInputElement>('input[name="name"]')!;
const type = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
async function openDirtyEditor() {
  await act(async () => container.querySelector<HTMLElement>('.ssh-tree-row')!.click());
  await type(nameInput(), 'Edited name');
  await act(async () => button('Connect in new tab', container).click());
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  api = preparePicker();
  upsert = jest.fn();
  Object.assign(api.ssh, { upsertConnection: upsert, reload: jest.fn(), get: jest.fn() });
  api.ssh.markUsed.mockResolvedValue({ revision: 0, view: { revision: 0, folders: [], connections: [], loadError: null } } as never);
  replaceSaved([saved('one', { name: 'One' })]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Provider store={store}><SshConnectionsPanel /></Provider>));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const id of tabIds()) store.dispatch(removeTab(id));
  for (const id of Object.keys(store.getState().panes.treesByTabId)) store.dispatch(removeTabTree(id));
  clearTabPanesInPlace();
});

test('connect_dirty_cancel_creates_no_tab_and_does_not_touch_recent', async () => {
  // SshConnectionsPanel.requestConnect: launch without consulting isSshEditorDirty(), or make cancelConnect launch.
  await openDirtyEditor();
  expect(footer()).toEqual(['Cancel', 'Discard', 'Save and connect']);
  await act(async () => button('Cancel', dialog()).click());
  await flush();
  expect(tabIds()).toEqual([]);
  expect(api.ssh.markUsed).toHaveBeenCalledTimes(0);
  expect(upsert).toHaveBeenCalledTimes(0);
  expect(document.querySelector('.confirm-dialog')).toBeNull();
  expect(nameInput().value).toBe('Edited name');
});

test('save_failure_cannot_launch_old_or_unsaved_target', async () => {
  // SshConnectionsPanel.saveThenConnect: launch without checking `saved`, or launch before the save settles.
  upsert.mockRejectedValue({ code: 'save-failed', message: 'Disk is read-only' });
  await openDirtyEditor();
  await act(async () => button('Save and connect', dialog()).click());
  await flush();
  expect(upsert.mock.calls).toHaveLength(1);
  expect(upsert.mock.calls[0][0]).toMatchObject({ id: 'one', name: 'Edited name' });
  expect(tabIds()).toEqual([]);
  expect(api.ssh.markUsed).toHaveBeenCalledTimes(0);
  expect(container.textContent).toContain('Disk is read-only');
});

test('discard_launches_saved_target', async () => {
  // SshConnectionsPanel.discardThenConnect: skip discardSshEditorDraft() or launch a different id/draft.
  await openDirtyEditor();
  await act(async () => button('Discard', dialog()).click());
  await flush();
  expect(upsert).toHaveBeenCalledTimes(0);
  expect(api.ssh.markUsed.mock.calls).toEqual([['one']]);
  expect(tabIds()).toHaveLength(1);
  const [tabId] = tabIds();
  expect(getTabPanesGlobal()[tabId]).toMatchObject({ name: 'One', ssh: { connectionId: 'one', browserCollapsed: false, followCd: false, hiddenMetrics: [] } });
  expect(nameInput().value).toBe('One');
});
