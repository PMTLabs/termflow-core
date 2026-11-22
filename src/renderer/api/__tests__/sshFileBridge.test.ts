import { readFileSync } from 'fs';
import { resolve } from 'path';
import { browserSshBridge, createSshBridge } from '../sshBridge';
import type { EditOpen } from '../../components/Ssh/sshFileTypes';

const target = { terminalId: 'tm-a', path: '/remote/a' };
const request = { ...target, expectedGeneration: 42 };
const cases = [
  ['fsList', request, 'ssh_fs_list'],
  ['fsStat', request, 'ssh_fs_stat'],
  ['fsMkdir', request, 'ssh_fs_mkdir'],
  ['fsCreate', request, 'ssh_fs_create'],
  ['fsRename', { ...request, newPath: '/remote/b' }, 'ssh_fs_rename'],
  ['fsDelete', { ...request, recursive: true, confirmed: true }, 'ssh_fs_delete'],
  ['fsChmod', { ...request, mode: 0o644 }, 'ssh_fs_chmod'],
  ['fsChown', { ...request, uid: 0, gid: 1000 }, 'ssh_fs_chown'],
  ['fsDownload', request, 'ssh_fs_download'],
  ['fsOpen', request, 'ssh_fs_open'],
  ['fsOpenWith', request, 'ssh_fs_open_with'],
  ['fsInsertPath', request, 'ssh_fs_insert_path'],
  ['fsEditDismiss', { ...target, editId: 'edit-1' }, 'ssh_fs_edit_dismiss'],
  ['fsEditStop', { ...target, editId: 'edit-1' }, 'ssh_fs_edit_stop'],
  ['fsEditList', { ...target, path: '.' }, 'ssh_fs_edit_list'],
] as const;

test('all_fs_methods_invoke_registered_names_with_terminal_and_remote_path', async () => {
  const source = readFileSync(resolve(__dirname, '../../../../src-tauri/src/commands/ssh_store.rs'), 'utf8');
  const handler = source.split('macro_rules! ssh_handlers')[1].split('$($extra),*')[0];
  const registered = [...handler.matchAll(/::(ssh_fs_\w+)/g)].map(match => match[1]).sort();
  const invoke = jest.fn().mockResolvedValue(null);
  const listen = jest.fn().mockResolvedValue(() => {});
  const api = createSshBridge(invoke, listen);
  expect(Object.keys(api).filter(key => key.startsWith('fs')).sort()).toEqual(cases.map(([key]) => key).sort());
  for (const [method, payload] of cases) await (api[method] as Function)(payload);
  expect(invoke.mock.calls).toEqual(cases.map(([, payload, command]) => [command, payload]));
  expect(invoke.mock.calls.map(([command]) => command).sort()).toEqual(registered);
  const onEdit = jest.fn(), onCwd = jest.fn();
  await api.onFsEditState(onEdit);
  await api.onFsCwd(onCwd);
  expect(listen.mock.calls.map(([event]) => event)).toEqual(['ssh-fs:edit-state', 'ssh-fs:cwd']);
  listen.mock.calls[0][1]({ payload: { editId: 'edit-1' } });
  listen.mock.calls[1][1]({ payload: target });
  expect(onEdit).toHaveBeenCalledWith({ editId: 'edit-1' });
  expect(onCwd).toHaveBeenCalledWith(target);
});

test('desktop_stub_rejects_without_network_request', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected request'));
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const socket = jest.fn();
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: socket });
  try {
    for (const [method, payload] of cases) {
      await expect((browserSshBridge[method] as Function)(payload)).rejects.toThrow('desktop only');
    }
    await expect(browserSshBridge.onFsEditState(jest.fn())).rejects.toThrow('desktop only');
    await expect(browserSshBridge.onFsCwd(jest.fn())).rejects.toThrow('desktop only');
    expect(fetch).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    if (original) Object.defineProperty(globalThis, 'WebSocket', original);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
  }
});

test('edit_open_union_parses_needs_editor_and_cancelled', async () => {
  const invoke = jest.fn().mockResolvedValueOnce(JSON.parse('{"state":"needsEditor"}'))
    .mockResolvedValueOnce(JSON.parse('{"state":"cancelled"}'))
    .mockResolvedValueOnce(JSON.parse('{"editId":"job-1","state":"watching","localPath":"/tmp/copy"}'));
  const api = createSshBridge(invoke, jest.fn());
  const describe = (result: EditOpen) => result.editId === undefined ? result.state : result.editId;
  expect(describe(await api.fsOpen(request))).toBe('needsEditor');
  expect(describe(await api.fsOpenWith(request))).toBe('cancelled');
  expect(describe(await api.fsOpen(request))).toBe('job-1');
});
