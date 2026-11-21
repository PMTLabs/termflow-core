/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { openSettingsTab } from '../../services/openSettings';
import { SshEditWarning } from './SshEditWarning';
import type { EditStatus, SshFileApi } from './sshFileTypes';

jest.mock('../../services/openSettings', () => ({ openSettingsTab: jest.fn() }));

const edit: EditStatus = {
  terminalId: 'tm-edit-warning', path: '/remote/file', editId: 'edit-1',
  state: 'watching', sessionGeneration: 1, retained: false, localPath: '/private/editor/copy',
};

function bridge(edits: EditStatus[]) {
  const unlisten = jest.fn();
  const api = {
    onFsEditState: jest.fn(async () => unlisten), onFsCwd: jest.fn(async () => unlisten),
    fsEditList: jest.fn(async () => edits), fsOpen: jest.fn(), fsOpenWith: jest.fn(),
    fsEditStop: jest.fn(async () => ({ retained: true, localPath: edit.localPath })),
  };
  return { api, files: api as unknown as SshFileApi, unlisten };
}

let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

test('detached_window_rehydrates_existing_edit_without_second_watch', async () => {
  const original = bridge([edit]);
  await act(async () => { root.render(<SshEditWarning terminalId={edit.terminalId} api={original.files} />); });
  act(() => root.unmount());
  expect(original.unlisten).toHaveBeenCalledTimes(2);
  root = createRoot(container);
  const detached = bridge([edit, { ...edit, terminalId: 'tm-other', path: '/other' }]);
  await act(async () => { root.render(<SshEditWarning terminalId={edit.terminalId} api={detached.files} />); });
  expect(detached.api.fsEditList.mock.calls).toEqual([[{ terminalId: edit.terminalId, path: '.' }]]);
  expect(detached.api.fsOpen).not.toHaveBeenCalled();
  expect(detached.api.fsOpenWith).not.toHaveBeenCalled();
  expect(container.querySelectorAll('li')).toHaveLength(1);
  expect(container.textContent).toContain('/remote/file — watching');
});

test('ssh_edit_warning_shows_retained_path_and_stop', async () => {
  const active = { ...edit, editId: 'edit-2', path: '/remote/active' };
  const retained = { ...edit, state: 'conflict', retained: true, localPath: '/private/retained/copy' };
  const { api, files } = bridge([retained, active]);
  await act(async () => { root.render(<SshEditWarning terminalId={edit.terminalId} api={files} />); });
  expect(container.textContent).toContain('/remote/file — conflict (retained)');
  expect(container.querySelector('code')?.textContent).toBe(retained.localPath);
  const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop editing /remote/active"]')!;
  await act(async () => { stop.click(); });
  expect(api.fsEditStop.mock.calls).toEqual([[{ terminalId: edit.terminalId, path: active.path, editId: active.editId }]]);
  expect(container.textContent).toContain('/remote/active — paused (retained)');
  expect(container.querySelectorAll('code')[1].textContent).toBe(edit.localPath);
  expect(container.querySelector('button')).toBeNull();
});

test('needs_editor_routes_to_existing_terminal_setting_and_cancelled_is_silent', async () => {
  const { files } = bridge([]);
  await act(async () => { root.render(<SshEditWarning terminalId={edit.terminalId} api={files} openResult={{ state: 'needsEditor' }} />); });
  // The settings module loads lazily (keeps the store out of SSH shell imports).
  await act(async () => { container.querySelector('button')!.click(); });
  for (let i = 0; i < 20 && !(openSettingsTab as jest.Mock).mock.calls.length; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  expect(openSettingsTab).toHaveBeenCalledWith('terminal');
  act(() => root.render(<SshEditWarning terminalId={edit.terminalId} api={files} openResult={{ state: 'cancelled' }} />));
  expect(container.textContent).toBe('');
});
